import { describe, it, expect } from 'vitest';
import { companyFocus, prestigeOf } from '../companies';

describe('companies.ts', () => {
  describe('companyFocus', () => {
    it('classifies big tech, including the Facebook alias', () => {
      expect(companyFocus('Google')).toBe('tech');
      expect(companyFocus('Facebook')).toBe('tech');
      expect(companyFocus('Instagram')).toBe('tech');
    });

    it('classifies finance and trading, including the JP Morgan alias', () => {
      expect(companyFocus('Jane Street')).toBe('finance');
      expect(companyFocus('JP Morgan')).toBe('finance');
      expect(companyFocus('JPM')).toBe('finance');
    });

    it('returns null for a company on neither list', () => {
      expect(companyFocus('Unknown Corp')).toBeNull();
      expect(companyFocus('')).toBeNull();
    });
  });

  describe('prestigeOf', () => {
    it('keeps the old tier scores', () => {
      expect(prestigeOf('Google')).toBe(1.0);
      expect(prestigeOf('Jane Street')).toBe(1.0);
      expect(prestigeOf('Uber')).toBe(0.5);
      expect(prestigeOf('Goldman Sachs')).toBe(0.5);
      expect(prestigeOf('Unknown Corp')).toBe(0);
    });
  });
});
