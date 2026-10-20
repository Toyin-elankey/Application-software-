import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Database tests run against a disposable PostgreSQL database (see scripts/db/reset-test.mjs).
// They run one file at a time so tests never write to the same data concurrently.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/db/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
