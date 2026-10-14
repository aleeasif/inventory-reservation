import { useState, type JSX } from 'react';
import type { ProductAvailability } from '@inventory/shared';
import { ApiClient, ApiClientError } from '../api/client';

interface ConcurrencyLabProps {
  readonly products: readonly ProductAvailability[];
  readonly onComplete: () => void;
}

interface LabResult {
  readonly buyers: number;
  readonly productId: string;
  readonly succeeded: number;
  readonly outcomes: ReadonlyMap<string, number>;
  readonly elapsedMs: number;
}

const BUYER_OPTIONS = [50, 100, 500] as const;
const client = new ApiClient();

/**
 * The challenge scenario, runnable from the browser: N buyers, one click, one
 * winner.
 *
 * Each simulated buyer gets its own signed session, exactly as 500 real people
 * would, so neither the per-user hold cap nor the per-user rate budget can be
 * mistaken for the thing preventing the oversell. What prevents it is the lock
 * on the server.
 */
export const ConcurrencyLab = ({ products, onComplete }: ConcurrencyLabProps): JSX.Element => {
  const [chosenProductId, setChosenProductId] = useState('');
  const [buyers, setBuyers] = useState<number>(500);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<LabResult>();
  const [error, setError] = useState<string>();

  // The catalogue arrives after the first render, so the selection is derived
  // rather than seeded: no effect, and never a stale id pointing at nothing.
  const productId = products.some((candidate) => candidate.productId === chosenProductId)
    ? chosenProductId
    : (products[0]?.productId ?? '');

  const run = async (): Promise<void> => {
    setIsRunning(true);
    setError(undefined);
    setResult(undefined);

    try {
      const sessions = await Promise.all(
        Array.from({ length: buyers }, () => client.createSession()),
      );

      const startedAt = performance.now();
      const settled = await Promise.all(
        sessions.map((session) =>
          client
            .reserve({ token: session.token, productId, quantity: 1 })
            .then(() => 'RESERVED')
            .catch((cause: unknown) =>
              cause instanceof ApiClientError ? cause.code : 'INTERNAL_ERROR',
            ),
        ),
      );
      const elapsedMs = performance.now() - startedAt;

      const outcomes = new Map<string, number>();
      for (const outcome of settled) {
        outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
      }

      setResult({
        buyers,
        productId,
        succeeded: outcomes.get('RESERVED') ?? 0,
        outcomes,
        elapsedMs,
      });
    } catch (cause) {
      setError(
        cause instanceof ApiClientError
          ? `${cause.code}: ${cause.message}`
          : 'The simulation could not be started.',
      );
    } finally {
      setIsRunning(false);
      onComplete();
    }
  };

  const product = products.find((candidate) => candidate.productId === productId);

  return (
    <section className="panel">
      <header className="panel__header">
        <h2 className="panel__title">Concurrency lab</h2>
        <p className="panel__subtitle">
          Fire simultaneous buyers at one product and watch the inventory hold the line.
        </p>
      </header>

      <div className="lab__controls">
        <label className="field">
          <span className="field__label">Product</span>
          <select
            className="field__input"
            value={productId}
            disabled={isRunning}
            onChange={(event) => {
              setChosenProductId(event.target.value);
            }}
          >
            {products.map((candidate) => (
              <option key={candidate.productId} value={candidate.productId}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">Simultaneous buyers</span>
          <select
            className="field__input"
            value={buyers}
            disabled={isRunning}
            onChange={(event) => {
              setBuyers(Number.parseInt(event.target.value, 10));
            }}
          >
            {BUYER_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="button button--primary"
          disabled={isRunning || productId === ''}
          onClick={() => {
            void run();
          }}
        >
          {isRunning ? 'Running…' : 'Run simulation'}
        </button>
      </div>

      {error === undefined ? null : (
        <p className="lab__error" role="alert">
          {error}
          <span className="lab__hint">
            Rate limits are on by default. Start the API with <code>npm run dev:server:demo</code>{' '}
            to run large simulations.
          </span>
        </p>
      )}

      {result === undefined ? null : (
        <div className="lab__result">
          <p className="lab__headline">
            <strong>{result.succeeded}</strong> of <strong>{result.buyers}</strong> buyers reserved{' '}
            {result.productId}
            {product === undefined ? '' : ` (stock ${String(product.totalStock)})`} in{' '}
            {result.elapsedMs.toFixed(0)} ms.
          </p>
          <table className="lab__table">
            <thead>
              <tr>
                <th scope="col">Outcome</th>
                <th scope="col">Count</th>
              </tr>
            </thead>
            <tbody>
              {[...result.outcomes].sort().map(([outcome, count]) => (
                <tr key={outcome}>
                  <td>
                    <code>{outcome}</code>
                  </td>
                  <td>{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
