import type { Clock, IdempotencyRecord, IdempotencyStore } from '../application/ports.js';

export interface IdempotencyStoreOptions {
  readonly clock: Clock;
  /** How long a key is remembered. Beyond this a retry is treated as a new request. */
  readonly ttlMs: number;
  /** Hard cap on retained keys, so a hostile client cannot exhaust memory. */
  readonly maxEntries: number;
}

interface StoredEntry<T> {
  readonly record: IdempotencyRecord<T>;
  readonly expiresAt: number;
}

/**
 * Remembers the outcome of a reservation request so an interrupted client can
 * retry without buying twice.
 *
 * Bounded in both directions: entries expire by TTL, and the oldest entry is
 * evicted once `maxEntries` is reached, so an unbounded stream of unique keys
 * cannot be used as a memory-exhaustion vector.
 */
export class InMemoryIdempotencyStore<T> implements IdempotencyStore<T> {
  private readonly entries = new Map<string, StoredEntry<T>>();

  constructor(private readonly options: IdempotencyStoreOptions) {}

  get size(): number {
    return this.entries.size;
  }

  async get(key: string): Promise<IdempotencyRecord<T> | undefined> {
    await Promise.resolve();
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAt <= this.options.clock.now().getTime()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.record;
  }

  async set(key: string, record: IdempotencyRecord<T>): Promise<void> {
    await Promise.resolve();
    this.evictIfFull();
    this.entries.set(key, {
      record,
      expiresAt: this.options.clock.now().getTime() + this.options.ttlMs,
    });
  }

  private evictIfFull(): void {
    if (this.entries.size < this.options.maxEntries) {
      return;
    }
    // Map preserves insertion order, so the first key is the oldest.
    const oldest = this.entries.keys().next();
    if (!oldest.done) {
      this.entries.delete(oldest.value);
    }
  }
}
