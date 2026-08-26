/**
 * Firebase ID token verification.
 *
 * The app authenticates with Firebase Auth, so this verifies Firebase tokens
 * rather than introducing Cognito — that would mean migrating every user and
 * every `users/{uid}` document for no security gain.
 *
 * This sits BEHIND the function URL's IAM auth. IAM proves the caller is our
 * Vercel deployment; this proves which user is asking. Both are required: IAM
 * alone would let any authenticated visitor spend another user's quota, since
 * the uid would otherwise come from the request body.
 *
 * Implemented against Google's JWKS directly rather than firebase-admin: the
 * Lambda needs one RS256 signature check, not a 60MB SDK and a service account.
 */

import { createPublicKey, createVerify } from 'node:crypto';

/**
 * Google's public keys for Firebase ID tokens, in JWK form.
 *
 * The path is `/metadata/jwk/`. An earlier version used `/jwks/`, which does not
 * exist and returns 404 — so every verification failed with "Authentication
 * unavailable" and the user was told to sign in again. Nothing in the unit
 * tests caught it, because they stub the fetch.
 *
 * Do not "simplify" this to `/jwks/`. The sibling endpoint
 * `/robot/v1/metadata/x509/...` also works but returns PEM certificates, which
 * would need parsing; this one returns JWKs that createPublicKey takes directly.
 */
const JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/metadata/jwk/securetoken@system.gserviceaccount.com';

export class AuthError extends Error {
  constructor(
    message: string,
    /** Safe to return to the client; never leaks token internals. */
    readonly clientMessage = 'Unauthorized',
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

interface Jwk {
  kid: string;
  n: string;
  e: string;
  kty: string;
  alg?: string;
}

interface JwksCache {
  keys: Map<string, Jwk>;
  expiresAt: number;
}

let cache: JwksCache | null = null;

/** Test seam. */
export function clearJwksCache(): void {
  cache = null;
}

async function getKeys(now: number): Promise<Map<string, Jwk>> {
  if (cache && now < cache.expiresAt) return cache.keys;

  const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    throw new AuthError(`JWKS fetch failed: ${res.status}`, 'Authentication unavailable');
  }

  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map((body.keys ?? []).map((k) => [k.kid, k]));
  if (keys.size === 0) {
    throw new AuthError('JWKS response contained no keys', 'Authentication unavailable');
  }

  // Honour Cache-Control rather than picking an arbitrary TTL: Google rotates
  // these keys, and caching past their lifetime rejects valid tokens.
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1]);
  const ttlMs = Number.isFinite(maxAge) && maxAge > 0 ? maxAge * 1000 : 60 * 60 * 1000;

  cache = { keys, expiresAt: now + ttlMs };
  return keys;
}

function b64urlToBuffer(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodeSegment<T>(segment: string): T {
  try {
    return JSON.parse(b64urlToBuffer(segment).toString('utf8')) as T;
  } catch {
    throw new AuthError('Malformed token segment');
  }
}

interface TokenHeader {
  alg: string;
  kid?: string;
}

interface TokenPayload {
  iss?: string;
  aud?: string;
  sub?: string;
  exp?: number;
  iat?: number;
  auth_time?: number;
  email?: string;
}

export interface VerifiedUser {
  uid: string;
  email?: string;
}

/**
 * Verify a Firebase ID token and return the authenticated user.
 *
 * Checks, in order: structure, algorithm, signing key, signature, issuer,
 * audience, subject, and expiry. Every failure throws AuthError with a generic
 * client message — a caller must not learn *why* a token was rejected.
 */
export async function verifyFirebaseToken(
  token: string,
  projectId: string,
  now: number = Date.now(),
): Promise<VerifiedUser> {
  if (!projectId) {
    throw new AuthError('FIREBASE_PROJECT_ID is not configured', 'Authentication unavailable');
  }
  if (!token?.trim()) {
    throw new AuthError('Missing token');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new AuthError('Token is not a well-formed JWT');
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = decodeSegment<TokenHeader>(headerB64);
  // Pin the algorithm. Accepting whatever the token declares is the classic
  // JWT flaw: "alg": "none" or an HMAC alg would let a caller forge tokens.
  if (header.alg !== 'RS256') {
    throw new AuthError(`Unexpected algorithm: ${header.alg}`);
  }
  if (!header.kid) {
    throw new AuthError('Token header has no kid');
  }

  const keys = await getKeys(now);
  const jwk = keys.get(header.kid);
  if (!jwk) {
    // Either a forged kid or a key rotated since we cached. Not retried here —
    // an attacker could otherwise force a JWKS fetch per request.
    throw new AuthError(`No signing key for kid ${header.kid}`);
  }

  const publicKey = createPublicKey({
    key: jwk as unknown as import('node:crypto').JsonWebKey,
    format: 'jwk',
  });
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  if (!verifier.verify(publicKey, b64urlToBuffer(signatureB64))) {
    throw new AuthError('Signature verification failed');
  }

  const payload = decodeSegment<TokenPayload>(payloadB64);

  // Signature alone is not enough: a valid token from ANOTHER Firebase project
  // would pass the crypto check. Issuer and audience bind it to ours.
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new AuthError(`Unexpected issuer: ${payload.iss}`);
  }
  if (payload.aud !== projectId) {
    throw new AuthError(`Unexpected audience: ${payload.aud}`);
  }
  if (!payload.sub) {
    throw new AuthError('Token has no subject');
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) {
    throw new AuthError('Token is expired');
  }
  // Guard against a token minted "in the future" by a skewed or forged clock.
  if (typeof payload.iat === 'number' && payload.iat * 1000 > now + 5 * 60 * 1000) {
    throw new AuthError('Token issued in the future');
  }

  return { uid: payload.sub, email: payload.email };
}

/**
 * Header carrying the Firebase ID token.
 *
 * NOT `authorization`. The function URL is authType AWS_IAM, so the Vercel route
 * signs every request with SigV4 — and SigV4 *writes its signature into*
 * `authorization`, silently destroying anything already there. Sending the
 * Firebase token in that header meant the Lambda only ever saw
 * `AWS4-HMAC-SHA256 Credential=...`, failed the `Bearer` match, and returned 401
 * to a correctly signed-in user.
 *
 * A custom header sidesteps the collision. SigV4 still signs it (it is included
 * in the canonical request), so it cannot be tampered with in transit.
 */
export const ID_TOKEN_HEADER = 'x-firebase-token';

/**
 * Pull the Firebase ID token out of Lambda function URL headers.
 *
 * Case-insensitive: API Gateway and function URLs lowercase header names, but
 * tests and direct invocations may not.
 *
 * Accepts a bare token or a `Bearer <token>` form. The `authorization` fallback
 * exists only for a caller that predates ID_TOKEN_HEADER; it cannot work through
 * SigV4 and should not be relied on.
 */
export function bearerFrom(headers: Record<string, string | undefined>): string | null {
  const pick = (name: string): string | undefined => {
    const target = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === target && v) return v;
    }
    return undefined;
  };

  // The dedicated header is ours, so a bare token is acceptable there. The
  // `authorization` fallback stays strict `Bearer <token>` — loosening it would
  // make `Basic <creds>` or a SigV4 signature parse as a user token.
  const dedicated = pick(ID_TOKEN_HEADER);
  if (dedicated) {
    const trimmed = dedicated.trim();
    const match = /^Bearer\s+(.+)$/i.exec(trimmed);
    if (match) return match[1].trim();
    // Never mistake a signature for a credential.
    if (/^AWS4-HMAC-SHA256/i.test(trimmed)) return null;
    return trimmed || null;
  }

  const raw = pick('authorization');
  if (!raw) return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1].trim() : null;
}
