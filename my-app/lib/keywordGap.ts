export interface KeywordGapResult {
  covered: string[];
  missing: string[];
  coveragePct: number;
}

// Simple tokenizer: split on non-alphanumeric, lowercase, filter common words
const COMMON_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should',
  'could', 'can', 'may', 'might', 'must', 'it', 'this', 'that', 'these',
  'those', 'i', 'you', 'he', 'she', 'we', 'they', 'what', 'which', 'who',
  'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few',
  'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
  'same', 'so', 'than', 'too', 'very', 'as', 'if', 'from', 'up', 'about',
  'after', 'before', 'between', 'into', 'through', 'during', 'above',
  'below', 'under', 'over', 'out', 'off', 'over', 'under', 'again',
  'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
  'how', 'all', 'both', 'each', 'either', 'neither', 'one', 'either',
  'neither', 'your', 'our', 'their', 'his', 'her', 'its', 'my',
]);

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();

  // Split on non-alphanumeric/dot/plus/dash, but keep some compound forms
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9.+\-#]+/)
    .filter((word) => word.length > 0 && !COMMON_WORDS.has(word));

  words.forEach((word) => {
    tokens.add(word);
    // Also add multi-word phrases (if we see "c++", split into "c" and "++" separately)
    if (word.includes('.') || word.includes('+') || word.includes('-')) {
      word.split(/[.+\-]+/).forEach((part) => {
        if (part.length > 0 && !COMMON_WORDS.has(part)) {
          tokens.add(part);
        }
      });
    }
  });

  return tokens;
}

function normalizeKeyword(keyword: string): string {
  return keyword.toLowerCase().trim();
}

function isKeywordCovered(keyword: string, resumeTokens: Set<string>): boolean {
  const normalized = normalizeKeyword(keyword);

  // Check exact token match (case-insensitive)
  if (resumeTokens.has(normalized)) {
    return true;
  }

  // For compound keywords, check if all parts are covered
  // e.g., "machine learning" -> both "machine" and "learning" should be present
  const parts = normalized.split(/\s+/);
  if (parts.length > 1) {
    return parts.every((part) => {
      const partTokens = tokenize(part);
      return Array.from(partTokens).some((token) => resumeTokens.has(token));
    });
  }

  // For hyphenated/dotted keywords, normalize and check
  const dashParts = normalized.split(/[-./+]/);
  if (dashParts.length > 1) {
    return dashParts.every((part) => {
      if (part.length === 0) return true;
      return resumeTokens.has(part);
    });
  }

  return false;
}

export function computeKeywordGap(
  resumeText: string,
  keywords: string[]
): KeywordGapResult {
  const resumeTokens = tokenize(resumeText);

  const covered: string[] = [];
  const missing: string[] = [];

  keywords.forEach((keyword) => {
    if (isKeywordCovered(keyword, resumeTokens)) {
      covered.push(keyword);
    } else {
      missing.push(keyword);
    }
  });

  const coveragePct =
    keywords.length > 0
      ? Math.round((covered.length / keywords.length) * 100)
      : 100;

  return { covered, missing, coveragePct };
}
