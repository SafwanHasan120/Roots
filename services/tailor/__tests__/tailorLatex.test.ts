import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { estimateFit } from '@app/latexFit';

/**
 * First tests for tailorLatex.ts.
 *
 * The prompts ARE the product here, and until now nothing observed them: worker
 * tests mock these functions wholesale and assert only that they were called.
 * So the model id, max_tokens, the system-block shape, and every rule in the
 * prompt could change silently.
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
    const { tailorLatexWithAnalysis } = await import('../tailorLatex.js');
    await tailorLatexWithAnalysis(FIXTURE, 'jd text', ANALYSIS, ['Kubernetes']);

    const body = lastBody();
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.max_tokens).toBe(8192);
    // Deterministic output: a resume editor should not sample.
    expect(body.temperature).toBe(0);
    // The API rejects a bare object here with "system: Input should be a valid
    // array" — this shape is load-bearing, not stylistic.
    expect(Array.isArray(body.system)).toBe(true);
  });

  it('forbids inventing content', async () => {
    const { tailorLatexWithAnalysis } = await import('../tailorLatex.js');
    await tailorLatexWithAnalysis(FIXTURE, 'jd', ANALYSIS, ['Kubernetes']);

    const system = systemText();
    expect(system).toMatch(/Never add sections, experience entries, projects, or skills/);
    expect(system).toMatch(/Never alter or add a numeric value/);
    // Added because the model was observed adding skills from the JD despite
    // the blanket "never add" rule.
    expect(system).toMatch(/Never introduce a technology, tool, or framework/);
    expect(system).toMatch(/Never add a bullet/);
  });

  it('sends the page budget when the template is recognised', async () => {
    const { tailorLatexWithAnalysis } = await import('../tailorLatex.js');
    const fit = estimateFit(FIXTURE);
    expect(fit.confidence).toBe('high');

    await tailorLatexWithAnalysis(FIXTURE, 'jd', ANALYSIS, ['Kubernetes'], fit);

    const system = systemText();
    expect(system).toMatch(/ONE page/);
    // Expressed in characters and lines, never points: height is a step function
    // of bullet length, so "cut N points" is not actionable.
    expect(system).toContain('118 visible characters');
    expect(system).toContain(String(fit.totalPt));
  });

  it('omits the budget when the template is unrecognised', async () => {
    const { tailorLatexWithAnalysis } = await import('../tailorLatex.js');
    const fit = estimateFit('\\resumeItem{no document wrapper}');
    expect(fit.confidence).toBe('low');

    await tailorLatexWithAnalysis(FIXTURE, 'jd', ANALYSIS, ['Kubernetes'], fit);

    // A budget derived from constants that do not describe this document would
    // be a fabricated instruction.
    expect(systemText()).not.toMatch(/ONE page/);
  });

  it('carries the resume in the user message', async () => {
    const { tailorLatexWithAnalysis } = await import('../tailorLatex.js');
    await tailorLatexWithAnalysis(FIXTURE, 'jd', ANALYSIS, ['Kubernetes']);

    const body = lastBody() as { messages: Array<{ content: string }> };
    expect(body.messages[0].content).toContain('---RESUME---');
    expect(body.messages[0].content).toContain('\\documentclass');
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
      tailorLatexWithAnalysis(FIXTURE, 'jd', ANALYSIS, ['Kubernetes']),
    ).rejects.toThrow(/max_tokens/);
  });

  it('surfaces the API error body, not just the status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad model id', { status: 400 }));
    const { tailorLatexWithAnalysis } = await import('../tailorLatex.js');

    await expect(
      tailorLatexWithAnalysis(FIXTURE, 'jd', ANALYSIS, ['Kubernetes']),
    ).rejects.toThrow(/bad model id/);
  });
});

describe('tailorLatexDegraded', () => {
  it('carries the same integrity rules and accepts a budget', async () => {
    const { tailorLatexDegraded } = await import('../tailorLatex.js');
    await tailorLatexDegraded('Acme', 'SWE Intern', FIXTURE, estimateFit(FIXTURE));

    const system = systemText();
    expect(system).toMatch(/Never introduce a technology, tool, or framework/);
    expect(system).toMatch(/Never add a bullet/);
    expect(system).toMatch(/ONE page/);
  });
});
