import type { ApiError, ErrorCode } from '@inventory/shared';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import type { Logger } from '../../application/ports.js';
import { isDomainError } from '../../domain/errors.js';
import { requestIdOf } from '../context.js';

const LOG_PREFIX = '[Http]';

interface MappedError {
  readonly status: number;
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: ApiError['error']['details'];
  /** Written to the logs only. Never sent to the client. */
  readonly logContext: Readonly<Record<string, unknown>>;
}

/**
 * The single exit point for every failure.
 *
 * Two rules hold without exception:
 *
 * 1. Nothing is swallowed — every error is logged with the request id, the
 *    route and structured context.
 * 2. Nothing internal leaks — stack traces, driver messages and unexpected
 *    error text never reach the client. Unrecognised errors become a flat 500.
 */
export const errorHandler =
  (logger: Logger) =>
  (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      // The response is already on the wire; only the framework can tidy up.
      next(error);
      return;
    }

    const mapped = mapError(error);
    const requestId = requestIdOf(req);
    const logPayload = {
      requestId,
      method: req.method,
      path: req.path,
      status: mapped.status,
      code: mapped.code,
      userId: req.context.userId ?? 'anonymous',
      ...mapped.logContext,
    };

    if (mapped.status >= 500) {
      logger.error(logPayload, `${LOG_PREFIX} request failed`);
    } else {
      logger.warn(logPayload, `${LOG_PREFIX} request rejected`);
    }

    const body: ApiError = {
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details ? { details: mapped.details } : {}),
      },
      requestId,
    };
    res.status(mapped.status).json(body);
  };

const mapError = (error: unknown): MappedError => {
  if (isDomainError(error)) {
    return {
      status: error.httpStatus,
      code: error.code,
      message: error.message,
      logContext: { ...error.context, kind: error.name, classification: error.classification },
    };
  }

  if (error instanceof ZodError) {
    return {
      status: 400,
      code: 'VALIDATION_FAILED',
      message: 'The request was not valid.',
      details: error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
      logContext: { kind: 'ZodError' },
    };
  }

  const bodyParserFailure = mapBodyParserError(error);
  if (bodyParserFailure !== undefined) {
    return bodyParserFailure;
  }

  return {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: 'Something went wrong.',
    logContext: {
      kind: error instanceof Error ? error.name : typeof error,
      // The real message is kept for operators, not for the caller.
      reason: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    },
  };
};

interface BodyParserError extends Error {
  readonly type?: string;
  readonly status?: number;
}

/**
 * `express.json()` rejects oversized and malformed payloads before any route
 * runs. Those are client errors, so they are reported as such rather than being
 * folded into a misleading 500.
 */
const mapBodyParserError = (error: unknown): MappedError | undefined => {
  if (!(error instanceof Error) || !('type' in error)) {
    return undefined;
  }
  const { type } = error as BodyParserError;

  if (type === 'entity.too.large') {
    return {
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body is too large.',
      logContext: { kind: 'PayloadTooLarge' },
    };
  }
  if (type === 'entity.parse.failed') {
    return {
      status: 400,
      code: 'VALIDATION_FAILED',
      message: 'Request body is not valid JSON.',
      logContext: { kind: 'MalformedJson' },
    };
  }
  return undefined;
};
