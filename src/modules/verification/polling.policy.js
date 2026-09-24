import { hasProviderCapability } from '../../providers/capabilities.js';
import { logger } from '../../utils/logger.js';

/**
 * Historical tracking grace period after campaign ends (in milliseconds)
 * Allows collecting final engagement views for clips created before campaign concluded.
 */
export const CAMPAIGN_POLL_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Centralized evaluation of submission polling eligibility
 *
 * @param {object} submission
 * @param {object} [options={}]
 * @param {Date} [options.now=new Date()]
 * @returns {{ eligible: boolean, reason: string }}
 */
export function evaluatePollingEligibility(submission, options = {}) {
  const now = options.now || new Date();

  if (!submission) {
    return { eligible: false, reason: 'SUBMISSION_NOT_FOUND' };
  }

  // 1. Must be APPROVED (only approved clips participate in metrics and earnings)
  if (submission.status !== 'APPROVED') {
    return { eligible: false, reason: `INELIGIBLE_STATUS_${submission.status}` };
  }

  // 2. Must not be soft-deleted or rejected
  if (submission.deletedAt) {
    return { eligible: false, reason: 'SUBMISSION_DELETED' };
  }

  // 3. Creator must be ACTIVE (not suspended or banned)
  if (submission.user && submission.user.status !== 'ACTIVE') {
    return { eligible: false, reason: `CREATOR_STATUS_${submission.user.status}` };
  }

  // 4. Platform must support metric retrieval
  if (!hasProviderCapability(submission.platform, 'fetchViews')) {
    return { eligible: false, reason: `PLATFORM_${submission.platform}_METRICS_UNSUPPORTED` };
  }

  // 5. Campaign must permit tracking
  if (!submission.campaign) {
    return { eligible: false, reason: 'CAMPAIGN_NOT_FOUND' };
  }

  const camp = submission.campaign;
  if (camp.status === 'DRAFT' || camp.status === 'ARCHIVED') {
    return { eligible: false, reason: `CAMPAIGN_STATUS_${camp.status}` };
  }

  // If campaign is ENDED, verify if within post-end grace period
  if (camp.status === 'ENDED' || (camp.endDate && new Date(camp.endDate) < now)) {
    const endThreshold = camp.endDate ? new Date(camp.endDate).getTime() : 0;
    const elapsedSinceEnd = now.getTime() - endThreshold;
    if (elapsedSinceEnd > CAMPAIGN_POLL_GRACE_PERIOD_MS) {
      return { eligible: false, reason: 'CAMPAIGN_TRACKING_WINDOW_EXPIRED' };
    }
  }

  return { eligible: true, reason: 'ELIGIBLE' };
}

/**
 * Convenient boolean helper
 * @param {object} submission
 * @param {object} [options={}]
 * @returns {boolean}
 */
export function isSubmissionEligibleForPolling(submission, options = {}) {
  return evaluatePollingEligibility(submission, options).eligible;
}

/**
 * Compare two metric sets to determine if values have changed.
 *
 * Deterministic Metric Snapshot Policy (Policy A):
 * To prevent database bloat and excessive row generation, if all metrics
 * (views, likes, comments) are exactly identical to the most recent snapshot,
 * we DO NOT insert a duplicate MetricSnapshot record.
 * A new snapshot is created ONLY when at least one metric has changed.
 *
 * Preserves:
 * - null: unknown / unavailable metric
 * - 0: actual known zero
 *
 * @param {object|null} latestSnapshot
 * @param {object} newMetrics
 * @returns {boolean} True if metrics changed or no previous snapshot exists
 */
export function hasMetricsChanged(latestSnapshot, newMetrics) {
  if (!latestSnapshot) return true;

  const compareMetric = (valA, valB) => {
    if (valA === null || valA === undefined) {
      return valB === null || valB === undefined;
    }
    if (valB === null || valB === undefined) {
      return false;
    }
    return BigInt(valA) === BigInt(valB);
  };

  const viewsSame = compareMetric(latestSnapshot.views, newMetrics.views);
  const likesSame = compareMetric(latestSnapshot.likes, newMetrics.likes);
  const commentsSame = compareMetric(latestSnapshot.comments, newMetrics.comments);

  // If all known metrics are identical, return false (no change)
  return !(viewsSame && likesSame && commentsSame);
}

/**
 * Find batch of approved submissions eligible for scheduled polling from database
 * Uses cursor-based pagination for bounded memory consumption.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {object} [params={}]
 * @param {number} [params.batchSize=50]
 * @param {string} [params.cursor=null]
 * @returns {Promise<Array<object>>}
 */
export async function findEligibleSubmissionsBatch(prisma, { batchSize = 50, cursor = null } = {}) {
  const where = {
    status: 'APPROVED',
    campaign: {
      status: { in: ['ACTIVE', 'PAUSED'] }
    },
    user: {
      status: 'ACTIVE'
    }
  };

  const query = {
    where,
    take: batchSize,
    orderBy: { id: 'asc' },
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
  };

  if (cursor) {
    query.skip = 1;
    query.cursor = { id: cursor };
  }

  const submissions = await prisma.submission.findMany(query);
  return submissions.filter((sub) => isSubmissionEligibleForPolling(sub));
}
