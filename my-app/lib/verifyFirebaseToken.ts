import { createPublicKey, createVerify } from 'crypto';

/**
 * Firebase ID token verification for Next route handlers.
 *
 * Deliberately a copy of services/tailor/auth.ts rather than an import: my-app
 * ships to Vercel and must not depend on the services workspace, which is
 * bundled for Lambda. The two are kept in step by
 * lib/__tests__/verifyFirebaseToken.test.ts, which asserts the same rejection
 * cases as the services suite.
 *
 * Only the status route needs this — it hands out presigned URLs to a user's
 * private artifact, so it must establish identity itself rather than trusting a
 * uid from the query string. The enqueue route forwards its token to the Lambda
 * instead, which does its own verification.
 */

/**
 * Google's public keys for Firebase ID tokens, in JWK form.
 *
 * The path is `/metadata/jwk/`. An earlier version used `/jwks/`, which does not
 * exist and returns 404 — every verification failed and the status poll returned
 * 401 to a signed-in user. Unit tests stub the fetch, so only a live request
 * catches this; see the reachability test in the suite for this file.
 *
 * Must stay identical to JWKS_URL in services/tailor/auth.ts.
 */
const JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/metadata/jwk/securetoken@system.gserviceaccount.com';

interface Jwk {
  kid: string;
  n: string;
  e: string;
  kty: string;
}

let cache: { keys: Map<string, Jwk>; expiresAt: number } | null = null;

export function clearJwksCache(): void {
  cache = null;
}

async function getKeys(now: number): Promise<Map<string, Jwk>> {
  if (cache && now < cache.expiresAt) return cache.keys;

  const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);

  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map((body.keys ?? []).map((k) => [k.kid, k]));
  if (keys.size === 0) throw new Error('JWKS response contained no keys');

  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1]);
  const ttlMs = Number.isFinite(maxAge) && maxAge > 0 ? maxAge * 1000 : 3_600_000;

  cache = { keys, expiresAt: now + ttlMs };
  return keys;
}

const b64urlToBuffer = (input: string) =>
  Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function decodeSegment<T>(segment: string): T {
  return JSON.parse(b64urlToBuffer(segment).toString('utf8')) as T;
}

export interface VerifiedUser {
  uid: string;
  email?: string;
}

export async function verifyIdToken(
  token: string,
  now: number = Date.now(),
): Promise<VerifiedUser> {
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('NEXT_PUBLIC_FIREBASE_PROJECT_ID is not configured');

  const parts = token?.split('.') ?? [];
  if (parts.length !== 3) throw new Error('Token is not a well-formed JWT');
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = decodeSegment<{ alg: string; kid?: string }>(headerB64);
  // Pin the algorithm: accepting the token's own claim allows "alg: none" and
  // HMAC confusion attacks.
  if (header.alg !== 'RS256') throw new Error(`Unexpected algorithm: ${header.alg}`);
  if (!header.kid) throw new Error('Token header has no kid');

  const jwk = (await getKeys(now)).get(header.kid);
  if (!jwk) throw new Error(`No signing key for kid ${header.kid}`);

  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  const publicKey = createPublicKey({
    key: jwk as unknown as import('crypto').JsonWebKey,
    format: 'jwk',
  });
  if (!verifier.verify(publicKey, b64urlToBuffer(signatureB64))) {
    throw new Error('Signature verification failed');
  }

  const payload = decodeSegment<{
    iss?: string;
    aud?: string;
    sub?: string;
    exp?: number;
    email?: string;
  }>(payloadB64);

  // A valid signature from ANOTHER Firebase project would pass the crypto
  // check; issuer and audience bind the token to this app.
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error(`Unexpected issuer: ${payload.iss}`);
  }
  if (payload.aud !== projectId) throw new Error(`Unexpected audience: ${payload.aud}`);
  if (!payload.sub) throw new Error('Token has no subject');
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) {
    throw new Error('Token is expired');
  }

  return { uid: payload.sub, email: payload.email };
}
