import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { AWS_REGION, resolveCredentials } from './ddbClient';

/**
 * SigV4-signed fetch for the tailor function URL.
 *
 * The function URL is `authType: AWS_IAM`, so unsigned requests are rejected by
 * Lambda before any handler code runs. Vercel assumes its OIDC role and signs
 * with the resulting temporary credentials — there is no access key involved.
 *
 * The browser never calls the function URL directly; it goes through the Next
 * route handlers, which hold the credentials.
 */

// On Vercel this is the OIDC exchange; locally it falls back to the shared
// profile. The default chain alone cannot see Vercel's token.
const credentials = resolveCredentials() ?? fromNodeProviderChain();

export async function signedFetch(
  url: string,
  init: { method: string; body?: string; headers?: Record<string, string> },
): Promise<Response> {
  const target = new URL(url);

  // SigV4 writes its signature into `authorization`. A caller-supplied value
  // there is not merged or appended — it is silently destroyed, and the request
  // still succeeds, so the loss shows up as a confusing 401 from the far end
  // rather than an error here. This cost a real debugging session: the Firebase
  // token was passed in `authorization` and never reached the Lambda.
  for (const key of Object.keys(init.headers ?? {})) {
    if (key.toLowerCase() === 'authorization') {
      throw new Error(
        'signedFetch: refusing to sign a request with a caller-supplied `authorization` ' +
          'header — SigV4 overwrites it. Use a distinct header (e.g. x-firebase-token); ' +
          'it is still covered by the signature.',
      );
    }
  }

  const signer = new SignatureV4({
    service: 'lambda',
    region: AWS_REGION,
    credentials,
    sha256: Sha256,
  });

  const signed = await signer.sign({
    method: init.method,
    protocol: target.protocol,
    hostname: target.hostname,
    path: target.pathname + target.search,
    // Host must be present and exact: SigV4 signs it, and a mismatch fails
    // with a signature error that says nothing about the real cause.
    headers: {
      host: target.hostname,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
    body: init.body,
  });

  return fetch(url, {
    method: signed.method,
    headers: signed.headers as Record<string, string>,
    body: init.body,
  });
}
