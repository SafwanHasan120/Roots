import { extractResumeItems, visibleText } from './latexBullets';

/**
 * Estimate whether a tailored resume still fits on one page — without compiling
 * LaTeX.
 *
 * Nothing else in the pipeline bounds document length: validateTailoredLatex
 * checks integrity (fabricated numbers, invented jobs) and the only one-page
 * pressure is a prose line in the tailor prompt, which nothing verifies. A model
 * that grows a resume onto a second page produces output that passes every
 * existing check.
 *
 * The constants below are measured from ONE preamble — letterpaper, 10pt,
 * fullpage, +1in textwidth, +1in textheight, as in the sb2nov/Jake template.
 * They are meaningless for any other geometry, which is why `confidence`
 * exists and why `fits` is never true when confidence is low.
 *
 * This is an estimate, deliberately advisory. It is kept OUT of
 * latexValidator.ts: that module encodes integrity invariants where a false
 * negative is a lie on someone's resume, whereas this is an aesthetic heuristic
 * fitted to one template. Failing a job over it would be the wrong trade.
 */

export const FIT_CONSTANTS = {
  /** Calibrated: a document at 759.2pt fits; one line more breaks to page 2. */
  PAGE_BUDGET_PT: 759.0,
  /** First line of a bullet, including \itemsep. */
  BULLET_FIRST_PT: 12.95,
  /** Each additional wrapped line within a bullet (\small baselineskip). */
  BULLET_LINE_PT: 11.0,
  /** 509.2pt column / 4.15pt per char, with a raggedright allowance. */
  CHARS_PER_LINE: 118,
  /** Name + contact block. */
  HEADER_PT: 67.9,
  /** \section title plus its rule. */
  SECTION_PT: 15.24,
  /** \resumeSubheading renders two lines. */
  SUBHEADING_PT: 27.0,
  /** \resumeProjectHeading renders one. */
  PROJHEADING_PT: 19.7,
  /** Each \\-terminated line in Technical Skills. */
  SKILLS_LINE_PT: 11.0,
  /** \resumeItemListEnd's \vspace{-5pt}, once per bullet list. */
  ITEMLIST_PT: -5.0,
} as const;

export interface FitItem {
  /** Bullet body, verbatim. */
  body: string;
  /** Offsets into the source, for splicing a shortened replacement. */
  start: number;
  end: number;
  /** Length after stripping formatting — what actually drives wrapping. */
  visibleChars: number;
  wrappedLines: number;
  ptCost: number;
  /**
   * Characters that must be cut to drop one wrapped line, or null when the
   * bullet is already a single line.
   *
   * This is the actionable number. Height is a step function of length: cutting
   * 13 characters from a bullet usually costs nothing, because the cost only
   * changes when a bullet crosses a CHARS_PER_LINE boundary.
   */
  cutToSaveLine: number | null;
}

export interface FitEstimate {
  totalPt: number;
  budgetPt: number;
  /** Only ever true when confidence is 'high'. */
  fits: boolean;
  /** 'low' means the template was not recognised and the estimate is unusable. */
  confidence: 'high' | 'low';
  /** Why confidence is low, for logs and the runbook. */
  reasons: string[];
  items: FitItem[];
  /** Wrapped lines that must disappear to fit. 0 when fitting. */
  linesOver: number;
}

function lowConfidence(reasons: string[], totalPt = 0): FitEstimate {
  return {
    totalPt,
    budgetPt: FIT_CONSTANTS.PAGE_BUDGET_PT,
    // Neither true nor a trigger for corrective work: with an unrecognised
    // template we cannot claim it fits, and we must not spend a retry chasing
    // a number we do not trust.
    fits: false,
    confidence: 'low',
    reasons,
    items: [],
    linesOver: 0,
  };
}

function countMatches(src: string, pattern: RegExp): number {
  return (src.match(pattern) || []).length;
}

/**
 * Reject documents whose geometry the constants do not describe.
 *
 * The failure this prevents is specific and was observed while calibrating: a
 * document whose bullets use bare `\item` instead of `\resumeItem{...}` parses
 * as ZERO bullets, so a 13-bullet resume estimates at 284pt and reports "FITS".
 * A false pass is worse than no check at all, because it silently suppresses
 * the corrective path.
 */
function templateReasons(latex: string, body: string): string[] {
  const reasons: string[] = [];

  const resumeItems = countMatches(body, /\\resumeItem\s*\{/g);
  const plainItems = countMatches(body, /\\item(?![a-zA-Z])/g);

  if (resumeItems === 0 && plainItems > 0) {
    reasons.push('bullets use \\item, not \\resumeItem — bullet heights unknown');
  }

  if (
    countMatches(body, /\\resumeSubheading/g) === 0 &&
    countMatches(body, /\\resumeProjectHeading/g) === 0
  ) {
    reasons.push('no \\resumeSubheading or \\resumeProjectHeading — not this template');
  }

  // The constants assume letterpaper at 10pt.
  const docClass = /\\documentclass\[([^\]]*)\]/.exec(latex);
  const options = docClass ? docClass[1] : '';
  if (options && !/letterpaper/.test(options)) {
    reasons.push(`page size is not letterpaper (${options})`);
  }
  if (options && !/\b10pt\b/.test(options)) {
    reasons.push(`base font is not 10pt (${options})`);
  }

  // Explicit geometry overrides the fullpage margins the constants assume.
  if (/\\usepackage(\[[^\]]*\])?\{geometry\}/.test(latex) || /\\geometry\s*\{/.test(latex)) {
    reasons.push('document sets its own geometry');
  }

  if (/\\begin\{multicols\}/.test(latex) || /\\documentclass\[[^\]]*twocolumn/.test(latex)) {
    reasons.push('multi-column layout — the linear model does not apply');
  }

  return reasons;
}

/**
 * Estimated rendered height of a resume, in points.
 *
 * Pure and side-effect free. Lives in my-app/lib rather than services/ because
 * services imports my-app via `@app/*` and never the reverse — the same
 * arrangement as keywordGap.ts.
 */
export function estimateFit(latex: string): FitEstimate {
  if (typeof latex !== 'string' || latex.trim() === '') {
    return lowConfidence(['empty document']);
  }

  // Guard, not try/catch: indexing past a missing \begin{document} is how the
  // reference implementation crashed.
  const markerIndex = latex.indexOf('\\begin{document}');
  if (markerIndex === -1) {
    return lowConfidence(['no \\begin{document} — not a complete document']);
  }
  const body = latex.slice(markerIndex);

  const reasons = templateReasons(latex, body);
  if (reasons.length > 0) {
    return lowConfidence(reasons);
  }

  const C = FIT_CONSTANTS;
  let total = C.HEADER_PT;
  total += C.SECTION_PT * countMatches(body, /\\section\{/g);
  total += C.SUBHEADING_PT * countMatches(body, /\\resumeSubheading/g);
  total += C.PROJHEADING_PT * countMatches(body, /\\resumeProjectHeading/g);
  total += C.ITEMLIST_PT * countMatches(body, /\\resumeItemListStart/g);

  const bodyOffset = markerIndex;
  const items: FitItem[] = extractResumeItems(body).map((bullet) => {
    const visibleChars = visibleText(bullet.body).length;
    const wrappedLines = Math.max(1, Math.ceil(visibleChars / C.CHARS_PER_LINE));
    const ptCost = C.BULLET_FIRST_PT + C.BULLET_LINE_PT * (wrappedLines - 1);
    total += ptCost;

    return {
      body: bullet.body,
      // Offsets are rebased onto the full document so callers can splice
      // without knowing the body was sliced.
      start: bullet.start + bodyOffset,
      end: bullet.end + bodyOffset,
      visibleChars,
      wrappedLines,
      ptCost,
      cutToSaveLine:
        wrappedLines > 1 ? visibleChars - (wrappedLines - 1) * C.CHARS_PER_LINE : null,
    };
  });

  // The skills block is a run of \\-terminated lines, not bullets.
  const skillsIndex = body.indexOf('Technical Skills');
  if (skillsIndex !== -1) {
    const tail = body.slice(skillsIndex);
    total += C.SKILLS_LINE_PT * (countMatches(tail, /\\\\/g) + 1);
  }

  const overPt = total - C.PAGE_BUDGET_PT;

  return {
    totalPt: Number(total.toFixed(2)),
    budgetPt: C.PAGE_BUDGET_PT,
    fits: overPt <= 0,
    confidence: 'high',
    reasons: [],
    items,
    linesOver: overPt > 0 ? Math.ceil(overPt / C.BULLET_LINE_PT) : 0,
  };
}

/**
 * Bullets whose length is cheapest to reduce, for a corrective prompt.
 *
 * Ranked by how few characters must go to drop a whole line. Single-line
 * bullets are excluded: shortening one saves nothing, and asking the model to
 * trim them wastes the attempt.
 */
export function cheapestCuts(estimate: FitEstimate, limit = 6): FitItem[] {
  return estimate.items
    .filter((i) => i.cutToSaveLine !== null)
    .sort((a, b) => (a.cutToSaveLine ?? 0) - (b.cutToSaveLine ?? 0))
    .slice(0, limit);
}
