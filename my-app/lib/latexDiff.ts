export interface DiffLine {
  type: 'unchanged' | 'added' | 'removed' | 'changed';
  before?: string;
  after?: string;
  lineNum?: number;
}

function extractBullets(latex: string): string[] {
  // Extract bullet points (\\item lines) from LaTeX
  const lines = latex.split('\n');
  const bullets: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('\\item')) {
      bullets.push(trimmed);
    }
  }

  return bullets;
}

export function computeLatexDiff(before: string, after: string): DiffLine[] {
  const beforeBullets = extractBullets(before);
  const afterBullets = extractBullets(after);

  const diff: DiffLine[] = [];
  const used = new Set<number>();

  // Find changed/unchanged lines
  for (let i = 0; i < beforeBullets.length; i++) {
    let found = false;

    for (let j = 0; j < afterBullets.length; j++) {
      if (used.has(j)) continue;

      if (beforeBullets[i] === afterBullets[j]) {
        diff.push({
          type: 'unchanged',
          before: beforeBullets[i],
          lineNum: i + 1,
        });
        used.add(j);
        found = true;
        break;
      }
    }

    if (!found) {
      // Look for similar line (likely changed)
      let bestMatch = -1;
      let bestSimilarity = 0;

      for (let j = 0; j < afterBullets.length; j++) {
        if (used.has(j)) continue;

        const similarity = computeSimilarity(beforeBullets[i], afterBullets[j]);
        if (similarity > bestSimilarity && similarity > 0.5) {
          bestSimilarity = similarity;
          bestMatch = j;
        }
      }

      if (bestMatch !== -1) {
        diff.push({
          type: 'changed',
          before: beforeBullets[i],
          after: afterBullets[bestMatch],
          lineNum: i + 1,
        });
        used.add(bestMatch);
      } else {
        diff.push({
          type: 'removed',
          before: beforeBullets[i],
          lineNum: i + 1,
        });
      }
    }
  }

  // Find added lines
  for (let j = 0; j < afterBullets.length; j++) {
    if (!used.has(j)) {
      diff.push({
        type: 'added',
        after: afterBullets[j],
      });
    }
  }

  return diff;
}

function computeSimilarity(a: string, b: string): number {
  // Simple similarity: count matching words
  const wordsA = a.toLowerCase().split(/\s+/);
  const wordsB = b.toLowerCase().split(/\s+/);

  const setA = new Set(wordsA);
  const setB = new Set(wordsB);

  let matches = 0;
  for (const word of setA) {
    if (setB.has(word)) matches++;
  }

  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? matches / union : 0;
}
