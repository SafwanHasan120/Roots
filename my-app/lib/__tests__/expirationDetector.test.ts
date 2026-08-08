import { describe, it, expect } from 'vitest';
import { detectExpiration, getExpirationBadge, isExpiredOrOld } from '../expirationDetector';

describe('expirationDetector.ts', () => {
  describe('detectExpiration', () => {
    it('returns "no-date" reason when dateMs === 0', () => {
      const result = detectExpiration(0, new Date('2024-01-15').getTime());
      expect(result.reason).toBe('no-date');
      expect(result.isExpired).toBe(false);
      expect(result.warningThreshold).toBe(false);
    });

    it('returns "posted-last-year" when posting is from previous year', () => {
      const lastYear = new Date(2023, 6, 1).getTime(); // July 2023
      const currentYear = new Date(2024, 0, 15).getTime(); // Jan 2024
      const result = detectExpiration(lastYear, currentYear);
      expect(result.reason).toBe('posted-last-year');
      expect(result.isExpired).toBe(true);
    });

    it('returns "over-6-months" when age exceeds 6 months in same year', () => {
      const sixMonthsAgo = new Date(2024, 0, 1).getTime(); // Jan 2024
      const current = new Date(2024, 7, 1).getTime(); // Aug 2024 (7 months later)
      const result = detectExpiration(sixMonthsAgo, current);
      expect(result.reason).toBe('over-6-months');
      expect(result.isExpired).toBe(true);
    });

    it('sets warningThreshold true between 5.5 and 6 months', () => {
      const fiveMonthsAgo = new Date(2024, 0, 1).getTime(); // Jan 1, 2024
      const current = new Date(2024, 5, 15).getTime(); // June 15, 2024 (~5.5 months)
      const result = detectExpiration(fiveMonthsAgo, current);
      expect(result.warningThreshold).toBe(true);
      expect(result.isExpired).toBe(false);
      expect(result.reason).toBe('fresh');
    });

    it('returns "fresh" for recent postings', () => {
      const today = new Date(2024, 0, 15).getTime();
      const yesterday = new Date(2024, 0, 14).getTime();
      const result = detectExpiration(yesterday, today);
      expect(result.reason).toBe('fresh');
      expect(result.isExpired).toBe(false);
      expect(result.warningThreshold).toBe(false);
    });

    it('calculates expiresAt correctly for over-6-months', () => {
      const sixMonthsAgo = new Date(2024, 0, 1).getTime();
      const current = new Date(2024, 7, 1).getTime();
      const result = detectExpiration(sixMonthsAgo, current);
      // expiresAt should be sixMonthsAgo + 6 months
      expect(result.expiresAt).toBe(sixMonthsAgo + 6 * 30 * 24 * 60 * 60 * 1000);
    });
  });

  describe('getExpirationBadge', () => {
    it('returns "📅 Last Year" for posted-last-year', () => {
      expect(getExpirationBadge('posted-last-year')).toBe('📅 Last Year');
    });

    it('returns "⏰ Over 6mo" for over-6-months', () => {
      expect(getExpirationBadge('over-6-months')).toBe('⏰ Over 6mo');
    });

    it('returns "❓ Unknown Date" for no-date', () => {
      expect(getExpirationBadge('no-date')).toBe('❓ Unknown Date');
    });

    it('returns empty string for fresh', () => {
      expect(getExpirationBadge('fresh')).toBe('');
    });
  });

  describe('isExpiredOrOld', () => {
    it('returns true for expired listing without includeWarning', () => {
      const sixMonthsAgo = new Date(2023, 6, 1).getTime();
      const current = new Date(2024, 1, 1).getTime();
      const result = isExpiredOrOld(sixMonthsAgo, false, current);
      expect(result).toBe(true);
    });

    it('returns false for fresh listing', () => {
      const today = new Date(2024, 0, 15).getTime();
      const yesterday = new Date(2024, 0, 14).getTime();
      const result = isExpiredOrOld(yesterday, false, today);
      expect(result).toBe(false);
    });

    it('returns true for warning threshold when includeWarning is true', () => {
      const fiveMonthsAgo = new Date(2024, 0, 1).getTime();
      const current = new Date(2024, 5, 15).getTime(); // ~5.5 months
      const result = isExpiredOrOld(fiveMonthsAgo, true, current);
      expect(result).toBe(true);
    });

    it('returns false for warning threshold when includeWarning is false', () => {
      const fiveMonthsAgo = new Date(2024, 0, 1).getTime();
      const current = new Date(2024, 5, 15).getTime(); // ~5.5 months
      const result = isExpiredOrOld(fiveMonthsAgo, false, current);
      expect(result).toBe(false);
    });

    it('uses Date.now() when currentDateMs not provided', () => {
      // This test verifies that the function defaults to Date.now()
      // We just verify it doesn't throw and returns a boolean
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const result = isExpiredOrOld(yesterday.getTime());
      expect(typeof result).toBe('boolean');
    });

    it('returns false for dateMs === 0', () => {
      const result = isExpiredOrOld(0, false, new Date().getTime());
      expect(result).toBe(false);
    });
  });
});
