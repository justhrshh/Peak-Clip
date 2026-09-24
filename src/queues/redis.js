import { Redis } from 'ioredis';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';

let sharedRedisClient = null;

/**
 * Creates a configured ioredis instance suitable for BullMQ
 * BullMQ requires maxRetriesPerRequest: null
 * @param {object} [customOptions={}]
 * @returns {Redis}
 */
export function createRedisConnection(customOptions = {}) {
  const redisOptions = {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password || undefined,
    db: config.redis.db,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
    connectTimeout: 2000,
    retryStrategy(times) {
      if (times > 3) {
        return null;
      }
      return Math.min(times * 200, 2000);
    },
    ...customOptions
  };

  const client = new Redis(redisOptions);

  client.on('error', (err) => {
    logger.debug({ err: err.message }, 'Redis connection event notice');
  });

  return client;
}

/**
 * Get or create shared Redis client
 * @returns {Redis}
 */
export function getSharedRedisClient() {
  if (!sharedRedisClient) {
    sharedRedisClient = createRedisConnection();
  }
  return sharedRedisClient;
}

/**
 * Test Redis connectivity without hanging or persistent retries
 * @returns {Promise<boolean>}
 */
export async function testRedisConnection() {
  const probeClient = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password || undefined,
    db: config.redis.db,
    connectTimeout: 1000,
    lazyConnect: true,
    retryStrategy: () => null,
    enableReadyCheck: false
  });

  probeClient.on('error', () => {}); // Ignore probe errors

  try {
    await probeClient.connect();
    const pong = await probeClient.ping();
    logger.debug({ pong }, 'Redis connection successfully established.');
    await probeClient.quit();
    return true;
  } catch (error) {
    probeClient.disconnect();
    logger.warn({ err: error.message }, 'Redis is unreachable; skipping live queue connections.');
    return false;
  }
}

/**
 * Gracefully close shared Redis connection
 */
export async function closeRedisConnection() {
  if (sharedRedisClient) {
    try {
      if (sharedRedisClient.status !== 'end') {
        sharedRedisClient.disconnect();
      }
      logger.info('Redis connection closed cleanly.');
    } catch (error) {
      logger.error({ err: error.message }, 'Error closing Redis connection.');
    } finally {
      sharedRedisClient = null;
    }
  }
}
