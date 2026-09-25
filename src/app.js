import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { formatError } from './utils/errors.js';
import { testDatabaseConnection, disconnectDatabase } from './database/client.js';
import { testRedisConnection } from './queues/redis.js';
import { closeAllQueues } from './queues/index.js';
import { startWorkers, stopWorkers } from './workers/index.js';
import { startDiscordBot, stopDiscordBot } from './bot/client.js';
import { startHealthServer, stopHealthServer } from './server/health.js';

let isShuttingDown = false;

/**
 * Perform application startup
 */
export async function bootstrap() {
  logger.info({
    env: config.env,
    logLevel: config.logLevel,
    nodeVersion: process.version
  }, 'Starting Discord Clipping Agency Platform...');

  // 1. Start lightweight HTTP health server FIRST (Render 0.0.0.0:$PORT requirement)
  // Must bind immediately so Render port scan detects open port before any gateway delays
  try {
    await startHealthServer();
  } catch (error) {
    logger.fatal(
      { err: formatError(error), port: process.env.PORT },
      'Fatal: Health check HTTP server failed to bind port. Aborting process with nonzero exit code.'
    );
    process.exit(1);
  }

  // 2. Check Database connection
  const dbConnected = await testDatabaseConnection();
  if (!dbConnected && config.isProduction) {
    throw new Error('Database connection failed in production mode. Aborting.');
  }

  // 3. Check Redis connection
  const redisConnected = await testRedisConnection();
  if (redisConnected) {
    // 4. Start workers if Redis is available
    await startWorkers();
  } else {
    logger.warn('Redis is not reachable. Background workers and queues are running in deferred/offline mode.');
  }

  // 5. Start Discord Bot
  try {
    await startDiscordBot();
  } catch (error) {
    logger.fatal(
      { err: formatError(error) },
      'Fatal: Discord bot failed to authenticate with gateway. Aborting.'
    );
    if (config.isProduction) {
      process.exit(1);
    }
  }

  logger.info('Platform foundation initialized successfully.');
}

/**
 * Graceful shutdown sequence
 * @param {string} signal
 * @param {boolean} [exitProcess=true]
 */
export async function shutdown(signal, exitProcess = true) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, 'Received shutdown signal. Commencing graceful teardown...');

  let shutdownTimeout = null;
  if (exitProcess && !config.isTest) {
    shutdownTimeout = setTimeout(() => {
      logger.fatal('Graceful shutdown timed out. Forcing termination.');
      process.exit(1);
    }, 10000);
  }

  try {
    // Teardown HTTP Health Server
    await stopHealthServer();

    // Teardown Discord Bot
    await stopDiscordBot();

    // Teardown Workers
    await stopWorkers();

    // Teardown Queues and Redis
    await closeAllQueues();

    // Teardown Database
    await disconnectDatabase();

    if (shutdownTimeout) clearTimeout(shutdownTimeout);
    logger.info('Graceful teardown completed. Exiting process.');
    if (exitProcess && !config.isTest) {
      process.exit(0);
    }
  } catch (error) {
    if (shutdownTimeout) clearTimeout(shutdownTimeout);
    logger.error({ err: formatError(error) }, 'Error during graceful shutdown');
    if (exitProcess && !config.isTest) {
      process.exit(1);
    }
    throw error;
  } finally {
    isShuttingDown = false;
  }
}

// Global process error handlers
process.on('uncaughtException', (err) => {
  logger.fatal({ err: formatError(err) }, 'Uncaught Exception detected');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason: reason instanceof Error ? formatError(reason) : reason }, 'Unhandled Rejection detected');
  process.exit(1);
});

// OS signal listeners
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Auto-run when executed directly
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('app.js')) {
  bootstrap().catch((err) => {
    logger.fatal({ err: formatError(err) }, 'Platform bootstrap failed');
    process.exit(1);
  });
}
