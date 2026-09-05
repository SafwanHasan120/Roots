/**
 * Bullet extraction for sb2nov/Jake-template resumes.
 *
 * Shared by latexDiff.ts, latexFit.ts and changeDetect.ts so there is exactly
 * one definition of "what counts as a bullet". The three disagreed before:
 * latexDiff matched lines starting with `\item` and therefore extracted
 * **nothing** from a real resume, because `'\resumeItem'.startsWith('\item')`
 * is false. The Changes tab rendered "No changes detected" for every sb2nov
 * document as a result.
 *
 * Bodies are brace-balanced rather than line-based: `\resumeItem{...}` bodies
 * routinely wrap across source lines, and they contain nested groups like
 * `\textbf{...}`.
 */

export interface Bullet {
  /** Body text between the outermost braces, verbatim (not unwrapped). */
  body: string;
  /** Index of the character immediately after the opening brace. */
  start: number;
  /** Index of the matching closing brace. */
  end: number;
}

/**
 * Find the matching close brace for the open brace at `openIndex`.
 *
 * Honours backslash escapes so `\{` and `\}` inside a body do not unbalance the
 * scan. Returns -1 when unterminated, which callers must treat as "stop", not
 * as "end of string" — silently accepting a truncated body would let a
 * malformed document look well-formed.
 */
export function matchBrace(src: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') {
      i++; // skip the escaped character
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * All `\resumeItem{...}` bullets, in document order.
 *
 * The trailing `{` in the pattern is required: `\resumeItem` is a prefix of
 * `\resumeItemListStart` and `\resumeItemListEnd`, so matching the bare command
 * counts three "bullets" for every real one.
 */
export function extractResumeItems(latex: string): Bullet[] {
  const bullets: Bullet[] = [];
  const re = /\\resumeItem\s*\{/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(latex)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(latex, open);
    if (close === -1) break; // unterminated: refuse to guess
    bullets.push({ body: latex.slice(open + 1, close), start: open + 1, end: close });
    re.lastIndex = close;
  }

  return bullets;
}

/**
 * Bare `\item ...` bullets, for templates that do not use `\resumeItem`.
 *
 * Line-oriented on purpose: `\item` takes no braced argument, so there is no
 * balanced region to scan. The negative lookahead keeps `\itemsep` and friends
 * out.
 */
export function extractPlainItems(latex: string): string[] {
  return latex
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\\item(?![a-zA-Z])/.test(line));
}

/** Strip formatting commands and braces, leaving roughly what a reader sees. */
export function visibleText(tex: string): string {
  return tex
    .replace(/\\href\{[^}]*\}/g, '')
    .replace(/\\(textbf|emph|textit|underline|small|texttt|textsc)\b/g, '')
    .replace(/\\%/g, '%')
    .replace(/\\\$/g, '$')
    .replace(/\\&/g, '&')
    .replace(/\\#/g, '#')
    .replace(/\$\|\$/g, '|')
    .replace(/--/g, '-')
    .replace(/[{}]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}
