import { useCallback, useEffect, useState } from 'react';
import type { CreateSessionResponse } from '@inventory/shared';
import { apiClient } from '../api/client';

export interface SessionState {
  readonly session: CreateSessionResponse | undefined;
  readonly error: string | undefined;
  readonly startNewSession: () => void;
}

/**
 * Holds the signed session for this browser tab.
 *
 * The token lives in React state and nowhere else — not `localStorage`, not a
 * cookie. It therefore dies with the tab, which is the right trade for a
 * bearer token: anything persisted is reachable by any script that manages to
 * run on the page.
 */
export const useSession = (): SessionState => {
  const [session, setSession] = useState<CreateSessionResponse>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    apiClient
      .createSession()
      .then((created) => {
        if (!cancelled) {
          setSession(created);
          setError(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not start a session.');
        }
      });

    return (): void => {
      cancelled = true;
    };
  }, [attempt]);

  const startNewSession = useCallback(() => {
    setSession(undefined);
    setAttempt((previous) => previous + 1);
  }, []);

  return { session, error, startNewSession };
};
