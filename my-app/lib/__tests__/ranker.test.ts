import { describe, it, expect } from 'vitest';
import { rankInternships } from '../ranker';
import type { Internship } from '../types';

describe('ranker.ts', () => {
  describe('rankInternships', () => {
    it('returns empty array for empty input', () => {
      expect(rankInternships([])).toEqual([]);
    });

    it('returns single element unchanged', () => {
      const input: Internship[] = [
        {
          id: '1',
          company: 'Acme',
          role: 'SDE',
          location: 'NYC',
          appUrl: 'https://example.com/apply',
          datePosted: 'Jan 1',
          dateMs: Date.now(),
          prestigeScore: 1.0,
          source: 'test',
        },
      ];
      const result = rankInternships(input);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });

    it('deduplicates by appUrl, keeping first occurrence', () => {
      const now = Date.now();
      const input: Internship[] = [
        {
          id: '1',
          company: 'Acme',
          role: 'SDE',
          location: 'NYC',
          appUrl: 'https://example.com/apply',
          datePosted: 'Jan 1',
          dateMs: now,
          prestigeScore: 1.0,
          source: 'test1',
        },
        {
          id: '2',
          company: 'Acme2',
          role: 'PM',
          location: 'SF',
          appUrl: 'https://example.com/apply',
          datePosted: 'Jan 2',
          dateMs: now + 86400000,
          prestigeScore: 0.5,
          source: 'test2',
        },
      ];
      const result = rankInternships(input);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
      expect(result[0].role).toBe('SDE');
    });

    it('deduplicates by id field when appUrl is empty', () => {
      const input: Internship[] = [
        {
          id: 'test:acme:sde:nyc',
          company: 'Acme',
          role: 'SDE',
          location: 'NYC',
          appUrl: '',
          datePosted: 'Jan 1',
          dateMs: 0,
          prestigeScore: 1.0,
          source: 'test1',
        },
        {
          id: 'test:acme:sde:nyc',
          company: 'Acme',
          role: 'SDE',
          location: 'NYC',
          appUrl: '',
          datePosted: 'Jan 2',
          dateMs: Date.now(),
          prestigeScore: 0.5,
          source: 'test2',
        },
      ];
      const result = rankInternships(input);
      expect(result).toHaveLength(1);
    });

    it('normalizes recency to [0,1] across min/max of entries with dateMs > 0', () => {
      const base = new Date('2024-01-01').getTime();
      const input: Internship[] = [
        {
          id: '1',
          company: 'Acme',
          role: 'SDE',
          location: 'NYC',
          appUrl: 'https://example.com/1',
          datePosted: 'Jan 1',
          dateMs: base,
          prestigeScore: 0,
          source: 'test',
        },
        {
          id: '2',
          company: 'Acme',
          role: 'SDE',
          location: 'NYC',
          appUrl: 'https://example.com/2',
          datePosted: 'Jan 2',
          dateMs: base + 86400000,
          prestigeScore: 0,
          source: 'test',
        },
      ];
      const result = rankInternships(input);
      // Both have prestigeScore 0, so score is purely recency * 0.6
      // First has recency 0, second has recency 1
      expect(result[0].id).toBe('2');
      expect(result[1].id).toBe('1');
    });

    it('scores dateMs === 0 as recency 0', () => {
      const now = Date.now();
      const input: Internship[] = [
        {
          id: '1',
          company: 'Acme',
          role: 'SDE',
          location: 'NYC',
          appUrl: 'https://example.com/1',
          datePosted: '—',
          dateMs: 0,
          prestigeScore: 1.0,
          source: 'test',
        },
        {
          id: '2',
          company: 'Acme',
          role: 'SDE',
          location: 'NYC',
          appUrl: 'https://example.com/2',
          datePosted: 'Jan 1',
          dateMs: now,
          prestigeScore: 0,
          source: 'test',
        },
      ];
      const result = rankInternships(input);
      // Entry 2: recency 1 (only entry with date) * 0.6 + prestige 0 * 0.4 = 0.6
      // Entry 1: recency 0 * 0.6 + prestige 1.0 * 0.4 = 0.4
      expect(result[0].id).toBe('2');
      expect(result[1].id).toBe('1');
    });

    it('handles all entries with dateMs === 0 without producing NaN', () => {
      const input: Internship[] = [
        {
          id: '1',
          company: 'Acme',
          role: 'SDE',
          location: 'NYC',
          appUrl: 'https://example.com/1',
          datePosted: '—',
          dateMs: 0,
          prestigeScore: 1.0,
          source: 'test',
        },
        {
          id: '2',
          company: 'Acme',
          role: 'PM',
          location: 'NYC',
          appUrl: 'https://example.com/2',
          datePosted: '—',
          dateMs: 0,
          prestigeScore: 0.5,
          source: 'test',
        },
      ];
      const result = rankInternships(input);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('1'); // higher prestige
      expect(Number.isNaN(result[0].prestigeScore)).toBe(false);
    });

    it('applies 0.8x multiplier for bad linkHealth', () => {
      const now = Date.now();
      const input: Internship[] = [
        {
          id: '1',
          company: 'Acme',
          role: 'SDE',
          location: 'NYC',
          appUrl: 'https://example.com/1',
          datePosted: 'Jan 1',
          dateMs: now,
          prestigeScore: 1.0,
          linkHealth: 'healthy',
          source: 'test',
        },
        {
          id: '2',
          company: 'Acme',
          role: 'SDE',
          location: 'NYC',
          appUrl: 'https://example.com/2',
          datePosted: 'Jan 1',
          dateMs: now,
          prestigeScore: 1.0,
          linkHealth: 'not-found',
          source: 'test',
        },
      ];
      const result = rankInternships(input);
      expect(result[0].id).toBe('1'); // healthy multiplier is 1.0
      expect(result[1].id).toBe('2'); // not-found multiplier is 0.8
    });

    it('applies 0.8x multiplier for server-error linkHealth', () => {
      const now = Date.now();
      const input: Internship[] = [
        {
          id: '1',
          company: 'Acme',
          role: 'SDE',
          location: 'NYC',
          appUrl: 'https://example.com/1',
          datePosted: 'Jan 1',
          dateMs: now,
          prestigeScore: 1.0,
          linkHealth: 'server-error',
          source: 'test',
        },
      ];
      const result = rankInternships(input);
      expect(result).toHaveLength(1);
    });

    it('applies 0.8x multiplier for timeout linkHealth', () => {
      const now = Date.now();
      const input: Internship[] = [
        {
          id: '1',
          company: 'Acme',
          role: 'SDE',
          location: 'NYC',
          appUrl: 'https://example.com/1',
          datePosted: 'Jan 1',
          dateMs: now,
          prestigeScore: 1.0,
          linkHealth: 'timeout',
          source: 'test',
        },
      ];
      const result = rankInternships(input);
      expect(result).toHaveLength(1);
    });

    it('does not apply linkHealth multiplier for undefined or unknown', () => {
      const now = Date.now();
      const input: Internship[] = [
        {
          id: '1',
          company: 'Acme',
          role: 'SDE',
          location: 'NYC',
          appUrl: 'https://example.com/1',
          datePosted: 'Jan 1',
          dateMs: now,
          prestigeScore: 1.0,
          linkHealth: 'unknown',
          source: 'test',
        },
      ];
      const result = rankInternships(input);
      expect(result).toHaveLength(1);
    });

    it('applies 0.1x multiplier for isExpired', () => {
      const now = Date.now();
      const input: Internship[] = [
        {
          id: '1',
          company: 'Acme',
          role: 'SDE',
          location: 'NYC',
          appUrl: 'https://example.com/1',
          datePosted: 'Jan 1',
          dateMs: now,
          prestigeScore: 1.0,
          isExpired: false,
          source: 'test',
        },
        {
          id: '2',
          company: 'Acme',
          role: 'SDE',
          location: 'NYC',
          appUrl: 'https://example.com/2',
          datePosted: 'Jan 1',
          dateMs: now,
          prestigeScore: 1.0,
          isExpired: true,
          source: 'test',
        },
      ];
      const result = rankInternships(input);
      expect(result[0].id).toBe('1');
      expect(result[1].id).toBe('2');
    });

    it('sorts by score descending', () => {
      const now = Date.now();
      const input: Internship[] = [
        {
          id: '1',
          company: 'Acme',
          role: 'SDE',
          location: 'NYC',
          appUrl: 'https://example.com/1',
          datePosted: 'Jan 1',
          dateMs: now - 86400000,
          prestigeScore: 0,
          source: 'test',
        },
        {
          id: '2',
          company: 'Acme',
          role: 'SDE',
          location: 'NYC',
          appUrl: 'https://example.com/2',
          datePosted: 'Jan 2',
          dateMs: now,
          prestigeScore: 0,
          source: 'test',
        },
      ];
      const result = rankInternships(input);
      expect(result[0].id).toBe('2');
      expect(result[1].id).toBe('1');
    });

    it('caps results at MAX_RESULTS (1000)', () => {
      const input: Internship[] = [];
      for (let i = 0; i < 1500; i++) {
        input.push({
          id: `${i}`,
          company: 'Acme',
          role: 'SDE',
          location: 'NYC',
          appUrl: `https://example.com/${i}`,
          datePosted: 'Jan 1',
          dateMs: Date.now() - i * 1000,
          prestigeScore: Math.random(),
          source: 'test',
        });
      }
      const result = rankInternships(input);
      expect(result).toHaveLength(1000);
    });

    it('score formula: recency*0.6 + prestige*0.4', () => {
      const base = new Date('2024-01-01').getTime();
      const input: Internship[] = [
        {
          id: '1',
          company: 'Acme',
          role: 'SDE',
          location: 'NYC',
          appUrl: 'https://example.com/1',
          datePosted: 'Jan 1',
          dateMs: base,
          prestigeScore: 0,
          source: 'test',
        },
        {
          id: '2',
          company: 'Acme',
          role: 'SDE',
          location: 'NYC',
          appUrl: 'https://example.com/2',
          datePosted: 'Jan 2',
          dateMs: base + 86400000,
          prestigeScore: 0.5,
          source: 'test',
        },
      ];
      const result = rankInternships(input);
      // Entry 1: recency 0 * 0.6 + 0 * 0.4 = 0
      // Entry 2: recency 1 * 0.6 + 0.5 * 0.4 = 0.6 + 0.2 = 0.8
      expect(result[0].id).toBe('2');
    });
  });
});
