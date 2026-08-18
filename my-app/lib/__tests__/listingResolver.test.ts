import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Internship } from '../types';

// The resolver reads the same store the homepage renders from. Before the AWS
// migration that was a live scrape; it is now DynamoDB behind listingsSource.
// Every behaviour asserted here predates the migration — only the backing
// store changed.
vi.mock('../listingsSource', () => ({
  readActiveListings: vi.fn(),
  getListingsSource: vi.fn(() => 'ddb'),
}));

vi.mock('../listingsRepo', () => ({
  getListingById: vi.fn(),
}));

vi.mock('../firestore', () => ({
  getInternshipById: vi.fn(),
}));

import { resolveInternship, clearListingIndexCache, listingIdFor } from '../listingResolver';
import { readActiveListings } from '../listingsSource';
import { getListingById } from '../listingsRepo';

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
    vi.mocked(getListingById).mockResolvedValue(null);
  });

  it('resolves a listing present in the active index without a point lookup', async () => {
    vi.mocked(readActiveListings).mockResolvedValue([makeListing()]);

    const result = await resolveInternship(APP_URL);

    expect(result?.company).toBe('SpaceX');
    expect(getListingById).not.toHaveBeenCalled();
  });

  it('resolves by normalized doc-id form', async () => {
    vi.mocked(readActiveListings).mockResolvedValue([makeListing()]);

    const docId = 'job-boards.greenhouse.io_spacex_jobs_8621756002';
    const result = await resolveInternship(docId);

    expect(result?.company).toBe('SpaceX');
  });

  it('resolves by the surrogate listing id the scrape worker writes', async () => {
    // The client may hold the DynamoDB id rather than the URL.
    vi.mocked(readActiveListings).mockResolvedValue([makeListing()]);

    const result = await resolveInternship(listingIdFor(APP_URL));

    expect(result?.company).toBe('SpaceX');
  });

  it('resolves when id differs from appUrl', async () => {
    vi.mocked(readActiveListings).mockResolvedValue([makeListing({ id: 'custom-id-123' })]);

    await expect(resolveInternship('custom-id-123')).resolves.not.toBeNull();
    await expect(resolveInternship(APP_URL)).resolves.not.toBeNull();
  });

  // A deactivated listing leaves GSI1v2 but stays in the base table, so a
  // point lookup must still find it — otherwise tailoring breaks for anything
  // the sweep has retired.
  it('falls back to a point lookup when the listing is not in the active index', async () => {
    vi.mocked(readActiveListings).mockResolvedValue([]);
    vi.mocked(getListingById).mockResolvedValue(makeListing({ company: 'Archived' }));

    const result = await resolveInternship(APP_URL);

    expect(result?.company).toBe('Archived');
    expect(getListingById).toHaveBeenCalled();
  });

  it('hashes an appUrl when the raw id misses', async () => {
    vi.mocked(readActiveListings).mockResolvedValue([]);
    vi.mocked(getListingById).mockImplementation(async (id: string) =>
      id === listingIdFor(APP_URL) ? makeListing({ company: 'ByHash' }) : null,
    );

    const result = await resolveInternship(APP_URL);

    expect(result?.company).toBe('ByHash');
  });

  it('falls back to a point lookup when the read throws', async () => {
    vi.mocked(readActiveListings).mockRejectedValue(new Error('network down'));
    vi.mocked(getListingById).mockResolvedValue(makeListing({ company: 'Persisted' }));

    const result = await resolveInternship(APP_URL);

    expect(result?.company).toBe('Persisted');
  });

  it('returns null when neither source has the listing', async () => {
    vi.mocked(readActiveListings).mockResolvedValue([]);
    vi.mocked(getListingById).mockResolvedValue(null);

    await expect(resolveInternship(APP_URL)).resolves.toBeNull();
  });

  it('returns null for empty input without reading', async () => {
    await expect(resolveInternship('')).resolves.toBeNull();
    await expect(resolveInternship('   ')).resolves.toBeNull();
    expect(readActiveListings).not.toHaveBeenCalled();
  });

  it('caches the index so repeated lookups read once', async () => {
    vi.mocked(readActiveListings).mockResolvedValue([makeListing()]);

    await resolveInternship(APP_URL);
    await resolveInternship(APP_URL);
    await resolveInternship(APP_URL);

    expect(readActiveListings).toHaveBeenCalledTimes(1);
  });

  it('re-reads after the cache is cleared', async () => {
    vi.mocked(readActiveListings).mockResolvedValue([makeListing()]);

    await resolveInternship(APP_URL);
    clearListingIndexCache();
    await resolveInternship(APP_URL);

    expect(readActiveListings).toHaveBeenCalledTimes(2);
  });

  it('does not fail the resolve when the store is empty', async () => {
    // throwOnEmpty must be off here: an empty store still allows a point lookup.
    vi.mocked(readActiveListings).mockResolvedValue([]);

    await resolveInternship(APP_URL);

    expect(vi.mocked(readActiveListings).mock.calls[0][0]).toMatchObject({
      throwOnEmpty: false,
    });
  });
});
