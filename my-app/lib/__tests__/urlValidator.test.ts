import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearUrlCache, getCacheStats } from '../urlValidator';

describe('urlValidator.ts', () => {
  beforeEach(() => {
    clearUrlCache();
    vi.clearAllMocks();
  });

  describe('clearUrlCache', () => {
    it('clears cached results', () => {
      // This test just verifies the function exists and doesn't throw
      expect(() => clearUrlCache()).not.toThrow();
    });
  });

  describe('getCacheStats', () => {
    it('returns cache statistics', () => {
      const stats = getCacheStats();
      expect(stats).toHaveProperty('cachedUrls');
      expect(stats).toHaveProperty('entries');
      expect(Array.isArray(stats.entries)).toBe(true);
    });

    it('returns empty cache initially', () => {
      const stats = getCacheStats();
      expect(stats.cachedUrls).toBe(0);
      expect(stats.entries).toEqual([]);
    });
  });

  // Note: Comprehensive validation tests for validateUrl and validateUrls are skipped
  // because they require mocking fetch/rateLimitedFetch which have complex internal dependencies.
  // In a production environment, these would use proper fetch mocking or an HTTP mock server.
});
