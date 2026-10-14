import { z } from 'zod';

/**
 * Every failure the API can return. Clients branch on `code`, never on `message`,
 * so messages stay free to change and codes do not.
 */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'PRODUCT_NOT_FOUND',
  'RESERVATION_NOT_FOUND',
  'INSUFFICIENT_STOCK',
  'RESERVATION_NOT_ACTIVE',
  'RESERVATION_LIMIT_EXCEEDED',
  'IDEMPOTENCY_KEY_CONFLICT',
  'RATE_LIMITED',
  'SERVICE_BUSY',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL_ERROR',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    /** Human-readable and safe to show a user. Never contains internal detail. */
    message: z.string(),
    /** Field-level detail for VALIDATION_FAILED; absent otherwise. */
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
  requestId: z.string(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
