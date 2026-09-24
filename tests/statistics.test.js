import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { StatisticsService } from '../src/modules/statistics/statistics.service.js';
import {
  UnauthorizedAccessError,
  CampaignMembershipRequiredError,
  SubmissionNotFoundError,
  CampaignNotFoundError
} from '../src/modules/statistics/statistics.errors.js';
import {
  formatMetricCount,
  formatGrowthDisplay,
  buildUserOverviewEmbed,
  buildCampaignOverviewEmbed,
  buildSubmissionStatisticsEmbed
} from '../src/bot/embeds/statistics.embeds.js';
import {
  buildUserOverviewActionRow,
  buildCampaignSelectorRow,
  buildClipPaginationRow
} from '../src/bot/components/statistics.components.js';

// Mock in-memory repository factory for statistics testing
function createMockStatisticsRepo() {
  const users = new Map();
  const campaigns = new Map();
  const memberships = new Map(); // key: `${userId}_${campaignId}`
  const submissions = new Map(); // key: submissionId
  const snapshots = []; // array of { id, submissionId, views, likes, comments, shares, capturedAt }
  const verifications = new Map(); // key: submissionId

  return {
    users,
    campaigns,
    memberships,
    submissions,
    snapshots,
    verifications,

    async getCampaignById(campaignId) {
      return campaigns.get(campaignId) || null;
    },

    async getCampaignMembership(userId, campaignId) {
      const key = `${userId}_${campaignId}`;
      const m = memberships.get(key);
      if (!m) return null;
      const c = campaigns.get(campaignId);
      return { ...m, campaign: c };
    },

    async getUserCampaignMemberships(userId) {
      const list = [];
      for (const [key, m] of memberships.entries()) {
        if (m.userId === userId) {
          const c = campaigns.get(m.campaignId);
          list.push({ ...m, campaign: c });
        }
      }
      return list.sort((a, b) => new Date(b.joinedAt) - new Date(a.joinedAt));
    },

    async getUserSubmissionsWithLatestSnapshots(userId, campaignId = null) {
      const list = [];
      for (const sub of submissions.values()) {
        if (sub.userId !== userId) continue;
        if (campaignId && sub.campaignId !== campaignId) continue;

        const subSnapshots = snapshots
          .filter((s) => s.submissionId === sub.id)
          .sort((a, b) => {
            const timeDiff = new Date(b.capturedAt) - new Date(a.capturedAt);
            if (timeDiff !== 0) return timeDiff;
            return b.id.localeCompare(a.id);
          });

        const latestSnapshot = subSnapshots.length > 0 ? [subSnapshots[0]] : [];

        const ver = verifications.get(sub.id) ? [verifications.get(sub.id)] : [];
        const camp = campaigns.get(sub.campaignId);

        list.push({
          ...sub,
          campaign: camp ? { id: camp.id, name: camp.name, slug: camp.slug, status: camp.status } : null,
          snapshots: latestSnapshot,
          verifications: ver
        });
      }

      return list.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    },

    async getSubmissionWithHistory(submissionId) {
      const sub = submissions.get(submissionId);
      if (!sub) return null;

      const camp = campaigns.get(sub.campaignId);
      const subSnapshots = snapshots
        .filter((s) => s.submissionId === sub.id)
        .sort((a, b) => {
          const timeDiff = new Date(a.capturedAt) - new Date(b.capturedAt);
          if (timeDiff !== 0) return timeDiff;
          return a.id.localeCompare(b.id);
        });

      const ver = verifications.get(sub.id);

      return {
        ...sub,
        campaign: camp,
        verifications: ver ? [ver] : [],
        snapshots: subSnapshots
      };
    }
  };
}

describe('Statistics Engine — Phase 4A', () => {
  describe('1. USER OVERVIEW', () => {
    test('aggregates submission counts and status counts accurately', async () => {
      const repo = createMockStatisticsRepo();
      const service = new StatisticsService(repo);

      const userId = 'usr_alice';
      repo.campaigns.set('cmp_1', { id: 'cmp_1', name: 'Campaign 1', status: 'ACTIVE' });
      repo.memberships.set(`${userId}_cmp_1`, { userId, campaignId: 'cmp_1', status: 'ACTIVE', joinedAt: new Date() });

      // Create submissions across various statuses
      repo.submissions.set('sub_1', { id: 'sub_1', userId, campaignId: 'cmp_1', status: 'APPROVED', submittedAt: new Date('2026-09-20T10:00:00Z') });
      repo.submissions.set('sub_2', { id: 'sub_2', userId, campaignId: 'cmp_1', status: 'APPROVED', submittedAt: new Date('2026-09-20T11:00:00Z') });
      repo.submissions.set('sub_3', { id: 'sub_3', userId, campaignId: 'cmp_1', status: 'PENDING_VERIFICATION', submittedAt: new Date('2026-09-20T12:00:00Z') });
      repo.submissions.set('sub_4', { id: 'sub_4', userId, campaignId: 'cmp_1', status: 'UNDER_REVIEW', submittedAt: new Date('2026-09-20T13:00:00Z') });
      repo.submissions.set('sub_5', { id: 'sub_5', userId, campaignId: 'cmp_1', status: 'FLAGGED', submittedAt: new Date('2026-09-20T14:00:00Z') });
      repo.submissions.set('sub_6', { id: 'sub_6', userId, campaignId: 'cmp_1', status: 'REJECTED', submittedAt: new Date('2026-09-20T15:00:00Z') });

      const overview = await service.getUserOverview(userId);

      assert.equal(overview.totalSubmissions, 6);
      assert.equal(overview.approvedSubmissions, 2);
      assert.equal(overview.pendingSubmissions, 1);
      assert.equal(overview.underReviewSubmissions, 1);
      assert.equal(overview.flaggedSubmissions, 1);
      assert.equal(overview.rejectedSubmissions, 1);
      assert.equal(overview.totalCampaignsJoined, 1);
      assert.equal(overview.activeCampaignsJoined, 1);
    });

    test('current metrics use latest snapshot per submission and do NOT double-count historical snapshots', async () => {
      const repo = createMockStatisticsRepo();
      const service = new StatisticsService(repo);

      const userId = 'usr_bob';
      repo.campaigns.set('cmp_1', { id: 'cmp_1', name: 'Campaign 1', status: 'ACTIVE' });
      repo.memberships.set(`${userId}_cmp_1`, { userId, campaignId: 'cmp_1', status: 'ACTIVE', joinedAt: new Date() });

      repo.submissions.set('sub_1', { id: 'sub_1', userId, campaignId: 'cmp_1', status: 'APPROVED', submittedAt: new Date('2026-09-20T10:00:00Z') });

      // Sequence of snapshots for sub_1: 10k -> 15k -> 25k views
      repo.snapshots.push({
        id: 'snap_1',
        submissionId: 'sub_1',
        views: 10000n,
        likes: 500n,
        comments: 50n,
        shares: 10n,
        capturedAt: new Date('2026-09-20T10:00:00Z')
      });
      repo.snapshots.push({
        id: 'snap_2',
        submissionId: 'sub_1',
        views: 15000n,
        likes: 750n,
        comments: 75n,
        shares: 15n,
        capturedAt: new Date('2026-09-20T12:00:00Z')
      });
      repo.snapshots.push({
        id: 'snap_3',
        submissionId: 'sub_1',
        views: 25000n,
        likes: 1250n,
        comments: 125n,
        shares: 25n,
        capturedAt: new Date('2026-09-20T15:00:00Z')
      });

      const overview = await service.getUserOverview(userId);

      // Current total views must be 25,000 NOT 50,000 (10k + 15k + 25k)
      assert.equal(overview.totalViews.knownSum, 25000n);
      assert.equal(overview.totalViews.availability, 'COMPLETE');
      assert.equal(overview.totalLikes.knownSum, 1250n);
      assert.equal(overview.totalComments.knownSum, 125n);
      assert.equal(overview.totalShares.knownSum, 25n);
    });

    test('deterministic tie-breaker is applied when snapshots have identical capturedAt', async () => {
      const repo = createMockStatisticsRepo();
      const service = new StatisticsService(repo);

      const userId = 'usr_charlie';
      repo.campaigns.set('cmp_1', { id: 'cmp_1', name: 'Campaign 1', status: 'ACTIVE' });
      repo.memberships.set(`${userId}_cmp_1`, { userId, campaignId: 'cmp_1', status: 'ACTIVE', joinedAt: new Date() });
      repo.submissions.set('sub_tie', { id: 'sub_tie', userId, campaignId: 'cmp_1', status: 'APPROVED', submittedAt: new Date() });

      const sameDate = new Date('2026-09-20T12:00:00Z');
      repo.snapshots.push({
        id: 'snap_a',
        submissionId: 'sub_tie',
        views: 1000n,
        likes: 50n,
        comments: 5n,
        shares: null,
        capturedAt: sameDate
      });
      repo.snapshots.push({
        id: 'snap_z',
        submissionId: 'sub_tie',
        views: 2000n,
        likes: 100n,
        comments: 10n,
        shares: null,
        capturedAt: sameDate
      });

      const overview = await service.getUserOverview(userId);
      // snap_z has higher id so snap_z is deterministically resolved as latest
      assert.equal(overview.totalViews.knownSum, 2000n);
    });

    test('unavailable metrics do NOT become zero and partial data is clearly represented', async () => {
      const repo = createMockStatisticsRepo();
      const service = new StatisticsService(repo);

      const userId = 'usr_david';
      repo.campaigns.set('cmp_1', { id: 'cmp_1', name: 'Campaign 1', status: 'ACTIVE' });
      repo.memberships.set(`${userId}_cmp_1`, { userId, campaignId: 'cmp_1', status: 'ACTIVE', joinedAt: new Date() });

      // Submission A: views = 100,000, likes = 5,000, comments = null, shares = null
      repo.submissions.set('sub_a', { id: 'sub_a', userId, campaignId: 'cmp_1', status: 'APPROVED', submittedAt: new Date('2026-09-20T10:00:00Z') });
      repo.snapshots.push({
        id: 'snap_a',
        submissionId: 'sub_a',
        views: 100000n,
        likes: 5000n,
        comments: null,
        shares: null,
        capturedAt: new Date('2026-09-20T10:00:00Z')
      });

      // Submission B: views = 50,000, likes = null, comments = 1,000, shares = null
      repo.submissions.set('sub_b', { id: 'sub_b', userId, campaignId: 'cmp_1', status: 'APPROVED', submittedAt: new Date('2026-09-20T11:00:00Z') });
      repo.snapshots.push({
        id: 'snap_b',
        submissionId: 'sub_b',
        views: 50000n,
        likes: null,
        comments: 1000n,
        shares: null,
        capturedAt: new Date('2026-09-20T11:00:00Z')
      });

      const overview = await service.getUserOverview(userId);

      // Views: both have views -> COMPLETE (150,000)
      assert.equal(overview.totalViews.knownSum, 150000n);
      assert.equal(overview.totalViews.availability, 'COMPLETE');

      // Likes: only sub_a has likes -> PARTIAL (5,000)
      assert.equal(overview.totalLikes.knownSum, 5000n);
      assert.equal(overview.totalLikes.availability, 'PARTIAL');
      assert.equal(overview.totalLikes.countWithMetric, 1);
      assert.equal(overview.totalLikes.totalSubmissions, 2);

      // Comments: only sub_b has comments -> PARTIAL (1,000)
      assert.equal(overview.totalComments.knownSum, 1000n);
      assert.equal(overview.totalComments.availability, 'PARTIAL');

      // Shares: neither has shares -> UNAVAILABLE (null sum, NOT 0)
      assert.equal(overview.totalShares.knownSum, null);
      assert.equal(overview.totalShares.availability, 'UNAVAILABLE');
    });
  });

  describe('2. CAMPAIGN OVERVIEW', () => {
    test('filters submissions strictly to requested user and campaign', async () => {
      const repo = createMockStatisticsRepo();
      const service = new StatisticsService(repo);

      const alice = 'usr_alice';
      const bob = 'usr_bob';
      const campaignId = 'cmp_gamma';

      repo.campaigns.set(campaignId, { id: campaignId, name: 'Gamma Clips', clientName: 'Client G', status: 'ACTIVE' });
      repo.memberships.set(`${alice}_${campaignId}`, { userId: alice, campaignId, status: 'ACTIVE', joinedAt: new Date() });
      repo.memberships.set(`${bob}_${campaignId}`, { userId: bob, campaignId, status: 'ACTIVE', joinedAt: new Date() });

      // Alice submissions in campaign
      repo.submissions.set('sub_alice_1', { id: 'sub_alice_1', userId: alice, campaignId, status: 'APPROVED', submittedAt: new Date() });
      repo.snapshots.push({ id: 'snap_al_1', submissionId: 'sub_alice_1', views: 30000n, likes: 1000n, comments: 50n, shares: 10n, capturedAt: new Date() });

      // Bob submissions in campaign (MUST NOT be counted for Alice)
      repo.submissions.set('sub_bob_1', { id: 'sub_bob_1', userId: bob, campaignId, status: 'APPROVED', submittedAt: new Date() });
      repo.snapshots.push({ id: 'snap_bob_1', submissionId: 'sub_bob_1', views: 999999n, likes: 50000n, comments: 2000n, shares: 500n, capturedAt: new Date() });

      const aliceStats = await service.getCampaignOverview(alice, campaignId);

      assert.equal(aliceStats.totalSubmissions, 1);
      assert.equal(aliceStats.currentTotalViews.knownSum, 30000n);
      assert.equal(aliceStats.bestPerformingSubmission.id, 'sub_alice_1');
    });

    test('enforces campaign membership requirement before exposing campaign stats', async () => {
      const repo = createMockStatisticsRepo();
      const service = new StatisticsService(repo);

      const userId = 'usr_outsider';
      const campaignId = 'cmp_private';

      repo.campaigns.set(campaignId, { id: campaignId, name: 'Private Campaign', status: 'ACTIVE' });
      // User has NOT joined cmp_private

      await assert.rejects(
        async () => {
          await service.getCampaignOverview(userId, campaignId);
        },
        (err) => {
          assert.ok(err instanceof CampaignMembershipRequiredError);
          assert.equal(err.code, 'CAMPAIGN_MEMBERSHIP_REQUIRED');
          return true;
        }
      );
    });

    test('determines best-performing submission using current view count and deterministic tie-breaker', async () => {
      const repo = createMockStatisticsRepo();
      const service = new StatisticsService(repo);

      const userId = 'usr_eve';
      const campaignId = 'cmp_top';

      repo.campaigns.set(campaignId, { id: campaignId, name: 'Top Clips', clientName: 'TopClient', status: 'ACTIVE' });
      repo.memberships.set(`${userId}_${campaignId}`, { userId, campaignId, status: 'ACTIVE', joinedAt: new Date() });

      repo.submissions.set('sub_1', { id: 'sub_1', userId, campaignId, platform: 'YOUTUBE', url: 'https://youtu.be/1', status: 'APPROVED', submittedAt: new Date() });
      repo.submissions.set('sub_2', { id: 'sub_2', userId, campaignId, platform: 'TIKTOK', url: 'https://tiktok.com/2', status: 'APPROVED', submittedAt: new Date() });
      repo.submissions.set('sub_3', { id: 'sub_3', userId, campaignId, platform: 'INSTAGRAM', url: 'https://instagram.com/3', status: 'APPROVED', submittedAt: new Date() });

      repo.snapshots.push({ id: 's1', submissionId: 'sub_1', views: 50000n, capturedAt: new Date('2026-09-20T10:00:00Z') });
      repo.snapshots.push({ id: 's2', submissionId: 'sub_2', views: 120000n, capturedAt: new Date('2026-09-20T11:00:00Z') });
      repo.snapshots.push({ id: 's3', submissionId: 'sub_3', views: 80000n, capturedAt: new Date('2026-09-20T12:00:00Z') });

      const stats = await service.getCampaignOverview(userId, campaignId);
      assert.equal(stats.bestPerformingSubmission.id, 'sub_2');
      assert.equal(stats.bestPerformingSubmission.views, 120000n);
    });

    test('best-performing submission is null if all submissions have unavailable views', async () => {
      const repo = createMockStatisticsRepo();
      const service = new StatisticsService(repo);

      const userId = 'usr_frank';
      const campaignId = 'cmp_unavail';

      repo.campaigns.set(campaignId, { id: campaignId, name: 'Unavail Camp', clientName: 'Unavail', status: 'ACTIVE' });
      repo.memberships.set(`${userId}_${campaignId}`, { userId, campaignId, status: 'ACTIVE', joinedAt: new Date() });

      repo.submissions.set('sub_unavail', { id: 'sub_unavail', userId, campaignId, platform: 'TIKTOK', status: 'UNDER_REVIEW', submittedAt: new Date() });
      repo.snapshots.push({ id: 's_null', submissionId: 'sub_unavail', views: null, capturedAt: new Date() });

      const stats = await service.getCampaignOverview(userId, campaignId);
      assert.equal(stats.bestPerformingSubmission, null);
    });
  });

  describe('3. INDIVIDUAL SUBMISSION STATISTICS', () => {
    test('calculates metric growth, growth percentage, and observation timestamps', async () => {
      const repo = createMockStatisticsRepo();
      const service = new StatisticsService(repo);

      const userId = 'usr_grace';
      const campaignId = 'cmp_growth';
      const subId = 'sub_growth_1';

      repo.campaigns.set(campaignId, { id: campaignId, name: 'Growth Campaign', status: 'ACTIVE' });
      repo.submissions.set(subId, {
        id: subId,
        userId,
        campaignId,
        platform: 'YOUTUBE',
        url: 'https://youtu.be/growth',
        status: 'APPROVED',
        submittedAt: new Date('2026-09-20T08:00:00Z')
      });

      // First snapshot: 100k views, 5k likes
      repo.snapshots.push({
        id: 'snap_early',
        submissionId: subId,
        views: 100000n,
        likes: 5000n,
        comments: 200n,
        shares: 50n,
        capturedAt: new Date('2026-09-20T10:00:00Z')
      });

      // Latest snapshot: 175k views, 8.5k likes
      repo.snapshots.push({
        id: 'snap_late',
        submissionId: subId,
        views: 175000n,
        likes: 8500n,
        comments: 350n,
        shares: 80n,
        capturedAt: new Date('2026-09-20T18:00:00Z')
      });

      const stats = await service.getSubmissionStatistics(userId, subId);

      // Current metrics
      assert.equal(stats.currentMetrics.views, 175000n);
      assert.equal(stats.currentMetrics.likes, 8500n);

      // Growth calculations
      assert.equal(stats.growth.views.delta, 75000n);
      assert.equal(stats.growth.views.growthPercent, 75.0); // (75000 / 100000) * 100 = 75%
      assert.equal(stats.growth.views.isRegression, false);

      assert.equal(stats.growth.likes.delta, 3500n);
      assert.equal(stats.growth.likes.growthPercent, 70.0);

      // Observation window
      assert.equal(new Date(stats.firstObservedAt).toISOString(), '2026-09-20T10:00:00.000Z');
      assert.equal(new Date(stats.lastObservedAt).toISOString(), '2026-09-20T18:00:00.000Z');
    });

    test('growth handles zero baseline without dividing by zero', async () => {
      const repo = createMockStatisticsRepo();
      const service = new StatisticsService(repo);

      const userId = 'usr_helen';
      const subId = 'sub_zero';

      repo.campaigns.set('cmp_zero', { id: 'cmp_zero', name: 'Zero Camp', status: 'ACTIVE' });
      repo.submissions.set(subId, { id: subId, userId, campaignId: 'cmp_zero', platform: 'YOUTUBE', url: 'https://youtu.be/0', status: 'APPROVED', submittedAt: new Date() });

      repo.snapshots.push({ id: 's_zero', submissionId: subId, views: 0n, likes: 0n, comments: 0n, shares: 0n, capturedAt: new Date('2026-09-20T10:00:00Z') });
      repo.snapshots.push({ id: 's_ten', submissionId: subId, views: 1000n, likes: 50n, comments: 5n, shares: 1n, capturedAt: new Date('2026-09-20T12:00:00Z') });

      const stats = await service.getSubmissionStatistics(userId, subId);

      assert.equal(stats.growth.views.delta, 1000n);
      // Baseline was 0; growthPercent must be null, not Infinity or NaN
      assert.equal(stats.growth.views.growthPercent, null);
    });

    test('growth flags regressions when metrics decrease without assuming system error', async () => {
      const repo = createMockStatisticsRepo();
      const service = new StatisticsService(repo);

      const userId = 'usr_ian';
      const subId = 'sub_regr';

      repo.campaigns.set('cmp_regr', { id: 'cmp_regr', name: 'Regr Camp', status: 'ACTIVE' });
      repo.submissions.set(subId, { id: subId, userId, campaignId: 'cmp_regr', platform: 'YOUTUBE', url: 'https://youtu.be/regr', status: 'UNDER_REVIEW', submittedAt: new Date() });

      repo.snapshots.push({ id: 's_high', submissionId: subId, views: 50000n, likes: 2000n, comments: 100n, shares: 20n, capturedAt: new Date('2026-09-20T10:00:00Z') });
      repo.snapshots.push({ id: 's_low', submissionId: subId, views: 40000n, likes: 1800n, comments: 90n, shares: 15n, capturedAt: new Date('2026-09-20T12:00:00Z') });

      const stats = await service.getSubmissionStatistics(userId, subId);

      assert.equal(stats.growth.views.delta, -10000n);
      assert.equal(stats.growth.views.isRegression, true);
      assert.equal(stats.growth.views.growthPercent, -20.0);
    });

    test('engagement rate calculation distinguishes complete vs known engagement when shares are unsupported', async () => {
      const repo = createMockStatisticsRepo();
      const service = new StatisticsService(repo);

      const userId = 'usr_jack';
      const subId = 'sub_yt';

      repo.campaigns.set('cmp_yt', { id: 'cmp_yt', name: 'YT Camp', status: 'ACTIVE' });
      repo.submissions.set(subId, { id: subId, userId, campaignId: 'cmp_yt', platform: 'YOUTUBE', url: 'https://youtu.be/yt', status: 'APPROVED', submittedAt: new Date() });

      // YouTube: views = 10,000, likes = 500, comments = 50, shares = null (not supported)
      repo.snapshots.push({
        id: 's_yt',
        submissionId: subId,
        views: 10000n,
        likes: 500n,
        comments: 50n,
        shares: null,
        metadata: { availability: { views: 'AVAILABLE', likes: 'AVAILABLE', comments: 'AVAILABLE', shares: 'NOT_SUPPORTED' } },
        capturedAt: new Date()
      });

      const stats = await service.getSubmissionStatistics(userId, subId);

      // Complete engagement requires all components (likes, comments, shares); shares is null -> engagementRate = null
      assert.equal(stats.engagement.engagementRate, null);

      // Known engagement rate is (500 + 50 + 0) / 10000 = 5.5%
      assert.equal(stats.engagement.knownEngagementRate, 5.5);
    });
  });

  describe('4. SECURITY & ACCESS CONTROL', () => {
    test('user CANNOT access another user submission statistics', async () => {
      const repo = createMockStatisticsRepo();
      const service = new StatisticsService(repo);

      const owner = 'usr_owner';
      const attacker = 'usr_attacker';
      const subId = 'sub_secret';

      repo.campaigns.set('cmp_sec', { id: 'cmp_sec', name: 'Secure Camp', status: 'ACTIVE' });
      repo.submissions.set(subId, { id: subId, userId: owner, campaignId: 'cmp_sec', status: 'APPROVED', submittedAt: new Date() });

      await assert.rejects(
        async () => {
          await service.getSubmissionStatistics(attacker, subId);
        },
        (err) => {
          assert.ok(err instanceof UnauthorizedAccessError);
          assert.equal(err.code, 'UNAUTHORIZED_ACCESS');
          return true;
        }
      );
    });

    test('invalid submission ID returns SubmissionNotFoundError', async () => {
      const repo = createMockStatisticsRepo();
      const service = new StatisticsService(repo);

      await assert.rejects(
        async () => {
          await service.getSubmissionStatistics('usr_anyone', 'sub_nonexistent');
        },
        (err) => {
          assert.ok(err instanceof SubmissionNotFoundError);
          assert.equal(err.code, 'SUBMISSION_NOT_FOUND');
          return true;
        }
      );
    });

    test('invalid campaign ID returns CampaignNotFoundError', async () => {
      const repo = createMockStatisticsRepo();
      const service = new StatisticsService(repo);

      await assert.rejects(
        async () => {
          await service.getCampaignOverview('usr_anyone', 'cmp_nonexistent');
        },
        (err) => {
          assert.ok(err instanceof CampaignNotFoundError);
          assert.equal(err.code, 'CAMPAIGN_NOT_FOUND');
          return true;
        }
      );
    });

    test('internal verification weights, raw scores, and internal notes are NOT exposed in user statistics', async () => {
      const repo = createMockStatisticsRepo();
      const service = new StatisticsService(repo);

      const userId = 'usr_priv';
      const subId = 'sub_priv';

      repo.campaigns.set('cmp_priv', { id: 'cmp_priv', name: 'Private Camp', status: 'ACTIVE' });
      repo.submissions.set(subId, { id: subId, userId, campaignId: 'cmp_priv', platform: 'YOUTUBE', url: 'https://youtu.be/p', status: 'UNDER_REVIEW', submittedAt: new Date() });

      // Verification with internal score and private signals
      repo.verifications.set(subId, {
        id: 'ver_internal',
        submissionId: subId,
        riskLevel: 'REVIEW_REQUIRED',
        score: 0.45, // Internal anomaly score
        signals: [
          { id: 'sig_1', type: 'LIKE_VIEW_RATIO', severity: 'MEDIUM', explanation: 'Low like ratio' }
        ]
      });

      const stats = await service.getSubmissionStatistics(userId, subId);

      // Phase 10G Privacy: Verify internal scores, risk levels, and signals are NOT exposed to creators
      assert.equal(stats.verification, undefined);
      assert.equal(stats.verificationSignalsSummary, undefined);
      assert.equal(stats.submission.status, 'UNDER REVIEW');
    });
  });

  describe('5. DISCORD UI BUILDERS', () => {
    test('buildUserOverviewEmbed formats counts, metrics, and timestamps', () => {
      const dummyUser = { id: '123456789' };
      const overview = {
        userId: 'usr_1',
        totalSubmissions: 5,
        approvedSubmissions: 3,
        pendingSubmissions: 1,
        underReviewSubmissions: 1,
        flaggedSubmissions: 0,
        rejectedSubmissions: 0,
        totalViews: { knownSum: 50000n, availability: 'COMPLETE', countWithMetric: 5, totalSubmissions: 5 },
        totalLikes: { knownSum: 2500n, availability: 'COMPLETE', countWithMetric: 5, totalSubmissions: 5 },
        totalComments: { knownSum: 150n, availability: 'PARTIAL', countWithMetric: 3, totalSubmissions: 5 },
        totalShares: { knownSum: null, availability: 'UNAVAILABLE', countWithMetric: 0, totalSubmissions: 5 },
        totalCampaignsJoined: 2,
        activeCampaignsJoined: 2,
        lastUpdatedAt: new Date('2026-09-20T12:00:00Z')
      };

      const embed = buildUserOverviewEmbed(overview, dummyUser);
      assert.ok(embed.data.title.includes('Performance Overview'));
      assert.ok(embed.data.fields.some((f) => f.value.includes('50,000')));
      assert.ok(embed.data.fields.some((f) => f.value.includes('Partial: 3/5')));
    });

    test('buildCampaignOverviewEmbed formats campaign stats and best clip', () => {
      const dummyUser = { id: '123456789' };
      const campaignOverview = {
        campaign: { id: 'cmp_1', name: 'Echo Campaign', clientName: 'Echo Corp', status: 'ACTIVE' },
        membership: { status: 'ACTIVE', joinedAt: new Date('2026-09-20T08:00:00Z') },
        totalSubmissions: 2,
        approvedSubmissions: 2,
        pendingSubmissions: 0,
        underReviewSubmissions: 0,
        flaggedSubmissions: 0,
        rejectedSubmissions: 0,
        currentTotalViews: { knownSum: 85000n, availability: 'COMPLETE', countWithMetric: 2, totalSubmissions: 2 },
        currentTotalLikes: { knownSum: 4000n, availability: 'COMPLETE', countWithMetric: 2, totalSubmissions: 2 },
        currentTotalComments: { knownSum: 300n, availability: 'COMPLETE', countWithMetric: 2, totalSubmissions: 2 },
        currentTotalShares: { knownSum: null, availability: 'UNAVAILABLE', countWithMetric: 0, totalSubmissions: 2 },
        bestPerformingSubmission: {
          id: 'sub_best',
          platform: 'YOUTUBE',
          url: 'https://youtu.be/best',
          status: 'APPROVED',
          views: 60000n
        },
        latestActivity: new Date('2026-09-20T14:00:00Z'),
        lastMetricUpdate: new Date('2026-09-20T14:00:00Z')
      };

      const embed = buildCampaignOverviewEmbed(campaignOverview, dummyUser);
      assert.ok(embed.data.title.includes('Echo Campaign'));
      assert.ok(embed.data.fields.some((f) => f.value.includes('60,000')));
    });

    test('formatGrowthDisplay formats positive growth, regressions, and unavailable states', () => {
      assert.equal(formatGrowthDisplay(null), '*N/A (insufficient snapshots)*');
      assert.equal(formatGrowthDisplay({ delta: null }), '*N/A (insufficient snapshots)*');
      assert.equal(formatGrowthDisplay({ delta: 5000n, growthPercent: 50.0, isRegression: false }), '+5,000 (+50%)');
      assert.ok(formatGrowthDisplay({ delta: -2000n, growthPercent: -20.0, isRegression: true }).includes('Metric Regression'));
    });

    test('component builders construct action rows with owner userId encoded', () => {
      const userId = 'usr_nav';
      const overviewRow = buildUserOverviewActionRow(userId);
      assert.ok(overviewRow.components[0].data.custom_id.includes(userId));

      const paginationRow = buildClipPaginationRow(userId, 1, 3, 'all');
      assert.ok(paginationRow.components[0].data.disabled); // Prev button disabled on page 1
      assert.ok(!paginationRow.components[1].data.disabled); // Next button enabled
    });
  });
});
