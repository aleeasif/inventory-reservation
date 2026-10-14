import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { formatCountdown, remainingFraction } from '../src/format';

interface FakeApiState {
  available: number;
  reservations: unknown[];
  reserveStatus: number;
}

/**
 * A fake API rather than a mocked component tree: the test exercises the real
 * hooks, the real client and the real contract parsing, and only the network is
 * replaced.
 */
const installFakeApi = (overrides: Partial<FakeApiState> = {}): FakeApiState => {
  const state: FakeApiState = { available: 1, reservations: [], reserveStatus: 201, ...overrides };

  const product = (): Record<string, unknown> => ({
    productId: 'flash-sale-single',
    name: 'Limited Edition Sneaker',
    totalStock: 1,
    confirmedSales: 0,
    activeReservations: 1 - state.available,
    available: state.available,
  });

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = input;
      const method = init?.method ?? 'GET';

      if (url.endsWith('/sessions')) {
        return Promise.resolve(
          json(201, {
            userId: 'user_test-buyer',
            token: 'token-abc',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        );
      }
      if (url.endsWith('/products')) {
        return Promise.resolve(json(200, { products: [product()] }));
      }
      if (url.endsWith('/reservations') && method === 'GET') {
        return Promise.resolve(json(200, { reservations: state.reservations }));
      }
      if (url.endsWith('/reservations') && method === 'POST') {
        if (state.reserveStatus !== 201) {
          return Promise.resolve(
            json(state.reserveStatus, {
              error: { code: 'INSUFFICIENT_STOCK', message: 'This item is sold out.' },
              requestId: 'req-test',
            }),
          );
        }
        const reservation = {
          reservationId: 'res-1',
          productId: 'flash-sale-single',
          userId: 'user_test-buyer',
          quantity: 1,
          status: 'ACTIVE',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
        };
        state.available = 0;
        state.reservations = [reservation];
        return Promise.resolve(json(201, { reservation, product: product() }));
      }
      return Promise.resolve(
        json(404, { error: { code: 'VALIDATION_FAILED', message: 'no' }, requestId: 'r' }),
      );
    }),
  );

  return state;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('opens a session and renders the catalogue', async () => {
    installFakeApi();
    render(<App />);

    expect(
      await screen.findByRole('heading', { name: 'Limited Edition Sneaker' }),
    ).toBeInTheDocument();
    expect(await screen.findByTitle('user_test-buyer')).toBeInTheDocument();
  });

  it('places a hold and shows it with a countdown', async () => {
    installFakeApi();
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Reserve' }));

    expect(await screen.findByText('ACTIVE')).toBeInTheDocument();
    expect(await screen.findByText(/^[0-2]:\d{2}$/u)).toBeInTheDocument();
  });

  it('shows the API error code when the item is gone', async () => {
    installFakeApi({ reserveStatus: 409 });
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Reserve' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('INSUFFICIENT_STOCK');
    });
    expect(screen.getByRole('alert')).toHaveTextContent('This item is sold out.');
  });

  it('enables the concurrency lab once the catalogue has loaded', async () => {
    installFakeApi();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
    });
  });

  it('disables the button for a sold-out product', async () => {
    installFakeApi({ available: 0 });
    render(<App />);

    expect(await screen.findByRole('button', { name: 'Sold out' })).toBeDisabled();
  });
});

describe('countdown formatting', () => {
  const createdAt = '2026-01-01T00:00:00.000Z';
  const expiresAt = '2026-01-01T00:02:00.000Z';
  const at = (offsetMs: number): number => new Date(createdAt).getTime() + offsetMs;

  it('counts down in mm:ss', () => {
    expect(formatCountdown(expiresAt, at(0))).toBe('2:00');
    expect(formatCountdown(expiresAt, at(61_000))).toBe('0:59');
    expect(formatCountdown(expiresAt, at(119_000))).toBe('0:01');
  });

  it('never shows a negative countdown once the hold has lapsed', () => {
    expect(formatCountdown(expiresAt, at(500_000))).toBe('0:00');
  });

  it('reports the remaining fraction of the hold, clamped to [0, 1]', () => {
    expect(remainingFraction(createdAt, expiresAt, at(0))).toBe(1);
    expect(remainingFraction(createdAt, expiresAt, at(60_000))).toBe(0.5);
    expect(remainingFraction(createdAt, expiresAt, at(999_000))).toBe(0);
  });
});
