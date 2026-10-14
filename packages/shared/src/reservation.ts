import { z } from 'zod';

/**
 * Reservation lifecycle.
 *
 *   ACTIVE ──confirm──▶ CONFIRMED   (terminal: a completed purchase, never reversible)
 *     │ │
 *     │ └──cancel───▶ CANCELLED     (terminal: stock released)
 *     └────expiry───▶ EXPIRED       (terminal: stock released)
 *
 * Only ACTIVE reservations hold stock. All other states are terminal.
 */
export const RESERVATION_STATUSES = ['ACTIVE', 'CONFIRMED', 'CANCELLED', 'EXPIRED'] as const;

export const reservationStatusSchema = z.enum(RESERVATION_STATUSES);
export type ReservationStatus = z.infer<typeof reservationStatusSchema>;

export const reservationSchema = z.object({
  reservationId: z.string(),
  productId: z.string(),
  userId: z.string(),
  quantity: z.number().int().positive(),
  status: reservationStatusSchema,
  /** ISO-8601 UTC. */
  createdAt: z.string(),
  /** ISO-8601 UTC. The instant the hold lapses; meaningful only while ACTIVE. */
  expiresAt: z.string(),
});

export type Reservation = z.infer<typeof reservationSchema>;
