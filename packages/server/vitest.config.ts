import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Concurrency tests spin 500 parallel requests; give them room without hiding hangs.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
