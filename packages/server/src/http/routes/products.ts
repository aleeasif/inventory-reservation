import { productIdSchema, type ProductListResponse, type ProductResponse } from '@inventory/shared';
import { Router } from 'express';
import type { ReservationService } from '../../application/reservationService.js';
import { toProductId } from '../../domain/ids.js';
import { asyncHandler } from '../asyncHandler.js';
import { readParam } from '../middleware/validate.js';

/**
 * Catalogue reads. Public, like any storefront, but still rate limited: the
 * availability counter is the thing a scraper would hammer during a drop.
 */
export const createProductRoutes = (service: ReservationService): Router => {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const products = await service.listProducts();
      const body: ProductListResponse = { products: [...products] };
      res.status(200).json(body);
    }),
  );

  router.get(
    '/:productId',
    asyncHandler(async (req, res) => {
      const product = await service.getProduct(
        toProductId(readParam(req, 'productId', productIdSchema)),
      );
      const body: ProductResponse = { product };
      res.status(200).json(body);
    }),
  );

  return router;
};
