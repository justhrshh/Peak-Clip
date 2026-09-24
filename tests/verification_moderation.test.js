import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { AdminSubmissionService } from '../src/modules/admin/admin.submission.service.js';
import { VerificationService } from '../src/modules/verification/verification.service.js';
import {
  STRUCTURED_REJECTION_REASONS,
  CREATOR_SAFE_REJECTION_LABELS,
  MODERATION_ACTIONS,
  isValidStructuredReason,
  getCreatorSafeReasonLabel
} from '../src/modules/moderation/moderation.constants.js';
import { MissingRejectionReasonError, AlreadyReviewedError } from '../src/modules/admin/admin.errors.js';

describe('Phase 10D — Verification & Fraud Review Operations', () => {
  const actorStaff = { discordId: 'staff_123', userId: 'user_staff_1' };

  function createTestEnvironment() {
    const submissions = new Map();
    const moderationHistory = [];
    const auditLogs = [];
    const earnings = new Map();
    const adjustments = [];

    const mockRepo = {
      async listSubmissions({ status, campaignId, platform, riskLevel, page = 1, limit = 10 } = {}) {
        let list = Array.from(submissions.values());
        if (status) list = list.filter((s) => s.status === status);
        return {
          items: list.slice((page - 1) * limit, page * limit),
          total: list.length,
          page,
          totalPages: Math.ceil(list.length / limit) || 1
        };
      },
      async listReviewQueue({ campaignId, platform, page = 1, limit = 10 } = {}) {
        const reviewStatuses = ['UNDER_REVIEW', 'POST_APPROVAL_REVIEW', 'FLAGGED'];
        let list = Array.from(submissions.values()).filter((s) => reviewStatuses.includes(s.status));
        if (campaignId) list = list.filter((s) => s.campaignId === campaignId);
        if (platform) list = list.filter((s) => s.platform === platform);
        return {
          items: list.slice((page - 1) * limit, page * limit),
          total: list.length,
          page,
          totalPages: Math.ceil(list.length / limit) || 1
        };
      },
      async getSubmissionWithFullDetails(id) {
        const sub = submissions.get(id);
        if (!sub) return null;
        const subEarnings = Array.from(earnings.values()).filter((e) => e.submissionId === id && e.status === 'ELIGIBLE');
        const subAdjustments = adjustments.filter((a) => a.submissionId === id);
        const subHistory = (sub.moderationHistory && sub.moderationHistory.length > 0)
          ? sub.moderationHistory
          : moderationHistory.filter((h) => h.submissionId === id);
        return {
          ...sub,
          verifications: sub.verifications ? [...sub.verifications] : [],
          snapshots: sub.snapshots ? [...sub.snapshots] : [],
          earnings: subEarnings,
          financialAdjustments: subAdjustments,
          moderationHistory: subHistory
        };
      },
      async updateSubmission(id, data) {
        const sub = submissions.get(id);
        if (!sub) throw new Error('Submission not found');
        const updated = { ...sub, ...data, updatedAt: new Date() };
        submissions.set(id, updated);
        return updated;
      }
    };

    const mockAuditService = {
      async logAction(entry) {
        auditLogs.push(entry);
        return entry;
      }
    };

    const mockModerationRepo = {
      async createHistoryEntry(data) {
        const entry = {
          id: `hist_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          createdAt: new Date(),
          ...data
        };
        moderationHistory.push(entry);
        return entry;
      },
      async getHistoryBySubmissionId(submissionId) {
        return moderationHistory.filter((h) => h.submissionId === submissionId);
      }
    };

    const mockAdjustmentService = {
      async createPostApprovalRejectionAdjustments(submission, reason, actorDiscordId = 'ADMIN') {
        const subEarnings = Array.from(earnings.values()).filter(
          (e) => e.submissionId === submission.id && e.status === 'ELIGIBLE'
        );

        const created = [];
        for (const earning of subEarnings) {
          // Idempotency check: don't duplicate adjustment for same earning
          const exists = adjustments.some(
            (a) => a.earningId === earning.id && a.type === 'POST_APPROVAL_REJECTION'
          );
          if (exists) continue;

          const earningAmount = new Prisma.Decimal(earning.grossAmount);
          const adj = {
            id: `adj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            userId: submission.userId,
            campaignId: submission.campaignId,
            submissionId: submission.id,
            earningId: earning.id,
            type: 'POST_APPROVAL_REJECTION',
            amount: earningAmount.negated(),
            currency: earning.currency || 'USD',
            reason: reason || 'Submission rejected during post-approval moderation review',
            source: 'ADMIN_MODERATION',
            createdAt: new Date()
          };
          adjustments.push(adj);
          created.push(adj);
        }
        return created;
      }
    };

    const adminService = new AdminSubmissionService(
      mockRepo,
      mockAuditService,
      mockModerationRepo,
      mockAdjustmentService
    );

    return {
      submissions,
      moderationHistory,
      auditLogs,
      earnings,
      adjustments,
      adminService
    };
  }

  // --------------------------------------------------------------------------
  // 1. Structured Rejection Reasons & Safe Labels
  // --------------------------------------------------------------------------
  describe('Structured Rejection Reasons & Creator Privacy Rules', () => {
    test('all structured rejection reasons have corresponding creator-safe labels', () => {
      for (const [key, value] of Object.entries(STRUCTURED_REJECTION_REASONS)) {
        assert.ok(isValidStructuredReason(value), `${value} should be recognized as valid`);
        const label = getCreatorSafeReasonLabel(value);
        assert.ok(label && typeof label === 'string', `${value} must have a non-empty human-readable label`);
        // Internal diagnostic keywords must not be present in creator-safe labels
        assert.ok(!label.includes('risk score'), 'Creator label must not leak risk score');
        assert.ok(!label.includes('signal weight'), 'Creator label must not leak signal weight');
        assert.ok(!label.includes('threshold'), 'Creator label must not leak fraud threshold');
      }
    });

    test('getSubmissionDetails redacts risk score, signals, and evidence for non-staff viewers', async () => {
      const env = createTestEnvironment();
      env.submissions.set('sub_secret', {
        id: 'sub_secret',
        status: 'UNDER_REVIEW',
        verifications: [
          {
            id: 'v1',
            status: 'COMPLETED',
            riskLevel: 'HIGH_RISK',
            score: 0.85,
            signals: [{ type: 'METRIC_INCONSISTENCY', severity: 'HIGH', explanation: 'Views jumped suspiciously' }]
          }
        ],
        moderationHistory: [
          {
            id: 'h1',
            action: 'SENT_TO_REVIEW',
            actorDiscordId: 'staff_999',
            actorType: 'STAFF',
            evidence: { rawViews: 50000 },
            reason: 'SUSPICIOUS_ENGAGEMENT',
            notes: 'High velocity anomaly detected'
          }
        ]
      });

      // Creator / non-staff view
      const creatorView = await env.adminService.getSubmissionDetails('sub_secret', { isStaff: false });
      assert.equal(creatorView.verifications[0].score, undefined, 'Score must be redacted');
      assert.equal(creatorView.verifications[0].riskLevel, undefined, 'RiskLevel must be redacted');
      assert.equal(creatorView.verifications[0].signals, undefined, 'Signals must be redacted');
      assert.equal(creatorView.moderationHistory[0].actorDiscordId, undefined, 'Staff ID must be redacted');
      assert.equal(creatorView.moderationHistory[0].evidence, undefined, 'Evidence must be redacted');
      assert.equal(creatorView.moderationHistory[0].reason, 'Suspicious Engagement', 'Reason converted to safe label');

      // Staff view retains all data
      const staffView = await env.adminService.getSubmissionDetails('sub_secret', { isStaff: true });
      assert.equal(staffView.verifications[0].score, 0.85);
      assert.equal(staffView.verifications[0].riskLevel, 'HIGH_RISK');
      assert.equal(staffView.verifications[0].signals.length, 1);
      assert.equal(staffView.moderationHistory[0].actorDiscordId, 'staff_999');
    });
  });

  // --------------------------------------------------------------------------
  // 2. Review Queue Management
  // --------------------------------------------------------------------------
  describe('Review Queue Querying', () => {
    test('listReviewQueue returns only UNDER_REVIEW, POST_APPROVAL_REVIEW, and FLAGGED items', async () => {
      const env = createTestEnvironment();
      env.submissions.set('s1', { id: 's1', status: 'APPROVED' });
      env.submissions.set('s2', { id: 's2', status: 'UNDER_REVIEW', campaignId: 'cmp1', platform: 'YOUTUBE' });
      env.submissions.set('s3', { id: 's3', status: 'REJECTED' });
      env.submissions.set('s4', { id: 's4', status: 'POST_APPROVAL_REVIEW', campaignId: 'cmp1', platform: 'YOUTUBE' });
      env.submissions.set('s5', { id: 's5', status: 'FLAGGED', campaignId: 'cmp2', platform: 'TIKTOK' });
      env.submissions.set('s6', { id: 's6', status: 'PENDING_VERIFICATION' });

      const queue = await env.adminService.listReviewQueue();
      assert.equal(queue.total, 3);
      const queueIds = queue.items.map((i) => i.id);
      assert.ok(queueIds.includes('s2'));
      assert.ok(queueIds.includes('s4'));
      assert.ok(queueIds.includes('s5'));
      assert.ok(!queueIds.includes('s1'));
      assert.ok(!queueIds.includes('s3'));
      assert.ok(!queueIds.includes('s6'));

      // Filter by campaign
      const filtered = await env.adminService.listReviewQueue({ campaignId: 'cmp1' });
      assert.equal(filtered.total, 2);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Manual Approval Operations
  // --------------------------------------------------------------------------
  describe('Manual Approval & Post-Approval Restoration', () => {
    test('manually approving an UNDER_REVIEW submission sets APPROVED and records ADMIN_APPROVED history', async () => {
      const env = createTestEnvironment();
      env.submissions.set('sub_review_1', {
        id: 'sub_review_1',
        status: 'UNDER_REVIEW',
        retentionRequired: true,
        retentionDays: 14
      });

      const approved = await env.adminService.approveSubmission('sub_review_1', actorStaff, 'Verified creator authenticity');
      assert.equal(approved.status, 'APPROVED');
      assert.equal(approved.retentionStatus, 'ACTIVE');
      assert.ok(approved.retentionDeadline);

      // Check moderation history
      const history = env.moderationHistory.find((h) => h.submissionId === 'sub_review_1');
      assert.ok(history);
      assert.equal(history.action, MODERATION_ACTIONS.ADMIN_APPROVED);
      assert.equal(history.previousStatus, 'UNDER_REVIEW');
      assert.equal(history.newStatus, 'APPROVED');
      assert.equal(history.actorDiscordId, actorStaff.discordId);
      assert.equal(history.notes, 'Verified creator authenticity');

      // Check audit log
      const audit = env.auditLogs.find((a) => a.entityId === 'sub_review_1');
      assert.ok(audit);
      assert.equal(audit.action, 'SUBMISSION_APPROVE');
    });

    test('approving a submission currently in POST_APPROVAL_REVIEW records POST_APPROVAL_RESTORED', async () => {
      const env = createTestEnvironment();
      env.submissions.set('sub_post_rev', {
        id: 'sub_post_rev',
        status: 'POST_APPROVAL_REVIEW',
        retentionRequired: false
      });

      const restored = await env.adminService.approveSubmission('sub_post_rev', actorStaff, 'Audit cleared: no fraud detected');
      assert.equal(restored.status, 'APPROVED');

      const history = env.moderationHistory.find((h) => h.submissionId === 'sub_post_rev');
      assert.ok(history);
      assert.equal(history.action, MODERATION_ACTIONS.POST_APPROVAL_RESTORED);
      assert.equal(history.previousStatus, 'POST_APPROVAL_REVIEW');
      assert.equal(history.newStatus, 'APPROVED');
    });

    test('attempting to approve an already APPROVED submission throws AlreadyReviewedError', async () => {
      const env = createTestEnvironment();
      env.submissions.set('sub_already_app', { id: 'sub_already_app', status: 'APPROVED' });

      await assert.rejects(
        () => env.adminService.approveSubmission('sub_already_app', actorStaff),
        AlreadyReviewedError
      );
    });
  });

  // --------------------------------------------------------------------------
  // 4. Manual Rejection & Structured Reasons
  // --------------------------------------------------------------------------
  describe('Manual Rejection with Structured Reasons', () => {
    test('rejecting requires a valid structured reason and records ADMIN_REJECTED history', async () => {
      const env = createTestEnvironment();
      env.submissions.set('sub_rej_target', {
        id: 'sub_rej_target',
        status: 'UNDER_REVIEW',
        userId: 'usr_creator',
        campaignId: 'cmp_test',
        user: { discordId: 'creator_111' },
        campaign: { name: 'Test Campaign' }
      });

      // Rejecting without valid reason throws MissingRejectionReasonError
      await assert.rejects(
        () => env.adminService.rejectSubmission('sub_rej_target', actorStaff, ''),
        MissingRejectionReasonError
      );

      // Rejection with structured reason succeeds
      const result = await env.adminService.rejectSubmission('sub_rej_target', actorStaff, {
        structuredReason: STRUCTURED_REJECTION_REASONS.SUSPICIOUS_ENGAGEMENT,
        notes: 'Spike of 20,000 views in 2 minutes without corresponding engagement'
      });

      assert.equal(result.status, 'REJECTED');
      assert.equal(result.structuredReason, STRUCTURED_REJECTION_REASONS.SUSPICIOUS_ENGAGEMENT);
      assert.equal(result.moderationNotes, 'Spike of 20,000 views in 2 minutes without corresponding engagement');

      const history = env.moderationHistory.find((h) => h.submissionId === 'sub_rej_target');
      assert.ok(history);
      assert.equal(history.action, MODERATION_ACTIONS.ADMIN_REJECTED);
      assert.equal(history.reason, STRUCTURED_REJECTION_REASONS.SUSPICIOUS_ENGAGEMENT);
      assert.equal(history.notes, 'Spike of 20,000 views in 2 minutes without corresponding engagement');

      const audit = env.auditLogs.find((a) => a.entityId === 'sub_rej_target');
      assert.ok(audit);
      assert.equal(audit.action, 'SUBMISSION_REJECT');
    });
  });

  // --------------------------------------------------------------------------
  // 5. Post-Approval Review & Fraud Rejection (Phase 10D Financial Invariant)
  // --------------------------------------------------------------------------
  describe('Post-Approval Review & Financial Adjustment Generation', () => {
    test('startPostApprovalReview transitions APPROVED submission to POST_APPROVAL_REVIEW', async () => {
      const env = createTestEnvironment();
      env.submissions.set('sub_approved_clip', {
        id: 'sub_approved_clip',
        status: 'APPROVED',
        userId: 'creator_1',
        campaignId: 'cmp_1'
      });

      const updated = await env.adminService.startPostApprovalReview('sub_approved_clip', actorStaff, {
        reason: 'Client flagged abnormal retention dropoff',
        notes: 'Investigating traffic sources'
      });

      assert.equal(updated.status, 'POST_APPROVAL_REVIEW');

      const history = env.moderationHistory.find((h) => h.submissionId === 'sub_approved_clip');
      assert.ok(history);
      assert.equal(history.action, MODERATION_ACTIONS.POST_APPROVAL_REVIEW_STARTED);
      assert.equal(history.previousStatus, 'APPROVED');
      assert.equal(history.newStatus, 'POST_APPROVAL_REVIEW');
    });

    test('rejectPostApproval transitions to REJECTED, creates negative financial adjustment, and preserves earnings ledger', async () => {
      const env = createTestEnvironment();
      const submissionId = 'sub_fraud_clip';
      const userId = 'creator_fraud';
      const campaignId = 'cmp_marketing';

      env.submissions.set(submissionId, {
        id: submissionId,
        status: 'APPROVED',
        userId,
        campaignId,
        user: { discordId: 'creator_discord_1' },
        campaign: { name: 'Marketing Blitz' }
      });

      // Create an existing eligible earning record for this submission
      const originalEarning = {
        id: 'earn_original_1',
        submissionId,
        userId,
        campaignId,
        grossAmount: new Prisma.Decimal('75.00'),
        netAmount: new Prisma.Decimal('75.00'),
        currency: 'USD',
        status: 'ELIGIBLE',
        createdAt: new Date('2026-09-20T10:00:00Z')
      };
      env.earnings.set(originalEarning.id, originalEarning);

      // Perform post-approval rejection
      const { submission, adjustments } = await env.adminService.rejectPostApproval(submissionId, actorStaff, {
        structuredReason: STRUCTURED_REJECTION_REASONS.INVALID_MANIPULATED_METRICS,
        notes: 'Artificial view farm traffic confirmed by telemetry'
      });

      // 1. Submission status is updated to REJECTED
      assert.equal(submission.status, 'REJECTED');
      assert.equal(submission.structuredReason, STRUCTURED_REJECTION_REASONS.INVALID_MANIPULATED_METRICS);

      // 2. Original earning row is PRESERVED INTACT (NOT modified, NOT deleted)
      const persistedEarning = env.earnings.get(originalEarning.id);
      assert.ok(persistedEarning, 'Original earning must still exist');
      assert.equal(persistedEarning.grossAmount.toString(), '75', 'Original gross amount must not be altered');
      assert.equal(persistedEarning.status, 'ELIGIBLE', 'Original earning row status must remain unchanged');

      // 3. Negative financial adjustment is generated
      assert.equal(adjustments.length, 1);
      const adj = adjustments[0];
      assert.equal(adj.type, 'POST_APPROVAL_REJECTION');
      assert.equal(adj.submissionId, submissionId);
      assert.equal(adj.earningId, originalEarning.id);
      assert.equal(adj.amount.toString(), '-75', 'Adjustment amount must be exact negative of earning amount');

      // 4. Moderation history recorded
      const history = env.moderationHistory.find(
        (h) => h.submissionId === submissionId && h.action === MODERATION_ACTIONS.POST_APPROVAL_REJECTED
      );
      assert.ok(history, 'POST_APPROVAL_REJECTED history must be created');
      assert.equal(history.previousStatus, 'APPROVED');
      assert.equal(history.newStatus, 'REJECTED');
      assert.equal(history.reason, STRUCTURED_REJECTION_REASONS.INVALID_MANIPULATED_METRICS);

      // 5. Audit log recorded
      const audit = env.auditLogs.find((a) => a.action === 'SUBMISSION_POST_APPROVAL_REJECT');
      assert.ok(audit, 'SUBMISSION_POST_APPROVAL_REJECT audit event must be logged');

      // 6. Idempotency test: repeated rejection does not produce duplicate financial adjustments
      const repeatRun = await env.adminService.rejectPostApproval(submissionId, actorStaff, {
        structuredReason: STRUCTURED_REJECTION_REASONS.INVALID_MANIPULATED_METRICS,
        notes: 'Repeated rejection call'
      }).catch((e) => e);
      // It either throws because already rejected or returns empty adjustments
      assert.equal(env.adjustments.length, 1, 'No duplicate adjustments created on repeated execution');
    });

    test('rejectSubmission on an already APPROVED submission routes cleanly to post-approval rejection', async () => {
      const env = createTestEnvironment();
      const submissionId = 'sub_direct_route';
      env.submissions.set(submissionId, {
        id: submissionId,
        status: 'APPROVED',
        userId: 'user_x',
        campaignId: 'cmp_y'
      });

      env.earnings.set('earn_2', {
        id: 'earn_2',
        submissionId,
        userId: 'user_x',
        campaignId: 'cmp_y',
        grossAmount: new Prisma.Decimal('30.00'),
        currency: 'USD',
        status: 'ELIGIBLE'
      });

      const res = await env.adminService.rejectSubmission(submissionId, actorStaff, {
        structuredReason: STRUCTURED_REJECTION_REASONS.CONTENT_VIOLATION,
        notes: 'Contains prohibited brand trademark'
      });

      assert.equal(res.submission.status, 'REJECTED');
      assert.equal(res.adjustments.length, 1);
      assert.equal(res.adjustments[0].amount.toString(), '-30');
    });
  });

  // --------------------------------------------------------------------------
  // 6. Automated Verification Pipeline Integration
  // --------------------------------------------------------------------------
  describe('Verification Service Moderation Trail', () => {
    test('runVerification records AUTO_APPROVED when risk is clean and approved', async () => {
      const historyRecorded = [];
      const mockModerationRepo = {
        async createHistoryEntry(entry) {
          historyRecorded.push(entry);
          return entry;
        }
      };

      const mockSub = {
        id: 'sub_pipeline_clean',
        platform: 'YOUTUBE',
        url: 'https://youtube.com/watch?v=clean123456',
        status: 'PENDING_VERIFICATION',
        retentionRequired: false
      };

      const mockSubRepo = {
        async getSubmissionById() { return mockSub; },
        async updateSubmission(id, data) { Object.assign(mockSub, data); return mockSub; }
      };

      const mockVerRepo = {
        async getVerificationBySubmissionId() { return null; },
        async upsertVerification(data) { return { id: 'v_clean', ...data }; },
        async getHistoricalSnapshots() { return []; },
        async createMetricSnapshot(data) { return { id: 'snap_clean', ...data }; },
        async addVerificationSignals() {}
      };

      const mockProvider = {
        getCurrentMetrics: async () => ({
          status: 'AVAILABLE',
          views: 1200n,
          likes: 50n,
          comments: 10n,
          shares: null,
          durationSeconds: 45
        })
      };

      const verService = new VerificationService(
        mockVerRepo,
        mockSubRepo,
        () => mockProvider,
        undefined,
        undefined,
        mockModerationRepo
      );

      const result = await verService.runVerification('sub_pipeline_clean');
      assert.equal(result.submissionStatus, 'APPROVED');

      const hist = historyRecorded.find((h) => h.action === MODERATION_ACTIONS.AUTO_APPROVED);
      assert.ok(hist, 'AUTO_APPROVED history must be recorded');
      assert.equal(hist.newStatus, 'APPROVED');
      assert.equal(hist.actorDiscordId, 'SYSTEM');
    });

    test('runVerification records AUTO_REJECTED when clip duration violates campaign requirements', async () => {
      const historyRecorded = [];
      const mockModerationRepo = {
        async createHistoryEntry(entry) {
          historyRecorded.push(entry);
          return entry;
        }
      };

      const mockSub = {
        id: 'sub_too_short',
        platform: 'YOUTUBE',
        url: 'https://youtube.com/watch?v=short123456',
        status: 'PENDING_VERIFICATION',
        campaign: { minClipDurationSeconds: 15, maxClipDurationSeconds: 60 }
      };

      const mockSubRepo = {
        async getSubmissionById() { return mockSub; },
        async updateSubmission(id, data) { Object.assign(mockSub, data); return mockSub; }
      };

      const mockVerRepo = {
        async getVerificationBySubmissionId() { return null; },
        async upsertVerification(data) { return { id: 'v_short', ...data }; }
      };

      const mockProvider = {
        getCurrentMetrics: async () => ({
          status: 'AVAILABLE',
          views: 500n,
          likes: 20n,
          comments: 2n,
          shares: null,
          durationSeconds: 5 // Too short! (min is 15)
        })
      };

      const verService = new VerificationService(
        mockVerRepo,
        mockSubRepo,
        () => mockProvider,
        undefined,
        undefined,
        mockModerationRepo
      );

      const result = await verService.runVerification('sub_too_short');
      assert.equal(result.submissionStatus, 'REJECTED');
      assert.equal(mockSub.structuredReason, STRUCTURED_REJECTION_REASONS.CAMPAIGN_REQUIREMENT_VIOLATION);

      const hist = historyRecorded.find((h) => h.action === MODERATION_ACTIONS.AUTO_REJECTED);
      assert.ok(hist, 'AUTO_REJECTED history must be created');
      assert.equal(hist.newStatus, 'REJECTED');
    });
  });
});
