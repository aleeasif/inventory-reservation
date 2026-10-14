import type { Inventory } from '../domain/inventory.js';
import type { ProductId, ReservationId } from '../domain/ids.js';

/**
 * Everything the application layer needs from the outside world, expressed as
 * interfaces it owns. Dependencies point inward: no file in `domain/` or
 * `application/` imports a database, a framework or a concrete clock.
 */

/** Time as an injectable dependency, so expiry can be tested without waiting. */
export interface Clock {
  now(): Date;
}

/** Collision-resistant, unguessable identifiers. */
export interface IdGenerator {
  next(): string;
}

export interface InventoryRepository {
  findById(productId: ProductId): Promise<Inventory | undefined>;
  listAll(): Promise<readonly Inventory[]>;
  /** Resolves which product aggregate owns a reservation, so it can be locked. */
  locateProduct(reservationId: ReservationId): Promise<ProductId | undefined>;
  save(inventory: Inventory): Promise<void>;
}

/**
 * Mutual exclusion over a named resource.
 *
 * The in-process implementation is a FIFO keyed mutex. Swapping in Redis
 * (Redlock) or a database advisory lock is a one-class change because nothing
 * above this interface knows which it is.
 */
export interface Lock {
  /** Runs `critical` with exclusive access to `key`, releasing even if it throws. */
  withLock<T>(key: string, critical: () => Promise<T>): Promise<T>;
}

export interface IdempotencyRecord<T> {
  /** Hash of the request this key was first used with, to detect replay with different input. */
  readonly fingerprint: string;
  readonly value: T;
}

export interface IdempotencyStore<T> {
  get(key: string): Promise<IdempotencyRecord<T> | undefined>;
  set(key: string, record: IdempotencyRecord<T>): Promise<void>;
}

export type LogContext = Readonly<Record<string, unknown>>;

/** Structural subset of pino's logger, so the application never imports pino. */
export interface Logger {
  debug(context: LogContext, message: string): void;
  info(context: LogContext, message: string): void;
  warn(context: LogContext, message: string): void;
  error(context: LogContext, message: string): void;
  child(context: LogContext): Logger;
}
