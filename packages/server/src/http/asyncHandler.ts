import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Forwards rejected promises to the error middleware.
 *
 * Express 5 does this natively, but wrapping explicitly keeps the guarantee
 * visible at every route and independent of the framework version: no route can
 * fail silently with an unhandled rejection.
 */
export const asyncHandler =
  (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
