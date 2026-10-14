import { createHash } from 'node:crypto';

/**
 * Stable hash of the inputs an idempotency key was first used with, so a replay
 * carrying a *different* body is rejected instead of silently returning the
 * wrong reservation.
 */
export const fingerprintReservationRequest = (input: {
  productId: string;
  quantity: number;
}): string =>
  createHash('sha256')
    .update(`${input.productId} ${String(input.quantity)}`)
    .digest('hex');
