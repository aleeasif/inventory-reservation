import { useState, type JSX } from 'react';
import { MAX_RESERVATION_QUANTITY, type ProductAvailability } from '@inventory/shared';
import { StockBar } from './StockBar';

interface ProductCardProps {
  readonly product: ProductAvailability;
  readonly disabled: boolean;
  readonly onReserve: (productId: string, quantity: number) => void;
}

export const ProductCard = ({ product, disabled, onReserve }: ProductCardProps): JSX.Element => {
  const [quantity, setQuantity] = useState(1);
  const isSoldOut = product.available === 0;
  const maxQuantity = Math.min(MAX_RESERVATION_QUANTITY, Math.max(1, product.available));

  return (
    <article className="card">
      <header className="card__header">
        <h3 className="card__title">{product.name}</h3>
        <code className="card__id">{product.productId}</code>
      </header>

      <StockBar product={product} />

      <div className="card__actions">
        <label className="field">
          <span className="field__label">Qty</span>
          <input
            className="field__input"
            type="number"
            min={1}
            max={maxQuantity}
            value={quantity}
            disabled={isSoldOut}
            onChange={(event) => {
              const next = Number.parseInt(event.target.value, 10);
              setQuantity(Number.isNaN(next) ? 1 : Math.min(maxQuantity, Math.max(1, next)));
            }}
          />
        </label>
        <button
          type="button"
          className="button button--primary"
          disabled={disabled || isSoldOut}
          onClick={() => {
            onReserve(product.productId, quantity);
          }}
        >
          {isSoldOut ? 'Sold out' : 'Reserve'}
        </button>
      </div>
    </article>
  );
};
