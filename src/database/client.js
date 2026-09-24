import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { DatabaseError } from '../utils/errors.js';

let prismaInstance = null;

/**
 * Get or initialize the Prisma Client singleton
 * @returns {PrismaClient}
 */
export function getPrismaClient() {
  if (!prismaInstance) {
    if (!config.db.url) {
      logger.warn('DATABASE_URL is not set. Prisma will run in unconfigured mode.');
    }

    prismaInstance = new PrismaClient({
      log: config.isDevelopment
        ? [
            { emit: 'event', level: 'query' },
            { emit: 'event', level: 'error' },
            { emit: 'event', level: 'warn' }
          ]
        : [{ emit: 'event', level: 'error' }]
    });

    if (config.isDevelopment) {
      prismaInstance.$on('error', (e) => {
        logger.error({ target: e.target }, `Prisma Error: ${e.message}`);
      });
      prismaInstance.$on('warn', (e) => {
        logger.warn({ target: e.target }, `Prisma Warning: ${e.message}`);
      });
    } else {
      prismaInstance.$on('error', (e) => {
        logger.error({ target: e.target }, `Prisma Error: ${e.message}`);
      });
    }
  }

  return prismaInstance;
}

/**
 * Test database connectivity with automatic retry for serverless wake-up (e.g. Neon)
 * @param {number} [maxRetries=3]
 * @param {number} [delayMs=2000]
 * @returns {Promise<boolean>}
 */
export async function testDatabaseConnection(maxRetries = 3, delayMs = 2000) {
  if (!config.db.url) {
    logger.warn('Skipping database connectivity test: DATABASE_URL not configured.');
    return false;
  }

  const client = getPrismaClient();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await client.$queryRaw`SELECT 1`;
      logger.info('Database connection successfully established.');
      return true;
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      if (isLastAttempt) {
        logger.error({ err: error.message, attempts: maxRetries }, 'Database connection test failed after all retries.');
        if (config.isProduction) {
          throw new DatabaseError(`Database connection failed after ${maxRetries} attempts: ${error.message}`);
        }
        return false;
      }
      logger.warn(
        { attempt, maxRetries, delayMs, err: error.message },
        'Database connection attempt failed (possible serverless cold start). Retrying...'
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return false;
}

/**
 * Gracefully disconnect database client
 */
export async function disconnectDatabase() {
  if (prismaInstance) {
    try {
      await prismaInstance.$disconnect();
      logger.info('Database disconnected cleanly.');
    } catch (error) {
      logger.error({ err: error.message }, 'Error disconnecting from database.');
    } finally {
      prismaInstance = null;
    }
  }
}

export const prisma = getPrismaClient();
export default prisma;
