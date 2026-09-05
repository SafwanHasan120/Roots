import { describe, it, expect } from 'vitest';
import { detectChanges } from '../changeDetect';

/** Minimal document wrapper; detection only reads \resumeItem bodies. */
function doc(...bullets: string[]): string {
  return [
    '\\documentclass[letterpaper,10pt]{article}',
    '\\begin{document}',
    '\\resumeItemListStart',
    ...bullets.map((b) => `\\resumeItem{${b}}`),
    '\\resumeItemListEnd',
    '\\end{document}',
  ].join('\n');
}

const VOCAB = ['Python', 'Kubernetes', 'Go', 'Docker', 'REST', 'microservices'];

describe('detectChanges', () => {
  describe('new_skill — the observed failure', () => {
    it('flags a technology imported from the job description', () => {
      // The prompt already forbids this; the model does it anyway, which is why
      // detection exists rather than more prompt wording.
      const before = doc('Built a REST API in Python handling authentication');
      const after = doc('Built a REST API in Python and Go handling authentication');

      const changes = detectChanges(before, after, { vocabulary: VOCAB });

      expect(changes).toHaveLength(1);
      expect(changes[0].kind).toBe('new_skill');
      expect(changes[0].evidence).toContain('go');
    });

    it('ignores added words that are not skills', () => {
      // Without the vocabulary filter, "successfully" and "quickly" would each
      // raise a question and make the feature unusable.
      const before = doc('Built a REST API in Python');
      const after = doc('Successfully built a robust REST API in Python quickly');

      expect(detectChanges(before, after, { vocabulary: VOCAB })).toHaveLength(0);
    });

    it('finds every added skill as evidence', () => {
      const before = doc('Wrote unit tests improving coverage');
      const after = doc('Wrote unit tests in Docker and Kubernetes improving coverage');

      const [change] = detectChanges(before, after, { vocabulary: VOCAB });
      expect(change.evidence.sort()).toEqual(['docker', 'kubernetes']);
    });

    it('asks nothing without a vocabulary', () => {
      // No JD analysis (degraded mode) means no way to tell a skill from
      // ordinary wording, and guessing would produce noise.
      const before = doc('Built a REST API in Python');
      const after = doc('Built a REST API in Python and Go');

      expect(detectChanges(before, after, {})).toHaveLength(0);
    });
  });

  describe('scope_escalation', () => {
    it('flags a newly introduced ownership verb', () => {
      const before = doc('Helped build a payments integration with two engineers');
      const after = doc('Led a payments integration with two engineers');

      const [change] = detectChanges(before, after, { vocabulary: VOCAB });
      expect(change.kind).toBe('scope_escalation');
      expect(change.evidence.join(' ').toLowerCase()).toContain('led');
    });

    it('does not flag a bullet that already claimed leadership', () => {
      const before = doc('Led the migration of a billing service');
      const after = doc('Led the migration of a billing service to reduce latency');

      expect(detectChanges(before, after, { vocabulary: VOCAB })).toHaveLength(0);
    });
  });

  describe('reordering must not generate questions', () => {
    it('returns nothing when bullets are only moved', () => {
      // The tailor prompt explicitly permits reordering. A similarity-only
      // pairing would report this as several unrelated rewrites.
      const before = doc('Alpha bullet about Python', 'Beta bullet about testing', 'Gamma bullet');
      const after = doc('Gamma bullet', 'Alpha bullet about Python', 'Beta bullet about testing');

      expect(detectChanges(before, after, { vocabulary: VOCAB })).toHaveLength(0);
    });

    it('finds a real change among reordered bullets', () => {
      const before = doc('Alpha bullet about Python', 'Beta bullet about testing');
      const after = doc('Beta bullet about testing', 'Alpha bullet about Python and Go');

      const changes = detectChanges(before, after, { vocabulary: VOCAB });
      expect(changes).toHaveLength(1);
      expect(changes[0].evidence).toContain('go');
    });
  });

  describe('deletions', () => {
    it('does not ask about a removed bullet', () => {
      // The prompt tells the model to drop the weakest bullet for space, and a
      // deletion cannot assert anything untrue about the user.
      const before = doc('Kept bullet about Python', 'Dropped bullet about something else');
      const after = doc('Kept bullet about Python');

      expect(detectChanges(before, after, { vocabulary: VOCAB })).toHaveLength(0);
    });
  });

  describe('output shape', () => {
    it('ranks new_skill above scope_escalation', () => {
      const before = doc('Helped build a service', 'Wrote tests for the API');
      const after = doc('Led the build of a service', 'Wrote tests for the API in Kubernetes');

      const changes = detectChanges(before, after, { vocabulary: VOCAB });
      expect(changes.map((c) => c.kind)).toEqual(['new_skill', 'scope_escalation']);
    });

    it('caps the number of questions', () => {
      const bullets = Array.from({ length: 10 }, (_, i) => `Bullet ${i} about work`);
      const changed = bullets.map((b) => `${b} using Kubernetes`);

      const changes = detectChanges(doc(...bullets), doc(...changed), {
        vocabulary: VOCAB,
        limit: 3,
      });
      expect(changes).toHaveLength(3);
    });

    it('reports indices that address the original bullets', () => {
      const before = doc('First about Python', 'Second about testing');
      const after = doc('First about Python', 'Second about testing with Docker');

      const [change] = detectChanges(before, after, { vocabulary: VOCAB });
      expect(change.index).toBe(1);
      expect(change.before).toContain('Second');
    });
  });

  describe('degenerate input', () => {
    it('returns nothing for identical documents', () => {
      const d = doc('One bullet about Python');
      expect(detectChanges(d, d, { vocabulary: VOCAB })).toHaveLength(0);
    });

    it('returns nothing when there are no bullets', () => {
      expect(detectChanges('\\begin{document}\\end{document}', '\\begin{document}\\end{document}', {}))
        .toHaveLength(0);
    });
  });
});
