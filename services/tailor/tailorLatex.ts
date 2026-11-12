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
 * Below the worker's 600s ceiling. A job may compile, then make this call a
 * second time to cut a long draft, so one call cannot take the whole window.
 * A timeout surfaces as a retryable failure rather than the invocation being
 * killed mid-write.
 */
export const REQUEST_TIMEOUT_MS = 180_000;

export interface JdAnalysis {
  required_skills: string[];
  preferred_skills: string[];
  keywords: string[];
}

/**
 * Resolve the Anthropic API key.
 *
 * Prefers ANTHROPIC_API_KEY when set (local runs, tests), otherwise reads the
 * SSM SecureString named by ANTHROPIC_KEY_PARAM.
 *
 * The fetch happens here rather than being injected at deploy time because
 * CloudFormation rejects SSM secure references in Lambda environment variables —
 * env vars are readable from the function config, so they are not a secret
 * store. Cached at module scope, so a warm container pays for this once.
 */
let cachedKey: string | null = null;

export async function getAnthropicKey(): Promise<string> {
  if (cachedKey) return cachedKey;

  const direct = process.env.ANTHROPIC_API_KEY;
  if (direct) {
    cachedKey = direct;
    return cachedKey;
  }

  const parameterName = process.env.ANTHROPIC_KEY_PARAM;
  if (!parameterName) {
    throw new Error('Neither ANTHROPIC_API_KEY nor ANTHROPIC_KEY_PARAM is set');
  }

  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
  const ssm = new SSMClient({ maxAttempts: 3 });
  const res = await ssm.send(
    new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
  );

  const value = res.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${parameterName} is empty`);

  cachedKey = value;
  return cachedKey;
}

/** Test seam. */
export function clearKeyCache(): void {
  cachedKey = null;
}

async function callClaude(systemPrompt: string, userMessage: string): Promise<string> {
  const apiKey = await getAnthropicKey();

  const response = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
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

/**
 * Shared by the analysis pass, the degraded pass, and the one-page shorten
 * pass. Byte-identical on every call so the cached system block can hit.
 *
 * The length rules are writing rules, not a point budget. Page count is
 * measured by compiling, and a second call (tailorLatexShorter) carries the
 * real number when the first draft runs long.
 */
const SYSTEM_PROMPT = `You are a resume editor for internship and new-grad applications. Rewrite the LaTeX so the resume matches the role and still fits on one page.

How these resumes are read:
- Recruiters and applicant tracking systems skim the top of a one-page resume and match plain text. Do not add columns, icons, skill bars, or a summary.
- Within Experience and within Projects, move the role or project that best matches the job to the top, and move its matching bullets above the other bullets in that entry.
- Reorder skills that are already on the resume so the overlap with the job comes first.
- Do not reorder sections, rename sections, or add a section.

Bullet shape:
- Start with a verb the candidate could actually claim, then what they built, then an existing number if the original bullet has one.
- Each bullet stays on a single line and is never longer than the original bullet.
- Cut filler such as "responsible for", "helped with", "various", and "worked on".
- Do not upgrade scope. "helped" must not become "led", "architected", or "owned".

Example:
- Weak: Helped with various backend tasks for the API
- Acceptable, when the original work supports it: Built the authentication endpoints for the internal API
- Not acceptable: Architected the authentication platform, improving latency by 40%

Integrity:
- Never add sections, experience entries, projects, or skills not already in the input
- Never introduce a technology, tool, or framework that does not already appear in the input, even when the job asks for it
- Never alter or add a numeric value (dates, metrics, percentages)
- Never add a bullet; the output must not contain more \\resumeItem entries than the input
- Do not add blank lines
- Do not change the preamble, margins, fonts, spacing, or macro definitions
- If the resume cannot fit on one page, delete the least relevant bullet rather than shrinking the layout
- Output the complete .tex file only, starting with \\documentclass, no markdown fences`;

function listOrNone(items: string[]): string {
  return items.length > 0 ? items.join(', ') : '(none)';
}

export async function tailorLatexWithAnalysis(
  latex: string,
  company: string,
  role: string,
  analysis: JdAnalysis,
  covered: string[],
  missing: string[],
): Promise<string> {
  const userMessage = `Company: ${company}
Role: ${role}

Required Skills: ${analysis.required_skills.join(', ')}
Preferred Skills: ${analysis.preferred_skills.join(', ')}
Key Keywords: ${analysis.keywords.join(', ')}

Surface these, in the job's wording, only where the resume already supports them: ${listOrNone(covered)}
Do not add these: ${listOrNone(missing)}

---RESUME---
${latex}`;

  return callClaude(SYSTEM_PROMPT, userMessage);
}

export async function tailorLatexDegraded(
  company: string,
  role: string,
  latex: string,
): Promise<string> {
  const userMessage = `Company: ${company}
Role: ${role}

Make the resume relevant to this role. You do not have the full job description, so do not guess tools or keywords that are not already on the resume.

---RESUME---
${latex}`;

  return callClaude(SYSTEM_PROMPT, userMessage);
}

/**
 * Second pass, used only after a compile measured more than one page.
 *
 * Same system prompt as the first pass. The page count goes in the user
 * message so the cached system block stays stable.
 */
export async function tailorLatexShorter(latex: string, pages: number): Promise<string> {
  const userMessage = `The draft below compiled to ${pages} pages. It must be exactly 1 page.
Delete the least relevant bullets and tighten the rest. Do not add anything. Keep every number and technology that remains.

---RESUME---
${latex}`;

  return callClaude(SYSTEM_PROMPT, userMessage);
}
