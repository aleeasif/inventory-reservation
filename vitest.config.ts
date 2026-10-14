import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/server'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // `shared` is consumed through its built output, so measuring its sources
      // here would report a misleading 0% for code the server exercises on
      // every request. Process entry points are excluded for the same reason:
      // they are wiring, verified by running the thing, not by unit tests.
      include: ['packages/server/src/**/*.ts'],
      exclude: ['packages/server/src/index.ts'],
      thresholds: {
        statements: 85,
        branches: 85,
        functions: 80,
        lines: 85,
      },
    },
  },
});
