import { describe, it, expect } from 'vitest';
import { listingHash } from '../ddb.js';
import type { Internship } from '@app/types';

const base: Internship = {
  id: 'https://example.com/job/1',
  company: 'Acme Corp',
  role: 'SWE Intern',
  location: 'Remote',
  appUrl: 'https://example.com/job/1',
  datePosted: 'Aug 01',
  dateMs: Date.UTC(2026, 7, 1),
  prestigeScore: 0.5,
  source: 'owner/repo',
};

describe('listingHash', () => {
  it('is stable across calls', () => {
    expect(listingHash(base)).toBe(listingHash(base));
  });

  it('does not depend on key insertion order', () => {
    // The whole idempotency guarantee rests on this: JSON.stringify over an
    // object would vary with property order and report spurious changes,
    // rewriting every listing on every run.
    const reordered = {
      source: base.source,
      prestigeScore: base.prestigeScore,
      dateMs: base.dateMs,
      datePosted: base.datePosted,
      appUrl: base.appUrl,
      location: base.location,
      role: base.role,
      company: base.company,
      id: base.id,
    } as Internship;

    expect(listingHash(reordered)).toBe(listingHash(base));
  });

  it.each([
    ['company', { company: 'Other Corp' }],
    ['role', { role: 'Data Intern' }],
    ['location', { location: 'NYC' }],
    ['appUrl', { appUrl: 'https://example.com/job/2' }],
    ['dateMs', { dateMs: Date.UTC(2026, 7, 2) }],
    ['datePosted', { datePosted: 'Aug 02' }],
    ['prestigeScore', { prestigeScore: 1 }],
    ['source', { source: 'other/repo' }],
    ['isExpired', { isExpired: true }],
    ['expirationReason', { expirationReason: 'over-6-months' as const }],
  ])('changes when %s changes', (_field, patch) => {
    expect(listingHash({ ...base, ...patch })).not.toBe(listingHash(base));
  });

  it('treats an absent optional field as distinct from a set one', () => {
    expect(listingHash({ ...base, companyUrl: 'https://acme.com' })).not.toBe(
      listingHash(base),
    );
  });

  it('does not change when linkHealth changes', () => {
    // linkHealth is probe output, not source content. Including it would make
    // a flaky HEAD request rewrite the item on every run and defeat the
    // conditional write.
    expect(listingHash({ ...base, linkHealth: 'healthy' })).toBe(listingHash(base));
  });

  it('produces a sha256 hex digest', () => {
    expect(listingHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});
