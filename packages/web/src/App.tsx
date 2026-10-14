import type { JSX } from 'react';
import { RESERVATION_HOLD_MS } from '@inventory/shared';
import { ConcurrencyLab } from './components/ConcurrencyLab';
import { ErrorBanner } from './components/ErrorBanner';
import { ProductCard } from './components/ProductCard';
import { ReservationCard } from './components/ReservationCard';
import { useNow } from './hooks/useNow';
import { useSession } from './hooks/useSession';
import { useStorefront } from './hooks/useStorefront';

const holdMinutes = Math.round(RESERVATION_HOLD_MS / 60_000);

export const App = (): JSX.Element => {
  const { session, error: sessionError, startNewSession } = useSession();
  const storefront = useStorefront(session?.token);
  const nowMs = useNow();

  const activeReservations = storefront.reservations.filter(
    (reservation) => reservation.status === 'ACTIVE',
  );
  const settledReservations = storefront.reservations.filter(
    (reservation) => reservation.status !== 'ACTIVE',
  );

  return (
    <div className="app">
      <header className="masthead">
        <div>
          <h1 className="masthead__title">Flash Sale</h1>
          <p className="masthead__subtitle">
            Reservations hold stock for {holdMinutes} minutes, then release it automatically.
          </p>
        </div>
        <div className="masthead__session">
          {session === undefined ? (
            <span className="pill pill--muted">{sessionError ?? 'Starting session…'}</span>
          ) : (
            <span className="pill" title={session.userId}>
              {session.userId.slice(0, 13)}…
            </span>
          )}
          <button type="button" className="button button--ghost" onClick={startNewSession}>
            New buyer
          </button>
        </div>
      </header>

      <ErrorBanner error={storefront.lastError} onDismiss={storefront.dismissError} />

      <main className="layout">
        <section className="panel">
          <header className="panel__header">
            <h2 className="panel__title">Catalogue</h2>
            <p className="panel__subtitle">
              available = total stock − confirmed sales − active reservations
            </p>
          </header>
          <div className="grid">
            {storefront.products.map((product) => (
              <ProductCard
                key={product.productId}
                product={product}
                disabled={session === undefined}
                onReserve={(productId, quantity) => {
                  void storefront.reserve(productId, quantity);
                }}
              />
            ))}
          </div>
          {storefront.isLoading && storefront.products.length === 0 ? (
            <p className="muted">Loading catalogue…</p>
          ) : null}
        </section>

        <section className="panel">
          <header className="panel__header">
            <h2 className="panel__title">Your reservations</h2>
            <p className="panel__subtitle">Confirm before the timer runs out, or lose the hold.</p>
          </header>

          {activeReservations.length === 0 ? (
            <p className="muted">No active holds.</p>
          ) : (
            activeReservations.map((reservation) => (
              <ReservationCard
                key={reservation.reservationId}
                reservation={reservation}
                nowMs={nowMs}
                onConfirm={(id) => {
                  void storefront.confirm(id);
                }}
                onCancel={(id) => {
                  void storefront.cancel(id);
                }}
              />
            ))
          )}

          {settledReservations.length === 0 ? null : (
            <details className="history">
              <summary>History ({settledReservations.length})</summary>
              {settledReservations.map((reservation) => (
                <ReservationCard
                  key={reservation.reservationId}
                  reservation={reservation}
                  nowMs={nowMs}
                  onConfirm={() => undefined}
                  onCancel={() => undefined}
                />
              ))}
            </details>
          )}
        </section>

        <ConcurrencyLab products={storefront.products} onComplete={storefront.refresh} />
      </main>

      <footer className="footer">
        <p>
          Stock is released the instant a hold lapses — the background sweeper only tidies up the
          records.
        </p>
      </footer>
    </div>
  );
};
