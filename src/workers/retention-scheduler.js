import { getQueue, QUEUE_NAMES } from '../queues/index.js';
import { prisma } from '../database/client.js';
import { logger } from '../utils/logger.js';

let retentionSchedulerInterval = null;
let isDispatchingRetention = false;

/**
 * Dispatch a single retention polling cycle
 * Queries active retention submissions in bounded batches and enqueues jobs with deterministic deduplication IDs.
 *
 * @param {object} [options={}]
 * @param {import('@prisma/client').PrismaClient} [options.db=prisma]
 * @returns {Promise<{ enqueuedCount: number, skipped: boolean }>}
 */
export async function dispatchRetentionPollingCycle(options = {}) {
  if (isDispatchingRetention) {
    logger.warn('Previous retention dispatch cycle is still active; skipping overlapping cycle');
    return { enqueuedCount: 0, skipped: true };
  }

  isDispatchingRetention = true;
  const db = options.db || prisma;
  const retentionQueue = getQueue(QUEUE_NAMES.RETENTION);
  // Cycle timestamp bucketed by day (24 hours) to enforce daily existence verification
  const cycleTimestamp = Math.floor(Date.now() / (1000 * 60 * 60 * 24));

  let enqueuedCount = 0;

  try {
    const activeSubmissions = await db.submission.findMany({
      where: {
        retentionRequired: true,
        retentionStatus: 'ACTIVE'
      },
      select: { id: true, retentionDeadline: true },
      take: 100
    });

    for (const sub of activeSubmissions) {
      const jobId = `retention_${sub.id}_${cycleTimestamp}`;
      try {
        await retentionQueue.add(
          'check-retention',
          { submissionId: sub.id },
          { jobId }
        );
        enqueuedCount++;
      } catch (err) {
        logger.debug({ submissionId: sub.id, err: err.message }, 'Retention job deduplicated or failed to enqueue');
      }
    }

    logger.info({ enqueuedCount, totalFound: activeSubmissions.length }, 'Retention polling cycle dispatch completed');
    return { enqueuedCount, skipped: false };
  } catch (err) {
    logger.error({ err: err.message }, 'Error during retention polling cycle dispatch');
    return { enqueuedCount: 0, error: err.message };
  } finally {
    isDispatchingRetention = false;
  }
}

/**
 * Start the retention scheduler interval
 * @param {number} [intervalMinutes=1440] - Default 24 hours (1440 minutes)
 */
export async function startRetentionScheduler(intervalMinutes = 1440) {
  if (retentionSchedulerInterval) {
    logger.warn('Retention scheduler already running');
    return;
  }

  logger.info({ intervalMinutes }, 'Starting retention monitoring scheduler');
  // Initial immediate check
  await dispatchRetentionPollingCycle();

  retentionSchedulerInterval = setInterval(async () => {
    try {
      await dispatchRetentionPollingCycle();
    } catch (err) {
      logger.error({ err: err.message }, 'Unexpected error in scheduled retention cycle');
    }
  }, intervalMinutes * 60 * 1000);
}

/**
 * Stop the retention scheduler interval
 */
export async function stopRetentionScheduler() {
  if (retentionSchedulerInterval) {
    clearInterval(retentionSchedulerInterval);
    retentionSchedulerInterval = null;
    logger.info('Retention scheduler stopped');
  }
}
