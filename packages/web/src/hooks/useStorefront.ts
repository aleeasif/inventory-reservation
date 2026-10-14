import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProductAvailability, Reservation } from '@inventory/shared';
import { apiClient, ApiClientError } from '../api/client';

export interface StorefrontState {
  readonly products: readonly ProductAvailability[];
  readonly reservations: readonly Reservation[];
  readonly isLoading: boolean;
  readonly lastError: ApiClientError | undefined;
  readonly refresh: () => void;
  readonly reserve: (productId: string, quantity: number) => Promise<void>;
  readonly confirm: (reservationId: string) => Promise<void>;
  readonly cancel: (reservationId: string) => Promise<void>;
  readonly dismissError: () => void;
}

const POLL_INTERVAL_MS = 2_000;

/**
 * Everything the storefront needs from the API, in one place.
 *
 * Availability is polled rather than cached optimistically: during a flash sale
 * the number on screen is stale the moment it is drawn, and showing a stock
 * count the server would not honour is worse than showing it a second late.
 */
export const useStorefront = (token: string | undefined): StorefrontState => {
  const [products, setProducts] = useState<readonly ProductAvailability[]>([]);
  const [reservations, setReservations] = useState<readonly Reservation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [lastError, setLastError] = useState<ApiClientError>();
  const inFlight = useRef<AbortController>(undefined);

  const load = useCallback(async (): Promise<void> => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    try {
      const [nextProducts, nextReservations] = await Promise.all([
        apiClient.listProducts(controller.signal),
        token === undefined
          ? Promise.resolve<readonly Reservation[]>([])
          : apiClient.listReservations(token, controller.signal),
      ]);
      setProducts(nextProducts);
      setReservations(nextReservations);
    } catch (error) {
      // A cancelled poll is routine, not something to put in front of a user.
      if (error instanceof ApiClientError && error.message !== 'Request cancelled.') {
        setLastError(error);
      }
    } finally {
      setIsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);

    return (): void => {
      clearInterval(timer);
      inFlight.current?.abort();
    };
  }, [load]);

  const act = useCallback(
    async (action: () => Promise<unknown>): Promise<void> => {
      try {
        await action();
        setLastError(undefined);
      } catch (error) {
        setLastError(
          error instanceof ApiClientError
            ? error
            : new ApiClientError('INTERNAL_ERROR', 'Something went wrong.', 0),
        );
      } finally {
        await load();
      }
    },
    [load],
  );

  return {
    products,
    reservations,
    isLoading,
    lastError,
    refresh: (): void => {
      void load();
    },
    reserve: (productId, quantity) =>
      act(() => {
        if (token === undefined) {
          return Promise.reject(new ApiClientError('UNAUTHENTICATED', 'No session yet.', 401));
        }
        // A fresh key per click: a retried click is one purchase, two clicks are two.
        return apiClient.reserve({
          token,
          productId,
          quantity,
          idempotencyKey: crypto.randomUUID(),
        });
      }),
    confirm: (reservationId) =>
      act(() => {
        if (token === undefined) {
          return Promise.reject(new ApiClientError('UNAUTHENTICATED', 'No session yet.', 401));
        }
        return apiClient.confirm(token, reservationId);
      }),
    cancel: (reservationId) =>
      act(() => {
        if (token === undefined) {
          return Promise.reject(new ApiClientError('UNAUTHENTICATED', 'No session yet.', 401));
        }
        return apiClient.cancel(token, reservationId);
      }),
    dismissError: (): void => {
      setLastError(undefined);
    },
  };
};
