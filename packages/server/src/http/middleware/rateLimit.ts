import type { ApiError } from '@inventory/shared';
import type { Request, Response } from 'express';
import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from 'express-rate-limit';
import { requestIdOf } from '../context.js';

export interface RateLimitOptions {
  readonly windowMs: number;
  readonly max: number;
}

/**
 * Rate limiting keyed by authenticated user where possible, falling back to IP.
 *
 * Keying on the user is what actually bounds a flash-sale abuser: one attacker
 * behind many addresses still gets one budget per session, and many genuine
 * buyers behind one corporate NAT are not punished for each other.
 *
 * Writes get a tighter budget than reads, because a reservation costs inventory
 * and a product listing costs a map lookup.
 */
export const createRateLimiter = (options: RateLimitOptions): RateLimitRequestHandler =>
  rateLimit({
    windowMs: options.windowMs,
    limit: options.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req: Request): string =>
      req.context.userId ?? ipKeyGenerator(req.ip ?? 'unknown'),
    handler: (req: Request, res: Response): void => {
      const body: ApiError = {
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down and retry.' },
        requestId: requestIdOf(req),
      };
      res.status(429).json(body);
    },
  });
