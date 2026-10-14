import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';

/**
 * Validates the request body at the boundary and replaces it with the parsed
 * value, so nothing downstream ever sees raw input.
 *
 * Request schemas are `.strict()`: unknown fields are rejected rather than
 * ignored, which stops a client smuggling properties past the contract and into
 * an object spread.
 */
export const validateBody =
  <T>(schema: ZodType<T>): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(result.error);
      return;
    }
    req.body = result.data;
    next();
  };

/**
 * Reads and validates a single path parameter.
 *
 * Path segments are as untrusted as any body: they end up in lock keys, log
 * lines and store lookups, so they are parsed through the same shared schemas
 * the contract defines.
 */
export const readParam = <T>(req: Request, name: string, schema: ZodType<T>): T =>
  schema.parse(req.params[name]);
