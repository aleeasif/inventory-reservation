import type { Request } from 'express';
import { UnauthenticatedError } from '../domain/errors.js';
import type { UserId } from '../domain/ids.js';

/**
 * Per-request state attached by middleware.
 *
 * Declared through module augmentation so handlers read `req.context.userId`
 * with full type safety instead of casting an untyped bag of properties.
 */
export interface RequestContext {
  readonly requestId: string;
  userId?: UserId;
}

declare module 'express-serve-static-core' {
  interface Request {
    context: RequestContext;
  }
}

/**
 * Returns the authenticated user, or fails loudly. A handler can never silently
 * operate on an undefined user because there is no other way to read it.
 */
export const requireUserId = (request: Request): UserId => {
  const userId = request.context.userId;
  if (userId === undefined) {
    throw new UnauthenticatedError();
  }
  return userId;
};

export const requestIdOf = (request: Request): string => request.context.requestId;
