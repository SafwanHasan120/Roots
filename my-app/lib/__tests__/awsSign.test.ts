import { describe, it, expect, vi } from 'vitest';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';

vi.mock('../ddbClient', () => ({
  AWS_REGION: 'us-west-2',
  resolveCredentials: () => ({ accessKeyId: 'AKIATEST', secretAccessKey: 'secret' }),
}));

const { signedFetch } = await import('../awsSign');

/**
 * Regression: SigV4 and the Firebase token cannot share `authorization`.
 *
 * The tailor function URL is authType AWS_IAM, so the Vercel route signs every
 * request. SigV4 writes its signature into `authorization` — it does not merge
 * or append, it overwrites. Passing the user's Firebase token in that header
 * meant the Lambda received only `AWS4-HMAC-SHA256 ...`, failed its Bearer
 * match, and returned 401 to a correctly signed-in user on every tailor click.
 *
 * The signing library gives no warning, and the request still succeeds — the
 * loss only surfaces as a confusing 401 from the far end.
 */
describe('signedFetch', () => {
  it('rejects a caller-supplied authorization header instead of silently losing it', async () => {
    await expect(
      signedFetch('https://x.lambda-url.us-west-2.on.aws/', {
        method: 'POST',
        body: '{}',
        headers: { authorization: 'Bearer firebase-token' },
      }),
    ).rejects.toThrow(/overwrites it/i);
  });

  it('rejects it regardless of casing', async () => {
    await expect(
      signedFetch('https://x.lambda-url.us-west-2.on.aws/', {
        method: 'POST',
        headers: { Authorization: 'Bearer firebase-token' },
      }),
    ).rejects.toThrow(/authorization/i);
  });

  it('signs a custom token header through to the request', async () => {
    // Typed args: a zero-arg mock infers an empty tuple, so indexing calls[0][1]
    // is a type error even though the call really does carry an init object.
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await signedFetch('https://x.lambda-url.us-west-2.on.aws/', {
      method: 'POST',
      body: '{}',
      headers: { 'x-firebase-token': 'Bearer firebase-token' },
    });

    const sent = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = sent.headers as Record<string, string>;

    // The token survives...
    expect(headers['x-firebase-token']).toBe('Bearer firebase-token');
    // ...and authorization carries the signature, as SigV4 requires.
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256/);
    // ...and the custom header is covered by the signature, so it cannot be
    // altered in transit.
    expect(headers.authorization).toContain('x-firebase-token');

    vi.unstubAllGlobals();
  });
});

describe('SigV4 behaviour this guards against', () => {
  it('confirms the signer really does clobber authorization', async () => {
    // Pins the upstream behaviour the guard exists for. If a future version of
    // @smithy/signature-v4 stopped overwriting, this test would tell us the
    // guard is now over-strict rather than leaving us guessing.
    const signed = await new SignatureV4({
      service: 'lambda',
      region: 'us-west-2',
      sha256: Sha256,
      credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'secret' },
    }).sign({
      method: 'POST',
      protocol: 'https:',
      hostname: 'x.lambda-url.us-west-2.on.aws',
      path: '/',
      headers: { host: 'x.lambda-url.us-west-2.on.aws', authorization: 'Bearer SENTINEL' },
      body: '{}',
    });

    const auth = (signed.headers as Record<string, string>).authorization;
    expect(auth).not.toContain('SENTINEL');
    expect(auth).toMatch(/^AWS4-HMAC-SHA256/);
  });
});
