/**
 * Hold a tailored resume to one compiled page.
 *
 * Measure with Tectonic, ask the model once to cut, then delete the longest
 * extra bullet and recompile. The loop stops at one page, when nothing
 * removable is left, or after MAX_MECHANICAL_DROPS. A compile that cannot be
 * measured does not fail the job: the caller still delivers the draft, with
 * fitStatus 'unknown'.
 */

import { validateTailoredLatex } from '@app/latexValidator';
import { compileResume, type CompileResult } from './compileResume.js';
import { dropLongestExtraBullet, restorePreamble } from './resumeEdit.js';

/** Enough to pull a dense resume back, not enough to empty it. */
export const MAX_MECHANICAL_DROPS = 8;

export interface FitOutcome {
  latex: string;
  fitStatus: 'fits' | 'over' | 'unknown';
  pageCount?: number;
}

type CompileFn = (latex: string) => Promise<CompileResult>;

interface Candidate {
  latex: string;
  pages: number;
}

function prefer(next: Candidate, current: Candidate): boolean {
  if (next.pages !== current.pages) return next.pages < current.pages;
  return next.latex.length < current.latex.length;
}

export async function fitToOnePage(
  original: string,
  draft: string,
  shorten: (latex: string, pages: number) => Promise<string>,
  compile: CompileFn = compileResume,
): Promise<FitOutcome> {
  const restored = restorePreamble(original, draft);
  const first = await compile(restored);

  if (!first.ok || first.pages === undefined || first.pages < 1) {
    console.info(
      JSON.stringify({ msg: 'page count unavailable', error: first.error ?? 'no page count' }),
    );
    return { latex: restored, fitStatus: 'unknown' };
  }

  let best: Candidate = { latex: restored, pages: first.pages };
  if (best.pages === 1) {
    return { latex: best.latex, fitStatus: 'fits', pageCount: 1 };
  }

  try {
    const shortened = await shorten(best.latex, best.pages);
    const locked = restorePreamble(original, shortened);
    const validation = validateTailoredLatex(original, locked);
    if (validation.ok) {
      const again = await compile(locked);
      if (again.ok && again.pages !== undefined && again.pages >= 1) {
        const next = { latex: locked, pages: again.pages };
        if (prefer(next, best)) best = next;
      }
    } else {
      console.warn(
        JSON.stringify({
          msg: 'shorten pass failed validation',
          errors: validation.errors,
        }),
      );
    }
  } catch (err) {
    console.warn(JSON.stringify({ msg: 'shorten pass failed', error: String(err) }));
  }

  let current = best.latex;
  for (let dropped = 0; dropped < MAX_MECHANICAL_DROPS && best.pages > 1; dropped++) {
    const trimmed = dropLongestExtraBullet(current);
    if (!trimmed) break;

    const locked = restorePreamble(original, trimmed);
    const result = await compile(locked);
    if (!result.ok || result.pages === undefined || result.pages < 1) break;

    current = locked;
    const next = { latex: locked, pages: result.pages };
    if (prefer(next, best)) best = next;
    if (best.pages === 1) break;
  }

  if (best.pages > 1) {
    console.warn(
      JSON.stringify({ msg: 'tailored resume exceeds one page', pageCount: best.pages }),
    );
  }

  return {
    latex: best.latex,
    fitStatus: best.pages === 1 ? 'fits' : 'over',
    pageCount: best.pages,
  };
}
