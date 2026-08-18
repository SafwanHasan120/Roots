import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Match my-app and infra: deterministic dates regardless of local timezone.
process.env.TZ = 'UTC';

export default defineConfig({
  resolve: {
    alias: {
      // Services reuse the app's scrape and normalization logic rather than
      // reimplementing it. companyNormalizer / expirationDetector are frozen
      // modules — imported, never edited.
      '@app': path.resolve(__dirname, '../my-app/lib'),
      '@infra': path.resolve(__dirname, '../infra/lib'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 30000,
  },
});
