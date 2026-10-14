import { API_BASE_PATH } from '@inventory/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestContainer, type TestContainer } from '../helpers/testContainer.js';

const SIMULTANEOUS_BUYERS = 500;

interface Tally {
  readonly created: number;
  readonly soldOut: number;
  readonly unexpected: readonly number[];
}

/**
 * Fires every request through the full HTTP stack — middleware, auth, routes,
 * service, lock, repository — rather than calling the service directly, so the
 * guarantee is proved end to end and not just in the layer that is easy to test.
 */
const stampede = async (container: TestContainer, productId: string): Promise<Tally> => {
  // A distinct signed session per buyer, so the per-user write budget
  // plays no part in the result.
  const buyers = Array.from(
    { length: SIMULTANEOUS_BUYERS },
    () => `Bearer ${container.tokens.issue().token}`,
  );

  const responses = await Promise.all(
    buyers.map((authorization) =>
      request(container.app)
        .post(`${API_BASE_PATH}/reservations`)
        .set('Authorization', authorization)
        .send({ productId, quantity: 1 }),
    ),
  );

  const unexpected: number[] = [];
  let created = 0;
  let soldOut = 0;

  for (const response of responses) {
    if (response.status === 201) {
      created += 1;
    } else if (
      response.status === 409 &&
      (response.body as { error: { code: string } }).error.code === 'INSUFFICIENT_STOCK'
    ) {
      soldOut += 1;
    } else {
      unexpected.push(response.status);
    }
  }

  return { created, soldOut, unexpected };
};

interface Availability {
  readonly available: number;
  readonly activeReservations: number;
}

const availabilityOf = async (
  container: TestContainer,
  productId: string,
): Promise<Availability> => {
  const response = await request(container.app).get(`${API_BASE_PATH}/products/${productId}`);
  return (response.body as { product: Availability }).product;
};

describe('Flash sale — 500 simultaneous buyers over HTTP', () => {
  it('gives the single unit to exactly one buyer and tells the other 499 it is gone', async () => {
    const container = createTestContainer({
      catalog: [{ productId: 'drop', name: 'One Unit', totalStock: 1 }],
    });

    const tally = await stampede(container, 'drop');

    expect(tally.unexpected).toEqual([]);
    expect(tally.created).toBe(1);
    expect(tally.soldOut).toBe(SIMULTANEOUS_BUYERS - 1);
    expect(await availabilityOf(container, 'drop')).toMatchObject({
      available: 0,
      activeReservations: 1,
    });
  });

  it('sells exactly the stock on hand when there is more than one unit', async () => {
    const totalStock = 25;
    const container = createTestContainer({
      catalog: [{ productId: 'drop', name: 'Limited Run', totalStock }],
    });

    const tally = await stampede(container, 'drop');

    expect(tally.unexpected).toEqual([]);
    expect(tally.created).toBe(totalStock);
    expect(tally.soldOut).toBe(SIMULTANEOUS_BUYERS - totalStock);
    expect(await availabilityOf(container, 'drop')).toMatchObject({ available: 0 });
  });

  it('re-opens the sale to a new wave once the first wave’s holds expire', async () => {
    const container = createTestContainer({
      catalog: [{ productId: 'drop', name: 'One Unit', totalStock: 1 }],
    });

    const first = await stampede(container, 'drop');
    expect(first.created).toBe(1);

    container.clock.advanceBy(container.config.RESERVATION_HOLD_MS);

    const second = await stampede(container, 'drop');
    expect(second.created).toBe(1);
    expect(second.soldOut).toBe(SIMULTANEOUS_BUYERS - 1);
  });
});
