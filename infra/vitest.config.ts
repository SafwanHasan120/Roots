import { defineConfig } from 'vitest/config';

// Match my-app: deterministic dates regardless of the developer's timezone.
process.env.TZ = 'UTC';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // CDK synth is slow on a cold run.
    testTimeout: 30000,
    // NodejsFunction shells out to esbuild via child_process. Vitest's default
    // worker-thread pool replaces process.stdio with a stream object that
    // child_process rejects ("The argument 'stdio' is invalid"), so any test
    // synthesizing a bundled Lambda fails despite `cdk synth` working. Forks
    // give each test file a real process with real stdio.
    pool: 'forks',
  },
});
