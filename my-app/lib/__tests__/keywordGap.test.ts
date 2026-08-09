import { describe, it, expect } from 'vitest';
import { computeKeywordGap } from '../keywordGap';

describe('keywordGap', () => {
  describe('computeKeywordGap', () => {
    it('should identify covered keywords', () => {
      const resume = `
        Experience with Python, JavaScript, and React.
        Built microservices using Node.js and Docker.
        Worked with PostgreSQL databases.
      `;

      const keywords = ['Python', 'JavaScript', 'React', 'Docker'];

      const result = computeKeywordGap(resume, keywords);

      expect(result.covered).toContain('Python');
      expect(result.covered).toContain('JavaScript');
      expect(result.covered).toContain('React');
      expect(result.covered).toContain('Docker');
      expect(result.missing).toHaveLength(0);
      expect(result.coveragePct).toBe(100);
    });

    it('should identify missing keywords', () => {
      const resume = `
        Experience with Python and React.
        Built applications using Node.js.
      `;

      const keywords = ['Python', 'React', 'Go', 'Kubernetes'];

      const result = computeKeywordGap(resume, keywords);

      expect(result.covered).toContain('Python');
      expect(result.covered).toContain('React');
      expect(result.missing).toContain('Go');
      expect(result.missing).toContain('Kubernetes');
      expect(result.coveragePct).toBe(50);
    });

    it('should handle case-insensitive matching', () => {
      const resume = `
        PYTHON development
        JavaScript expert
        react developer
      `;

      const keywords = ['python', 'JavaScript', 'REACT'];

      const result = computeKeywordGap(resume, keywords);

      expect(result.covered).toHaveLength(3);
      expect(result.missing).toHaveLength(0);
      expect(result.coveragePct).toBe(100);
    });

    it('should match multi-word phrases', () => {
      const resume = `
        Experienced with machine learning and deep learning frameworks.
        Built distributed systems at scale.
      `;

      const keywords = ['machine learning', 'deep learning', 'distributed systems'];

      const result = computeKeywordGap(resume, keywords);

      expect(result.covered).toContain('machine learning');
      expect(result.covered).toContain('deep learning');
      expect(result.covered).toContain('distributed systems');
      expect(result.coveragePct).toBe(100);
    });

    it('should handle hyphenated keywords', () => {
      const resume = `
        Experience with full-stack development and front-end frameworks.
        Used CI/CD pipelines and DevOps practices.
      `;

      const keywords = ['full-stack', 'front-end', 'CI/CD', 'DevOps'];

      const result = computeKeywordGap(resume, keywords);

      expect(result.covered).toContain('full-stack');
      expect(result.covered).toContain('front-end');
      expect(result.covered).toContain('CI/CD');
      expect(result.covered).toContain('DevOps');
      expect(result.coveragePct).toBe(100);
    });

    it('should handle dotted keywords', () => {
      const resume = `
        Expert in Node.js, Django, and ASP.NET frameworks.
        Used C++ extensively in performance-critical code.
      `;

      const keywords = ['Node.js', 'Django', 'ASP.NET', 'C++'];

      const result = computeKeywordGap(resume, keywords);

      expect(result.covered).toContain('Node.js');
      expect(result.covered).toContain('Django');
      expect(result.covered).toContain('ASP.NET');
      expect(result.covered).toContain('C++');
      expect(result.coveragePct).toBe(100);
    });

    it('should filter common words', () => {
      const resume = `
        The and or but in on at to for of with by is are was
        Python programming language
      `;

      const keywords = ['Python', 'programming', 'language'];

      const result = computeKeywordGap(resume, keywords);

      // All non-common words should be covered
      expect(result.covered).toContain('Python');
      expect(result.covered).toContain('programming');
      expect(result.covered).toContain('language');
      expect(result.coveragePct).toBe(100);
    });

    it('should calculate coverage percentage correctly', () => {
      const resume = 'Python JavaScript';
      const keywords = ['Python', 'JavaScript', 'Go', 'Rust', 'Java'];

      const result = computeKeywordGap(resume, keywords);

      expect(result.coveragePct).toBe(40); // 2/5 = 40%
    });

    it('should return 100% coverage for empty keywords', () => {
      const resume = 'Some content';
      const keywords: string[] = [];

      const result = computeKeywordGap(resume, keywords);

      expect(result.coveragePct).toBe(100);
      expect(result.covered).toHaveLength(0);
      expect(result.missing).toHaveLength(0);
    });

    it('should handle special characters in keywords', () => {
      const resume = `
        Proficient in C#, Java, and SQL.
        Experience with AWS Lambda functions.
      `;

      const keywords = ['C#', 'SQL', 'AWS Lambda'];

      const result = computeKeywordGap(resume, keywords);

      expect(result.covered).toContain('C#');
      expect(result.covered).toContain('SQL');
      expect(result.covered).toContain('AWS Lambda');
      expect(result.coveragePct).toBe(100);
    });

    it('should handle numbers in keywords', () => {
      const resume = `
        Worked with Python 3.10 and Node.js 18.
        Experience with Kubernetes 1.25 and Docker.
      `;

      const keywords = ['Python', 'Node.js', 'Kubernetes', 'Docker'];

      const result = computeKeywordGap(resume, keywords);

      expect(result.covered).toContain('Python');
      expect(result.covered).toContain('Node.js');
      expect(result.covered).toContain('Kubernetes');
      expect(result.covered).toContain('Docker');
      expect(result.coveragePct).toBe(100);
    });

    it('should distinguish between similar but different keywords', () => {
      const resume = `
        Experience with React and Vue frameworks.
        Worked with Node.js backend development.
      `;

      const keywords = ['React', 'Angular', 'Vue', 'Node.js', 'Express'];

      const result = computeKeywordGap(resume, keywords);

      expect(result.covered).toContain('React');
      expect(result.covered).toContain('Vue');
      expect(result.covered).toContain('Node.js');
      expect(result.missing).toContain('Angular');
      expect(result.missing).toContain('Express');
      expect(result.coveragePct).toBe(60); // 3/5
    });

    it('should handle very long resume text', () => {
      const longResume = `
        ${Array(1000).fill('Lorem ipsum dolor sit amet. ').join('')}
        Python expert with JavaScript experience.
      `;

      const keywords = ['Python', 'JavaScript', 'Go'];

      const result = computeKeywordGap(longResume, keywords);

      expect(result.covered).toContain('Python');
      expect(result.covered).toContain('JavaScript');
      expect(result.missing).toContain('Go');
      expect(result.coveragePct).toBe(67);
    });
  });
});
