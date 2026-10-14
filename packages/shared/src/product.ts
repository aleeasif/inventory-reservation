import { z } from 'zod';

/**
 * A product's stock position at a point in time.
 *
 *   available = totalStock - confirmedSales - activeReservations
 *
 * `available` is derived, never stored, so it cannot drift from its parts.
 */
export const productAvailabilitySchema = z.object({
  productId: z.string(),
  name: z.string(),
  totalStock: z.number().int().nonnegative(),
  confirmedSales: z.number().int().nonnegative(),
  activeReservations: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
});

export type ProductAvailability = z.infer<typeof productAvailabilitySchema>;
