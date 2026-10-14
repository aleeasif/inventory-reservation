import {
  createReservationRequestSchema,
  IDEMPOTENCY_KEY_HEADER,
  reservationIdSchema,
  type CreateReservationRequest,
  type ReservationListResponse,
  type ReservationResponse,
} from '@inventory/shared';
import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import type { ReservationService } from '../../application/reservationService.js';
import { toProductId, toReservationId } from '../../domain/ids.js';
import { asyncHandler } from '../asyncHandler.js';
import { requireUserId } from '../context.js';
import { readParam, validateBody } from '../middleware/validate.js';

/** Bounded so a hostile key cannot bloat the idempotency store's memory. */
const idempotencyKeySchema = z.string().trim().min(8).max(128);

export interface ReservationRoutesOptions {
  readonly service: ReservationService;
  /** Tighter budget for state-changing calls. */
  readonly writeRateLimiter: RequestHandler;
}

/**
 * Entry point: parse, authenticate, delegate, respond. No business rule is
 * decided here — every one of them lives in the domain.
 */
export const createReservationRoutes = (options: ReservationRoutesOptions): Router => {
  const router = Router();
  const { service } = options;

  router.post(
    '/',
    options.writeRateLimiter,
    validateBody(createReservationRequestSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as CreateReservationRequest;
      const idempotencyKey = readIdempotencyKey(req);

      const result: ReservationResponse = await service.reserve({
        productId: toProductId(body.productId),
        userId: requireUserId(req),
        quantity: body.quantity,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      });

      res.status(201).json(result);
    }),
  );

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const reservations = await service.listReservations(requireUserId(req));
      const body: ReservationListResponse = { reservations: [...reservations] };
      res.status(200).json(body);
    }),
  );

  router.get(
    '/:reservationId',
    asyncHandler(async (req, res) => {
      const result = await service.getReservation({
        reservationId: toReservationId(readParam(req, 'reservationId', reservationIdSchema)),
        userId: requireUserId(req),
      });
      res.status(200).json(result);
    }),
  );

  router.post(
    '/:reservationId/confirm',
    options.writeRateLimiter,
    asyncHandler(async (req, res) => {
      const result = await service.confirm({
        reservationId: toReservationId(readParam(req, 'reservationId', reservationIdSchema)),
        userId: requireUserId(req),
      });
      res.status(200).json(result);
    }),
  );

  router.post(
    '/:reservationId/cancel',
    options.writeRateLimiter,
    asyncHandler(async (req, res) => {
      const result = await service.cancel({
        reservationId: toReservationId(readParam(req, 'reservationId', reservationIdSchema)),
        userId: requireUserId(req),
      });
      res.status(200).json(result);
    }),
  );

  return router;
};

const readIdempotencyKey = (req: Request): string | undefined => {
  const raw = req.get(IDEMPOTENCY_KEY_HEADER);
  return raw === undefined ? undefined : idempotencyKeySchema.parse(raw);
};
