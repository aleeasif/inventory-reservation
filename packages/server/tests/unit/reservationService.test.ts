import { IDEMPOTENCY_KEY_HEADER, type ReservationResponse } from '@inventory/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { ReservationService } from '../../src/application/reservationService.js';
import {
  IdempotencyKeyConflictError,
  ProductNotFoundError,
  ReservationNotFoundError,
} from '../../src/domain/errors.js';
import { toProductId, toReservationId, toUserId } from '../../src/domain/ids.js';
import { Inventory } from '../../src/domain/inventory.js';
import { InMemoryIdempotencyStore } from '../../src/infrastructure/inMemoryIdempotencyStore.js';
import { InMemoryInventoryRepository } from '../../src/infrastructure/inMemoryInventoryRepository.js';
import { KeyedMutex } from '../../src/infrastructure/keyedMutex.js';
import { createSilentLogger } from '../../src/infrastructure/logger.js';
import { FakeClock } from '../../src/infrastructure/systemClock.js';
import { UuidIdGenerator } from '../../src/infrastructure/uuidIdGenerator.js';

const PRODUCT = toProductId('flash-sale-single');
const OTHER_PRODUCT = toProductId('flash-sale-ten');
const ALICE = toUserId('alice');
const BOB = toUserId('bob');
const HOLD_MS = 120_000;

let clock: FakeClock;
let repository: InMemoryInventoryRepository;
let service: ReservationService;

beforeEach(() => {
  clock = new FakeClock();
  repository = new InMemoryInventoryRepository([
    Inventory.create({ productId: PRODUCT, name: 'Sneaker', totalStock: 2 }),
    Inventory.create({ productId: OTHER_PRODUCT, name: 'Keyboard', totalStock: 5 }),
  ]);
  service = new ReservationService({
    repository,
    lock: new KeyedMutex({ acquireTimeoutMs: 1_000 }),
    clock,
    ids: new UuidIdGenerator(),
    idempotency: new InMemoryIdempotencyStore<ReservationResponse>({
      clock,
      ttlMs: 60_000,
      maxEntries: 100,
    }),
    logger: createSilentLogger(),
    holdMs: HOLD_MS,
  });
});

describe('ReservationService — reserving', () => {
  it('returns the reservation alongside the resulting stock position', async () => {
    const result = await service.reserve({ productId: PRODUCT, userId: ALICE, quantity: 1 });

    expect(result.reservation).toMatchObject({ status: 'ACTIVE', quantity: 1, userId: ALICE });
    expect(result.product).toMatchObject({ available: 1, activeReservations: 1 });
  });

  it('rejects an unknown product', async () => {
    await expect(
      service.reserve({ productId: toProductId('ghost'), userId: ALICE, quantity: 1 }),
    ).rejects.toBeInstanceOf(ProductNotFoundError);
  });

  it('issues unguessable identifiers', async () => {
    const first = await service.reserve({ productId: PRODUCT, userId: ALICE, quantity: 1 });
    const second = await service.reserve({ productId: PRODUCT, userId: BOB, quantity: 1 });

    expect(first.reservation.reservationId).not.toBe(second.reservation.reservationId);
    expect(first.reservation.reservationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });
});

describe(`ReservationService — ${IDEMPOTENCY_KEY_HEADER}`, () => {
  it('returns the original reservation when the same request is retried', async () => {
    const command = { productId: PRODUCT, userId: ALICE, quantity: 1, idempotencyKey: 'retry-123' };

    const first = await service.reserve(command);
    const second = await service.reserve(command);

    expect(second.reservation.reservationId).toBe(first.reservation.reservationId);
    const inventory = await repository.findById(PRODUCT);
    expect(inventory?.heldQuantity(clock.now())).toBe(1);
  });

  it('is safe when both retries land simultaneously', async () => {
    const command = { productId: PRODUCT, userId: ALICE, quantity: 1, idempotencyKey: 'retry-123' };

    const [first, second] = await Promise.all([service.reserve(command), service.reserve(command)]);

    expect(second.reservation.reservationId).toBe(first.reservation.reservationId);
    const inventory = await repository.findById(PRODUCT);
    expect(inventory?.heldQuantity(clock.now())).toBe(1);
  });

  it('rejects a key replayed with a different request', async () => {
    await service.reserve({
      productId: PRODUCT,
      userId: ALICE,
      quantity: 1,
      idempotencyKey: 'retry-123',
    });

    await expect(
      service.reserve({
        productId: PRODUCT,
        userId: ALICE,
        quantity: 2,
        idempotencyKey: 'retry-123',
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
  });

  it('scopes keys per user, so one buyer cannot replay another’s', async () => {
    const key = 'shared-key-value';
    const alice = await service.reserve({
      productId: PRODUCT,
      userId: ALICE,
      quantity: 1,
      idempotencyKey: key,
    });
    const bob = await service.reserve({
      productId: PRODUCT,
      userId: BOB,
      quantity: 1,
      idempotencyKey: key,
    });

    expect(bob.reservation.reservationId).not.toBe(alice.reservation.reservationId);
    expect(bob.reservation.userId).toBe(BOB);
  });
});

describe('ReservationService — reading', () => {
  it('lists only the caller’s own reservations, newest first', async () => {
    const first = await service.reserve({ productId: PRODUCT, userId: ALICE, quantity: 1 });
    clock.advanceBy(1_000);
    const second = await service.reserve({ productId: OTHER_PRODUCT, userId: ALICE, quantity: 1 });
    await service.reserve({ productId: OTHER_PRODUCT, userId: BOB, quantity: 1 });

    const mine = await service.listReservations(ALICE);

    expect(mine.map((reservation) => reservation.reservationId)).toEqual([
      second.reservation.reservationId,
      first.reservation.reservationId,
    ]);
  });

  it('hides another user’s reservation behind a not-found', async () => {
    const { reservation } = await service.reserve({
      productId: PRODUCT,
      userId: ALICE,
      quantity: 1,
    });

    await expect(
      service.getReservation({
        reservationId: toReservationId(reservation.reservationId),
        userId: BOB,
      }),
    ).rejects.toMatchObject({ code: 'RESERVATION_NOT_FOUND', httpStatus: 404 });
  });

  it('rejects an unknown reservation id', async () => {
    await expect(
      service.getReservation({ reservationId: toReservationId('missing'), userId: ALICE }),
    ).rejects.toBeInstanceOf(ReservationNotFoundError);
  });

  it('reports a lapsed reservation as EXPIRED without waiting for a sweeper', async () => {
    const { reservation } = await service.reserve({
      productId: PRODUCT,
      userId: ALICE,
      quantity: 1,
    });
    clock.advanceBy(HOLD_MS + 1);

    const result = await service.getReservation({
      reservationId: toReservationId(reservation.reservationId),
      userId: ALICE,
    });

    expect(result.reservation.status).toBe('EXPIRED');
    expect(result.product.available).toBe(2);
  });
});

describe('ReservationService — confirming and cancelling', () => {
  it('confirms a hold into a sale', async () => {
    const { reservation } = await service.reserve({
      productId: PRODUCT,
      userId: ALICE,
      quantity: 1,
    });

    const result = await service.confirm({
      reservationId: toReservationId(reservation.reservationId),
      userId: ALICE,
    });

    expect(result.reservation.status).toBe('CONFIRMED');
    expect(result.product).toMatchObject({
      confirmedSales: 1,
      activeReservations: 0,
      available: 1,
    });
  });

  it('releases stock on cancel', async () => {
    const { reservation } = await service.reserve({
      productId: PRODUCT,
      userId: ALICE,
      quantity: 2,
    });

    const result = await service.cancel({
      reservationId: toReservationId(reservation.reservationId),
      userId: ALICE,
    });

    expect(result.reservation.status).toBe('CANCELLED');
    expect(result.product.available).toBe(2);
  });

  it('refuses to confirm after the hold has lapsed', async () => {
    const { reservation } = await service.reserve({
      productId: PRODUCT,
      userId: ALICE,
      quantity: 1,
    });
    clock.advanceBy(HOLD_MS);

    await expect(
      service.confirm({
        reservationId: toReservationId(reservation.reservationId),
        userId: ALICE,
      }),
    ).rejects.toMatchObject({ code: 'RESERVATION_NOT_ACTIVE' });
  });
});
