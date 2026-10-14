import { describe, expect, it, vi } from 'vitest';
import { ExpirySweeper } from '../../src/application/expirySweeper.js';
import type { InventoryRepository } from '../../src/application/ports.js';
import { toProductId, toReservationId, toUserId } from '../../src/domain/ids.js';
import { Inventory } from '../../src/domain/inventory.js';
import { InMemoryInventoryRepository } from '../../src/infrastructure/inMemoryInventoryRepository.js';
import { KeyedMutex } from '../../src/infrastructure/keyedMutex.js';
import { createSilentLogger } from '../../src/infrastructure/logger.js';
import { FakeClock } from '../../src/infrastructure/systemClock.js';

const PRODUCT = toProductId('flash-sale-single');
const RESERVATION = toReservationId('res-1');
const HOLD_MS = 120_000;
const RETENTION_MS = 60_000;

const seededRepository = (): InMemoryInventoryRepository => {
  const base = Inventory.create({ productId: PRODUCT, name: 'Sneaker', totalStock: 1 });
  const { inventory } = base.reserve({
    reservationId: RESERVATION,
    userId: toUserId('alice'),
    quantity: 1,
    now: new Date('2026-01-01T00:00:00.000Z'),
    holdMs: HOLD_MS,
  });
  return new InMemoryInventoryRepository([inventory]);
};

const buildSweeper = (repository: InventoryRepository, clock: FakeClock): ExpirySweeper =>
  new ExpirySweeper({
    repository,
    lock: new KeyedMutex({ acquireTimeoutMs: 1_000 }),
    clock,
    logger: createSilentLogger(),
    intervalMs: 50,
    retentionMs: RETENTION_MS,
  });

describe('ExpirySweeper', () => {
  it('does nothing while every hold is still live', async () => {
    const repository = seededRepository();
    const sweeper = buildSweeper(repository, new FakeClock());

    expect(await sweeper.sweepOnce()).toBe(0);
  });

  it('materialises EXPIRED once a hold has lapsed', async () => {
    const repository = seededRepository();
    const clock = new FakeClock();
    clock.advanceBy(HOLD_MS + 1);

    expect(await buildSweeper(repository, clock).sweepOnce()).toBe(1);

    const inventory = await repository.findById(PRODUCT);
    expect(inventory?.findReservation(RESERVATION)?.status).toBe('EXPIRED');
  });

  it('is not what releases the stock — availability recovers before it runs', async () => {
    const repository = seededRepository();
    const clock = new FakeClock();
    clock.advanceBy(HOLD_MS + 1);

    const inventory = await repository.findById(PRODUCT);
    expect(inventory?.findReservation(RESERVATION)?.status).toBe('ACTIVE');
    expect(inventory?.availableStock(clock.now())).toBe(1);
  });

  it('forgets terminal reservations past the retention window', async () => {
    const repository = seededRepository();
    const clock = new FakeClock();
    clock.advanceBy(HOLD_MS + RETENTION_MS + 1);

    await buildSweeper(repository, clock).sweepOnce();
    await buildSweeper(repository, clock).sweepOnce();

    const inventory = await repository.findById(PRODUCT);
    expect(inventory?.reservations.size).toBe(0);
    // The secondary index must be cleaned up with it, or it leaks.
    expect(await repository.locateProduct(RESERVATION)).toBeUndefined();
  });

  it('logs and keeps running when a sweep fails, rather than killing the process', async () => {
    const failing: InventoryRepository = {
      findById: () => Promise.reject(new Error('datastore down')),
      listAll: () => Promise.reject(new Error('datastore down')),
      locateProduct: () => Promise.reject(new Error('datastore down')),
      save: () => Promise.reject(new Error('datastore down')),
    };
    const logger = createSilentLogger();
    const errorSpy = vi.spyOn(logger, 'error');

    const sweeper = new ExpirySweeper({
      repository: failing,
      lock: new KeyedMutex({ acquireTimeoutMs: 1_000 }),
      clock: new FakeClock(),
      logger,
      intervalMs: 5,
      retentionMs: RETENTION_MS,
    });

    sweeper.start();
    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalled();
    });
    sweeper.stop();

    await expect(sweeper.sweepOnce()).rejects.toThrow('datastore down');
  });

  it('start is idempotent and stop is safe to call twice', () => {
    const sweeper = buildSweeper(seededRepository(), new FakeClock());

    sweeper.start();
    sweeper.start();
    sweeper.stop();
    expect(() => {
      sweeper.stop();
    }).not.toThrow();
  });
});
