import type {
  ProductAvailability,
  Reservation as ReservationDto,
  ReservationResponse,
} from '@inventory/shared';
import {
  IdempotencyKeyConflictError,
  ProductNotFoundError,
  ReservationNotFoundError,
} from '../domain/errors.js';
import type { ProductId, ReservationId, UserId } from '../domain/ids.js';
import { toReservationId } from '../domain/ids.js';
import type { Inventory } from '../domain/inventory.js';
import { fingerprintReservationRequest } from './fingerprint.js';
import type {
  Clock,
  IdGenerator,
  IdempotencyStore,
  InventoryRepository,
  Lock,
  Logger,
} from './ports.js';
import { toProductDto, toReservationDto } from './transformers.js';

const LOG_PREFIX = '[Reservations]';

export interface ReservationServiceDependencies {
  readonly repository: InventoryRepository;
  readonly lock: Lock;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly idempotency: IdempotencyStore<ReservationResponse>;
  readonly logger: Logger;
  /** How long a new reservation holds stock. */
  readonly holdMs: number;
}

export interface ReserveCommand {
  readonly productId: ProductId;
  readonly userId: UserId;
  readonly quantity: number;
  /** Optional client-supplied key that makes a retry of this exact request safe. */
  readonly idempotencyKey?: string;
}

export interface ReservationActionCommand {
  readonly reservationId: ReservationId;
  readonly userId: UserId;
}

/**
 * One use case per method, orchestrating the domain.
 *
 * Every write follows the same shape:
 *
 *     lock(product) -> load aggregate -> pure domain transition -> save -> unlock
 *
 * The lock is what makes "check availability, then write" atomic. Without it the
 * `await` between load and save is a window in which another request reads the
 * same availability and sells the same unit twice. The test
 * `tests/concurrency/race-condition.test.ts` demonstrates precisely that window.
 */
export class ReservationService {
  constructor(private readonly deps: ReservationServiceDependencies) {}

  async listProducts(): Promise<readonly ProductAvailability[]> {
    const now = this.deps.clock.now();
    const inventories = await this.deps.repository.listAll();
    return inventories.map((inventory) => toProductDto(inventory.snapshot(now)));
  }

  async getProduct(productId: ProductId): Promise<ProductAvailability> {
    const inventory = await this.requireInventory(productId);
    return toProductDto(inventory.snapshot(this.deps.clock.now()));
  }

  async reserve(command: ReserveCommand): Promise<ReservationResponse> {
    const logger = this.deps.logger.child({
      productId: command.productId,
      userId: command.userId,
    });

    return this.deps.lock.withLock(lockKey(command.productId), async () => {
      const replay = await this.replayedReservation(command);
      if (replay !== undefined) {
        logger.info({ reservationId: replay.reservation.reservationId }, `${LOG_PREFIX} replayed`);
        return replay;
      }

      const now = this.deps.clock.now();
      const inventory = await this.requireInventory(command.productId);

      const { inventory: next, reservation } = inventory.reserve({
        reservationId: toReservationId(this.deps.ids.next()),
        userId: command.userId,
        quantity: command.quantity,
        now,
        holdMs: this.deps.holdMs,
      });
      await this.deps.repository.save(next);

      const response: ReservationResponse = {
        reservation: toReservationDto(reservation, now),
        product: toProductDto(next.snapshot(now)),
      };
      await this.rememberReservation(command, response);

      logger.info(
        {
          reservationId: reservation.reservationId,
          quantity: reservation.quantity,
          available: response.product.available,
        },
        `${LOG_PREFIX} reserved`,
      );
      return response;
    });
  }

  async confirm(command: ReservationActionCommand): Promise<ReservationResponse> {
    return this.applyReservationAction(command, 'confirm');
  }

  async cancel(command: ReservationActionCommand): Promise<ReservationResponse> {
    return this.applyReservationAction(command, 'cancel');
  }

  async getReservation(command: ReservationActionCommand): Promise<ReservationResponse> {
    const now = this.deps.clock.now();
    const inventory = await this.requireInventory(
      await this.requireProductOf(command.reservationId),
    );
    const reservation = inventory.requireReservationOwnedBy(command.reservationId, command.userId);

    return {
      reservation: toReservationDto(reservation, now),
      product: toProductDto(inventory.snapshot(now)),
    };
  }

  async listReservations(userId: UserId): Promise<readonly ReservationDto[]> {
    const now = this.deps.clock.now();
    const inventories = await this.deps.repository.listAll();

    return inventories
      .flatMap((inventory) => inventory.reservationsOf(userId))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map((reservation) => toReservationDto(reservation, now));
  }

  /**
   * `confirm` and `cancel` differ only in which pure transition they invoke, so
   * locking, persistence and logging are written once here.
   */
  private async applyReservationAction(
    command: ReservationActionCommand,
    action: 'confirm' | 'cancel',
  ): Promise<ReservationResponse> {
    const productId = await this.requireProductOf(command.reservationId);
    const logger = this.deps.logger.child({
      reservationId: command.reservationId,
      userId: command.userId,
      productId,
    });

    return this.deps.lock.withLock(lockKey(productId), async () => {
      const now = this.deps.clock.now();
      const inventory = await this.requireInventory(productId);

      const transition = inventory[action]({
        reservationId: command.reservationId,
        actorUserId: command.userId,
        now,
      });
      await this.deps.repository.save(transition.inventory);

      const response: ReservationResponse = {
        reservation: toReservationDto(transition.reservation, now),
        product: toProductDto(transition.inventory.snapshot(now)),
      };
      logger.info(
        { status: response.reservation.status, available: response.product.available },
        `${LOG_PREFIX} ${action} applied`,
      );
      return response;
    });
  }

  /**
   * Idempotency is resolved inside the product lock, so two simultaneous retries
   * of the same key cannot both miss the cache and both create a reservation.
   */
  private async replayedReservation(
    command: ReserveCommand,
  ): Promise<ReservationResponse | undefined> {
    if (command.idempotencyKey === undefined) {
      return undefined;
    }

    const stored = await this.deps.idempotency.get(
      idempotencyScope(command.userId, command.idempotencyKey),
    );
    if (stored === undefined) {
      return undefined;
    }
    if (stored.fingerprint !== fingerprintReservationRequest(command)) {
      throw new IdempotencyKeyConflictError();
    }
    return stored.value;
  }

  private async rememberReservation(
    command: ReserveCommand,
    response: ReservationResponse,
  ): Promise<void> {
    if (command.idempotencyKey === undefined) {
      return;
    }
    await this.deps.idempotency.set(idempotencyScope(command.userId, command.idempotencyKey), {
      fingerprint: fingerprintReservationRequest(command),
      value: response,
    });
  }

  private async requireInventory(productId: ProductId): Promise<Inventory> {
    const inventory = await this.deps.repository.findById(productId);
    if (inventory === undefined) {
      throw new ProductNotFoundError(productId);
    }
    return inventory;
  }

  private async requireProductOf(reservationId: ReservationId): Promise<ProductId> {
    const productId = await this.deps.repository.locateProduct(reservationId);
    if (productId === undefined) {
      throw new ReservationNotFoundError(reservationId);
    }
    return productId;
  }
}

/** Namespaced so a product lock can never collide with a lock of another kind. */
const lockKey = (productId: ProductId): string => `product:${productId}`;

/** Idempotency keys are scoped per user: one client can never replay another's key. */
const idempotencyScope = (userId: UserId, key: string): string => `${userId}:${key}`;
