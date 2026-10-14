import type { ApiError } from '@inventory/shared';
import type { Request, Response } from 'express';
import { requestIdOf } from '../context.js';

/** Unknown routes answer in the same error shape as everything else. */
export const notFound = (req: Request, res: Response): void => {
  const body: ApiError = {
    error: { code: 'VALIDATION_FAILED', message: `No route for ${req.method} ${req.path}.` },
    requestId: requestIdOf(req),
  };
  res.status(404).json(body);
};
