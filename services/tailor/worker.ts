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
import { tailorLatexWithAnalysis, tailorLatexDegraded } from './tailorLatex.js';
import { consume, release } from './rateLimit.js';
import { markRunning, markDone, markFailed, getJob } from './jobs.js';

const s3 = new S3Client({ maxAttempts: 3 });

interface TailorMessage {
  jobId: string;
  uid: string;
  internshipId: string;
  latex: string;
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

export async function handler(event: SQSEvent): Promise<void> {
  // batchSize is 1; written as a loop so raising it later cannot silently drop
  // records.
  for (const record of event.Records) {
    await processRecord(record);
  }
}

async function processRecord(record: SQSRecord): Promise<void> {
  const msg = JSON.parse(record.body) as TailorMessage;
  const { jobId, uid, internshipId, latex } = msg;

  // A redelivered message whose first attempt already finished must not re-run
  // the pipeline — that would double-charge Claude and re-settle the quota.
  const existing = await getJob(jobId);
  if (existing && (existing.status === 'DONE' || existing.status === 'FAILED')) {
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
    const result = await runPipeline({ internshipId, latex });

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
    });

    // Charge only now: the artifact exists and passed validation.
    await consume(uid);

    console.log(
      JSON.stringify({ msg: 'job done', jobId, uid, degraded: result.degraded }),
    );
  } catch (err) {
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
}

async function runPipeline(input: {
  internshipId: string;
  latex: string;
}): Promise<PipelineResult> {
  const { internshipId, latex } = input;

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
  try {
    const jd = await extractJD(appUrl);
    if (!jd.text) {
      throw new JobError(
        'jd_extraction_failed',
        'Could not extract job description from the provided URL. Please try again or check the link.',
      );
    }
    jdText = jd.text;
    jdConfidence = jd.confidence;
  } catch (err) {
    if (err instanceof JobError) throw err;
    throw new JobError(
      'jd_extraction_failed',
      'Could not extract job description from the provided URL. Please try again or check the link.',
      String(err),
    );
  }

  let tailoredLatex: string | undefined;
  let coverageBefore = 0;
  let coverageAfter = 0;
  let degraded = false;

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
      tailoredLatex = await tailorLatexDegraded(internship.company, internship.role, latex);
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

  return {
    latex: tailoredLatex,
    coverageBefore: coverageBefore > 0 ? coverageBefore : undefined,
    coverageAfter: coverageAfter > 0 ? coverageAfter : undefined,
    degraded,
  };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}
