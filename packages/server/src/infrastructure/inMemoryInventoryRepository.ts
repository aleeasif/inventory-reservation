import type { InventoryRepository } from '../application/ports.js';
import type { ProductId, ReservationId } from '../domain/ids.js';
import type { Inventory } from '../domain/inventory.js';

/**
 * In-memory store for the challenge, written as if it were a real database.
 *
 * Every method is async on purpose. A synchronous store would hide the very bug
 * this system exists to prevent: it is the `await` between "read availability"
 * and "write reservation" that creates the race, and a fake that never yields
 * would let incorrect code pass its tests. Swapping this for Postgres must not
 * change a single line above the repository interface.
 */
export class InMemoryInventoryRepository implements InventoryRepository {
  private readonly inventories = new Map<ProductId, Inventory>();

  /** Secondary index: a reservation id resolves to the aggregate that owns it. */
  private readonly reservationIndex = new Map<ReservationId, ProductId>();

  constructor(seed: readonly Inventory[] = []) {
    for (const inventory of seed) {
      this.inventories.set(inventory.productId, inventory);
    }
  }

  async findById(productId: ProductId): Promise<Inventory | undefined> {
    await yieldToEventLoop();
    return this.inventories.get(productId);
  }

  async listAll(): Promise<readonly Inventory[]> {
    await yieldToEventLoop();
    return [...this.inventories.values()];
  }

  async locateProduct(reservationId: ReservationId): Promise<ProductId | undefined> {
    await yieldToEventLoop();
    return this.reservationIndex.get(reservationId);
  }

  async save(inventory: Inventory): Promise<void> {
    await yieldToEventLoop();
    this.inventories.set(inventory.productId, inventory);
    this.reindex(inventory);
  }

  /**
   * Keeps the reservation index in step with the aggregate, including removing
   * entries the aggregate has compacted away.
   */
  private reindex(inventory: Inventory): void {
    for (const [reservationId, productId] of this.reservationIndex) {
      if (productId === inventory.productId && !inventory.reservations.has(reservationId)) {
        this.reservationIndex.delete(reservationId);
      }
    }
    for (const reservationId of inventory.reservations.keys()) {
      this.reservationIndex.set(reservationId, inventory.productId);
    }
  }
}

/**
 * Models the unavoidable asynchrony of any real datastore. A microtask is
 * enough: it is exactly the suspension point at which another request can run.
 */
const yieldToEventLoop = (): Promise<void> => Promise.resolve();
