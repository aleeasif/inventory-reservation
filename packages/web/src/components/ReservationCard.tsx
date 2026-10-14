import type { JSX } from 'react';
import type { Reservation } from '@inventory/shared';
import { formatCountdown, remainingFraction } from '../format';

interface ReservationCardProps {
  readonly reservation: Reservation;
  readonly nowMs: number;
  readonly onConfirm: (reservationId: string) => void;
  readonly onCancel: (reservationId: string) => void;
}

export const ReservationCard = ({
  reservation,
  nowMs,
  onConfirm,
  onCancel,
}: ReservationCardProps): JSX.Element => {
  const isActive = reservation.status === 'ACTIVE';
  const remaining = remainingFraction(reservation.createdAt, reservation.expiresAt, nowMs);

  return (
    <article className={`reservation reservation--${reservation.status.toLowerCase()}`}>
      <div className="reservation__summary">
        <span className="pill">{reservation.status}</span>
        <span className="reservation__product">{reservation.productId}</span>
        <span className="reservation__quantity">x{reservation.quantity}</span>
        {isActive ? (
          <time className="reservation__timer" dateTime={reservation.expiresAt}>
            {formatCountdown(reservation.expiresAt, nowMs)}
          </time>
        ) : null}
      </div>

      {isActive ? (
        <div
          className="reservation__hold"
          role="img"
          aria-label={`Hold expires in ${formatCountdown(reservation.expiresAt, nowMs)}`}
        >
          <span
            className="reservation__hold-fill"
            style={{ width: `${String(remaining * 100)}%` }}
          />
        </div>
      ) : null}

      {isActive ? (
        <div className="reservation__actions">
          <button
            type="button"
            className="button button--primary"
            onClick={() => {
              onConfirm(reservation.reservationId);
            }}
          >
            Confirm purchase
          </button>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              onCancel(reservation.reservationId);
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}
    </article>
  );
};
