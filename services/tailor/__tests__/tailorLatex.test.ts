import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The prompts ARE the product here, and worker tests mock these functions
 * wholesale. So the model id, max_tokens, the system-block shape, and every
 * rule in the prompt are pinned here.
 */

vi.mock('../tailorLatex.js', async (importOriginal) => importOriginal());

const getAnthropicKey = vi.fn(async () => 'test-key');
vi.mock('../ssm.js', () => ({ getAnthropicKey: () => getAnthropicKey() }));

const FIXTURE = readFileSync(
  new URL('../../../my-app/lib/__tests__/fixtures/sb2nov-resume.tex', import.meta.url),
  'utf8',
);

const ANALYSIS = {
  required_skills: ['Python', 'REST'],
  preferred_skills: ['Kubernetes'],
  domain: 'backend',
  seniority_signals: ['entry level'],
  keywords: ['Python', 'REST', 'Kubernetes', 'Docker'],
};

let fetchMock: ReturnType<typeof vi.fn>;

function lastBody(): Record<string, unknown> {
  return JSON.parse(String(fetchMock.mock.calls[0][1].body));
}

function systemText(): string {
  const body = lastBody() as { system: Array<{ text: string }> };
  return body.system[0].text;
}

function userText(): string {
  const body = lastBody() as { messages: Array<{ content: string }> };
  return body.messages[0].content;
}

beforeEach(() => {
  vi.resetModules();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  fetchMock = vi.fn(async () =>
    new Response(
      JSON.stringify({ content: [{ type: 'text', text: '\\documentclass{article}' }] }),
      { status: 200 },
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
});

describe('tailorLatexWithAnalysis', () => {
  it('pins the Claude call parameters', async () => {
    const { tailorLatexWithAnalysis, REQUEST_TIMEOUT_MS } = await import('../tailorLatex.js');
    await tailorLatexWithAnalysis(FIXTURE, 'Acme', 'SWE Intern', ANALYSIS, ['Python'], ['Kubernetes']);

    const body = lastBody();
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.max_tokens).toBe(8192);
    // Deterministic output: a resume editor should not sample.
    expect(body.temperature).toBe(0);
    // The API rejects a bare object here with "system: Input should be a valid
    // array" — this shape is load-bearing, not stylistic.
    expect(Array.isArray(body.system)).toBe(true);
    // Two calls plus compiles have to fit in the 600s worker.
    expect(REQUEST_TIMEOUT_MS).toBe(180_000);
  });

  it('forbids inventing content and upgrading scope', async () => {
    const { tailorLatexWithAnalysis } = await import('../tailorLatex.js');
    await tailorLatexWithAnalysis(FIXTURE, 'Acme', 'SWE Intern', ANALYSIS, ['Python'], ['Kubernetes']);

    const system = systemText();
    expect(system).toMatch(/Never add sections, experience entries, projects, or skills/);
    expect(system).toMatch(/Never alter or add a numeric value/);
    expect(system).toMatch(/Never introduce a technology, tool, or framework/);
    expect(system).toMatch(/Never add a bullet/);
    expect(system).toMatch(/must not become "led", "architected", or "owned"/);
    expect(system).toMatch(/Do not change the preamble/);
    expect(system).toMatch(/one page/);
    expect(system).toMatch(/single line/);
    // A point budget is not a rule the model can follow. Page count is measured
    // by compiling, not by quoting constants.
    expect(system).not.toMatch(/\d+ points/);
    expect(system).not.toMatch(/Focus on:/);
  });

  it('aims at overlap and names the keywords that must not be added', async () => {
    const { tailorLatexWithAnalysis } = await import('../tailorLatex.js');
    await tailorLatexWithAnalysis(
      FIXTURE,
      'Acme',
      'SWE Intern',
      ANALYSIS,
      ['Python', 'REST'],
      ['Kubernetes'],
    );

    const user = userText();
    expect(user).toContain('Surface these');
    expect(user).toContain('Python, REST');
    expect(user).toContain('Do not add these: Kubernetes');
    expect(user).toContain('Company: Acme');
    expect(user).toContain('Role: SWE Intern');
  });

  it('carries the resume in the user message', async () => {
    const { tailorLatexWithAnalysis } = await import('../tailorLatex.js');
    await tailorLatexWithAnalysis(FIXTURE, 'Acme', 'SWE Intern', ANALYSIS, ['Python'], ['Kubernetes']);

    expect(userText()).toContain('---RESUME---');
    expect(userText()).toContain('\\documentclass');
  });

  it('treats a truncated completion as an error', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' }),
        { status: 200 },
      ),
    );
    const { tailorLatexWithAnalysis } = await import('../tailorLatex.js');

    // Silently returning a half-written .tex would corrupt the resume.
    await expect(
      tailorLatexWithAnalysis(FIXTURE, 'Acme', 'SWE Intern', ANALYSIS, ['Python'], ['Kubernetes']),
    ).rejects.toThrow(/max_tokens/);
  });

  it('surfaces the API error body, not just the status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad model id', { status: 400 }));
    const { tailorLatexWithAnalysis } = await import('../tailorLatex.js');

    await expect(
      tailorLatexWithAnalysis(FIXTURE, 'Acme', 'SWE Intern', ANALYSIS, ['Python'], ['Kubernetes']),
    ).rejects.toThrow(/bad model id/);
  });
});

describe('tailorLatexDegraded', () => {
  it('uses the same integrity rules and does not pretend to know the job', async () => {
    const { tailorLatexDegraded } = await import('../tailorLatex.js');
    await tailorLatexDegraded('Acme', 'SWE Intern', FIXTURE);

    const system = systemText();
    expect(system).toMatch(/Never introduce a technology, tool, or framework/);
    expect(system).toMatch(/Never add a bullet/);
    expect(system).toMatch(/one page/);
    expect(system).toMatch(/must not become "led", "architected", or "owned"/);

    const user = userText();
    expect(user).toContain('do not guess tools or keywords');
    expect(user).not.toMatch(/preserving all existing content/);
  });
});

describe('tailorLatexShorter', () => {
  it('keeps the cached system prompt and puts the compiled page count in the user message', async () => {
    const { tailorLatexWithAnalysis, tailorLatexShorter } = await import('../tailorLatex.js');
    await tailorLatexWithAnalysis(FIXTURE, 'Acme', 'SWE Intern', ANALYSIS, ['Python'], ['Kubernetes']);
    const firstSystem = systemText();

    fetchMock.mockClear();
    await tailorLatexShorter(FIXTURE, 2);

    expect(systemText()).toBe(firstSystem);
    expect(userText()).toMatch(/compiled to 2 pages/);
    expect(userText()).toMatch(/exactly 1 page/);
    expect(userText()).toMatch(/Delete the least relevant bullets/);
  });
});
