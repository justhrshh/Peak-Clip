import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { StatisticsService } from '../src/modules/statistics/statistics.service.js';
import {
  UnauthorizedAccessError,
  CampaignNotFoundError
} from '../src/modules/statistics/statistics.errors.js';
import {
  buildUserOverviewEmbed,
  buildCreatorCampaignsEmbed,
  buildCreatorPlatformsEmbed,
  buildCreatorChannelsEmbed,
  buildStatsClipListEmbed,
  buildAdminCampaignReportEmbed,
  formatGrowthDisplay,
  formatMetricCount
} from '../src/bot/embeds/statistics.embeds.js';
import {
  buildUserOverviewActionRow,
  buildCampaignPaginationRow,
  buildPlatformBackRow,
  buildChannelBackRow
} from '../src/bot/components/statistics.components.js';

function createMockAnalyticsRepo() {
  const users = new Map();
  const campaigns = new Map();
  const memberships = new Map(); // key: `${userId}_${campaignId}`
  const submissions = new Map(); // key: submissionId
  const snapshots = [];
  const earnings = []; // array of { id, userId, campaignId, submissionId, eligibleViews, grossAmount, status }
  const adjustments = []; // array of { id, userId, campaignId, submissionId, amount, currency }
  const payoutRequests = []; // array of { id, userId, amount, status, currency }

  return {
    users,
    campaigns,
    memberships,
    submissions,
    snapshots,
    earnings,
    adjustments,
    payoutRequests,

    async getCampaignById(campaignId) {
      return campaigns.get(campaignId) || null;
    },

    async getCampaignMembership(userId, campaignId) {
      const key = `${userId}_${campaignId}`;
      const m = memberships.get(key);
      if (!m) return null;
      return { ...m, campaign: campaigns.get(campaignId) };
    },

    async getUserCampaignMemberships(userId) {
      const list = [];
      for (const m of memberships.values()) {
        if (m.userId === userId) {
          list.push({ ...m, campaign: campaigns.get(m.campaignId) });
        }
      }
      return list.sort((a, b) => new Date(b.joinedAt) - new Date(a.joinedAt));
    },

    async getUserSubmissionsWithLatestSnapshots(userId, campaignId = null) {
      const list = [];
      for (const sub of submissions.values()) {
        if (sub.userId !== userId) continue;
        if (campaignId && sub.campaignId !== campaignId) continue;

        const subSnaps = snapshots
          .filter((s) => s.submissionId === sub.id)
          .sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));
        const latestSnap = subSnaps.length > 0 ? [subSnaps[0]] : [];

        const subEarnings = earnings.filter((e) => e.submissionId === sub.id && e.status === 'ELIGIBLE');

        list.push({
          ...sub,
          campaign: campaigns.get(sub.campaignId),
          snapshots: latestSnap,
          earnings: subEarnings
        });
      }
      return list.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    },

    async getSubmissionWithHistory(submissionId) {
      const sub = submissions.get(submissionId);
      if (!sub) return null;

      const subSnaps = snapshots
        .filter((s) => s.submissionId === sub.id)
        .sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));

      const subEarnings = earnings.filter((e) => e.submissionId === sub.id && e.status === 'ELIGIBLE');

      return {
        ...sub,
        campaign: campaigns.get(sub.campaignId),
        snapshots: subSnaps,
        earnings: subEarnings,
        verifications: []
      };
    },

    async getCreatorPayoutBalances(userId, currency = 'USD') {
      let eligibleEarnings = new Prisma.Decimal('0.00');
      for (const e of earnings) {
        if (e.userId === userId && e.status === 'ELIGIBLE') {
          eligibleEarnings = eligibleEarnings.plus(new Prisma.Decimal(e.grossAmount));
        }
      }

      let netAdjustments = new Prisma.Decimal('0.00');
      for (const a of adjustments) {
        if (a.userId === userId) {
          netAdjustments = netAdjustments.plus(new Prisma.Decimal(a.amount));
        }
      }

      let reservedBalance = new Prisma.Decimal('0.00');
      let completedPayouts = new Prisma.Decimal('0.00');
      for (const p of payoutRequests) {
        if (p.userId === userId) {
          if (['REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING'].includes(p.status)) {
            reservedBalance = reservedBalance.plus(new Prisma.Decimal(p.amount));
          } else if (p.status === 'COMPLETED') {
            completedPayouts = completedPayouts.plus(new Prisma.Decimal(p.amount));
          }
        }
      }

      const totalEarned = eligibleEarnings.plus(netAdjustments);
      let availableBalance = totalEarned.minus(reservedBalance).minus(completedPayouts);
      if (availableBalance.lessThan(0)) availableBalance = new Prisma.Decimal('0.00');

      return {
        userId,
        currency,
        eligibleEarnings,
        netAdjustments,
        totalEarned,
        reservedBalance,
        completedPayouts,
        availableBalance
      };
    },

    async getCreatorCampaignBreakdown(userId, { page = 1, limit = 5 } = {}) {
      const userMemberships = [];
      for (const m of memberships.values()) {
        if (m.userId === userId) {
          userMemberships.push({ ...m, campaign: campaigns.get(m.campaignId) });
        }
      }

      userMemberships.sort((a, b) => new Date(b.joinedAt) - new Date(a.joinedAt));
      const total = userMemberships.length;
      const skip = (page - 1) * limit;
      const paged = userMemberships.slice(skip, skip + limit);

      const items = paged.map((m) => {
        const camp = m.campaign;
        const campSubs = Array.from(submissions.values()).filter(
          (s) => s.userId === userId && s.campaignId === camp.id
        );

        let approvedClips = 0;
        let underReviewClips = 0;
        let rejectedClips = 0;
        let observedViewsSum = 0n;
        let eligibleViewsSum = 0n;
        let grossEarnings = new Prisma.Decimal('0.00');

        for (const s of campSubs) {
          if (s.status === 'APPROVED') approvedClips++;
          else if (['PENDING_VERIFICATION', 'UNDER_REVIEW', 'FLAGGED'].includes(s.status)) underReviewClips++;
          else if (s.status === 'REJECTED') rejectedClips++;

          const sSnaps = snapshots
            .filter((sn) => sn.submissionId === s.id)
            .sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));
          if (sSnaps.length > 0 && sSnaps[0].views !== null && sSnaps[0].views !== undefined) {
            observedViewsSum += BigInt(sSnaps[0].views);
          }

          const sEarns = earnings.filter((e) => e.submissionId === s.id && e.status === 'ELIGIBLE');
          for (const e of sEarns) {
            eligibleViewsSum += BigInt(e.eligibleViews);
            grossEarnings = grossEarnings.plus(new Prisma.Decimal(e.grossAmount));
          }
        }

        let netAdj = new Prisma.Decimal('0.00');
        for (const a of adjustments) {
          if (a.userId === userId && a.campaignId === camp.id) {
            netAdj = netAdj.plus(new Prisma.Decimal(a.amount));
          }
        }

        const totalEarned = grossEarnings.plus(netAdj);
        const cap = new Prisma.Decimal(camp.creatorEarningCap || 600);
        let capConsumedPercent = 0;
        if (cap.greaterThan(0)) {
          capConsumedPercent = Number(totalEarned.dividedBy(cap).times(100).toFixed(2));
        }

        return {
          campaignId: camp.id,
          campaignName: camp.name,
          campaignSlug: camp.slug,
          campaignStatus: camp.status,
          clientName: camp.clientName,
          cpm: new Prisma.Decimal(camp.payRate).toFixed(2),
          creatorEarningCap: cap.toFixed(2),
          currency: camp.currency,
          joinedAt: m.joinedAt,
          clips: {
            total: campSubs.length,
            approved: approvedClips,
            underReview: underReviewClips,
            rejected: rejectedClips
          },
          totalObservedViews: observedViewsSum,
          totalEligibleViews: eligibleViewsSum,
          grossEarnings: grossEarnings.toFixed(2),
          netAdjustments: netAdj.toFixed(2),
          totalEarned: totalEarned.toFixed(2),
          capConsumedPercent
        };
      });

      return {
        items,
        total,
        page,
        totalPages: Math.ceil(total / limit) || 1
      };
    },

    async getCreatorPlatformBreakdown(userId) {
      const userSubs = Array.from(submissions.values()).filter((s) => s.userId === userId);
      return ['YOUTUBE', 'TIKTOK', 'INSTAGRAM', 'FACEBOOK'].map((plat) => {
        const platSubs = userSubs.filter((s) => s.platform === plat);
        let approvedClips = 0;
        let underReviewClips = 0;
        let rejectedClips = 0;
        let clipsWithViews = 0;
        let observedViewsSum = 0n;
        let eligibleViewsSum = 0n;
        let totalEarnings = new Prisma.Decimal('0.00');

        for (const s of platSubs) {
          if (s.status === 'APPROVED') approvedClips++;
          else if (['PENDING_VERIFICATION', 'UNDER_REVIEW'].includes(s.status)) underReviewClips++;
          else if (s.status === 'REJECTED') rejectedClips++;

          const sSnaps = snapshots
            .filter((sn) => sn.submissionId === s.id)
            .sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));
          if (sSnaps.length > 0 && sSnaps[0].views !== null && sSnaps[0].views !== undefined) {
            clipsWithViews++;
            observedViewsSum += BigInt(sSnaps[0].views);
          }

          const sEarns = earnings.filter((e) => e.submissionId === s.id && e.status === 'ELIGIBLE');
          for (const e of sEarns) {
            eligibleViewsSum += BigInt(e.eligibleViews);
            totalEarnings = totalEarnings.plus(new Prisma.Decimal(e.grossAmount));
          }
        }

        let availability = 'UNAVAILABLE';
        if (platSubs.length > 0 && clipsWithViews === platSubs.length) availability = 'COMPLETE';
        else if (clipsWithViews > 0) availability = 'PARTIAL';

        return {
          platform: plat,
          clips: {
            total: platSubs.length,
            approved: approvedClips,
            underReview: underReviewClips,
            rejected: rejectedClips
          },
          observedViews: {
            sum: clipsWithViews > 0 ? observedViewsSum : null,
            availability,
            countWithViews: clipsWithViews,
            totalClips: platSubs.length
          },
          eligibleViews: eligibleViewsSum,
          totalEarnings: totalEarnings.toFixed(2)
        };
      });
    },

    async getCreatorChannelBreakdown(userId) {
      const userSubs = Array.from(submissions.values()).filter((s) => s.userId === userId);
      const channelMap = new Map();

      for (const s of userSubs) {
        const sSnaps = snapshots
          .filter((sn) => sn.submissionId === s.id)
          .sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));
        const meta = sSnaps[0]?.metadata || {};
        const chName = meta.channelTitle || 'Unknown / Unspecified';
        const key = `${s.platform}:${chName}`;

        if (!channelMap.has(key)) {
          channelMap.set(key, {
            channelName: chName,
            platform: s.platform,
            totalClips: 0,
            approvedClips: 0,
            observedViews: 0n,
            hasViews: false,
            eligibleViews: 0n,
            totalEarnings: new Prisma.Decimal('0.00')
          });
        }

        const entry = channelMap.get(key);
        entry.totalClips++;
        if (s.status === 'APPROVED') entry.approvedClips++;
        if (sSnaps[0]?.views !== null && sSnaps[0]?.views !== undefined) {
          entry.hasViews = true;
          entry.observedViews += BigInt(sSnaps[0].views);
        }

        const sEarns = earnings.filter((e) => e.submissionId === s.id && e.status === 'ELIGIBLE');
        for (const e of sEarns) {
          entry.eligibleViews += BigInt(e.eligibleViews);
          entry.totalEarnings = entry.totalEarnings.plus(new Prisma.Decimal(e.grossAmount));
        }
      }

      return Array.from(channelMap.values()).map((ch) => ({
        channelName: ch.channelName,
        platform: ch.platform,
        clips: { total: ch.totalClips, approved: ch.approvedClips },
        observedViews: ch.hasViews ? ch.observedViews : null,
        eligibleViews: ch.eligibleViews,
        totalEarnings: ch.totalEarnings.toFixed(2)
      }));
    },

    async getCreatorVideos(userId, { campaignId = null, page = 1, limit = 10 } = {}) {
      let userSubs = Array.from(submissions.values()).filter((s) => s.userId === userId);
      if (campaignId && campaignId !== 'all') {
        userSubs = userSubs.filter((s) => s.campaignId === campaignId);
      }

      userSubs.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
      const total = userSubs.length;
      const skip = (page - 1) * limit;
      const paged = userSubs.slice(skip, skip + limit);

      const items = paged.map((s) => {
        const sSnaps = snapshots
          .filter((sn) => sn.submissionId === s.id)
          .sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));
        const snap = sSnaps[0] || null;

        let eligibleViews = 0n;
        let grossEarnings = new Prisma.Decimal('0.00');
        const sEarns = earnings.filter((e) => e.submissionId === s.id && e.status === 'ELIGIBLE');
        for (const e of sEarns) {
          eligibleViews += BigInt(e.eligibleViews);
          grossEarnings = grossEarnings.plus(new Prisma.Decimal(e.grossAmount));
        }

        return {
          id: s.id,
          title: snap?.metadata?.title || null,
          url: s.url,
          normalizedUrl: s.normalizedUrl,
          platform: s.platform,
          status: s.status,
          campaign: campaigns.get(s.campaignId),
          submittedAt: s.submittedAt,
          verifiedAt: s.verifiedAt,
          rejectionReason: s.rejectionReason,
          retentionStatus: s.retentionStatus || 'NOT_REQUIRED',
          retentionRequired: s.retentionRequired || false,
          retentionDeadline: s.retentionDeadline || null,
          durationSeconds: s.durationSeconds || null,
          riskLevel: s.riskLevel || null,
          latestViews: snap?.views !== null && snap?.views !== undefined ? BigInt(snap.views) : null,
          eligibleViews,
          grossEarnings: grossEarnings.toFixed(2),
          netAdjustments: '0.00',
          totalEarned: grossEarnings.toFixed(2),
          lastCapturedAt: snap?.capturedAt || null
        };
      });

      return {
        items,
        total,
        page,
        totalPages: Math.ceil(total / limit) || 1
      };
    },

    async getCampaignAnalytics(campaignId, { page = 1, limit = 10, sortBy = 'views', sortOrder = 'desc' } = {}) {
      const camp = campaigns.get(campaignId);
      if (!camp) return null;

      const campSubs = Array.from(submissions.values()).filter((s) => s.campaignId === campaignId);
      const campEarns = earnings.filter((e) => e.campaignId === campaignId && e.status === 'ELIGIBLE');
      const campAdjs = adjustments.filter((a) => a.campaignId === campaignId);
      const campMembers = Array.from(memberships.values()).filter((m) => m.campaignId === campaignId);

      const statusCounts = {
        APPROVED: 0,
        PENDING_VERIFICATION: 0,
        UNDER_REVIEW: 0,
        FLAGGED: 0,
        POST_APPROVAL_REVIEW: 0,
        REJECTED: 0
      };

      let totalObservedViews = 0n;
      for (const s of campSubs) {
        if (statusCounts[s.status] !== undefined) statusCounts[s.status]++;
        const sSnaps = snapshots
          .filter((sn) => sn.submissionId === s.id)
          .sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));
        if (sSnaps.length > 0 && sSnaps[0].views !== null && sSnaps[0].views !== undefined) {
          totalObservedViews += BigInt(sSnaps[0].views);
        }
      }

      let totalEligibleViews = 0n;
      let totalCreditedEarnings = new Prisma.Decimal('0.00');
      for (const e of campEarns) {
        totalEligibleViews += BigInt(e.eligibleViews);
        totalCreditedEarnings = totalCreditedEarnings.plus(new Prisma.Decimal(e.grossAmount));
      }

      let netAdjustments = new Prisma.Decimal('0.00');
      for (const a of campAdjs) {
        netAdjustments = netAdjustments.plus(new Prisma.Decimal(a.amount));
      }

      const totalBudgetLoad = totalCreditedEarnings.plus(netAdjustments);
      const totalBudget = new Prisma.Decimal(camp.totalBudget || 0);
      const consumedBudget = new Prisma.Decimal(camp.consumedBudget || 0);
      const remainingBudget = Prisma.Decimal.max(0, totalBudget.minus(consumedBudget));
      let fulfillmentPercent = 0;
      if (totalBudget.greaterThan(0)) {
        fulfillmentPercent = Number(consumedBudget.dividedBy(totalBudget).times(100).toFixed(2));
      }

      // Creator table
      const creatorMap = new Map();
      for (const m of campMembers) {
        const u = users.get(m.userId) || { id: m.userId, discordId: m.userId, username: 'Creator' };
        creatorMap.set(m.userId, {
          userId: m.userId,
          discordId: u.discordId,
          username: u.username,
          displayName: u.displayName || u.username,
          totalClips: 0,
          approvedClips: 0,
          eligibleViews: 0n,
          observedViews: 0n,
          creditedEarnings: new Prisma.Decimal('0.00'),
          lastActivity: m.joinedAt
        });
      }

      for (const s of campSubs) {
        if (!creatorMap.has(s.userId)) {
          const u = users.get(s.userId) || { id: s.userId, discordId: s.userId, username: 'Creator' };
          creatorMap.set(s.userId, {
            userId: s.userId,
            discordId: u.discordId,
            username: u.username,
            displayName: u.displayName || u.username,
            totalClips: 0,
            approvedClips: 0,
            eligibleViews: 0n,
            observedViews: 0n,
            creditedEarnings: new Prisma.Decimal('0.00'),
            lastActivity: s.submittedAt
          });
        }
        const c = creatorMap.get(s.userId);
        c.totalClips++;
        if (s.status === 'APPROVED') c.approvedClips++;

        const sSnaps = snapshots
          .filter((sn) => sn.submissionId === s.id)
          .sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));
        if (sSnaps.length > 0 && sSnaps[0].views !== null && sSnaps[0].views !== undefined) {
          c.observedViews += BigInt(sSnaps[0].views);
        }
        if (new Date(s.submittedAt) > new Date(c.lastActivity)) c.lastActivity = s.submittedAt;
      }

      for (const e of campEarns) {
        const c = creatorMap.get(e.userId);
        if (c) {
          c.eligibleViews += BigInt(e.eligibleViews);
          c.creditedEarnings = c.creditedEarnings.plus(new Prisma.Decimal(e.grossAmount));
        }
      }

      for (const a of campAdjs) {
        const c = creatorMap.get(a.userId);
        if (c) {
          c.creditedEarnings = c.creditedEarnings.plus(new Prisma.Decimal(a.amount));
        }
      }

      const capDecimal = new Prisma.Decimal(camp.creatorEarningCap || 600);
      const allCreators = Array.from(creatorMap.values()).map((c) => {
        let capUsedPercent = 0;
        if (capDecimal.greaterThan(0)) {
          capUsedPercent = Number(c.creditedEarnings.dividedBy(capDecimal).times(100).toFixed(2));
        }
        return {
          userId: c.userId,
          discordId: c.discordId,
          username: c.username,
          displayName: c.displayName,
          totalClips: c.totalClips,
          approvedClips: c.approvedClips,
          eligibleViews: c.eligibleViews,
          observedViews: c.observedViews,
          creditedEarnings: c.creditedEarnings.toFixed(2),
          capUsedPercent,
          lastActivity: c.lastActivity
        };
      });

      allCreators.sort((a, b) => {
        let cmp = 0;
        if (sortBy === 'views') {
          if (a.eligibleViews > b.eligibleViews) cmp = 1;
          else if (a.eligibleViews < b.eligibleViews) cmp = -1;
        } else if (sortBy === 'earnings') {
          cmp = new Prisma.Decimal(a.creditedEarnings).comparedTo(new Prisma.Decimal(b.creditedEarnings));
        } else if (sortBy === 'clips') {
          cmp = a.totalClips - b.totalClips;
        } else if (sortBy === 'activity') {
          cmp = new Date(a.lastActivity).getTime() - new Date(b.lastActivity).getTime();
        }
        return sortOrder === 'asc' ? cmp : -cmp;
      });

      const totalCreators = allCreators.length;
      const skip = (page - 1) * limit;
      const paginatedCreators = allCreators.slice(skip, skip + limit);

      let avgCredited = new Prisma.Decimal('0.00');
      if (totalCreators > 0) {
        avgCredited = totalCreditedEarnings.dividedBy(totalCreators).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      }

      return {
        campaign: {
          id: camp.id,
          name: camp.name,
          slug: camp.slug,
          clientName: camp.clientName,
          status: camp.status,
          cpm: new Prisma.Decimal(camp.payRate).toFixed(2),
          creatorEarningCap: capDecimal.toFixed(2),
          currency: camp.currency,
          startsAt: camp.startsAt,
          endsAt: camp.endsAt,
          retentionRequired: camp.retentionRequired,
          retentionDays: camp.retentionDays
        },
        overview: {
          totalSubmissions: campSubs.length,
          statusBreakdown: statusCounts,
          activeMembers: campMembers.length,
          totalMembers: campMembers.length
        },
        reach: {
          totalObservedViews,
          totalEligibleViews
        },
        financial: {
          totalBudget: totalBudget.toFixed(2),
          consumedBudget: consumedBudget.toFixed(2),
          remainingBudget: remainingBudget.toFixed(2),
          fulfillmentPercent,
          totalCreditedEarnings: totalCreditedEarnings.toFixed(2),
          netAdjustments: netAdjustments.toFixed(2),
          totalCreators,
          avgCreditedEarning: avgCredited.toFixed(2)
        },
        platforms: [],
        channels: [],
        creators: {
          items: paginatedCreators,
          total: totalCreators,
          page,
          totalPages: Math.ceil(totalCreators / limit) || 1,
          sortBy,
          sortOrder
        },
        financialReconciliation: {
          totalBudget: totalBudget.toFixed(2),
          consumedBudget: consumedBudget.toFixed(2),
          remainingBudget: remainingBudget.toFixed(2),
          fulfillmentPercent,
          reconciledGrossEarnings: totalCreditedEarnings.toFixed(2),
          reconciledNetAdjustments: netAdjustments.toFixed(2),
          reconciledTotalLoad: totalBudgetLoad.toFixed(2),
          budgetDiscrepancy: consumedBudget.minus(totalBudgetLoad).toFixed(2),
          isReconciled: consumedBudget.equals(totalBudgetLoad)
        }
      };
    }
  };
}

describe('Phase 10F — Creator Analytics & Campaign Reporting', () => {
  // ----------------------------------------------------
  // 1. CREATOR OVERVIEW DASHBOARD
  // ----------------------------------------------------
  describe('Creator Overview (/statistics)', () => {
    test('computes total views, eligible views, submissions by status, and ledger balances accurately', async () => {
      const repo = createMockAnalyticsRepo();
      const service = new StatisticsService(repo);

      const userId = 'usr_creator_1';
      const campId = 'camp_nike';

      repo.campaigns.set(campId, {
        id: campId,
        name: 'Nike Air Launch',
        slug: 'nike-air',
        status: 'ACTIVE',
        payRate: new Prisma.Decimal('10.00'),
        creatorEarningCap: new Prisma.Decimal('600.00'),
        currency: 'USD'
      });

      repo.memberships.set(`${userId}_${campId}`, {
        userId,
        campaignId: campId,
        status: 'ACTIVE',
        joinedAt: new Date('2026-09-01T10:00:00Z')
      });

      // Submissions
      repo.submissions.set('sub_1', {
        id: 'sub_1',
        userId,
        campaignId: campId,
        platform: 'YOUTUBE',
        status: 'APPROVED',
        submittedAt: new Date('2026-09-02T12:00:00Z')
      });
      repo.snapshots.push({
        id: 'snap_1',
        submissionId: 'sub_1',
        views: 20000n,
        likes: 500n,
        comments: 50n,
        shares: 10n,
        capturedAt: new Date('2026-09-03T12:00:00Z')
      });
      repo.earnings.push({
        id: 'earn_1',
        userId,
        campaignId: campId,
        submissionId: 'sub_1',
        eligibleViews: 15000n,
        grossAmount: new Prisma.Decimal('150.00'),
        status: 'ELIGIBLE'
      });

      repo.submissions.set('sub_2', {
        id: 'sub_2',
        userId,
        campaignId: campId,
        platform: 'TIKTOK',
        status: 'UNDER_REVIEW',
        submittedAt: new Date('2026-09-04T12:00:00Z')
      });
      repo.snapshots.push({
        id: 'snap_2',
        submissionId: 'sub_2',
        views: 5000n,
        likes: null,
        comments: null,
        shares: null,
        capturedAt: new Date('2026-09-04T13:00:00Z')
      });

      repo.submissions.set('sub_3', {
        id: 'sub_3',
        userId,
        campaignId: campId,
        platform: 'INSTAGRAM',
        status: 'REJECTED',
        submittedAt: new Date('2026-09-05T12:00:00Z')
      });

      // Payout reservations and disbursements
      repo.payoutRequests.push({
        id: 'payout_res',
        userId,
        amount: new Prisma.Decimal('50.00'),
        status: 'REQUESTED',
        currency: 'USD'
      });
      repo.payoutRequests.push({
        id: 'payout_done',
        userId,
        amount: new Prisma.Decimal('40.00'),
        status: 'COMPLETED',
        currency: 'USD'
      });

      const overview = await service.getUserOverview(userId);

      assert.equal(overview.userId, userId);
      assert.equal(overview.totalSubmissions, 3);
      assert.equal(overview.approvedSubmissions, 1);
      assert.equal(overview.underReviewSubmissions, 1);
      assert.equal(overview.rejectedSubmissions, 1);
      assert.equal(overview.totalCampaignsJoined, 1);

      // Views
      assert.equal(overview.totalViews.knownSum, 25000n);
      assert.equal(overview.totalEligibleViews, 15000n);

      // Authoritative financials from ledger:
      // Total Earned = 150.00
      // Reserved = 50.00
      // Completed = 40.00
      // Available = 150.00 - 50.00 - 40.00 = 60.00
      assert.equal(overview.financials.totalEarned, '150.00');
      assert.equal(overview.financials.reservedBalance, '50.00');
      assert.equal(overview.financials.completedPayouts, '40.00');
      assert.equal(overview.financials.availableBalance, '60.00');
    });

    test('distinguishes unavailable metrics from valid zero counts', () => {
      const zeroObj = { knownSum: 0n, availability: 'COMPLETE', countWithMetric: 1, totalSubmissions: 1 };
      assert.equal(formatMetricCount(zeroObj), '**0**');

      const unavailObj = { knownSum: null, availability: 'UNAVAILABLE', countWithMetric: 0, totalSubmissions: 1 };
      assert.equal(formatMetricCount(unavailObj), '*Unavailable*');
    });
  });

  // ----------------------------------------------------
  // 2. CREATOR CAMPAIGN BREAKDOWN
  // ----------------------------------------------------
  describe('Creator Campaign Breakdown', () => {
    test('returns paginated campaigns with cap consumption and ledgered earnings', async () => {
      const repo = createMockAnalyticsRepo();
      const service = new StatisticsService(repo);

      const userId = 'usr_camps';
      const c1 = 'c_alpha';
      const c2 = 'c_beta';

      repo.campaigns.set(c1, {
        id: c1,
        name: 'Alpha Campaign',
        slug: 'alpha',
        status: 'ACTIVE',
        clientName: 'Client Alpha',
        payRate: new Prisma.Decimal('10.00'),
        creatorEarningCap: new Prisma.Decimal('500.00'),
        currency: 'USD'
      });
      repo.campaigns.set(c2, {
        id: c2,
        name: 'Beta Campaign',
        slug: 'beta',
        status: 'PAUSED',
        clientName: 'Client Beta',
        payRate: new Prisma.Decimal('5.00'),
        creatorEarningCap: new Prisma.Decimal('200.00'),
        currency: 'USD'
      });

      repo.memberships.set(`${userId}_${c1}`, { userId, campaignId: c1, joinedAt: new Date('2026-09-01') });
      repo.memberships.set(`${userId}_${c2}`, { userId, campaignId: c2, joinedAt: new Date('2026-09-02') });

      // Clip in c1 earning $250 (50% of cap)
      repo.submissions.set('sub_a', { id: 'sub_a', userId, campaignId: c1, platform: 'YOUTUBE', status: 'APPROVED' });
      repo.snapshots.push({ id: 'sn_a', submissionId: 'sub_a', views: 25000n, capturedAt: new Date() });
      repo.earnings.push({
        id: 'earn_a',
        userId,
        campaignId: c1,
        submissionId: 'sub_a',
        eligibleViews: 25000n,
        grossAmount: new Prisma.Decimal('250.00'),
        status: 'ELIGIBLE'
      });

      const res = await service.getCreatorCampaigns(userId, { page: 1, limit: 10 });
      assert.equal(res.total, 2);
      assert.equal(res.items.length, 2);

      const alpha = res.items.find((i) => i.campaignId === c1);
      assert.ok(alpha);
      assert.equal(alpha.campaignName, 'Alpha Campaign');
      assert.equal(alpha.totalObservedViews, 25000n);
      assert.equal(alpha.totalEligibleViews, 25000n);
      assert.equal(alpha.totalEarned, '250.00');
      assert.equal(alpha.capConsumedPercent, 50.0);
    });
  });

  // ----------------------------------------------------
  // 3. PLATFORM & CHANNEL BREAKDOWN
  // ----------------------------------------------------
  describe('Platform & Channel Breakdown', () => {
    test('groups performance by platform cleanly', async () => {
      const repo = createMockAnalyticsRepo();
      const service = new StatisticsService(repo);
      const userId = 'usr_plat';

      repo.submissions.set('sub_yt', { id: 'sub_yt', userId, campaignId: 'c1', platform: 'YOUTUBE', status: 'APPROVED' });
      repo.snapshots.push({ id: 'sn_yt', submissionId: 'sub_yt', views: 10000n, capturedAt: new Date() });
      repo.earnings.push({ id: 'e_yt', userId, campaignId: 'c1', submissionId: 'sub_yt', eligibleViews: 10000n, grossAmount: new Prisma.Decimal('100.00'), status: 'ELIGIBLE' });

      const platforms = await service.getCreatorPlatforms(userId);
      const yt = platforms.find((p) => p.platform === 'YOUTUBE');
      assert.equal(yt.clips.total, 1);
      assert.equal(yt.clips.approved, 1);
      assert.equal(yt.observedViews.sum, 10000n);
      assert.equal(yt.eligibleViews, 10000n);
      assert.equal(yt.totalEarnings, '100.00');

      const fb = platforms.find((p) => p.platform === 'FACEBOOK');
      assert.equal(fb.clips.total, 0);
      assert.equal(fb.observedViews.availability, 'UNAVAILABLE');
    });

    test('groups performance by channel/account from metadata', async () => {
      const repo = createMockAnalyticsRepo();
      const service = new StatisticsService(repo);
      const userId = 'usr_chan';

      repo.submissions.set('sub_ch1', { id: 'sub_ch1', userId, campaignId: 'c1', platform: 'YOUTUBE', status: 'APPROVED' });
      repo.snapshots.push({
        id: 'sn_ch1',
        submissionId: 'sub_ch1',
        views: 8000n,
        capturedAt: new Date(),
        metadata: { channelTitle: 'ApexClipsHQ' }
      });

      repo.submissions.set('sub_ch2', { id: 'sub_ch2', userId, campaignId: 'c1', platform: 'TIKTOK', status: 'APPROVED' });
      repo.snapshots.push({
        id: 'sn_ch2',
        submissionId: 'sub_ch2',
        views: 3000n,
        capturedAt: new Date(),
        metadata: {} // No channelTitle
      });

      const channels = await service.getCreatorChannels(userId);
      assert.equal(channels.length, 2);

      const named = channels.find((c) => c.channelName === 'ApexClipsHQ');
      assert.ok(named);
      assert.equal(named.observedViews, 8000n);

      const unk = channels.find((c) => c.channelName === 'Unknown / Unspecified');
      assert.ok(unk);
      assert.equal(unk.observedViews, 3000n);
    });
  });

  // ----------------------------------------------------
  // 4. VIDEO BREAKDOWN & GROWTH HISTORY
  // ----------------------------------------------------
  describe('Video Breakdown & Historical Growth', () => {
    test('returns paginated videos with retention status and linked earnings', async () => {
      const repo = createMockAnalyticsRepo();
      const service = new StatisticsService(repo);
      const userId = 'usr_vid';

      repo.campaigns.set('camp_ret', { id: 'camp_ret', name: 'Retention Camp', slug: 'ret', status: 'ACTIVE' });
      repo.submissions.set('sub_ret', {
        id: 'sub_ret',
        userId,
        campaignId: 'camp_ret',
        platform: 'YOUTUBE',
        url: 'https://youtube.com/watch?v=12345',
        normalizedUrl: 'https://youtube.com/watch?v=12345',
        status: 'APPROVED',
        submittedAt: new Date('2026-09-10'),
        retentionStatus: 'ACTIVE',
        retentionRequired: true,
        retentionDeadline: new Date('2026-09-24')
      });
      repo.snapshots.push({
        id: 'sn_ret',
        submissionId: 'sub_ret',
        views: 12000n,
        capturedAt: new Date(),
        metadata: { title: 'Best Clutch Moments' }
      });
      repo.earnings.push({
        id: 'e_ret',
        userId,
        campaignId: 'camp_ret',
        submissionId: 'sub_ret',
        eligibleViews: 10000n,
        grossAmount: new Prisma.Decimal('100.00'),
        status: 'ELIGIBLE'
      });

      const vids = await service.getCreatorVideos(userId, { page: 1, limit: 10 });
      assert.equal(vids.total, 1);
      const vid = vids.items[0];
      assert.equal(vid.title, 'Best Clutch Moments');
      assert.equal(vid.retentionStatus, 'ACTIVE');
      assert.equal(vid.retentionRequired, true);
      assert.equal(vid.latestViews, 12000n);
      assert.equal(vid.eligibleViews, 10000n);
      assert.equal(vid.grossEarnings, '100.00');
    });

    test('growth reports insufficient snapshots when < 2 exist', async () => {
      const repo = createMockAnalyticsRepo();
      const service = new StatisticsService(repo);
      const userId = 'usr_grow';

      repo.campaigns.set('c1', { id: 'c1', name: 'Camp 1', slug: 'c1', status: 'ACTIVE' });
      repo.submissions.set('sub_one_snap', {
        id: 'sub_one_snap',
        userId,
        campaignId: 'c1',
        platform: 'YOUTUBE',
        url: 'https://youtu.be/abc',
        normalizedUrl: 'https://youtu.be/abc',
        status: 'APPROVED',
        submittedAt: new Date()
      });
      repo.snapshots.push({
        id: 'snap_only',
        submissionId: 'sub_one_snap',
        views: 1000n,
        capturedAt: new Date()
      });

      const stats = await service.getSubmissionStatistics(userId, 'sub_one_snap');
      assert.equal(stats.hasEnoughHistory, false);
      assert.equal(formatGrowthDisplay(stats.growth.views), '*N/A (insufficient snapshots)*');
    });

    test('calculates view growth and delta accurately when >= 2 snapshots exist', async () => {
      const repo = createMockAnalyticsRepo();
      const service = new StatisticsService(repo);
      const userId = 'usr_grow2';

      repo.campaigns.set('c1', { id: 'c1', name: 'Camp 1', slug: 'c1', status: 'ACTIVE' });
      repo.submissions.set('sub_two_snaps', {
        id: 'sub_two_snaps',
        userId,
        campaignId: 'c1',
        platform: 'YOUTUBE',
        url: 'https://youtu.be/def',
        normalizedUrl: 'https://youtu.be/def',
        status: 'APPROVED',
        submittedAt: new Date('2026-09-01')
      });
      repo.snapshots.push({
        id: 'snap_1',
        submissionId: 'sub_two_snaps',
        views: 1000n,
        capturedAt: new Date('2026-09-01')
      });
      repo.snapshots.push({
        id: 'snap_2',
        submissionId: 'sub_two_snaps',
        views: 1500n,
        capturedAt: new Date('2026-09-02')
      });

      const stats = await service.getSubmissionStatistics(userId, 'sub_two_snaps');
      assert.equal(stats.hasEnoughHistory, true);
      assert.equal(stats.growth.views.delta, 500n);
      assert.equal(stats.growth.views.growthPercent, 50.0);
      assert.equal(formatGrowthDisplay(stats.growth.views), '+500 (+50%)');
    });

    test('rejects unauthorized access when viewing another creator clip', async () => {
      const repo = createMockAnalyticsRepo();
      const service = new StatisticsService(repo);

      repo.campaigns.set('c1', { id: 'c1', name: 'Camp 1', slug: 'c1', status: 'ACTIVE' });
      repo.submissions.set('sub_private', {
        id: 'sub_private',
        userId: 'owner_user',
        campaignId: 'c1',
        platform: 'YOUTUBE',
        url: 'https://youtu.be/sec',
        normalizedUrl: 'https://youtu.be/sec',
        status: 'APPROVED'
      });

      await assert.rejects(
        service.getSubmissionStatistics('intruder_user', 'sub_private'),
        UnauthorizedAccessError
      );
    });
  });

  // ----------------------------------------------------
  // 5. ADMIN CAMPAIGN PERFORMANCE & REPORTING
  // ----------------------------------------------------
  describe('Admin Campaign Performance & Reporting', () => {
    test('generates comprehensive campaign analytics report with neutral creator performance', async () => {
      const repo = createMockAnalyticsRepo();
      const service = new StatisticsService(repo);
      const campId = 'camp_admin_rep';

      repo.campaigns.set(campId, {
        id: campId,
        name: 'Spring Energy Blitz',
        slug: 'spring-energy',
        clientName: 'Energy Co',
        status: 'ACTIVE',
        payRate: new Prisma.Decimal('10.00'),
        totalBudget: new Prisma.Decimal('1000.00'),
        consumedBudget: new Prisma.Decimal('600.00'),
        creatorEarningCap: new Prisma.Decimal('500.00'),
        currency: 'USD',
        startsAt: new Date('2026-09-01'),
        endsAt: new Date('2026-09-30'),
        retentionRequired: true,
        retentionDays: 14
      });

      // User 1: 50,000 views, $500 earned
      repo.users.set('u1', { id: 'u1', discordId: 'disc_1', username: 'Alex', displayName: 'Alex The Clipper' });
      repo.memberships.set(`u1_${campId}`, { userId: 'u1', campaignId: campId, joinedAt: new Date('2026-09-01') });
      repo.submissions.set('s1', { id: 's1', userId: 'u1', campaignId: campId, platform: 'YOUTUBE', status: 'APPROVED', submittedAt: new Date('2026-09-02') });
      repo.snapshots.push({ id: 'sn1', submissionId: 's1', views: 50000n, capturedAt: new Date() });
      repo.earnings.push({ id: 'e1', userId: 'u1', campaignId: campId, submissionId: 's1', eligibleViews: 50000n, grossAmount: new Prisma.Decimal('500.00'), status: 'ELIGIBLE' });

      // User 2: 10,000 views, $100 earned
      repo.users.set('u2', { id: 'u2', discordId: 'disc_2', username: 'Jordan', displayName: 'Jordan Clips' });
      repo.memberships.set(`u2_${campId}`, { userId: 'u2', campaignId: campId, joinedAt: new Date('2026-09-02') });
      repo.submissions.set('s2', { id: 's2', userId: 'u2', campaignId: campId, platform: 'TIKTOK', status: 'APPROVED', submittedAt: new Date('2026-09-03') });
      repo.snapshots.push({ id: 'sn2', submissionId: 's2', views: 10000n, capturedAt: new Date() });
      repo.earnings.push({ id: 'e2', userId: 'u2', campaignId: campId, submissionId: 's2', eligibleViews: 10000n, grossAmount: new Prisma.Decimal('100.00'), status: 'ELIGIBLE' });

      const report = await service.getCampaignReport(campId, { sortBy: 'views', sortOrder: 'desc' });

      // Budget & Reach
      assert.equal(report.financial.totalBudget, '1000.00');
      assert.equal(report.financial.consumedBudget, '600.00');
      assert.equal(report.financial.remainingBudget, '400.00');
      assert.equal(report.financial.fulfillmentPercent, 60.0);
      assert.equal(report.reach.totalObservedViews, 60000n);
      assert.equal(report.reach.totalEligibleViews, 60000n);
      assert.equal(report.financial.totalCreditedEarnings, '600.00');
      assert.equal(report.financial.totalCreators, 2);
      assert.equal(report.financial.avgCreditedEarning, '300.00');

      // Creator Table (Neutral non-evaluative reporting)
      assert.equal(report.creators.items.length, 2);
      assert.equal(report.creators.items[0].username, 'Alex');
      assert.equal(report.creators.items[0].eligibleViews, 50000n);
      assert.equal(report.creators.items[0].creditedEarnings, '500.00');
      assert.equal(report.creators.items[0].capUsedPercent, 100.0);

      assert.equal(report.creators.items[1].username, 'Jordan');
      assert.equal(report.creators.items[1].eligibleViews, 10000n);
      assert.equal(report.creators.items[1].creditedEarnings, '100.00');
      assert.equal(report.creators.items[1].capUsedPercent, 20.0);

      // Financial Reconciliation
      assert.equal(report.financialReconciliation.isReconciled, true);
      assert.equal(report.financialReconciliation.budgetDiscrepancy, '0.00');
    });

    test('reconciliation identifies budget discrepancy if consumedBudget was desynced', async () => {
      const repo = createMockAnalyticsRepo();
      const service = new StatisticsService(repo);
      const campId = 'camp_desync';

      repo.campaigns.set(campId, {
        id: campId,
        name: 'Desync Campaign',
        slug: 'desync',
        clientName: 'Client',
        status: 'COMPLETED',
        totalBudget: new Prisma.Decimal('500.00'),
        consumedBudget: new Prisma.Decimal('500.00'), // Marked 500 consumed
        payRate: new Prisma.Decimal('10.00'),
        currency: 'USD'
      });

      // But ledger has only $400 credited
      repo.earnings.push({
        id: 'e_desync',
        userId: 'u_desync',
        campaignId: campId,
        submissionId: 's_desync',
        eligibleViews: 40000n,
        grossAmount: new Prisma.Decimal('400.00'),
        status: 'ELIGIBLE'
      });

      const report = await service.getCampaignReport(campId);
      assert.equal(report.financialReconciliation.isReconciled, false);
      assert.equal(report.financialReconciliation.budgetDiscrepancy, '100.00');
    });
  });

  // ----------------------------------------------------
  // 6. DISCORD EMBEDS & COMPONENTS RENDERING
  // ----------------------------------------------------
  describe('Discord Presentation & Components', () => {
    test('renders user overview embed with authoritative financial balances', () => {
      const mockOverview = {
        totalSubmissions: 5,
        approvedSubmissions: 3,
        underReviewSubmissions: 1,
        flaggedSubmissions: 0,
        rejectedSubmissions: 1,
        totalViews: { knownSum: 25000n, availability: 'COMPLETE', countWithMetric: 5, totalSubmissions: 5 },
        totalEligibleViews: 20000n,
        totalLikes: { knownSum: 500n, availability: 'COMPLETE', countWithMetric: 5, totalSubmissions: 5 },
        totalComments: { knownSum: null, availability: 'UNAVAILABLE', countWithMetric: 0, totalSubmissions: 5 },
        totalShares: { knownSum: null, availability: 'UNAVAILABLE', countWithMetric: 0, totalSubmissions: 5 },
        totalCampaignsJoined: 2,
        activeCampaignsJoined: 2,
        financials: {
          totalEarned: '200.00',
          availableBalance: '150.00',
          reservedBalance: '50.00',
          completedPayouts: '0.00',
          currency: 'USD'
        },
        lastUpdatedAt: new Date()
      };

      const embed = buildUserOverviewEmbed(mockOverview, { id: 'disc_user_1' });
      assert.ok(embed);
      assert.equal(embed.data.title, '📊 My Clipping Performance Overview');

      const finField = embed.data.fields.find((f) => f.name.includes('Financial Ledger'));
      assert.ok(finField);
      assert.ok(finField.value.includes('$200.00 USD'));
      assert.ok(finField.value.includes('$150.00 USD'));
    });

    test('renders user overview action row with 5 buttons', () => {
      const row = buildUserOverviewActionRow('usr_test');
      assert.equal(row.components.length, 5);
      assert.equal(row.components[0].data.label, 'Campaigns');
      assert.equal(row.components[1].data.label, 'Platforms');
      assert.equal(row.components[2].data.label, 'Channels');
      assert.equal(row.components[3].data.label, 'My Clips');
      assert.equal(row.components[4].data.label, 'Refresh');
    });

    test('renders admin campaign report embed with financial reconciliation', () => {
      const mockReport = {
        campaign: {
          name: 'Test Blitz',
          clientName: 'Client Co',
          status: 'COMPLETED',
          cpm: '10.00',
          creatorEarningCap: '500.00',
          currency: 'USD',
          startsAt: new Date(),
          endsAt: new Date()
        },
        financialReconciliation: {
          totalBudget: '1000.00',
          consumedBudget: '1000.00',
          remainingBudget: '0.00',
          fulfillmentPercent: 100.0,
          reconciledGrossEarnings: '1000.00',
          reconciledNetAdjustments: '0.00',
          reconciledTotalLoad: '1000.00',
          budgetDiscrepancy: '0.00',
          isReconciled: true
        }
      };

      const embed = buildAdminCampaignReportEmbed(mockReport, 'financial');
      assert.ok(embed);
      assert.ok(embed.data.fields[0].name.includes('RECONCILED'));
      assert.ok(embed.data.fields[0].value.includes('$1000.00 USD'));
    });
  });
});
