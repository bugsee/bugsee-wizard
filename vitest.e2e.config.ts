import { defineConfig } from 'vitest/config';

// The end-to-end suite (e2e/): real projects, real installs and builds. Kept out of `npm test`.
export default defineConfig({
  test: {
    include: ['e2e/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 15 * 60_000,
    hookTimeout: 15 * 60_000,
    reporters: ['verbose'],
  },
});
