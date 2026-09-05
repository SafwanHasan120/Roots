export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function countBraces(text: string): { open: number; close: number } {
  let open = 0;
  let close = 0;
  let inEscape = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inEscape) {
      inEscape = false;
      continue;
    }

    if (char === '\\') {
      inEscape = true;
      continue;
    }

    if (char === '{') open++;
    if (char === '}') close++;
  }

  return { open, close };
}

function extractNumbers(text: string): Set<number | string> {
  // Extract integers and percentages
  const numbers = new Set<number | string>();

  // Match integers (including negative)
  const intPattern = /-?\d+/g;
  const intMatches = text.match(intPattern) || [];
  intMatches.forEach((match) => {
    numbers.add(parseInt(match, 10));
  });

  // Match percentages (e.g., "50%", "3.5%")
  const percentPattern = /(\d+(?:\.\d+)?)\s*%/g;
  let percentMatch;
  while ((percentMatch = percentPattern.exec(text)) !== null) {
    numbers.add(percentMatch[1]);
  }

  // Match decimal numbers used in metrics (e.g., "3.5x", "2.1M")
  const decimalPattern = /\d+\.\d+/g;
  const decimalMatches = text.match(decimalPattern) || [];
  decimalMatches.forEach((match) => {
    numbers.add(match);
  });

  return numbers;
}

function countEntities(
  text: string,
  pattern: string
): number {
  const regex = new RegExp(`\\\\${pattern}`, 'g');
  const matches = text.match(regex) || [];
  return matches.length;
}

/**
 * Count `\resumeItem{...}` bullets.
 *
 * Separate from countEntities because `\resumeItem` is a prefix of
 * `\resumeItemListStart` and `\resumeItemListEnd`; requiring the opening brace
 * is what distinguishes a bullet from its surrounding list macros.
 */
function countItems(text: string): number {
  return (text.match(/\\resumeItem\s*\{/g) || []).length;
}

export function validateTailoredLatex(
  input: string,
  output: string
): ValidationResult {
  const errors: string[] = [];

  // 1. Check if output starts with \documentclass
  if (!output.trim().startsWith('\\documentclass')) {
    errors.push('Output must start with \\documentclass');
  }

  // 2. Check for markdown code fences
  if (output.includes('```')) {
    errors.push('Output contains markdown code fences (```)');
  }

  // 3. Check braces are balanced
  const braces = countBraces(output);
  if (braces.open !== braces.close) {
    errors.push(
      `Unbalanced braces: ${braces.open} open, ${braces.close} close`
    );
  }

  // 4. Check for \begin{document} and \end{document}
  if (!output.includes('\\begin{document}')) {
    errors.push('Output missing \\begin{document}');
  }
  if (!output.includes('\\end{document}')) {
    errors.push('Output missing \\end{document}');
  }

  // 5. Check entity counts (no new experience/project entries)
  const inputSubheadingCount = countEntities(input, 'resumeSubheading');
  const outputSubheadingCount = countEntities(output, 'resumeSubheading');

  if (outputSubheadingCount > inputSubheadingCount) {
    errors.push(
      `New \\resumeSubheading entries detected: ${inputSubheadingCount} in input, ${outputSubheadingCount} in output`
    );
  }

  const inputProjectCount = countEntities(input, 'resumeProjectHeading');
  const outputProjectCount = countEntities(output, 'resumeProjectHeading');

  if (outputProjectCount > inputProjectCount) {
    errors.push(
      `New \\resumeProjectHeading entries detected: ${inputProjectCount} in input, ${outputProjectCount} in output`
    );
  }

  // Bullets, same rule. Without this the model could add unlimited \resumeItem
  // entries: nothing else here bounds document length, and the prompt's own
  // "never add" rule was unenforced for bullets specifically.
  //
  // Counted with a trailing brace because a bare \resumeItem pattern also
  // matches \resumeItemListStart and \resumeItemListEnd — which would report 3
  // for a single bullet and make this check fire on correct output.
  const inputItemCount = countItems(input);
  const outputItemCount = countItems(output);

  if (outputItemCount > inputItemCount) {
    errors.push(
      `New \\resumeItem entries detected: ${inputItemCount} in input, ${outputItemCount} in output`
    );
  }

  // 6. Check that every number/percentage in output exists in input
  const inputNumbers = extractNumbers(input);
  const outputNumbers = extractNumbers(output);

  const fabricatedNumbers: (number | string)[] = [];
  outputNumbers.forEach((num) => {
    // Allow small adjustments and new formatting, but flag fabricated metrics
    // Check both string and numeric forms
    const numericForm = typeof num === 'string' ? parseFloat(num) : num;
    const hasMatch =
      inputNumbers.has(num) ||
      inputNumbers.has(String(num)) ||
      inputNumbers.has(numericForm) ||
      inputNumbers.has(String(numericForm));

    if (!hasMatch) {
      // Check if it's a common small number (like font sizes, margins, etc.)
      const isCommonNumber =
        numericForm <= 20 && numericForm >= 0 && Number.isInteger(numericForm);
      if (!isCommonNumber) {
        fabricatedNumbers.push(num);
      }
    }
  });

  if (fabricatedNumbers.length > 0) {
    errors.push(
      `Fabricated metrics detected in output: ${fabricatedNumbers.join(', ')}`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
