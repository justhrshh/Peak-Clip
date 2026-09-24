import { Queue, Worker, QueueEvents } from 'bullmq';
import { createRedisConnection, closeRedisConnection } from '../queues/redis.js';
import { getQueue, closeAllQueues } from '../queues/index.js';
import { logger } from '../utils/logger.js';

async function runBullMqTest() {
  const queueName = 'infra-health-test-queue';
  logger.info({ queueName }, 'Starting BullMQ lifecycle verification...');

  // 1. Verify Queue Creation and default job options
  const queue = getQueue(queueName);
  const defaultOpts = queue.defaultJobOptions;
  logger.info({ defaultOpts }, 'Default job options retrieved');

  if (defaultOpts.attempts !== 3) {
    throw new Error(`Expected default attempts 3, got ${defaultOpts.attempts}`);
  }
  if (defaultOpts.backoff?.type !== 'exponential' || defaultOpts.backoff?.delay !== 5000) {
    throw new Error(`Expected backoff exponential 5000ms, got ${JSON.stringify(defaultOpts.backoff)}`);
  }
  if (defaultOpts.removeOnComplete?.count !== 500) {
    throw new Error(`Expected removeOnComplete count 500, got ${JSON.stringify(defaultOpts.removeOnComplete)}`);
  }

  // 2. QueueEvents for monitoring
  const eventsConnection = createRedisConnection();
  const queueEvents = new QueueEvents(queueName, { connection: eventsConnection });
  await queueEvents.waitUntilReady();

  // 3. Worker for processing
  const workerConnection = createRedisConnection();
  let completedJobs = [];
  let failedJobs = [];
  let attemptCount = 0;

  const worker = new Worker(
    queueName,
    async (job) => {
      logger.info({ jobId: job.id, name: job.name, attemptsMade: job.attemptsMade }, 'Worker processing job');
      if (job.name === 'test-failing-job' && job.attemptsMade === 0) {
        attemptCount++;
        throw new Error('Simulated transient failure for retry check');
      }
      return { success: true, processedAt: Date.now(), receivedData: job.data };
    },
    { connection: workerConnection }
  );

  await worker.waitUntilReady();
  logger.info('BullMQ Worker is ready');

  // 4. Producer: Add normal job
  const job1 = await queue.add('test-success-job', { payload: 'hello-bullmq', ts: Date.now() });
  logger.info({ jobId: job1.id }, 'Enqueued test-success-job');

  // Wait for job1 completion
  const res1 = await job1.waitUntilFinished(queueEvents, 10000);
  logger.info({ res1 }, 'Job 1 completed successfully');

  if (!res1.success || res1.receivedData.payload !== 'hello-bullmq') {
    throw new Error(`Job 1 returned unexpected result: ${JSON.stringify(res1)}`);
  }

  // 5. Test failure & retry metadata handling
  // Add a failing job with 2 attempts, backoff fixed 100ms for fast test
  const job2 = await queue.add('test-failing-job', { attemptTest: true }, {
    attempts: 2,
    backoff: { type: 'fixed', delay: 100 }
  });
  logger.info({ jobId: job2.id }, 'Enqueued test-failing-job (should fail once, then succeed)');

  const res2 = await job2.waitUntilFinished(queueEvents, 10000);
  logger.info({ res2, attemptCount }, 'Job 2 succeeded after retry');

  if (attemptCount !== 1 || !res2.success) {
    throw new Error(`Job 2 retry verification failed. Attempts made: ${attemptCount}`);
  }

  // 6. Graceful worker and queue shutdown
  logger.info('Shutting down test worker, queue events, and cleaning up test queue...');
  await worker.close();
  await queueEvents.close();
  eventsConnection.disconnect();

  // Clean up queue data
  await queue.obliterate({ force: true });
  await closeAllQueues();

  logger.info('BullMQ lifecycle verification passed completely!');
  console.log('BULLMQ_VERIFICATION_SUCCESS');
}

runBullMqTest()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('BULLMQ_VERIFICATION_FAILED:', err);
    process.exit(1);
  });
