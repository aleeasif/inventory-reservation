import type { Express } from 'express';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { createContainer, type Container } from '../../src/container.js';
import { buildCatalog, type CatalogItem } from '../../src/infrastructure/catalog.js';
import { createSilentLogger } from '../../src/infrastructure/logger.js';
import { FakeClock } from '../../src/infrastructure/systemClock.js';

export interface TestContainer extends Container {
  readonly app: Express;
  readonly clock: FakeClock;
  readonly config: AppConfig;
}

export interface TestContainerOptions {
  readonly catalog?: readonly CatalogItem[];
  readonly env?: NodeJS.ProcessEnv;
  readonly clock?: FakeClock;
}

/**
 * Wires the real container with a controllable clock and a silent logger.
 *
 * Tests exercise production wiring — the same middleware chain, the same lock,
 * the same error handler — so a bug in composition cannot hide behind a
 * hand-rolled test harness.
 */
export const createTestContainer = (options: TestContainerOptions = {}): TestContainer => {
  const clock = options.clock ?? new FakeClock();

  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SESSION_SECRET: 'test-secret-value-at-least-32-characters-long',
    // Rate limits exist to stop abuse, not to cap the concurrency tests that
    // deliberately fire 500 requests from one address.
    RATE_LIMIT_MAX: '1000000',
    RATE_LIMIT_WRITE_MAX: '1000000',
    ...options.env,
  });

  const container = createContainer(config, createSilentLogger(), {
    clock,
    catalog: buildCatalog(options.catalog),
  });

  return { ...container, clock, config };
};

/** Mints a bearer header for a fresh anonymous buyer. */
export const authHeaderFor = (container: TestContainer): { Authorization: string } => ({
  Authorization: `Bearer ${container.tokens.issue().token}`,
});
