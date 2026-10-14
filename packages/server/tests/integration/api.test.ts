import { API_BASE_PATH, IDEMPOTENCY_KEY_HEADER, REQUEST_ID_HEADER } from '@inventory/shared';
import request, { type Test } from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  authHeaderFor,
  createTestContainer,
  type TestContainer,
} from '../helpers/testContainer.js';

const SINGLE = 'flash-sale-single';
const TEN = 'flash-sale-ten';
const SOLD_OUT = 'sold-out';
const HOLD_MS = 120_000;

let container: TestContainer;
let auth: { Authorization: string };

beforeEach(() => {
  container = createTestContainer();
  auth = authHeaderFor(container);
});

const reserve = (productId: string, quantity = 1, headers = auth): Test =>
  request(container.app)
    .post(`${API_BASE_PATH}/reservations`)
    .set(headers)
    .send({ productId, quantity });

describe('GET /health', () => {
  it('reports liveness without exposing internals', async () => {
    const response = await request(container.app).get(`${API_BASE_PATH}/health`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok' });
    expect(Object.keys(response.body as object).sort()).toEqual([
      'status',
      'uptimeSeconds',
      'version',
    ]);
  });
});

describe('POST /sessions', () => {
  it('issues a usable bearer token', async () => {
    const response = await request(container.app).post(`${API_BASE_PATH}/sessions`);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ userId: expect.stringMatching(/^user_/u) as unknown });

    const reserved = await reserve(SINGLE, 1, {
      Authorization: `Bearer ${(response.body as { token: string }).token}`,
    });
    expect(reserved.status).toBe(201);
  });
});

describe('GET /products', () => {
  it('lists the catalogue with derived availability', async () => {
    const response = await request(container.app).get(`${API_BASE_PATH}/products`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      products: expect.arrayContaining([
        {
          productId: SINGLE,
          name: expect.any(String) as unknown,
          totalStock: 1,
          confirmedSales: 0,
          activeReservations: 0,
          available: 1,
        },
      ]) as unknown,
    });
  });

  it('reflects a hold immediately', async () => {
    await reserve(SINGLE);
    const response = await request(container.app).get(`${API_BASE_PATH}/products/${SINGLE}`);

    expect(response.body).toMatchObject({
      product: { activeReservations: 1, available: 0 },
    });
  });

  it('404s an unknown product', async () => {
    const response = await request(container.app).get(`${API_BASE_PATH}/products/does-not-exist`);

    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
  });

  it('rejects a product id outside the allowed character set', async () => {
    const response = await request(container.app).get(
      `${API_BASE_PATH}/products/${encodeURIComponent('../../etc/passwd')}`,
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('POST /reservations — authentication', () => {
  it('401s with no token', async () => {
    const response = await request(container.app)
      .post(`${API_BASE_PATH}/reservations`)
      .send({ productId: SINGLE, quantity: 1 });

    expect(response.status).toBe(401);
    expect(response.body.error).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('401s with a forged token', async () => {
    const response = await reserve(SINGLE, 1, { Authorization: 'Bearer v1.forged.signature' });

    expect(response.status).toBe(401);
  });

  it('401s when the scheme is not Bearer', async () => {
    const response = await reserve(SINGLE, 1, { Authorization: 'Basic abc123' });

    expect(response.status).toBe(401);
  });
});

describe('POST /reservations — validation', () => {
  it('rejects a missing product', async () => {
    const response = await request(container.app)
      .post(`${API_BASE_PATH}/reservations`)
      .set(auth)
      .send({ quantity: 1 });

    expect(response.status).toBe(400);
    expect(response.body.error.details).toContainEqual(
      expect.objectContaining({ path: 'productId' }),
    );
  });

  it('rejects a non-positive or fractional quantity', async () => {
    for (const quantity of [0, -1, 1.5]) {
      const response = await reserve(TEN, quantity);
      expect(response.status).toBe(400);
    }
  });

  it('rejects a quantity beyond the per-request cap', async () => {
    expect((await reserve(TEN, 999)).status).toBe(400);
  });

  it('rejects unknown fields instead of silently ignoring them', async () => {
    const response = await request(container.app)
      .post(`${API_BASE_PATH}/reservations`)
      .set(auth)
      .send({ productId: TEN, quantity: 1, userId: 'someone-else', totalStock: 9_999 });

    expect(response.status).toBe(400);
  });

  it('rejects malformed JSON as a client error, not a crash', async () => {
    const response = await request(container.app)
      .post(`${API_BASE_PATH}/reservations`)
      .set(auth)
      .set('Content-Type', 'application/json')
      .send('{"productId":');

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects an oversized body before it reaches a route', async () => {
    const response = await request(container.app)
      .post(`${API_BASE_PATH}/reservations`)
      .set(auth)
      .send({ productId: TEN, quantity: 1, padding: 'x'.repeat(10_000) });

    expect(response.status).toBe(413);
    expect(response.body.error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });
});

describe('POST /reservations — business rules', () => {
  it('reserves the last unit and reports the new position', async () => {
    const response = await reserve(SINGLE);

    expect(response.status).toBe(201);
    expect(response.body.reservation).toMatchObject({ status: 'ACTIVE', quantity: 1 });
    expect(response.body.product).toMatchObject({ available: 0, activeReservations: 1 });
  });

  it('refuses the second buyer of a single unit', async () => {
    await reserve(SINGLE);
    const response = await reserve(SINGLE, 1, authHeaderFor(container));

    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({ code: 'INSUFFICIENT_STOCK' });
  });

  it('refuses a sold-out product', async () => {
    const response = await reserve(SOLD_OUT);

    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/sold out/iu);
  });
});

describe('Reservation lifecycle over HTTP', () => {
  const createReservation = async (): Promise<string> => {
    const response = await reserve(TEN);
    return (response.body as { reservation: { reservationId: string } }).reservation.reservationId;
  };

  it('confirms a hold into a sale', async () => {
    const id = await createReservation();

    const response = await request(container.app)
      .post(`${API_BASE_PATH}/reservations/${id}/confirm`)
      .set(auth);

    expect(response.status).toBe(200);
    expect(response.body.reservation.status).toBe('CONFIRMED');
    expect(response.body.product).toMatchObject({ confirmedSales: 1, activeReservations: 0 });
  });

  it('never reverses a confirmed purchase', async () => {
    const id = await createReservation();
    await request(container.app).post(`${API_BASE_PATH}/reservations/${id}/confirm`).set(auth);

    const response = await request(container.app)
      .post(`${API_BASE_PATH}/reservations/${id}/cancel`)
      .set(auth);

    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({ code: 'RESERVATION_NOT_ACTIVE' });
  });

  it('releases stock on cancel', async () => {
    const id = await createReservation();

    const response = await request(container.app)
      .post(`${API_BASE_PATH}/reservations/${id}/cancel`)
      .set(auth);

    expect(response.status).toBe(200);
    expect(response.body.product).toMatchObject({ available: 10, activeReservations: 0 });
  });

  it('expires the hold after the configured window and releases the stock', async () => {
    const id = await createReservation();
    container.clock.advanceBy(HOLD_MS);

    const read = await request(container.app).get(`${API_BASE_PATH}/reservations/${id}`).set(auth);
    expect(read.body.reservation.status).toBe('EXPIRED');
    expect(read.body.product.available).toBe(10);

    const confirm = await request(container.app)
      .post(`${API_BASE_PATH}/reservations/${id}/confirm`)
      .set(auth);
    expect(confirm.status).toBe(409);
    expect(confirm.body.error.message).toMatch(/expired/iu);
  });

  it('lists only the caller’s reservations', async () => {
    await createReservation();
    const stranger = authHeaderFor(container);
    await reserve(TEN, 1, stranger);

    const mine = await request(container.app).get(`${API_BASE_PATH}/reservations`).set(auth);
    const theirs = await request(container.app).get(`${API_BASE_PATH}/reservations`).set(stranger);

    expect(mine.body.reservations).toHaveLength(1);
    expect(theirs.body.reservations).toHaveLength(1);
    expect(mine.body.reservations[0].reservationId).not.toBe(
      theirs.body.reservations[0].reservationId,
    );
  });

  it('hides another buyer’s reservation behind a 404', async () => {
    const id = await createReservation();
    const stranger = authHeaderFor(container);

    const read = await request(container.app)
      .get(`${API_BASE_PATH}/reservations/${id}`)
      .set(stranger);
    const confirm = await request(container.app)
      .post(`${API_BASE_PATH}/reservations/${id}/confirm`)
      .set(stranger);

    expect(read.status).toBe(404);
    expect(confirm.status).toBe(404);
    // The response must not reveal that the reservation exists.
    expect(JSON.stringify(read.body)).not.toMatch(/ownership|forbidden/iu);
  });
});

describe('Idempotency', () => {
  it('returns the original reservation when a retry carries the same key', async () => {
    const key = 'checkout-attempt-0001';

    const first = await request(container.app)
      .post(`${API_BASE_PATH}/reservations`)
      .set(auth)
      .set(IDEMPOTENCY_KEY_HEADER, key)
      .send({ productId: TEN, quantity: 1 });

    const retry = await request(container.app)
      .post(`${API_BASE_PATH}/reservations`)
      .set(auth)
      .set(IDEMPOTENCY_KEY_HEADER, key)
      .send({ productId: TEN, quantity: 1 });

    expect(retry.status).toBe(201);
    expect(retry.body.reservation.reservationId).toBe(first.body.reservation.reservationId);

    const product = await request(container.app).get(`${API_BASE_PATH}/products/${TEN}`);
    expect(product.body.product.activeReservations).toBe(1);
  });

  it('409s when the same key is replayed with a different body', async () => {
    const key = 'checkout-attempt-0001';
    await request(container.app)
      .post(`${API_BASE_PATH}/reservations`)
      .set(auth)
      .set(IDEMPOTENCY_KEY_HEADER, key)
      .send({ productId: TEN, quantity: 1 });

    const response = await request(container.app)
      .post(`${API_BASE_PATH}/reservations`)
      .set(auth)
      .set(IDEMPOTENCY_KEY_HEADER, key)
      .send({ productId: TEN, quantity: 2 });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
  });

  it('rejects an idempotency key that is too short or too long to be meaningful', async () => {
    for (const key of ['tiny', 'x'.repeat(200)]) {
      const response = await request(container.app)
        .post(`${API_BASE_PATH}/reservations`)
        .set(auth)
        .set(IDEMPOTENCY_KEY_HEADER, key)
        .send({ productId: TEN, quantity: 1 });

      expect(response.status).toBe(400);
    }
  });
});

describe('Error and response hygiene', () => {
  it('attaches a correlation id to every response and error body', async () => {
    const response = await reserve(SOLD_OUT);

    expect(response.headers[REQUEST_ID_HEADER]).toBeDefined();
    expect(response.body.requestId).toBe(response.headers[REQUEST_ID_HEADER]);
  });

  it('ignores a client-supplied request id rather than trusting it', async () => {
    const response = await request(container.app)
      .get(`${API_BASE_PATH}/health`)
      .set(REQUEST_ID_HEADER, 'attacker-chosen-id');

    expect(response.headers[REQUEST_ID_HEADER]).not.toBe('attacker-chosen-id');
  });

  it('never leaks a stack trace or internal detail', async () => {
    const response = await reserve(SOLD_OUT);

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toMatch(/at \w+ \(/u);
    expect(serialised).not.toMatch(/node_modules|\/src\//u);
  });

  it('does not advertise the framework', async () => {
    const response = await request(container.app).get(`${API_BASE_PATH}/health`);

    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('sets hardening headers', async () => {
    const response = await request(container.app).get(`${API_BASE_PATH}/health`);

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBeDefined();
  });

  it('answers an unknown route in the standard error shape', async () => {
    const response = await request(container.app).get(`${API_BASE_PATH}/nope`);

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: expect.any(String) as unknown } });
  });

  it('does not reflect an untrusted CORS origin', async () => {
    const response = await request(container.app)
      .get(`${API_BASE_PATH}/health`)
      .set('Origin', 'https://evil.example');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows the configured origin', async () => {
    const allowed = createTestContainer({
      env: { CORS_ALLOWED_ORIGINS: 'https://shop.example' },
    });
    const response = await request(allowed.app)
      .get(`${API_BASE_PATH}/health`)
      .set('Origin', 'https://shop.example');

    expect(response.headers['access-control-allow-origin']).toBe('https://shop.example');
  });
});

describe('Rate limiting', () => {
  it('rejects a caller that exceeds its write budget', async () => {
    const limited = createTestContainer({ env: { RATE_LIMIT_WRITE_MAX: '3' } });
    const header = authHeaderFor(limited);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(limited.app)
        .post(`${API_BASE_PATH}/reservations`)
        .set(header)
        .send({ productId: TEN, quantity: 1 });
      statuses.push(response.status);
    }

    expect(statuses.at(-1)).toBe(429);
  });
});
