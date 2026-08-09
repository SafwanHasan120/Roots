import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Internship } from '../types';

vi.mock('../scraper', () => ({
  scrapeAllRepos: vi.fn(),
}));

vi.mock('../firestore', () => ({
  getInternshipById: vi.fn(),
}));

import { resolveInternship, clearListingIndexCache } from '../listingResolver';
import { scrapeAllRepos } from '../scraper';
import { getInternshipById } from '../firestore';

const APP_URL = 'https://job-boards.greenhouse.io/spacex/jobs/8621756002';

function makeListing(overrides: Partial<Internship> = {}): Internship {
  return {
    id: APP_URL,
    company: 'SpaceX',
    role: 'Software Engineering Intern',
    location: 'Hawthorne, CA',
    appUrl: APP_URL,
    datePosted: 'Jan 01',
    dateMs: 1,
    prestigeScore: 1,
    source: 'test-repo',
    ...overrides,
  };
}

describe('listingResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearListingIndexCache();
  });

  it('resolves a listing present in the scrape without touching Firestore', async () => {
    vi.mocked(scrapeAllRepos).mockResolvedValue([makeListing()]);

    const result = await resolveInternship(APP_URL);

    expect(result?.company).toBe('SpaceX');
    expect(getInternshipById).not.toHaveBeenCalled();
  });

  // The bug this module exists to fix: the row is on screen (in the scrape)
  // but was never persisted to Firestore, which used to 404.
  it('resolves a scraped listing that is absent from Firestore', async () => {
    vi.mocked(scrapeAllRepos).mockResolvedValue([makeListing()]);
    vi.mocked(getInternshipById).mockResolvedValue(null);

    await expect(resolveInternship(APP_URL)).resolves.not.toBeNull();
  });

  it('resolves by normalized doc-id form', async () => {
    vi.mocked(scrapeAllRepos).mockResolvedValue([makeListing()]);

    const docId = 'job-boards.greenhouse.io_spacex_jobs_8621756002';
    const result = await resolveInternship(docId);

    expect(result?.company).toBe('SpaceX');
  });

  it('resolves when id differs from appUrl', async () => {
    vi.mocked(scrapeAllRepos).mockResolvedValue([
      makeListing({ id: 'custom-id-123' }),
    ]);

    await expect(resolveInternship('custom-id-123')).resolves.not.toBeNull();
    await expect(resolveInternship(APP_URL)).resolves.not.toBeNull();
  });

  it('falls back to Firestore when the listing is not in the scrape', async () => {
    vi.mocked(scrapeAllRepos).mockResolvedValue([]);
    vi.mocked(getInternshipById).mockResolvedValue(makeListing({ company: 'Archived' }));

    const result = await resolveInternship(APP_URL);

    expect(result?.company).toBe('Archived');
    expect(getInternshipById).toHaveBeenCalledWith(APP_URL);
  });

  it('falls back to Firestore when the scrape throws', async () => {
    vi.mocked(scrapeAllRepos).mockRejectedValue(new Error('network down'));
    vi.mocked(getInternshipById).mockResolvedValue(makeListing({ company: 'Persisted' }));

    const result = await resolveInternship(APP_URL);

    expect(result?.company).toBe('Persisted');
  });

  it('returns null when neither source has the listing', async () => {
    vi.mocked(scrapeAllRepos).mockResolvedValue([]);
    vi.mocked(getInternshipById).mockResolvedValue(null);

    await expect(resolveInternship(APP_URL)).resolves.toBeNull();
  });

  it('returns null for empty input without scraping', async () => {
    await expect(resolveInternship('')).resolves.toBeNull();
    await expect(resolveInternship('   ')).resolves.toBeNull();
    expect(scrapeAllRepos).not.toHaveBeenCalled();
  });

  it('caches the index so repeated lookups scrape once', async () => {
    vi.mocked(scrapeAllRepos).mockResolvedValue([makeListing()]);

    await resolveInternship(APP_URL);
    await resolveInternship(APP_URL);
    await resolveInternship(APP_URL);

    expect(scrapeAllRepos).toHaveBeenCalledTimes(1);
  });

  it('re-scrapes after the cache is cleared', async () => {
    vi.mocked(scrapeAllRepos).mockResolvedValue([makeListing()]);

    await resolveInternship(APP_URL);
    clearListingIndexCache();
    await resolveInternship(APP_URL);

    expect(scrapeAllRepos).toHaveBeenCalledTimes(2);
  });
});
