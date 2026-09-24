import { createVerificationWorker } from './verification.worker.js';
import { createMetricsWorker } from './metrics.worker.js';
import { createPayoutWorker } from './payout.worker.js';
import { createMetricPollingWorker } from './metric-polling.worker.js';
import { createRetentionWorker } from './retention.worker.js';
import { startMetricScheduler, stopMetricScheduler } from './metric-scheduler.js';
import { startRetentionScheduler, stopRetentionScheduler } from './retention-scheduler.js';
import { logger } from '../utils/logger.js';

const activeWorkers = [];

/**
 * Start all background workers and scheduler
 */
export async function startWorkers() {
  logger.info('Initializing background workers...');

  const workers = [
    { name: 'VerificationWorker', worker: createVerificationWorker() },
    { name: 'MetricsWorker', worker: createMetricsWorker() },
    { name: 'PayoutWorker', worker: createPayoutWorker() },
    { name: 'MetricPollingWorker', worker: createMetricPollingWorker() },
    { name: 'RetentionWorker', worker: createRetentionWorker() }
  ];

  for (const { name, worker } of workers) {
    activeWorkers.push(worker);
    worker.run();
    logger.info(`Worker [${name}] registered and running.`);
  }

  // Start global schedulers
  await startMetricScheduler();
  await startRetentionScheduler();
}

/**
 * Gracefully stop all running workers and scheduler
 */
export async function stopWorkers() {
  await stopMetricScheduler();
  await stopRetentionScheduler();

  if (activeWorkers.length === 0) return;

  logger.info(`Stopping ${activeWorkers.length} background workers...`);
  for (const worker of activeWorkers) {
    try {
      await worker.close();
    } catch (err) {
      logger.error({ err: err.message }, 'Error stopping worker');
    }
  }
  activeWorkers.length = 0;
  logger.info('All background workers stopped.');
}
