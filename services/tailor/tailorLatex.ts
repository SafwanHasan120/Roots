/**
 * Claude calls for LaTeX resume tailoring.
 *
 * Moved verbatim from my-app/app/api/tailor/route.ts — same model, same system
 * prompts, same rules, same error handling. The prompts are the product here;
 * rewriting them during an infrastructure migration would make any output
 * change impossible to attribute.
 *
 * One addition: an explicit request timeout. The original had none, so a hung
 * connection could only be bounded by the platform's own request limit.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 8192;

/**
 * Below the Lambda's 300s ceiling, leaving room to write the artifact and
 * settle the job. A timeout here surfaces as a retryable failure rather than
 * the invocation being killed mid-write.
 */
const REQUEST_TIMEOUT_MS = 240_000;

export interface JdAnalysis {
  required_skills: string[];
  preferred_skills: string[];
  keywords: string[];
}

async function callClaude(systemPrompt: string, userMessage: string): Promise<string> {
  const response = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

export async function tailorLatexWithAnalysis(
  latex: string,
  _jdText: string,
  analysis: JdAnalysis,
  missing: string[],
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

  return callClaude(systemPrompt, userMessage);
}

export async function tailorLatexDegraded(
  company: string,
  role: string,
  latex: string,
): Promise<string> {
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

  return callClaude(systemPrompt, userMessage);
}
