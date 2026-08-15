import { defineConfig } from 'vitest/config';

// Match my-app: deterministic dates regardless of the developer's timezone.
process.env.TZ = 'UTC';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // CDK synth is slow on a cold run.
    testTimeout: 30000,
  },
});
