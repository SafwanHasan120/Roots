import { extractResumeItems, visibleText } from './latexBullets';
import { tokenize } from './keywordGap';

/**
 * Find edits a user should approve before their resume is delivered.
 *
 * Entirely mechanical — no model call. That is not only a cost decision
 * (a question-generating Claude call would add ~32% to every job): asking the
 * model to report its own scope inflation puts the party that made the change in
 * charge of policing it, and there is no way to tell whether its list is
 * complete. Diffing the before/after text is ground truth.
 *
 * The vocabulary argument is what makes `new_skill` precise. Any word added to a
 * bullet is a candidate, but only ones that also appear in the job description's
 * extracted keywords are interesting — that filters ordinary rewording
 * ("deployed", "via") from genuinely importing a technology off the JD.
 */

export type ChangeKind = 'new_skill' | 'scope_escalation' | 'detail_change';

export interface DetectedChange {
  kind: ChangeKind;
  /** Index into the ORIGINAL bullet list, so a decision can be applied by revert. */
  index: number;
  before: string;
  after: string;
  /** The specific terms that triggered this, for showing the user why. */
  evidence: string[];
}

/**
 * Verbs that claim ownership or leadership.
 *
 * The prompt forbids inventing experience but says nothing about restating the
 * same work more grandly, so this is the category the model is most free to get
 * wrong: "helped build" becoming "architected" is not a fabricated project, but
 * it is a claim the user may not want to make.
 */
const ESCALATION_VERBS = [
  'led', 'leading', 'architected', 'owned', 'spearheaded', 'managed',
  'directed', 'founded', 'mentored', 'oversaw', 'headed', 'drove',
  'pioneered', 'established', 'orchestrated',
];

const ESCALATION_RE = new RegExp(`\\b(${ESCALATION_VERBS.join('|')})\\b`, 'i');

/** Bullets, in document order, as visible text. */
function bulletTexts(latex: string): string[] {
  return extractResumeItems(latex).map((b) => visibleText(b.body));
}

function similarity(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wa.size === 0 && wb.size === 0) return 1;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.max(wa.size, wb.size);
}

/**
 * Pair up before/after bullets.
 *
 * Positional first, similarity second. The tailor prompt explicitly permits
 * reordering, so a similarity-only pairing would report a pure reorder as a pile
 * of unrelated edits and bury the user in questions about changes that never
 * happened. An identical bullet is matched wherever it moved to.
 */
function pairBullets(before: string[], after: string[]): Array<[number, string | null]> {
  const remaining = new Set(after.map((_, i) => i));
  const pairs: Array<[number, string | null]> = [];

  // Pass 1: exact matches anywhere in the document (a reorder is not a change).
  const exact = new Map<number, number>();
  before.forEach((text, i) => {
    for (const j of remaining) {
      if (after[j] === text) {
        exact.set(i, j);
        remaining.delete(j);
        return;
      }
    }
  });

  // Pass 2: best surviving similarity match for everything else.
  before.forEach((text, i) => {
    if (exact.has(i)) {
      pairs.push([i, after[exact.get(i)!]]);
      return;
    }

    let bestIdx = -1;
    let bestScore = 0;
    for (const j of remaining) {
      const score = similarity(text, after[j]);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = j;
      }
    }

    // Below this the two bullets are unrelated; treat the original as deleted
    // rather than inventing a rewrite the model did not make.
    if (bestIdx !== -1 && bestScore >= 0.4) {
      remaining.delete(bestIdx);
      pairs.push([i, after[bestIdx]]);
    } else {
      pairs.push([i, null]);
    }
  });

  return pairs;
}

/** Words present in `after` but not `before`, using the coverage tokenizer. */
function addedWords(before: string, after: string): string[] {
  const b = tokenize(before);
  const added: string[] = [];
  for (const word of tokenize(after)) {
    if (!b.has(word)) added.push(word);
  }
  return added;
}

export interface DetectOptions {
  /** JD keywords + required/preferred skills. Drives `new_skill` precision. */
  vocabulary?: string[];
  /** Questions to return. Beyond a handful, users blanket-approve. */
  limit?: number;
}

/**
 * Changes worth asking about, most important first.
 *
 * `detail_change` is detected but never returned: ordinary rewording is the bulk
 * of what tailoring does, and surfacing it would make the approval step
 * pointless busywork. Callers wanting the count can diff the arrays themselves.
 */
export function detectChanges(
  beforeLatex: string,
  afterLatex: string,
  options: DetectOptions = {},
): DetectedChange[] {
  const { vocabulary = [], limit = 5 } = options;

  const vocab = new Set<string>();
  for (const term of vocabulary) {
    for (const token of tokenize(term)) vocab.add(token);
  }

  const before = bulletTexts(beforeLatex);
  const after = bulletTexts(afterLatex);
  const changes: DetectedChange[] = [];

  pairBullets(before, after).forEach(([index, afterText]) => {
    // A deleted bullet is permitted by the prompt and removes nothing the user
    // did not already write, so it needs no approval.
    if (afterText === null) return;

    const beforeText = before[index];
    if (beforeText === afterText) return;

    const added = addedWords(beforeText, afterText);

    const newSkills = added.filter((w) => vocab.has(w));
    if (newSkills.length > 0) {
      changes.push({
        kind: 'new_skill',
        index,
        before: beforeText,
        after: afterText,
        evidence: newSkills,
      });
      return;
    }

    // Only counts when the escalation is NEW: a bullet that already said "led"
    // is not being escalated by a rewrite that keeps the word.
    if (ESCALATION_RE.test(afterText) && !ESCALATION_RE.test(beforeText)) {
      const verbs = added.filter((w) => ESCALATION_VERBS.includes(w.toLowerCase()));
      changes.push({
        kind: 'scope_escalation',
        index,
        before: beforeText,
        after: afterText,
        evidence: verbs.length > 0 ? verbs : [ESCALATION_RE.exec(afterText)![0]],
      });
    }
  });

  // new_skill first: importing a technology off the job description is a
  // factual claim, while escalation is a matter of emphasis.
  const rank: Record<ChangeKind, number> = {
    new_skill: 0,
    scope_escalation: 1,
    detail_change: 2,
  };

  return changes.sort((a, b) => rank[a.kind] - rank[b.kind]).slice(0, limit);
}
