import type { ReservationResponse } from '@inventory/shared';
import { describe, expect, it } from 'vitest';
import type { Lock } from '../../src/application/ports.js';
import { ReservationService } from '../../src/application/reservationService.js';
import { InsufficientStockError } from '../../src/domain/errors.js';
import { toProductId, toReservationId, toUserId } from '../../src/domain/ids.js';
import { Inventory } from '../../src/domain/inventory.js';
import { InMemoryIdempotencyStore } from '../../src/infrastructure/inMemoryIdempotencyStore.js';
import { InMemoryInventoryRepository } from '../../src/infrastructure/inMemoryInventoryRepository.js';
import { KeyedMutex, NoopLock } from '../../src/infrastructure/keyedMutex.js';
import { createSilentLogger } from '../../src/infrastructure/logger.js';
import { FakeClock } from '../../src/infrastructure/systemClock.js';
import { UuidIdGenerator } from '../../src/infrastructure/uuidIdGenerator.js';

const PRODUCT = toProductId('flash-sale-single');
const SIMULTANEOUS_BUYERS = 500;

interface Harness {
  readonly service: ReservationService;
  readonly repository: InMemoryInventoryRepository;
  readonly clock: FakeClock;
}

const buildHarness = (options: { lock: Lock; totalStock: number }): Harness => {
  const clock = new FakeClock();
  const repository = new InMemoryInventoryRepository([
    Inventory.create({ productId: PRODUCT, name: 'Sneaker', totalStock: options.totalStock }),
  ]);

  const service = new ReservationService({
    repository,
    lock: options.lock,
    clock,
    ids: new UuidIdGenerator(),
    idempotency: new InMemoryIdempotencyStore<ReservationResponse>({
      clock,
      ttlMs: 60_000,
      maxEntries: 1_000,
    }),
    logger: createSilentLogger(),
    holdMs: 120_000,
  });

  return { service, repository, clock };
};

interface Outcome {
  readonly succeeded: number;
  readonly soldOut: number;
  readonly other: number;
}

/** Fires `count` reservations at the same instant and tallies what came back. */
const stampede = async (harness: Harness, count: number): Promise<Outcome> => {
  const attempts = Array.from({ length: count }, (_unused, index) =>
    harness.service.reserve({
      productId: PRODUCT,
      // A distinct buyer per request, so the per-user cap plays no part.
      userId: toUserId(`buyer-${String(index)}`),
      quantity: 1,
    }),
  );

  const settled = await Promise.allSettled(attempts);

  let succeeded = 0;
  let soldOut = 0;
  let other = 0;
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      succeeded += 1;
    } else if (result.reason instanceof InsufficientStockError) {
      soldOut += 1;
    } else {
      other += 1;
    }
  }
  return { succeeded, soldOut, other };
};

const confirmedPlusHeld = async (harness: Harness): Promise<number> => {
  const inventory = await harness.repository.findById(PRODUCT);
  const now = harness.clock.now();
  return (inventory?.confirmedSales ?? 0) + (inventory?.heldQuantity(now) ?? 0);
};

/**
 * The reason the lock exists.
 *
 * This file first demonstrates the bug, then demonstrates its absence. A test
 * that only asserts the happy path would pass against code that oversells on a
 * slower machine; proving the unlocked version actually *does* oversell is what
 * makes the locked result meaningful.
 */
describe('Concurrency — the overselling race', () => {
  it('is incorrect without a lock: many buyers are told they won the last unit', async () => {
    const harness = buildHarness({ lock: new NoopLock(), totalStock: 1 });

    const outcome = await stampede(harness, SIMULTANEOUS_BUYERS);
    const accountedFor = await confirmedPlusHeld(harness);

    // Every request loads availability, yields at the repository `await`, and
    // only then writes — so they all see the single unit as free and all get a
    // success response. One unit of stock, many winners: that is the oversell.
    expect(outcome.succeeded).toBeGreaterThan(1);

    // The stored state cannot even agree with what the buyers were told, because
    // the concurrent writes clobber one another. Silent data loss on top of the
    // oversell — exactly what serialising the critical section removes.
    expect(accountedFor).not.toBe(outcome.succeeded);
  });

  it('sells exactly one unit to exactly one of 500 simultaneous buyers', async () => {
    const harness = buildHarness({
      lock: new KeyedMutex({ acquireTimeoutMs: 10_000 }),
      totalStock: 1,
    });

    const outcome = await stampede(harness, SIMULTANEOUS_BUYERS);

    expect(outcome).toEqual({ succeeded: 1, soldOut: SIMULTANEOUS_BUYERS - 1, other: 0 });
    expect(await confirmedPlusHeld(harness)).toBe(1);
  });

  it('sells exactly the stock on hand, never one more', async () => {
    const stock = 37;
    const harness = buildHarness({
      lock: new KeyedMutex({ acquireTimeoutMs: 10_000 }),
      totalStock: stock,
    });

    const outcome = await stampede(harness, SIMULTANEOUS_BUYERS);

    expect(outcome.succeeded).toBe(stock);
    expect(outcome.soldOut).toBe(SIMULTANEOUS_BUYERS - stock);
    expect(await confirmedPlusHeld(harness)).toBe(stock);
  });

  it('keeps the availability counter exact under a mixed reserve/cancel storm', async () => {
    const harness = buildHarness({
      lock: new KeyedMutex({ acquireTimeoutMs: 10_000 }),
      totalStock: 50,
    });

    const reserved = await Promise.allSettled(
      Array.from({ length: 200 }, (_unused, index) =>
        harness.service.reserve({
          productId: PRODUCT,
          userId: toUserId(`buyer-${String(index)}`),
          quantity: 1,
        }),
      ),
    );

    const winners = reserved.filter(
      (result): result is PromiseFulfilledResult<ReservationResponse> =>
        result.status === 'fulfilled',
    );
    expect(winners).toHaveLength(50);

    // Half cancel, half confirm — all at once.
    await Promise.all(
      winners.map((winner, index) =>
        index % 2 === 0
          ? harness.service.cancel({
              reservationId: toReservationId(winner.value.reservation.reservationId),
              userId: toUserId(winner.value.reservation.userId),
            })
          : harness.service.confirm({
              reservationId: toReservationId(winner.value.reservation.reservationId),
              userId: toUserId(winner.value.reservation.userId),
            }),
      ),
    );

    const inventory = await harness.repository.findById(PRODUCT);
    expect(inventory?.confirmedSales).toBe(25);
    expect(inventory?.availableStock(harness.clock.now())).toBe(25);
  });

  it('does not serialise buyers of different products behind each other', async () => {
    const lock = new KeyedMutex({ acquireTimeoutMs: 10_000 });
    const clock = new FakeClock();
    const repository = new InMemoryInventoryRepository([
      Inventory.create({ productId: toProductId('a'), name: 'A', totalStock: 1 }),
      Inventory.create({ productId: toProductId('b'), name: 'B', totalStock: 1 }),
    ]);
    const service = new ReservationService({
      repository,
      lock,
      clock,
      ids: new UuidIdGenerator(),
      idempotency: new InMemoryIdempotencyStore<ReservationResponse>({
        clock,
        ttlMs: 60_000,
        maxEntries: 10,
      }),
      logger: createSilentLogger(),
      holdMs: 120_000,
    });

    const [first, second] = await Promise.all([
      service.reserve({ productId: toProductId('a'), userId: toUserId('alice'), quantity: 1 }),
      service.reserve({ productId: toProductId('b'), userId: toUserId('bob'), quantity: 1 }),
    ]);

    expect(first.product.available).toBe(0);
    expect(second.product.available).toBe(0);
  });
});
