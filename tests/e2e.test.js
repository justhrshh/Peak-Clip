import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { VerificationService } from '../src/modules/verification/verification.service.js';
import { ApprovalPolicy } from '../src/modules/verification/approval.policy.js';
import { EarningsService } from '../src/modules/earnings/earnings.service.js';
import { PayoutService } from '../src/modules/payouts/payout.service.js';
import { StatisticsService } from '../src/modules/statistics/statistics.service.js';
import { IneligibleSubmissionError } from '../src/modules/earnings/earnings.errors.js';
import { RESERVING_PAYOUT_STATUSES } from '../src/modules/payouts/payout.state-machine.js';

// In-memory mock repository implementing the end-to-end multi-module data store
function createMockE2EDataStore() {
  const users = new Map();
  const campaigns = new Map();
  const memberships = new Map();
  const submissions = new Map();
  const snapshots = new Map();
  const verifications = new Map();
  const signals = [];
  const earnings = new Map();
  const payoutRequests = new Map();
  const disbursements = new Map();
  const payoutEvents = [];

  let snapIdCounter = 1;
  let earnIdCounter = 1;
  let payoutIdCounter = 1;
  let disburseIdCounter = 1;

  const store = {
    users,
    campaigns,
    memberships,
    submissions,
    snapshots,
    verifications,
    signals,
    earnings,
    payoutRequests,
    disbursements,
    payoutEvents,

    // ==================== SUBMISSIONS ====================
    submissionRepo: {
      async getSubmissionById(id) {
        return submissions.get(id) || null;
      },
      async updateSubmissionStatus(id, status, metadata = {}) {
        const sub = submissions.get(id);
        if (!sub) throw new Error('Submission not found');
        const updated = { ...sub, status, ...metadata, updatedAt: new Date() };
        submissions.set(id, updated);
        return updated;
      }
    },

    // ==================== VERIFICATION ====================
    verificationRepo: {
      async getVerificationBySubmissionId(submissionId) {
        return verifications.get(submissionId) || null;
      },
      async getLatestVerificationBySubmissionId(submissionId) {
        return verifications.get(submissionId) || null;
      },
      async upsertVerification(data) {
        let v = verifications.get(data.submissionId);
        if (!v) {
          v = {
            id: `ver_${Date.now()}_${Math.random()}`,
            signals: [],
            ...data
          };
          verifications.set(data.submissionId, v);
          return v;
        }
        Object.assign(v, data);
        return v;
      },
      async addVerificationSignals(verificationId, newSignals = []) {
        for (const s of newSignals) {
          signals.push({ id: `sig_${Date.now()}`, verificationId, ...s });
        }
        return newSignals;
      },
      async getHistoricalSnapshots(submissionId) {
        return Array.from(snapshots.values())
          .filter((s) => s.submissionId === submissionId)
          .sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
      },
      async createMetricSnapshot(data) {
        const id = `snap_${snapIdCounter++}`;
        const record = { id, ...data, capturedAt: new Date() };
        snapshots.set(id, record);
        return record;
      }
    },

    // ==================== EARNINGS ====================
    earningsRepo: {
      async transaction(callback) {
        return callback(store.earningsRepo);
      },
      async acquireSubmissionLock() {},
      async getSubmissionForEarnings(submissionId) {
        const sub = submissions.get(submissionId);
        if (!sub) return null;
        const camp = campaigns.get(sub.campaignId);
        const ver = verifications.get(submissionId);
        const subSnaps = Array.from(snapshots.values())
          .filter((s) => s.submissionId === submissionId)
          .sort((a, b) => b.capturedAt - a.capturedAt);

        return {
          ...sub,
          campaign: camp,
          verifications: ver ? [ver] : [],
          snapshots: subSnaps.length > 0 ? [subSnaps[0]] : []
        };
      },
      async getSnapshotById(snapshotId) {
        return snapshots.get(snapshotId) || null;
      },
      async getPreviouslyCreditedViews(submissionId) {
        let sum = 0n;
        for (const e of earnings.values()) {
          if (e.submissionId === submissionId && e.status !== 'VOIDED') {
            sum += BigInt(e.eligibleViews);
          }
        }
        return sum;
      },
      async getEarningBySnapshotId(snapshotId) {
        for (const e of earnings.values()) {
          if (e.sourceSnapshotId === snapshotId && e.status !== 'VOIDED') {
            return e;
          }
        }
        return null;
      },
      async createEarning(data) {
        const id = `earn_${earnIdCounter++}`;
        const record = { id, ...data, createdAt: new Date() };
        earnings.set(id, record);
        return record;
      },
      async getUserEarningsBreakdown(userId, currency = 'USD') {
        let eligible = new Prisma.Decimal('0.00');
        let totalViews = 0n;
        for (const e of earnings.values()) {
          if (e.userId === userId && e.currency === currency && e.status === 'ELIGIBLE') {
            eligible = eligible.plus(new Prisma.Decimal(e.grossAmount));
            totalViews += BigInt(e.eligibleViews);
          }
        }
        return {
          totalEligibleEarnings: eligible,
          totalPendingEarnings: new Prisma.Decimal('0.00'),
          totalCreditedViews: totalViews,
          currency
        };
      }
    },

    // ==================== STATISTICS ====================
    statisticsRepo: {
      async getUserSubmissionsWithLatestSnapshots(userId, campaignId = null) {
        let userSubs = Array.from(submissions.values()).filter((s) => s.userId === userId);
        if (campaignId) userSubs = userSubs.filter((s) => s.campaignId === campaignId);
        return userSubs.map((sub) => {
          const subSnaps = Array.from(snapshots.values())
            .filter((sn) => sn.submissionId === sub.id)
            .sort((a, b) => b.capturedAt - a.capturedAt);
          const ver = verifications.get(sub.id);
          return {
            ...sub,
            campaign: campaigns.get(sub.campaignId),
            verifications: ver ? [ver] : [],
            snapshots: subSnaps.length > 0 ? [subSnaps[0]] : []
          };
        });
      },
      async getUserCampaignMemberships(userId) {
        return Array.from(memberships.values())
          .filter((m) => m.userId === userId)
          .map((m) => ({ ...m, campaign: campaigns.get(m.campaignId) }));
      },
      async getCampaignMembership(userId, campaignId) {
        return memberships.get(`${userId}_${campaignId}`) || null;
      },
      async getCampaignById(campaignId) {
        return campaigns.get(campaignId) || null;
      }
    },

    // ==================== PAYOUTS ====================
    payoutRepo: {
      async transaction(callback) {
        return callback(store.payoutRepo);
      },
      async acquireUserPayoutLock() {},
      async acquirePayoutRequestLock() {},
      async getUserById(userId) {
        return users.get(userId) || null;
      },
      async getPayoutBalanceBreakdown(userId, currency = 'USD') {
        let eligible = new Prisma.Decimal('0.00');
        for (const e of earnings.values()) {
          if (e.userId === userId && e.currency === currency && e.status === 'ELIGIBLE') {
            eligible = eligible.plus(new Prisma.Decimal(e.grossAmount));
          }
        }
        let reserved = new Prisma.Decimal('0.00');
        for (const pr of payoutRequests.values()) {
          if (pr.userId === userId && pr.currency === currency && RESERVING_PAYOUT_STATUSES.includes(pr.status)) {
            reserved = reserved.plus(new Prisma.Decimal(pr.amount));
          }
        }
        let completed = new Prisma.Decimal('0.00');
        for (const pr of payoutRequests.values()) {
          if (pr.userId === userId && pr.currency === currency && pr.status === 'COMPLETED') {
            completed = completed.plus(new Prisma.Decimal(pr.amount));
          }
        }
        let available = eligible.minus(reserved).minus(completed);
        if (available.lessThan(0)) available = new Prisma.Decimal('0.00');

        return {
          eligibleEarnings: eligible,
          reservedBalance: reserved,
          completedPayouts: completed,
          availableBalance: available,
          minimumPayout: new Prisma.Decimal('10.00'),
          currency
        };
      },
      async createPayoutRequest(data) {
        const id = `pr_${payoutIdCounter++}`;
        const record = {
          id,
          ...data,
          amount: new Prisma.Decimal(data.amount),
          requestedAt: new Date(),
          updatedAt: new Date(),
          disbursements: []
        };
        payoutRequests.set(id, record);
        return record;
      },
      async recordPayoutEvent(data) {
        payoutEvents.push(data);
      },
      async getPayoutRequestById(payoutRequestId) {
        const pr = payoutRequests.get(payoutRequestId);
        if (!pr) return null;
        const prDis = Array.from(disbursements.values()).filter((d) => d.payoutRequestId === payoutRequestId);
        return { ...pr, disbursements: prDis };
      },
      async updatePayoutRequest(payoutRequestId, data) {
        const pr = payoutRequests.get(payoutRequestId);
        if (!pr) throw new Error('Not found');
        const updated = { ...pr, ...data, updatedAt: new Date() };
        payoutRequests.set(payoutRequestId, updated);
        return updated;
      },
      async createDisbursement(data) {
        const id = `dis_${disburseIdCounter++}`;
        const record = { id, ...data, amount: new Prisma.Decimal(data.amount), createdAt: new Date() };
        disbursements.set(id, record);
        return record;
      },
      async updateDisbursement(disbursementId, data) {
        const dis = disbursements.get(disbursementId);
        if (!dis) throw new Error('Not found');
        const updated = { ...dis, ...data, updatedAt: new Date() };
        disbursements.set(disbursementId, updated);
        return updated;
      }
    }
  };

  return store;
}

describe('End-to-End Platform Flow', () => {
  test('executes complete production flow: Creator -> Campaign -> Submit -> Verify -> Approval -> Earnings -> Stats -> Payout', async () => {
    const store = createMockE2EDataStore();

    // 1. Creator & Campaign Setup
    store.users.set('creator_1', { id: 'creator_1', discordId: 'dc_123', status: 'ACTIVE' });
    store.campaigns.set('camp_fall2026', {
      id: 'camp_fall2026',
      name: 'Fall 2026 Clipping Sprint',
      payRate: new Prisma.Decimal('1.50'),
      minimumPayout: new Prisma.Decimal('10.00'),
      currency: 'USD',
      status: 'ACTIVE'
    });
    store.memberships.set('creator_1_camp_fall2026', {
      id: 'mem_1',
      userId: 'creator_1',
      campaignId: 'camp_fall2026',
      status: 'ACTIVE'
    });

    // 2. Submission Created
    store.submissions.set('sub_clip_1', {
      id: 'sub_clip_1',
      userId: 'creator_1',
      campaignId: 'camp_fall2026',
      platform: 'YOUTUBE',
      platformVideoId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      status: 'PENDING'
    });

    // 3. Fake Platform Provider returning 100,000 views
    const fakeProvider = {
      name: 'YOUTUBE',
      async getCurrentMetrics() {
        return {
          isAvailable: true,
          views: 100000n,
          likes: 5000n,
          comments: 400n,
          shares: null,
          status: 'AVAILABLE',
          availability: {
            views: 'AVAILABLE',
            likes: 'AVAILABLE',
            comments: 'AVAILABLE',
            shares: 'NOT_SUPPORTED'
          },
          metadata: { title: 'Viral Clip', channelTitle: 'Creator Channel' },
          publishedAt: new Date().toISOString()
        };
      }
    };

    // 4. Run Verification Service
    const verService = new VerificationService({
      submissionRepo: store.submissionRepo,
      verificationRepo: store.verificationRepo,
      providerResolver: () => fakeProvider,
      approvalPolicy: new ApprovalPolicy()
    });

    const verResult = await verService.runVerification('sub_clip_1');
    assert.equal(verResult.status, 'COMPLETED');
    assert.equal(verResult.submissionStatus, 'APPROVED');

    // Verify submission is APPROVED in store
    const updatedSub = store.submissions.get('sub_clip_1');
    assert.equal(updatedSub.status, 'APPROVED');

    // 5. Run Earnings Service
    const earningsService = new EarningsService(store.earningsRepo);
    const latestSnap = Array.from(store.snapshots.values())[0];
    assert.ok(latestSnap);

    const earnResult = await earningsService.creditNewEligibleViews('sub_clip_1', latestSnap.id);
    assert.equal(earnResult.newlyCreditedViews, 100000n);
    // 100,000 views @ $1.50 / 1,000 = $150.00
    assert.equal(earnResult.grossAmount.toFixed(2), '150.00');

    // 6. Verify Statistics Engine Consistency
    const statsService = new StatisticsService(store.statisticsRepo);
    const userStats = await statsService.getUserOverview('creator_1');
    assert.equal(userStats.totalSubmissions, 1);
    assert.equal(userStats.approvedSubmissions, 1);
    assert.equal(userStats.totalViews.knownSum, 100000n);
    assert.equal(userStats.totalViews.availability, 'COMPLETE');

    // 7. Verify Payout Service Balance & Execution
    const payoutService = new PayoutService(store.payoutRepo);
    const balanceBefore = await payoutService.getAvailablePayoutBalance('creator_1', 'USD');
    assert.equal(balanceBefore.availableBalance.toFixed(2), '150.00');
    assert.equal(balanceBefore.reservedBalance.toFixed(2), '0.00');

    // Creator requests $100.00 payout
    const payoutReq = await payoutService.createPayoutRequest('creator_1', '100.00', 'USD');
    assert.equal(payoutReq.status, 'REQUESTED');

    const balanceAfterReq = await payoutService.getAvailablePayoutBalance('creator_1', 'USD');
    assert.equal(balanceAfterReq.availableBalance.toFixed(2), '50.00');
    assert.equal(balanceAfterReq.reservedBalance.toFixed(2), '100.00');

    // Staff approves and executes disbursement
    await payoutService.reviewPayoutRequest(payoutReq.id, 'admin_staff');
    await payoutService.approvePayoutRequest(payoutReq.id, 'admin_staff');
    await payoutService.processDisbursement(payoutReq.id, 'MANUAL');
    await payoutService.markDisbursementCompleted(payoutReq.id, 'BANK_REF_999');

    const balanceFinal = await payoutService.getAvailablePayoutBalance('creator_1', 'USD');
    assert.equal(balanceFinal.completedPayouts.toFixed(2), '100.00');
    assert.equal(balanceFinal.reservedBalance.toFixed(2), '0.00');
    assert.equal(balanceFinal.availableBalance.toFixed(2), '50.00');
  });

  test('realistic metric progression: 100k -> 150k -> 220k -> regression (180k) -> 250k', async () => {
    const store = createMockE2EDataStore();
    const earningsService = new EarningsService(store.earningsRepo);

    store.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    store.campaigns.set('c1', { id: 'c1', payRate: new Prisma.Decimal('1.00'), currency: 'USD' });
    store.submissions.set('sub1', { id: 'sub1', userId: 'u1', campaignId: 'c1', status: 'APPROVED' });
    store.verifications.set('sub1', { id: 'v1', status: 'COMPLETED' });

    // 1. Initial snapshot: 100,000 views
    store.snapshots.set('s1', { id: 's1', submissionId: 'sub1', views: 100000n, capturedAt: new Date('2026-09-20T10:00:00Z') });
    const r1 = await earningsService.creditNewEligibleViews('sub1', 's1');
    assert.equal(r1.newlyCreditedViews, 100000n);

    // 2. Second snapshot: 150,000 views (+50k)
    store.snapshots.set('s2', { id: 's2', submissionId: 'sub1', views: 150000n, capturedAt: new Date('2026-09-20T11:00:00Z') });
    const r2 = await earningsService.creditNewEligibleViews('sub1', 's2');
    assert.equal(r2.newlyCreditedViews, 50000n);

    // 3. Third snapshot: 220,000 views (+70k)
    store.snapshots.set('s3', { id: 's3', submissionId: 'sub1', views: 220000n, capturedAt: new Date('2026-09-20T12:00:00Z') });
    const r3 = await earningsService.creditNewEligibleViews('sub1', 's3');
    assert.equal(r3.newlyCreditedViews, 70000n);

    // Total credited after step 3 must be strictly 220,000
    const totalStep3 = await store.earningsRepo.getPreviouslyCreditedViews('sub1');
    assert.equal(totalStep3, 220000n);

    // 4. Fourth snapshot: 180,000 views (Metric regression)
    store.snapshots.set('s4', { id: 's4', submissionId: 'sub1', views: 180000n, capturedAt: new Date('2026-09-20T13:00:00Z') });
    const r4 = await earningsService.creditNewEligibleViews('sub1', 's4');
    assert.equal(r4.newlyCreditedViews, 0n);
    assert.equal(r4.reason, 'METRIC_REGRESSION');

    // High-water mark remains strictly 220,000
    const totalStep4 = await store.earningsRepo.getPreviouslyCreditedViews('sub1');
    assert.equal(totalStep4, 220000n);

    // 5. Fifth snapshot: 250,000 views (+30k beyond high-water mark)
    store.snapshots.set('s5', { id: 's5', submissionId: 'sub1', views: 250000n, capturedAt: new Date('2026-09-20T14:00:00Z') });
    const r5 = await earningsService.creditNewEligibleViews('sub1', 's5');
    assert.equal(r5.newlyCreditedViews, 30000n);

    // Total credited views must strictly equal 250,000
    const totalFinal = await store.earningsRepo.getPreviouslyCreditedViews('sub1');
    assert.equal(totalFinal, 250000n);
  });

  test('rate change preservation: historical earnings remain locked at original rate', async () => {
    const store = createMockE2EDataStore();
    const earningsService = new EarningsService(store.earningsRepo);

    store.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    store.campaigns.set('c1', { id: 'c1', payRate: new Prisma.Decimal('0.80'), currency: 'USD' });
    store.submissions.set('sub1', { id: 'sub1', userId: 'u1', campaignId: 'c1', status: 'APPROVED' });
    store.verifications.set('sub1', { id: 'v1', status: 'COMPLETED' });

    // First credit event: 100,000 views @ $0.80 / 1k = $80.00
    store.snapshots.set('s1', { id: 's1', submissionId: 'sub1', views: 100000n });
    const r1 = await earningsService.creditNewEligibleViews('sub1', 's1');
    assert.equal(r1.grossAmount.toFixed(2), '80.00');

    // Campaign rate changes to $1.00 / 1k
    store.campaigns.get('c1').payRate = new Prisma.Decimal('1.00');

    // Second credit event: 150,000 views (+50k) @ $1.00 / 1k = $50.00
    store.snapshots.set('s2', { id: 's2', submissionId: 'sub1', views: 150000n });
    const r2 = await earningsService.creditNewEligibleViews('sub1', 's2');
    assert.equal(r2.newlyCreditedViews, 50000n);
    assert.equal(r2.grossAmount.toFixed(2), '50.00');

    // Verify historical row 1 was not modified
    const earningRow1 = Array.from(store.earnings.values())[0];
    assert.equal(earningRow1.ratePerThousand.toFixed(2), '0.80');
    assert.equal(earningRow1.grossAmount.toFixed(2), '80.00');

    // Verify total eligible earnings = $80.00 + $50.00 = $130.00
    const breakdown = await store.earningsRepo.getUserEarningsBreakdown('u1');
    assert.equal(breakdown.totalEligibleEarnings.toFixed(2), '130.00');
  });

  test('risk / approval decoupling: metric retrieval does not bypass approval or risk policy', async () => {
    const store = createMockE2EDataStore();

    store.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    store.campaigns.set('c1', { id: 'c1', status: 'ACTIVE', payRate: new Prisma.Decimal('1.00') });
    store.submissions.set('sub_sus', {
      id: 'sub_sus',
      userId: 'u1',
      campaignId: 'c1',
      platform: 'YOUTUBE',
      url: 'https://youtube.com/watch?v=suspicious1',
      status: 'PENDING'
    });

    // Seed prior snapshot of 150k views so a drop to 100k creates a HIGH-severity metric regression anomaly
    store.snapshots.set('prior_snap_sus', {
      id: 'prior_snap_sus',
      submissionId: 'sub_sus',
      views: 150000n,
      likes: 6000n,
      comments: 300n,
      capturedAt: new Date(Date.now() - 3600000)
    });

    // Provider returns anomalous metrics (regression from 150k to 100k + 0 likes and 0 comments)
    // Signal analyzer will produce high anomaly score -> REVIEW_REQUIRED / FLAGGED -> status != APPROVED
    const fakeSuspiciousProvider = {
      name: 'YOUTUBE',
      async getCurrentMetrics() {
        return {
          isAvailable: true,
          views: 100000n,
          likes: 0n,
          comments: 0n,
          shares: null,
          status: 'AVAILABLE',
          availability: {
            views: 'AVAILABLE',
            likes: 'AVAILABLE',
            comments: 'AVAILABLE',
            shares: 'NOT_SUPPORTED'
          }
        };
      }
    };

    const verService = new VerificationService(
      store.verificationRepo,
      store.submissionRepo,
      () => fakeSuspiciousProvider,
      new ApprovalPolicy()
    );

    const result = await verService.runVerification('sub_sus');
    // High risk or review required prevents automatic approval
    assert.notEqual(result.submissionStatus, 'APPROVED');

    // Attempting to credit earnings on an unapproved submission must strictly throw IneligibleSubmissionError
    const earningsService = new EarningsService(store.earningsRepo);
    const snap = Array.from(store.snapshots.values())[0];

    await assert.rejects(
      () => earningsService.creditNewEligibleViews('sub_sus', snap.id),
      IneligibleSubmissionError
    );
  });
});
