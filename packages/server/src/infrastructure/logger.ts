import { pino, type Logger as PinoLogger } from 'pino';
import type { Logger } from '../application/ports.js';

export interface LoggerOptions {
  readonly level: string;
  readonly pretty: boolean;
}

/**
 * Structured logging with a hard redaction list.
 *
 * Secrets never reach a log line even if a future caller passes a whole request
 * object by mistake: redaction is configured here, once, rather than trusted to
 * every call site.
 */
export const createLogger = (options: LoggerOptions): PinoLogger =>
  pino({
    level: options.level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["idempotency-key"]',
        'res.headers["set-cookie"]',
        'token',
        '*.token',
        'password',
        '*.password',
        'secret',
        '*.secret',
      ],
      censor: '[redacted]',
    },
    ...(options.pretty
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l' } } }
      : {}),
  });

/** A logger that discards everything. Keeps test output readable. */
export const createSilentLogger = (): Logger => {
  const noop = (): void => undefined;
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
};
