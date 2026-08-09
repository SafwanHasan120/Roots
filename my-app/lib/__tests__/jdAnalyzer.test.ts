import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { analyzeJD, clearAnalysisCache } from '../jdAnalyzer';
import * as rateLimiter from '../rateLimiter';
import * as retryManager from '../retryManager';

vi.mock('../rateLimiter');
vi.mock('../retryManager');

describe('jdAnalyzer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAnalysisCache();
  });

  afterEach(() => {
    clearAnalysisCache();
  });

  describe('analyzeJD', () => {
    it('should parse valid JD analysis response', async () => {
      const jdText = 'Seeking a Python developer with 5 years experience in backend development.';
      const appUrl = 'https://example.com/job/123';

      const mockResponse = {
        ok: true,
        json: async () => ({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                required_skills: ['Python', 'Django', 'PostgreSQL'],
                preferred_skills: ['AWS', 'Docker'],
                domain: 'backend',
                seniority_signals: ['5+ years experience', 'backend development'],
                keywords: ['Python', 'Django', 'PostgreSQL', 'AWS', 'Docker', 'backend'],
              }),
            },
          ],
        }),
      };

      vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
        (url, fn) => fn()
      );
      vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(mockResponse as any);

      const result = await analyzeJD(jdText, appUrl);

      expect(result.required_skills).toContain('Python');
      expect(result.required_skills).toContain('Django');
      expect(result.preferred_skills).toContain('AWS');
      expect(result.domain).toBe('backend');
      expect(result.keywords.length).toBeGreaterThan(0);
    });

    it('should parse a response wrapped in a markdown code fence', async () => {
      const appUrl = 'https://example.com/job/fenced';
      const payload = JSON.stringify(
        {
          required_skills: ['Python'],
          preferred_skills: ['Kubernetes'],
          domain: 'backend',
          seniority_signals: ['entry level'],
          keywords: ['Python', 'Kubernetes'],
        },
        null,
        2
      );

      const mockResponse = {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: '```json\n' + payload + '\n```' }],
        }),
      };

      vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce((url, fn) => fn());
      vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(mockResponse as any);

      const result = await analyzeJD('Backend role', appUrl);

      expect(result.required_skills).toContain('Python');
      expect(result.keywords).toContain('Kubernetes');
    });

    it('should parse a fenced response without a language tag', async () => {
      const appUrl = 'https://example.com/job/fenced-plain';
      const payload = JSON.stringify({
        required_skills: ['Go'],
        preferred_skills: [],
        domain: 'backend',
        seniority_signals: [],
        keywords: ['Go'],
      });

      const mockResponse = {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: '```\n' + payload + '\n```' }],
        }),
      };

      vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce((url, fn) => fn());
      vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(mockResponse as any);

      const result = await analyzeJD('Backend role', appUrl);

      expect(result.required_skills).toContain('Go');
    });

    it('should cache analysis results', async () => {
      const jdText = 'Senior Full Stack Engineer needed.';
      const appUrl = 'https://example.com/job/456';

      const mockResponse = {
        ok: true,
        json: async () => ({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                required_skills: ['React', 'Node.js'],
                preferred_skills: ['GraphQL'],
                domain: 'full-stack',
                seniority_signals: ['Senior level', 'leadership expected'],
                keywords: ['React', 'Node.js', 'GraphQL', 'full-stack'],
              }),
            },
          ],
        }),
      };

      vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
        (url, fn) => fn()
      );
      vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(mockResponse as any);

      const result1 = await analyzeJD(jdText, appUrl);

      // Clear mocks for second call
      vi.clearAllMocks();

      // Second call should use cache
      const result2 = await analyzeJD(jdText, appUrl);

      expect(result2).toEqual(result1);
      // Fetch should not be called again
      expect(retryManager.fetchWithRetry).not.toHaveBeenCalled();
    });

    it('should throw on invalid JSON response', async () => {
      const jdText = 'Some job description';
      const appUrl = 'https://example.com/job/789';

      const mockResponse = {
        ok: true,
        json: async () => ({
          content: [
            {
              type: 'text',
              text: 'Not valid JSON { broken',
            },
          ],
        }),
      };

      vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
        (url, fn) => fn()
      );
      vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(mockResponse as any);

      await expect(analyzeJD(jdText, appUrl)).rejects.toThrow();
    });

    it('should throw on missing required fields', async () => {
      const jdText = 'Job description';
      const appUrl = 'https://example.com/job/999';

      const mockResponse = {
        ok: true,
        json: async () => ({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                required_skills: ['Python'],
                // Missing other required fields
              }),
            },
          ],
        }),
      };

      vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
        (url, fn) => fn()
      );
      vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(mockResponse as any);

      await expect(analyzeJD(jdText, appUrl)).rejects.toThrow(
        'Invalid JD analysis structure'
      );
    });

    it('should handle missing content block', async () => {
      const jdText = 'Job description';
      const appUrl = 'https://example.com/job/nocontent';

      const mockResponse = {
        ok: true,
        json: async () => ({
          content: [],
        }),
      };

      vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
        (url, fn) => fn()
      );
      vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(mockResponse as any);

      await expect(analyzeJD(jdText, appUrl)).rejects.toThrow(
        'Invalid Claude API response'
      );
    });

    it('should return analysis with all fields populated', async () => {
      const jdText = 'Job posting text';
      const appUrl = 'https://example.com/job/complete';

      const mockResponse = {
        ok: true,
        json: async () => ({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                required_skills: ['Skill1', 'Skill2'],
                preferred_skills: ['Skill3', 'Skill4'],
                domain: 'data',
                seniority_signals: ['Senior', 'leadership'],
                keywords: ['Skill1', 'Skill2', 'data'],
              }),
            },
          ],
        }),
      };

      vi.mocked(rateLimiter.rateLimitedFetch).mockImplementationOnce(
        (url, fn) => fn()
      );
      vi.mocked(retryManager.fetchWithRetry).mockResolvedValueOnce(mockResponse as any);

      const result = await analyzeJD(jdText, appUrl);

      expect(result.required_skills).toHaveLength(2);
      expect(result.preferred_skills).toHaveLength(2);
      expect(result.seniority_signals).toHaveLength(2);
      expect(result.keywords).toHaveLength(3);
      expect(result.domain).toBe('data');
    });
  });
});
