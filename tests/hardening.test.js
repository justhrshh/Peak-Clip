import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import {
  evaluatePollingEligibility,
  isSubmissionEligibleForPolling,
  hasMetricsChanged,
  CAMPAIGN_POLL_GRACE_PERIOD_MS
} from '../src/modules/verification/polling.policy.js';
import {
  hasProviderCapability,
  getProviderCapabilities,
  PLATFORM_CAPABILITIES
} from '../src/providers/capabilities.js';
import {
  TransientProviderError,
  PermanentContentError,
  ConfigurationAuthError,
  RateLimitProviderError,
  UnsupportedOperationError
} from '../src/modules/verification/verification.errors.js';
import { EarningsService } from '../src/modules/earnings/earnings.service.js';
import { calculateGrossAmount } from '../src/modules/earnings/earnings.calculator.js';
import { PayoutService } from '../src/modules/payouts/payout.service.js';
import {
  InsufficientBalanceError,
  InvalidPayoutStatusTransitionError
} from '../src/modules/payouts/payout.errors.js';
import { RESERVING_PAYOUT_STATUSES } from '../src/modules/payouts/payout.state-machine.js';
import { checkLiveness, checkReadiness } from '../src/utils/health.js';
import {
  rateLimiter,
  enforceSubmissionRateLimit,
  enforcePayoutRateLimit,
  RateLimitExceededError
} from '../src/utils/rate-limiter.js';

// Helper: In-memory mock repository with simulated transactional locking
function createMockHardenedRepo() {
  const users = new Map();
  const campaigns = new Map();
  const submissions = new Map();
  const snapshots = new Map();
  const verifications = new Map();
  const earnings = new Map();
  const payoutRequests = new Map();
  const disbursements = new Map();
  const events = [];

  // Simulated locks for transactional serialization
  const locks = new Map();

  let earningCounter = 1;
  let payoutCounter = 1;
  let disburseCounter = 1;

  async function acquireLock(key) {
    while (locks.has(key)) {
      await locks.get(key);
    }
    let release;
    const lockPromise = new Promise((resolve) => {
      release = resolve;
    });
    locks.set(key, lockPromise);
    return () => {
      locks.delete(key);
      release();
    };
  }

  const repo = {
    users,
    campaigns,
    submissions,
    snapshots,
    verifications,
    earnings,
    payoutRequests,
    disbursements,
    events,

    async transaction(callback) {
      const txLocks = [];
      const tx = { _txLocks: txLocks };

      try {
        return await callback(tx);
      } finally {
        for (const release of txLocks) {
          release();
        }
      }
    },

    async acquireSubmissionLock(submissionId, tx = null) {
      const release = await acquireLock(`submission_${submissionId}`);
      if (tx?._txLocks) {
        tx._txLocks.push(release);
      } else {
        release();
      }
    },

    async acquireUserPayoutLock(userId, tx = null) {
      const release = await acquireLock(`payout_user_${userId}`);
      if (tx?._txLocks) {
        tx._txLocks.push(release);
      } else {
        release();
      }
    },

    async acquirePayoutRequestLock(payoutRequestId, tx = null) {
      const release = await acquireLock(`payout_disburse_${payoutRequestId}`);
      if (tx?._txLocks) {
        tx._txLocks.push(release);
      } else {
        release();
      }
    },

    async getUserById(userId) {
      return users.get(userId) || null;
    },

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
      // Enforce sourceSnapshotId unique constraint
      for (const e of earnings.values()) {
        if (e.sourceSnapshotId === data.sourceSnapshotId) {
          const err = new Error('Unique constraint failed on sourceSnapshotId');
          err.code = 'P2002';
          throw err;
        }
      }
      const id = `earn_${earningCounter++}`;
      const record = { id, ...data, createdAt: new Date() };
      earnings.set(id, record);
      return record;
    },

    async getPayoutBalanceBreakdown(userId, currency = 'USD') {
      let eligibleEarnings = new Prisma.Decimal('0.00');
      for (const e of earnings.values()) {
        if (e.userId === userId && e.currency === currency && e.status === 'ELIGIBLE') {
          eligibleEarnings = eligibleEarnings.plus(new Prisma.Decimal(e.grossAmount));
        }
      }

      let reservedBalance = new Prisma.Decimal('0.00');
      for (const pr of payoutRequests.values()) {
        if (pr.userId === userId && pr.currency === currency && RESERVING_PAYOUT_STATUSES.includes(pr.status)) {
          reservedBalance = reservedBalance.plus(new Prisma.Decimal(pr.amount));
        }
      }

      let completedPayouts = new Prisma.Decimal('0.00');
      for (const pr of payoutRequests.values()) {
        if (pr.userId === userId && pr.currency === currency && pr.status === 'COMPLETED') {
          completedPayouts = completedPayouts.plus(new Prisma.Decimal(pr.amount));
        }
      }

      let availableBalance = eligibleEarnings.minus(reservedBalance).minus(completedPayouts);
      if (availableBalance.lessThan(0)) {
        availableBalance = new Prisma.Decimal('0.00');
      }

      return {
        eligibleEarnings: eligibleEarnings.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
        reservedBalance: reservedBalance.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
        completedPayouts: completedPayouts.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
        availableBalance: availableBalance.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
        minimumPayout: new Prisma.Decimal('10.00'),
        currency
      };
    },

    async createPayoutRequest(data) {
      const id = `pr_${payoutCounter++}`;
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
      events.push(data);
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
      const id = `dis_${disburseCounter++}`;
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
  };

  return repo;
}

describe('Scheduled Polling Eligibility & Change Detection', () => {
  test('qualifies approved submission on active campaign with view-capable provider', () => {
    const submission = {
      id: 'sub_1',
      status: 'APPROVED',
      platform: 'YOUTUBE',
      deletedAt: null,
      user: { status: 'ACTIVE' },
      campaign: { status: 'ACTIVE' }
    };
    const result = evaluatePollingEligibility(submission);
    assert.equal(result.eligible, true);
    assert.equal(result.reason, 'ELIGIBLE');
  });

  test('disqualifies unapproved, deleted, or suspended creator submissions', () => {
    // Unapproved
    assert.equal(isSubmissionEligibleForPolling({ status: 'PENDING', platform: 'YOUTUBE', campaign: { status: 'ACTIVE' } }), false);

    // Soft deleted
    assert.equal(
      isSubmissionEligibleForPolling({
        status: 'APPROVED',
        deletedAt: new Date(),
        platform: 'YOUTUBE',
        campaign: { status: 'ACTIVE' }
      }),
      false
    );

    // Banned creator
    assert.equal(
      isSubmissionEligibleForPolling({
        status: 'APPROVED',
        platform: 'YOUTUBE',
        user: { status: 'BANNED' },
        campaign: { status: 'ACTIVE' }
      }),
      false
    );
  });

  test('disqualifies unsupported platforms without fetchViews capability and qualifies supported platforms', () => {
    assert.equal(
      isSubmissionEligibleForPolling({
        status: 'APPROVED',
        platform: 'UNKNOWN_PLATFORM',
        user: { status: 'ACTIVE' },
        campaign: { status: 'ACTIVE' }
      }),
      false
    );

    assert.equal(
      isSubmissionEligibleForPolling({
        status: 'APPROVED',
        platform: 'TIKTOK',
        user: { status: 'ACTIVE' },
        campaign: { status: 'ACTIVE' }
      }),
      true
    );

    assert.equal(
      isSubmissionEligibleForPolling({
        status: 'APPROVED',
        platform: 'FACEBOOK',
        user: { status: 'ACTIVE' },
        campaign: { status: 'ACTIVE' }
      }),
      true
    );
  });

  test('handles campaign tracking window and post-end grace period', () => {
    const now = new Date('2026-09-20T12:00:00Z');

    // Ended 2 days ago -> within 7 day grace period
    const recentEnded = {
      status: 'APPROVED',
      platform: 'YOUTUBE',
      user: { status: 'ACTIVE' },
      campaign: {
        status: 'ENDED',
        endDate: new Date('2026-09-18T12:00:00Z')
      }
    };
    assert.equal(isSubmissionEligibleForPolling(recentEnded, { now }), true);

    // Ended 10 days ago -> grace period expired
    const expiredEnded = {
      status: 'APPROVED',
      platform: 'YOUTUBE',
      user: { status: 'ACTIVE' },
      campaign: {
        status: 'ENDED',
        endDate: new Date('2026-09-10T12:00:00Z')
      }
    };
    assert.equal(isSubmissionEligibleForPolling(expiredEnded, { now }), false);
  });

  test('deterministic metric snapshot policy: skips insertion if metrics are identical', () => {
    const latestSnapshot = {
      id: 'snap_old',
      views: 50000n,
      likes: 1200n,
      comments: 300n
    };

    // Identical metrics -> no change
    assert.equal(
      hasMetricsChanged(latestSnapshot, {
        views: 50000n,
        likes: 1200n,
        comments: 300n
      }),
      false
    );

    // Views grew -> change detected
    assert.equal(
      hasMetricsChanged(latestSnapshot, {
        views: 52000n,
        likes: 1200n,
        comments: 300n
      }),
      true
    );

    // Likes changed -> change detected
    assert.equal(
      hasMetricsChanged(latestSnapshot, {
        views: 50000n,
        likes: 1350n,
        comments: 300n
      }),
      true
    );
  });

  test('preserves null vs zero semantic distinction in metric comparison', () => {
    const zeroSnapshot = { views: 0n, likes: 0n, comments: null };

    // null comments vs 0 comments -> change detected (null !== 0)
    assert.equal(
      hasMetricsChanged(zeroSnapshot, {
        views: 0n,
        likes: 0n,
        comments: 0n
      }),
      true
    );

    // null comments vs null comments -> no change
    assert.equal(
      hasMetricsChanged(zeroSnapshot, {
        views: 0n,
        likes: 0n,
        comments: null
      }),
      false
    );
  });
});

describe('Provider Capability Matrix & Error Taxonomy', () => {
  test('provider capability matrix accurately exposes platform abilities', () => {
    assert.equal(hasProviderCapability('YOUTUBE', 'fetchViews'), true);
    assert.equal(hasProviderCapability('YOUTUBE', 'fetchLikes'), true);
    assert.equal(hasProviderCapability('YOUTUBE', 'fetchShares'), false);

    assert.equal(hasProviderCapability('INSTAGRAM', 'fetchViews'), true);
    assert.equal(hasProviderCapability('TIKTOK', 'fetchViews'), true);
    assert.equal(hasProviderCapability('FACEBOOK', 'fetchViews'), true);
    assert.equal(hasProviderCapability('UNKNOWN_PLATFORM', 'fetchViews'), false);
  });

  test('RateLimitProviderError carries retryable flag and backoff duration', () => {
    const err = new RateLimitProviderError('YouTube quota exceeded', 'youtube', 60000);
    assert.equal(err.code, 'RATE_LIMIT_PROVIDER_ERROR');
    assert.equal(err.statusCode, 429);
    assert.equal(err.details.retryable, true);
    assert.equal(err.details.retryAfterMs, 60000);
  });

  test('UnsupportedOperationError is classified as non-retryable validation error', () => {
    const err = new UnsupportedOperationError('TikTok metric polling is not supported', 'tiktok');
    assert.equal(err.code, 'UNSUPPORTED_OPERATION');
    assert.equal(err.statusCode, 400);
    assert.equal(err.details.retryable, false);
  });
});

describe('High-Water-Mark & Earnings Concurrency Hardening', () => {
  test('concurrent snapshot processing guarantees sequential high-water mark crediting', async () => {
    const repo = createMockHardenedRepo();
    const service = new EarningsService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.campaigns.set('c1', { id: 'c1', payRate: new Prisma.Decimal('2.50'), currency: 'USD' });
    repo.submissions.set('sub1', {
      id: 'sub1',
      userId: 'u1',
      campaignId: 'c1',
      status: 'APPROVED'
    });
    repo.verifications.set('sub1', { id: 'ver1', status: 'COMPLETED' });

    // Baseline: 100,000 views credited
    repo.snapshots.set('snap0', { id: 'snap0', submissionId: 'sub1', views: 100000n });
    repo.earnings.set('e0', {
      id: 'e0',
      userId: 'u1',
      campaignId: 'c1',
      submissionId: 'sub1',
      sourceSnapshotId: 'snap0',
      eligibleViews: 100000n,
      grossAmount: new Prisma.Decimal('250.00'),
      currency: 'USD',
      status: 'ELIGIBLE'
    });

    // Two snapshots arrive simultaneously:
    // Snapshot A = 150,000
    // Snapshot B = 180,000
    repo.snapshots.set('snapA', { id: 'snapA', submissionId: 'sub1', views: 150000n });
    repo.snapshots.set('snapB', { id: 'snapB', submissionId: 'sub1', views: 180000n });

    // Simulate concurrent workers processing both snapshots
    const [resA, resB] = await Promise.all([
      service.creditNewEligibleViews('sub1', 'snapA'),
      service.creditNewEligibleViews('sub1', 'snapB')
    ]);

    // Total newly credited views must strictly equal 80,000 (180,000 - 100,000)
    // Never 50k + 80k = 130k!
    const totalNewlyCredited = resA.newlyCreditedViews + resB.newlyCreditedViews;
    assert.equal(totalNewlyCredited, 80000n);

    // Check all non-voided views in repository sum to 180,000
    const finalCreditedViews = await repo.getPreviouslyCreditedViews('sub1');
    assert.equal(finalCreditedViews, 180000n);
  });

  test('out-of-order snapshots do not create negative earnings or reduce high-water mark', async () => {
    const repo = createMockHardenedRepo();
    const service = new EarningsService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.campaigns.set('c1', { id: 'c1', payRate: new Prisma.Decimal('2.00'), currency: 'USD' });
    repo.submissions.set('sub1', {
      id: 'sub1',
      userId: 'u1',
      campaignId: 'c1',
      status: 'APPROVED'
    });
    repo.verifications.set('sub1', { id: 'ver1', status: 'COMPLETED' });

    // 1. Credit 200,000 views
    repo.snapshots.set('snap_200k', { id: 'snap_200k', submissionId: 'sub1', views: 200000n });
    const res1 = await service.creditNewEligibleViews('sub1', 'snap_200k');
    assert.equal(res1.newlyCreditedViews, 200000n);

    // 2. Out-of-order Snapshot C arrives with 175,000 views (< 200k)
    repo.snapshots.set('snap_175k', { id: 'snap_175k', submissionId: 'sub1', views: 175000n });
    const res2 = await service.creditNewEligibleViews('sub1', 'snap_175k');
    assert.equal(res2.newlyCreditedViews, 0n);
    assert.equal(res2.reason, 'METRIC_REGRESSION');

    // High-water mark remains strictly 200,000
    const totalCredited = await repo.getPreviouslyCreditedViews('sub1');
    assert.equal(totalCredited, 200000n);
  });

  test('same-snapshot idempotency: repeated executions produce exactly one credit', async () => {
    const repo = createMockHardenedRepo();
    const service = new EarningsService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.campaigns.set('c1', { id: 'c1', payRate: new Prisma.Decimal('3.00'), currency: 'USD' });
    repo.submissions.set('sub1', { id: 'sub1', userId: 'u1', campaignId: 'c1', status: 'APPROVED' });
    repo.verifications.set('sub1', { id: 'ver1', status: 'COMPLETED' });
    repo.snapshots.set('snap_x', { id: 'snap_x', submissionId: 'sub1', views: 50000n });

    const first = await service.creditNewEligibleViews('sub1', 'snap_x');
    assert.equal(first.newlyCreditedViews, 50000n);
    assert.equal(first.reason, 'CREDITED_SUCCESSFULLY');

    const second = await service.creditNewEligibleViews('sub1', 'snap_x');
    assert.equal(second.newlyCreditedViews, 0n);
    assert.equal(second.reason, 'ALREADY_CREDITED');
  });
});

describe('Payout Concurrency & Disbursement Hardening', () => {
  test('two concurrent payout requests exceeding available balance: exactly one succeeds', async () => {
    const repo = createMockHardenedRepo();
    const service = new PayoutService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    // Total balance = $1000
    repo.earnings.set('e1', {
      id: 'e1',
      userId: 'u1',
      grossAmount: '1000.00',
      currency: 'USD',
      status: 'ELIGIBLE'
    });

    // Worker A requests $800, Worker B requests $800 concurrently
    const promises = [
      service.createPayoutRequest('u1', '800.00', 'USD').catch((err) => err),
      service.createPayoutRequest('u1', '800.00', 'USD').catch((err) => err)
    ];

    const results = await Promise.all(promises);

    const successful = results.filter((r) => !(r instanceof Error));
    const failed = results.filter((r) => r instanceof Error);

    assert.equal(successful.length, 1, 'Exactly one request should succeed');
    assert.equal(failed.length, 1, 'Exactly one request should fail');
    assert.ok(failed[0] instanceof InsufficientBalanceError);

    // Available balance must NEVER be negative
    const balance = await service.getAvailablePayoutBalance('u1', 'USD');
    assert.equal(balance.availableBalance.toFixed(2), '200.00');
    assert.equal(balance.reservedBalance.toFixed(2), '800.00');
  });

  test('simultaneous disbursement execution on same payout request: only one succeeds', async () => {
    const repo = createMockHardenedRepo();
    const service = new PayoutService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.earnings.set('e1', { id: 'e1', userId: 'u1', grossAmount: '500.00', currency: 'USD', status: 'ELIGIBLE' });

    const pr = await service.createPayoutRequest('u1', '200.00', 'USD');
    await service.reviewPayoutRequest(pr.id, 'admin_1');
    await service.approvePayoutRequest(pr.id, 'admin_1');

    // Two workers attempt to process disbursement simultaneously
    const results = await Promise.all([
      service.processDisbursement(pr.id, 'MANUAL').catch((err) => err),
      service.processDisbursement(pr.id, 'MANUAL').catch((err) => err)
    ]);

    const successes = results.filter((r) => !(r instanceof Error));
    const failures = results.filter((r) => r instanceof Error);

    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.ok(failures[0] instanceof InvalidPayoutStatusTransitionError);
  });
});

describe('Operational Health & Readiness', () => {
  test('checkLiveness returns UP, uptime, and memory usage', () => {
    const liveness = checkLiveness();
    assert.equal(liveness.status, 'UP');
    assert.ok(liveness.uptimeSeconds >= 0);
    assert.ok(liveness.memoryUsage.heapUsedMb > 0);
  });

  test('checkReadiness accurately reflects dependency states', async () => {
    // Both healthy
    const healthy = await checkReadiness({
      testDb: async () => true,
      testRedis: async () => true
    });
    assert.equal(healthy.status, 'READY');
    assert.equal(healthy.checks.database, 'HEALTHY');
    assert.equal(healthy.checks.redis, 'HEALTHY');

    // Database unhealthy
    const dbDown = await checkReadiness({
      testDb: async () => false,
      testRedis: async () => true
    });
    assert.equal(dbDown.checks.database, 'UNHEALTHY');

    // Redis throws error
    const redisError = await checkReadiness({
      testDb: async () => true,
      testRedis: async () => {
        throw new Error('Connection refused');
      }
    });
    assert.equal(redisError.checks.redis, 'UNHEALTHY');
  });
});

describe('Application Rate Limiter', () => {
  test('allows requests within threshold and blocks excess', () => {
    rateLimiter.reset();

    // Consume 3 tokens out of 3 limit
    const r1 = rateLimiter.consume('test_user', 3, 60);
    assert.equal(r1.allowed, true);
    assert.equal(r1.remaining, 2);

    const r2 = rateLimiter.consume('test_user', 3, 60);
    assert.equal(r2.allowed, true);
    assert.equal(r2.remaining, 1);

    const r3 = rateLimiter.consume('test_user', 3, 60);
    assert.equal(r3.allowed, true);
    assert.equal(r3.remaining, 0);

    // 4th request must be blocked
    const r4 = rateLimiter.consume('test_user', 3, 60);
    assert.equal(r4.allowed, false);
    assert.equal(r4.remaining, 0);
    assert.ok(r4.resetSeconds > 0);
  });

  test('enforceSubmissionRateLimit throws RateLimitExceededError when limit reached', () => {
    rateLimiter.reset();
    const userId = 'usr_spam';

    // Consume limit
    for (let i = 0; i < 10; i++) {
      assert.doesNotThrow(() => enforceSubmissionRateLimit(userId));
    }

    // 11th request throws
    assert.throws(
      () => enforceSubmissionRateLimit(userId),
      (err) => {
        assert.ok(err instanceof RateLimitExceededError);
        assert.equal(err.statusCode, 429);
        return true;
      }
    );
  });
});

describe('Worker Lifecycle & Graceful Teardown', () => {
  test('stopWorkers and stopMetricScheduler execute cleanly without unhandled rejections', async () => {
    const { stopWorkers } = await import('../src/workers/index.js');
    const { stopMetricScheduler } = await import('../src/workers/metric-scheduler.js');

    // Executing stop on idle/empty worker list should be safe and idempotent
    await assert.doesNotReject(() => stopWorkers());
    await assert.doesNotReject(() => stopMetricScheduler());
  });
});

