import { defineConfig } from 'vitest/config';
import path from 'path';

// Set timezone to UTC for deterministic date tests
process.env.TZ = 'UTC';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts'],
      exclude: ['lib/__tests__', 'lib/firebase.ts', 'lib/firestore.ts', 'lib/firestore-sync.ts', 'lib/tailorRateLimiter.ts'],
    },
  },
});
