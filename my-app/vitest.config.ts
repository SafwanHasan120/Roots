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
      // firebase.ts / firestore-sync.ts still back user data (resume,
      // favorites, tailor results). lib/firestore.ts and tailorRateLimiter.ts
      // were deleted with the listings and quota migrations.
      exclude: ['lib/__tests__', 'lib/firebase.ts', 'lib/firestore-sync.ts'],
    },
  },
});
