import type { ReservationResponse } from '@inventory/shared';
import type { Express } from 'express';
import { ExpirySweeper } from './application/expirySweeper.js';
import type { Clock, InventoryRepository, Logger } from './application/ports.js';
import { ReservationService } from './application/reservationService.js';
import type { AppConfig } from './config/env.js';
import type { Inventory } from './domain/inventory.js';
import { buildCatalog } from './infrastructure/catalog.js';
import { InMemoryIdempotencyStore } from './infrastructure/inMemoryIdempotencyStore.js';
import { InMemoryInventoryRepository } from './infrastructure/inMemoryInventoryRepository.js';
import { KeyedMutex } from './infrastructure/keyedMutex.js';
import { SessionTokenService } from './infrastructure/sessionTokenService.js';
import { SystemClock } from './infrastructure/systemClock.js';
import { UuidIdGenerator } from './infrastructure/uuidIdGenerator.js';
import { createApp } from './http/createApp.js';
import { APP_VERSION } from './version.js';

export interface ContainerOverrides {
  /** Tests inject a controllable clock; production never passes one. */
  readonly clock?: Clock;
  readonly catalog?: readonly Inventory[];
}

export interface Container {
  readonly app: Express;
  readonly service: ReservationService;
  readonly tokens: SessionTokenService;
  readonly sweeper: ExpirySweeper;
  readonly repository: InventoryRepository;
  readonly logger: Logger;
}

/**
 * The composition root: the only place concrete implementations are chosen.
 *
 * Every other module depends on an interface, which is why the same wiring
 * powers the server, the integration tests and the load script with nothing
 * swapped but a clock and a catalogue.
 */
export const createContainer = (
  config: AppConfig,
  logger: Logger,
  overrides: ContainerOverrides = {},
): Container => {
  const clock = overrides.clock ?? new SystemClock();
  const catalog = overrides.catalog ?? buildCatalog();
  const repository = new InMemoryInventoryRepository(catalog);
  const lock = new KeyedMutex({ acquireTimeoutMs: config.LOCK_ACQUIRE_TIMEOUT_MS });

  const service = new ReservationService({
    repository,
    lock,
    clock,
    ids: new UuidIdGenerator(),
    idempotency: new InMemoryIdempotencyStore<ReservationResponse>({
      clock,
      ttlMs: config.IDEMPOTENCY_TTL_MS,
      maxEntries: config.IDEMPOTENCY_MAX_ENTRIES,
    }),
    logger,
    holdMs: config.RESERVATION_HOLD_MS,
  });

  const tokens = new SessionTokenService({
    secret: config.sessionSecret,
    ttlMs: config.SESSION_TTL_MS,
    clock,
  });

  const sweeper = new ExpirySweeper({
    repository,
    lock,
    clock,
    logger,
    intervalMs: config.SWEEP_INTERVAL_MS,
    retentionMs: config.RESERVATION_RETENTION_MS,
  });

  const app = createApp({ config, service, tokens, logger, version: APP_VERSION });

  return {
    app,
    service,
    tokens,
    sweeper,
    repository,
    logger,
  };
};
