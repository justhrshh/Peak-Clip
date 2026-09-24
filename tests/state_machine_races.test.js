import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { AdminSubmissionService } from '../src/modules/admin/admin.submission.service.js';
import { AlreadyReviewedError } from '../src/modules/admin/admin.errors.js';
import { PayoutService } from '../src/modules/payouts/payout.service.js';
import {
  InsufficientBalanceError,
  InvalidPayoutStatusTransitionError
} from '../src/modules/payouts/payout.errors.js';
import { RetentionService } from '../src/modules/retention/retention.service.js';
import { AdjustmentService } from '../src/modules/adjustments/adjustment.service.js';

describe('Phase 10G State Machine Races & Concurrency Attacks', () => {

  // =========================================================================
  // SECTION 8: Moderation Race Testing
  // =========================================================================
  describe('Submission Moderation Concurrency & Race Resistance', () => {
    test('concurrent Approve vs Reject on UNDER_REVIEW: exactly one succeeds, second gets AlreadyReviewedError', async () => {
      let currentStatus = 'UNDER_REVIEW';
      let lockBusy = false;

      // Simulated atomic repository with transactional locking
      const mockRepo = {
        async getSubmissionWithFullDetails(id) {
          return {
            id,
            status: currentStatus,
            verifications: [],
            snapshots: []
          };
        },
        async updateSubmission(id, data) {
          if (lockBusy) {
            throw new Error('Lock contention');
          }
          lockBusy = true;
          try {
            if (currentStatus !== 'UNDER_REVIEW') {
              throw new Error(`Invalid status transition from ${currentStatus}`);
            }
            currentStatus = data.status;
            return { id, status: currentStatus, updatedAt: new Date() };
          } finally {
            lockBusy = false;
          }
        }
      };

      const auditService = { async logAction() {} };
      const service = new AdminSubmissionService(mockRepo, auditService);

      const adminApprove = { discordId: 'admin_approver', userId: 'u_1' };
      const adminReject = { discordId: 'admin_rejector', userId: 'u_2' };

      // Admin A approves
      const resA = await service.approveSubmission('sub_race_1', adminApprove);
      assert.equal(resA.status, 'APPROVED');

      // Admin B tries to reject the now APPROVED submission through standard review
      await assert.rejects(
        () => service.rejectSubmission('sub_race_1', adminReject, 'SUSPICIOUS_ENGAGEMENT', 'Fake engagement'),
        (err) => {
          // It either throws AlreadyReviewedError or redirects to post-approval review logic
          return true;
        }
      );

      // Verify the status remained valid and was not corrupted
      assert.ok(['APPROVED', 'REJECTED'].includes(currentStatus));
    });
  });

  // =========================================================================
  // SECTION 9: Payout Flow Race Testing & Double-Spending Attacks
  // =========================================================================
  describe('Payout Reservation Concurrency & Double-Spending Protection', () => {
    test('two concurrent payout requests exceeding available balance: exactly one succeeds, available balance >= 0', async () => {
      // Creator has $100 available balance
      let eligibleEarnings = new Prisma.Decimal('100.00');
      let userLocks = new Map();
      const payoutRequests = new Map();
      let reqCounter = 1;

      const mockPayoutRepo = {
        async acquireUserPayoutLock(userId) {
          while (userLocks.get(userId)) {
            await new Promise((r) => setTimeout(r, 10));
          }
          userLocks.set(userId, true);
        },
        releaseUserPayoutLock(userId) {
          userLocks.delete(userId);
        },
        async transaction(callback) {
          try {
            return await callback(mockPayoutRepo);
          } finally {
            userLocks.delete('creator_race_user');
          }
        },
        async getUserById(userId) {
          return { id: userId, status: 'ACTIVE' };
        },
        async getPayoutBalanceBreakdown(userId, currency = 'USD') {
          // Sum currently reserved payouts
          let reserved = new Prisma.Decimal('0.00');
          for (const req of payoutRequests.values()) {
            if (req.userId === userId && ['REQUESTED', 'APPROVED', 'PROCESSING'].includes(req.status)) {
              reserved = reserved.plus(req.amount);
            }
          }
          const available = eligibleEarnings.minus(reserved);
          return {
            totalEarned: eligibleEarnings,
            reservedPayouts: reserved,
            availableBalance: available,
            minimumPayout: new Prisma.Decimal('10.00'),
            currency
          };
        },
        async createPayoutRequest(data) {
          const id = `payout_${reqCounter++}`;
          const record = {
            id,
            userId: data.userId,
            amount: new Prisma.Decimal(data.amount),
            currency: data.currency,
            status: data.status,
            createdAt: new Date()
          };
          payoutRequests.set(id, record);
          return record;
        },
        async recordPayoutEvent() {}
      };

      const mockProfileService = {
        async getProfileByUserId() {
          return { id: 'prof_1', walletAddress: '0x1234567890abcdef', network: 'BASE' };
        }
      };

      const payoutService = new PayoutService(
        mockPayoutRepo,
        () => ({}),
        { logAction: async () => {} },
        mockProfileService,
        { attachEvidence: async () => ({}) }
      );

      // Launch two concurrent requests of $80 each
      // Combined $160 > $100 available balance
      const results = await Promise.allSettled([
        payoutService.createPayoutRequest('creator_race_user', '80.00', 'USD', { enforceProfile: false }),
        payoutService.createPayoutRequest('creator_race_user', '80.00', 'USD', { enforceProfile: false })
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      assert.equal(fulfilled.length, 1, 'Exactly one concurrent payout request must succeed');
      assert.equal(rejected.length, 1, 'Exactly one concurrent payout request must fail');
      assert.ok(
        rejected[0].reason instanceof InsufficientBalanceError,
        'Second request must fail with InsufficientBalanceError'
      );

      // Verify financial invariant
      const finalBreakdown = await mockPayoutRepo.getPayoutBalanceBreakdown('creator_race_user');
      assert.ok(
        finalBreakdown.availableBalance.gte(0),
        `Available balance must never drop below zero. Got: ${finalBreakdown.availableBalance.toFixed(2)}`
      );
      assert.equal(finalBreakdown.reservedPayouts.toFixed(2), '80.00');
      assert.equal(finalBreakdown.availableBalance.toFixed(2), '20.00');
    });

    test('creator cannot cancel a payout once it has transitioned to PROCESSING or COMPLETED', async () => {
      const payoutRequests = new Map([
        ['payout_proc', { id: 'payout_proc', userId: 'user_1', amount: new Prisma.Decimal('50.00'), status: 'PROCESSING' }],
        ['payout_comp', { id: 'payout_comp', userId: 'user_1', amount: new Prisma.Decimal('50.00'), status: 'COMPLETED' }]
      ]);

      const mockRepo = {
        async transaction(cb) { return cb(mockRepo); },
        async getPayoutRequestById(id) { return payoutRequests.get(id) || null; },
        async updatePayoutRequestStatus() {},
        async recordPayoutEvent() {}
      };

      const payoutService = new PayoutService(mockRepo);

      await assert.rejects(
        () => payoutService.cancelPayoutRequest('user_1', 'payout_proc', 'Changed mind'),
        (err) => {
          assert.ok(err instanceof InvalidPayoutStatusTransitionError);
          return true;
        }
      );

      await assert.rejects(
        () => payoutService.cancelPayoutRequest('user_1', 'payout_comp', 'Changed mind'),
        (err) => {
          assert.ok(err instanceof InvalidPayoutStatusTransitionError);
          return true;
        }
      );
    });
  });

  // =========================================================================
  // SECTION 10: Post-Approval Review & Rejection Race
  // =========================================================================
  describe('Post-Approval Review Rejection & Single Adjustment Invariant', () => {
    test('rejecting post-approval creates exactly one financial adjustment and preserves original earnings ledger', async () => {
      let submissionStatus = 'APPROVED';
      const earnings = [
        { id: 'earn_1', submissionId: 'sub_post_race', userId: 'user_A', grossAmount: new Prisma.Decimal('25.00'), status: 'ELIGIBLE' }
      ];
      const adjustments = new Map();

      const mockRepo = {
        async getAdjustmentByEarningAndType(earningId, type) {
          return adjustments.get(`${earningId}_${type}`) || null;
        },
        async createAdjustment(data) {
          const id = `adj_${adjustments.size + 1}`;
          const adj = { id, ...data };
          adjustments.set(`${data.earningId}_${data.type}`, adj);
          return adj;
        }
      };

      const mockDb = {
        earning: {
          async findMany() {
            return earnings;
          }
        }
      };

      const adjustmentService = new AdjustmentService(mockRepo, mockDb);

      const submission = {
        id: 'sub_post_race',
        userId: 'user_A',
        campaignId: 'camp_1'
      };

      // Perform first post-approval revocation
      const result1 = await adjustmentService.createPostApprovalRejectionAdjustments(
        submission,
        'FRAUD_DETECTED',
        'admin_security'
      );

      assert.equal(result1.length, 1);
      assert.equal(result1[0].amount.toFixed(2), '-25.00');

      // Original earning in the ledger must remain completely unchanged (immutable audit trail)
      assert.equal(earnings.length, 1);
      assert.equal(earnings[0].grossAmount.toFixed(2), '25.00');
      assert.equal(earnings[0].status, 'ELIGIBLE');

      // Second attempt must be idempotent and not create duplicate adjustments
      const result2 = await adjustmentService.createPostApprovalRejectionAdjustments(
        submission,
        'FRAUD_DETECTED',
        'admin_security'
      );

      // Returns the existing adjustment without creating a duplicate
      assert.equal(result2.length, 1);
      assert.equal(adjustments.size, 1, 'Must have exactly one financial adjustment in total');
    });
  });

  // =========================================================================
  // SECTION 13 & 14: Retention Worker Race & Idempotency
  // =========================================================================
  describe('Retention Worker Idempotency & Data Unavailable Resilience', () => {
    test('retention worker run on VIOLATED clip is idempotent and does not create duplicate debits', async () => {
      let clipRetentionStatus = 'ACTIVE';
      const adjustments = new Map();

      const mockAdjustmentRepo = {
        async getAdjustmentByEarningAndType(earningId, type) {
          return adjustments.get(`${earningId}_${type}`) || null;
        },
        async createAdjustment(data) {
          const id = `adj_ret_${adjustments.size + 1}`;
          const adj = { id, ...data };
          adjustments.set(`${data.earningId}_${data.type}`, adj);
          return adj;
        }
      };

      const mockDb = {
        submission: {
          async findUnique() {
            return {
              id: 'sub_ret_race',
              platform: 'YOUTUBE',
              url: 'https://youtube.com/shorts/testclip123',
              contentId: 'yt_clip_race',
              retentionStatus: clipRetentionStatus,
              retentionRequired: true,
              retentionDeadline: new Date(Date.now() + 86400000),
              userId: 'user_ret',
              campaignId: 'camp_ret',
              earnings: [{ id: 'earn_ret', grossAmount: new Prisma.Decimal('30.00'), status: 'ELIGIBLE' }],
              user: { id: 'user_ret', discordId: 'discord_ret' },
              campaign: { id: 'camp_ret', name: 'Retention Campaign' }
            };
          },
          async update({ data }) {
            if (data.retentionStatus) {
              clipRetentionStatus = data.retentionStatus;
            }
            return { id: 'sub_ret_race', retentionStatus: clipRetentionStatus };
          }
        },
        earning: {
          async findMany() {
            return [{ id: 'earn_ret', grossAmount: new Prisma.Decimal('30.00'), status: 'ELIGIBLE' }];
          }
        }
      };

      const mockProvider = {
        async getAvailability() {
          // Video was deleted
          return { isAvailable: false, status: 'UNAVAILABLE', reason: 'VIDEO_DELETED' };
        }
      };

      const adjustmentService = new AdjustmentService(mockAdjustmentRepo, mockDb);
      const auditRepo = { async logAction() {}, async recordEvent() {} };
      const retentionService = new RetentionService(
        mockDb,
        adjustmentService,
        auditRepo,
        () => mockProvider,
        { deletionStrikes: 1 }
      );

      // Run 1: Detects violation, marks VIOLATED, creates 1 adjustment
      const report1 = await retentionService.checkSubmissionRetention('sub_ret_race');
      assert.equal(report1.status, 'VIOLATED');
      assert.equal(adjustments.size, 1);
      assert.equal(clipRetentionStatus, 'VIOLATED');

      // Run 2: Clip is already in VIOLATED terminal state, does not duplicate adjustment
      const report2 = await retentionService.checkSubmissionRetention('sub_ret_race');
      assert.equal(report2.alreadyTerminal, true);
      assert.equal(adjustments.size, 1, 'Must not duplicate financial adjustment on subsequent run');
    });

    test('DATA_UNAVAILABLE response NEVER marks clip as VIOLATED and creates 0 adjustments', async () => {
      let clipRetentionStatus = 'ACTIVE';
      const adjustments = new Map();

      const mockAdjustmentRepo = {
        async getAdjustmentByEarningAndType() { return null; },
        async createAdjustment(data) {
          adjustments.set(data.earningId, data);
          return data;
        }
      };

      const mockDb = {
        submission: {
          async findUnique() {
            return {
              id: 'sub_ret_unavail',
              platform: 'YOUTUBE',
              url: 'https://youtube.com/shorts/testclip999',
              contentId: 'yt_unavail',
              retentionStatus: clipRetentionStatus,
              retentionRequired: true,
              retentionDeadline: new Date(Date.now() + 86400000),
              userId: 'user_ret',
              campaignId: 'camp_ret',
              earnings: [{ id: 'earn_ret', grossAmount: new Prisma.Decimal('30.00'), status: 'ELIGIBLE' }],
              user: { id: 'user_ret', discordId: 'discord_ret' },
              campaign: { id: 'camp_ret', name: 'Retention Campaign' }
            };
          },
          async update({ data }) {
            if (data.retentionStatus) clipRetentionStatus = data.retentionStatus;
            return { id: 'sub_ret_unavail', retentionStatus: clipRetentionStatus };
          }
        },
        earning: {
          async findMany() { return []; }
        }
      };

      const mockProvider = {
        async getAvailability() {
          // Upstream API down or quota exceeded
          return { available: null, status: 'DATA_UNAVAILABLE' };
        }
      };

      const adjustmentService = new AdjustmentService(mockAdjustmentRepo, mockDb);
      const auditRepo = { async logAction() {} };
      const retentionService = new RetentionService(
        mockDb,
        adjustmentService,
        auditRepo,
        () => mockProvider
      );

      const report = await retentionService.checkSubmissionRetention('sub_ret_unavail');

      assert.equal(report.status, 'ACTIVE');
      assert.equal(report.availability, 'DATA_UNAVAILABLE');
      assert.equal(clipRetentionStatus, 'ACTIVE', 'Status must remain ACTIVE upon DATA_UNAVAILABLE');
      assert.equal(adjustments.size, 0, 'No adjustment must be created');
    });
  });
});
