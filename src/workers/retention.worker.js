import { Worker } from 'bullmq';
import { QUEUE_NAMES } from '../queues/index.js';
import { createRedisConnection } from '../queues/redis.js';
import { retentionService } from '../modules/retention/retention.service.js';
import { logger } from '../utils/logger.js';

/**
 * Creates and initializes the BullMQ Retention Worker
 *
 * Responsibilities:
 * - Listens on retention-queue
 * - Checks video availability and evaluates retention deadlines
 * - Transitions submissions to FULFILLED or VIOLATED
 * - Re-throws transient errors to enable BullMQ exponential retry/backoff
 *
 * @returns {Worker}
 */
export function createRetentionWorker() {
  const connection = createRedisConnection();

  const worker = new Worker(
    QUEUE_NAMES.RETENTION,
    async (job) => {
      const { submissionId } = job.data;
      logger.info({ jobId: job.id, submissionId }, 'Starting retention check job');

      if (!submissionId) {
        logger.warn({ jobId: job.id }, 'Retention check job missing submissionId; skipping');
        return { status: 'SKIPPED' };
      }

      const result = await retentionService.checkSubmissionRetention(submissionId);
      logger.info({ jobId: job.id, submissionId, status: result.status }, 'Retention check job completed');
      return result;
    },
    {
      connection,
      concurrency: 5,
      autorun: false
    }
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, submissionId: job?.data?.submissionId, err: err.message },
      'Retention check job failed'
    );
  });

  worker.on('error', (err) => {
    logger.debug({ err: err.message }, 'Retention worker connection notice');
  });

  return worker;
}
