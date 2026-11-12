/**
 * Compile a resume with Tectonic and read the PDF page count.
 *
 * The binary is bundled into the worker asset at deploy time (see TailorStack).
 * Locally, set TECTONIC_BIN or have `tectonic` on PATH. The TeX bundle cache
 * lives under /tmp so a warm Lambda reuses it.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pdfPageCount } from './pdfPages.js';

/** One compile, including a cold bundle fetch. The worker budgets for two. */
export const COMPILE_TIMEOUT_MS = 45_000;

export interface CompileResult {
  ok: boolean;
  /** Present only when the PDF compiled and its page tree was readable. */
  pages?: number;
  /** Short reason. Never the compiler log: that can echo `\input` file contents. */
  error?: string;
}

export interface CompileOptions {
  timeoutMs?: number;
  bin?: string;
  /** Defaults to process.env. Tests pass a fixture env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Names whose values must not reach the compiler.
 *
 * A resume can `\input` or `\openin` a path. The compiler runs the user's
 * document, so the child environment is the boundary that keeps the Anthropic
 * key and the Lambda credentials out of that document.
 */
const SECRET_NAME =
  /(?:^|_)(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)(?:_|$)|ANTHROPIC|AWS_ACCESS_KEY|AWS_SECRET|AWS_SESSION/i;

export function scrubbedEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (SECRET_NAME.test(key)) continue;
    env[key] = value;
  }
  // Tectonic's cache follows XDG, not an app-specific variable. Pin both so a
  // warm container reuses the bundle and nothing is written under a real home.
  env.HOME = '/tmp';
  env.XDG_CACHE_HOME = '/tmp/tectonic-cache';
  env.TMPDIR = '/tmp';
  return env;
}

function resolveBin(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.TECTONIC_BIN) return process.env.TECTONIC_BIN;
  if (process.env.LAMBDA_TASK_ROOT) return path.join(process.env.LAMBDA_TASK_ROOT, 'tectonic');
  return 'tectonic';
}

function runTectonic(
  bin: string,
  texPath: string,
  outDir: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: { code: number | null; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const child = spawn(bin, ['--outdir', outDir, texPath], {
      cwd: path.dirname(texPath),
      env,
      // Discard both streams. The log can quote files the document read.
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: null, timedOut: true });
    }, timeoutMs);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => finish({ code, timedOut: false }));
  });
}

export async function compileResume(
  latex: string,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const dir = await mkdtemp(path.join(tmpdir(), 'resume-'));
  const timeoutMs = options.timeoutMs ?? COMPILE_TIMEOUT_MS;

  try {
    const texPath = path.join(dir, 'resume.tex');
    await writeFile(texPath, latex, 'utf8');

    let outcome: { code: number | null; timedOut: boolean };
    try {
      outcome = await runTectonic(
        resolveBin(options.bin),
        texPath,
        dir,
        timeoutMs,
        scrubbedEnv(options.env),
      );
    } catch {
      return { ok: false, error: 'tectonic unavailable' };
    }

    if (outcome.timedOut) return { ok: false, error: 'compile timed out' };
    if (outcome.code !== 0) return { ok: false, error: 'compile failed' };

    let pdf: Buffer;
    try {
      pdf = await readFile(path.join(dir, 'resume.pdf'));
    } catch {
      return { ok: false, error: 'compile produced no pdf' };
    }

    const pages = pdfPageCount(pdf);
    if (pages === null) return { ok: false, error: 'page count unreadable' };
    return { ok: true, pages };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
