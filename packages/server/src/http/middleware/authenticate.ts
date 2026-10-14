import type { NextFunction, Request, Response } from 'express';
import { UnauthenticatedError } from '../../domain/errors.js';
import type { SessionTokenService } from '../../infrastructure/sessionTokenService.js';

const BEARER_PREFIX = 'Bearer ';

/**
 * Authentication only: it establishes *who* is calling and nothing more.
 * Deciding what that user may do is the domain's job (see
 * `Inventory.requireReservationOwnedBy`), so a future caller that bypasses this
 * route still cannot touch another user's reservation.
 */
export const authenticate =
  (tokens: SessionTokenService) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.get('authorization');

    if (header?.startsWith(BEARER_PREFIX) !== true) {
      next(new UnauthenticatedError('Provide a bearer session token.'));
      return;
    }

    try {
      req.context.userId = tokens.verify(header.slice(BEARER_PREFIX.length).trim());
      next();
    } catch (error) {
      next(error);
    }
  };
