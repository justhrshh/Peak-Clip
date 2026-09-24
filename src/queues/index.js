import { Queue } from 'bullmq';
import { createRedisConnection, closeRedisConnection } from './redis.js';
import { logger } from '../utils/logger.js';

export const QUEUE_NAMES = Object.freeze({
  VERIFICATION: 'verification-queue',
  METRICS: 'metrics-queue',
  PAYOUT: 'payout-queue',
  METRIC_POLLING: 'metric-polling-queue',
  METRIC_SCHEDULER: 'metric-scheduler-queue',
  RETENTION: 'retention-queue',
  RETENTION_SCHEDULER: 'retention-scheduler-queue'
});

const queues = new Map();

/**
 * Get or initialize a BullMQ Queue instance
 * @param {string} queueName
 * @returns {Queue}
 */
export function getQueue(queueName) {
  if (!queues.has(queueName)) {
    const connection = createRedisConnection();
    const queue = new Queue(queueName, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000
        },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 1000 }
      }
    });

    queue.on('error', (err) => {
      logger.debug({ queue: queueName, err: err.message }, 'BullMQ Queue connection notice');
    });

    queues.set(queueName, { queue, connection });
  }

  return queues.get(queueName).queue;
}

/**
 * Gracefully close all initialized BullMQ queues and underlying connections
 */
export async function closeAllQueues() {
  logger.info(`Closing ${queues.size} BullMQ queues...`);
  for (const [name, { queue, connection }] of queues.entries()) {
    try {
      await queue.close();
    } catch (error) {
      logger.error({ queue: name, err: error.message }, 'Failed to close queue cleanly');
    }

    try {
      if (connection && connection.status !== 'end') {
        connection.disconnect();
      }
    } catch (error) {
      logger.debug({ queue: name, err: error.message }, 'Error disconnecting queue Redis connection');
    }
  }
  queues.clear();
  await closeRedisConnection();
}
