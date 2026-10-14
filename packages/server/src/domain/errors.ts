import type { ErrorCode } from '@inventory/shared';

/**
 * How a caller should treat a failure.
 *
 * - `transient`: the same request may succeed later (contention, timeout). Safe to retry.
 * - `permanent`: the request is wrong or the world has moved on. Retrying is harmful noise.
 */
export type ErrorClassification = 'transient' | 'permanent';

export type ErrorContext = Readonly<Record<string, string | number>>;

/**
 * Base class for every failure the domain can raise.
 *
 * Carries its own wire mapping (`code`, `httpStatus`) so the HTTP layer never
 * has to guess, and structured `context` so every log line is diagnosable.
 * `message` is written to be shown to an end user: it must never leak internals.
 */
export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly httpStatus: number;
  abstract readonly classification: ErrorClassification;

  readonly context: ErrorContext;

  constructor(message: string, context: ErrorContext = {}) {
    super(message);
    this.name = new.target.name;
    this.context = context;
  }
}

export const isDomainError = (error: unknown): error is DomainError => error instanceof DomainError;

export class ProductNotFoundError extends DomainError {
  readonly code = 'PRODUCT_NOT_FOUND';
  readonly httpStatus = 404;
  readonly classification = 'permanent';

  constructor(productId: string) {
    super('Product not found.', { productId });
  }
}

export class ReservationNotFoundError extends DomainError {
  readonly code = 'RESERVATION_NOT_FOUND';
  readonly httpStatus = 404;
  readonly classification = 'permanent';

  constructor(reservationId: string) {
    super('Reservation not found.', { reservationId });
  }
}

export class InsufficientStockError extends DomainError {
  readonly code = 'INSUFFICIENT_STOCK';
  readonly httpStatus = 409;
  readonly classification = 'permanent';

  constructor(productId: string, requested: number, available: number) {
    super(
      available === 0
        ? 'This item is sold out.'
        : `Only ${String(available)} left — ${String(requested)} requested.`,
      { productId, requested, available },
    );
  }
}

export class ReservationNotActiveError extends DomainError {
  readonly code = 'RESERVATION_NOT_ACTIVE';
  readonly httpStatus = 409;
  readonly classification = 'permanent';

  constructor(reservationId: string, status: string, reason: string) {
    super(reason, { reservationId, status });
  }
}

/**
 * The actor is authenticated but does not own the resource they are acting on.
 *
 * Deliberately reported to the client as "not found": a distinct 403 would turn
 * the endpoint into an existence oracle for other users' reservations. The real
 * reason survives in `context` and in the logs, where it belongs.
 */
export class ForbiddenError extends DomainError {
  readonly code = 'RESERVATION_NOT_FOUND';
  readonly httpStatus = 404;
  readonly classification = 'permanent';

  constructor(context: ErrorContext = {}) {
    super('Reservation not found.', { reason: 'ownership_mismatch', ...context });
  }
}

export class UnauthenticatedError extends DomainError {
  readonly code = 'UNAUTHENTICATED';
  readonly httpStatus = 401;
  readonly classification = 'permanent';

  constructor(reason = 'Authentication required.') {
    super(reason);
  }
}

/** The same idempotency key was replayed with a different request body. */
export class IdempotencyKeyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';
  readonly httpStatus = 409;
  readonly classification = 'permanent';

  constructor() {
    super('This idempotency key was already used with a different request.');
  }
}

/** A per-product lock could not be acquired in time. The system is healthy but busy. */
export class LockTimeoutError extends DomainError {
  readonly code = 'SERVICE_BUSY';
  readonly httpStatus = 503;
  readonly classification = 'transient';

  constructor(key: string, timeoutMs: number) {
    super('The service is busy. Please retry.', { key, timeoutMs });
  }
}

/**
 * An impossible state was reached — a bug, not a user error. Raised instead of
 * silently persisting corrupt inventory.
 */
export class InvariantViolationError extends DomainError {
  readonly code = 'INTERNAL_ERROR';
  readonly httpStatus = 500;
  readonly classification = 'permanent';

  constructor(invariant: string, context: ErrorContext = {}) {
    super('Something went wrong.', { invariant, ...context });
  }
}
