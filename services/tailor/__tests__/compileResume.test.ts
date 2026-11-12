import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileResume, scrubbedEnv } from '../compileResume.js';

const ONE_PAGE = [
  '%PDF-1.4',
  '1 0 obj << /Type /Pages /Count 1 /Kids [2 0 R] >> endobj',
  '',
].join('\n');

describe('scrubbedEnv', () => {
  it('drops credential-shaped variables and pins the cache under /tmp', () => {
    const env = scrubbedEnv({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      ANTHROPIC_KEY_PARAM: '/intern-tool/anthropic-api-key',
      AWS_ACCESS_KEY_ID: 'AKIA',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_SESSION_TOKEN: 'token',
      HOME: '/Users/someone',
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_KEY_PARAM).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
    expect(env.HOME).toBe('/tmp');
    expect(env.XDG_CACHE_HOME).toBe('/tmp/tectonic-cache');
    expect(env.TMPDIR).toBe('/tmp');
  });
});

describe('compileResume', () => {
  async function fakeBin(script: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'tectonic-bin-'));
    const bin = path.join(dir, 'tectonic');
    await writeFile(bin, script, 'utf8');
    await chmod(bin, 0o755);
    return bin;
  }

  it('counts pages from the PDF the compiler writes', async () => {
    const bin = await fakeBin(`#!/bin/sh
if [ -n "$ANTHROPIC_API_KEY" ]; then
  exit 3
fi
outdir=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--outdir" ]; then
    outdir="$arg"
  fi
  prev="$arg"
done
cat > "$outdir/resume.pdf" << 'EOF'
${ONE_PAGE}
EOF
exit 0
`);

    const result = await compileResume('\\documentclass{article}\\begin{document}x\\end{document}', {
      bin,
      env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-ant-secret' },
    });

    expect(result).toEqual({ ok: true, pages: 1 });
  });

  it('reports a missing binary without throwing', async () => {
    const result = await compileResume('latex', { bin: '/no/such/tectonic' });
    expect(result).toEqual({ ok: false, error: 'tectonic unavailable' });
  });

  it('kills a compile that exceeds the timeout', async () => {
    const bin = await fakeBin(`#!/bin/sh
sleep 30
exit 0
`);

    const result = await compileResume('latex', { bin, timeoutMs: 200 });
    expect(result).toEqual({ ok: false, error: 'compile timed out' });
  });

  it('does not treat a non-zero exit as a page count', async () => {
    const bin = await fakeBin(`#!/bin/sh
exit 1
`);
    const result = await compileResume('latex', { bin });
    expect(result).toEqual({ ok: false, error: 'compile failed' });
  });
});
