import type { ReservationStatus } from '@inventory/shared';
import type { ProductId, ReservationId, UserId } from './ids.js';

/**
 * A temporary claim on stock.
 *
 *   ACTIVE ──confirm──▶ CONFIRMED   purchase completed, never reversible
 *     │  │
 *     │  └──cancel────▶ CANCELLED   released by the user
 *     └─────lapse─────▶ EXPIRED     released by the clock
 *
 * Only ACTIVE-and-unlapsed reservations hold stock.
 */
export interface Reservation {
  readonly reservationId: ReservationId;
  readonly productId: ProductId;
  readonly userId: UserId;
  readonly quantity: number;
  readonly status: ReservationStatus;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/**
 * True once the hold time has elapsed but before any sweeper has written
 * EXPIRED to the record.
 *
 * Expiry is evaluated from the clock, never from a background job having run.
 * That is what makes "expired reservations release inventory automatically"
 * correct even if the sweeper is late, paused or dead.
 */
export const hasLapsed = (reservation: Reservation, now: Date): boolean =>
  reservation.status === 'ACTIVE' && reservation.expiresAt.getTime() <= now.getTime();

/** True while the reservation is still withholding stock from other buyers. */
export const isHoldingStock = (reservation: Reservation, now: Date): boolean =>
  reservation.status === 'ACTIVE' && !hasLapsed(reservation, now);

/** The status as of `now`, accounting for expiry that has not yet been materialised. */
export const effectiveStatus = (reservation: Reservation, now: Date): ReservationStatus =>
  hasLapsed(reservation, now) ? 'EXPIRED' : reservation.status;

/** A reservation in a terminal state will never hold stock again. */
export const isTerminal = (status: ReservationStatus): boolean => status !== 'ACTIVE';

export const withStatus = (reservation: Reservation, status: ReservationStatus): Reservation => ({
  ...reservation,
  status,
});
