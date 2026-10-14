import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiClientError } from '../src/api/client';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const stubFetch = (impl: (input: string, init?: RequestInit) => Promise<Response>): void => {
  vi.stubGlobal('fetch', vi.fn(impl));
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ApiClient', () => {
  it('parses a successful response through the shared contract', async () => {
    stubFetch(() =>
      Promise.resolve(
        jsonResponse(200, {
          products: [
            {
              productId: 'p1',
              name: 'Thing',
              totalStock: 3,
              confirmedSales: 1,
              activeReservations: 1,
              available: 1,
            },
          ],
        }),
      ),
    );

    const products = await new ApiClient('http://api.test').listProducts();

    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ productId: 'p1', available: 1 });
  });

  it('turns an API error body into a typed error the UI can branch on', async () => {
    stubFetch(() =>
      Promise.resolve(
        jsonResponse(409, {
          error: { code: 'INSUFFICIENT_STOCK', message: 'This item is sold out.' },
          requestId: 'req-1',
        }),
      ),
    );

    await expect(
      new ApiClient('http://api.test').reserve({ token: 't', productId: 'p1', quantity: 1 }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      status: 409,
      requestId: 'req-1',
    });
  });

  it('does not pretend an unparseable error body is a known failure', async () => {
    stubFetch(() => Promise.resolve(new Response('<html>502</html>', { status: 502 })));

    await expect(new ApiClient('http://api.test').listProducts()).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 502,
    });
  });

  it('reports a transport failure distinctly from a rejected request', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));

    const error = await new ApiClient('http://api.test')
      .listProducts()
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).code).toBe('NETWORK_ERROR');
  });

  it('sends the bearer token and idempotency key it was given', async () => {
    const calls: RequestInit[] = [];
    stubFetch((_input, init) => {
      calls.push(init ?? {});
      return Promise.resolve(
        jsonResponse(201, {
          reservation: {
            reservationId: 'r1',
            productId: 'p1',
            userId: 'u1',
            quantity: 1,
            status: 'ACTIVE',
            createdAt: new Date().toISOString(),
            expiresAt: new Date().toISOString(),
          },
          product: {
            productId: 'p1',
            name: 'Thing',
            totalStock: 1,
            confirmedSales: 0,
            activeReservations: 1,
            available: 0,
          },
        }),
      );
    });

    await new ApiClient('http://api.test').reserve({
      token: 'secret-token',
      productId: 'p1',
      quantity: 1,
      idempotencyKey: 'key-123456',
    });

    const headers = calls[0]?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-token');
    expect(headers['idempotency-key']).toBe('key-123456');
  });
});
