import { describe, it, expect } from 'vitest';
import { validateTailoredLatex } from '../latexValidator';

describe('latexValidator', () => {
  describe('validateTailoredLatex', () => {
    const validBasicLatex = `\\documentclass[letterpaper,10pt]{article}
\\usepackage{latexsym}
\\begin{document}
Hello World
\\end{document}`;

    it('should accept valid LaTeX with balanced braces', () => {
      const result = validateTailoredLatex(validBasicLatex, validBasicLatex);
      expect(result.ok).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    describe('\\documentclass check', () => {
      it('should reject if output does not start with \\documentclass', () => {
        const input = validBasicLatex;
        const output = `\\usepackage{latexsym}
\\begin{document}
Hello
\\end{document}`;

        const result = validateTailoredLatex(input, output);
        expect(result.ok).toBe(false);
        expect(result.errors).toContain(
          'Output must start with \\documentclass'
        );
      });

      it('should allow whitespace before \\documentclass', () => {
        const input = validBasicLatex;
        const output = `
\\documentclass[letterpaper,10pt]{article}
\\begin{document}
Hello
\\end{document}`;

        const result = validateTailoredLatex(input, output);
        expect(result.errors).not.toContain(
          'Output must start with \\documentclass'
        );
      });
    });

    describe('markdown code fences', () => {
      it('should reject output with markdown code fences', () => {
        const input = validBasicLatex;
        const output = `\\documentclass[letterpaper,10pt]{article}
\`\`\`latex
\\begin{document}
Hello
\\end{document}
\`\`\``;

        const result = validateTailoredLatex(input, output);
        expect(result.ok).toBe(false);
        expect(result.errors).toContain(
          'Output contains markdown code fences (```)'
        );
      });
    });

    describe('brace balancing', () => {
      it('should reject unbalanced opening braces', () => {
        const input = validBasicLatex;
        const output = `\\documentclass[letterpaper,10pt]{article
\\begin{document}
Hello
\\end{document}`;

        const result = validateTailoredLatex(input, output);
        expect(result.ok).toBe(false);
        expect(result.errors.some((e) => e.includes('Unbalanced braces'))).toBe(
          true
        );
      });

      it('should reject unbalanced closing braces', () => {
        const input = validBasicLatex;
        const output = `\\documentclass[letterpaper,10pt]{article}
\\begin{document}
Hello
\\end{document}}`;

        const result = validateTailoredLatex(input, output);
        expect(result.ok).toBe(false);
        expect(result.errors.some((e) => e.includes('Unbalanced braces'))).toBe(
          true
        );
      });

      it('should ignore escaped braces', () => {
        const input = validBasicLatex;
        const output = `\\documentclass[letterpaper,10pt]{article}
\\textbf{\\{}hello\\textbf{\\}}
\\begin{document}
Content
\\end{document}`;

        const result = validateTailoredLatex(input, output);
        expect(result.errors.some((e) => e.includes('Unbalanced braces'))).toBe(
          false
        );
      });
    });

    describe('document tags', () => {
      it('should reject output without \\begin{document}', () => {
        const input = validBasicLatex;
        const output = `\\documentclass[letterpaper,10pt]{article}
Content here
\\end{document}`;

        const result = validateTailoredLatex(input, output);
        expect(result.ok).toBe(false);
        expect(result.errors).toContain(
          'Output missing \\begin{document}'
        );
      });

      it('should reject output without \\end{document}', () => {
        const input = validBasicLatex;
        const output = `\\documentclass[letterpaper,10pt]{article}
\\begin{document}
Content here`;

        const result = validateTailoredLatex(input, output);
        expect(result.ok).toBe(false);
        expect(result.errors).toContain(
          'Output missing \\end{document}'
        );
      });

      it('should accept both document tags present', () => {
        const input = validBasicLatex;
        const output = `\\documentclass[letterpaper,10pt]{article}
\\begin{document}
Content
\\end{document}`;

        const result = validateTailoredLatex(input, output);
        expect(result.errors).not.toContain(
          'Output missing \\begin{document}'
        );
        expect(result.errors).not.toContain(
          'Output missing \\end{document}'
        );
      });
    });

    describe('entity count validation', () => {
      it('should reject if output has more \\resumeSubheading than input', () => {
        const input = `\\documentclass{article}
\\begin{document}
\\resumeSubheading{Company1}{2020}
\\end{document}`;

        const output = `\\documentclass{article}
\\begin{document}
\\resumeSubheading{Company1}{2020}
\\resumeSubheading{Company2}{2021}
\\end{document}`;

        const result = validateTailoredLatex(input, output);
        expect(result.ok).toBe(false);
        expect(result.errors.some((e) =>
          e.includes('New \\resumeSubheading entries detected')
        )).toBe(true);
      });

      it('should reject if output has more \\resumeProjectHeading than input', () => {
        const input = `\\documentclass{article}
\\begin{document}
\\resumeProjectHeading{Project1}{}
\\end{document}`;

        const output = `\\documentclass{article}
\\begin{document}
\\resumeProjectHeading{Project1}{}
\\resumeProjectHeading{Project2}{}
\\end{document}`;

        const result = validateTailoredLatex(input, output);
        expect(result.ok).toBe(false);
        expect(result.errors.some((e) =>
          e.includes('New \\resumeProjectHeading entries detected')
        )).toBe(true);
      });

      it('should allow same or fewer entity counts', () => {
        const input = `\\documentclass{article}
\\begin{document}
\\resumeSubheading{Company1}{2020}
\\resumeSubheading{Company2}{2021}
\\resumeProjectHeading{Project1}{}
\\end{document}`;

        const output = `\\documentclass{article}
\\begin{document}
\\resumeSubheading{Company1}{2020}
\\resumeProjectHeading{Project1}{}
\\end{document}`;

        const result = validateTailoredLatex(input, output);
        expect(result.errors.filter((e) =>
          e.includes('New') && e.includes('entries detected')
        )).toHaveLength(0);
      });

      describe('bullet counts', () => {
        const wrap = (items: string) => `\\documentclass{article}
\\begin{document}
\\resumeItemListStart
${items}
\\resumeItemListEnd
\\end{document}`;

        it('rejects added bullets', () => {
          // Nothing else bounds document length, so an unchecked \\resumeItem
          // count let the model grow a one-page resume onto a second page.
          const input = wrap('\\resumeItem{One}');
          const output = wrap('\\resumeItem{One}\n\\resumeItem{Two}');

          const result = validateTailoredLatex(input, output);
          expect(result.ok).toBe(false);
          expect(result.errors.some((e) => e.includes('New \\resumeItem'))).toBe(true);
        });

        it('allows deleting a bullet', () => {
          // The prompt tells the model to drop the weakest bullet when space is
          // needed, so removal must stay legal.
          const input = wrap('\\resumeItem{One}\n\\resumeItem{Two}');
          const output = wrap('\\resumeItem{One}');

          expect(validateTailoredLatex(input, output).ok).toBe(true);
        });

        it('does not miscount the list macros as bullets', () => {
          // \\resumeItem is a prefix of \\resumeItemListStart/End. Counting the
          // bare command reports 3 for one bullet, which would fire this check
          // on correct output.
          const input = wrap('\\resumeItem{One}');
          expect(validateTailoredLatex(input, input).ok).toBe(true);
        });
      });
    });

    describe('metric validation', () => {
      it('should reject fabricated large numbers not in input', () => {
        const input = `\\documentclass{article}
\\begin{document}
Reduced latency by 50% and improved throughput by 3x
\\end{document}`;

        const output = `\\documentclass{article}
\\begin{document}
Reduced latency by 50% and improved throughput by 3x, increased revenue by 999999
\\end{document}`;

        const result = validateTailoredLatex(input, output);
        expect(result.ok).toBe(false);
        expect(result.errors.some((e) =>
          e.includes('Fabricated metrics detected')
        )).toBe(true);
      });

      it('should allow common small numbers (font sizes, etc)', () => {
        const input = `\\documentclass{article}
\\begin{document}
Result: 50 items
\\end{document}`;

        const output = `\\documentclass{article}
\\begin{document}
Result: 50 items, in 10 point font
\\end{document}`;

        const result = validateTailoredLatex(input, output);
        // Common small numbers like 10 should not trigger fabrication error
        expect(result.errors.some((e) =>
          e.includes('Fabricated metrics')
        )).toBe(false);
      });

      it('should accept metrics from input appearing in output', () => {
        const input = `\\documentclass{article}
\\begin{document}
Increased efficiency by 45% and reduced latency by 2.5x
\\end{document}`;

        const output = `\\documentclass{article}
\\begin{document}
Increased efficiency by 45%, reduced latency by 2.5x across all systems
\\end{document}`;

        const result = validateTailoredLatex(input, output);
        expect(result.errors.some((e) =>
          e.includes('Fabricated metrics')
        )).toBe(false);
      });

      it('should handle percentages correctly', () => {
        const input = `\\documentclass{article}
\\begin{document}
Reduced costs by 25% and improved reliability
\\end{document}`;

        const output = `\\documentclass{article}
\\begin{document}
Reduced costs by 25% annually through optimization efforts
\\end{document}`;

        const result = validateTailoredLatex(input, output);
        expect(result.errors.some((e) =>
          e.includes('Fabricated metrics')
        )).toBe(false);
      });

      it('should handle decimal metrics', () => {
        const input = `\\documentclass{article}
\\begin{document}
Achieved 99.9% uptime and 1.5x throughput improvement
\\end{document}`;

        const output = `\\documentclass{article}
\\begin{document}
Achieved 99.9% uptime with 1.5x throughput improvement across infrastructure
\\end{document}`;

        const result = validateTailoredLatex(input, output);
        expect(result.errors.some((e) =>
          e.includes('Fabricated metrics')
        )).toBe(false);
      });
    });

    describe('comprehensive validation', () => {
      it('should accept valid tailored LaTeX with edited content', () => {
        const input = `\\documentclass[letterpaper,10pt]{article}
\\usepackage{latexsym}
\\usepackage[empty]{fullpage}
\\begin{document}

\\resumeSection{Experience}
\\resumeSubheading{Previous Company}{Jan 2020 -- Dec 2022}
\\item Implemented feature with 50% performance improvement
\\item Led team of 3 engineers
\\resumeSubheading{Another Company}{Jan 2023 -- Present}
\\item Managed systems handling 100k requests per day

\\resumeSection{Projects}
\\resumeProjectHeading{Project Alpha}{}
\\item Achieved 99.5% uptime

\\end{document}`;

        const output = `\\documentclass[letterpaper,10pt]{article}
\\usepackage{latexsym}
\\usepackage[empty]{fullpage}
\\begin{document}

\\resumeSection{Experience}
\\resumeSubheading{Previous Company}{Jan 2020 -- Dec 2022}
\\item Architected and implemented distributed system achieving 50% latency reduction
\\item Led cross-functional team of 3 engineers through major migration
\\resumeSubheading{Another Company}{Jan 2023 -- Present}
\\item Designed systems handling 100k requests per day with 99.5% uptime

\\resumeSection{Projects}
\\resumeProjectHeading{Project Alpha}{}
\\item Maintained and optimized service with 99.5% uptime SLA

\\end{document}`;

        const result = validateTailoredLatex(input, output);
        expect(result.ok).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('should catch multiple validation errors', () => {
        const input = `\\documentclass{article}
\\begin{document}
Test content with 50% improvement
\\end{document}`;

        const output = `This is not valid LaTeX
\\begin{document
Test content with 999% improvement
\\end{document}`;

        const result = validateTailoredLatex(input, output);
        expect(result.ok).toBe(false);
        expect(result.errors.length).toBeGreaterThan(1);
      });
    });
  });
});
