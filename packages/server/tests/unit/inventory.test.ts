import { RESERVATION_HOLD_MS } from '@inventory/shared';
import { describe, expect, it } from 'vitest';
import {
  ForbiddenError,
  InsufficientStockError,
  InvariantViolationError,
  ReservationNotActiveError,
  ReservationNotFoundError,
} from '../../src/domain/errors.js';
import { toProductId, toReservationId, toUserId } from '../../src/domain/ids.js';
import { Inventory, type InventoryTransition } from '../../src/domain/inventory.js';

const PRODUCT = toProductId('flash-sale-single');
const ALICE = toUserId('alice');
const BOB = toUserId('bob');
const T0 = new Date('2026-01-01T00:00:00.000Z');
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);

const inventoryWith = (totalStock: number): Inventory =>
  Inventory.create({ productId: PRODUCT, name: 'Sneaker', totalStock });

const reserveOne = (
  inventory: Inventory,
  overrides: Partial<{ id: string; userId: typeof ALICE; quantity: number; now: Date }> = {},
): InventoryTransition =>
  inventory.reserve({
    reservationId: toReservationId(overrides.id ?? 'res-1'),
    userId: overrides.userId ?? ALICE,
    quantity: overrides.quantity ?? 1,
    now: overrides.now ?? T0,
    holdMs: RESERVATION_HOLD_MS,
  });

describe('Inventory — available stock formula', () => {
  it('starts with everything available', () => {
    expect(inventoryWith(5).availableStock(T0)).toBe(5);
  });

  it('subtracts active reservations', () => {
    const { inventory } = reserveOne(inventoryWith(5), { quantity: 2 });
    expect(inventory.availableStock(T0)).toBe(3);
  });

  it('subtracts confirmed sales', () => {
    const { inventory } = reserveOne(inventoryWith(5), { quantity: 2 });
    const confirmed = inventory.confirm({
      reservationId: toReservationId('res-1'),
      actorUserId: ALICE,
      now: T0,
    }).inventory;

    // The hold becomes a sale: the total withheld is unchanged, its reason is not.
    expect(confirmed.availableStock(T0)).toBe(3);
    expect(confirmed.snapshot(T0)).toMatchObject({
      totalStock: 5,
      confirmedSales: 2,
      activeReservations: 0,
      available: 3,
    });
  });

  it('never reports negative availability', () => {
    const { inventory } = reserveOne(inventoryWith(1));
    expect(inventory.availableStock(T0)).toBe(0);
  });
});

describe('Inventory — reserving', () => {
  it('rejects a reservation larger than availability instead of clamping it', () => {
    expect(() => reserveOne(inventoryWith(1), { quantity: 2 })).toThrow(InsufficientStockError);
  });

  it('reports how much is actually left', () => {
    try {
      reserveOne(inventoryWith(3), { quantity: 5 });
      expect.unreachable('expected InsufficientStockError');
    } catch (error) {
      expect(error).toBeInstanceOf(InsufficientStockError);
      expect((error as InsufficientStockError).context).toMatchObject({
        requested: 5,
        available: 3,
      });
    }
  });

  it('refuses to sell the last item twice', () => {
    const { inventory } = reserveOne(inventoryWith(1), { id: 'res-1' });
    expect(() => reserveOne(inventory, { id: 'res-2', userId: BOB })).toThrow(
      InsufficientStockError,
    );
  });

  it('sets the hold window from the supplied clock', () => {
    const { reservation } = reserveOne(inventoryWith(1));
    expect(reservation.expiresAt.getTime() - reservation.createdAt.getTime()).toBe(
      RESERVATION_HOLD_MS,
    );
    expect(reservation.status).toBe('ACTIVE');
  });

  it('refuses a quantity the boundary should already have rejected', () => {
    expect(() => reserveOne(inventoryWith(100), { quantity: 0 })).toThrow(InvariantViolationError);
    expect(() => reserveOne(inventoryWith(100), { quantity: 1.5 })).toThrow(
      InvariantViolationError,
    );
    expect(() => reserveOne(inventoryWith(100), { quantity: 99 })).toThrow(InvariantViolationError);
  });

  it('rejects a product created with impossible stock', () => {
    expect(() => inventoryWith(-1)).toThrow(InvariantViolationError);
  });
});

describe('Inventory — expiry', () => {
  it('releases stock the moment the hold lapses, with no sweeper involved', () => {
    const { inventory } = reserveOne(inventoryWith(1));

    expect(inventory.availableStock(at(RESERVATION_HOLD_MS - 1))).toBe(0);
    expect(inventory.availableStock(at(RESERVATION_HOLD_MS))).toBe(1);
  });

  it('lets the freed unit be reserved by someone else', () => {
    const { inventory } = reserveOne(inventoryWith(1));
    const later = at(RESERVATION_HOLD_MS + 1);

    const { reservation } = reserveOne(inventory, { id: 'res-2', userId: BOB, now: later });
    expect(reservation.userId).toBe(BOB);
  });

  it('refuses to confirm a lapsed reservation', () => {
    const { inventory } = reserveOne(inventoryWith(1));
    expect(() =>
      inventory.confirm({
        reservationId: toReservationId('res-1'),
        actorUserId: ALICE,
        now: at(RESERVATION_HOLD_MS + 1),
      }),
    ).toThrow(ReservationNotActiveError);
  });
});

describe('Inventory — confirming', () => {
  const confirmed = (): Inventory => {
    const { inventory } = reserveOne(inventoryWith(2));
    return inventory.confirm({
      reservationId: toReservationId('res-1'),
      actorUserId: ALICE,
      now: T0,
    }).inventory;
  };

  it('turns a hold into a sale', () => {
    expect(confirmed().snapshot(T0)).toMatchObject({ confirmedSales: 1, activeReservations: 0 });
  });

  it('is idempotent — confirming twice does not sell two units', () => {
    const once = confirmed();
    const twice = once.confirm({
      reservationId: toReservationId('res-1'),
      actorUserId: ALICE,
      now: T0,
    }).inventory;

    expect(twice.confirmedSales).toBe(1);
  });

  it('survives the hold window, because the sale is already made', () => {
    expect(confirmed().availableStock(at(RESERVATION_HOLD_MS * 10))).toBe(1);
  });

  it('refuses to confirm a cancelled reservation', () => {
    const { inventory } = reserveOne(inventoryWith(2));
    const cancelled = inventory.cancel({
      reservationId: toReservationId('res-1'),
      actorUserId: ALICE,
      now: T0,
    }).inventory;

    expect(() =>
      cancelled.confirm({
        reservationId: toReservationId('res-1'),
        actorUserId: ALICE,
        now: T0,
      }),
    ).toThrow(ReservationNotActiveError);
  });

  it('rejects an unknown reservation', () => {
    expect(() =>
      inventoryWith(1).confirm({
        reservationId: toReservationId('nope'),
        actorUserId: ALICE,
        now: T0,
      }),
    ).toThrow(ReservationNotFoundError);
  });
});

describe('Inventory — cancelling', () => {
  it('returns the held stock immediately', () => {
    const { inventory } = reserveOne(inventoryWith(1));
    const cancelled = inventory.cancel({
      reservationId: toReservationId('res-1'),
      actorUserId: ALICE,
      now: T0,
    }).inventory;

    expect(cancelled.availableStock(T0)).toBe(1);
  });

  it('is idempotent', () => {
    const { inventory } = reserveOne(inventoryWith(1));
    const once = inventory.cancel({
      reservationId: toReservationId('res-1'),
      actorUserId: ALICE,
      now: T0,
    }).inventory;
    const twice = once.cancel({
      reservationId: toReservationId('res-1'),
      actorUserId: ALICE,
      now: T0,
    });

    expect(twice.reservation.status).toBe('CANCELLED');
    expect(twice.inventory.availableStock(T0)).toBe(1);
  });

  it('never reverses a confirmed purchase', () => {
    const { inventory } = reserveOne(inventoryWith(1));
    const sold = inventory.confirm({
      reservationId: toReservationId('res-1'),
      actorUserId: ALICE,
      now: T0,
    }).inventory;

    expect(() =>
      sold.cancel({ reservationId: toReservationId('res-1'), actorUserId: ALICE, now: T0 }),
    ).toThrow(ReservationNotActiveError);
    expect(sold.availableStock(T0)).toBe(0);
  });

  it('settles an already-lapsed reservation as EXPIRED rather than CANCELLED', () => {
    const { inventory } = reserveOne(inventoryWith(1));
    const result = inventory.cancel({
      reservationId: toReservationId('res-1'),
      actorUserId: ALICE,
      now: at(RESERVATION_HOLD_MS + 1),
    });

    expect(result.reservation.status).toBe('EXPIRED');
  });
});

describe('Inventory — authorisation', () => {
  it('will not let one user confirm another user’s reservation', () => {
    const { inventory } = reserveOne(inventoryWith(1));
    expect(() =>
      inventory.confirm({ reservationId: toReservationId('res-1'), actorUserId: BOB, now: T0 }),
    ).toThrow(ForbiddenError);
  });

  it('will not let one user cancel another user’s reservation', () => {
    const { inventory } = reserveOne(inventoryWith(1));
    expect(() =>
      inventory.cancel({ reservationId: toReservationId('res-1'), actorUserId: BOB, now: T0 }),
    ).toThrow(ForbiddenError);
  });

  it('reports an ownership failure as "not found" so the API is not an existence oracle', () => {
    const { inventory } = reserveOne(inventoryWith(1));
    try {
      inventory.requireReservationOwnedBy(toReservationId('res-1'), BOB);
      expect.unreachable('expected ForbiddenError');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).httpStatus).toBe(404);
      expect((error as ForbiddenError).code).toBe('RESERVATION_NOT_FOUND');
      expect((error as ForbiddenError).message).not.toContain('ownership');
    }
  });
});

describe('Inventory — compaction', () => {
  it('writes EXPIRED onto lapsed holds', () => {
    const { inventory } = reserveOne(inventoryWith(1));
    const swept = inventory.compact(at(RESERVATION_HOLD_MS + 1), 60_000);

    expect(swept.findReservation(toReservationId('res-1'))?.status).toBe('EXPIRED');
  });

  it('returns the same instance when there is nothing to do', () => {
    const { inventory } = reserveOne(inventoryWith(1));
    expect(inventory.compact(T0, 60_000)).toBe(inventory);
  });

  it('forgets terminal reservations once past the retention window', () => {
    const { inventory } = reserveOne(inventoryWith(1));
    const swept = inventory.compact(at(RESERVATION_HOLD_MS + 60_001), 60_000);

    expect(swept.findReservation(toReservationId('res-1'))).toBeUndefined();
    expect(swept.availableStock(at(RESERVATION_HOLD_MS + 60_001))).toBe(1);
  });

  it('keeps confirmed sales counted after the record is forgotten', () => {
    const { inventory } = reserveOne(inventoryWith(1));
    const sold = inventory.confirm({
      reservationId: toReservationId('res-1'),
      actorUserId: ALICE,
      now: T0,
    }).inventory;

    const swept = sold.compact(at(RESERVATION_HOLD_MS + 60_001), 60_000);
    expect(swept.findReservation(toReservationId('res-1'))).toBeUndefined();
    expect(swept.availableStock(at(RESERVATION_HOLD_MS + 60_001))).toBe(0);
  });
});
