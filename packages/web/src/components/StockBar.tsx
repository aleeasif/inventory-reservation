import type { JSX } from 'react';
import type { ProductAvailability } from '@inventory/shared';

interface StockBarProps {
  readonly product: ProductAvailability;
}

/**
 * Shows the availability formula as a picture:
 * `available = totalStock - confirmedSales - activeReservations`.
 */
export const StockBar = ({ product }: StockBarProps): JSX.Element => {
  const percent = (value: number): string =>
    product.totalStock === 0 ? '0%' : `${String((value / product.totalStock) * 100)}%`;

  return (
    <div className="stock">
      <div
        className="stock__bar"
        role="img"
        aria-label={`${String(product.available)} of ${String(product.totalStock)} available`}
      >
        <span
          className="stock__segment stock__segment--sold"
          style={{ width: percent(product.confirmedSales) }}
        />
        <span
          className="stock__segment stock__segment--held"
          style={{ width: percent(product.activeReservations) }}
        />
        <span
          className="stock__segment stock__segment--free"
          style={{ width: percent(product.available) }}
        />
      </div>
      <dl className="stock__legend">
        <div>
          <dt>Sold</dt>
          <dd>{product.confirmedSales}</dd>
        </div>
        <div>
          <dt>Held</dt>
          <dd>{product.activeReservations}</dd>
        </div>
        <div>
          <dt>Available</dt>
          <dd>{product.available}</dd>
        </div>
      </dl>
    </div>
  );
};
