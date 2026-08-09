import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, incrementUsage } from '@/lib/tailorRateLimiter';
import { resolveInternship } from '@/lib/listingResolver';
import { assertSafeUrl } from '@/lib/urlGuard';
import { extractJD } from '@/lib/jdExtractor';
import { analyzeJD } from '@/lib/jdAnalyzer';
import { computeKeywordGap } from '@/lib/keywordGap';
import { validateTailoredLatex } from '@/lib/latexValidator';

interface TailorRequest {
  internshipId: string;
  latex: string;
  uid: string;
}

interface TailorResponse {
  latex?: string;
  internshipId?: string;
  error?: string;
  message?: string;
  used?: number;
  limit?: number;
  resetsAt?: number;
  coverageBefore?: number;
  coverageAfter?: number;
  degraded?: boolean;
}

async function tailorLatexWithAnalysis(
  latex: string,
  jdText: string,
  analysis: {
    required_skills: string[];
    preferred_skills: string[];
    keywords: string[];
  },
  missing: string[]
): Promise<string> {
  const requirementsSummary = `Required Skills: ${analysis.required_skills.join(', ')}
Preferred Skills: ${analysis.preferred_skills.join(', ')}
Key Keywords: ${analysis.keywords.join(', ')}

Missing Keywords in Resume: ${missing.join(', ')}`;

  const systemPrompt = `You are a resume editor. Rewrite LaTeX to surface relevant keywords and experience.

Rules:
- Never add sections, experience entries, projects, or skills not already in the input
- Never alter or add a numeric value (dates, metrics, percentages)
- Reorder and rewrite existing bullets to surface covered keywords from the job
- If space is needed, delete the weakest bullet from the least relevant section
- Output the complete .tex file only, starting with \\documentclass, no markdown fences

Focus on: ${missing.slice(0, 5).join(', ')}`;

  const userMessage = `Requirements:
${requirementsSummary}

---RESUME---
${latex}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      temperature: 0,
      // Must be an array of content blocks: the API rejects a bare object with
      // "system: Input should be a valid array".
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    // Include the response body: the status alone hides the actual cause
    // (bad model id, malformed system block, rate limit).
    const detail = await response.text().catch(() => '');
    throw new Error(`Claude API error: ${response.status} ${detail}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
  };

  if (data.stop_reason === 'max_tokens') {
    throw new Error('Claude API reached max_tokens limit - response incomplete');
  }

  const content = data.content?.find((block) => block.type === 'text');
  if (!content || !content.text) {
    throw new Error('Invalid Claude API response: no text content');
  }

  return content.text;
}

async function tailorLatexDegraded(company: string, role: string, latex: string): Promise<string> {
  const systemPrompt = `You are a resume editor. Make minor improvements without access to full job requirements.

Rules:
- Never add sections, experience entries, projects, or skills not already in the input
- Never alter or add a numeric value (dates, metrics, percentages)
- Reorder and enhance existing bullets to highlight relevance to the role
- If space is needed, delete the weakest bullet from the least relevant section
- Output the complete .tex file only, starting with \\documentclass, no markdown fences`;

  const userMessage = `Company: ${company}
Role: ${role}

Make the resume relevant to this role while preserving all existing content.

---RESUME---
${latex}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      temperature: 0,
      // Must be an array of content blocks: the API rejects a bare object with
      // "system: Input should be a valid array".
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    // Include the response body: the status alone hides the actual cause
    // (bad model id, malformed system block, rate limit).
    const detail = await response.text().catch(() => '');
    throw new Error(`Claude API error: ${response.status} ${detail}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
  };

  if (data.stop_reason === 'max_tokens') {
    throw new Error('Claude API reached max_tokens limit - response incomplete');
  }

  const content = data.content?.find((block) => block.type === 'text');
  if (!content || !content.text) {
    throw new Error('Invalid Claude API response: no text content');
  }

  return content.text;
}

export async function POST(request: NextRequest): Promise<NextResponse<TailorResponse>> {
  try {
    // 1. Validate inputs
    const body = (await request.json()) as TailorRequest;
    const { internshipId, latex, uid } = body;

    if (!internshipId?.trim() || !latex?.trim() || !uid?.trim()) {
      return NextResponse.json(
        { error: 'validation_failed', message: 'Missing required fields' },
        { status: 400 }
      );
    }

    // 2. Rate limit check
    const rateStatus = await checkRateLimit(uid);
    if (!rateStatus.allowed) {
      return NextResponse.json(
        {
          error: 'rate_limited',
          used: rateStatus.used,
          limit: rateStatus.limit,
          resetsAt: rateStatus.resetsAt,
        },
        { status: 429 }
      );
    }

    // 3. Resolve the internship server-side to get appUrl. Resolved from the
    // same listing source the UI renders, so a visible row is always tailorable.
    const internship = await resolveInternship(internshipId);
    if (!internship) {
      return NextResponse.json(
        { error: 'not_found', message: 'Internship listing not found' },
        { status: 404 }
      );
    }

    const appUrl = internship.appUrl;

    // 4. Validate URL safety
    try {
      await assertSafeUrl(appUrl);
    } catch (error) {
      console.error('URL validation failed:', error);
      return NextResponse.json(
        {
          error: 'unsafe_url',
          message: 'The internship URL failed security validation.',
        },
        { status: 403 }
      );
    }

    // 5. Extract job description
    let jdText: string;
    let jdConfidence: 'high' | 'low';
    try {
      const jd = await extractJD(appUrl);
      if (!jd.text) {
        return NextResponse.json(
          {
            error: 'jd_extraction_failed',
            message: 'Could not extract job description from the provided URL. Please try again or check the link.',
          },
          { status: 422 }
        );
      }
      jdText = jd.text;
      jdConfidence = jd.confidence;
    } catch (error) {
      console.error('JD extraction failed:', error);
      return NextResponse.json(
        {
          error: 'jd_extraction_failed',
          message: 'Could not extract job description from the provided URL. Please try again or check the link.',
        },
        { status: 422 }
      );
    }

    // 6. Two-pass tailoring
    let tailoredLatex: string | undefined;
    let coverageBefore = 0;
    let coverageAfter = 0;
    let isDegraded = false;

    // Compute coverage before tailoring
    let beforeGap = { covered: [] as string[], missing: [] as string[], coveragePct: 100 };

    if (jdConfidence === 'high') {
      // Pass 1: Analyze JD
      let analysis;
      try {
        analysis = await analyzeJD(jdText, appUrl);
      } catch (error) {
        console.error('JD analysis failed:', error);
        // Fall back to degraded mode
        isDegraded = true;
        analysis = undefined;
      }

      if (analysis) {
        // Compute keyword gap
        beforeGap = computeKeywordGap(latex, analysis.keywords);
        coverageBefore = beforeGap.coveragePct;

        // Pass 2: Tailor with analysis
        try {
          tailoredLatex = await tailorLatexWithAnalysis(latex, jdText, analysis, beforeGap.missing);
        } catch (error) {
          console.error('LaTeX tailoring failed:', error);
          return NextResponse.json(
            {
              error: 'tailor_failed',
              message: 'Resume tailoring service is unavailable. Please try again.',
            },
            { status: 502 }
          );
        }

        // Compute coverage after tailoring
        const afterGap = computeKeywordGap(tailoredLatex, analysis.keywords);
        coverageAfter = afterGap.coveragePct;
      }
    }

    // Degraded mode: use only company + role
    if (isDegraded || jdConfidence === 'low' || !tailoredLatex) {
      try {
        tailoredLatex = await tailorLatexDegraded(internship.company, internship.role, latex);
        isDegraded = true;
      } catch (error) {
        console.error('Degraded tailoring failed:', error);
        return NextResponse.json(
          {
            error: 'tailor_failed',
            message: 'Resume tailoring service is unavailable. Please try again.',
          },
          { status: 502 }
        );
      }
    }

    if (!tailoredLatex || !tailoredLatex.trim()) {
      return NextResponse.json(
        {
          error: 'tailor_failed',
          message: 'Resume tailoring service is unavailable. Please try again.',
        },
        { status: 502 }
      );
    }

    // 7. Validate tailored LaTeX
    const validation = validateTailoredLatex(latex, tailoredLatex);
    if (!validation.ok) {
      console.error('LaTeX validation failed:', validation.errors);
      return NextResponse.json(
        {
          error: 'validation_failed',
          message: 'The tailored resume failed validation. Please try again.',
        },
        { status: 502 }
      );
    }

    // 8. Increment usage (after successful validation)
    try {
      await incrementUsage(uid);
    } catch (error) {
      console.error('Usage increment failed:', error);
      // Don't fail the request if we can't increment usage
    }

    // 9. Return success
    const response: TailorResponse = {
      latex: tailoredLatex,
      internshipId,
      coverageBefore: coverageBefore > 0 ? coverageBefore : undefined,
      coverageAfter: coverageAfter > 0 ? coverageAfter : undefined,
    };

    if (isDegraded) {
      response.degraded = true;
    }

    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    console.error('Tailor route error:', error);
    return NextResponse.json(
      {
        error: 'internal_error',
        message: 'An unexpected error occurred. Please try again.',
      },
      { status: 500 }
    );
  }
}
