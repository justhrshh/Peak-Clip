import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { RetentionService } from '../src/modules/retention/retention.service.js';
import { AdjustmentService } from '../src/modules/adjustments/adjustment.service.js';
import { PayoutService } from '../src/modules/payouts/payout.service.js';
import {
  InvalidPayoutStatusTransitionError,
  UnauthorizedPayoutAccessError,
  PayoutNotFoundError
} from '../src/modules/payouts/payout.errors.js';
import {
  PermanentContentError,
  TransientProviderError,
  ConfigurationAuthError
} from '../src/modules/verification/verification.errors.js';
import { RESERVING_PAYOUT_STATUSES } from '../src/modules/payouts/payout.state-machine.js';

/**
 * In-memory test environment fixture for Phase 10C retention, financial adjustments, and payout cancellations
 */
function createTestEnvironment() {
  const users = new Map();
  const campaigns = new Map();
  const submissions = new Map();
  const earnings = new Map();
  const adjustments = new Map();
  const payoutRequests = new Map();
  const payoutEvents = [];
  const adminAuditEvents = [];

  let idCounter = 1000;

  // Mock Prisma client
  const db = {
    submission: {
      async findUnique({ where, include }) {
        const sub = submissions.get(where.id);
        if (!sub) return null;
        return {
          ...sub,
          campaign: sub.campaignId ? campaigns.get(sub.campaignId) : null,
          user: sub.userId ? users.get(sub.userId) : null,
          earnings: Array.from(earnings.values()).filter((e) => e.submissionId === sub.id)
        };
      },
      async update({ where, data }) {
        const sub = submissions.get(where.id);
        if (!sub) throw new Error('Submission not found');
        const updated = { ...sub, ...data, updatedAt: new Date() };
        submissions.set(where.id, updated);
        return updated;
      },
      async findMany({ where }) {
        let list = Array.from(submissions.values());
        if (where?.retentionRequired !== undefined) {
          list = list.filter((s) => s.retentionRequired === where.retentionRequired);
        }
        if (where?.retentionStatus) {
          list = list.filter((s) => s.retentionStatus === where.retentionStatus);
        }
        return list;
      }
    },

    earning: {
      async findMany({ where }) {
        let list = Array.from(earnings.values());
        if (where?.submissionId) {
          list = list.filter((e) => e.submissionId === where.submissionId);
        }
        if (where?.userId) {
          list = list.filter((e) => e.userId === where.userId);
        }
        if (where?.status) {
          list = list.filter((e) => e.status === where.status);
        }
        return list;
      },
      async aggregate({ where, _sum }) {
        let sum = new Prisma.Decimal('0.00');
        for (const e of earnings.values()) {
          if (where.userId && e.userId !== where.userId) continue;
          if (where.currency && e.currency !== where.currency) continue;
          if (where.status && e.status !== where.status) continue;
          sum = sum.plus(new Prisma.Decimal(e.grossAmount));
        }
        return { _sum: { grossAmount: sum.toNumber() > 0 ? sum : null } };
      }
    },

    financialAdjustment: {
      async create({ data }) {
        const id = `adj_${idCounter++}`;
        const record = {
          id,
          ...data,
          amount: new Prisma.Decimal(data.amount),
          createdAt: new Date()
        };
        adjustments.set(id, record);
        return record;
      },
      async findUnique({ where }) {
        if (where?.earningId_type) {
          for (const adj of adjustments.values()) {
            if (adj.earningId === where.earningId_type.earningId && adj.type === where.earningId_type.type) {
              return adj;
            }
          }
          return null;
        }
        return null;
      },
      async findMany({ where }) {
        let list = Array.from(adjustments.values());
        if (where?.userId) list = list.filter((a) => a.userId === where.userId);
        if (where?.submissionId) list = list.filter((a) => a.submissionId === where.submissionId);
        return list;
      },
      async aggregate({ where, _sum }) {
        let sum = new Prisma.Decimal('0.00');
        for (const a of adjustments.values()) {
          if (where.userId && a.userId !== where.userId) continue;
          if (where.currency && a.currency !== where.currency) continue;
          sum = sum.plus(new Prisma.Decimal(a.amount));
        }
        return { _sum: { amount: sum } };
      }
    },

    payoutRequest: {
      async findUnique({ where }) {
        const pr = payoutRequests.get(where.id);
        if (!pr) return null;
        return {
          ...pr,
          user: users.get(pr.userId) || null,
          disbursements: [],
          events: payoutEvents.filter((e) => e.payoutRequestId === pr.id)
        };
      },
      async update({ where, data }) {
        const pr = payoutRequests.get(where.id);
        if (!pr) throw new Error('Payout request not found');
        const updated = { ...pr, ...data, updatedAt: new Date() };
        payoutRequests.set(where.id, updated);
        return updated;
      },
      async aggregate({ where, _sum }) {
        let sum = new Prisma.Decimal('0.00');
        for (const pr of payoutRequests.values()) {
          if (where.userId && pr.userId !== where.userId) continue;
          if (where.currency && pr.currency !== where.currency) continue;
          if (where.status?.in && !where.status.in.includes(pr.status)) continue;
          if (where.status && typeof where.status === 'string' && pr.status !== where.status) continue;
          sum = sum.plus(new Prisma.Decimal(pr.amount));
        }
        return { _sum: { amount: sum } };
      },
      async findMany({ where }) {
        let list = Array.from(payoutRequests.values());
        if (where?.userId) list = list.filter((p) => p.userId === where.userId);
        return list;
      }
    },

    payoutEvent: {
      async create({ data }) {
        const evt = { id: `evt_${idCounter++}`, ...data, createdAt: new Date() };
        payoutEvents.push(evt);
        return evt;
      }
    },

    adminAuditEvent: {
      async create({ data }) {
        const evt = { id: `aevt_${idCounter++}`, ...data, createdAt: new Date() };
        adminAuditEvents.push(evt);
        return evt;
      }
    }
  };

  // Mock Audit Repo
  const mockAuditRepo = {
    async recordEvent(params) {
      const evt = { id: `aevt_${idCounter++}`, ...params, createdAt: new Date() };
      adminAuditEvents.push(evt);
      return evt;
    }
  };

  // Mock Adjustment Repo
  const mockAdjRepo = {
    async createAdjustment(data) {
      return db.financialAdjustment.create({ data });
    },
    async getAdjustmentByEarningAndType(earningId, type) {
      return db.financialAdjustment.findUnique({ where: { earningId_type: { earningId, type } } });
    },
    async getAdjustmentsByUserId(userId, currency) {
      return db.financialAdjustment.findMany({ where: { userId } });
    },
    async getNetAdjustmentAmount(userId, currency = 'USD') {
      const agg = await db.financialAdjustment.aggregate({ where: { userId, currency }, _sum: { amount: true } });
      return agg._sum.amount ? new Prisma.Decimal(agg._sum.amount) : new Prisma.Decimal('0.00');
    }
  };

  // Mock Payout Repo
  const mockPayoutRepo = {
    prisma: db,
    async transaction(cb) {
      return cb(mockPayoutRepo);
    },
    async acquirePayoutBalanceLock(userId, tx) {
      return true;
    },
    async getPayoutRequestById(id) {
      return db.payoutRequest.findUnique({ where: { id } });
    },
    async updatePayoutRequest(id, data) {
      return db.payoutRequest.update({ where: { id }, data });
    },
    async recordPayoutEvent(data) {
      return db.payoutEvent.create({ data });
    },
    async getUserPayoutRequests(userId) {
      return db.payoutRequest.findMany({ where: { userId } });
    },
    async getPayoutBalanceBreakdown(userId, currency = 'USD') {
      // 1. Sum ELIGIBLE earnings
      const eAgg = await db.earning.aggregate({ where: { userId, currency, status: 'ELIGIBLE' }, _sum: { grossAmount: true } });
      const eligibleEarnings = eAgg._sum.grossAmount ? new Prisma.Decimal(eAgg._sum.grossAmount) : new Prisma.Decimal('0.00');

      // 2. Net adjustments
      const aAgg = await db.financialAdjustment.aggregate({ where: { userId, currency }, _sum: { amount: true } });
      const netAdjustments = aAgg._sum.amount ? new Prisma.Decimal(aAgg._sum.amount) : new Prisma.Decimal('0.00');

      // 3. Reserved
      const rAgg = await db.payoutRequest.aggregate({ where: { userId, currency, status: { in: [...RESERVING_PAYOUT_STATUSES] } }, _sum: { amount: true } });
      const reservedBalance = rAgg._sum.amount ? new Prisma.Decimal(rAgg._sum.amount) : new Prisma.Decimal('0.00');

      // 4. Completed
      const cAgg = await db.payoutRequest.aggregate({ where: { userId, currency, status: 'COMPLETED' }, _sum: { amount: true } });
      const completedPayouts = cAgg._sum.amount ? new Prisma.Decimal(cAgg._sum.amount) : new Prisma.Decimal('0.00');

      // 5. Available
      let availableBalance = eligibleEarnings.plus(netAdjustments).minus(reservedBalance).minus(completedPayouts);
      if (availableBalance.lessThan(0)) availableBalance = new Prisma.Decimal('0.00');

      return {
        eligibleEarnings,
        netAdjustments,
        reservedBalance,
        completedPayouts,
        availableBalance,
        minimumPayout: new Prisma.Decimal('10.00'),
        currency
      };
    }
  };

  const adjustmentService = new AdjustmentService(mockAdjRepo, db);
  const payoutService = new PayoutService(mockPayoutRepo, null, mockAuditRepo);

  return {
    users,
    campaigns,
    submissions,
    earnings,
    adjustments,
    payoutRequests,
    payoutEvents,
    adminAuditEvents,
    db,
    mockAuditRepo,
    mockAdjRepo,
    mockPayoutRepo,
    adjustmentService,
    payoutService
  };
}

describe('PHASE 10C — RETENTION ENFORCEMENT & PAYOUT CANCELLATION', () => {

  // =========================================================================
  // 1. RETENTION LIFECYCLE & MONITORING
  // =========================================================================
  describe('1. Retention State Transitions & Monitoring', () => {
    test('ACTIVE -> FULFILLED when now >= retentionDeadline and provider confirms video available', async () => {
      const env = createTestEnvironment();
      const approvedAt = new Date('2026-01-01T00:00:00Z');
      const deadline = new Date('2026-01-31T00:00:00Z');

      const user = { id: 'usr_1', username: 'creator1', discordId: '12345' };
      const campaign = { id: 'cmp_1', name: 'Test Campaign', retentionDays: 30 };
      const sub = {
        id: 'sub_1',
        userId: user.id,
        campaignId: campaign.id,
        platform: 'YOUTUBE',
        url: 'https://youtube.com/watch?v=dur00000030',
        retentionRequired: true,
        retentionStatus: 'ACTIVE',
        approvedAt,
        retentionDeadline: deadline
      };

      env.users.set(user.id, user);
      env.campaigns.set(campaign.id, campaign);
      env.submissions.set(sub.id, sub);

      const mockProvider = {
        async getAvailability() {
          return { isAvailable: true, status: 'AVAILABLE' };
        }
      };

      const retentionService = new RetentionService(
        env.db,
        env.adjustmentService,
        env.mockAuditRepo,
        () => mockProvider
      );

      // Check on deadline day (now >= deadline)
      const res = await retentionService.checkSubmissionRetention(sub.id, {
        now: new Date('2026-01-31T12:00:00Z')
      });

      assert.equal(res.status, 'FULFILLED');
      const updated = env.submissions.get(sub.id);
      assert.equal(updated.retentionStatus, 'FULFILLED');
      assert.equal(updated.lastAvailabilityStatus, 'AVAILABLE');

      // Audit event logged
      const auditEvt = env.adminAuditEvents.find((e) => e.action === 'RETENTION_FULFILLED');
      assert.ok(auditEvt);
      assert.equal(auditEvt.entityId, sub.id);
    });

    test('ACTIVE -> VIOLATED when video is deleted or private before retentionDeadline', async () => {
      const env = createTestEnvironment();
      const approvedAt = new Date('2026-01-01T00:00:00Z');
      const deadline = new Date('2026-01-31T00:00:00Z');

      const user = { id: 'usr_1', username: 'creator1', discordId: '12345' };
      const campaign = { id: 'cmp_1', name: 'Test Campaign', retentionDays: 30 };
      const sub = {
        id: 'sub_violation',
        userId: user.id,
        campaignId: campaign.id,
        platform: 'YOUTUBE',
        url: 'https://youtube.com/watch?v=dur00000030',
        retentionRequired: true,
        retentionStatus: 'ACTIVE',
        approvedAt,
        retentionDeadline: deadline
      };

      // Associated earning: +$50.00
      const earning = {
        id: 'earn_1',
        userId: user.id,
        campaignId: campaign.id,
        submissionId: sub.id,
        grossAmount: new Prisma.Decimal('50.00'),
        status: 'ELIGIBLE',
        currency: 'USD',
        eligibleViews: 10000n
      };

      env.users.set(user.id, user);
      env.campaigns.set(campaign.id, campaign);
      env.submissions.set(sub.id, sub);
      env.earnings.set(earning.id, earning);

      const mockProvider = {
        async getAvailability() {
          throw new PermanentContentError('Video was deleted by creator');
        }
      };

      const retentionService = new RetentionService(
        env.db,
        env.adjustmentService,
        env.mockAuditRepo,
        () => mockProvider,
        { deletionStrikes: 1 }
      );

      // Check on day 15 (before deadline)
      const res = await retentionService.checkSubmissionRetention(sub.id, {
        now: new Date('2026-01-15T00:00:00Z')
      });

      assert.equal(res.status, 'VIOLATED');
      const updated = env.submissions.get(sub.id);
      assert.equal(updated.retentionStatus, 'VIOLATED');
      assert.ok(updated.retentionViolatedAt);
      assert.match(updated.retentionViolationReason, /Video was deleted/i);

      // Audit event logged
      const auditEvt = env.adminAuditEvents.find((e) => e.action === 'RETENTION_VIOLATED');
      assert.ok(auditEvt);
      assert.equal(auditEvt.entityId, sub.id);

      // Financial adjustment created: -$50.00
      const createdAdj = Array.from(env.adjustments.values()).find((a) => a.submissionId === sub.id);
      assert.ok(createdAdj);
      assert.equal(createdAdj.amount.toString(), '-50');
      assert.equal(createdAdj.type, 'RETENTION_VIOLATION');
      assert.equal(createdAdj.earningId, earning.id);

      // ORIGINAL EARNING REMAINS UNTOUCHED
      const untouchedEarning = env.earnings.get(earning.id);
      assert.equal(untouchedEarning.grossAmount.toString(), '50');
      assert.equal(untouchedEarning.status, 'ELIGIBLE');
    });

    test('DATA_UNAVAILABLE from boundary provider does NOT violate retention', async () => {
      const env = createTestEnvironment();
      const approvedAt = new Date('2026-01-01T00:00:00Z');
      const deadline = new Date('2026-01-31T00:00:00Z');

      const user = { id: 'usr_tt', username: 'tiktok_creator' };
      const campaign = { id: 'cmp_tt', name: 'TikTok Campaign', retentionDays: 30 };
      const sub = {
        id: 'sub_tt',
        userId: user.id,
        campaignId: campaign.id,
        platform: 'TIKTOK',
        url: 'https://www.tiktok.com/@creator/video/1234567890',
        retentionRequired: true,
        retentionStatus: 'ACTIVE',
        approvedAt,
        retentionDeadline: deadline
      };

      env.users.set(user.id, user);
      env.campaigns.set(campaign.id, campaign);
      env.submissions.set(sub.id, sub);

      const mockProvider = {
        async getAvailability() {
          return {
            isAvailable: true,
            status: 'DATA_UNAVAILABLE',
            reason: 'OAuth required'
          };
        }
      };

      const retentionService = new RetentionService(
        env.db,
        env.adjustmentService,
        env.mockAuditRepo,
        () => mockProvider
      );

      const res = await retentionService.checkSubmissionRetention(sub.id, {
        now: new Date('2026-01-15T00:00:00Z')
      });

      assert.equal(res.status, 'ACTIVE');
      assert.equal(res.availability, 'DATA_UNAVAILABLE');

      const updated = env.submissions.get(sub.id);
      assert.equal(updated.retentionStatus, 'ACTIVE'); // NOT VIOLATED!
      assert.equal(updated.lastAvailabilityStatus, 'DATA_UNAVAILABLE');
      assert.equal(env.adjustments.size, 0); // NO ADJUSTMENT
    });

    test('repeated worker execution is idempotent and cannot create duplicate adjustments', async () => {
      const env = createTestEnvironment();
      const sub = {
        id: 'sub_idempotent',
        userId: 'usr_1',
        campaignId: 'cmp_1',
        platform: 'YOUTUBE',
        url: 'https://youtube.com/watch?v=dur00000030',
        retentionRequired: true,
        retentionStatus: 'ACTIVE',
        approvedAt: new Date('2026-01-01T00:00:00Z'),
        retentionDeadline: new Date('2026-01-31T00:00:00Z')
      };
      const earning = {
        id: 'earn_idem',
        userId: 'usr_1',
        campaignId: 'cmp_1',
        submissionId: sub.id,
        grossAmount: new Prisma.Decimal('50.00'),
        status: 'ELIGIBLE',
        currency: 'USD',
        eligibleViews: 5000n
      };

      env.submissions.set(sub.id, sub);
      env.earnings.set(earning.id, earning);

      const mockProvider = {
        async getAvailability() {
          throw new PermanentContentError('Video deleted');
        }
      };

      const retentionService = new RetentionService(
        env.db,
        env.adjustmentService,
        env.mockAuditRepo,
        () => mockProvider,
        { deletionStrikes: 1 }
      );

      // Run 1: Transitions to VIOLATED and creates 1 adjustment
      const res1 = await retentionService.checkSubmissionRetention(sub.id);
      assert.equal(res1.status, 'VIOLATED');
      assert.equal(env.adjustments.size, 1);

      // Run 2: Already terminal VIOLATED -> idempotent skip, 0 new adjustments
      const res2 = await retentionService.checkSubmissionRetention(sub.id);
      assert.equal(res2.status, 'VIOLATED');
      assert.equal(res2.alreadyTerminal, true);
      assert.equal(env.adjustments.size, 1); // Exact same count
    });

    test('IMP-07: requires N consecutive failures before violation; transient errors do not increment; success resets strikes', async () => {
      const env = createTestEnvironment();
      const approvedAt = new Date('2026-01-01T00:00:00Z');
      const deadline = new Date('2026-01-31T00:00:00Z');

      const user = { id: 'usr_strikes', username: 'strike_user', discordId: '99999' };
      const campaign = { id: 'cmp_strikes', name: 'Strike Campaign', retentionDays: 30 };
      const sub = {
        id: 'sub_strikes',
        userId: user.id,
        campaignId: campaign.id,
        platform: 'YOUTUBE',
        url: 'https://youtube.com/watch?v=dur00000030',
        retentionRequired: true,
        retentionStatus: 'ACTIVE',
        approvedAt,
        retentionDeadline: deadline
      };
      const earning = {
        id: 'earn_strikes',
        userId: user.id,
        campaignId: campaign.id,
        submissionId: sub.id,
        grossAmount: new Prisma.Decimal('50.00'),
        status: 'ELIGIBLE',
        currency: 'USD',
        eligibleViews: 10000n
      };

      env.users.set(user.id, user);
      env.campaigns.set(campaign.id, campaign);
      env.submissions.set(sub.id, sub);
      env.earnings.set(earning.id, earning);

      let providerBehavior = 'NOT_FOUND';
      const mockProvider = {
        async getAvailability() {
          if (providerBehavior === 'NOT_FOUND') {
            throw new PermanentContentError('Video not found (404)');
          } else if (providerBehavior === 'TRANSIENT') {
            throw new TransientProviderError('Network timeout');
          } else if (providerBehavior === 'AUTH_ERROR') {
            throw new ConfigurationAuthError('Invalid API token');
          } else if (providerBehavior === 'DATA_UNAVAILABLE') {
            return { isAvailable: true, status: 'DATA_UNAVAILABLE', reason: 'Scraper rate limited' };
          } else if (providerBehavior === 'LIVE') {
            return { isAvailable: true, status: 'AVAILABLE' };
          }
          return { isAvailable: false, status: 'UNAVAILABLE' };
        }
      };

      const retentionService = new RetentionService(
        env.db,
        env.adjustmentService,
        env.mockAuditRepo,
        () => mockProvider,
        { deletionStrikes: 3 }
      );

      const testNow = { now: new Date('2026-01-15T00:00:00Z') };

      // Check 1: 404 -> strike 1 (remains ACTIVE)
      const res1 = await retentionService.checkSubmissionRetention(sub.id, testNow);
      assert.equal(res1.status, 'ACTIVE');
      assert.equal(res1.strikes, 1);
      assert.equal(await retentionService.getStrikes(sub.id), 1);
      assert.equal(env.submissions.get(sub.id).retentionStatus, 'ACTIVE');

      // Check 2: Transient network error -> throws, strike remains 1 (NOT incremented)
      providerBehavior = 'TRANSIENT';
      await assert.rejects(() => retentionService.checkSubmissionRetention(sub.id, testNow), TransientProviderError);
      assert.equal(await retentionService.getStrikes(sub.id), 1);

      // Check 3: Scraper auth error -> does NOT increment strike
      providerBehavior = 'AUTH_ERROR';
      const resAuth = await retentionService.checkSubmissionRetention(sub.id, testNow);
      assert.equal(resAuth.status, 'ACTIVE');
      assert.equal(await retentionService.getStrikes(sub.id), 1);

      // Check 4: DATA_UNAVAILABLE -> does NOT increment strike
      providerBehavior = 'DATA_UNAVAILABLE';
      const resDataUnavail = await retentionService.checkSubmissionRetention(sub.id, testNow);
      assert.equal(resDataUnavail.status, 'ACTIVE');
      assert.equal(await retentionService.getStrikes(sub.id), 1);

      // Check 5: Success (LIVE) -> RESETS strike counter to 0
      providerBehavior = 'LIVE';
      const resLive = await retentionService.checkSubmissionRetention(sub.id, testNow);
      assert.equal(resLive.status, 'ACTIVE');
      assert.equal(await retentionService.getStrikes(sub.id), 0);

      // Check 6: Strike 1 of 3 after reset -> remains ACTIVE
      providerBehavior = 'NOT_FOUND';
      const r1 = await retentionService.checkSubmissionRetention(sub.id, testNow);
      assert.equal(r1.status, 'ACTIVE');
      assert.equal(r1.strikes, 1);
      assert.equal(await retentionService.getStrikes(sub.id), 1);

      // Check 7: Strike 2 of 3 -> remains ACTIVE
      const r2 = await retentionService.checkSubmissionRetention(sub.id, testNow);
      assert.equal(r2.status, 'ACTIVE');
      assert.equal(r2.strikes, 2);
      assert.equal(await retentionService.getStrikes(sub.id), 2);

      // Check 8: Strike 3 of 3 -> REACHES THRESHOLD -> VIOLATED!
      const r3 = await retentionService.checkSubmissionRetention(sub.id, testNow);
      assert.equal(r3.status, 'VIOLATED');
      assert.equal(env.submissions.get(sub.id).retentionStatus, 'VIOLATED');
      assert.equal(await retentionService.getStrikes(sub.id), 0); // Reset upon violation
      assert.equal(env.adjustments.size, 1); // Financial penalty applied
    });
  });

  // =========================================================================
  // 2. FINANCIAL RULES & LEDGER IMMUTABILITY
  // =========================================================================
  describe('2. Financial Rules & Immutable Ledger', () => {
    test('approval makes earnings ELIGIBLE immediately; retention does NOT delay payout eligibility', async () => {
      const env = createTestEnvironment();
      const userId = 'usr_imm';

      // Creator has approved earning of $75.00
      env.earnings.set('earn_imm', {
        id: 'earn_imm',
        userId,
        campaignId: 'cmp_1',
        submissionId: 'sub_imm',
        grossAmount: new Prisma.Decimal('75.00'),
        status: 'ELIGIBLE',
        currency: 'USD',
        eligibleViews: 10000n
      });

      // User requests payout balance
      const breakdown = await env.mockPayoutRepo.getPayoutBalanceBreakdown(userId, 'USD');
      assert.equal(breakdown.eligibleEarnings.toString(), '75');
      assert.equal(breakdown.availableBalance.toString(), '75'); // 100% available immediately
      assert.equal(breakdown.netAdjustments.toString(), '0');
    });

    test('retention violation creates auditable adjustment that reduces future available balance', async () => {
      const env = createTestEnvironment();
      const userId = 'usr_adj';

      // 1. Original Earning: +$50.00
      const earning = {
        id: 'earn_adj',
        userId,
        campaignId: 'cmp_1',
        submissionId: 'sub_adj',
        grossAmount: new Prisma.Decimal('50.00'),
        status: 'ELIGIBLE',
        currency: 'USD',
        eligibleViews: 5000n
      };
      env.earnings.set(earning.id, earning);

      // 2. Initial balance before violation: $50.00 available
      let balance = await env.mockPayoutRepo.getPayoutBalanceBreakdown(userId, 'USD');
      assert.equal(balance.availableBalance.toString(), '50');

      // 3. Create retention violation adjustment: -$50.00
      const sub = { id: 'sub_adj', userId, campaignId: 'cmp_1' };
      await env.adjustmentService.createRetentionViolationAdjustments(sub, 'Video deleted');

      // 4. Authoritative derivation after adjustment:
      // Original Earning: +$50
      // Retention Adjustment: -$50
      // Net Future Available Balance: $0
      balance = await env.mockPayoutRepo.getPayoutBalanceBreakdown(userId, 'USD');
      assert.equal(balance.eligibleEarnings.toString(), '50');
      assert.equal(balance.netAdjustments.toString(), '-50');
      assert.equal(balance.availableBalance.toString(), '0');

      // Original earning was NEVER mutated or deleted
      const original = env.earnings.get(earning.id);
      assert.equal(original.grossAmount.toString(), '50');
      assert.equal(original.status, 'ELIGIBLE');
    });

    test('adjustment cannot exceed applicable earning and prevents silent negative balance', async () => {
      const env = createTestEnvironment();
      const userId = 'usr_bound';

      // Creator has $30 earning
      const earning = {
        id: 'earn_bound',
        userId,
        campaignId: 'cmp_1',
        submissionId: 'sub_bound',
        grossAmount: new Prisma.Decimal('30.00'),
        status: 'ELIGIBLE',
        currency: 'USD',
        eligibleViews: 2000n
      };
      env.earnings.set(earning.id, earning);

      // Creator previously completed a payout of $30.00
      env.payoutRequests.set('pr_completed', {
        id: 'pr_completed',
        userId,
        amount: new Prisma.Decimal('30.00'),
        status: 'COMPLETED',
        currency: 'USD'
      });

      // Now retention violation occurs
      await env.adjustmentService.createRetentionViolationAdjustments(
        { id: 'sub_bound', userId, campaignId: 'cmp_1' },
        'Deleted'
      );

      // Available balance formula: MAX(0, 30 + (-30) - 0 - 30) = MAX(0, -30) = 0.00
      const balance = await env.mockPayoutRepo.getPayoutBalanceBreakdown(userId, 'USD');
      assert.equal(balance.availableBalance.toString(), '0'); // Safe non-negative available balance

      // Completed payout is NEVER mutated
      const completedPR = env.payoutRequests.get('pr_completed');
      assert.equal(completedPR.status, 'COMPLETED');
      assert.equal(completedPR.amount.toString(), '30');
    });
  });

  // =========================================================================
  // 3. PAYOUT CANCELLATION LIFECYCLE & CONCURRENCY
  // =========================================================================
  describe('3. Payout Cancellation Engine', () => {
    test('REQUESTED payout can be cancelled and releases reservation', async () => {
      const env = createTestEnvironment();
      const userId = 'usr_can';

      // 1. Creator has $100 earning and a $40 REQUESTED payout
      env.earnings.set('earn_1', {
        id: 'earn_1',
        userId,
        campaignId: 'cmp_1',
        grossAmount: new Prisma.Decimal('100.00'),
        status: 'ELIGIBLE',
        currency: 'USD'
      });

      const pr = {
        id: 'pr_req',
        userId,
        amount: new Prisma.Decimal('40.00'),
        status: 'REQUESTED',
        currency: 'USD',
        requestedAt: new Date()
      };
      env.payoutRequests.set(pr.id, pr);

      // Available before cancel: $100 - $40 = $60
      let bBefore = await env.mockPayoutRepo.getPayoutBalanceBreakdown(userId, 'USD');
      assert.equal(bBefore.availableBalance.toString(), '60');
      assert.equal(bBefore.reservedBalance.toString(), '40');

      // 2. Creator cancels payout
      const res = await env.payoutService.cancelPayoutRequest(userId, pr.id, 'Changed mind');
      assert.equal(res.status, 'CANCELLED');
      assert.ok(res.cancelledAt);
      assert.equal(res.cancelledBy, userId);
      assert.equal(res.cancellationReason, 'Changed mind');

      // 3. Available after cancel: reservation released -> full $100 available again
      let bAfter = await env.mockPayoutRepo.getPayoutBalanceBreakdown(userId, 'USD');
      assert.equal(bAfter.availableBalance.toString(), '100');
      assert.equal(bAfter.reservedBalance.toString(), '0');

      // Payout lifecycle event recorded
      const evt = env.payoutEvents.find((e) => e.payoutRequestId === pr.id && e.type === 'CANCELLED');
      assert.ok(evt);

      // Admin audit event recorded
      const aEvt = env.adminAuditEvents.find((e) => e.entityId === pr.id && e.action === 'PAYOUT_CANCEL');
      assert.ok(aEvt);
    });

    test('UNDER_REVIEW and APPROVED payouts can also be cancelled by creator', async () => {
      const env = createTestEnvironment();
      const userId = 'usr_can2';

      // UNDER_REVIEW
      const prReview = {
        id: 'pr_review',
        userId,
        amount: new Prisma.Decimal('25.00'),
        status: 'UNDER_REVIEW',
        currency: 'USD'
      };
      env.payoutRequests.set(prReview.id, prReview);

      const resReview = await env.payoutService.cancelPayoutRequest(userId, prReview.id);
      assert.equal(resReview.status, 'CANCELLED');

      // APPROVED
      const prApproved = {
        id: 'pr_approved',
        userId,
        amount: new Prisma.Decimal('50.00'),
        status: 'APPROVED',
        currency: 'USD'
      };
      env.payoutRequests.set(prApproved.id, prApproved);

      const resApproved = await env.payoutService.cancelPayoutRequest(userId, prApproved.id);
      assert.equal(resApproved.status, 'CANCELLED');
    });

    test('PROCESSING and COMPLETED payouts CANNOT be cancelled (strictly rejected)', async () => {
      const env = createTestEnvironment();
      const userId = 'usr_proc';

      // PROCESSING
      env.payoutRequests.set('pr_proc', {
        id: 'pr_proc',
        userId,
        amount: new Prisma.Decimal('50.00'),
        status: 'PROCESSING',
        currency: 'USD'
      });

      await assert.rejects(
        () => env.payoutService.cancelPayoutRequest(userId, 'pr_proc'),
        InvalidPayoutStatusTransitionError
      );

      // COMPLETED
      env.payoutRequests.set('pr_comp', {
        id: 'pr_comp',
        userId,
        amount: new Prisma.Decimal('50.00'),
        status: 'COMPLETED',
        currency: 'USD'
      });

      await assert.rejects(
        () => env.payoutService.cancelPayoutRequest(userId, 'pr_comp'),
        InvalidPayoutStatusTransitionError
      );
    });

    test('double cancellation is rejected safely (cannot cancel twice)', async () => {
      const env = createTestEnvironment();
      const userId = 'usr_double';

      env.payoutRequests.set('pr_double', {
        id: 'pr_double',
        userId,
        amount: new Prisma.Decimal('30.00'),
        status: 'REQUESTED',
        currency: 'USD'
      });

      // 1st cancel: succeeds
      await env.payoutService.cancelPayoutRequest(userId, 'pr_double');

      // 2nd cancel: rejected by state machine
      await assert.rejects(
        () => env.payoutService.cancelPayoutRequest(userId, 'pr_double'),
        InvalidPayoutStatusTransitionError
      );
    });

    test('creator CANNOT cancel another creator payout request', async () => {
      const env = createTestEnvironment();
      const ownerId = 'usr_owner';
      const maliciousId = 'usr_attacker';

      env.payoutRequests.set('pr_secure', {
        id: 'pr_secure',
        userId: ownerId,
        amount: new Prisma.Decimal('50.00'),
        status: 'REQUESTED',
        currency: 'USD'
      });

      await assert.rejects(
        () => env.payoutService.cancelPayoutRequest(maliciousId, 'pr_secure'),
        UnauthorizedPayoutAccessError
      );

      // Original request remains REQUESTED
      const untouched = env.payoutRequests.get('pr_secure');
      assert.equal(untouched.status, 'REQUESTED');
    });

    test('cancelled payout preserves original record and creator can request again later', async () => {
      const env = createTestEnvironment();
      const userId = 'usr_cycle';

      env.earnings.set('earn_cycle', {
        id: 'earn_cycle',
        userId,
        campaignId: 'cmp_1',
        grossAmount: new Prisma.Decimal('100.00'),
        status: 'ELIGIBLE',
        currency: 'USD'
      });

      // Request 1
      env.payoutRequests.set('pr_first', {
        id: 'pr_first',
        userId,
        amount: new Prisma.Decimal('50.00'),
        status: 'REQUESTED',
        currency: 'USD'
      });

      // Cancel Request 1
      await env.payoutService.cancelPayoutRequest(userId, 'pr_first');

      // Original record is preserved permanently with status CANCELLED
      const first = env.payoutRequests.get('pr_first');
      assert.equal(first.status, 'CANCELLED');
      assert.ok(first.cancelledAt);

      // Creator can request a new payout
      const b = await env.mockPayoutRepo.getPayoutBalanceBreakdown(userId, 'USD');
      assert.equal(b.availableBalance.toString(), '100'); // Full balance available to request again
    });
  });
});
