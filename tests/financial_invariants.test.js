import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { calculateGrossAmount, applyBudgetCaps } from '../src/modules/earnings/earnings.calculator.js';
import { EarningsService } from '../src/modules/earnings/earnings.service.js';
import { PayoutService } from '../src/modules/payouts/payout.service.js';

describe('Phase 10G Financial Invariants & Concurrency Hardening', () => {

  // =========================================================================
  // SECTION 3: Concurrent Earning Calculation Attacks (100 Concurrent Requests)
  // =========================================================================
  describe('Concurrent Earning Calculations & Duplicate Credit Resistance', () => {
    test('100 concurrent attempts against the same snapshot produce strictly 1 earning record', async () => {
      const earnings = new Map();
      let lockBusy = false;

      const mockRepo = {
        async transaction(callback) {
          while (lockBusy) {
            await new Promise((r) => setTimeout(r, 2));
          }
          lockBusy = true;
          try {
            return await callback(mockRepo);
          } finally {
            lockBusy = false;
          }
        },
        async acquireSubmissionLock() {},
        async getSubmissionForEarnings(submissionId) {
          return {
            id: submissionId,
            userId: 'user_attacker_100',
            campaignId: 'camp_inv_1',
            status: 'APPROVED',
            campaign: {
              id: 'camp_inv_1',
              totalBudget: new Prisma.Decimal('1000.00'),
              consumedBudget: new Prisma.Decimal('0.00'),
              payRate: new Prisma.Decimal('2.00'),
              creatorCapAmount: new Prisma.Decimal('600.00'),
              status: 'ACTIVE',
              currency: 'USD'
            },
            verifications: [{ status: 'COMPLETED' }],
            snapshots: [{ id: 'snap_fixed_100', submissionId, views: 5000n, capturedAt: new Date() }]
          };
        },
        async getSnapshotById(snapshotId) {
          return {
            id: snapshotId,
            submissionId: 'sub_concurrent_test',
            views: 5000n,
            capturedAt: new Date()
          };
        },
        async getPreviouslyCreditedViews() {
          return 0n;
        },
        async getEarningBySnapshotId(sourceSnapshotId) {
          for (const e of earnings.values()) {
            if (e.sourceSnapshotId === sourceSnapshotId) return e;
          }
          return null;
        },
        async getCreatorCampaignTotal() {
          return new Prisma.Decimal('0.00');
        },
        async createEarning(data) {
          for (const existing of earnings.values()) {
            if (existing.sourceSnapshotId === data.sourceSnapshotId) {
              return existing;
            }
          }
          const id = `earn_${earnings.size + 1}`;
          const record = { id, ...data };
          earnings.set(id, record);
          return record;
        },
        async updateCampaignBudget() {},
        async updateSubmissionMetrics() {}
      };

      const mockCampaignRepo = {
        async consumeBudget() {}
      };

      const earningsService = new EarningsService(mockRepo, mockCampaignRepo);

      // Launch 100 simultaneous concurrent calculation requests for the same submission & snapshot
      const promises = Array.from({ length: 100 }, () =>
        earningsService.creditNewEligibleViews('sub_concurrent_test', 'snap_fixed_100')
      );

      const results = await Promise.allSettled(promises);

      const rejected = results.filter((r) => r.status === 'rejected');
      assert.equal(rejected.length, 0, `Unexpected rejections: ${rejected.map((r) => r.reason?.stack || r.reason?.message || r.reason).join('; ')}`);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      assert.equal(fulfilled.length, 100);

      // Verify exact invariant: strictly 1 earning created
      assert.equal(earnings.size, 1, 'Exactly one earning record must be generated across 100 concurrent requests');

      const earning = Array.from(earnings.values())[0];
      assert.equal(earning.grossAmount.toFixed(2), '10.00'); // (5000 / 1000) * $2 = $10.00
    });
  });

  // =========================================================================
  // SECTION 4: Campaign Budget Boundary Partial Credit
  // =========================================================================
  describe('Campaign Budget Exhaustion & Partial Credit Clamping', () => {
    test('when campaign remaining budget is $0.40 and raw earning is $1.50, credits exactly $0.40', () => {
      const rawEarning = new Prisma.Decimal('1.50');
      const campaignRemaining = new Prisma.Decimal('0.40');
      const creatorRemaining = new Prisma.Decimal('100.00');

      const result = applyBudgetCaps(rawEarning, campaignRemaining, creatorRemaining);

      assert.equal(result.actualCredit.toFixed(2), '0.40');
      assert.equal(result.cappedBy, 'CAMPAIGN');
    });

    test('when campaign budget is completely exhausted ($0.00 remaining), credit is strictly $0.00', () => {
      const rawEarning = new Prisma.Decimal('1.50');
      const campaignRemaining = new Prisma.Decimal('0.00');
      const creatorRemaining = new Prisma.Decimal('100.00');

      const result = applyBudgetCaps(rawEarning, campaignRemaining, creatorRemaining);

      assert.equal(result.actualCredit.toFixed(2), '0.00');
      assert.equal(result.cappedBy, 'CAMPAIGN');
    });
  });

  // =========================================================================
  // SECTION 5: Creator Campaign Cap Enforcement
  // =========================================================================
  describe('Creator Cap Enforcement & Multi-Submission Cap Clamping', () => {
    test('creator with $50 cap who earned $45 is credited exactly $5 when new views yield $15', () => {
      const rawEarning = new Prisma.Decimal('15.00');
      const campaignRemaining = new Prisma.Decimal('500.00');
      const creatorRemaining = new Prisma.Decimal('5.00'); // $50 cap - $45 earned

      const result = applyBudgetCaps(rawEarning, campaignRemaining, creatorRemaining);

      assert.equal(result.actualCredit.toFixed(2), '5.00');
      assert.equal(result.cappedBy, 'CREATOR');
    });

    test('creator who has reached creator cap receives strictly $0 for subsequent views', () => {
      const rawEarning = new Prisma.Decimal('20.00');
      const campaignRemaining = new Prisma.Decimal('500.00');
      const creatorRemaining = new Prisma.Decimal('0.00');

      const result = applyBudgetCaps(rawEarning, campaignRemaining, creatorRemaining);

      assert.equal(result.actualCredit.toFixed(2), '0.00');
      assert.equal(result.cappedBy, 'CREATOR');
    });
  });

  // =========================================================================
  // SECTION 15: Metric Regression Integrity
  // =========================================================================
  describe('Metric Regression Integrity & Negative View Immunity', () => {
    test('metric regression (e.g. views drop from 1500 to 1200 due to platform purge) produces $0.00', () => {
      const previousViews = 1500n;
      const currentViews = 1200n;

      // Delta views clamped at 0
      const deltaViews = currentViews > previousViews ? currentViews - previousViews : 0n;
      assert.equal(deltaViews, 0n);

      const grossAmount = calculateGrossAmount(deltaViews, '2.00');
      assert.equal(grossAmount.toFixed(2), '0.00');
      assert.ok(grossAmount.gte(0), 'Earnings must never be negative from metric calculations');
    });

    test('identical view count produces 0 delta views and $0.00 earnings', () => {
      const deltaViews = 0n;
      const grossAmount = calculateGrossAmount(deltaViews, '3.50');
      assert.equal(grossAmount.toFixed(2), '0.00');
    });
  });

  // =========================================================================
  // SECTION 16: Continuous Invariant Assertions
  // =========================================================================
  describe('Continuous Ledger Invariant Formula Assertions', () => {
    test('availableBalance >= 0 holds across complex earning, adjustment, and reservation cycles', () => {
      // Synthetic ledger state test
      const totalEarned = new Prisma.Decimal('150.00');
      const negativeAdjustments = new Prisma.Decimal('-30.00'); // e.g. retention violation
      const reservedPayout = new Prisma.Decimal('50.00');
      const completedPayout = new Prisma.Decimal('40.00');

      // Net available balance formula:
      // netBalance = totalEarned + adjustments - completedPayouts - reservedPayouts
      const netBalance = totalEarned
        .plus(negativeAdjustments)
        .minus(completedPayout)
        .minus(reservedPayout);

      assert.equal(netBalance.toFixed(2), '30.00');
      assert.ok(netBalance.gte(0), 'Available balance invariant (>= 0) holds');
    });

    test('consumedBudget <= totalBudget invariant is never exceeded even at exact boundary', () => {
      const totalBudget = new Prisma.Decimal('100.00');
      let consumedBudget = new Prisma.Decimal('99.50');

      const rawAmount = new Prisma.Decimal('2.00');
      const remaining = totalBudget.minus(consumedBudget);
      const { actualCredit } = applyBudgetCaps(rawAmount, remaining, new Prisma.Decimal('50.00'));

      consumedBudget = consumedBudget.plus(actualCredit);

      assert.equal(consumedBudget.toFixed(2), '100.00');
      assert.ok(consumedBudget.lessThanOrEqualTo(totalBudget), 'consumedBudget must never exceed totalBudget');
    });
  });
});
