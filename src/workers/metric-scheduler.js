import { getQueue, QUEUE_NAMES } from '../queues/index.js';
import { prisma } from '../database/client.js';
import { findEligibleSubmissionsBatch } from '../modules/verification/polling.policy.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

let schedulerInterval = null;
let isDispatching = false;

/**
 * Dispatch a single polling cycle:
 * Queries eligible submissions in bounded batches and enqueues individual polling jobs
 * with deterministic job IDs to avoid duplicate processing.
 *
 * @param {object} [options={}]
 * @param {import('@prisma/client').PrismaClient} [options.db=prisma]
 * @returns {Promise<{ enqueuedCount: number, batchCount: number }>}
 */
export async function dispatchMetricPollingCycle(options = {}) {
  if (isDispatching) {
    logger.warn('Previous polling dispatch cycle is still active; skipping overlapping cycle');
    return { enqueuedCount: 0, batchCount: 0, skipped: true };
  }

  isDispatching = true;
  const db = options.db || prisma;
  const batchSize = config.polling.batchSize || 50;
  const pollQueue = getQueue(QUEUE_NAMES.METRIC_POLLING);
  const cycleTimestamp = Math.floor(Date.now() / (1000 * 60 * (config.polling.intervalMinutes || 60))); // Unique per interval bucket

  let cursor = null;
  let hasMore = true;
  let enqueuedCount = 0;
  let batchCount = 0;

  logger.info({ batchSize, cycleBucket: cycleTimestamp }, 'Initiating global metric polling dispatch cycle');

  try {
    while (hasMore) {
      const batch = await findEligibleSubmissionsBatch(db, { batchSize, cursor });
      batchCount++;

      if (batch.length === 0) {
        hasMore = false;
        break;
      }

      // Enqueue polling jobs with deterministic IDs
      for (const sub of batch) {
        const jobId = `poll_${sub.id}_${cycleTimestamp}`;
        try {
          await pollQueue.add(
            'poll-metrics',
            {
              submissionId: sub.id,
              correlationId: `poll_cycle_${cycleTimestamp}_${sub.id}`,
              forceRefresh: false
            },
            {
              jobId, // Deterministic deduplication
              attempts: config.polling.maxAttempts || 3,
              backoff: {
                type: 'exponential',
                delay: config.polling.backoffMs || 5000
              }
            }
          );
          enqueuedCount++;
        } catch (enqueueErr) {
          // If job with deterministic ID already exists, BullMQ will cleanly ignore/reject duplicate
          logger.debug({ submissionId: sub.id, jobId, err: enqueueErr.message }, 'Job already enqueued for this cycle');
        }
      }

      cursor = batch[batch.length - 1].id;
      if (batch.length < batchSize) {
        hasMore = false;
      }
    }

    logger.info(
      { enqueuedCount, batchCount, cycleBucket: cycleTimestamp },
      'Global metric polling dispatch cycle completed'
    );

    return { enqueuedCount, batchCount, skipped: false };
  } catch (error) {
    logger.error({ err: error.message }, 'Error during metric polling dispatch cycle');
    throw error;
  } finally {
    isDispatching = false;
  }
}

/**
 * Start the global metric scheduler
 */
export async function startMetricScheduler() {
  if (!config.polling.enabled) {
    logger.info('Scheduled metric polling is disabled by configuration.');
    return;
  }

  const intervalMs = (config.polling.intervalMinutes || 60) * 60 * 1000;
  logger.info({ intervalMinutes: config.polling.intervalMinutes }, 'Starting global metric polling scheduler');

  // Trigger initial cycle on startup (after 10s warmup)
  setTimeout(() => {
    dispatchMetricPollingCycle().catch((err) => {
      logger.error({ err: err.message }, 'Error running initial metric polling dispatch');
    });
  }, 10000);

  // Recurring interval
  schedulerInterval = setInterval(() => {
    dispatchMetricPollingCycle().catch((err) => {
      logger.error({ err: err.message }, 'Error running periodic metric polling dispatch');
    });
  }, intervalMs);
}

/**
 * Stop the global metric scheduler
 */
export async function stopMetricScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    logger.info('Global metric polling scheduler stopped.');
  }
}
