/**
 * Page count from a PDF buffer, without Poppler.
 *
 * pdfTeX and XeTeX (Tectonic) write the page tree as an uncompressed
 * dictionary. The root `/Type /Pages` node carries the total in `/Count`;
 * child nodes, when present, carry a smaller count. The maximum is the
 * document length.
 */

export function pdfPageCount(pdf: Buffer | string): number | null {
  const src = typeof pdf === 'string' ? pdf : pdf.toString('latin1');
  const counts: number[] = [];
  const dictRe = /<<([\s\S]*?)>>/g;
  let match: RegExpExecArray | null;

  while ((match = dictRe.exec(src)) !== null) {
    const body = match[1];
    // `/Type /Page` is a leaf and must not match `/Pages`.
    if (!/\/Type\s*\/Pages\b/.test(body)) continue;
    const count = /\/Count\s+(\d+)/.exec(body);
    if (count) counts.push(Number(count[1]));
  }

  if (counts.length === 0) return null;
  return Math.max(...counts);
}
