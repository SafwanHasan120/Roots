import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQSEvent } from 'aws-lambda';

const s3Send = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = s3Send;
  },
  PutObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

const getListingById = vi.fn();
vi.mock('../listings.js', () => ({ getListingById: (...a: unknown[]) => getListingById(...a) }));

const assertSafeUrl = vi.fn();
vi.mock('@app/urlGuard', () => ({ assertSafeUrl: (...a: unknown[]) => assertSafeUrl(...a) }));

const extractJD = vi.fn();
vi.mock('@app/jdExtractor', () => ({ extractJD: (...a: unknown[]) => extractJD(...a) }));

const analyzeJD = vi.fn();
vi.mock('@app/jdAnalyzer', () => ({ analyzeJD: (...a: unknown[]) => analyzeJD(...a) }));

const tailorLatexWithAnalysis = vi.fn();
const tailorLatexDegraded = vi.fn();
vi.mock('../tailorLatex.js', () => ({
  tailorLatexWithAnalysis: (...a: unknown[]) => tailorLatexWithAnalysis(...a),
  tailorLatexDegraded: (...a: unknown[]) => tailorLatexDegraded(...a),
  getAnthropicKey: async () => 'test-key',
}));

const consume = vi.fn();
const release = vi.fn();
vi.mock('../rateLimit.js', () => ({
  consume: (...a: unknown[]) => consume(...a),
  release: (...a: unknown[]) => release(...a),
}));

const getJob = vi.fn();
const markRunning = vi.fn();
const markDone = vi.fn();
const markFailed = vi.fn();
const markNeedsJd = vi.fn();
vi.mock('../jobs.js', () => ({
  getJob: (...a: unknown[]) => getJob(...a),
  markRunning: (...a: unknown[]) => markRunning(...a),
  markDone: (...a: unknown[]) => markDone(...a),
  markFailed: (...a: unknown[]) => markFailed(...a),
  markNeedsJd: (...a: unknown[]) => markNeedsJd(...a),
}));

const { handler } = await import('../worker.js');

const LATEX = '\\documentclass{article}\\begin{document}Original\\end{document}';
const TAILORED = '\\documentclass{article}\\begin{document}Tailored\\end{document}';

const event = (over: Record<string, unknown> = {}): SQSEvent =>
  ({
    Records: [
      {
        body: JSON.stringify({
          jobId: 'job-1',
          uid: 'user-1',
          internshipId: 'listing-1',
          latex: LATEX,
          ...over,
        }),
      },
    ],
  }) as SQSEvent;

describe('tailor worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ARTIFACT_BUCKET = 'test-bucket';

    getJob.mockResolvedValue({ jobId: 'job-1', status: 'QUEUED' });
    markRunning.mockResolvedValue(undefined);
    markDone.mockResolvedValue(undefined);
    markFailed.mockResolvedValue(undefined);
    markNeedsJd.mockResolvedValue(undefined);
    consume.mockResolvedValue(undefined);
    release.mockResolvedValue(undefined);
    s3Send.mockResolvedValue({});

    getListingById.mockResolvedValue({
      id: 'listing-1',
      company: 'Acme',
      role: 'SWE Intern',
      appUrl: 'https://example.com/job/1',
      location: 'Remote',
      datePosted: 'Aug 01',
      dateMs: 1,
      prestigeScore: 0,
      source: 'owner/repo',
    });
    assertSafeUrl.mockResolvedValue(undefined);
    extractJD.mockResolvedValue({ text: 'Job description text', confidence: 'high' });
    analyzeJD.mockResolvedValue({
      required_skills: ['python'],
      preferred_skills: ['aws'],
      keywords: ['python', 'aws'],
    });
    tailorLatexWithAnalysis.mockResolvedValue(TAILORED);
    tailorLatexDegraded.mockResolvedValue(TAILORED);
  });

  describe('success path', () => {
    it('writes the artifact and marks the job done', async () => {
      await handler(event());

      expect(s3Send).toHaveBeenCalledTimes(1);
      expect(s3Send.mock.calls[0][0].input).toMatchObject({
        Bucket: 'test-bucket',
        Key: 'jobs/user-1/job-1.tex',
        Body: TAILORED,
      });
      expect(markDone).toHaveBeenCalled();
    });

    it('charges the quota only after the artifact exists', async () => {
      const order: string[] = [];
      s3Send.mockImplementation(async () => void order.push('s3'));
      consume.mockImplementation(async () => void order.push('consume'));

      await handler(event());

      expect(order).toEqual(['s3', 'consume']);
      expect(release).not.toHaveBeenCalled();
    });

    it('never charges on the failure path', async () => {
      tailorLatexWithAnalysis.mockRejectedValue(new Error('Claude 529'));
      tailorLatexDegraded.mockRejectedValue(new Error('Claude 529'));

      await handler(event());

      expect(consume).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledWith('user-1');
    });
  });

  describe('failure handling', () => {
    it.each([
      ['listing missing', () => getListingById.mockResolvedValue(null), 'not_found'],
      ['unsafe url', () => assertSafeUrl.mockRejectedValue(new Error('private ip')), 'unsafe_url'],
    ])('marks %s as FAILED and releases the reservation', async (_label, arrange, code) => {
      arrange();

      await handler(event());

      expect(markFailed).toHaveBeenCalledWith('job-1', code, expect.any(String));
      expect(release).toHaveBeenCalledWith('user-1');
      expect(consume).not.toHaveBeenCalled();
    });

    it('returns a user-safe message, never the raw error', async () => {
      assertSafeUrl.mockRejectedValue(new Error('DNS resolved to 169.254.169.254'));

      await handler(event());

      const clientMessage = markFailed.mock.calls[0][2];
      expect(clientMessage).not.toMatch(/169\.254/);
      expect(clientMessage).toMatch(/security validation/i);
    });

    it('does not rethrow, so a deterministic failure is not retried three times', async () => {
      // A bad JD page fails identically on every delivery. Rethrowing would
      // burn two more invocations and dead-letter for nothing.
      extractJD.mockRejectedValue(new Error('permanent 404'));
      await expect(handler(event())).resolves.toBeUndefined();
    });
  });

  describe('manual job description fallback', () => {
    it('settles as NEEDS_JD when extraction finds nothing, not FAILED', async () => {
      // Client-rendered boards (Workday and similar) serve the description via
      // JavaScript, so there is nothing in the HTML. That is recoverable — the
      // user can paste it — and must not look like a failure.
      extractJD.mockResolvedValue({ text: '', confidence: 'low' });

      await handler(event());

      expect(markNeedsJd).toHaveBeenCalledWith('job-1', 'jd_required', expect.any(String));
      expect(markFailed).not.toHaveBeenCalled();
    });

    it('settles as NEEDS_JD when extraction throws', async () => {
      extractJD.mockRejectedValue(new Error('404'));

      await handler(event());

      expect(markNeedsJd).toHaveBeenCalled();
      expect(markFailed).not.toHaveBeenCalled();
    });

    it('does not charge the user for a job that needs a paste', async () => {
      extractJD.mockResolvedValue({ text: '', confidence: 'low' });

      await handler(event());

      expect(consume).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledWith('user-1');
    });

    it('uses a pasted description without fetching the page', async () => {
      await handler(event({ manualJd: 'We need a Python engineer with AWS experience.' }));

      expect(extractJD).not.toHaveBeenCalled();
      expect(analyzeJD).toHaveBeenCalledWith(
        'We need a Python engineer with AWS experience.',
        expect.any(String),
      );
      expect(markDone).toHaveBeenCalled();
      expect(consume).toHaveBeenCalled();
    });

    it('treats a pasted description as high confidence', async () => {
      // A human copied it off the page, which beats anything inferred from
      // markup — so it takes the full analysis path, not the degraded one.
      await handler(event({ manualJd: 'A'.repeat(500) }));

      expect(tailorLatexWithAnalysis).toHaveBeenCalled();
      expect(tailorLatexDegraded).not.toHaveBeenCalled();
    });

    it('ignores a blank paste and asks again', async () => {
      extractJD.mockResolvedValue({ text: '', confidence: 'low' });

      await handler(event({ manualJd: '   ' }));

      expect(markNeedsJd).toHaveBeenCalled();
    });
  });

  describe('idempotency', () => {
    it('skips a job that already completed', async () => {
      // SQS may redeliver a message whose first attempt succeeded; re-running
      // would double-charge Claude and re-settle the quota.
      getJob.mockResolvedValue({ jobId: 'job-1', status: 'DONE' });

      await handler(event());

      expect(tailorLatexWithAnalysis).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
      expect(s3Send).not.toHaveBeenCalled();
    });

    it('skips a job that already failed', async () => {
      getJob.mockResolvedValue({ jobId: 'job-1', status: 'FAILED' });

      await handler(event());

      expect(release).not.toHaveBeenCalled();
      expect(tailorLatexWithAnalysis).not.toHaveBeenCalled();
    });

    it('skips a job already waiting on a pasted description', async () => {
      // NEEDS_JD is settled: the reservation is released and the user has been
      // asked. Re-running would extract-and-fail all over again.
      getJob.mockResolvedValue({ jobId: 'job-1', status: 'NEEDS_JD' });

      await handler(event());

      expect(release).not.toHaveBeenCalled();
      expect(extractJD).not.toHaveBeenCalled();
    });

    it('yields to a concurrent delivery that already claimed the job', async () => {
      markRunning.mockRejectedValue(
        Object.assign(new Error('conditional failed'), {
          name: 'ConditionalCheckFailedException',
        }),
      );

      await handler(event());

      expect(tailorLatexWithAnalysis).not.toHaveBeenCalled();
    });
  });

  describe('degraded mode', () => {
    it('falls back when JD confidence is low', async () => {
      extractJD.mockResolvedValue({ text: 'sparse', confidence: 'low' });

      await handler(event());

      expect(tailorLatexDegraded).toHaveBeenCalled();
      expect(tailorLatexWithAnalysis).not.toHaveBeenCalled();
      expect(markDone.mock.calls[0][1]).toMatchObject({ degraded: true });
    });

    it('falls back when JD analysis throws', async () => {
      analyzeJD.mockRejectedValue(new Error('bad JSON'));

      await handler(event());

      expect(tailorLatexDegraded).toHaveBeenCalled();
      expect(consume).toHaveBeenCalled();
    });
  });

  describe('output validation', () => {
    it('fails the job when the tailored LaTeX is empty', async () => {
      tailorLatexWithAnalysis.mockResolvedValue('   ');
      tailorLatexDegraded.mockResolvedValue('   ');

      await handler(event());

      expect(markFailed).toHaveBeenCalledWith('job-1', 'tailor_failed', expect.any(String));
      expect(consume).not.toHaveBeenCalled();
    });

    it('fails the job when validation rejects fabricated content', async () => {
      // latexValidator is frozen and imported unmocked, so this exercises the
      // real guard against added sections and altered numbers.
      tailorLatexWithAnalysis.mockResolvedValue(
        '\\documentclass{article}\\begin{document}\\section{Fake}99\\end{document}',
      );
      tailorLatexDegraded.mockResolvedValue(
        '\\documentclass{article}\\begin{document}\\section{Fake}99\\end{document}',
      );

      await handler(event());

      expect(consume).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalled();
    });
  });
});
