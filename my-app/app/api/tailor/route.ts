import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, incrementUsage } from '@/lib/tailorRateLimiter';
import { getInternshipById } from '@/lib/firestore';
import { assertSafeUrl } from '@/lib/urlGuard';
import { extractJD } from '@/lib/jdExtractor';
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
}

async function callClaudeAPI(jd: string, latex: string): Promise<string> {
  const systemPrompt = `You are a resume optimization system. You receive a job description and a LaTeX resume.

Your job: TAILOR the resume to match the job description. Do NOT add new sections, projects, experience entries, or skills. Only modify existing content.

You are a panel of three evaluators conducting a thorough, no-flattery software engineering resume review calibrated to 2026 hiring standards.

EVALUATOR 1 — ATS ALGORITHM
Simulate Greenhouse/Lever 2026 scoring. Scan for keyword strings, formatting legibility, and section structure.

EVALUATOR 2 — SENIOR TECH RECRUITER
10 years at Google, Meta, and Amazon. 7.4-second first pass. Care about: level signal, tech stack match, career trajectory clarity, builder vs task-completer. Skip duty-based bullets.

EVALUATOR 3 — STAFF SWE HIRING MANAGER
Probe technical credibility: Are metrics plausible? Does the person show engineering judgment or just list tools?

Run all evaluation layers silently. Apply fixes directly to the LaTeX. Output ONLY the final .tex file — no explanation, no analysis, no markdown fences.

CRITICAL RULES — DO NOT VIOLATE:
- Do NOT add new experience entries, projects, or skills that don't exist in the input
- Do NOT add new sections
- PRESERVE THE ORIGINAL ORDER OF EXPERIENCE ENTRIES AND EDUCATION ENTRIES EXACTLY
- You MAY reorder other content to better match the job description, including projects, skills, and bullet lists within sections
- DO NOT move experience or education items to a different section or change their relative order
- Only rewrite, trim, or remove existing content to match the job description
- Preserve all original content exactly unless making targeted edits to bullets or wording
- If space is needed, remove the WEAKEST existing bullets from the LEAST relevant sections, not add new ones

EVALUATION LAYERS (run silently):
1. ATS: keywords, formatting, canonical tech capitalization (JavaScript, TypeScript, Next.js, PostgreSQL, PyTorch, React, Node.js, GitHub, CI/CD)
2. Bullet quality rubric: Action Verb + Specific Technology + Metric + Outcome. Rewrite C/D grade bullets to A grade.
3. Quantification: improve metrics where plausible (scale, performance, business impact) — do not invent new metrics
4. Relevance reordering: Prioritize experience/projects that match job description keywords
5. Red flag removal: buzzwords, duty descriptions, vague metrics, over-claiming

LATEX TEMPLATE RULES (Jake/sb2nov format — do not deviate from this preamble):
\\documentclass[letterpaper,10pt]{article}
\\usepackage{latexsym}
\\usepackage[empty]{fullpage}
\\usepackage{titlesec}
\\usepackage{marvosym}
\\usepackage[usenames,dvipsnames]{color}
\\usepackage{verbatim}
\\usepackage{enumitem}
\\usepackage[hidelinks]{hyperref}
\\usepackage{fancyhdr}
\\usepackage[english]{babel}
\\usepackage{tabularx}
\\input{glyphtounicode}

SECTION ORDER: Header → Education → Experience → Projects → Technical Skills

SPECIAL CHARACTER ESCAPING: % → \\%, & → \\&, # → \\#, _ → \\_ in text mode

ONE-PAGE ENFORCEMENT: Must fit one page for candidates with under 5 years experience. Cut weakest bullets before shortening others.

Output: complete .tex file only, starting with \\documentclass`;

  const userMessage = `Job Description:
${jd}

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
      system: {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Claude API error: ${response.status}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
  };

  // Check for max_tokens stop reason
  if (data.stop_reason === 'max_tokens') {
    throw new Error('Claude API reached max_tokens limit - response incomplete');
  }

  // Find text content block
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

    // 3. Look up internship by ID to get appUrl
    const internship = await getInternshipById(internshipId);
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

    // 6. Call Claude API
    let tailoredLatex: string;
    try {
      tailoredLatex = await callClaudeAPI(jdText, latex);
    } catch (error) {
      console.error('Claude API error:', error);
      return NextResponse.json(
        {
          error: 'claude_error',
          message: 'Resume tailoring service is unavailable. Please try again.',
        },
        { status: 502 }
      );
    }

    if (!tailoredLatex.trim()) {
      return NextResponse.json(
        {
          error: 'claude_error',
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
      // The tailor succeeded even if we couldn't update the counter
    }

    // 9. Return success
    return NextResponse.json(
      {
        latex: tailoredLatex,
        internshipId,
      },
      { status: 200 }
    );
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
