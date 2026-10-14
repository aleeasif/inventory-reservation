import { randomUUID } from 'node:crypto';
import { REQUEST_ID_HEADER } from '@inventory/shared';
import type { NextFunction, Request, Response } from 'express';

/**
 * Gives every request a correlation id that appears on each log line and in the
 * error body, so a user-reported failure can be found in the logs immediately.
 *
 * The id is always generated server-side. Echoing a client-supplied value would
 * let a caller forge or collide with another request's identity in the logs.
 */
export const requestContext = (req: Request, res: Response, next: NextFunction): void => {
  const requestId = randomUUID();
  req.context = { requestId };
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
};
