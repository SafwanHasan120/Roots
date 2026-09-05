import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { estimateFit, cheapestCuts, FIT_CONSTANTS } from '../latexFit';

const FIXTURE = readFileSync(
  new URL('./fixtures/sb2nov-resume.tex', import.meta.url),
  'utf8',
);

/** Swap a bullet body in the fixture, keeping the document otherwise identical. */
function withBullet(original: string, replacement: string): string {
  return FIXTURE.replace(original, replacement);
}

describe('estimateFit', () => {
  describe('golden value', () => {
    it('matches the reference implementation on the fixture', () => {
      // Pinned against the Python reference run on this exact file. Any drift in
      // the constants or the parsing changes this number and fails loudly, which
      // is the point — the constants are calibrated to one preamble and silent
      // drift would make every downstream decision wrong.
      const fit = estimateFit(FIXTURE);

      expect(fit.totalPt).toBeCloseTo(424.76, 1);
      expect(fit.items).toHaveLength(10);
      expect(fit.confidence).toBe('high');
      expect(fit.fits).toBe(true);
      expect(fit.linesOver).toBe(0);
    });

    it('reports the budget it measured against', () => {
      expect(estimateFit(FIXTURE).budgetPt).toBe(FIT_CONSTANTS.PAGE_BUDGET_PT);
    });
  });

  describe('degradation — fits must never be true on an unrecognised template', () => {
    it('refuses a document whose bullets use bare \\item', () => {
      // The silent-false-FITS case. With \item bullets, a 13-bullet resume
      // parses as ZERO bullets and estimates ~284pt, comfortably "fitting" a
      // document that actually overflows.
      const swapped = FIXTURE.replace(/\\resumeItem\{/g, '\\item ');
      const fit = estimateFit(swapped);

      expect(fit.fits).toBe(false);
      expect(fit.confidence).toBe('low');
      expect(fit.reasons.join(' ')).toMatch(/\\item/);
    });

    it('returns rather than throwing on a fragment with no \\begin{document}', () => {
      // The reference implementation raised IndexError here.
      const fit = estimateFit('\\resumeItem{orphan bullet}');

      expect(fit.confidence).toBe('low');
      expect(fit.fits).toBe(false);
      expect(fit.reasons.join(' ')).toMatch(/begin\{document\}/);
    });

    it('refuses an empty document', () => {
      expect(estimateFit('').confidence).toBe('low');
      expect(estimateFit('   ').confidence).toBe('low');
    });

    it('refuses a document with no resume headings', () => {
      const fit = estimateFit('\\documentclass[letterpaper,10pt]{article}\n\\begin{document}\nplain text\n\\end{document}');
      expect(fit.confidence).toBe('low');
      expect(fit.reasons.join(' ')).toMatch(/not this template/);
    });

    it('refuses a non-letterpaper page size', () => {
      const fit = estimateFit(FIXTURE.replace('letterpaper,10pt', 'a4paper,10pt'));
      expect(fit.confidence).toBe('low');
      expect(fit.reasons.join(' ')).toMatch(/letterpaper/);
    });

    it('refuses a different base font size', () => {
      const fit = estimateFit(FIXTURE.replace('letterpaper,10pt', 'letterpaper,12pt'));
      expect(fit.confidence).toBe('low');
      expect(fit.reasons.join(' ')).toMatch(/10pt/);
    });

    it('refuses a document that sets its own geometry', () => {
      const fit = estimateFit(
        FIXTURE.replace('\\usepackage{latexsym}', '\\usepackage[margin=0.5in]{geometry}'),
      );
      expect(fit.confidence).toBe('low');
      expect(fit.reasons.join(' ')).toMatch(/geometry/);
    });

    it('refuses a multi-column layout', () => {
      const fit = estimateFit(
        FIXTURE.replace('\\begin{document}', '\\begin{document}\n\\begin{multicols}{2}'),
      );
      expect(fit.confidence).toBe('low');
      expect(fit.reasons.join(' ')).toMatch(/column/);
    });
  });

  describe('the step function', () => {
    const short = 'Wrote a note-taking CLI with full-text search over a local index';

    it('charges nothing for extra characters within the same wrapped line', () => {
      const base = estimateFit(FIXTURE).totalPt;
      // 64 -> 77 visible chars, still one line of 118.
      const grown = estimateFit(withBullet(short, short + ' and cache')).totalPt;

      expect(grown).toBe(base);
    });

    it('charges one line when a bullet crosses the wrap boundary', () => {
      const base = estimateFit(FIXTURE).totalPt;
      const long = 'x'.repeat(FIT_CONSTANTS.CHARS_PER_LINE + 1);
      const grown = estimateFit(withBullet(short, long)).totalPt;

      expect(grown - base).toBeCloseTo(FIT_CONSTANTS.BULLET_LINE_PT, 1);
    });

    it('counts wrapped lines from visible text, not source length', () => {
      // Formatting commands occupy source but render nothing.
      const plain = 'y'.repeat(100);
      const decorated = `\\textbf{${'y'.repeat(100)}}`;

      const a = estimateFit(withBullet(short, plain));
      const b = estimateFit(withBullet(short, decorated));

      expect(a.totalPt).toBe(b.totalPt);
    });

    it('measures a body wrapped across source lines', () => {
      const multiline = 'z'.repeat(60) + '\n      ' + 'z'.repeat(60);
      const fit = estimateFit(withBullet(short, multiline));
      const item = fit.items.find((i) => i.body.includes('zzz'));

      // 60 + 1 space + 60 = 121 visible chars -> 2 lines.
      expect(item?.wrappedLines).toBe(2);
    });
  });

  describe('overflow reporting', () => {
    function overflowing(): string {
      const extra = Array.from(
        { length: 30 },
        () => '\\resumeItem{' + 'w'.repeat(150) + '}',
      ).join('\n');
      // Anchor on a body bullet, NOT on \resumeItemListEnd: the first
      // occurrence of that macro is its \newcommand in the preamble, so
      // injecting there lands outside \begin{document} and is never parsed.
      const anchor = '\\resumeItem{Wrote a note-taking CLI with full-text search over a local index}';
      expect(FIXTURE).toContain(anchor);
      return FIXTURE.replace(anchor, anchor + '\n' + extra);
    }

    it('reports how many lines must go', () => {
      const fit = estimateFit(overflowing());

      expect(fit.fits).toBe(false);
      expect(fit.confidence).toBe('high');
      expect(fit.linesOver).toBeGreaterThan(0);
    });

    it('ranks the cheapest bullets to shorten', () => {
      const cuts = cheapestCuts(estimateFit(overflowing()));

      expect(cuts.length).toBeGreaterThan(0);
      // Every candidate must actually be able to lose a line.
      for (const cut of cuts) {
        expect(cut.wrappedLines).toBeGreaterThan(1);
        expect(cut.cutToSaveLine).toBeGreaterThan(0);
      }
      // Sorted cheapest-first.
      const costs = cuts.map((c) => c.cutToSaveLine ?? 0);
      expect([...costs].sort((a, b) => a - b)).toEqual(costs);
    });

    it('excludes single-line bullets, where shortening saves nothing', () => {
      expect(cheapestCuts(estimateFit(FIXTURE))).toHaveLength(0);
    });
  });

  describe('splice offsets', () => {
    it('slice back to the exact bullet body', () => {
      const fit = estimateFit(FIXTURE);
      for (const item of fit.items) {
        expect(FIXTURE.slice(item.start, item.end)).toBe(item.body);
      }
    });
  });
});
