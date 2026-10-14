import type { Clock, InventoryRepository, Lock, Logger } from './ports.js';

const LOG_PREFIX = '[ExpirySweeper]';

export interface ExpirySweeperDependencies {
  readonly repository: InventoryRepository;
  readonly lock: Lock;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly intervalMs: number;
  /** How long terminal reservations are kept queryable before being forgotten. */
  readonly retentionMs: number;
}

/**
 * Materialises expiry and bounds memory.
 *
 * It is deliberately *not* what releases stock. Availability is computed from
 * the clock (`Inventory.heldQuantity`), so a lapsed hold stops blocking other
 * buyers the instant it lapses, whether or not this sweeper has run. If the
 * sweeper is late, paused or dead, the system is still correct — it just shows
 * `EXPIRED` a little later and keeps records a little longer.
 */
export class ExpirySweeper {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: ExpirySweeperDependencies) {}

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runSweep();
    }, this.deps.intervalMs);
    // Never hold the process open just to run housekeeping.
    this.timer.unref();
    this.deps.logger.info({ intervalMs: this.deps.intervalMs }, `${LOG_PREFIX} started`);
  }

  stop(): void {
    if (this.timer === undefined) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
    this.deps.logger.info({}, `${LOG_PREFIX} stopped`);
  }

  /**
   * Sweeps every product once, locking them one at a time. Returns how many
   * aggregates changed, which is what the tests assert on.
   */
  async sweepOnce(): Promise<number> {
    const inventories = await this.deps.repository.listAll();
    let compacted = 0;

    for (const inventory of inventories) {
      const changed = await this.deps.lock.withLock(`product:${inventory.productId}`, async () => {
        const current = await this.deps.repository.findById(inventory.productId);
        if (current === undefined) {
          return false;
        }
        const next = current.compact(this.deps.clock.now(), this.deps.retentionMs);
        if (next === current) {
          return false;
        }
        await this.deps.repository.save(next);
        return true;
      });
      if (changed) {
        compacted += 1;
      }
    }

    return compacted;
  }

  /**
   * A failed sweep must never take the process down and must never go unnoticed:
   * the next tick retries, and the failure is logged with full context.
   */
  private async runSweep(): Promise<void> {
    try {
      const compacted = await this.sweepOnce();
      if (compacted > 0) {
        this.deps.logger.debug({ compacted }, `${LOG_PREFIX} swept`);
      }
    } catch (error) {
      this.deps.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        `${LOG_PREFIX} sweep failed; will retry on next tick`,
      );
    }
  }
}
