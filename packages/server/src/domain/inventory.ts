import { MAX_RESERVATION_QUANTITY } from '@inventory/shared';
import {
  ForbiddenError,
  InsufficientStockError,
  InvariantViolationError,
  ReservationNotActiveError,
  ReservationNotFoundError,
} from './errors.js';
import type { ProductId, ReservationId, UserId } from './ids.js';
import {
  effectiveStatus,
  isHoldingStock,
  isTerminal,
  withStatus,
  type Reservation,
} from './reservation.js';

export interface InventoryState {
  readonly productId: ProductId;
  readonly name: string;
  readonly totalStock: number;
  readonly confirmedSales: number;
  readonly reservations: ReadonlyMap<ReservationId, Reservation>;
}

export interface ReserveCommand {
  readonly reservationId: ReservationId;
  readonly userId: UserId;
  readonly quantity: number;
  readonly now: Date;
  readonly holdMs: number;
}

export interface ReservationCommand {
  readonly reservationId: ReservationId;
  readonly actorUserId: UserId;
  readonly now: Date;
}

export interface InventoryTransition {
  readonly inventory: Inventory;
  readonly reservation: Reservation;
}

export interface AvailabilitySnapshot {
  readonly productId: ProductId;
  readonly name: string;
  readonly totalStock: number;
  readonly confirmedSales: number;
  readonly activeReservations: number;
  readonly available: number;
}

/**
 * The inventory position of a single product, and the only place the
 * overselling invariant is enforced:
 *
 *     confirmedSales + heldByActiveReservations <= totalStock
 *
 * The aggregate is immutable and pure — no clock, no I/O, no framework. Every
 * transition returns a new `Inventory`; the caller decides whether to persist
 * it. That is what makes the whole rule set trivially unit-testable and what
 * lets the service layer hold a lock around "load → transition → save".
 */
export class Inventory {
  private constructor(private readonly state: InventoryState) {}

  static create(input: { productId: ProductId; name: string; totalStock: number }): Inventory {
    if (!Number.isInteger(input.totalStock) || input.totalStock < 0) {
      throw new InvariantViolationError('totalStock must be a non-negative integer', {
        productId: input.productId,
        totalStock: input.totalStock,
      });
    }
    return new Inventory({ ...input, confirmedSales: 0, reservations: new Map() });
  }

  /** Rebuilds an aggregate from stored state. Used only by repositories. */
  static rehydrate(state: InventoryState): Inventory {
    return new Inventory(state);
  }

  get productId(): ProductId {
    return this.state.productId;
  }

  get name(): string {
    return this.state.name;
  }

  get totalStock(): number {
    return this.state.totalStock;
  }

  get confirmedSales(): number {
    return this.state.confirmedSales;
  }

  get reservations(): ReadonlyMap<ReservationId, Reservation> {
    return this.state.reservations;
  }

  /** Quantity currently withheld by reservations that have not lapsed. */
  heldQuantity(now: Date): number {
    let held = 0;
    for (const reservation of this.state.reservations.values()) {
      if (isHoldingStock(reservation, now)) {
        held += reservation.quantity;
      }
    }
    return held;
  }

  /** available = totalStock − confirmedSales − activeReservations */
  availableStock(now: Date): number {
    return this.state.totalStock - this.state.confirmedSales - this.heldQuantity(now);
  }

  snapshot(now: Date): AvailabilitySnapshot {
    const activeReservations = this.heldQuantity(now);
    return {
      productId: this.state.productId,
      name: this.state.name,
      totalStock: this.state.totalStock,
      confirmedSales: this.state.confirmedSales,
      activeReservations,
      available: this.state.totalStock - this.state.confirmedSales - activeReservations,
    };
  }

  findReservation(reservationId: ReservationId): Reservation | undefined {
    return this.state.reservations.get(reservationId);
  }

  reservationsOf(userId: UserId): readonly Reservation[] {
    return [...this.state.reservations.values()].filter(
      (reservation) => reservation.userId === userId,
    );
  }

  /**
   * Authorisation lives here, not only on the route: a reservation may only be
   * read or acted on by the user who created it, however the call arrives.
   */
  requireReservationOwnedBy(reservationId: ReservationId, actorUserId: UserId): Reservation {
    const reservation = this.state.reservations.get(reservationId);
    if (reservation === undefined) {
      throw new ReservationNotFoundError(reservationId);
    }
    if (reservation.userId !== actorUserId) {
      throw new ForbiddenError({ reservationId });
    }
    return reservation;
  }

  /**
   * Places a hold on `quantity` units.
   *
   * Rejects — rather than clamps — when stock is short: a partial reservation
   * would be a silent change to what the user asked for.
   */
  reserve(command: ReserveCommand): InventoryTransition {
    this.assertQuantityIsSane(command.quantity);

    const available = this.availableStock(command.now);
    if (command.quantity > available) {
      throw new InsufficientStockError(this.state.productId, command.quantity, available);
    }

    const reservation: Reservation = {
      reservationId: command.reservationId,
      productId: this.state.productId,
      userId: command.userId,
      quantity: command.quantity,
      status: 'ACTIVE',
      createdAt: command.now,
      expiresAt: new Date(command.now.getTime() + command.holdMs),
    };

    return {
      inventory: this.withReservation(reservation),
      reservation,
    };
  }

  /**
   * Turns a hold into a sale. Idempotent: confirming an already-confirmed
   * reservation returns it unchanged rather than double-counting the sale.
   */
  confirm(command: ReservationCommand): InventoryTransition {
    const reservation = this.requireOwnedReservation(command);
    const status = effectiveStatus(reservation, command.now);

    if (status === 'CONFIRMED') {
      return { inventory: this, reservation };
    }
    if (status !== 'ACTIVE') {
      throw new ReservationNotActiveError(
        reservation.reservationId,
        status,
        status === 'EXPIRED'
          ? 'This reservation expired and the stock was released.'
          : 'This reservation was cancelled.',
      );
    }

    const confirmed = withStatus(reservation, 'CONFIRMED');
    const confirmedSales = this.state.confirmedSales + reservation.quantity;

    if (confirmedSales > this.state.totalStock) {
      // Unreachable while reserve() guards availability and a lock serialises
      // writes. Loud failure beats persisting oversold inventory.
      throw new InvariantViolationError('confirmedSales must never exceed totalStock', {
        productId: this.state.productId,
        confirmedSales,
        totalStock: this.state.totalStock,
      });
    }

    return {
      inventory: new Inventory({
        ...this.state,
        confirmedSales,
        reservations: this.replaced(confirmed),
      }),
      reservation: confirmed,
    };
  }

  /**
   * Releases a hold. Idempotent for an already-cancelled reservation; a
   * confirmed purchase can never be reversed here.
   */
  cancel(command: ReservationCommand): InventoryTransition {
    const reservation = this.requireOwnedReservation(command);
    const status = effectiveStatus(reservation, command.now);

    if (status === 'CANCELLED') {
      return { inventory: this, reservation };
    }
    if (status === 'CONFIRMED') {
      throw new ReservationNotActiveError(
        reservation.reservationId,
        status,
        'This purchase is confirmed and cannot be reversed.',
      );
    }
    if (status === 'EXPIRED') {
      // The stock is already released; materialise the state so the record agrees.
      const expired = withStatus(reservation, 'EXPIRED');
      return { inventory: this.withReservation(expired), reservation: expired };
    }

    const cancelled = withStatus(reservation, 'CANCELLED');
    return { inventory: this.withReservation(cancelled), reservation: cancelled };
  }

  /**
   * Writes EXPIRED onto reservations whose hold has lapsed, and forgets
   * terminal reservations older than `retentionMs` so memory stays bounded.
   *
   * Purely cosmetic for availability — `heldQuantity` already ignores lapsed
   * holds — which is why the sweeper being late can never oversell.
   */
  compact(now: Date, retentionMs: number): Inventory {
    const next = new Map<ReservationId, Reservation>();
    let changed = false;

    for (const [id, reservation] of this.state.reservations) {
      const status = effectiveStatus(reservation, now);

      if (isTerminal(status) && now.getTime() - reservation.expiresAt.getTime() > retentionMs) {
        changed = true;
        continue;
      }
      if (status !== reservation.status) {
        changed = true;
        next.set(id, withStatus(reservation, status));
        continue;
      }
      next.set(id, reservation);
    }

    return changed ? new Inventory({ ...this.state, reservations: next }) : this;
  }

  private assertQuantityIsSane(quantity: number): void {
    const isSane =
      Number.isSafeInteger(quantity) && quantity > 0 && quantity <= MAX_RESERVATION_QUANTITY;
    if (!isSane) {
      // The HTTP layer validates this too; the domain refuses to trust that it did.
      throw new InvariantViolationError('quantity must be an integer within the allowed range', {
        productId: this.state.productId,
        quantity,
      });
    }
  }

  private requireOwnedReservation(command: ReservationCommand): Reservation {
    return this.requireReservationOwnedBy(command.reservationId, command.actorUserId);
  }

  private withReservation(reservation: Reservation): Inventory {
    return new Inventory({ ...this.state, reservations: this.replaced(reservation) });
  }

  private replaced(reservation: Reservation): ReadonlyMap<ReservationId, Reservation> {
    const next = new Map(this.state.reservations);
    next.set(reservation.reservationId, reservation);
    return next;
  }
}
