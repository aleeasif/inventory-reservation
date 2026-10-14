import { useEffect, useState } from 'react';

/**
 * A ticking clock for countdowns.
 *
 * One interval shared by every consumer of the hook instance beats a timer per
 * reservation card, and re-rendering on a fixed tick keeps "expires in 1:59"
 * honest without the component having to know anything about expiry rules.
 */
export const useNow = (intervalMs = 1_000): number => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return (): void => {
      clearInterval(timer);
    };
  }, [intervalMs]);

  return now;
};
