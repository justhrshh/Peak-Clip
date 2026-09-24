import { prisma, testDatabaseConnection } from '../database/client.js';
import { testRedisConnection } from '../queues/redis.js';
import { config } from '../config/index.js';
import { logger } from './logger.js';

/**
 * Check process liveness
 * Indicates whether the application process is running and responding.
 *
 * @returns {{ status: 'UP', uptimeSeconds: number, timestamp: string, nodeVersion: string, memoryUsage: object }}
 */
export function checkLiveness() {
  const memory = process.memoryUsage();
  return {
    status: 'UP',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    memoryUsage: {
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
      rssMb: Math.round(memory.rss / 1024 / 1024)
    }
  };
}

/**
 * Check system readiness
 * Verifies that required infrastructure (PostgreSQL, Redis) is available and responsive.
 * Never leaks credentials or secrets.
 *
 * @param {object} [dependencies={}] - Optional injected connection testers for testing
 * @returns {Promise<{ status: 'READY'|'NOT_READY', timestamp: string, checks: { database: string, redis: string } }>}
 */
export async function checkReadiness(dependencies = {}) {
  const dbTester = dependencies.testDb || testDatabaseConnection;
  const redisTester = dependencies.testRedis || testRedisConnection;

  let dbOk = false;
  let redisOk = false;

  try {
    dbOk = await dbTester();
  } catch (err) {
    logger.warn({ err: err.message }, 'Readiness check: database failure');
    dbOk = false;
  }

  try {
    redisOk = await redisTester();
  } catch (err) {
    logger.warn({ err: err.message }, 'Readiness check: redis failure');
    redisOk = false;
  }

  // In production, both DB and Redis are required for full readiness
  // In development, if DB or Redis is offline, report status accurately
  const isReady = config.isProduction ? (dbOk && redisOk) : (dbOk || redisOk);

  return {
    status: isReady ? 'READY' : 'NOT_READY',
    timestamp: new Date().toISOString(),
    checks: {
      database: dbOk ? 'HEALTHY' : 'UNHEALTHY',
      redis: redisOk ? 'HEALTHY' : 'UNHEALTHY'
    }
  };
}
