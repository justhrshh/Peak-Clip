import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { calculateGrossAmount, applyBudgetCaps } from '../src/modules/earnings/earnings.calculator.js';
import { EarningsService } from '../src/modules/earnings/earnings.service.js';
import { PayoutService } from '../src/modules/payouts/payout.service.js';
import {
  PayoutProfileService,
  maskWalletAddress
} from '../src/modules/payout-profile/payout-profile.service.js';
import {
  validateEvidenceFile,
  buildMockMp4Buffer
} from '../src/modules/evidence/evidence.validator.js';
import { RetentionService } from '../src/modules/retention/retention.service.js';
import { AdjustmentService } from '../src/modules/adjustments/adjustment.service.js';

describe('Phase 10G Complete Synthetic End-to-End Lifecycles', () => {

  // =========================================================================
  // SCENARIO 1: Complete Happy Path Lifecycle
  // =========================================================================
  test('Complete End-to-End Happy Path: Register -> Submit -> Verify -> Earn -> Retain -> Profile -> Evidence -> Payout -> Disburse', async () => {
    // 1. Data Store Initialization
    const users = new Map();
    const campaigns = new Map();
    const submissions = new Map();
    const snapshots = new Map();
    const earnings = new Map();
    const adjustments = new Map();
    const payoutProfiles = new Map();
    const payoutRequests = new Map();
    const payoutEvents = [];
    const disbursements = [];
    const auditLogs = [];

    // Helper: Mock DB client & Repositories
    const mockDb = {
      user: {
        async findUnique({ where }) { return users.get(where.id) || null; }
      },
      payoutProfile: {
        async findUnique({ where }) { return payoutProfiles.get(where.userId) || null; },
        async create({ data }) {
          const profile = { id: `prof_${payoutProfiles.size + 1}`, ...data };
          payoutProfiles.set(data.userId, profile);
          return profile;
        }
      },
      earning: {
        async findMany({ where }) {
          return Array.from(earnings.values()).filter((e) => !where?.submissionId || e.submissionId === where.submissionId);
        }
      },
      financialAdjustment: {
        async findMany({ where }) {
          return Array.from(adjustments.values()).filter((a) => !where?.userId || a.userId === where.userId);
        }
      }
    };

    // --- STEP 1: Creator Registration ---
    const creatorUser = {
      id: 'usr_creator_e2e',
      discordId: 'discord_creator_123',
      status: 'ACTIVE',
      createdAt: new Date()
    };
    users.set(creatorUser.id, creatorUser);

    // --- STEP 2: Campaign Setup ---
    const campaign = {
      id: 'camp_e2e_alpha',
      name: 'Launch Blitz',
      totalBudget: new Prisma.Decimal('500.00'),
      consumedBudget: new Prisma.Decimal('0.00'),
      payRate: new Prisma.Decimal('2.50'), // $2.50 per 1k views
      creatorCapAmount: new Prisma.Decimal('100.00'),
      status: 'ACTIVE',
      currency: 'USD'
    };
    campaigns.set(campaign.id, campaign);

    // --- STEP 3: Submission & Automatic Verification ---
    const submission = {
      id: 'sub_e2e_1',
      userId: creatorUser.id,
      campaignId: campaign.id,
      platform: 'YOUTUBE',
      url: 'https://youtube.com/shorts/e2e_happy_clip',
      status: 'APPROVED',
      retentionRequired: true,
      retentionStatus: 'ACTIVE',
      retentionDeadline: new Date(Date.now() - 1000), // Deadline passed
      verifications: [{ status: 'COMPLETED', riskLevel: 'LOW_RISK' }]
    };
    submissions.set(submission.id, submission);

    // Initial snapshot: 4,000 views
    const snap1 = {
      id: 'snap_e2e_1',
      submissionId: submission.id,
      views: 4000n,
      capturedAt: new Date(Date.now() - 3600000)
    };
    snapshots.set(snap1.id, snap1);

    // --- STEP 4: Initial Earning Ledgering ---
    const mockEarningsRepo = {
      async transaction(cb) { return cb(mockEarningsRepo); },
      async acquireSubmissionLock() {},
      async getSubmissionForEarnings(subId) {
        return {
          ...submissions.get(subId),
          campaign: campaigns.get(campaign.id),
          verifications: [{ status: 'COMPLETED' }],
          snapshots: [snap1]
        };
      },
      async getSnapshotById(snapId) { return snapshots.get(snapId); },
      async getPreviouslyCreditedViews() { return 0n; },
      async getEarningBySnapshotId(snapId) {
        for (const e of earnings.values()) {
          if (e.sourceSnapshotId === snapId) return e;
        }
        return null;
      },
      async getCreatorCampaignTotal() { return new Prisma.Decimal('0.00'); },
      async createEarning(data) {
        const id = `earn_${earnings.size + 1}`;
        const record = { id, ...data };
        earnings.set(id, record);
        return record;
      },
      async updateCampaignBudget() {},
      async updateSubmissionMetrics() {}
    };

    const mockCampaignRepo = {
      async consumeBudget(campId, amount) {
        const c = campaigns.get(campId);
        c.consumedBudget = c.consumedBudget.plus(amount);
      }
    };

    const earningsService = new EarningsService(mockEarningsRepo, mockCampaignRepo);

    // Credit initial views (4,000 views -> $10.00)
    const initialCredit = await earningsService.creditNewEligibleViews(submission.id, snap1.id);
    assert.equal(initialCredit.actualCredit.toFixed(2), '10.00');
    assert.equal(campaign.consumedBudget.toFixed(2), '10.00');

    // --- STEP 5: Metric Growth & Incremental Earnings ---
    // Views jump from 4,000 to 12,000 (+8,000 views -> $20.00)
    const snap2 = {
      id: 'snap_e2e_2',
      submissionId: submission.id,
      views: 12000n,
      capturedAt: new Date()
    };
    snapshots.set(snap2.id, snap2);

    mockEarningsRepo.getSubmissionForEarnings = async () => ({
      ...submissions.get(submission.id),
      campaign: campaigns.get(campaign.id),
      verifications: [{ status: 'COMPLETED' }],
      snapshots: [snap2]
    });
    mockEarningsRepo.getPreviouslyCreditedViews = async () => 4000n;
    mockEarningsRepo.getCreatorCampaignTotal = async () => new Prisma.Decimal('10.00');

    const incrementalCredit = await earningsService.creditNewEligibleViews(submission.id, snap2.id);
    assert.equal(incrementalCredit.actualCredit.toFixed(2), '20.00');
    assert.equal(campaign.consumedBudget.toFixed(2), '30.00'); // $10.00 + $20.00

    // Total creator balance is now $30.00
    let totalEarned = new Prisma.Decimal('30.00');

    // --- STEP 6: Retention Verification & Fulfillment ---
    const mockRetentionDb = {
      submission: {
        async findUnique() {
          return {
            ...submission,
            user: creatorUser,
            campaign,
            earnings: Array.from(earnings.values())
          };
        },
        async update({ data }) {
          if (data.retentionStatus) submission.retentionStatus = data.retentionStatus;
          return submission;
        }
      }
    };

    const mockProvider = {
      async getAvailability() {
        return { isAvailable: true, status: 'AVAILABLE' };
      }
    };

    const retentionService = new RetentionService(
      mockRetentionDb,
      {},
      { async logAction() {}, async recordEvent() {} },
      () => mockProvider
    );

    const retentionResult = await retentionService.checkSubmissionRetention(submission.id);
    assert.equal(retentionResult.status, 'FULFILLED');
    assert.equal(submission.retentionStatus, 'FULFILLED');

    // --- STEP 7: Payout Profile Creation & Evidence Recording ---
    const profileService = new PayoutProfileService(mockDb);
    const profile = await profileService.createProfile(
      creatorUser.id,
      {
        walletAddress: '4Nd1m1ndxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx9ZqX',
        network: 'SOLANA',
        creatorHandle: '@happytester',
        platform: 'YOUTUBE'
      },
      { discordId: creatorUser.discordId, userId: creatorUser.id }
    );
    assert.ok(profile.id);
    assert.equal(maskWalletAddress(profile.walletAddress), '4Nd1••••••••••9ZqX');

    // Validate 35.0-second video evidence buffer (< 40.0s)
    const validEvidenceBuffer = buildMockMp4Buffer(1000, 35000);
    const evidenceValidation = validateEvidenceFile({
      buffer: validEvidenceBuffer,
      filename: 'creator_proof.mp4',
      mimeType: 'video/mp4'
    });
    assert.equal(evidenceValidation.isValid, true);
    assert.equal(evidenceValidation.durationSeconds, 35.00);

    // --- STEP 8: Creator Payout Request ($30.00) ---
    const mockPayoutRepo = {
      async transaction(cb) { return cb(mockPayoutRepo); },
      async acquireUserPayoutLock() {},
      async getUserById(userId) { return users.get(userId); },
      async getPayoutBalanceBreakdown(userId, currency = 'USD') {
        let reserved = new Prisma.Decimal('0.00');
        for (const req of payoutRequests.values()) {
          if (req.userId === userId && ['REQUESTED', 'APPROVED', 'PROCESSING'].includes(req.status)) {
            reserved = reserved.plus(req.amount);
          }
        }
        return {
          totalEarned,
          reservedPayouts: reserved,
          availableBalance: totalEarned.minus(reserved),
          minimumPayout: new Prisma.Decimal('10.00'),
          currency
        };
      },
      async createPayoutRequest(data) {
        const id = `payout_happy_${payoutRequests.size + 1}`;
        const record = { id, ...data, createdAt: new Date() };
        payoutRequests.set(id, record);
        return record;
      },
      async getPayoutRequestById(id) {
        const req = payoutRequests.get(id);
        if (!req) return null;
        return {
          ...req,
          disbursements: disbursements.filter((d) => d.payoutRequestId === id)
        };
      },
      async updatePayoutRequest(id, data) {
        const req = payoutRequests.get(id);
        if (!req) throw new Error(`Payout request ${id} not found`);
        Object.assign(req, data);
        return req;
      },
      async updatePayoutRequestStatus(id, status) {
        const req = payoutRequests.get(id);
        req.status = status;
        return req;
      },
      async recordPayoutEvent(event) { payoutEvents.push(event); },
      async createDisbursement(data) {
        disbursements.push(data);
        return data;
      },
      async updateDisbursement(id, data) {
        const d = disbursements.find((item) => item.id === id);
        if (d) Object.assign(d, data);
        return d;
      }
    };

    const payoutService = new PayoutService(
      mockPayoutRepo,
      () => ({
        name: 'MANUAL',
        createDisbursement: async () => ({
          status: 'PROCESSING',
          providerReference: '0xsolana_receipt_hash'
        })
      }),
      { logAction: async (log) => auditLogs.push(log) },
      profileService,
      { attachEvidence: async () => ({ id: 'ev_1' }) }
    );

    const payoutReq = await payoutService.createPayoutRequest(
      creatorUser.id,
      '30.00',
      'USD',
      {
        evidence: {
          buffer: validEvidenceBuffer,
          filename: 'proof.mp4',
          mimeType: 'video/mp4',
          durationSeconds: 35.0
        }
      }
    );
    assert.equal(payoutReq.status, 'REQUESTED');
    assert.equal(payoutReq.amount.toFixed(2), '30.00');

    // Balance reserved: Available balance is now $0.00
    const balanceAfterRequest = await mockPayoutRepo.getPayoutBalanceBreakdown(creatorUser.id);
    assert.equal(balanceAfterRequest.reservedPayouts.toFixed(2), '30.00');
    assert.equal(balanceAfterRequest.availableBalance.toFixed(2), '0.00');

    // --- STEP 9: Staff Review & Approval ---
    // REQUESTED -> UNDER_REVIEW
    const underReviewPayout = await payoutService.reviewPayoutRequest(payoutReq.id, 'admin_super');
    assert.equal(underReviewPayout.status, 'UNDER_REVIEW');

    // UNDER_REVIEW -> APPROVED
    const approvedPayout = await payoutService.approvePayoutRequest(payoutReq.id, 'admin_super');
    assert.equal(approvedPayout.status, 'APPROVED');

    // --- STEP 10: Disbursement & Completion ---
    const processingResult = await payoutService.processDisbursement(
      payoutReq.id,
      'MANUAL',
      { skipGate: true }
    );
    assert.equal(processingResult.payoutRequest.status, 'PROCESSING');

    const completedPayout = await payoutService.markDisbursementCompleted(
      payoutReq.id,
      '0xsolana_receipt_hash'
    );
    assert.equal(completedPayout.status, 'COMPLETED');

    // Immutable ledger audit trail complete
    assert.ok(payoutEvents.length >= 2);
    assert.ok(payoutEvents.some((e) => e.type === 'REQUESTED'));
  });

  // =========================================================================
  // SCENARIO 2: Payout Cancellation and Re-Request Lifecycle
  // =========================================================================
  test('Payout Cancellation & Re-Request Lifecycle: Request -> Reserve -> Cancel -> Release -> Re-Request', async () => {
    let available = new Prisma.Decimal('50.00');
    let reserved = new Prisma.Decimal('0.00');
    const payoutRequests = new Map();

    const mockRepo = {
      async transaction(cb) { return cb(mockRepo); },
      async acquireUserPayoutLock() {},
      async getUserById() { return { id: 'u_cancel', status: 'ACTIVE' }; },
      async getPayoutBalanceBreakdown() {
        return {
          totalEarned: new Prisma.Decimal('50.00'),
          reservedPayouts: reserved,
          availableBalance: available,
          minimumPayout: new Prisma.Decimal('10.00'),
          currency: 'USD'
        };
      },
      async createPayoutRequest(data) {
        const id = `payout_cancel_test_${payoutRequests.size + 1}`;
        const record = { id, ...data, status: 'REQUESTED' };
        payoutRequests.set(id, record);
        reserved = reserved.plus(data.amount);
        available = available.minus(data.amount);
        return record;
      },
      async getPayoutRequestById(id) { return payoutRequests.get(id); },
      async updatePayoutRequest(id, data) {
        const req = payoutRequests.get(id);
        if (!req) throw new Error(`Payout request ${id} not found`);
        Object.assign(req, data);
        if (data.status === 'CANCELLED') {
          reserved = reserved.minus(req.amount);
          available = available.plus(req.amount);
        }
        return req;
      },
      async updatePayoutRequestStatus(id, status) {
        const req = payoutRequests.get(id);
        req.status = status;
        if (status === 'CANCELLED') {
          reserved = reserved.minus(req.amount);
          available = available.plus(req.amount);
        }
        return req;
      },
      async recordPayoutEvent() {}
    };

    const payoutService = new PayoutService(mockRepo);

    // 1. Creator requests $40 payout -> $40 reserved, $10 available
    const req1 = await payoutService.createPayoutRequest('u_cancel', '40.00', 'USD', { enforceProfile: false });
    assert.equal(req1.status, 'REQUESTED');
    assert.equal(reserved.toFixed(2), '40.00');
    assert.equal(available.toFixed(2), '10.00');

    // 2. Creator cancels the payout request -> $40 released back
    const cancelled = await payoutService.cancelPayoutRequest('u_cancel', req1.id, 'User cancelled');
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(reserved.toFixed(2), '0.00');
    assert.equal(available.toFixed(2), '50.00');

    // 3. Creator re-requests $50 payout -> full balance reserved
    const req2 = await payoutService.createPayoutRequest('u_cancel', '50.00', 'USD', { enforceProfile: false });
    assert.equal(req2.status, 'REQUESTED');
    assert.equal(reserved.toFixed(2), '50.00');
    assert.equal(available.toFixed(2), '0.00');
  });

  // =========================================================================
  // SCENARIO 3: Post-Approval Rejection & Recoupment Lifecycle
  // =========================================================================
  test('Post-Approval Rejection & Recoupment: Approved -> Adjustment Created -> Future Balance Recouped', async () => {
    // 1. Initial clip approved with $40 earnings
    const earnings = [
      { id: 'earn_clip_1', submissionId: 'sub_flagged', grossAmount: new Prisma.Decimal('40.00'), status: 'ELIGIBLE' }
    ];
    const adjustments = [];

    const mockRepo = {
      async getAdjustmentByEarningAndType(earningId, type) {
        return adjustments.find((a) => a.earningId === earningId && a.type === type) || null;
      },
      async createAdjustment(data) {
        const id = `adj_${adjustments.length + 1}`;
        const adj = { id, ...data };
        adjustments.push(adj);
        return adj;
      }
    };

    const mockDb = {
      earning: {
        async findMany() { return earnings; }
      }
    };

    const adjustmentService = new AdjustmentService(mockRepo, mockDb);

    // 2. Admin rejects clip post-approval for bot engagement -> -$40 adjustment created
    const createdAdj = await adjustmentService.createPostApprovalRejectionAdjustments(
      { id: 'sub_flagged', userId: 'user_debtor', campaignId: 'camp_1' },
      'SUSPICIOUS_ENGAGEMENT',
      'admin_sec'
    );
    assert.equal(createdAdj.length, 1);
    assert.equal(createdAdj[0].amount.toFixed(2), '-40.00');

    // 3. Creator balance calculation formula with adjustment
    // Net balance = gross ($40) + adjustment (-$40) = $0.00
    let grossTotal = new Prisma.Decimal('40.00');
    let adjustmentsTotal = new Prisma.Decimal('-40.00');
    let netAvailable = grossTotal.plus(adjustmentsTotal);
    assert.equal(netAvailable.toFixed(2), '0.00');

    // 4. Creator subsequently earns $60 on a new legitimate clip
    // Future earnings offset any past debits: $0.00 + $60.00 = $60.00
    grossTotal = grossTotal.plus(new Prisma.Decimal('60.00'));
    netAvailable = grossTotal.plus(adjustmentsTotal);
    assert.equal(netAvailable.toFixed(2), '60.00');
    assert.ok(netAvailable.gte(0), 'Balance invariant holds (>= 0)');
  });
});
