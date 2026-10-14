import type { ProductAvailability, Reservation as ReservationDto } from '@inventory/shared';
import type { AvailabilitySnapshot } from '../domain/inventory.js';
import { effectiveStatus, type Reservation } from '../domain/reservation.js';

/**
 * Domain → wire. Pure functions: no I/O, no clock of their own, no side effects.
 */

export const toReservationDto = (reservation: Reservation, now: Date): ReservationDto => ({
  reservationId: reservation.reservationId,
  productId: reservation.productId,
  userId: reservation.userId,
  quantity: reservation.quantity,
  // Report expiry the moment it happens, not the moment the sweeper notices.
  status: effectiveStatus(reservation, now),
  createdAt: reservation.createdAt.toISOString(),
  expiresAt: reservation.expiresAt.toISOString(),
});

export const toProductDto = (snapshot: AvailabilitySnapshot): ProductAvailability => ({
  productId: snapshot.productId,
  name: snapshot.name,
  totalStock: snapshot.totalStock,
  confirmedSales: snapshot.confirmedSales,
  activeReservations: snapshot.activeReservations,
  available: snapshot.available,
});
