import { LockTimeoutError } from '../domain/errors.js';
import type { Lock } from '../application/ports.js';

export interface KeyedMutexOptions {
  /**
   * How long a caller will queue for a key before giving up with a transient
   * error. Failing fast under pathological contention beats an unbounded queue
   * of requests the client has already abandoned.
   */
  readonly acquireTimeoutMs: number;
}

/**
 * A fair, per-key mutex for a single Node process.
 *
 * ### Why this exists
 *
 * JavaScript runs one callback at a time, so a *synchronous* read-modify-write
 * is already atomic. A reservation is not synchronous: it awaits the repository
 * to load, runs domain logic, then awaits the repository to save. Every `await`
 * yields the event loop, so two requests can interleave like this:
 *
 *     request A: load (available = 1) ──await──┐
 *     request B: load (available = 1) ─────────┤   both saw 1
 *     request A: save (reserved 1)   ◀─────────┘
 *     request B: save (reserved 1)                 oversold
 *
 * Serialising the whole critical section closes that window.
 *
 * ### Why per key
 *
 * Locking globally would serialise every product in the catalogue behind the
 * one item that is trending. Contention is only ever real between buyers of the
 * *same* product, so the key is the product.
 *
 * ### Fairness
 *
 * Waiters are chained onto a per-key promise tail, so they are served strictly
 * first-in-first-out. No caller can be starved by a steady stream of newcomers.
 *
 * ### Scope
 *
 * This guards one process. Across several instances the same invariant must be
 * enforced where the state lives — a conditional `UPDATE ... WHERE available >=
 * :qty`, `SELECT ... FOR UPDATE`, or a Redis Lua script. Because callers depend
 * on the `Lock` interface rather than this class, that swap is one file.
 */
export class KeyedMutex implements Lock {
  /** key -> promise that resolves when every currently queued holder is done. */
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly options: KeyedMutexOptions) {}

  /** Number of keys with at least one holder or waiter. Used by tests and metrics. */
  get activeKeys(): number {
    return this.tails.size;
  }

  async withLock<T>(key: string, critical: () => Promise<T>): Promise<T> {
    const predecessor = this.tails.get(key) ?? Promise.resolve();

    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const tail = predecessor.then(() => held);
    this.tails.set(key, tail);

    try {
      await this.awaitTurn(key, predecessor, release, tail);
      return await critical();
    } finally {
      release();
      // Only the last waiter clears the key, so a queue in progress is never dropped.
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }

  /**
   * Waits for the predecessor to finish, or gives up after `acquireTimeoutMs`.
   *
   * On timeout the slot is released immediately so the queue behind it keeps
   * moving, and a *transient* error is raised: the caller may safely retry.
   */
  private async awaitTurn(
    key: string,
    predecessor: Promise<void>,
    release: () => void,
    tail: Promise<void>,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new LockTimeoutError(key, this.options.acquireTimeoutMs));
      }, this.options.acquireTimeoutMs);
      timer.unref();
    });

    try {
      await Promise.race([predecessor, timeout]);
    } catch (error) {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * A lock that does not lock. Exists so tests can demonstrate the race condition
 * the real lock prevents. Never wire this into the application.
 */
export class NoopLock implements Lock {
  async withLock<T>(_key: string, critical: () => Promise<T>): Promise<T> {
    return critical();
  }
}
