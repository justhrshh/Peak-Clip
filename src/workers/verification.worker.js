import { Worker } from 'bullmq';
import { QUEUE_NAMES } from '../queues/index.js';
import { createRedisConnection } from '../queues/redis.js';
import { verificationService } from '../modules/verification/verification.service.js';
import {
  PermanentContentError,
  ConfigurationAuthError,
  TransientProviderError
} from '../modules/verification/verification.errors.js';
import { logger } from '../utils/logger.js';

/**
 * Creates and initializes the hardened Verification Worker
 * @returns {Worker}
 */
export function createVerificationWorker() {
  const connection = createRedisConnection();

  const worker = new Worker(
    QUEUE_NAMES.VERIFICATION,
    async (job) => {
      const submissionId = job.data?.submissionId;
      logger.info({ jobId: job.id, submissionId }, 'Processing verification job');

      if (!submissionId) {
        logger.warn({ jobId: job.id }, 'Verification job missing submissionId; skipping');
        return { status: 'skipped', reason: 'MISSING_SUBMISSION_ID' };
      }

      try {
        const result = await verificationService.runVerification(submissionId);
        logger.info({ jobId: job.id, submissionId, status: result.status }, 'Verification job completed successfully');
        return result;
      } catch (error) {
        // 1. Permanent content failure (video deleted, 404, private) -> do not retry
        if (error instanceof PermanentContentError || error.details?.category === 'PERMANENT_CONTENT') {
          logger.warn(
            { jobId: job.id, submissionId, err: error.message },
            'Permanent content failure encountered; job terminated without retry'
          );
          return { status: 'failed_permanently', reason: error.message };
        }

        // 2. Configuration or authorization error (bad API key) -> do not repeatedly hammer API
        if (error instanceof ConfigurationAuthError || error.details?.category === 'CONFIGURATION_OR_AUTH') {
          logger.error(
            { jobId: job.id, submissionId, err: error.message },
            'Configuration/auth error encountered; job terminated without retry (staff review required)'
          );
          return { status: 'failed_configuration_auth', reason: error.message };
        }

        // 3. Transient failure (network, 429, 503) -> re-throw so BullMQ retries with exponential backoff
        if (error instanceof TransientProviderError || error.details?.retryable === true) {
          logger.warn(
            { jobId: job.id, submissionId, attempt: job.attemptsMade, err: error.message },
            'Transient provider error; enqueued for BullMQ exponential backoff retry'
          );
          throw error;
        }

        logger.error(
          { jobId: job.id, submissionId, err: error.message },
          'Unexpected error during verification; letting BullMQ handle retry'
        );
        throw error;
      }
    },
    {
      connection,
      concurrency: 5,
      autorun: false
    }
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, attempts: job?.attemptsMade, err: err.message },
      'Verification worker job final failure'
    );
  });

  return worker;
}
