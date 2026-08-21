import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as rateLimiter from '../rateLimiter';
import * as retryManager from '../retryManager';
import { scrapeOneSource } from '../scraper';

vi.mock('../rateLimiter');
vi.mock('../retryManager');

/**
 * The branch must reach every GitHub request.
 *
 * The commit-SHA change detector used to query `/commits?path=README.md` with no
 * `sha=`, so GitHub answered with the *default branch's* HEAD while the content
 * fetch pulled whatever branch the source URL named. When those differ the
 * detector compares one branch's HEAD to another's content, decides "unchanged",
 * and returns zero listings — and three such runs let the sweep deactivate the
 * whole source (SWEEP_GRACE_RUNS = 3).
 *
 * vanshb03's default branch really is `dev` while sources.json said `/main/`,
 * and `?sha=main` 404s there, so this was live, not theoretical.
 */

const DEV_URL = 'https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/dev/README.md';

/** Every URL passed to fetchWithRetry, in call order. */
function requestedUrls(): string[] {
  return vi.mocked(retryManager.fetchWithRetry).mock.calls.map((c) => String(c[0]));
}

function res(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 404,
    headers: { get: () => null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

beforeEach(() => {
  vi.resetAllMocks();
  // Pass through the rate limiter so we observe the real URLs.
  vi.mocked(rateLimiter.rateLimitedFetch).mockImplementation((_url, fn) => fn() as never);
});

describe('branch propagation into GitHub requests', () => {
  it('pins the commits query to the URL branch via sha=', async () => {
    vi.mocked(retryManager.fetchWithRetry).mockResolvedValue(res([{ sha: 'abc123' }]));

    await scrapeOneSource(DEV_URL).catch(() => {
      /* downstream parsing is not under test here */
    });

    const commits = requestedUrls().find((u) => u.includes('api.github.com'));
    expect(commits, 'expected a commits API call').toBeDefined();
    expect(commits).toContain('sha=dev');
    expect(commits).not.toContain('sha=main');
  });

  it('requests listings.json from the URL branch, not a hardcoded main', async () => {
    vi.mocked(retryManager.fetchWithRetry).mockImplementation(async (u: string) => {
      if (String(u).includes('api.github.com')) return res([{ sha: 'newsha' }]);
      return res('# empty');
    });

    await scrapeOneSource(DEV_URL).catch(() => {});

    const struct = requestedUrls().find((u) => u.includes('listings.json'));
    expect(struct, 'expected a listings.json probe').toBeDefined();
    expect(struct).toContain('/dev/.github/scripts/listings.json');
    expect(struct).not.toContain('/main/');
  });

  it('short-circuits only when the SHA of the SAME branch is unchanged', async () => {
    vi.mocked(retryManager.fetchWithRetry).mockResolvedValue(res([{ sha: 'same' }]));

    const out = await scrapeOneSource(DEV_URL, { sha: 'same', failCount: 0 });

    expect(out.listings).toEqual([]);
    expect(out.state.sha).toBe('same');
    // Short-circuit means exactly one request: the commits check. Nothing else.
    expect(requestedUrls().filter((u) => !u.includes('api.github.com'))).toHaveLength(0);
  });

  it('falls through to an unconditional fetch for a non-GitHub source', async () => {
    vi.mocked(retryManager.fetchWithRetry).mockResolvedValue(res('# not github'));

    await scrapeOneSource('https://example.com/jobs.md').catch(() => {});

    // repoRef returns null, so neither GitHub-specific request is attempted.
    expect(requestedUrls().some((u) => u.includes('api.github.com'))).toBe(false);
    expect(requestedUrls().some((u) => u.includes('listings.json'))).toBe(false);
  });
});
