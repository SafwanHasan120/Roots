import type { User } from 'firebase/auth';

/**
 * Client for the async tailor flow.
 *
 * Enqueue returns a job id immediately; the result arrives via polling. The old
 * flow held a single HTTP request open for the whole pipeline, which meant an
 * 8192-token completion had to finish inside the platform's request timeout.
 */

export interface TailorJobResult {
  latex: string;
  coverageBefore?: number;
  coverageAfter?: number;
  degraded?: boolean;
  /** Compiled PDF page count. Absent when the compile could not be measured. */
  pageCount?: number;
  /**
   * 'fits' and 'over' come from a compiled page count.
   * 'unknown' means the compile failed — it does NOT mean the resume fits.
   */
  fitStatus?: 'fits' | 'over' | 'unknown';
}

export class TailorError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TailorError';
  }
}

/**
 * The job description could not be read from the listing page.
 *
 * Thrown instead of TailorError so the UI can offer a paste box rather than a
 * retry button. Common on client-rendered job boards (Workday and similar),
 * where the description simply is not in the HTML.
 *
 * No quota was consumed, so resubmitting with `manualJd` costs the user nothing
 * extra.
 */
export class NeedsJobDescriptionError extends Error {
  readonly code = 'jd_required';

  constructor(message: string) {
    super(message);
    this.name = 'NeedsJobDescriptionError';
  }
}

/** Statuses a job passes through before it settles. Fired only when the phase changes. */
export type TailorLiveStatus = 'queued' | 'running';

/** Poll cadence: fast enough to feel responsive, slow enough not to hammer the route. */
const POLL_INTERVAL_MS = 2000;
/** Ceiling. The worker timeout is 600s; this leaves room for queue wait. */
const POLL_TIMEOUT_MS = 12 * 60 * 1000;

function friendlyMessage(code: string, fallback?: string): string {
  switch (code) {
    case 'rate_limited':
      return 'Daily limit reached (5/5). Resets at midnight UTC.';
    case 'jd_extraction_failed':
      return "Couldn't read that job page. Try a different link.";
    case 'unsafe_url':
      return 'That listing URL failed a safety check.';
    case 'not_found':
      return 'That listing could not be found.';
    case 'unauthorized':
      return 'Please sign in again.';
    case 'validation_failed':
      return fallback ?? 'The tailored resume failed validation. Please try again.';
    default:
      return fallback ?? 'Something went wrong. Please try again.';
  }
}

/**
 * Tailor a resume: enqueue, then poll until the job settles.
 *
 * Sends the user's Firebase ID token rather than a uid. The previous flow put
 * `uid` in the request body, so any caller could spend another user's quota.
 */
export async function tailorResume(
  user: User,
  internshipId: string,
  latex: string,
  signal?: AbortSignal,
  /**
   * Job description pasted by the user. Supplied only on a resubmission after
   * a NeedsJobDescriptionError; when present the worker skips extraction.
   */
  manualJd?: string,
  /** Called as the job moves through the queue and into the worker. */
  onStatus?: (status: TailorLiveStatus) => void,
): Promise<TailorJobResult> {
  const token = await user.getIdToken();

  const enqueueRes = await fetch('/api/tailor', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ internshipId, latex, manualJd }),
    signal,
  });

  const enqueued = (await enqueueRes.json()) as {
    jobId?: string;
    error?: string;
    message?: string;
  };

  if (!enqueueRes.ok || !enqueued.jobId) {
    throw new TailorError(
      enqueued.error ?? 'unknown',
      friendlyMessage(enqueued.error ?? 'unknown', enqueued.message),
    );
  }

  onStatus?.('queued');
  return pollJob(user, enqueued.jobId, signal, onStatus, 'queued');
}

async function pollJob(
  user: User,
  jobId: string,
  signal?: AbortSignal,
  onStatus?: (status: TailorLiveStatus) => void,
  reported: TailorLiveStatus | null = null,
): Promise<TailorJobResult> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let seen = reported;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new TailorError('aborted', 'Cancelled.');

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    // Refreshed each poll: a token can expire during a long job, and the
    // status route verifies it on every call.
    const token = await user.getIdToken();
    const res = await fetch(`/api/tailor/status?jobId=${encodeURIComponent(jobId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });

    const data = (await res.json()) as {
      status?: string;
      downloadUrl?: string;
      error?: string;
      message?: string;
      coverageBefore?: number;
      coverageAfter?: number;
      degraded?: boolean;
      pageCount?: number;
      fitStatus?: 'fits' | 'over' | 'unknown';
    };

    if (!res.ok) {
      throw new TailorError(data.error ?? 'unknown', friendlyMessage(data.error ?? 'unknown', data.message));
    }

    // Recoverable, and distinct from failure: the user pastes the description
    // and resubmits. No quota was spent.
    if (data.status === 'QUEUED' || data.status === 'RUNNING') {
      const next: TailorLiveStatus = data.status === 'QUEUED' ? 'queued' : 'running';
      if (next !== seen) {
        seen = next;
        onStatus?.(next);
      }
    }

    if (data.status === 'NEEDS_JD') {
      throw new NeedsJobDescriptionError(
        data.message ??
          "We couldn't read the job description from that page. Paste it below and we'll tailor your resume.",
      );
    }

    if (data.status === 'FAILED') {
      throw new TailorError(data.error ?? 'tailor_failed', friendlyMessage(data.error ?? '', data.message));
    }

    if (data.status === 'DONE') {
      if (!data.downloadUrl) {
        throw new TailorError('no_artifact', 'The tailored resume could not be retrieved.');
      }

      // The artifact is fetched straight from S3 via a short-lived presigned
      // URL, so the .tex never passes through the Vercel function.
      const artifact = await fetch(data.downloadUrl, { signal });
      if (!artifact.ok) {
        throw new TailorError('no_artifact', 'The tailored resume could not be downloaded.');
      }

      return {
        latex: await artifact.text(),
        coverageBefore: data.coverageBefore,
        coverageAfter: data.coverageAfter,
        degraded: data.degraded,
        pageCount: data.pageCount,
        fitStatus: data.fitStatus,
      };
    }
  }

  throw new TailorError('timeout', 'Tailoring is taking longer than expected. Try again shortly.');
}
