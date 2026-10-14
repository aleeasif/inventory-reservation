import { API_BASE_PATH, IDEMPOTENCY_KEY_HEADER, REQUEST_ID_HEADER } from '@inventory/shared';
import cors, { type CorsOptions } from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from '../application/ports.js';
import type { ReservationService } from '../application/reservationService.js';
import type { AppConfig } from '../config/env.js';
import type { SessionTokenService } from '../infrastructure/sessionTokenService.js';
import { requestContext } from './middleware/requestContext.js';
import { authenticate } from './middleware/authenticate.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { createHealthRoutes } from './routes/health.js';
import { createProductRoutes } from './routes/products.js';
import { createReservationRoutes } from './routes/reservations.js';
import { createSessionRoutes } from './routes/sessions.js';

export interface CreateAppOptions {
  readonly config: AppConfig;
  readonly service: ReservationService;
  readonly tokens: SessionTokenService;
  readonly logger: Logger;
  readonly version: string;
}

/**
 * Builds the HTTP surface.
 *
 * Order is load-bearing and deliberate:
 *
 *   security headers -> CORS -> correlation id -> body limit -> rate limit
 *   -> authentication -> routes -> 404 -> single error handler
 *
 * Everything that protects the process runs before anything that costs work, so
 * an oversized or unauthenticated request is rejected before it reaches a route.
 */
export const createApp = (options: CreateAppOptions): Express => {
  const { config, logger } = options;
  const app = express();

  // Never advertise the framework; it is free reconnaissance for an attacker.
  app.disable('x-powered-by');

  // Only trust forwarding headers when the deployment really is behind a proxy;
  // trusting them unconditionally lets a client spoof its IP past the limiter.
  app.set('trust proxy', config.TRUST_PROXY ? 1 : false);

  app.use(
    helmet({ contentSecurityPolicy: true, crossOriginResourcePolicy: { policy: 'same-site' } }),
  );
  app.use(cors(corsOptions(config.corsOrigins)));
  app.use(requestContext);
  app.use(express.json({ limit: config.BODY_LIMIT }));

  const readRateLimiter = createRateLimiter({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_MAX,
  });
  const writeRateLimiter = createRateLimiter({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_WRITE_MAX,
  });

  app.use(API_BASE_PATH, readRateLimiter);
  app.use(`${API_BASE_PATH}/health`, createHealthRoutes(options.version));
  app.use(`${API_BASE_PATH}/sessions`, writeRateLimiter, createSessionRoutes(options.tokens));
  app.use(`${API_BASE_PATH}/products`, createProductRoutes(options.service));
  app.use(
    `${API_BASE_PATH}/reservations`,
    authenticate(options.tokens),
    createReservationRoutes({ service: options.service, writeRateLimiter }),
  );

  app.use(notFound);
  app.use(errorHandler(logger));

  return app;
};

/**
 * An explicit origin allowlist. Reflecting whatever `Origin` arrives would make
 * the API callable from any site a user happens to visit.
 */
const corsOptions = (allowedOrigins: readonly string[]): CorsOptions => ({
  origin: (origin, callback): void => {
    // Same-origin and non-browser clients (curl, the load script) send no Origin.
    if (origin === undefined || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization', IDEMPOTENCY_KEY_HEADER],
  exposedHeaders: [REQUEST_ID_HEADER, 'RateLimit', 'RateLimit-Policy'],
  // Identity travels in the Authorization header, so no cookies are ever needed.
  credentials: false,
  maxAge: 600,
});
