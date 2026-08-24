import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, createSign, createPublicKey } from 'node:crypto';
import {
  verifyFirebaseToken,
  bearerFrom,
  clearJwksCache,
  AuthError,
  ID_TOKEN_HEADER,
} from '../auth.js';

const PROJECT = 'intern-tool-4224a';
const KID = 'test-key-1';

// A throwaway RSA pair standing in for Google's signing keys, so these tests
// exercise real signature verification rather than a mocked crypto layer.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const jwk = {
  ...createPublicKey(publicKey).export({ format: 'jwk' }),
  kid: KID,
  alg: 'RS256',
};

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);

function makeToken(
  payloadOverrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
  sign = true,
): string {
  const header = { alg: 'RS256', kid: KID, typ: 'JWT', ...headerOverrides };
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    sub: 'user-abc',
    iat: Math.floor(NOW / 1000) - 60,
    exp: Math.floor(NOW / 1000) + 3600,
    email: 'user@example.com',
    ...payloadOverrides,
  };

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  if (!sign) return `${signingInput}.${b64url('not-a-signature')}`;

  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  return `${signingInput}.${b64url(signer.sign(privateKey))}`;
}

describe('verifyFirebaseToken', () => {
  beforeEach(() => {
    clearJwksCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({ 'cache-control': 'public, max-age=3600' }),
        json: async () => ({ keys: [jwk] }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts a valid token and returns the uid', async () => {
    const user = await verifyFirebaseToken(makeToken(), PROJECT, NOW);
    expect(user).toEqual({ uid: 'user-abc', email: 'user@example.com' });
  });

  describe('rejects', () => {
    it('a token signed by the wrong key', async () => {
      const other = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const header = b64url(JSON.stringify({ alg: 'RS256', kid: KID }));
      const payload = b64url(
        JSON.stringify({
          iss: `https://securetoken.google.com/${PROJECT}`,
          aud: PROJECT,
          sub: 'attacker',
          exp: Math.floor(NOW / 1000) + 3600,
        }),
      );
      const signer = createSign('RSA-SHA256');
      signer.update(`${header}.${payload}`);
      const forged = `${header}.${payload}.${b64url(signer.sign(other.privateKey))}`;

      await expect(verifyFirebaseToken(forged, PROJECT, NOW)).rejects.toThrow(AuthError);
    });

    it('a token with a tampered payload', async () => {
      const valid = makeToken();
      const [h, , s] = valid.split('.');
      const tampered = b64url(
        JSON.stringify({
          iss: `https://securetoken.google.com/${PROJECT}`,
          aud: PROJECT,
          sub: 'someone-else',
          exp: Math.floor(NOW / 1000) + 3600,
        }),
      );

      await expect(verifyFirebaseToken(`${h}.${tampered}.${s}`, PROJECT, NOW)).rejects.toThrow(
        /Signature verification failed/,
      );
    });

    it('alg: none — the classic JWT bypass', async () => {
      // Accepting the token's own algorithm claim would let anyone forge one.
      const token = makeToken({}, { alg: 'none' }, false);
      await expect(verifyFirebaseToken(token, PROJECT, NOW)).rejects.toThrow(
        /Unexpected algorithm/,
      );
    });

    it('an HMAC algorithm, which would treat the public key as a shared secret', async () => {
      const token = makeToken({}, { alg: 'HS256' }, false);
      await expect(verifyFirebaseToken(token, PROJECT, NOW)).rejects.toThrow(
        /Unexpected algorithm/,
      );
    });

    it('an expired token', async () => {
      const token = makeToken({ exp: Math.floor(NOW / 1000) - 1 });
      await expect(verifyFirebaseToken(token, PROJECT, NOW)).rejects.toThrow(/expired/);
    });

    it('a token from another Firebase project', async () => {
      // Correctly signed by Google, but issued for a different app.
      const token = makeToken({
        iss: 'https://securetoken.google.com/someone-elses-project',
        aud: 'someone-elses-project',
      });
      await expect(verifyFirebaseToken(token, PROJECT, NOW)).rejects.toThrow(/issuer/);
    });

    it('a token whose audience is not this project', async () => {
      const token = makeToken({ aud: 'other-project' });
      await expect(verifyFirebaseToken(token, PROJECT, NOW)).rejects.toThrow(/audience/);
    });

    it('a token with an unknown kid', async () => {
      const token = makeToken({}, { kid: 'rotated-away' });
      await expect(verifyFirebaseToken(token, PROJECT, NOW)).rejects.toThrow(/No signing key/);
    });

    it('a token with no subject', async () => {
      const token = makeToken({ sub: undefined });
      await expect(verifyFirebaseToken(token, PROJECT, NOW)).rejects.toThrow(/subject/);
    });

    it('a token issued far in the future', async () => {
      const token = makeToken({ iat: Math.floor(NOW / 1000) + 3600 });
      await expect(verifyFirebaseToken(token, PROJECT, NOW)).rejects.toThrow(/future/);
    });

    it('a malformed token', async () => {
      await expect(verifyFirebaseToken('not.a.jwt', PROJECT, NOW)).rejects.toThrow(AuthError);
      await expect(verifyFirebaseToken('only-one-part', PROJECT, NOW)).rejects.toThrow(AuthError);
      await expect(verifyFirebaseToken('', PROJECT, NOW)).rejects.toThrow(AuthError);
    });

    it('any token when the project id is unconfigured', async () => {
      // Fail closed: an empty projectId must not make every token valid.
      await expect(verifyFirebaseToken(makeToken(), '', NOW)).rejects.toThrow(
        /not configured/,
      );
    });
  });

  describe('error messages', () => {
    it('never leaks the reason to the client', async () => {
      try {
        await verifyFirebaseToken(makeToken({ aud: 'other' }), PROJECT, NOW);
        expect.unreachable();
      } catch (err) {
        expect((err as AuthError).message).toMatch(/audience/); // for logs
        expect((err as AuthError).clientMessage).toBe('Unauthorized'); // for the caller
      }
    });
  });

  describe('JWKS caching', () => {
    it('fetches once across many verifications', async () => {
      await verifyFirebaseToken(makeToken(), PROJECT, NOW);
      await verifyFirebaseToken(makeToken(), PROJECT, NOW);
      await verifyFirebaseToken(makeToken(), PROJECT, NOW);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    it('refetches once the cache-control max-age lapses', async () => {
      // Google rotates these keys; caching past their lifetime rejects valid
      // tokens.
      await verifyFirebaseToken(makeToken(), PROJECT, NOW);
      const later = NOW + 3601 * 1000;
      await verifyFirebaseToken(
        makeToken({ exp: Math.floor(later / 1000) + 3600 }),
        PROJECT,
        later,
      );
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    });

    it('surfaces a JWKS outage as an auth failure, not a crash', async () => {
      clearJwksCache();
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })));
      await expect(verifyFirebaseToken(makeToken(), PROJECT, NOW)).rejects.toThrow(AuthError);
    });
  });
});

describe('bearerFrom', () => {
  it('extracts a token regardless of header casing', () => {
    expect(bearerFrom({ authorization: 'Bearer abc' })).toBe('abc');
    expect(bearerFrom({ Authorization: 'Bearer abc' })).toBe('abc');
    expect(bearerFrom({ authorization: 'bearer abc' })).toBe('abc');
  });

  it('returns null when absent or malformed', () => {
    expect(bearerFrom({})).toBeNull();
    expect(bearerFrom({ authorization: 'Basic abc' })).toBeNull();
    expect(bearerFrom({ authorization: 'Bearer' })).toBeNull();
  });

  describe('SigV4 coexistence', () => {
    // The bug: the function URL is authType AWS_IAM, so the Vercel route signs
    // every request with SigV4 — and SigV4 writes its signature INTO
    // `authorization`, destroying whatever was there. Sending the Firebase token
    // in that header meant the Lambda only saw the signature and 401'd a
    // correctly signed-in user on every tailor attempt.
    const SIGV4 =
      'AWS4-HMAC-SHA256 Credential=AKIA/20260824/us-west-2/lambda/aws4_request, ' +
      'SignedHeaders=host;x-amz-date, Signature=deadbeef';

    it('reads the token from the dedicated header while SigV4 owns authorization', () => {
      expect(bearerFrom({ authorization: SIGV4, [ID_TOKEN_HEADER]: 'Bearer fb-token' })).toBe(
        'fb-token',
      );
    });

    it('accepts a bare token in the dedicated header', () => {
      expect(bearerFrom({ [ID_TOKEN_HEADER]: 'fb-token' })).toBe('fb-token');
    });

    it('never mistakes a SigV4 signature for a user token', () => {
      expect(bearerFrom({ authorization: SIGV4 })).toBeNull();
      expect(bearerFrom({ [ID_TOKEN_HEADER]: SIGV4 })).toBeNull();
    });

    it('matches the dedicated header case-insensitively', () => {
      // Function URLs lowercase header names; direct invocations may not.
      expect(bearerFrom({ 'X-Firebase-Token': 'Bearer fb' })).toBe('fb');
    });

    it('prefers the dedicated header over a stale authorization bearer', () => {
      expect(
        bearerFrom({ authorization: 'Bearer old', [ID_TOKEN_HEADER]: 'Bearer new' }),
      ).toBe('new');
    });
  });
});
