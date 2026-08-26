import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The JWKS endpoint must actually exist.
 *
 * Every other test in this repo stubs the network, which is correct for
 * verification logic but meant a wrong URL was invisible: the code used
 * `/service_accounts/v1/jwks/...`, which 404s. Signature verification could
 * never run, so every tailor attempt told a signed-in user to sign in again.
 *
 * This test makes one real request. It is the only thing that catches a URL
 * that is well-formed, plausible, and wrong.
 *
 * If it fails in CI with a network error rather than a 404, that is a sandbox
 * limitation — but a 404 or a keyless response is a genuine failure and means
 * authentication is broken in production.
 */

const SOURCES = [
  'lib/verifyFirebaseToken.ts',
  '../services/tailor/auth.ts',
] as const;

function jwksUrlFrom(path: string): string {
  const src = readFileSync(new URL(path, new URL('../../', import.meta.url)), 'utf8');
  const match = /const JWKS_URL =\s*\n?\s*'([^']+)'/.exec(src);
  if (!match) throw new Error(`Could not find JWKS_URL in ${path}`);
  return match[1];
}

describe('Firebase JWKS endpoint', () => {
  it('is the same URL in both verifiers', () => {
    // my-app and services deliberately duplicate the verifier (my-app must not
    // depend on the Lambda workspace), so the URL can drift in one and not the
    // other.
    const [app, lambda] = SOURCES.map(jwksUrlFrom);
    expect(app).toBe(lambda);
  });

  it('serves RS256 signing keys, not a 404', async () => {
    const url = jwksUrlFrom(SOURCES[0]);

    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    expect(res.status, `${url} did not return 200`).toBe(200);

    const body = (await res.json()) as { keys?: Array<{ alg?: string; kty?: string }> };
    expect(body.keys, 'JWKS response contained no keys array').toBeDefined();
    expect(body.keys!.length).toBeGreaterThan(0);

    // The verifiers pin RS256 and hand each JWK straight to createPublicKey, so
    // a PEM/x509 endpoint would parse as JSON but fail at key construction.
    for (const key of body.keys!) {
      expect(key.kty).toBe('RSA');
      expect(key.alg).toBe('RS256');
    }
  }, 20000);
});
