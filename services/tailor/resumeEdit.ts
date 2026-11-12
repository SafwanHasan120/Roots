import { extractResumeItems, visibleText } from '@app/latexBullets';

const DOCUMENT_START = '\\begin{document}';

/**
 * Put the original preamble back on a draft.
 *
 * The model is told not to touch margins, fonts, or macros. Restoring the
 * bytes before `\begin{document}` is what actually stops a shrink-the-margins
 * cheat from turning a two-page resume into a fake one-page compile.
 *
 * Returns the draft unchanged when either side is missing the marker: there is
 * no preamble to restore, and guessing one would hide a broken document.
 */
export function restorePreamble(original: string, draft: string): string {
  const originalAt = original.indexOf(DOCUMENT_START);
  const draftAt = draft.indexOf(DOCUMENT_START);
  if (originalAt === -1 || draftAt === -1) return draft;
  return original.slice(0, originalAt) + draft.slice(draftAt);
}

interface Span {
  body: string;
  /** Index of `\resumeItem`. */
  cmd: number;
  /** Index just past the closing brace. */
  close: number;
}

/**
 * Delete the longest bullet that is not the last one under its role.
 *
 * A role with a single bullet is left alone: emptying an entry collapses the
 * heading into a blank block and, repeated, can strip the resume. Returns null
 * when every role is already down to one bullet.
 */
export function dropLongestExtraBullet(latex: string): string | null {
  const items = extractResumeItems(latex);
  if (items.length === 0) return null;

  const headings: number[] = [];
  const headingRe = /\\resume(?:Subheading|ProjectHeading)\b/g;
  let heading: RegExpExecArray | null;
  while ((heading = headingRe.exec(latex)) !== null) {
    headings.push(heading.index);
  }

  const spans: Span[] = items.map((item) => {
    const cmd = latex.lastIndexOf('\\resumeItem', item.start);
    return { body: item.body, cmd, close: item.end + 1 };
  });

  const groups = new Map<number, Span[]>();
  for (const span of spans) {
    if (span.cmd === -1) continue;
    let group = -1;
    for (const at of headings) {
      if (at < span.cmd) group = at;
    }
    const list = groups.get(group) ?? [];
    list.push(span);
    groups.set(group, list);
  }

  const deletable = [...groups.values()].flatMap((list) => (list.length > 1 ? list : []));
  if (deletable.length === 0) return null;

  deletable.sort((a, b) => {
    const byLength = visibleText(b.body).length - visibleText(a.body).length;
    if (byLength !== 0) return byLength;
    // Same length: drop the later bullet so the top of the page stays put.
    return b.cmd - a.cmd;
  });

  const victim = deletable[0];
  const { start, end } = expandToLine(latex, victim.cmd, victim.close);
  return latex.slice(0, start) + latex.slice(end);
}

/**
 * Take the whole source line when the bullet occupies it alone.
 *
 * A leftover blank line inside an itemize becomes a paragraph and adds
 * vertical space, which is the opposite of what a trim is for.
 */
function expandToLine(latex: string, cmd: number, close: number): { start: number; end: number } {
  let start = cmd;
  let end = close;

  const lineStart = latex.lastIndexOf('\n', cmd - 1) + 1;
  if (/^[ \t]*$/.test(latex.slice(lineStart, cmd))) start = lineStart;

  const trail = /^[ \t]*\r?\n/.exec(latex.slice(end));
  if (trail) end += trail[0].length;

  return { start, end };
}
