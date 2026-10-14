import { Inventory } from '../domain/inventory.js';
import { toProductId } from '../domain/ids.js';

export interface CatalogItem {
  readonly productId: string;
  readonly name: string;
  readonly totalStock: number;
}

/**
 * The flash-sale catalogue the demo starts with.
 *
 * `flash-sale-single` exists to make the headline scenario reproducible by
 * hand: one unit, every buyer in the world clicking at once, exactly one winner.
 */
export const DEFAULT_CATALOG: readonly CatalogItem[] = [
  { productId: 'flash-sale-single', name: 'Limited Edition Sneaker (1 left)', totalStock: 1 },
  { productId: 'flash-sale-ten', name: 'Mechanical Keyboard (10 left)', totalStock: 10 },
  { productId: 'flash-sale-fifty', name: 'Wireless Earbuds (50 left)', totalStock: 50 },
  { productId: 'sold-out', name: 'Collector Vinyl (sold out)', totalStock: 0 },
];

export const buildCatalog = (items: readonly CatalogItem[] = DEFAULT_CATALOG): Inventory[] =>
  items.map((item) =>
    Inventory.create({
      productId: toProductId(item.productId),
      name: item.name,
      totalStock: item.totalStock,
    }),
  );
