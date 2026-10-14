import { z } from 'zod';
import { MAX_RESERVATION_QUANTITY } from './constants.js';
import { productAvailabilitySchema } from './product.js';
import { reservationSchema } from './reservation.js';

/**
 * Identifiers are opaque to clients but constrained at the boundary: a bounded,
 * URL-safe character set keeps hostile input out of logs, paths and lock keys.
 */
const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/u, 'must contain only letters, digits, hyphen or underscore');

export const productIdSchema = identifierSchema;
export const reservationIdSchema = identifierSchema;

export const createSessionResponseSchema = z.object({
  userId: z.string(),
  token: z.string(),
  expiresAt: z.string(),
});
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

export const createReservationRequestSchema = z
  .object({
    productId: productIdSchema,
    quantity: z.number().int().positive().max(MAX_RESERVATION_QUANTITY),
  })
  .strict();
export type CreateReservationRequest = z.infer<typeof createReservationRequestSchema>;

export const reservationResponseSchema = z.object({
  reservation: reservationSchema,
  product: productAvailabilitySchema,
});
export type ReservationResponse = z.infer<typeof reservationResponseSchema>;

export const productListResponseSchema = z.object({
  products: z.array(productAvailabilitySchema),
});
export type ProductListResponse = z.infer<typeof productListResponseSchema>;

export const productResponseSchema = z.object({
  product: productAvailabilitySchema,
});
export type ProductResponse = z.infer<typeof productResponseSchema>;

export const reservationListResponseSchema = z.object({
  reservations: z.array(reservationSchema),
});
export type ReservationListResponse = z.infer<typeof reservationListResponseSchema>;

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number().nonnegative(),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
