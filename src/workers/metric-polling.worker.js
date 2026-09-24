import { Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { QUEUE_NAMES } from '../queues/index.js';
import { createRedisConnection } from '../queues/redis.js';
import { prisma } from '../database/client.js';
import { getPlatformProvider } from '../providers/index.js';
import { isSubmissionEligibleForPolling, hasMetricsChanged } from '../modules/verification/polling.policy.js';
import { parseAndNormalizeUrl } from '../modules/submissions/url.parser.js';
import { earningsService } from '../modules/earnings/earnings.service.js';
import { analyzeMetricSignals } from '../modules/verification/analyzer.js';
import { assessVerificationRisk } from '../modules/verification/risk.assessor.js';
import { DEFAULT_VERIFICATION_POLICY } from '../modules/verification/policy.js';
import { MODERATION_ACTIONS } from '../modules/moderation/moderation.constants.js';
import { notifyStaffSuspiciousClip } from '../bot/notifications/staff.notifications.js';
import {
  PermanentContentError,
  ConfigurationAuthError,
  TransientProviderError,
  RateLimitProviderError
} from '../modules/verification/verification.errors.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';

/**
 * Creates and initializes the Metric Polling Worker
 * @returns {Worker}
 */
export function createMetricPollingWorker() {
  const connection = createRedisConnection();

  const worker = new Worker(
    QUEUE_NAMES.METRIC_POLLING,
    async (job) => {
      const submissionId = job.data?.submissionId;
      const correlationId = job.data?.correlationId || `poll_${randomUUID()}`;
      const forceRefresh = Boolean(job.data?.forceRefresh);
      const startTime = Date.now();

      logger.info(
        { jobId: job.id, submissionId, correlationId, forceRefresh },
        'Starting scheduled metric polling job'
      );

      if (!submissionId) {
        logger.warn({ jobId: job.id, correlationId }, 'Metric polling job missing submissionId; skipping');
        return { status: 'skipped', reason: 'MISSING_SUBMISSION_ID' };
      }

      // 1. Resolve submission from database
      const submission = await prisma.submission.findUnique({
        where: { id: submissionId },
        include: {
          campaign: true,
          user: {
            select: { id: true, status: true }
          },
          snapshots: {
            orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
            take: 1
          }
        }
      });

      if (!submission) {
        logger.warn({ submissionId, correlationId }, 'Submission not found in database; polling aborted');
        return { status: 'skipped', reason: 'SUBMISSION_NOT_FOUND' };
      }

      // 2. Validate polling eligibility
      if (!forceRefresh && !isSubmissionEligibleForPolling(submission)) {
        logger.info(
          { submissionId, campaignId: submission.campaignId, correlationId },
          'Submission is currently ineligible for scheduled polling; skipping'
        );
        return { status: 'skipped', reason: 'INELIGIBLE' };
      }

      // 3. Resolve provider
      const provider = getPlatformProvider(submission.platform);
      logger.info(
        {
          submissionId,
          campaignId: submission.campaignId,
          platform: submission.platform,
          provider: provider.name,
          correlationId
        },
        'Querying external provider for latest metrics'
      );

      try {
        const { contentId } = parseAndNormalizeUrl(submission.url);
        const providerInput = submission.platform === 'INSTAGRAM' ? (submission.url || contentId) : (contentId || submission.url);
        const metricsRes = await provider.getVideoMetrics(providerInput);

        if (!metricsRes || metricsRes.status === 'DATA_UNAVAILABLE') {
          await prisma.submission.update({
            where: { id: submission.id },
            data: { lastAvailabilityStatus: 'DATA_UNAVAILABLE', updatedAt: new Date() }
          }).catch(() => {});

          logger.warn(
            { submissionId, platform: submission.platform, correlationId },
            'Provider returned DATA_UNAVAILABLE; updated lastAvailabilityStatus'
          );
          return { status: 'data_unavailable', submissionId };
        }

        const newMetrics = {
          views: metricsRes.views !== null && metricsRes.views !== undefined ? BigInt(metricsRes.views) : null,
          likes: metricsRes.likes !== null && metricsRes.likes !== undefined ? BigInt(metricsRes.likes) : null,
          comments: metricsRes.comments !== null && metricsRes.comments !== undefined ? BigInt(metricsRes.comments) : null,
          shares: metricsRes.shares !== null && metricsRes.shares !== undefined ? BigInt(metricsRes.shares) : null
        };

        const latestSnapshot = submission.snapshots?.[0] || null;

        // 4. Deterministic Snapshot Policy: check if metrics actually changed
        if (!forceRefresh && !hasMetricsChanged(latestSnapshot, newMetrics)) {
          await prisma.submission.update({
            where: { id: submission.id },
            data: { lastAvailabilityStatus: metricsRes.status || 'AVAILABLE', updatedAt: new Date() }
          }).catch(() => {});

          logger.info(
            {
              submissionId,
              latestSnapshotId: latestSnapshot?.id,
              views: newMetrics.views?.toString(),
              correlationId
            },
            'Metrics identical to latest snapshot; skipping duplicate snapshot insertion'
          );
          return {
            status: 'unchanged',
            submissionId,
            snapshotId: latestSnapshot?.id,
            durationMs: Date.now() - startTime
          };
        }

        // 5. Insert new MetricSnapshot record
        const snapshot = await prisma.metricSnapshot.create({
          data: {
            submissionId: submission.id,
            views: newMetrics.views,
            likes: newMetrics.likes,
            comments: newMetrics.comments,
            shares: newMetrics.shares,
            capturedAt: new Date(),
            metadata: {
              correlationId,
              polledBy: 'METRIC_POLLING_WORKER',
              provider: provider.name || submission.platform,
              availability: metricsRes.availability || null,
              status: metricsRes.status || 'AVAILABLE'
            }
          }
        });

        await prisma.submission.update({
          where: { id: submission.id },
          data: { lastAvailabilityStatus: metricsRes.status || 'AVAILABLE', updatedAt: new Date() }
        }).catch(() => {});

        logger.info(
          {
            submissionId,
            snapshotId: snapshot.id,
            views: newMetrics.views?.toString(),
            correlationId
          },
          'New metric snapshot captured successfully'
        );

        // 5.5 Continuous Suspicion Detection on new metrics
        const historicalSnapshots = await prisma.metricSnapshot.findMany({
          where: { submissionId: submission.id, id: { not: snapshot.id } },
          orderBy: { capturedAt: 'asc' },
          take: 50
        });

        const signals = analyzeMetricSignals(snapshot, historicalSnapshots, DEFAULT_VERIFICATION_POLICY);
        const assessment = assessVerificationRisk(signals, DEFAULT_VERIFICATION_POLICY);

        if (assessment.riskLevel === 'HIGH_RISK' || signals.some((s) => s.severity === 'CRITICAL')) {
          const reason = assessment.primaryReasons.join('; ') || 'High risk metric anomaly detected during hourly polling';
          logger.warn(
            { submissionId, riskLevel: assessment.riskLevel, score: assessment.score, reason, correlationId },
            'Continuous suspicion detection flagged anomalous metric trajectory'
          );

          // Idempotency: only transition and notify if not already flagged/post-approval review
          if (submission.status !== 'POST_APPROVAL_REVIEW' && submission.status !== 'FLAGGED') {
            await prisma.submission.update({
              where: { id: submission.id },
              data: {
                status: 'POST_APPROVAL_REVIEW',
                moderatedAt: new Date(),
                moderatedBy: 'SYSTEM',
                moderationNotes: reason
              }
            });

            await prisma.moderationHistory.create({
              data: {
                submissionId: submission.id,
                action: MODERATION_ACTIONS.POST_APPROVAL_REVIEW_STARTED,
                previousStatus: submission.status,
                newStatus: 'POST_APPROVAL_REVIEW',
                actorDiscordId: 'SYSTEM',
                actorType: 'SYSTEM',
                reason,
                evidence: {
                  riskLevel: assessment.riskLevel,
                  score: assessment.score,
                  primaryReasons: assessment.primaryReasons,
                  signalsCount: signals.length
                }
              }
            }).catch(() => {});

            await prisma.auditLog.create({
              data: {
                action: 'METRIC_SUSPICION_FLAGGED',
                entityType: 'SUBMISSION',
                entityId: submission.id,
                actorDiscordId: 'SYSTEM',
                reason,
                metadata: {
                  score: assessment.score,
                  signals: signals.map((s) => s.type)
                }
              }
            }).catch(() => {});

            notifyStaffSuspiciousClip({
              submission,
              reason,
              snapshot,
              signals
            }).catch(() => {});
          }

          return {
            status: 'flagged_suspicious',
            submissionId,
            snapshotId: snapshot.id,
            riskLevel: assessment.riskLevel,
            score: assessment.score,
            durationMs: Date.now() - startTime
          };
        }

        // 6. Trigger incremental earnings crediting if submission is APPROVED
        let earningsResult = null;
        if (submission.status === 'APPROVED') {
          try {
            earningsResult = await earningsService.creditNewEligibleViews(submission.id, snapshot.id);
            logger.info(
              {
                submissionId,
                snapshotId: snapshot.id,
                creditedViews: earningsResult.newlyCreditedViews.toString(),
                grossAmount: earningsResult.grossAmount.toString(),
                correlationId
              },
              'Incremental earnings credited from scheduled snapshot'
            );
          } catch (earningsErr) {
            logger.error(
              { submissionId, snapshotId: snapshot.id, err: earningsErr.message, correlationId },
              'Failed to credit incremental earnings; will retry on next poll'
            );
          }
        }

        return {
          status: 'success',
          submissionId,
          snapshotId: snapshot.id,
          newlyCreditedViews: earningsResult?.newlyCreditedViews ? earningsResult.newlyCreditedViews.toString() : '0',
          durationMs: Date.now() - startTime
        };
      } catch (error) {
        // Error classification & recovery strategy
        if (error instanceof PermanentContentError || error.details?.category === 'PERMANENT_CONTENT') {
          logger.warn(
            { submissionId, correlationId, err: error.message },
            'Permanent content failure encountered; polling terminated without retry'
          );
          return { status: 'failed_permanently', reason: error.message };
        }

        if (error instanceof ConfigurationAuthError || error.details?.category === 'CONFIGURATION_OR_AUTH') {
          logger.error(
            { submissionId, correlationId, err: error.message },
            'Provider configuration/auth error; terminating polling without retry'
          );
          return { status: 'failed_configuration', reason: error.message };
        }

        if (error instanceof RateLimitProviderError || error.status === 429) {
          logger.warn(
            { submissionId, attempt: job.attemptsMade, correlationId, err: error.message },
            'Provider rate limit encountered; enqueued for BullMQ exponential backoff'
          );
          throw error;
        }

        if (error instanceof TransientProviderError || error.details?.retryable) {
          logger.warn(
            { submissionId, attempt: job.attemptsMade, correlationId, err: error.message },
            'Transient provider error; enqueued for BullMQ retry'
          );
          throw error;
        }

        logger.error(
          { submissionId, attempt: job.attemptsMade, correlationId, err: error.message },
          'Unexpected error during metric poll; delegating to BullMQ retry'
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
      'Metric polling worker job exhausted retries'
    );
  });

  return worker;
}
