import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { calculateGrossAmount } from '../src/modules/earnings/earnings.calculator.js';
import { EarningsService } from '../src/modules/earnings/earnings.service.js';
import {
  IneligibleSubmissionError,
  UnauthorizedEarningAccessError
} from '../src/modules/earnings/earnings.errors.js';
import {
  buildUserEarningsEmbed,
  buildCampaignEarningsEmbed,
  buildSubmissionEarningsEmbed
} from '../src/bot/embeds/earnings.embeds.js';
import { buildUserEarningsActionRow } from '../src/bot/components/earnings.components.js';

// In-memory mock repository for earnings testing
function createMockEarningsRepo() {
  const campaigns = new Map();
  const memberships = new Map(); // key: `${userId}_${campaignId}`
  const submissions = new Map(); // key: submissionId
  const snapshots = new Map(); // key: snapshotId
  const verifications = new Map(); // key: submissionId
  const earnings = new Map(); // key: earningId

  const repo = {
    campaigns,
    memberships,
    submissions,
    snapshots,
    verifications,
    earnings,

    async transaction(callback) {
      // Execute within transaction scope using repo as tx
      return callback(repo);
    },

    async getSubmissionForEarnings(submissionId, tx = null) {
      const sub = submissions.get(submissionId);
      if (!sub) return null;

      const camp = campaigns.get(sub.campaignId);
      const ver = verifications.get(submissionId);
      const subSnaps = Array.from(snapshots.values())
        .filter((s) => s.submissionId === submissionId)
        .sort((a, b) => {
          const timeDiff = new Date(b.capturedAt) - new Date(a.capturedAt);
          if (timeDiff !== 0) return timeDiff;
          return b.id.localeCompare(a.id);
        });

      return {
        ...sub,
        campaign: camp,
        verifications: ver ? [ver] : [],
        snapshots: subSnaps.length > 0 ? [subSnaps[0]] : []
      };
    },

    async getSnapshotById(snapshotId, tx = null) {
      return snapshots.get(snapshotId) || null;
    },

    async getPreviouslyCreditedViews(submissionId, tx = null) {
      let sum = 0n;
      for (const e of earnings.values()) {
        if (e.submissionId === submissionId && e.status !== 'VOIDED') {
          sum += BigInt(e.eligibleViews);
        }
      }
      return sum;
    },

    async getEarningBySnapshotId(sourceSnapshotId, tx = null) {
      for (const e of earnings.values()) {
        if (e.sourceSnapshotId === sourceSnapshotId) {
          return e;
        }
      }
      return null;
    },

    async createEarning(data, tx = null) {
      // Enforce unique constraint simulation on sourceSnapshotId
      for (const existing of earnings.values()) {
        if (existing.sourceSnapshotId === data.sourceSnapshotId) {
          const err = new Error('Unique constraint failed on the fields: (`source_snapshot_id`)');
          err.code = 'P2002';
          throw err;
        }
      }

      const id = `earn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const earning = {
        id,
        ...data,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      earnings.set(id, earning);
      return earning;
    },

    async getUserEarningsLedger(userId) {
      const list = [];
      for (const e of earnings.values()) {
        if (e.userId === userId) {
          const camp = campaigns.get(e.campaignId);
          const sub = submissions.get(e.submissionId);
          list.push({ ...e, campaign: camp, submission: sub });
        }
      }
      return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },

    async getCampaignEarningsLedger(userId, campaignId) {
      const list = [];
      for (const e of earnings.values()) {
        if (e.userId === userId && e.campaignId === campaignId) {
          const sub = submissions.get(e.submissionId);
          list.push({ ...e, submission: sub });
        }
      }
      return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },

    async getSubmissionEarningsLedger(submissionId) {
      const list = [];
      for (const e of earnings.values()) {
        if (e.submissionId === submissionId) {
          list.push(e);
        }
      }
      return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },

    async getCampaignMembership(userId, campaignId) {
      const key = `${userId}_${campaignId}`;
      const m = memberships.get(key);
      if (!m) return null;
      const c = campaigns.get(campaignId);
      return { ...m, campaign: c };
    }
  };

  return repo;
}

describe('Earnings Engine — Phase 4B', () => {
  describe('1. EARNINGS CALCULATOR', () => {
    test('calculates 0 views as $0.00', () => {
      const amount = calculateGrossAmount(0, '0.80');
      assert.equal(amount.toFixed(2), '0.00');
    });

    test('calculates exact 1,000 views at $0.80/1k as $0.80', () => {
      const amount = calculateGrossAmount(1000, '0.80');
      assert.equal(amount.toFixed(2), '0.80');
    });

    test('calculates 1,500 views at $0.80/1k as $1.20', () => {
      const amount = calculateGrossAmount(1500, '0.80');
      assert.equal(amount.toFixed(2), '1.20');
    });

    test('calculates large view counts with high precision (125,500 views @ $0.80 = $100.40)', () => {
      const amount = calculateGrossAmount(125500n, '0.80');
      assert.equal(amount.toFixed(2), '100.40');
    });

    test('applies exact ROUND_HALF_UP rounding policy', () => {
      // 123 views at $0.85 / 1,000 = 0.10455 -> rounds to 0.10
      const amt1 = calculateGrossAmount(123, '0.85');
      assert.equal(amt1.toFixed(2), '0.10');

      // 129 views at $0.85 / 1,000 = 0.10965 -> rounds to 0.11
      const amt2 = calculateGrossAmount(129, '0.85');
      assert.equal(amt2.toFixed(2), '0.11');

      // 1,001 views at $1.25 / 1,000 = 1.25125 -> rounds to 1.25
      const amt3 = calculateGrossAmount(1001, '1.25');
      assert.equal(amt3.toFixed(2), '1.25');
    });

    test('handles Decimal rate objects seamlessly', () => {
      const rate = new Prisma.Decimal('1.50');
      const amount = calculateGrossAmount(10000n, rate);
      assert.equal(amount.toFixed(2), '15.00');
    });
  });

  describe('2. ELIGIBILITY ENFORCEMENT', () => {
    test('approved submission with completed verification generates eligible earnings', async () => {
      const repo = createMockEarningsRepo();
      const service = new EarningsService(repo);

      const userId = 'usr_alice';
      const campaignId = 'cmp_1';
      const subId = 'sub_app';

      repo.campaigns.set(campaignId, { id: campaignId, name: 'Active Camp', payRate: new Prisma.Decimal('1.00'), currency: 'USD' });
      repo.submissions.set(subId, { id: subId, userId, campaignId, status: 'APPROVED' });
      repo.verifications.set(subId, { status: 'COMPLETED' });
      repo.snapshots.set('snap_1', { id: 'snap_1', submissionId: subId, views: 50000n, capturedAt: new Date() });

      const result = await service.creditNewEligibleViews(subId, 'snap_1');

      assert.equal(result.reason, 'CREDITED_SUCCESSFULLY');
      assert.equal(result.newlyCreditedViews, 50000n);
      assert.equal(result.grossAmount.toFixed(2), '50.00');
      assert.equal(result.earning.status, 'ELIGIBLE');
    });

    test('pending, under review, flagged, and rejected submissions are strictly rejected', async () => {
      const repo = createMockEarningsRepo();
      const service = new EarningsService(repo);

      const campaignId = 'cmp_1';
      repo.campaigns.set(campaignId, { id: campaignId, name: 'Active Camp', payRate: new Prisma.Decimal('1.00'), currency: 'USD' });

      const ineligibleStatuses = ['PENDING_VERIFICATION', 'UNDER_REVIEW', 'FLAGGED', 'REJECTED'];

      for (const status of ineligibleStatuses) {
        const subId = `sub_${status}`;
        repo.submissions.set(subId, { id: subId, userId: 'usr_1', campaignId, status });
        repo.verifications.set(subId, { status: 'COMPLETED' });
        repo.snapshots.set(`snap_${status}`, { id: `snap_${status}`, submissionId: subId, views: 10000n, capturedAt: new Date() });

        await assert.rejects(
          async () => {
            await service.creditNewEligibleViews(subId, `snap_${status}`);
          },
          (err) => {
            assert.ok(err instanceof IneligibleSubmissionError);
            assert.equal(err.code, 'INELIGIBLE_SUBMISSION');
            return true;
          }
        );
      }
    });

    test('submission with incomplete verification is rejected even if marked approved', async () => {
      const repo = createMockEarningsRepo();
      const service = new EarningsService(repo);

      const subId = 'sub_incomplete_ver';
      repo.campaigns.set('cmp_1', { id: 'cmp_1', name: 'Camp', payRate: new Prisma.Decimal('1.00'), currency: 'USD' });
      repo.submissions.set(subId, { id: subId, userId: 'usr_1', campaignId: 'cmp_1', status: 'APPROVED' });
      repo.verifications.set(subId, { status: 'IN_PROGRESS' }); // Not completed!
      repo.snapshots.set('snap_inc', { id: 'snap_inc', submissionId: subId, views: 10000n, capturedAt: new Date() });

      await assert.rejects(
        async () => {
          await service.creditNewEligibleViews(subId, 'snap_inc');
        },
        (err) => {
          assert.ok(err instanceof IneligibleSubmissionError);
          return true;
        }
      );
    });
  });

  describe('3. INCREMENTAL VIEW CREDITING & REGRESSION', () => {
    test('correctly credits incremental views across sequence (100k -> +50k -> +70k)', async () => {
      const repo = createMockEarningsRepo();
      const service = new EarningsService(repo);

      const userId = 'usr_bob';
      const campaignId = 'cmp_inc';
      const subId = 'sub_inc';

      repo.campaigns.set(campaignId, { id: campaignId, name: 'Inc Camp', payRate: new Prisma.Decimal('0.80'), currency: 'USD' });
      repo.submissions.set(subId, { id: subId, userId, campaignId, status: 'APPROVED' });
      repo.verifications.set(subId, { status: 'COMPLETED' });

      // 1. Snapshot 1: 100,000 views -> credits 100,000 views ($80.00)
      repo.snapshots.set('s1', { id: 's1', submissionId: subId, views: 100000n, capturedAt: new Date('2026-09-20T10:00:00Z') });
      const res1 = await service.creditNewEligibleViews(subId, 's1');
      assert.equal(res1.newlyCreditedViews, 100000n);
      assert.equal(res1.grossAmount.toFixed(2), '80.00');

      // 2. Snapshot 2: 150,000 views -> credits incremental 50,000 views ($40.00)
      repo.snapshots.set('s2', { id: 's2', submissionId: subId, views: 150000n, capturedAt: new Date('2026-09-20T12:00:00Z') });
      const res2 = await service.creditNewEligibleViews(subId, 's2');
      assert.equal(res2.newlyCreditedViews, 50000n);
      assert.equal(res2.grossAmount.toFixed(2), '40.00');

      // 3. Snapshot 3: 220,000 views -> credits incremental 70,000 views ($56.00)
      repo.snapshots.set('s3', { id: 's3', submissionId: subId, views: 220000n, capturedAt: new Date('2026-09-20T15:00:00Z') });
      const res3 = await service.creditNewEligibleViews(subId, 's3');
      assert.equal(res3.newlyCreditedViews, 70000n);
      assert.equal(res3.grossAmount.toFixed(2), '56.00');

      // Total credited views across ledger must be exactly 220,000
      const totalCredited = await repo.getPreviouslyCreditedViews(subId);
      assert.equal(totalCredited, 220000n);

      // Total gross earnings: $80 + $40 + $56 = $176.00
      const balance = await service.getUserBalance(userId);
      assert.equal(balance.totalGrossEarnings.toFixed(2), '176.00');
      assert.equal(balance.totalEligibleViews, 220000n);
    });

    test('metric regression (220k -> 180k) does NOT generate negative earnings or delete ledger rows', async () => {
      const repo = createMockEarningsRepo();
      const service = new EarningsService(repo);

      const userId = 'usr_regr';
      const subId = 'sub_regr';

      repo.campaigns.set('cmp_1', { id: 'cmp_1', name: 'Camp', payRate: new Prisma.Decimal('1.00'), currency: 'USD' });
      repo.submissions.set(subId, { id: subId, userId, campaignId: 'cmp_1', status: 'APPROVED' });
      repo.verifications.set(subId, { status: 'COMPLETED' });

      // Credit 220k
      repo.snapshots.set('s_high', { id: 's_high', submissionId: subId, views: 220000n, capturedAt: new Date('2026-09-20T10:00:00Z') });
      await service.creditNewEligibleViews(subId, 's_high');

      // Regress to 180k
      repo.snapshots.set('s_regr', { id: 's_regr', submissionId: subId, views: 180000n, capturedAt: new Date('2026-09-20T12:00:00Z') });
      const regrRes = await service.creditNewEligibleViews(subId, 's_regr');

      assert.equal(regrRes.reason, 'METRIC_REGRESSION');
      assert.equal(regrRes.newlyCreditedViews, 0n);
      assert.equal(regrRes.grossAmount.toFixed(2), '0.00');
      assert.equal(regrRes.earning, null);

      // Historical credited views remain intact at 220k
      const credited = await repo.getPreviouslyCreditedViews(subId);
      assert.equal(credited, 220000n);

      const balance = await service.getUserBalance(userId);
      assert.equal(balance.totalGrossEarnings.toFixed(2), '220.00');
    });

    test('views unavailable produces 0 earnings and does not fail', async () => {
      const repo = createMockEarningsRepo();
      const service = new EarningsService(repo);

      const subId = 'sub_unavail';
      repo.campaigns.set('cmp_1', { id: 'cmp_1', name: 'Camp', payRate: new Prisma.Decimal('1.00'), currency: 'USD' });
      repo.submissions.set(subId, { id: subId, userId: 'usr_1', campaignId: 'cmp_1', status: 'APPROVED' });
      repo.verifications.set(subId, { status: 'COMPLETED' });
      repo.snapshots.set('s_null', { id: 's_null', submissionId: subId, views: null, capturedAt: new Date() });

      const res = await service.creditNewEligibleViews(subId, 's_null');
      assert.equal(res.reason, 'VIEWS_UNAVAILABLE');
      assert.equal(res.newlyCreditedViews, 0n);
    });
  });

  describe('4. IDEMPOTENCY & RATE CHANGES', () => {
    test('processing the same snapshot twice creates exactly one earning event', async () => {
      const repo = createMockEarningsRepo();
      const service = new EarningsService(repo);

      const subId = 'sub_idem';
      repo.campaigns.set('cmp_1', { id: 'cmp_1', name: 'Camp', payRate: new Prisma.Decimal('0.80'), currency: 'USD' });
      repo.submissions.set(subId, { id: subId, userId: 'usr_idem', campaignId: 'cmp_1', status: 'APPROVED' });
      repo.verifications.set(subId, { status: 'COMPLETED' });
      repo.snapshots.set('s_idem', { id: 's_idem', submissionId: subId, views: 50000n, capturedAt: new Date() });

      // First run: credits 50k
      const res1 = await service.creditNewEligibleViews(subId, 's_idem');
      assert.equal(res1.reason, 'CREDITED_SUCCESSFULLY');

      // Second run: detected as already credited
      const res2 = await service.creditNewEligibleViews(subId, 's_idem');
      assert.equal(res2.reason, 'ALREADY_CREDITED');
      assert.equal(res2.newlyCreditedViews, 0n);
      assert.equal(res2.earning.id, res1.earning.id);

      // Earning count remains 1
      const ledger = await repo.getUserEarningsLedger('usr_idem');
      assert.equal(ledger.length, 1);
    });

    test('historical earnings preserve historical rate when campaign rate changes', async () => {
      const repo = createMockEarningsRepo();
      const service = new EarningsService(repo);

      const userId = 'usr_rate';
      const campaignId = 'cmp_dyn_rate';
      const subId = 'sub_dyn';

      // Campaign initial rate: $0.80 / 1k
      const camp = { id: campaignId, name: 'Dyn Rate Camp', payRate: new Prisma.Decimal('0.80'), currency: 'USD' };
      repo.campaigns.set(campaignId, camp);
      repo.submissions.set(subId, { id: subId, userId, campaignId, status: 'APPROVED' });
      repo.verifications.set(subId, { status: 'COMPLETED' });

      // Step 1: Snapshot 1 at $0.80 rate -> 100,000 views = $80.00
      repo.snapshots.set('s_rate_1', { id: 's_rate_1', submissionId: subId, views: 100000n, capturedAt: new Date('2026-09-01') });
      const res1 = await service.creditNewEligibleViews(subId, 's_rate_1');
      assert.equal(res1.grossAmount.toFixed(2), '80.00');
      assert.equal(new Prisma.Decimal(res1.earning.ratePerThousand).toFixed(2), '0.80');

      // Step 2: Campaign rate increased to $1.00 / 1k
      camp.payRate = new Prisma.Decimal('1.00');

      // Step 3: Snapshot 2 at $1.00 rate -> +50,000 views = $50.00 (NOT $40.00)
      repo.snapshots.set('s_rate_2', { id: 's_rate_2', submissionId: subId, views: 150000n, capturedAt: new Date('2026-09-10') });
      const res2 = await service.creditNewEligibleViews(subId, 's_rate_2');
      assert.equal(res2.grossAmount.toFixed(2), '50.00');
      assert.equal(new Prisma.Decimal(res2.earning.ratePerThousand).toFixed(2), '1.00');

      // Step 4: Verify ledger integrity
      const ledger = await repo.getSubmissionEarningsLedger(subId);
      assert.equal(ledger.length, 2);

      // Old earning still has rate 0.80 and gross 80.00
      const oldEarning = ledger.find((e) => e.sourceSnapshotId === 's_rate_1');
      assert.equal(new Prisma.Decimal(oldEarning.ratePerThousand).toFixed(2), '0.80');
      assert.equal(new Prisma.Decimal(oldEarning.grossAmount).toFixed(2), '80.00');

      // New earning has rate 1.00 and gross 50.00
      const newEarning = ledger.find((e) => e.sourceSnapshotId === 's_rate_2');
      assert.equal(new Prisma.Decimal(newEarning.ratePerThousand).toFixed(2), '1.00');
      assert.equal(new Prisma.Decimal(newEarning.grossAmount).toFixed(2), '50.00');

      // Total balance: $80 + $50 = $130.00
      const balance = await service.getUserBalance(userId);
      assert.equal(balance.totalGrossEarnings.toFixed(2), '130.00');
    });
  });

  describe('5. BALANCE AGGREGATION & ACCESS CONTROL', () => {
    test('authoritative balance categorizes eligible, pending, and voided correctly', async () => {
      const repo = createMockEarningsRepo();
      const service = new EarningsService(repo);

      const userId = 'usr_balances';

      await repo.createEarning({ userId, campaignId: 'c1', submissionId: 's1', sourceSnapshotId: 'sn1', eligibleViews: 10000n, ratePerThousand: new Prisma.Decimal('1.00'), grossAmount: new Prisma.Decimal('10.00'), currency: 'USD', status: 'ELIGIBLE' });
      await repo.createEarning({ userId, campaignId: 'c1', submissionId: 's2', sourceSnapshotId: 'sn2', eligibleViews: 5000n, ratePerThousand: new Prisma.Decimal('1.00'), grossAmount: new Prisma.Decimal('5.00'), currency: 'USD', status: 'PENDING' });
      await repo.createEarning({ userId, campaignId: 'c1', submissionId: 's3', sourceSnapshotId: 'sn3', eligibleViews: 2000n, ratePerThousand: new Prisma.Decimal('1.00'), grossAmount: new Prisma.Decimal('2.00'), currency: 'USD', status: 'VOIDED' });

      const balance = await service.getUserBalance(userId);

      assert.equal(balance.eligibleEarnings.toFixed(2), '10.00');
      assert.equal(balance.pendingEarnings.toFixed(2), '5.00');
      assert.equal(balance.voidedEarnings.toFixed(2), '2.00');
      assert.equal(balance.totalGrossEarnings.toFixed(2), '15.00'); // eligible + pending
      assert.equal(balance.totalEligibleViews, 15000n); // non-voided views
    });

    test('user overview flags isPayoutThresholdReached accurately', async () => {
      const repo = createMockEarningsRepo();
      const service = new EarningsService(repo);

      const userId = 'usr_threshold';
      repo.campaigns.set('cmp_min', { id: 'cmp_min', name: 'Min Payout Camp', minimumPayout: new Prisma.Decimal('50.00'), currency: 'USD' });

      // 1. Initially $20 earned (threshold not reached)
      await repo.createEarning({ userId, campaignId: 'cmp_min', submissionId: 's1', sourceSnapshotId: 'sn1', eligibleViews: 20000n, ratePerThousand: new Prisma.Decimal('1.00'), grossAmount: new Prisma.Decimal('20.00'), currency: 'USD', status: 'ELIGIBLE' });
      const stats1 = await service.getUserEarnings(userId);
      assert.equal(stats1.isPayoutThresholdReached, false);

      // 2. Additional $35 earned (total $55 >= $50 minimum payout)
      await repo.createEarning({ userId, campaignId: 'cmp_min', submissionId: 's2', sourceSnapshotId: 'sn2', eligibleViews: 35000n, ratePerThousand: new Prisma.Decimal('1.00'), grossAmount: new Prisma.Decimal('35.00'), currency: 'USD', status: 'ELIGIBLE' });
      const stats2 = await service.getUserEarnings(userId);
      assert.equal(stats2.isPayoutThresholdReached, true);
    });

    test('cross-user access to submission earnings is rejected', async () => {
      const repo = createMockEarningsRepo();
      const service = new EarningsService(repo);

      const owner = 'usr_owner';
      const intruder = 'usr_intruder';
      const subId = 'sub_priv_earnings';

      repo.campaigns.set('cmp_1', { id: 'cmp_1', name: 'Camp', payRate: new Prisma.Decimal('1.00'), currency: 'USD' });
      repo.submissions.set(subId, { id: subId, userId: owner, campaignId: 'cmp_1', status: 'APPROVED' });

      await assert.rejects(
        async () => {
          await service.getSubmissionEarnings(intruder, subId);
        },
        (err) => {
          assert.ok(err instanceof UnauthorizedEarningAccessError);
          assert.equal(err.code, 'UNAUTHORIZED_EARNING_ACCESS');
          return true;
        }
      );
    });
  });

  describe('6. DISCORD UI BUILDERS', () => {
    test('buildUserEarningsEmbed displays formatted balances and threshold status', () => {
      const dummyUser = { id: '123456789' };
      const earningsData = {
        userId: 'usr_ui',
        eligibleEarnings: new Prisma.Decimal('65.40'),
        pendingEarnings: new Prisma.Decimal('15.00'),
        voidedEarnings: new Prisma.Decimal('0.00'),
        totalGrossEarnings: new Prisma.Decimal('80.40'),
        totalEligibleViews: 80400n,
        currency: 'USD',
        campaignCount: 2,
        submissionCount: 4,
        minimumPayout: new Prisma.Decimal('50.00'),
        isPayoutThresholdReached: true,
        latestEarningAt: new Date('2026-09-20T12:00:00Z')
      };

      const embed = buildUserEarningsEmbed(earningsData, dummyUser);
      assert.ok(embed.data.title.includes('Earnings'));
      assert.ok(embed.data.fields.some((f) => f.value.includes('$65.40')));
      assert.ok(embed.data.fields.some((f) => f.value.includes('Threshold Reached')));
    });

    test('buildCampaignEarningsEmbed formats campaign specific financial overview', () => {
      const dummyUser = { id: '123456789' };
      const campData = {
        campaign: { id: 'c1', name: 'Alpha Clips', status: 'ACTIVE' },
        currentRatePerThousand: new Prisma.Decimal('1.25'),
        minimumPayout: new Prisma.Decimal('25.00'),
        isPayoutThresholdReached: true,
        approvedSubmissionsCount: 3,
        eligibleViews: 40000n,
        grossEarnings: new Prisma.Decimal('50.00'),
        eligibleEarnings: new Prisma.Decimal('50.00'),
        pendingEarnings: new Prisma.Decimal('0.00'),
        voidedEarnings: new Prisma.Decimal('0.00'),
        currency: 'USD'
      };

      const embed = buildCampaignEarningsEmbed(campData, dummyUser);
      assert.ok(embed.data.title.includes('Alpha Clips'));
      assert.ok(embed.data.fields.some((f) => f.value.includes('$1.25 / 1k views')));
      assert.ok(embed.data.fields.some((f) => f.value.includes('40,000')));
    });

    test('buildUserEarningsActionRow sets up interactive buttons with user customId', () => {
      const row = buildUserEarningsActionRow('usr_test');
      assert.ok(row.components[0].data.custom_id.includes('usr_test'));
      assert.ok(row.components[1].data.custom_id.includes('usr_test'));
    });
  });
});
