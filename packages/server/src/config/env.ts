import { randomBytes } from 'node:crypto';
import { RESERVATION_HOLD_MS } from '@inventory/shared';
import { z } from 'zod';

/**
 * Configuration is validated once, at startup, and never read from
 * `process.env` again. A missing or malformed value is a permanent error: the
 * process refuses to start rather than failing later under load.
 */

const SESSION_SECRET_MIN_BYTES = 32;

const durationMs = (fallback: number): z.ZodType<number> =>
  z.coerce.number().int().positive().max(86_400_000).default(fallback);

const booleanFlag = (fallback: boolean): z.ZodType<boolean> =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** HMAC key for session tokens. Must be supplied in production. */
  SESSION_SECRET: z.string().min(SESSION_SECRET_MIN_BYTES).optional(),
  SESSION_TTL_MS: durationMs(24 * 60 * 60 * 1000),

  /**
   * Comma-separated exact origins allowed to call the API from a browser.
   * Empty by default: the challenge has no browser client. curl and the tests
   * send no Origin header, so they are unaffected.
   */
  CORS_ALLOWED_ORIGINS: z.string().default(''),

  RESERVATION_HOLD_MS: durationMs(RESERVATION_HOLD_MS),
  RESERVATION_RETENTION_MS: durationMs(60 * 60 * 1000),
  SWEEP_INTERVAL_MS: durationMs(5_000),
  LOCK_ACQUIRE_TIMEOUT_MS: durationMs(5_000),

  IDEMPOTENCY_TTL_MS: durationMs(10 * 60 * 1000),
  IDEMPOTENCY_MAX_ENTRIES: z.coerce.number().int().positive().max(1_000_000).default(50_000),

  RATE_LIMIT_WINDOW_MS: durationMs(60_000),
  /** Ceiling for ordinary reads. */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  /** Tighter ceiling for state-changing reservation calls. */
  RATE_LIMIT_WRITE_MAX: z.coerce.number().int().positive().default(60),

  /** Request body cap. Reservation payloads are tiny; anything larger is hostile. */
  BODY_LIMIT: z.string().default('4kb'),

  /** Enable only when the process genuinely sits behind a trusted proxy. */
  TRUST_PROXY: booleanFlag(false),
});

export type Env = Readonly<z.infer<typeof envSchema>>;

export interface AppConfig extends Env {
  readonly corsOrigins: readonly string[];
  readonly sessionSecret: string;
  readonly isProduction: boolean;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * Builds the configuration, or throws with an actionable message naming every
 * offending variable. Never falls back to an insecure default in production.
 */
export const loadConfig = (source: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ConfigurationError(`Invalid environment configuration — ${problems}`);
  }

  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';

  if (isProduction && env.SESSION_SECRET === undefined) {
    throw new ConfigurationError(
      `SESSION_SECRET is required in production and must be at least ${String(
        SESSION_SECRET_MIN_BYTES,
      )} characters. Generate one with: openssl rand -base64 48`,
    );
  }

  return {
    ...env,
    isProduction,
    // Outside production an ephemeral secret is fine: it only invalidates
    // sessions on restart, and it keeps a weak default out of the repository.
    sessionSecret: env.SESSION_SECRET ?? randomBytes(48).toString('base64'),
    corsOrigins: env.CORS_ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  };
};
