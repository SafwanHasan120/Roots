/**
 * Tailor worker. One SQS message = one job.
 *
 * Runs the pipeline the synchronous route used to run inline: resolve listing,
 * SSRF-guard the URL, extract and analyze the JD, call Claude, validate the
 * output, write the artifact to S3.
 *
 * Quota settlement is the part that matters:
 *   success  -> consume (reserved becomes consumed)
 *   failure  -> release (reserved returned, consumed untouched)
 *
 * A failure must never charge the user for work they did not receive. Both
 * paths run before the handler returns, so a message that dead-letters after
 * three deliveries has already released its reservation on each attempt.
 */

import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getListingById } from './listings.js';
import { assertSafeUrl } from '@app/urlGuard';
import { extractJD } from '@app/jdExtractor';
import { analyzeJD } from '@app/jdAnalyzer';
import { computeKeywordGap } from '@app/keywordGap';
import { validateTailoredLatex } from '@app/latexValidator';
import { estimateFit } from '@app/latexFit';
import { tailorLatexWithAnalysis, tailorLatexDegraded, getAnthropicKey } from './tailorLatex.js';
import { consume, release } from './rateLimit.js';
import { markRunning, markDone, markFailed, markNeedsJd, getJob } from './jobs.js';

const s3 = new S3Client({ maxAttempts: 3 });

interface TailorMessage {
  jobId: string;
  uid: string;
  internshipId: string;
  latex: string;
  /**
   * Job description pasted by the user.
   *
   * Set only on a resubmission after automatic extraction failed — some job
   * boards (Workday especially) render their description client-side, so there
   * is nothing in the HTML to scrape. When present it is used verbatim and no
   * fetch is attempted.
   */
  manualJd?: string;
}

/** Failure with a message safe to show the user. */
class JobError extends Error {
  constructor(
    readonly code: string,
    readonly clientMessage: string,
    detail?: string,
  ) {
    super(detail ?? clientMessage);
    this.name = 'JobError';
  }
}

/**
 * The job description could not be read automatically.
 *
 * Not an error in the usual sense: the user can paste the description and
 * resubmit. Settled as NEEDS_JD rather than FAILED so the client can tell the
 * two apart, and the quota reservation is released — nothing was delivered.
 */
class NeedsJdError extends Error {
  readonly code = 'jd_required';
  readonly clientMessage =
    "We couldn't read the job description from that page. Paste it below and we'll tailor your resume.";

  constructor() {
    super('JD extraction produced no usable text');
    this.name = 'NeedsJdError';
  }
}

export async function handler(event: SQSEvent): Promise<void> {
  // jdAnalyzer.ts is shared with the Next app and reads
  // process.env.ANTHROPIC_API_KEY directly. In Lambda the key lives in SSM, so
  // populate the variable before anything calls it.
  //
  // Without this, analyzeJD fails with HTTP 401 and the worker silently falls
  // back to degraded mode: jobs still succeed, but with materially worse output
  // and no error surfaced to the user. A quiet quality regression is worse than
  // a loud failure.
  await ensureAnthropicKeyInEnv();

  // batchSize is 1; written as a loop so raising it later cannot silently drop
  // records.
  for (const record of event.Records) {
    await processRecord(record);
  }
}

async function processRecord(record: SQSRecord): Promise<void> {
  const msg = JSON.parse(record.body) as TailorMessage;
  const { jobId, uid, internshipId, latex, manualJd } = msg;

  // A redelivered message whose first attempt already finished must not re-run
  // the pipeline — that would double-charge Claude and re-settle the quota.
  const existing = await getJob(jobId);
  if (
    existing &&
    (existing.status === 'DONE' ||
      existing.status === 'FAILED' ||
      // NEEDS_JD is settled too: the reservation is already released and the
      // user has been asked to paste. Re-running would extract-and-fail again.
      existing.status === 'NEEDS_JD')
  ) {
    console.log(JSON.stringify({ msg: 'job already settled, skipping', jobId, status: existing.status }));
    return;
  }

  try {
    await markRunning(jobId);
  } catch (err) {
    // Lost the race with a concurrent delivery; that invocation owns the job.
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      console.log(JSON.stringify({ msg: 'job not in QUEUED state, skipping', jobId }));
      return;
    }
    throw err;
  }

  try {
    const result = await runPipeline({ internshipId, latex, manualJd });

    const artifactKey = `jobs/${uid}/${jobId}.tex`;
    await s3.send(
      new PutObjectCommand({
        Bucket: requireEnv('ARTIFACT_BUCKET'),
        Key: artifactKey,
        Body: result.latex,
        ContentType: 'application/x-tex',
      }),
    );

    await markDone(jobId, {
      artifactKey,
      coverageBefore: result.coverageBefore,
      coverageAfter: result.coverageAfter,
      degraded: result.degraded,
      fitPt: result.fitPt,
      fitBudgetPt: result.fitBudgetPt,
      fitStatus: result.fitStatus,
    });

    // Charge only now: the artifact exists and passed validation.
    await consume(uid);

    console.log(
      JSON.stringify({ msg: 'job done', jobId, uid, degraded: result.degraded }),
    );
  } catch (err) {
    // A missing job description is recoverable: the user pastes it and
    // resubmits. Kept out of the FAILED bucket so the client can distinguish
    // "try again" from "here is what to do next", and so alarms on failure
    // rates are not polluted by an expected outcome on client-rendered pages.
    if (err instanceof NeedsJdError) {
      console.log(JSON.stringify({ msg: 'job needs manual JD', jobId, uid }));

      await markNeedsJd(jobId, err.code, err.clientMessage).catch((e) =>
        console.error(JSON.stringify({ msg: 'failed to mark needs-jd', jobId, error: String(e) })),
      );
      await release(uid).catch((e) =>
        console.error(JSON.stringify({ msg: 'failed to release reservation', uid, error: String(e) })),
      );
      return;
    }

    const code = err instanceof JobError ? err.code : 'internal_error';
    const clientMessage =
      err instanceof JobError
        ? err.clientMessage
        : 'An unexpected error occurred. Please try again.';

    console.error(
      JSON.stringify({ msg: 'job failed', jobId, uid, code, error: String(err) }),
    );

    await markFailed(jobId, code, clientMessage).catch((e) =>
      console.error(JSON.stringify({ msg: 'failed to mark job failed', jobId, error: String(e) })),
    );

    // The user keeps their quota: they never received a resume.
    await release(uid).catch((e) =>
      console.error(JSON.stringify({ msg: 'failed to release reservation', uid, error: String(e) })),
    );

    // Deliberately NOT rethrown. The job record already carries the failure and
    // the quota is settled; letting SQS redeliver would repeat an error that is
    // not transient — a bad JD page fails identically three times, then
    // dead-letters and pages someone for nothing.
  }
}

interface PipelineResult {
  latex: string;
  coverageBefore?: number;
  coverageAfter?: number;
  degraded: boolean;
  /** Estimated height of the delivered resume, when the template was recognised. */
  fitPt?: number;
  fitBudgetPt?: number;
  /** 'unknown' means the template was not recognised, not that it fits. */
  fitStatus?: 'fits' | 'over' | 'unknown';
}

async function runPipeline(input: {
  internshipId: string;
  latex: string;
  manualJd?: string;
}): Promise<PipelineResult> {
  const { internshipId, latex, manualJd } = input;

  // Resolve server-side: the appUrl comes from the stored record, never from
  // the request, so a caller cannot point the fetcher at a URL of its choosing.
  const internship = await getListingById(internshipId);
  if (!internship) {
    throw new JobError('not_found', 'Internship listing not found');
  }

  const appUrl = internship.appUrl;

  try {
    await assertSafeUrl(appUrl);
  } catch (err) {
    throw new JobError(
      'unsafe_url',
      'The internship URL failed security validation.',
      String(err),
    );
  }

  let jdText: string;
  let jdConfidence: 'high' | 'low';

  if (manualJd?.trim()) {
    // Pasted by the user after automatic extraction failed. Treated as
    // high-confidence: a human copied it off the page, which beats anything the
    // scraper infers from markup.
    jdText = manualJd.trim();
    jdConfidence = 'high';
  } else {
    let extracted: { text?: string; confidence: 'high' | 'low' } | null = null;
    try {
      extracted = await extractJD(appUrl);
    } catch (err) {
      console.warn(
        JSON.stringify({ msg: 'JD extraction threw', appUrl, error: String(err) }),
      );
    }

    if (!extracted?.text) {
      // Not a failure the user can do nothing about — ask them to paste it.
      // Distinct from tailor_failed so the client can show an input rather than
      // a dead end, and NEEDS_JD is settled without consuming quota.
      throw new NeedsJdError();
    }

    jdText = extracted.text;
    jdConfidence = extracted.confidence;
  }

  let tailoredLatex: string | undefined;
  let coverageBefore = 0;
  let coverageAfter = 0;
  let degraded = false;

  // Measured before the model runs so the budget can go into the prompt.
  // Preventing overflow costs ~60 tokens; correcting it afterwards costs a
  // second Claude call, so the pre-flight constraint is the whole strategy.
  const inputFit = estimateFit(latex);

  if (jdConfidence === 'high') {
    let analysis;
    try {
      analysis = await analyzeJD(jdText, appUrl);
    } catch (err) {
      console.error(JSON.stringify({ msg: 'JD analysis failed, degrading', error: String(err) }));
      degraded = true;
    }

    if (analysis) {
      const beforeGap = computeKeywordGap(latex, analysis.keywords);
      coverageBefore = beforeGap.coveragePct;

      try {
        tailoredLatex = await tailorLatexWithAnalysis(
          latex,
          jdText,
          analysis,
          beforeGap.missing,
          inputFit,
        );
      } catch (err) {
        throw new JobError(
          'tailor_failed',
          'Resume tailoring service is unavailable. Please try again.',
          String(err),
        );
      }

      coverageAfter = computeKeywordGap(tailoredLatex, analysis.keywords).coveragePct;
    }
  }

  if (degraded || jdConfidence === 'low' || !tailoredLatex) {
    try {
      tailoredLatex = await tailorLatexDegraded(
        internship.company,
        internship.role,
        latex,
        inputFit,
      );
      degraded = true;
    } catch (err) {
      throw new JobError(
        'tailor_failed',
        'Resume tailoring service is unavailable. Please try again.',
        String(err),
      );
    }
  }

  if (!tailoredLatex?.trim()) {
    throw new JobError(
      'tailor_failed',
      'Resume tailoring service is unavailable. Please try again.',
    );
  }

  // The guard against fabricated experience and altered numbers. Frozen module,
  // imported unchanged.
  const validation = validateTailoredLatex(latex, tailoredLatex);
  if (!validation.ok) {
    throw new JobError(
      'validation_failed',
      'The tailored resume failed validation. Please try again.',
      validation.errors?.join('; '),
    );
  }

  // Advisory only: a resume that runs slightly long is still a useful artifact,
  // and failing the job would deliver nothing while charging another Claude call
  // on the retry. The estimate is also a heuristic with a known blind spot for
  // unrecognised templates, which is the wrong thing to hard-gate on.
  const outputFit = estimateFit(tailoredLatex);
  if (outputFit.confidence === 'high' && !outputFit.fits) {
    console.warn(
      JSON.stringify({
        msg: 'tailored resume exceeds one page',
        totalPt: outputFit.totalPt,
        budgetPt: outputFit.budgetPt,
        linesOver: outputFit.linesOver,
        inputPt: inputFit.confidence === 'high' ? inputFit.totalPt : null,
      }),
    );
  } else if (outputFit.confidence === 'low') {
    console.info(
      JSON.stringify({ msg: 'fit not estimated', reasons: outputFit.reasons }),
    );
  }

  return {
    latex: tailoredLatex,
    coverageBefore: coverageBefore > 0 ? coverageBefore : undefined,
    coverageAfter: coverageAfter > 0 ? coverageAfter : undefined,
    degraded,
    fitPt: outputFit.confidence === 'high' ? outputFit.totalPt : undefined,
    fitBudgetPt: outputFit.confidence === 'high' ? outputFit.budgetPt : undefined,
    fitStatus:
      outputFit.confidence !== 'high' ? 'unknown' : outputFit.fits ? 'fits' : 'over',
  };
}

/**
 * Make the Anthropic key visible to modules that read it from the environment.
 *
 * tailorLatex.ts fetches the key itself, but jdAnalyzer.ts is shared with the
 * Next app and reads process.env directly. Rather than fork that frozen-ish
 * module for Lambda, bridge the value into the environment once per container.
 */
async function ensureAnthropicKeyInEnv(): Promise<void> {
  if (process.env.ANTHROPIC_API_KEY) return;
  try {
    process.env.ANTHROPIC_API_KEY = await getAnthropicKey();
  } catch (err) {
    // Not fatal here: the failure surfaces per-job with a clearer message than
    // a cold-start crash that dead-letters everything on the queue.
    console.error(JSON.stringify({ msg: 'failed to load Anthropic key', error: String(err) }));
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}
