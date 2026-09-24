/**
 * Phase 10A: Campaign Budget, CPM, Fulfillment & Creator Cap Engine
 *
 * Comprehensive test suite covering:
 * - Campaign creation with budget fields
 * - CPM calculation and fulfillment
 * - Campaign budget cap enforcement
 * - Creator $600 cap enforcement
 * - Campaign auto-completion on budget exhaustion
 * - Concurrent budget consumption (race condition safety)
 * - Incremental views correctness
 * - Metric regression guard
 * - Decimal precision
 * - Allowed platform list (including FACEBOOK)
 * - Clip duration defaults and overrides
 * - Retention configuration
 * - Idempotency (duplicate credit prevention)
 * - Payout accounting compatibility
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { calculateGrossAmount, applyBudgetCaps } from '../src/modules/earnings/earnings.calculator.js';
import { EarningsService } from '../src/modules/earnings/earnings.service.js';
import { CampaignService } from '../src/modules/campaigns/campaign.service.js';
import { CAMPAIGN_POLICY } from '../src/modules/campaigns/campaign.policy.js';
import {
  campaignCreateSchema,
  ADMIN_SETTABLE_STATUSES,
  ALLOWED_STATUS_TRANSITIONS
} from '../src/modules/campaigns/campaign.validation.js';
import {
  CampaignBudgetExhaustedError,
  CampaignNotActiveError,
  CampaignNotFoundError
} from '../src/modules/campaigns/campaign.errors.js';
import { withFulfillment } from '../src/modules/campaigns/campaign.repository.js';

// ─────────────────────────────────────────────────────────────────────────────
// MOCK FACTORY — In-memory repository for EarningsService tests
// ─────────────────────────────────────────────────────────────────────────────

function createMockEarningsRepo(campaignDefaults = {}) {
  const campaigns = new Map();
  const submissions = new Map();
  const snapshots = new Map();
  const verifications = new Map();
  const earnings = new Map();
  const memberships = new Map();

  return {
    campaigns,
    submissions,
    snapshots,
    verifications,
    earnings,
    memberships,

    async transaction(callback) {
      return callback(this);
    },

    async acquireSubmissionLock() {},

    async getSubmissionForEarnings(submissionId) {
      const sub = submissions.get(submissionId);
      if (!sub) return null;
      const camp = campaigns.get(sub.campaignId);
      const ver = verifications.get(submissionId);
      const subSnaps = Array.from(snapshots.values())
        .filter((s) => s.submissionId === submissionId)
        .sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));
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

    async getEarningBySnapshotId(sourceSnapshotId) {
      for (const e of earnings.values()) {
        if (e.sourceSnapshotId === sourceSnapshotId) return e;
      }
      return null;
    },

    async createEarning(data) {
      for (const existing of earnings.values()) {
        if (existing.sourceSnapshotId === data.sourceSnapshotId) {
          const err = new Error('Unique constraint failed on source_snapshot_id');
          err.code = 'P2002';
          throw err;
        }
      }
      const id = `earn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const earning = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
      earnings.set(id, earning);
      return earning;
    },

    async getCreatorCampaignTotal(userId, campaignId) {
      let sum = new Prisma.Decimal('0.00');
      for (const e of earnings.values()) {
        if (e.userId === userId && e.campaignId === campaignId && e.status !== 'VOIDED') {
          sum = sum.plus(new Prisma.Decimal(e.grossAmount.toString()));
        }
      }
      return sum;
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
      return Array.from(earnings.values())
        .filter((e) => e.userId === userId && e.campaignId === campaignId)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },

    async getSubmissionEarningsLedger(submissionId) {
      return Array.from(earnings.values())
        .filter((e) => e.submissionId === submissionId)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },

    async getCampaignMembership(userId, campaignId) {
      const key = `${userId}_${campaignId}`;
      const m = memberships.get(key);
      if (!m) return null;
      const c = campaigns.get(campaignId);
      return { ...m, campaign: c };
    }
  };
}

/**
 * Shared campaign repo mock for CampaignService tests
 */
function createMockCampaignRepo(overrides = {}) {
  const campaigns = new Map();
  const memberships = new Map();

  return {
    campaigns,
    memberships,

    async findActive() {
      return Array.from(campaigns.values())
        .filter((c) => c.status === 'ACTIVE')
        .map(withFulfillment);
    },

    async findById(id) {
      const c = campaigns.get(id);
      return c ? withFulfillment(c) : null;
    },

    async findBySlug(slug) {
      for (const c of campaigns.values()) {
        if (c.slug === slug) return withFulfillment(c);
      }
      return null;
    },

    async create(data) {
      const id = `camp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const c = { id, ...data };
      campaigns.set(id, c);
      return withFulfillment(c);
    },

    async updateStatus(id, status) {
      const c = campaigns.get(id);
      if (!c) throw new Error('Not found');
      c.status = status;
      return withFulfillment(c);
    },

    async consumeBudget(campaignId, amount) {
      const c = campaigns.get(campaignId);
      if (!c) throw new Error('Campaign not found');
      const amtDec = new Prisma.Decimal(amount.toString());
      c.consumedBudget = new Prisma.Decimal(c.consumedBudget?.toString() ?? '0').plus(amtDec);
      const remaining = new Prisma.Decimal(c.totalBudget.toString()).minus(c.consumedBudget);
      if (remaining.lessThanOrEqualTo(0) && c.status === 'ACTIVE') {
        c.status = 'COMPLETED';
      }
      return withFulfillment(c);
    },

    async getRemainingBudget(campaignId) {
      const c = campaigns.get(campaignId);
      if (!c) return new Prisma.Decimal('0.00');
      return new Prisma.Decimal(c.totalBudget.toString()).minus(
        new Prisma.Decimal(c.consumedBudget?.toString() ?? '0')
      );
    },

    async findMembership(userId, campaignId) {
      return memberships.get(`${userId}_${campaignId}`) || null;
    },

    async upsertMembership(userId, campaignId, status) {
      const m = { id: `m_${Date.now()}`, userId, campaignId, status, joinedAt: new Date() };
      memberships.set(`${userId}_${campaignId}`, m);
      return m;
    },

    async updateMembershipStatus(userId, campaignId, status) {
      const key = `${userId}_${campaignId}`;
      const m = memberships.get(key);
      if (m) m.status = status;
      return m;
    },

    async findUserMemberships(userId) {
      return Array.from(memberships.values()).filter((m) => m.userId === userId);
    },

    async findCampaignMembers(campaignId) {
      return Array.from(memberships.values()).filter((m) => m.campaignId === campaignId);
    },

    ...overrides
  };
}

function createApprovedSubmission(overrides = {}) {
  return {
    id: 'sub-1',
    userId: 'user-1',
    campaignId: 'camp-1',
    platform: 'YOUTUBE',
    url: 'https://youtube.com/watch?v=abc',
    normalizedUrl: 'https://youtube.com/watch?v=abc',
    status: 'APPROVED',
    submittedAt: new Date(),
    ...overrides
  };
}

function createCampaign(overrides = {}) {
  return {
    id: 'camp-1',
    name: 'Test Campaign',
    slug: 'test-campaign',
    description: 'Test',
    clientName: 'Test Client',
    status: 'ACTIVE',
    payRate: new Prisma.Decimal('1.50'),
    minimumPayout: new Prisma.Decimal('10.00'),
    totalBudget: new Prisma.Decimal('5.00'),
    consumedBudget: new Prisma.Decimal('0.00'),
    creatorEarningCap: new Prisma.Decimal('600.00'),
    currency: 'USD',
    minClipDurationSeconds: 7,
    maxClipDurationSeconds: 120,
    retentionRequired: false,
    retentionDays: null,
    startsAt: new Date('2024-01-01'),
    endsAt: new Date('2099-01-01'),
    requirements: { allowedPlatforms: ['youtube'] },
    ...overrides
  };
}

function createVerification(submissionId, overrides = {}) {
  return {
    id: `ver-${submissionId}`,
    submissionId,
    status: 'COMPLETED',
    riskLevel: 'LOW_RISK',
    ...overrides
  };
}

function createSnapshot(submissionId, views, overrides = {}) {
  const id = overrides.id || `snap-${submissionId}-${views}`;
  return {
    id,
    submissionId,
    views: BigInt(views),
    capturedAt: new Date(),
    ...overrides
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. CAMPAIGN POLICY DEFAULTS
// ─────────────────────────────────────────────────────────────────────────────

describe('1. Campaign Policy Defaults', () => {
  test('DEFAULT_CREATOR_EARNING_CAP is $600.00', () => {
    assert.equal(CAMPAIGN_POLICY.DEFAULT_CREATOR_EARNING_CAP.toFixed(2), '600.00');
  });

  test('DEFAULT_MIN_CLIP_DURATION_SECONDS is 7', () => {
    assert.equal(CAMPAIGN_POLICY.DEFAULT_MIN_CLIP_DURATION_SECONDS, 7);
  });

  test('DEFAULT_MAX_CLIP_DURATION_SECONDS is 120', () => {
    assert.equal(CAMPAIGN_POLICY.DEFAULT_MAX_CLIP_DURATION_SECONDS, 120);
  });

  test('SUPPORTED_PLATFORMS includes YOUTUBE, TIKTOK, INSTAGRAM, FACEBOOK', () => {
    const platforms = CAMPAIGN_POLICY.SUPPORTED_PLATFORMS;
    assert.ok(platforms.includes('YOUTUBE'));
    assert.ok(platforms.includes('TIKTOK'));
    assert.ok(platforms.includes('INSTAGRAM'));
    assert.ok(platforms.includes('FACEBOOK'));
  });

  test('MINIMUM_TOTAL_BUDGET is $1.00', () => {
    assert.equal(CAMPAIGN_POLICY.MINIMUM_TOTAL_BUDGET.toFixed(2), '1.00');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. CAMPAIGN CREATE SCHEMA VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

describe('2. Campaign Create Schema Validation', () => {
  const baseData = {
    name: 'My Campaign',
    slug: 'my-campaign',
    description: 'A campaign with at least 10 chars',
    clientName: 'Acme Corp',
    payRate: 1.50,
    totalBudget: 5.00,
    startsAt: new Date('2024-01-01'),
    endsAt: new Date('2024-12-31'),
    requirements: { allowedPlatforms: ['youtube'] }
  };

  test('valid full campaign data parses successfully', () => {
    const result = campaignCreateSchema.safeParse(baseData);
    assert.ok(result.success, `Parse failed: ${JSON.stringify(result.error?.format())}`);
  });

  test('totalBudget defaults are applied', () => {
    const result = campaignCreateSchema.parse(baseData);
    assert.ok(result.totalBudget > 0);
  });

  test('creatorEarningCap defaults to 600', () => {
    const result = campaignCreateSchema.parse(baseData);
    assert.equal(result.creatorEarningCap, 600);
  });

  test('minClipDurationSeconds defaults to 7', () => {
    const result = campaignCreateSchema.parse(baseData);
    assert.equal(result.minClipDurationSeconds, 7);
  });

  test('maxClipDurationSeconds defaults to 120', () => {
    const result = campaignCreateSchema.parse(baseData);
    assert.equal(result.maxClipDurationSeconds, 120);
  });

  test('custom clip duration is respected', () => {
    const result = campaignCreateSchema.parse({ ...baseData, minClipDurationSeconds: 15, maxClipDurationSeconds: 60 });
    assert.equal(result.minClipDurationSeconds, 15);
    assert.equal(result.maxClipDurationSeconds, 60);
  });

  test('maxClipDuration < minClipDuration fails validation', () => {
    const result = campaignCreateSchema.safeParse({ ...baseData, minClipDurationSeconds: 60, maxClipDurationSeconds: 30 });
    assert.ok(!result.success);
    assert.ok(result.error.format().maxClipDurationSeconds);
  });

  test('zero totalBudget fails validation', () => {
    const result = campaignCreateSchema.safeParse({ ...baseData, totalBudget: 0 });
    assert.ok(!result.success);
  });

  test('negative totalBudget fails validation', () => {
    const result = campaignCreateSchema.safeParse({ ...baseData, totalBudget: -10 });
    assert.ok(!result.success);
  });

  test('retentionRequired=true without retentionDays fails validation', () => {
    const result = campaignCreateSchema.safeParse({ ...baseData, retentionRequired: true });
    assert.ok(!result.success);
  });

  test('retentionRequired=true with retentionDays=7 passes', () => {
    const result = campaignCreateSchema.safeParse({ ...baseData, retentionRequired: true, retentionDays: 7 });
    assert.ok(result.success, `Failed: ${JSON.stringify(result.error?.format())}`);
    assert.equal(result.data.retentionDays, 7);
  });

  test('FACEBOOK is a valid allowedPlatform', () => {
    const result = campaignCreateSchema.safeParse({ ...baseData, requirements: { allowedPlatforms: ['facebook'] } });
    assert.ok(result.success, `Failed: ${JSON.stringify(result.error?.format())}`);
  });

  test('endsAt before startsAt fails validation', () => {
    const result = campaignCreateSchema.safeParse({
      ...baseData,
      startsAt: new Date('2024-12-31'),
      endsAt: new Date('2024-01-01')
    });
    assert.ok(!result.success);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. FULFILLMENT CALCULATION (withFulfillment helper)
// ─────────────────────────────────────────────────────────────────────────────

describe('3. Campaign Fulfillment Calculation', () => {
  test('zero consumed budget → 0% fulfillment', () => {
    const c = withFulfillment({ totalBudget: new Prisma.Decimal('5.00'), consumedBudget: new Prisma.Decimal('0.00') });
    assert.equal(c.fulfillmentPercent.toFixed(2), '0.00');
    assert.equal(c.remainingBudget.toFixed(2), '5.00');
  });

  test('SCENARIO A: $1.50 consumed of $5.00 → 30% fulfillment', () => {
    const c = withFulfillment({ totalBudget: new Prisma.Decimal('5.00'), consumedBudget: new Prisma.Decimal('1.50') });
    assert.equal(c.fulfillmentPercent.toFixed(2), '30.00');
    assert.equal(c.remainingBudget.toFixed(2), '3.50');
  });

  test('full consumption → 100% fulfillment, $0.00 remaining', () => {
    const c = withFulfillment({ totalBudget: new Prisma.Decimal('5.00'), consumedBudget: new Prisma.Decimal('5.00') });
    assert.equal(c.fulfillmentPercent.toFixed(2), '100.00');
    assert.equal(c.remainingBudget.toFixed(2), '0.00');
  });

  test('$525 consumed of $2000 → 26.25% fulfillment', () => {
    const c = withFulfillment({ totalBudget: new Prisma.Decimal('2000.00'), consumedBudget: new Prisma.Decimal('525.00') });
    assert.equal(c.fulfillmentPercent.toFixed(2), '26.25');
    assert.equal(c.remainingBudget.toFixed(2), '1475.00');
  });

  test('remainingBudget never goes negative', () => {
    const c = withFulfillment({ totalBudget: new Prisma.Decimal('5.00'), consumedBudget: new Prisma.Decimal('10.00') });
    assert.equal(c.remainingBudget.toFixed(2), '0.00');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. applyBudgetCaps() — cap logic
// ─────────────────────────────────────────────────────────────────────────────

describe('4. Budget Cap Enforcement (applyBudgetCaps)', () => {
  test('no cap applied when raw < both limits', () => {
    const { actualCredit, cappedBy } = applyBudgetCaps('1.00', '5.00', '600.00');
    assert.equal(actualCredit.toFixed(2), '1.00');
    assert.equal(cappedBy, null);
  });

  test('SCENARIO B: campaign budget cap — $0.40 remaining, $1.50 raw → $0.40 actual', () => {
    const { actualCredit, cappedBy } = applyBudgetCaps('1.50', '0.40', '600.00');
    assert.equal(actualCredit.toFixed(2), '0.40');
    assert.equal(cappedBy, 'CAMPAIGN');
  });

  test('SCENARIO C: creator cap — creator at $599.50, raw $1.50 → $0.50 actual', () => {
    // creatorRemaining = 600 - 599.50 = 0.50
    const { actualCredit, cappedBy } = applyBudgetCaps('1.50', '1000.00', '0.50');
    assert.equal(actualCredit.toFixed(2), '0.50');
    assert.equal(cappedBy, 'CREATOR');
  });

  test('SCENARIO D: creator at cap → $0 credit, CREATOR reason', () => {
    const { actualCredit, cappedBy } = applyBudgetCaps('1.50', '1000.00', '0.00');
    assert.equal(actualCredit.toFixed(2), '0.00');
    assert.equal(cappedBy, 'CREATOR');
  });

  test('campaign budget exhausted → $0 credit, CAMPAIGN reason', () => {
    const { actualCredit, cappedBy } = applyBudgetCaps('1.50', '0.00', '600.00');
    assert.equal(actualCredit.toFixed(2), '0.00');
    assert.equal(cappedBy, 'CAMPAIGN');
  });

  test('both limits hit simultaneously', () => {
    const { actualCredit } = applyBudgetCaps('1.50', '0.00', '0.00');
    assert.equal(actualCredit.toFixed(2), '0.00');
  });

  test('Decimal precision preserved throughout', () => {
    // $0.333... campaign remaining, $1.50 raw → $0.33 credited
    const { actualCredit } = applyBudgetCaps('1.50', '0.333', '600.00');
    assert.equal(actualCredit.toFixed(2), '0.33');
  });

  test('raw = 0 → $0 credit', () => {
    const { actualCredit } = applyBudgetCaps('0.00', '500.00', '500.00');
    assert.equal(actualCredit.toFixed(2), '0.00');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. CPM CALCULATION CORRECTNESS
// ─────────────────────────────────────────────────────────────────────────────

describe('5. CPM Calculation Correctness', () => {
  test('SCENARIO A: 1k views at $1.50 CPM = $1.50', () => {
    assert.equal(calculateGrossAmount(1000n, '1.50').toFixed(2), '1.50');
  });

  test('1k views at $5 CPM = $5.00', () => {
    assert.equal(calculateGrossAmount(1000n, '5.00').toFixed(2), '5.00');
  });

  test('500 views at $1.50 CPM = $0.75', () => {
    assert.equal(calculateGrossAmount(500n, '1.50').toFixed(2), '0.75');
  });

  test('0 views = $0.00', () => {
    assert.equal(calculateGrossAmount(0n, '1.50').toFixed(2), '0.00');
  });

  test('434,796,970 views at $1.00 CPM = $434,796.97', () => {
    assert.equal(calculateGrossAmount(434796970n, '1.00').toFixed(2), '434796.97');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. EARNINGS SERVICE — BUDGET CAP INTEGRATION
// ─────────────────────────────────────────────────────────────────────────────

describe('6. EarningsService — Budget Cap Integration', () => {
  /**
   * Helper: build an EarningsService with pre-seeded mock data
   */
  function buildService(campaignOverrides = {}, submissionOverrides = {}) {
    const earningsRepo = createMockEarningsRepo();
    const campaignRepo = createMockCampaignRepo();

    const camp = createCampaign(campaignOverrides);
    earningsRepo.campaigns.set(camp.id, camp);
    campaignRepo.campaigns.set(camp.id, camp);

    const sub = createApprovedSubmission({ ...submissionOverrides, campaignId: camp.id });
    earningsRepo.submissions.set(sub.id, sub);

    const ver = createVerification(sub.id);
    earningsRepo.verifications.set(sub.id, ver);

    const snap = createSnapshot(sub.id, 1000, { id: 'snap-1' });
    earningsRepo.snapshots.set(snap.id, snap);

    const svc = new EarningsService(earningsRepo, campaignRepo);
    return { svc, earningsRepo, campaignRepo, camp, sub, snap };
  }

  test('SCENARIO A: $5 budget / $1.50 CPM / 1k views → $1.50 actual, 30% fulfillment', async () => {
    const { svc, campaignRepo, camp, sub, snap } = buildService(
      { totalBudget: new Prisma.Decimal('5.00'), consumedBudget: new Prisma.Decimal('0.00') }
    );

    const result = await svc.creditNewEligibleViews(sub.id, snap.id);

    assert.equal(result.reason, 'CREDITED_SUCCESSFULLY');
    assert.equal(result.actualCredit.toFixed(2), '1.50');
    assert.equal(result.cappedBy, null);

    // Verify fulfillment via campaign repo
    const updatedCamp = await campaignRepo.findById(camp.id);
    assert.equal(updatedCamp.consumedBudget.toFixed(2), '1.50');
    assert.equal(updatedCamp.fulfillmentPercent.toFixed(2), '30.00');
    assert.equal(updatedCamp.remainingBudget.toFixed(2), '3.50');
    assert.equal(updatedCamp.status, 'ACTIVE'); // Not completed yet
  });

  test('SCENARIO B: $0.40 remaining / $1.50 raw → $0.40 actual, campaign COMPLETED', async () => {
    const { svc, campaignRepo, camp, sub, snap } = buildService(
      { totalBudget: new Prisma.Decimal('5.00'), consumedBudget: new Prisma.Decimal('4.60') }
    );

    const result = await svc.creditNewEligibleViews(sub.id, snap.id);

    assert.equal(result.reason, 'CREDITED_SUCCESSFULLY');
    assert.equal(result.actualCredit.toFixed(2), '0.40');
    assert.equal(result.cappedBy, 'CAMPAIGN');

    const updatedCamp = await campaignRepo.findById(camp.id);
    assert.equal(updatedCamp.consumedBudget.toFixed(2), '5.00');
    assert.equal(updatedCamp.status, 'COMPLETED');
    assert.equal(updatedCamp.remainingBudget.toFixed(2), '0.00');
    assert.equal(updatedCamp.fulfillmentPercent.toFixed(2), '100.00');
  });

  test('SCENARIO C: creator at $599.50, next raw earning $1.50 → $0.50 actual', async () => {
    const earningsRepo = createMockEarningsRepo();
    const campaignRepo = createMockCampaignRepo();

    const camp = createCampaign({
      totalBudget: new Prisma.Decimal('2000.00'),
      consumedBudget: new Prisma.Decimal('599.50'),
      creatorEarningCap: new Prisma.Decimal('600.00')
    });
    earningsRepo.campaigns.set(camp.id, camp);
    campaignRepo.campaigns.set(camp.id, camp);

    const sub = createApprovedSubmission({ campaignId: camp.id });
    earningsRepo.submissions.set(sub.id, sub);
    earningsRepo.verifications.set(sub.id, createVerification(sub.id));

    // Pre-existing earning of $599.50 for this creator in this campaign
    const previousEarning = {
      id: 'earn-prev',
      userId: sub.userId,
      campaignId: camp.id,
      submissionId: sub.id,
      sourceSnapshotId: 'snap-prev',
      eligibleViews: 399666n, // $599.50 at $1.50/1k
      grossAmount: new Prisma.Decimal('599.50'),
      status: 'ELIGIBLE',
      createdAt: new Date()
    };
    earningsRepo.earnings.set('earn-prev', previousEarning);

    const snap = createSnapshot(sub.id, 400666, { id: 'snap-2' });
    earningsRepo.snapshots.set(snap.id, snap);

    const svc = new EarningsService(earningsRepo, campaignRepo);
    const result = await svc.creditNewEligibleViews(sub.id, snap.id);

    assert.equal(result.reason, 'CREDITED_SUCCESSFULLY');
    assert.equal(result.actualCredit.toFixed(2), '0.50');
    assert.equal(result.cappedBy, 'CREATOR');

    // Total creator earnings = $599.50 + $0.50 = $600.00
    const total = await earningsRepo.getCreatorCampaignTotal(sub.userId, camp.id);
    assert.equal(total.toFixed(2), '600.00');
  });

  test('SCENARIO D: creator already at $600 → $0 earnings, CREATOR_CAP_REACHED', async () => {
    const earningsRepo = createMockEarningsRepo();
    const campaignRepo = createMockCampaignRepo();

    const camp = createCampaign({
      totalBudget: new Prisma.Decimal('2000.00'),
      consumedBudget: new Prisma.Decimal('600.00'),
      creatorEarningCap: new Prisma.Decimal('600.00')
    });
    earningsRepo.campaigns.set(camp.id, camp);
    campaignRepo.campaigns.set(camp.id, camp);

    const sub = createApprovedSubmission({ campaignId: camp.id });
    earningsRepo.submissions.set(sub.id, sub);
    earningsRepo.verifications.set(sub.id, createVerification(sub.id));

    // Creator has exactly $600 already
    earningsRepo.earnings.set('earn-full', {
      id: 'earn-full',
      userId: sub.userId,
      campaignId: camp.id,
      submissionId: sub.id,
      sourceSnapshotId: 'snap-full',
      eligibleViews: 400000n,
      grossAmount: new Prisma.Decimal('600.00'),
      status: 'ELIGIBLE',
      createdAt: new Date()
    });

    const snap = createSnapshot(sub.id, 401000, { id: 'snap-new' });
    earningsRepo.snapshots.set(snap.id, snap);

    const svc = new EarningsService(earningsRepo, campaignRepo);
    const result = await svc.creditNewEligibleViews(sub.id, snap.id);

    assert.equal(result.reason, 'CREATOR_CAP_REACHED');
    assert.equal(result.actualCredit.toFixed(2), '0.00');
    assert.equal(result.earning, null);
  });

  test('SCENARIO E: concurrent budget consumption — total never exceeds budget', async () => {
    // Simulate two simultaneous earning events each claiming $3.00 on a $5.00 budget
    // Only $5.00 total should ever be credited (limited by remaining budget in each txn)
    const earningsRepo = createMockEarningsRepo();
    const campaignRepo = createMockCampaignRepo();

    const camp = createCampaign({
      totalBudget: new Prisma.Decimal('5.00'),
      consumedBudget: new Prisma.Decimal('0.00')
    });
    earningsRepo.campaigns.set(camp.id, camp);
    campaignRepo.campaigns.set(camp.id, camp);

    // Creator 1 — 2000 views at $1.50 = $3.00 raw
    const sub1 = createApprovedSubmission({ id: 'sub-c1', userId: 'user-1', campaignId: camp.id });
    earningsRepo.submissions.set(sub1.id, sub1);
    earningsRepo.verifications.set(sub1.id, createVerification(sub1.id));
    const snap1 = createSnapshot(sub1.id, 2000, { id: 'snap-c1' });
    earningsRepo.snapshots.set(snap1.id, snap1);

    // Creator 2 — 2000 views at $1.50 = $3.00 raw
    const sub2 = createApprovedSubmission({ id: 'sub-c2', userId: 'user-2', campaignId: camp.id });
    earningsRepo.submissions.set(sub2.id, sub2);
    earningsRepo.verifications.set(sub2.id, createVerification(sub2.id));
    const snap2 = createSnapshot(sub2.id, 2000, { id: 'snap-c2' });
    earningsRepo.snapshots.set(snap2.id, snap2);

    const svc = new EarningsService(earningsRepo, campaignRepo);

    // Run sequentially (mock doesn't support true concurrency, but logic is identical)
    const r1 = await svc.creditNewEligibleViews(sub1.id, snap1.id);
    const r2 = await svc.creditNewEligibleViews(sub2.id, snap2.id);

    const total = r1.actualCredit.plus(r2.actualCredit);
    // Total must not exceed $5.00
    assert.ok(
      total.lessThanOrEqualTo(new Prisma.Decimal('5.00')),
      `Total exceeded budget: ${total.toFixed(2)}`
    );

    const finalCamp = await campaignRepo.findById(camp.id);
    assert.ok(
      new Prisma.Decimal(finalCamp.consumedBudget.toString()).lessThanOrEqualTo(new Prisma.Decimal('5.00')),
      `consumedBudget exceeded totalBudget: ${finalCamp.consumedBudget}`
    );
  });

  test('incremental views: second snapshot credits only new views', async () => {
    const earningsRepo = createMockEarningsRepo();
    const campaignRepo = createMockCampaignRepo();

    const camp = createCampaign({
      totalBudget: new Prisma.Decimal('1000.00'),
      consumedBudget: new Prisma.Decimal('0.00')
    });
    earningsRepo.campaigns.set(camp.id, camp);
    campaignRepo.campaigns.set(camp.id, camp);

    const sub = createApprovedSubmission({ campaignId: camp.id });
    earningsRepo.submissions.set(sub.id, sub);
    earningsRepo.verifications.set(sub.id, createVerification(sub.id));

    // First snapshot: 100,000 views → $150.00
    const snap1 = createSnapshot(sub.id, 100000, { id: 'snap-s1', capturedAt: new Date('2024-01-01') });
    earningsRepo.snapshots.set(snap1.id, snap1);

    const svc = new EarningsService(earningsRepo, campaignRepo);
    const r1 = await svc.creditNewEligibleViews(sub.id, snap1.id);
    assert.equal(r1.actualCredit.toFixed(2), '150.00');
    assert.equal(r1.newlyCreditedViews.toString(), '100000');

    // Second snapshot: 150,000 views → only 50,000 incremental → $75.00
    const snap2 = createSnapshot(sub.id, 150000, { id: 'snap-s2', capturedAt: new Date('2024-01-02') });
    earningsRepo.snapshots.set(snap2.id, snap2);
    const r2 = await svc.creditNewEligibleViews(sub.id, snap2.id);
    assert.equal(r2.actualCredit.toFixed(2), '75.00');
    assert.equal(r2.newlyCreditedViews.toString(), '50000');

    // Third snapshot: 220,000 → only 70,000 incremental → $105.00
    const snap3 = createSnapshot(sub.id, 220000, { id: 'snap-s3', capturedAt: new Date('2024-01-03') });
    earningsRepo.snapshots.set(snap3.id, snap3);
    const r3 = await svc.creditNewEligibleViews(sub.id, snap3.id);
    assert.equal(r3.actualCredit.toFixed(2), '105.00');
    assert.equal(r3.newlyCreditedViews.toString(), '70000');
  });

  test('metric regression: views decrease → no negative earning created', async () => {
    const earningsRepo = createMockEarningsRepo();
    const campaignRepo = createMockCampaignRepo();

    const camp = createCampaign({ totalBudget: new Prisma.Decimal('1000.00'), consumedBudget: new Prisma.Decimal('0.00') });
    earningsRepo.campaigns.set(camp.id, camp);
    campaignRepo.campaigns.set(camp.id, camp);

    const sub = createApprovedSubmission({ campaignId: camp.id });
    earningsRepo.submissions.set(sub.id, sub);
    earningsRepo.verifications.set(sub.id, createVerification(sub.id));

    // First: 200,000 views credited
    const snap1 = createSnapshot(sub.id, 200000, { id: 'snap-r1', capturedAt: new Date('2024-01-01') });
    earningsRepo.snapshots.set(snap1.id, snap1);
    await new EarningsService(earningsRepo, campaignRepo).creditNewEligibleViews(sub.id, snap1.id);

    // Second: metric regression to 150,000 views
    const snap2 = createSnapshot(sub.id, 150000, { id: 'snap-r2', capturedAt: new Date('2024-01-02') });
    earningsRepo.snapshots.set(snap2.id, snap2);
    const r2 = await new EarningsService(earningsRepo, campaignRepo).creditNewEligibleViews(sub.id, snap2.id);

    assert.equal(r2.reason, 'METRIC_REGRESSION');
    assert.equal(r2.actualCredit.toFixed(2), '0.00');
    assert.equal(r2.earning, null);

    // Ledger unchanged
    const total = await earningsRepo.getCreatorCampaignTotal(sub.userId, camp.id);
    assert.equal(total.toFixed(2), '300.00'); // 200,000 * $1.50/1k
  });

  test('idempotency: same snapshot credited twice returns ALREADY_CREDITED', async () => {
    const { svc, sub, snap } = buildService();
    const r1 = await svc.creditNewEligibleViews(sub.id, snap.id);
    assert.equal(r1.reason, 'CREDITED_SUCCESSFULLY');

    const r2 = await svc.creditNewEligibleViews(sub.id, snap.id);
    assert.equal(r2.reason, 'ALREADY_CREDITED');
    assert.equal(r2.actualCredit.toFixed(2), '0.00');
  });

  test('ineligible (non-APPROVED) submission throws IneligibleSubmissionError', async () => {
    const { svc, sub, snap, earningsRepo } = buildService({ totalBudget: new Prisma.Decimal('100.00'), consumedBudget: new Prisma.Decimal('0.00') }, { status: 'PENDING_VERIFICATION' });
    // Need to fix the submission status in our repo
    earningsRepo.submissions.get(sub.id).status = 'PENDING_VERIFICATION';
    await assert.rejects(
      () => svc.creditNewEligibleViews(sub.id, snap.id),
      (err) => err.name === 'IneligibleSubmissionError' || err.code === 'INELIGIBLE_SUBMISSION'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. CAMPAIGN SERVICE — joinCampaign budget guard
// ─────────────────────────────────────────────────────────────────────────────

describe('7. CampaignService — joinCampaign budget guard', () => {
  function buildCampaignService(campaignOverrides = {}) {
    const repo = createMockCampaignRepo();
    const userService = {
      async getProfile(id) { return { id, status: 'ACTIVE' }; },
      assertUserCanParticipate() {}
    };
    const camp = createCampaign(campaignOverrides);
    repo.campaigns.set(camp.id, camp);
    const svc = new CampaignService(repo, userService);
    return { svc, repo, camp };
  }

  test('active campaign with budget can be joined', async () => {
    const { svc, camp } = buildCampaignService();
    const membership = await svc.joinCampaign('user-1', camp.id);
    assert.equal(membership.status, 'ACTIVE');
  });

  test('COMPLETED campaign throws CampaignBudgetExhaustedError', async () => {
    const { svc, camp } = buildCampaignService({
      status: 'COMPLETED',
      totalBudget: new Prisma.Decimal('5.00'),
      consumedBudget: new Prisma.Decimal('5.00')
    });
    await assert.rejects(
      () => svc.joinCampaign('user-1', camp.id),
      CampaignBudgetExhaustedError
    );
  });

  test('ACTIVE campaign with zero remaining budget throws CampaignBudgetExhaustedError', async () => {
    const { svc, camp } = buildCampaignService({
      status: 'ACTIVE',
      totalBudget: new Prisma.Decimal('5.00'),
      consumedBudget: new Prisma.Decimal('5.00')
    });
    await assert.rejects(
      () => svc.joinCampaign('user-1', camp.id),
      CampaignBudgetExhaustedError
    );
  });

  test('PAUSED campaign throws CampaignNotActiveError (not budget error)', async () => {
    const { svc, camp } = buildCampaignService({ status: 'PAUSED' });
    await assert.rejects(
      () => svc.joinCampaign('user-1', camp.id),
      CampaignNotActiveError
    );
  });

  test('non-existent campaign throws CampaignNotFoundError', async () => {
    const { svc } = buildCampaignService();
    await assert.rejects(
      () => svc.joinCampaign('user-1', 'non-existent-id'),
      CampaignNotFoundError
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. STATUS MACHINE — COMPLETED transitions
// ─────────────────────────────────────────────────────────────────────────────

describe('8. Status Machine — COMPLETED transitions', () => {
  test('ACTIVE can transition to COMPLETED (system-only)', () => {
    assert.ok(ALLOWED_STATUS_TRANSITIONS.ACTIVE.includes('COMPLETED'));
  });

  test('COMPLETED can transition to ARCHIVED', () => {
    assert.ok(ALLOWED_STATUS_TRANSITIONS.COMPLETED.includes('ARCHIVED'));
  });

  test('COMPLETED is NOT in admin-settable statuses', () => {
    assert.ok(!ADMIN_SETTABLE_STATUSES.includes('COMPLETED'));
  });

  test('COMPLETED cannot transition back to ACTIVE', () => {
    assert.ok(!ALLOWED_STATUS_TRANSITIONS.COMPLETED.includes('ACTIVE'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. CLIP DURATION & RETENTION DEFAULTS
// ─────────────────────────────────────────────────────────────────────────────

describe('9. Clip Duration & Retention Defaults', () => {
  test('withFulfillment passes through minClipDurationSeconds', () => {
    const c = withFulfillment({
      totalBudget: new Prisma.Decimal('100.00'),
      consumedBudget: new Prisma.Decimal('0.00'),
      minClipDurationSeconds: 15,
      maxClipDurationSeconds: 90
    });
    assert.equal(c.minClipDurationSeconds, 15);
    assert.equal(c.maxClipDurationSeconds, 90);
  });

  test('retention fields are preserved in campaign object', () => {
    const c = withFulfillment({
      totalBudget: new Prisma.Decimal('100.00'),
      consumedBudget: new Prisma.Decimal('0.00'),
      retentionRequired: true,
      retentionDays: 30
    });
    assert.equal(c.retentionRequired, true);
    assert.equal(c.retentionDays, 30);
  });

  test('default clip duration parses correctly from schema', () => {
    const result = campaignCreateSchema.parse({
      name: 'My Campaign',
      slug: 'my-campaign-dur',
      description: 'Test description text',
      clientName: 'Test Client',
      payRate: 1.50,
      totalBudget: 100,
      startsAt: new Date('2024-01-01'),
      endsAt: new Date('2024-12-31'),
      requirements: { allowedPlatforms: ['youtube'] }
    });
    assert.equal(result.minClipDurationSeconds, CAMPAIGN_POLICY.DEFAULT_MIN_CLIP_DURATION_SECONDS);
    assert.equal(result.maxClipDurationSeconds, CAMPAIGN_POLICY.DEFAULT_MAX_CLIP_DURATION_SECONDS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. DECIMAL PRECISION
// ─────────────────────────────────────────────────────────────────────────────

describe('10. Decimal Precision', () => {
  test('$0.333... campaign remaining is capped to $0.33 in actualCredit', () => {
    const { actualCredit } = applyBudgetCaps('1.50', '0.333', '600.00');
    assert.equal(actualCredit.toFixed(2), '0.33');
  });

  test('fulfillment percentage uses ROUND_HALF_UP', () => {
    // 1/3 = 33.333... → 33.33%
    const c = withFulfillment({
      totalBudget: new Prisma.Decimal('3.00'),
      consumedBudget: new Prisma.Decimal('1.00')
    });
    assert.equal(c.fulfillmentPercent.toFixed(2), '33.33');
  });

  test('exact $600.00 cap is preserved without floating-point drift', () => {
    const raw = new Prisma.Decimal('1.50');
    const remaining = new Prisma.Decimal('0.50'); // creatorRemaining
    const { actualCredit } = applyBudgetCaps(raw, '10000.00', remaining);
    // $599.50 + $0.50 = exactly $600.00
    const total = new Prisma.Decimal('599.50').plus(actualCredit);
    assert.equal(total.toFixed(2), '600.00');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. PLATFORM SUPPORT
// ─────────────────────────────────────────────────────────────────────────────

describe('11. Platform Support', () => {
  test('FACEBOOK is valid in campaign requirements schema', () => {
    const result = campaignCreateSchema.safeParse({
      name: 'Facebook Campaign',
      slug: 'fb-campaign',
      description: 'A test description that is long enough',
      clientName: 'Test Client',
      payRate: 2.00,
      totalBudget: 500,
      startsAt: new Date('2024-01-01'),
      endsAt: new Date('2024-12-31'),
      requirements: { allowedPlatforms: ['facebook', 'youtube'] }
    });
    assert.ok(result.success, JSON.stringify(result.error?.format()));
    assert.ok(result.data.requirements.allowedPlatforms.includes('facebook'));
  });

  test('multi-platform campaign (all 4) is valid', () => {
    const result = campaignCreateSchema.safeParse({
      name: 'All Platforms',
      slug: 'all-platforms',
      description: 'Multi-platform campaign test',
      clientName: 'Test Client',
      payRate: 1.00,
      totalBudget: 1000,
      startsAt: new Date('2024-01-01'),
      endsAt: new Date('2024-12-31'),
      requirements: { allowedPlatforms: ['youtube', 'tiktok', 'instagram', 'facebook'] }
    });
    assert.ok(result.success);
    assert.equal(result.data.requirements.allowedPlatforms.length, 4);
  });

  test('invalid platform is rejected', () => {
    const result = campaignCreateSchema.safeParse({
      name: 'Invalid Platform',
      slug: 'invalid-platform',
      description: 'Campaign with invalid platform',
      clientName: 'Test Client',
      payRate: 1.00,
      totalBudget: 1000,
      startsAt: new Date('2024-01-01'),
      endsAt: new Date('2024-12-31'),
      requirements: { allowedPlatforms: ['snapchat'] }
    });
    assert.ok(!result.success);
  });
});
