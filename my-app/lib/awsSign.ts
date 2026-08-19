import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { AWS_REGION } from './ddbClient';

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

const credentials = fromNodeProviderChain();

export async function signedFetch(
  url: string,
  init: { method: string; body?: string; headers?: Record<string, string> },
): Promise<Response> {
  const target = new URL(url);

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
