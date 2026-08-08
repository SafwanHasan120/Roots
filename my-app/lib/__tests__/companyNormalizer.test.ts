import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { normalizeCompanyName, addAlias, getAliasMap } from '../companyNormalizer';

describe('companyNormalizer.ts', () => {
  let originalAliasMap: Record<string, string>;

  beforeEach(() => {
    originalAliasMap = getAliasMap();
  });

  afterEach(() => {
    // Restore original map by clearing and re-adding all aliases
    const currentMap = getAliasMap();
    Object.keys(currentMap).forEach((key) => {
      if (!(key in originalAliasMap)) {
        delete currentMap[key];
      }
    });
  });

  describe('normalizeCompanyName', () => {
    it('maps "facebook" to "meta"', () => {
      expect(normalizeCompanyName('facebook')).toBe('meta');
    });

    it('maps "instagram" to "meta"', () => {
      expect(normalizeCompanyName('instagram')).toBe('meta');
    });

    it('maps "jpm" to "jpmorgan"', () => {
      expect(normalizeCompanyName('jpm')).toBe('jpmorgan');
    });

    it('maps "aws" to "amazon"', () => {
      expect(normalizeCompanyName('aws')).toBe('amazon');
    });

    it('maps "square" to "block"', () => {
      expect(normalizeCompanyName('square')).toBe('block');
    });

    it('is case-insensitive', () => {
      expect(normalizeCompanyName('FACEBOOK')).toBe('meta');
      expect(normalizeCompanyName('FaCeBooK')).toBe('meta');
      expect(normalizeCompanyName('AWS')).toBe('amazon');
    });

    it('is whitespace-insensitive', () => {
      expect(normalizeCompanyName('  facebook  ')).toBe('meta');
      expect(normalizeCompanyName('\tfacebook\n')).toBe('meta');
    });

    it('returns empty string for empty input', () => {
      expect(normalizeCompanyName('')).toBe('');
    });

    it('returns lowercased trimmed name for unknown company', () => {
      expect(normalizeCompanyName('UnknownCorp')).toBe('unknowncorp');
      expect(normalizeCompanyName('  My Startup  ')).toBe('my startup');
    });

    it('handles multiple-word aliases', () => {
      expect(normalizeCompanyName('JP Morgan')).toBe('jpmorgan');
      expect(normalizeCompanyName('Goldman Sachs')).toBe('goldman sachs');
    });
  });

  describe('addAlias', () => {
    it('adds a new alias mapping', () => {
      addAlias('TestCorp', 'test-canonical');
      expect(normalizeCompanyName('testcorp')).toBe('test-canonical');
    });

    it('is case-insensitive for both alias and canonical', () => {
      addAlias('NEWCOMPANY', 'NewCanonical');
      expect(normalizeCompanyName('newcompany')).toBe('newcanonical');
    });

    it('overwrites existing aliases', () => {
      const original = normalizeCompanyName('facebook');
      addAlias('facebook', 'new-canonical');
      expect(normalizeCompanyName('facebook')).toBe('new-canonical');

      // Restore
      addAlias('facebook', original);
    });
  });

  describe('getAliasMap', () => {
    it('returns a copy of the alias map', () => {
      const map = getAliasMap();
      expect(typeof map).toBe('object');
      expect('facebook' in map).toBe(true);
    });

    it('includes meta ecosystem aliases', () => {
      const map = getAliasMap();
      expect(map['facebook']).toBe('meta');
      expect(map['instagram']).toBe('meta');
      expect(map['whatsapp']).toBe('meta');
    });

    it('includes Amazon aliases', () => {
      const map = getAliasMap();
      expect(map['amazon']).toBe('amazon');
      expect(map['aws']).toBe('amazon');
    });

    it('includes JPMorgan aliases', () => {
      const map = getAliasMap();
      // 'jpmorgan' is an entry
      expect(map['jpm']).toBe('jpmorgan');
      expect(map['jp morgan']).toBe('jpmorgan');
    });

    it('includes Block (Square) aliases', () => {
      const map = getAliasMap();
      expect(map['block']).toBe('block');
      expect(map['square']).toBe('block');
    });
  });
});
