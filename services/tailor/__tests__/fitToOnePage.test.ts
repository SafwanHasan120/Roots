import { describe, expect, it, vi } from 'vitest';
import { fitToOnePage, MAX_MECHANICAL_DROPS } from '../fitToOnePage.js';
import type { CompileResult } from '../compileResume.js';

const ORIGINAL = [
  '\\documentclass[letterpaper,10pt]{article}',
  '\\begin{document}',
  '\\resumeSubheading{Intern}{2026}{Acme}{Remote}',
  '\\resumeItem{Built a REST API in Python}',
  '\\resumeItem{this bullet is long enough to be the one that gets cut first}',
  '\\end{document}',
].join('\n');

function compileByLength(): (latex: string) => Promise<CompileResult> {
  return async (latex: string) => ({
    ok: true,
    pages: latex.includes('long enough to be the one') ? 2 : 1,
  });
}

describe('fitToOnePage', () => {
  it('accepts a draft that already compiles to one page', async () => {
    const shorten = vi.fn();
    const compile = vi.fn(async (): Promise<CompileResult> => ({ ok: true, pages: 1 }));

    const result = await fitToOnePage(ORIGINAL, ORIGINAL, shorten, compile);

    expect(result).toEqual({ latex: ORIGINAL, fitStatus: 'fits', pageCount: 1 });
    expect(shorten).not.toHaveBeenCalled();
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('keeps the original preamble on the draft it compiles', async () => {
    const draft = ORIGINAL.replace('10pt', '8pt').replace('Built a REST API in Python', 'Rewritten');
    let seen = '';
    const compile = vi.fn(async (latex: string): Promise<CompileResult> => {
      seen = latex;
      return { ok: true, pages: 1 };
    });

    await fitToOnePage(ORIGINAL, draft, vi.fn(), compile);

    expect(seen).toContain('10pt');
    expect(seen).not.toContain('8pt');
    expect(seen).toContain('Rewritten');
  });

  it('uses the shorten pass when the draft compiles long and the rewrite fits', async () => {
    const short = ORIGINAL.replace(
      'this bullet is long enough to be the one that gets cut first',
      'Cut',
    );
    const shorten = vi.fn(async (_latex: string, pages: number) => {
      expect(pages).toBe(2);
      return short;
    });
    const compile = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, pages: 2 })
      .mockResolvedValueOnce({ ok: true, pages: 1 });

    const result = await fitToOnePage(ORIGINAL, ORIGINAL, shorten, compile);

    expect(shorten).toHaveBeenCalledTimes(1);
    expect(result.fitStatus).toBe('fits');
    expect(result.pageCount).toBe(1);
    expect(result.latex).toContain('Cut');
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it('ignores a shorten pass that fails validation and trims instead', async () => {
    const shorten = vi.fn(async () =>
      ORIGINAL.replace('Built a REST API in Python', 'Invented a metric of 99999'),
    );
    const compile = vi.fn(compileByLength());

    const result = await fitToOnePage(ORIGINAL, ORIGINAL, shorten, compile);

    expect(result.fitStatus).toBe('fits');
    expect(result.pageCount).toBe(1);
    expect(result.latex).not.toContain('99999');
    expect(result.latex).not.toContain('long enough to be the one');
    expect(result.latex).toContain('Built a REST API in Python');
  });

  it('trims when the shorten pass still compiles to more than one page', async () => {
    const shorten = vi.fn(async (latex: string) => latex);
    const compile = vi.fn(compileByLength());

    const result = await fitToOnePage(ORIGINAL, ORIGINAL, shorten, compile);

    expect(result.fitStatus).toBe('fits');
    expect(result.latex).not.toContain('long enough to be the one');
  });

  it('reports over, with the real page count, when nothing left can be cut', async () => {
    const single = [
      '\\documentclass{article}',
      '\\begin{document}',
      '\\resumeSubheading{Intern}{2026}{Acme}{Remote}',
      '\\resumeItem{only bullet}',
      '\\end{document}',
    ].join('\n');
    const shorten = vi.fn(async () => single);
    const compile = vi.fn(async (): Promise<CompileResult> => ({ ok: true, pages: 2 }));

    const result = await fitToOnePage(single, single, shorten, compile);

    expect(result.fitStatus).toBe('over');
    expect(result.pageCount).toBe(2);
    expect(result.latex).toContain('only bullet');
    // One shorten compile, then no successful trim compile: the sole bullet stays.
    expect(compile.mock.calls.length).toBeLessThan(3 + MAX_MECHANICAL_DROPS);
  });

  it('does not fail the draft when the compile cannot be measured', async () => {
    const shorten = vi.fn();
    const compile = vi.fn(
      async (): Promise<CompileResult> => ({ ok: false, error: 'compile failed' }),
    );

    const result = await fitToOnePage(ORIGINAL, ORIGINAL, shorten, compile);

    expect(result).toEqual({ latex: ORIGINAL, fitStatus: 'unknown' });
    expect(shorten).not.toHaveBeenCalled();
  });

  it('stops trimming if a shorter draft no longer compiles', async () => {
    const compile = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, pages: 2 })
      .mockResolvedValueOnce({ ok: false, error: 'compile failed' })
      .mockResolvedValue({ ok: false, error: 'compile failed' });
    const shorten = vi.fn(async () => {
      throw new Error('model down');
    });

    const result = await fitToOnePage(ORIGINAL, ORIGINAL, shorten, compile);

    expect(result.fitStatus).toBe('over');
    expect(result.pageCount).toBe(2);
    expect(result.latex).toContain('long enough to be the one');
  });
});
