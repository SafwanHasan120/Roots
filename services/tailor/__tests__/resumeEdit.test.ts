import { describe, expect, it } from 'vitest';
import { dropLongestExtraBullet, restorePreamble } from '../resumeEdit.js';

const ORIGINAL = [
  '\\documentclass[letterpaper,10pt]{article}',
  '\\addtolength{\\textheight}{1.0in}',
  '\\begin{document}',
  'original body',
  '\\end{document}',
].join('\n');

describe('restorePreamble', () => {
  it('keeps the original preamble and the draft body', () => {
    const draft = [
      '\\documentclass[letterpaper,8pt]{article}',
      '\\usepackage{geometry}',
      '\\begin{document}',
      'tailored body',
      '\\end{document}',
    ].join('\n');

    expect(restorePreamble(ORIGINAL, draft)).toBe(
      [
        '\\documentclass[letterpaper,10pt]{article}',
        '\\addtolength{\\textheight}{1.0in}',
        '\\begin{document}',
        'tailored body',
        '\\end{document}',
      ].join('\n'),
    );
  });

  it('returns the draft when either side has no document body', () => {
    expect(restorePreamble('no marker', '\\begin{document}x\\end{document}')).toBe(
      '\\begin{document}x\\end{document}',
    );
    expect(restorePreamble(ORIGINAL, 'not a document')).toBe('not a document');
  });
});

describe('dropLongestExtraBullet', () => {
  const resume = [
    '\\begin{document}',
    '\\resumeSubheading{Intern}{2026}{Acme}{Remote}',
    '  \\resumeItem{short one}',
    '  \\resumeItem{this is the very long bullet that should go}',
    '\\resumeSubheading{Research}{2025}{Lab}{Campus}',
    '  \\resumeItem{only bullet under the second role and it is extremely long indeed}',
    '\\end{document}',
  ].join('\n');

  it('drops the longest bullet that is not the last one in its role', () => {
    const next = dropLongestExtraBullet(resume);
    expect(next).not.toBeNull();
    expect(next).not.toContain('very long bullet');
    expect(next).toContain('short one');
    // The sole bullet of the other role stays, even though it is longer.
    expect(next).toContain('extremely long indeed');
  });

  it('removes the source line so the itemize does not keep a blank paragraph', () => {
    const next = dropLongestExtraBullet(resume)!;
    expect(next).not.toMatch(/\n\s*\n\s*\\resumeSubheading\{Research\}/);
  });

  it('stops when every role has a single bullet', () => {
    const once = dropLongestExtraBullet(resume)!;
    expect(dropLongestExtraBullet(once)).toBeNull();
  });

  it('returns null when there are no bullets', () => {
    expect(dropLongestExtraBullet('\\begin{document}none\\end{document}')).toBeNull();
  });
});
