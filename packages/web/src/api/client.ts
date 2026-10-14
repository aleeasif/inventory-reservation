import {
  API_BASE_PATH,
  apiErrorSchema,
  createSessionResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  productListResponseSchema,
  reservationListResponseSchema,
  reservationResponseSchema,
  type CreateSessionResponse,
  type ErrorCode,
  type ProductAvailability,
  type Reservation,
  type ReservationResponse,
} from '@inventory/shared';

const BASE_URL = (import.meta.env['VITE_API_BASE_URL'] ?? 'http://localhost:4000') as string;

/**
 * A failure the API described in its own error contract. Carrying the `code`
 * lets the UI react to *what* went wrong (sold out vs rate limited) instead of
 * pattern-matching on prose.
 */
export class ApiClientError extends Error {
  constructor(
    readonly code: ErrorCode | 'NETWORK_ERROR',
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly token?: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

/**
 * The single place the browser talks to the API.
 *
 * Responses are parsed through the same schemas the server publishes, so a
 * contract change surfaces here as a type error rather than as `undefined`
 * halfway down a component tree.
 */
export class ApiClient {
  constructor(private readonly baseUrl: string = BASE_URL) {}

  async createSession(): Promise<CreateSessionResponse> {
    return this.send('/sessions', (value) => createSessionResponseSchema.parse(value), {
      method: 'POST',
    });
  }

  async listProducts(signal?: AbortSignal): Promise<readonly ProductAvailability[]> {
    const response = await this.send(
      '/products',
      (value) => productListResponseSchema.parse(value),
      {
        ...(signal ? { signal } : {}),
      },
    );
    return response.products;
  }

  async listReservations(token: string, signal?: AbortSignal): Promise<readonly Reservation[]> {
    const response = await this.send(
      '/reservations',
      (value) => reservationListResponseSchema.parse(value),
      {
        token,
        ...(signal ? { signal } : {}),
      },
    );
    return response.reservations;
  }

  async reserve(input: {
    token: string;
    productId: string;
    quantity: number;
    idempotencyKey?: string;
  }): Promise<ReservationResponse> {
    return this.send('/reservations', (value) => reservationResponseSchema.parse(value), {
      method: 'POST',
      token: input.token,
      body: { productId: input.productId, quantity: input.quantity },
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
  }

  async confirm(token: string, reservationId: string): Promise<ReservationResponse> {
    return this.send(
      `/reservations/${encodeURIComponent(reservationId)}/confirm`,
      (value) => reservationResponseSchema.parse(value),
      { method: 'POST', token },
    );
  }

  async cancel(token: string, reservationId: string): Promise<ReservationResponse> {
    return this.send(
      `/reservations/${encodeURIComponent(reservationId)}/cancel`,
      (value) => reservationResponseSchema.parse(value),
      { method: 'POST', token },
    );
  }

  private async send<T>(
    path: string,
    parse: (value: unknown) => T,
    options: RequestOptions = {},
  ): Promise<T> {
    const response = await this.fetchOrThrow(path, options);
    const payload: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      throw toApiError(payload, response.status);
    }
    return parse(payload);
  }

  private async fetchOrThrow(path: string, options: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (options.token !== undefined) {
      headers['Authorization'] = `Bearer ${options.token}`;
    }
    if (options.idempotencyKey !== undefined) {
      headers[IDEMPOTENCY_KEY_HEADER] = options.idempotencyKey;
    }

    try {
      return await fetch(`${this.baseUrl}${API_BASE_PATH}${path}`, {
        method: options.method ?? 'GET',
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      // A transport failure is not the same as a rejected request, and the UI
      // needs to tell a user "we could not reach the server" either way.
      throw new ApiClientError(
        'NETWORK_ERROR',
        error instanceof Error && error.name === 'AbortError'
          ? 'Request cancelled.'
          : 'Could not reach the reservation service.',
        0,
      );
    }
  }
}

const toApiError = (payload: unknown, status: number): ApiClientError => {
  const parsed = apiErrorSchema.safeParse(payload);
  if (parsed.success) {
    return new ApiClientError(
      parsed.data.error.code,
      parsed.data.error.message,
      status,
      parsed.data.requestId,
    );
  }
  return new ApiClientError(
    'INTERNAL_ERROR',
    `Unexpected response (HTTP ${String(status)}).`,
    status,
  );
};

export const apiClient = new ApiClient();
