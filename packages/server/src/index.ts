import type { Server } from 'node:http';
import { createContainer } from './container.js';
import { ConfigurationError, loadConfig } from './config/env.js';
import { createLogger } from './infrastructure/logger.js';
import { APP_VERSION } from './version.js';

const LOG_PREFIX = '[Server]';
const SHUTDOWN_GRACE_MS = 10_000;

/**
 * Process entry point: validate configuration, wire the container, listen, and
 * shut down cleanly. Any failure before `listen` exits non-zero rather than
 * leaving a half-started process accepting traffic.
 */
const main = (): void => {
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, pretty: !config.isProduction });
  const container = createContainer(config, logger);

  container.sweeper.start();

  const server = container.app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV, version: APP_VERSION },
      `${LOG_PREFIX} listening`,
    );
  });

  installShutdownHandlers(server, container.sweeper.stop.bind(container.sweeper), logger);
};

const installShutdownHandlers = (
  server: Server,
  stopSweeper: () => void,
  logger: ReturnType<typeof createLogger>,
): void => {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, `${LOG_PREFIX} shutting down`);
    stopSweeper();

    // Stop accepting new connections, then give in-flight reservations a
    // bounded window to finish rather than cutting them mid-transition.
    const forceExit = setTimeout(() => {
      logger.error({ graceMs: SHUTDOWN_GRACE_MS }, `${LOG_PREFIX} forced exit`);
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExit.unref();

    server.close((error) => {
      if (error) {
        logger.error({ reason: error.message }, `${LOG_PREFIX} shutdown failed`);
        process.exit(1);
      }
      logger.info({}, `${LOG_PREFIX} stopped`);
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  // An unobserved failure is still a failure: log it with context, then let the
  // supervisor restart a process whose state can no longer be trusted.
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error(
      { reason: reason instanceof Error ? reason.message : String(reason) },
      `${LOG_PREFIX} unhandled rejection`,
    );
    shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (error: Error) => {
    logger.error({ reason: error.message, stack: error.stack }, `${LOG_PREFIX} uncaught exception`);
    shutdown('uncaughtException');
  });
};

try {
  main();
} catch (error) {
  const message = error instanceof ConfigurationError ? error.message : String(error);
  // The logger may not exist yet, so startup failure is reported on stderr.
  process.stderr.write(`${LOG_PREFIX} failed to start: ${message}\n`);
  process.exit(1);
}
