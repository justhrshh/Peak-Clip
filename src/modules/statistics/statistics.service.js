import { Prisma } from '@prisma/client';
import { statisticsRepository as defaultRepo } from './statistics.repository.js';
import {
  userOverviewInputSchema,
  campaignOverviewInputSchema,
  submissionStatsInputSchema,
  creatorCampaignsInputSchema,
  creatorVideosInputSchema,
  campaignAnalyticsInputSchema
} from './statistics.validation.js';
import {
  UnauthorizedAccessError,
  CampaignMembershipRequiredError,
  SubmissionNotFoundError,
  CampaignNotFoundError
} from './statistics.errors.js';
import { logger } from '../../utils/logger.js';

/**
 * Maps internal submission statuses to safe creator-facing statuses
 * Internal risk levels, tiers, and granular states are strictly STAFF ONLY.
 * @param {string} status
 * @returns {'APPROVED'|'UNDER REVIEW'|'REJECTED'}
 */
export function toCreatorSafeStatus(status) {
  if (status === 'APPROVED') return 'APPROVED';
  if (status === 'REJECTED') return 'REJECTED';
  return 'UNDER REVIEW';
}

export class StatisticsService {
  /**
   * @param {object} [repo=defaultRepo]
   */
  constructor(repo = defaultRepo) {
    this.repo = repo;
  }

  /**
   * Helper to aggregate a specific BigInt metric across multiple submissions' latest snapshots
   * Distinguishes COMPLETE, PARTIAL, and UNAVAILABLE.
   *
   * @param {Array<object>} submissions
   * @param {'views'|'likes'|'comments'|'shares'} metricKey
   * @returns {{ knownSum: bigint|null, availability: 'COMPLETE'|'PARTIAL'|'UNAVAILABLE', countWithMetric: number, totalSubmissions: number }}
   */
  _aggregateMetric(submissions, metricKey) {
    const totalSubmissions = submissions.length;
    if (totalSubmissions === 0) {
      return {
        knownSum: null,
        availability: 'UNAVAILABLE',
        countWithMetric: 0,
        totalSubmissions: 0
      };
    }

    let countWithMetric = 0;
    let sum = 0n;

    for (const sub of submissions) {
      const latestSnapshot = sub.snapshots?.[0];
      const val = latestSnapshot?.[metricKey];

      if (val !== null && val !== undefined) {
        countWithMetric++;
        sum += BigInt(val);
      }
    }

    let availability = 'UNAVAILABLE';
    if (countWithMetric === totalSubmissions) {
      availability = 'COMPLETE';
    } else if (countWithMetric > 0) {
      availability = 'PARTIAL';
    }

    return {
      knownSum: countWithMetric > 0 ? sum : null,
      availability,
      countWithMetric,
      totalSubmissions
    };
  }

  /**
   * Calculate growth between two metric values
   * Handles nulls, zero baseline (no divide by zero), and regressions.
   *
   * @param {bigint|null} baselineVal
   * @param {bigint|null} currentVal
   * @returns {{ delta: bigint|null, growthPercent: number|null, isRegression: boolean }}
   */
  _calculateGrowth(baselineVal, currentVal) {
    if (baselineVal === null || baselineVal === undefined || currentVal === null || currentVal === undefined) {
      return {
        delta: null,
        growthPercent: null,
        isRegression: false
      };
    }

    const baseline = BigInt(baselineVal);
    const current = BigInt(currentVal);
    const delta = current - baseline;
    const isRegression = delta < 0n;

    let growthPercent = null;
    if (baseline > 0n) {
      growthPercent = Number(((Number(delta) / Number(baseline)) * 100).toFixed(2));
    }

    return {
      delta,
      growthPercent,
      isRegression
    };
  }

  /**
   * 1. CREATOR OVERVIEW
   * Derives overall clipping performance and authoritative financial balances for the requesting creator.
   *
   * @param {string} userId
   * @returns {Promise<object>}
   */
  async getUserOverview(userId) {
    const validated = userOverviewInputSchema.parse({ userId });
    logger.debug({ userId: validated.userId }, 'Generating user statistics overview');

    // Concurrently fetch submissions, campaign memberships, and authoritative payout balance
    const [submissions, memberships, payoutBreakdown] = await Promise.all([
      this.repo.getUserSubmissionsWithLatestSnapshots(validated.userId),
      this.repo.getUserCampaignMemberships(validated.userId),
      typeof this.repo.getCreatorPayoutBalances === 'function'
        ? this.repo.getCreatorPayoutBalances(validated.userId)
        : null
    ]);

    // Status counts
    let approvedSubmissions = 0;
    let pendingSubmissions = 0;
    let underReviewSubmissions = 0;
    let flaggedSubmissions = 0;
    let rejectedSubmissions = 0;

    let totalEligibleViews = 0n;
    let latestTimestamp = null;

    for (const sub of submissions) {
      switch (sub.status) {
        case 'APPROVED':
          approvedSubmissions++;
          break;
        case 'PENDING_VERIFICATION':
          pendingSubmissions++;
          break;
        case 'UNDER_REVIEW':
        case 'POST_APPROVAL_REVIEW':
          underReviewSubmissions++;
          break;
        case 'FLAGGED':
          flaggedSubmissions++;
          break;
        case 'REJECTED':
          rejectedSubmissions++;
          break;
      }

      for (const e of sub.earnings || []) {
        totalEligibleViews += BigInt(e.eligibleViews);
      }

      const snapCapturedAt = sub.snapshots?.[0]?.capturedAt;
      const candidateDate = snapCapturedAt || sub.updatedAt || sub.submittedAt;
      if (candidateDate && (!latestTimestamp || new Date(candidateDate) > new Date(latestTimestamp))) {
        latestTimestamp = new Date(candidateDate);
      }
    }

    const totalViews = this._aggregateMetric(submissions, 'views');
    const totalLikes = this._aggregateMetric(submissions, 'likes');
    const totalComments = this._aggregateMetric(submissions, 'comments');
    const totalShares = this._aggregateMetric(submissions, 'shares');

    const totalCampaignsJoined = memberships.length;
    const activeCampaignsJoined = memberships.filter(
      (m) => m.status === 'ACTIVE' && m.campaign?.status === 'ACTIVE'
    ).length;

    return {
      userId: validated.userId,
      totalSubmissions: submissions.length,
      approvedSubmissions,
      pendingSubmissions,
      underReviewSubmissions,
      flaggedSubmissions,
      rejectedSubmissions,
      totalViews,
      totalEligibleViews,
      totalLikes,
      totalComments,
      totalShares,
      totalCampaignsJoined,
      activeCampaignsJoined,
      financials: {
        totalEarned: payoutBreakdown?.totalEarned ? (payoutBreakdown.totalEarned.toFixed ? payoutBreakdown.totalEarned.toFixed(2) : String(payoutBreakdown.totalEarned)) : '0.00',
        availableBalance: payoutBreakdown?.availableBalance ? (payoutBreakdown.availableBalance.toFixed ? payoutBreakdown.availableBalance.toFixed(2) : String(payoutBreakdown.availableBalance)) : '0.00',
        reservedBalance: payoutBreakdown?.reservedBalance ? (payoutBreakdown.reservedBalance.toFixed ? payoutBreakdown.reservedBalance.toFixed(2) : String(payoutBreakdown.reservedBalance)) : '0.00',
        completedPayouts: payoutBreakdown?.completedPayouts ? (payoutBreakdown.completedPayouts.toFixed ? payoutBreakdown.completedPayouts.toFixed(2) : String(payoutBreakdown.completedPayouts)) : '0.00',
        currency: payoutBreakdown?.currency || 'USD'
      },
      lastUpdatedAt: latestTimestamp
    };
  }

  /**
   * 2. CREATOR CAMPAIGN BREAKDOWN
   * Returns paginated list of campaigns creator has joined with budget contributions and cap consumption.
   *
   * @param {string} userId
   * @param {object} [options={}]
   * @returns {Promise<object>}
   */
  async getCreatorCampaigns(userId, options = {}) {
    const validated = creatorCampaignsInputSchema.parse({
      userId,
      page: options.page,
      limit: options.limit
    });

    return this.repo.getCreatorCampaignBreakdown(validated.userId, {
      page: validated.page,
      limit: validated.limit
    });
  }

  /**
   * 3. CREATOR PLATFORM BREAKDOWN
   * Returns performance grouped by platform (YouTube, TikTok, Instagram, Facebook).
   *
   * @param {string} userId
   * @returns {Promise<Array<object>>}
   */
  async getCreatorPlatforms(userId) {
    const validated = userOverviewInputSchema.parse({ userId });
    return this.repo.getCreatorPlatformBreakdown(validated.userId);
  }

  /**
   * 4. CREATOR CHANNEL / ACCOUNT BREAKDOWN
   * Returns performance grouped by creator channel or handle.
   *
   * @param {string} userId
   * @returns {Promise<Array<object>>}
   */
  async getCreatorChannels(userId) {
    const validated = userOverviewInputSchema.parse({ userId });
    return this.repo.getCreatorChannelBreakdown(validated.userId);
  }

  /**
   * 5. CREATOR VIDEO BREAKDOWN
   * Returns paginated list of creator's clips with status, retention, latest views, and linked earnings.
   *
   * @param {string} userId
   * @param {object} [options={}]
   * @returns {Promise<object>}
   */
  async getCreatorVideos(userId, options = {}) {
    const validated = creatorVideosInputSchema.parse({
      userId,
      campaignId: options.campaignId,
      page: options.page,
      limit: options.limit
    });

    return this.repo.getCreatorVideos(validated.userId, {
      campaignId: validated.campaignId,
      page: validated.page,
      limit: validated.limit
    });
  }

  /**
   * 6. CAMPAIGN OVERVIEW (FOR CREATOR)
   * Derives campaign-specific performance for the requesting user.
   *
   * @param {string} userId
   * @param {string} campaignId
   * @returns {Promise<object>}
   */
  async getCampaignOverview(userId, campaignId) {
    const validated = campaignOverviewInputSchema.parse({ userId, campaignId });
    logger.debug({ userId: validated.userId, campaignId: validated.campaignId }, 'Generating campaign statistics overview');

    // 1. Verify campaign exists
    const campaign = await this.repo.getCampaignById(validated.campaignId);
    if (!campaign) {
      throw new CampaignNotFoundError(validated.campaignId);
    }

    // 2. Verify campaign membership (security & business requirement)
    const membership = await this.repo.getCampaignMembership(validated.userId, validated.campaignId);
    if (!membership) {
      throw new CampaignMembershipRequiredError(validated.campaignId);
    }

    // 3. Fetch submissions belonging ONLY to this user and campaign
    const submissions = await this.repo.getUserSubmissionsWithLatestSnapshots(
      validated.userId,
      validated.campaignId
    );

    // Submission counts by status
    let approvedSubmissions = 0;
    let pendingSubmissions = 0;
    let underReviewSubmissions = 0;
    let flaggedSubmissions = 0;
    let rejectedSubmissions = 0;

    let latestActivity = membership.joinedAt ? new Date(membership.joinedAt) : null;
    let lastMetricUpdate = null;

    let bestSubmission = null;
    let bestViewCount = -1n;

    for (const sub of submissions) {
      switch (sub.status) {
        case 'APPROVED':
          approvedSubmissions++;
          break;
        case 'PENDING_VERIFICATION':
          pendingSubmissions++;
          break;
        case 'UNDER_REVIEW':
        case 'POST_APPROVAL_REVIEW':
          underReviewSubmissions++;
          break;
        case 'FLAGGED':
          flaggedSubmissions++;
          break;
        case 'REJECTED':
          rejectedSubmissions++;
          break;
      }

      const candidateActivity = sub.updatedAt || sub.submittedAt;
      if (candidateActivity && (!latestActivity || new Date(candidateActivity) > latestActivity)) {
        latestActivity = new Date(candidateActivity);
      }

      const snap = sub.snapshots?.[0];
      if (snap) {
        const snapDate = snap.capturedAt ? new Date(snap.capturedAt) : null;
        if (snapDate && (!lastMetricUpdate || snapDate > lastMetricUpdate)) {
          lastMetricUpdate = snapDate;
        }

        if (snap.views !== null && snap.views !== undefined) {
          const views = BigInt(snap.views);
          if (views > bestViewCount) {
            bestViewCount = views;
            bestSubmission = {
              id: sub.id,
              platform: sub.platform,
              url: sub.url,
              normalizedUrl: sub.normalizedUrl,
              status: sub.status,
              views,
              likes: snap.likes !== null && snap.likes !== undefined ? BigInt(snap.likes) : null,
              comments: snap.comments !== null && snap.comments !== undefined ? BigInt(snap.comments) : null,
              shares: snap.shares !== null && snap.shares !== undefined ? BigInt(snap.shares) : null,
              capturedAt: snap.capturedAt
            };
          } else if (views === bestViewCount && bestSubmission) {
            const bestDate = bestSubmission.capturedAt ? new Date(bestSubmission.capturedAt).getTime() : 0;
            const curDate = snap.capturedAt ? new Date(snap.capturedAt).getTime() : 0;
            if (curDate > bestDate || (curDate === bestDate && sub.id.localeCompare(bestSubmission.id) > 0)) {
              bestSubmission = {
                id: sub.id,
                platform: sub.platform,
                url: sub.url,
                normalizedUrl: sub.normalizedUrl,
                status: sub.status,
                views,
                likes: snap.likes !== null && snap.likes !== undefined ? BigInt(snap.likes) : null,
                comments: snap.comments !== null && snap.comments !== undefined ? BigInt(snap.comments) : null,
                shares: snap.shares !== null && snap.shares !== undefined ? BigInt(snap.shares) : null,
                capturedAt: snap.capturedAt
              };
            }
          }
        }
      }
    }

    const currentTotalViews = this._aggregateMetric(submissions, 'views');
    const currentTotalLikes = this._aggregateMetric(submissions, 'likes');
    const currentTotalComments = this._aggregateMetric(submissions, 'comments');
    const currentTotalShares = this._aggregateMetric(submissions, 'shares');

    return {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        slug: campaign.slug,
        status: campaign.status,
        clientName: campaign.clientName
      },
      membership: {
        status: membership.status,
        joinedAt: membership.joinedAt
      },
      totalSubmissions: submissions.length,
      approvedSubmissions,
      pendingSubmissions,
      underReviewSubmissions,
      flaggedSubmissions,
      rejectedSubmissions,
      currentTotalViews,
      currentTotalLikes,
      currentTotalComments,
      currentTotalShares,
      bestPerformingSubmission: bestSubmission,
      latestActivity,
      lastMetricUpdate
    };
  }

  /**
   * 7. INDIVIDUAL SUBMISSION STATISTICS & VIEW GROWTH
   * Derives individual clip performance, historical growth, and engagement for the owner.
   *
   * @param {string} userId
   * @param {string} submissionId
   * @returns {Promise<object>}
   */
  async getSubmissionStatistics(userId, submissionId) {
    const validated = submissionStatsInputSchema.parse({ userId, submissionId });
    logger.debug({ userId: validated.userId, submissionId: validated.submissionId }, 'Generating submission statistics');

    const submission = await this.repo.getSubmissionWithHistory(validated.submissionId);
    if (!submission) {
      throw new SubmissionNotFoundError(validated.submissionId);
    }

    // Access control: strictly verify the requesting user is the owner
    if (submission.userId !== validated.userId) {
      throw new UnauthorizedAccessError('You do not have permission to view statistics for this submission.');
    }

    const snapshots = submission.snapshots || [];
    const hasEnoughHistory = snapshots.length >= 2;
    const firstSnapshot = snapshots.length > 0 ? snapshots[0] : null;
    const previousSnapshot = snapshots.length > 1 ? snapshots[snapshots.length - 2] : null;
    const latestSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;

    const currentMetrics = {
      views: latestSnapshot?.views !== null && latestSnapshot?.views !== undefined ? BigInt(latestSnapshot.views) : null,
      likes: latestSnapshot?.likes !== null && latestSnapshot?.likes !== undefined ? BigInt(latestSnapshot.likes) : null,
      comments: latestSnapshot?.comments !== null && latestSnapshot?.comments !== undefined ? BigInt(latestSnapshot.comments) : null,
      shares: latestSnapshot?.shares !== null && latestSnapshot?.shares !== undefined ? BigInt(latestSnapshot.shares) : null
    };

    // Metric availability resolution
    const metadataAvailability = latestSnapshot?.metadata?.availability || {};
    const metricAvailability = {
      views: metadataAvailability.views || (currentMetrics.views !== null ? 'AVAILABLE' : 'UNAVAILABLE'),
      likes: metadataAvailability.likes || (currentMetrics.likes !== null ? 'AVAILABLE' : 'UNAVAILABLE'),
      comments: metadataAvailability.comments || (currentMetrics.comments !== null ? 'AVAILABLE' : 'UNAVAILABLE'),
      shares: metadataAvailability.shares || (currentMetrics.shares !== null ? 'AVAILABLE' : 'UNAVAILABLE')
    };

    // Growth calculations (First vs. Latest snapshot)
    const viewGrowth = hasEnoughHistory
      ? this._calculateGrowth(firstSnapshot?.views, latestSnapshot?.views)
      : { delta: null, growthPercent: null, isRegression: false };
    const likeGrowth = hasEnoughHistory
      ? this._calculateGrowth(firstSnapshot?.likes, latestSnapshot?.likes)
      : { delta: null, growthPercent: null, isRegression: false };
    const commentGrowth = hasEnoughHistory
      ? this._calculateGrowth(firstSnapshot?.comments, latestSnapshot?.comments)
      : { delta: null, growthPercent: null, isRegression: false };
    const shareGrowth = hasEnoughHistory
      ? this._calculateGrowth(firstSnapshot?.shares, latestSnapshot?.shares)
      : { delta: null, growthPercent: null, isRegression: false };

    // Recent delta (Previous vs. Latest snapshot)
    const recentViewGrowth = hasEnoughHistory
      ? this._calculateGrowth(previousSnapshot?.views, latestSnapshot?.views)
      : { delta: null, growthPercent: null, isRegression: false };

    // Engagement rate calculation
    let engagementRate = null;
    let knownEngagementRate = null;

    if (currentMetrics.views !== null && currentMetrics.views > 0n) {
      const viewsNum = Number(currentMetrics.views);

      if (currentMetrics.likes !== null && currentMetrics.comments !== null && currentMetrics.shares !== null) {
        const totalEng = Number(currentMetrics.likes) + Number(currentMetrics.comments) + Number(currentMetrics.shares);
        engagementRate = Number(((totalEng / viewsNum) * 100).toFixed(2));
      }

      if (currentMetrics.likes !== null || currentMetrics.comments !== null) {
        const knownEng =
          Number(currentMetrics.likes ?? 0n) +
          Number(currentMetrics.comments ?? 0n) +
          Number(currentMetrics.shares ?? 0n);
        knownEngagementRate = Number(((knownEng / viewsNum) * 100).toFixed(2));
      }
    }

    // Phase 10G Security: Internal risk information (LOW_RISK, REVIEW_REQUIRED, HIGH_RISK, scores, signals) is strictly STAFF ONLY.
    // Creators may see only safe statuses: APPROVED, UNDER REVIEW, REJECTED.
    const safeStatus = toCreatorSafeStatus(submission.status);

    // Authoritative earnings attached to this clip
    let eligibleViews = 0n;
    let grossEarnings = new Prisma.Decimal('0.00');
    for (const e of submission.earnings || []) {
      eligibleViews += BigInt(e.eligibleViews);
      grossEarnings = grossEarnings.plus(new Prisma.Decimal(e.grossAmount));
    }

    return {
      submission: {
        id: submission.id,
        platform: submission.platform,
        url: submission.url,
        normalizedUrl: submission.normalizedUrl,
        status: safeStatus,
        rawStatus: submission.status,
        submittedAt: submission.submittedAt,
        verifiedAt: submission.verifiedAt,
        rejectionReason: submission.rejectionReason,
        retentionStatus: submission.retentionStatus,
        retentionRequired: submission.retentionRequired,
        retentionDeadline: submission.retentionDeadline,
        durationSeconds: submission.durationSeconds
      },
      campaign: {
        id: submission.campaign.id,
        name: submission.campaign.name,
        slug: submission.campaign.slug,
        status: submission.campaign.status
      },
      currentMetrics,
      metricAvailability,
      financials: {
        eligibleViews,
        grossEarnings: grossEarnings.toFixed(2)
      },
      hasEnoughHistory,
      growth: {
        views: viewGrowth,
        likes: likeGrowth,
        comments: commentGrowth,
        shares: shareGrowth,
        recentViewsDelta: recentViewGrowth.delta,
        recentViewsGrowthPercent: recentViewGrowth.growthPercent
      },
      engagement: {
        engagementRate,
        knownEngagementRate
      },
      firstObservedAt: firstSnapshot?.capturedAt || null,
      lastObservedAt: latestSnapshot?.capturedAt || null,
      snapshotsCount: snapshots.length
    };
  }

  /**
   * 8. CAMPAIGN ANALYTICS & REPORTING (ADMIN)
   * Detailed campaign analytics report with reach, platform, channel, neutral creator table, and reconciliation.
   *
   * @param {string} campaignId
   * @param {object} [options={}]
   * @returns {Promise<object>}
   */
  async getCampaignReport(campaignId, options = {}) {
    const validated = campaignAnalyticsInputSchema.parse({
      campaignId,
      page: options.page,
      limit: options.limit,
      sortBy: options.sortBy,
      sortOrder: options.sortOrder
    });

    const report = await this.repo.getCampaignAnalytics(validated.campaignId, {
      page: validated.page,
      limit: validated.limit,
      sortBy: validated.sortBy,
      sortOrder: validated.sortOrder
    });

    if (!report) {
      throw new CampaignNotFoundError(validated.campaignId);
    }

    return report;
  }
}

export const statisticsService = new StatisticsService();
export default statisticsService;
