import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractResumeItems, extractPlainItems, matchBrace, visibleText } from '../latexBullets';
import { computeLatexDiff } from '../latexDiff';

const FIXTURE = readFileSync(
  new URL('./fixtures/sb2nov-resume.tex', import.meta.url),
  'utf8',
);

describe('extractResumeItems', () => {
  it('finds every bullet in a real sb2nov resume', () => {
    expect(extractResumeItems(FIXTURE)).toHaveLength(10);
  });

  it('does not count the surrounding list macros as bullets', () => {
    // `\resumeItem` is a prefix of `\resumeItemListStart` and
    // `\resumeItemListEnd`, so a bare-command match reports 3 per real bullet.
    const src = '\\resumeItemListStart \\resumeItem{only one} \\resumeItemListEnd';
    expect(extractResumeItems(src)).toHaveLength(1);
    expect(extractResumeItems(src)[0].body).toBe('only one');
  });

  it('keeps nested groups intact', () => {
    const src = '\\resumeItem{Built \\textbf{fast} systems with \\emph{care}}';
    expect(extractResumeItems(src)[0].body).toBe(
      'Built \\textbf{fast} systems with \\emph{care}',
    );
  });

  it('handles a body wrapped across source lines', () => {
    const src = '\\resumeItem{first line\n  continues here\n  and here}';
    expect(extractResumeItems(src)[0].body).toContain('continues here');
  });

  it('reports offsets that slice back to the body', () => {
    const src = 'prefix \\resumeItem{the body} suffix';
    const [b] = extractResumeItems(src);
    expect(src.slice(b.start, b.end)).toBe('the body');
  });

  it('stops rather than guessing at an unterminated bullet', () => {
    expect(extractResumeItems('\\resumeItem{never closed')).toHaveLength(0);
  });
});

describe('matchBrace', () => {
  it('respects escaped braces', () => {
    const src = '{a \\{ b \\} c}';
    expect(matchBrace(src, 0)).toBe(src.length - 1);
  });

  it('returns -1 when unbalanced', () => {
    expect(matchBrace('{ nope', 0)).toBe(-1);
  });
});

describe('extractPlainItems', () => {
  it('matches bare \\item but not \\itemsep', () => {
    const src = '\\item real bullet\n\\itemsep 2pt\n\\item another';
    expect(extractPlainItems(src)).toHaveLength(2);
  });
});

describe('visibleText', () => {
  it('drops formatting commands and braces', () => {
    expect(visibleText('\\textbf{Built} a \\emph{thing}')).toBe('Built a thing');
  });

  it('unescapes literals that occupy width', () => {
    expect(visibleText('improved by 50\\% overall')).toBe('improved by 50% overall');
  });
});

describe('computeLatexDiff regression', () => {
  // The bug: extractBullets matched lines starting with `\item`, and
  // '\resumeItem'.startsWith('\item') is false. Every sb2nov diff was empty, so
  // the Changes tab in TailorModal always read "No changes detected".
  it('detects a changed bullet in an sb2nov document', () => {
    const after = FIXTURE.replace(
      'Wrote unit tests with pytest and raised coverage on the billing module',
      'Wrote unit tests with pytest and Jest, raising coverage on the billing module',
    );
    const diff = computeLatexDiff(FIXTURE, after);

    expect(diff.some((d) => d.type === 'changed')).toBe(true);
  });

  it('reports no changes for an identical document', () => {
    const diff = computeLatexDiff(FIXTURE, FIXTURE);
    expect(diff.every((d) => d.type === 'unchanged')).toBe(true);
  });

  it('still works for templates using bare \\item', () => {
    const before = '\\begin{document}\n\\item alpha\n\\item beta\n\\end{document}';
    const after = '\\begin{document}\n\\item alpha\n\\item gamma delta\n\\end{document}';
    const diff = computeLatexDiff(before, after);
    expect(diff.length).toBeGreaterThan(0);
  });
});
