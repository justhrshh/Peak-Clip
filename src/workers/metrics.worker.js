import { Worker } from 'bullmq';
import { QUEUE_NAMES } from '../queues/index.js';
import { createRedisConnection } from '../queues/redis.js';
import { logger } from '../utils/logger.js';

/**
 * Creates and initializes the Metrics Worker
 * (Periodic engagement metric snapshots will be implemented in future phases)
 * @returns {Worker}
 */
export function createMetricsWorker() {
  const connection = createRedisConnection();

  const worker = new Worker(
    QUEUE_NAMES.METRICS,
    async (job) => {
      logger.info({ jobId: job.id, jobName: job.name }, 'Processing metrics snapshot job (placeholder)');
      // Phase 0: Foundation only - business logic will be added in Phase 2+
      return { status: 'acknowledged', jobId: job.id };
    },
    {
      connection,
      concurrency: 5,
      autorun: false
    }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'Metrics job failed');
  });

  return worker;
}
