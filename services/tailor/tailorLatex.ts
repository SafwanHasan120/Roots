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

import { FIT_CONSTANTS, type FitEstimate } from '@app/latexFit';

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
 * A concrete page budget for the prompt.
 *
 * Expressed in lines and characters, never points. Rendered height is a step
 * function of bullet length: trimming a few characters usually costs nothing,
 * because cost only changes when a bullet crosses the wrap boundary. "Cut 30pt"
 * is therefore close to unactionable, while "keep this bullet under 118
 * characters" is a rule the model can follow.
 *
 * Costs ~60 input tokens (~$0.0002) and is what prevents the far more expensive
 * corrective round-trip.
 */
export function fitConstraint(fit: FitEstimate): string {
  if (fit.confidence !== 'high') return '';

  const C = FIT_CONSTANTS;
  const lines = [
    '',
    'Length budget (the resume must stay on ONE page):',
    `- The page holds ${C.PAGE_BUDGET_PT} points. The input resume uses ${fit.totalPt}.`,
    `- A bullet costs ${C.BULLET_FIRST_PT} points for its first line and ${C.BULLET_LINE_PT} for each additional line.`,
    `- A line holds about ${C.CHARS_PER_LINE} visible characters, so a bullet longer than that wraps and costs another line.`,
    '- Keep each rewritten bullet within the same number of lines as the original. Prefer shorter.',
  ];

  const multiline = fit.items.filter((i) => i.wrappedLines > 1).length;
  if (multiline > 0) {
    lines.push(
      `- ${multiline} of the ${fit.items.length} bullets already wrap to 2+ lines; do not lengthen those.`,
    );
  }

  return lines.join('\n');
}

export async function tailorLatexWithAnalysis(
  latex: string,
  _jdText: string,
  analysis: JdAnalysis,
  missing: string[],
  fit?: FitEstimate,
): Promise<string> {
  const requirementsSummary = `Required Skills: ${analysis.required_skills.join(', ')}
Preferred Skills: ${analysis.preferred_skills.join(', ')}
Key Keywords: ${analysis.keywords.join(', ')}

Missing Keywords in Resume: ${missing.join(', ')}`;

  const systemPrompt = `You are a resume editor. Rewrite LaTeX to surface relevant keywords and experience.

Rules:
- Never add sections, experience entries, projects, or skills not already in the input
- Never introduce a technology, tool, or framework that does not already appear in the input, even when the job asks for it
- Never alter or add a numeric value (dates, metrics, percentages)
- Never add a bullet; the output must not contain more \\resumeItem entries than the input
- Reorder and rewrite existing bullets to surface covered keywords from the job
- If space is needed, delete the weakest bullet from the least relevant section
- Output the complete .tex file only, starting with \\documentclass, no markdown fences
${fit ? fitConstraint(fit) : ''}

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
  fit?: FitEstimate,
): Promise<string> {
  const systemPrompt = `You are a resume editor. Make minor improvements without access to full job requirements.

Rules:
- Never add sections, experience entries, projects, or skills not already in the input
- Never introduce a technology, tool, or framework that does not already appear in the input
- Never alter or add a numeric value (dates, metrics, percentages)
- Never add a bullet; the output must not contain more \\resumeItem entries than the input
- Reorder and enhance existing bullets to highlight relevance to the role
- If space is needed, delete the weakest bullet from the least relevant section
- Output the complete .tex file only, starting with \\documentclass, no markdown fences
${fit ? fitConstraint(fit) : ''}`;

  const userMessage = `Company: ${company}
Role: ${role}

Make the resume relevant to this role while preserving all existing content.

---RESUME---
${latex}`;

  return callClaude(systemPrompt, userMessage);
}
