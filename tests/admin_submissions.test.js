import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AdminSubmissionService } from '../src/modules/admin/admin.submission.service.js';
import {
  MissingRejectionReasonError,
  AlreadyReviewedError
} from '../src/modules/admin/admin.errors.js';
import { SubmissionNotFoundError } from '../src/modules/submissions/submission.errors.js';

function createMockSubmissionEnvironment() {
  const submissions = new Map();
  const auditEvents = [];

  const repo = {
    async listSubmissions({ status, campaignId, platform, riskLevel, page = 1, limit = 10 } = {}) {
      let list = Array.from(submissions.values());
      if (status) list = list.filter((s) => s.status === status);
      if (campaignId) list = list.filter((s) => s.campaignId === campaignId);
      if (platform) list = list.filter((s) => s.platform === platform);
      if (riskLevel) list = list.filter((s) => s.verifications.some((v) => v.riskLevel === riskLevel));

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
      return {
        ...sub,
        verifications: [...(sub.verifications || [])],
        snapshots: [...(sub.snapshots || [])]
      };
    },
    async updateSubmission(id, data) {
      const sub = submissions.get(id);
      if (!sub) throw new Error('Not found');
      const updated = { ...sub, ...data, updatedAt: new Date() };
      submissions.set(id, updated);
      return updated;
    }
  };

  const auditService = {
    async logAction(event) {
      auditEvents.push(event);
      return event;
    }
  };

  const service = new AdminSubmissionService(repo, auditService);

  return {
    submissions,
    auditEvents,
    service
  };
}

describe('Admin Submission Review Queue & Moderation', () => {
  const actor = { discordId: 'staff_mod_1', userId: 'usr_mod' };

  test('lists submissions with pagination and filters by status and risk level', async () => {
    const env = createMockSubmissionEnvironment();

    env.submissions.set('sub1', {
      id: 'sub1',
      status: 'UNDER_REVIEW',
      campaignId: 'c1',
      platform: 'YOUTUBE',
      verifications: [{ riskLevel: 'REVIEW_REQUIRED', score: 0.45 }],
      snapshots: [{ views: 50000n }]
    });

    env.submissions.set('sub2', {
      id: 'sub2',
      status: 'APPROVED',
      campaignId: 'c1',
      platform: 'YOUTUBE',
      verifications: [{ riskLevel: 'LOW_RISK', score: 0.05 }],
      snapshots: [{ views: 10000n }]
    });

    // Filter by UNDER_REVIEW
    const listReview = await env.service.listSubmissions({ status: 'UNDER_REVIEW' });
    assert.equal(listReview.total, 1);
    assert.equal(listReview.items[0].id, 'sub1');

    // Filter by riskLevel REVIEW_REQUIRED
    const listRisk = await env.service.listSubmissions({ riskLevel: 'REVIEW_REQUIRED' });
    assert.equal(listRisk.total, 1);
    assert.equal(listRisk.items[0].id, 'sub1');
  });

  test('enforces creator privacy by redacting internal risk signals when isStaff is false', async () => {
    const env = createMockSubmissionEnvironment();

    env.submissions.set('sub_priv', {
      id: 'sub_priv',
      status: 'UNDER_REVIEW',
      campaignId: 'c1',
      platform: 'YOUTUBE',
      verifications: [
        {
          id: 'v1',
          status: 'COMPLETED',
          riskLevel: 'HIGH_RISK',
          score: 0.85,
          completedAt: new Date(),
          signals: [
            { type: 'METRIC_INCONSISTENCY', severity: 'HIGH', explanation: 'Sudden drop in views' }
          ]
        }
      ],
      snapshots: []
    });

    // Staff view: full details including risk and signals
    const staffView = await env.service.getSubmissionDetails('sub_priv', { isStaff: true });
    assert.equal(staffView.verifications[0].riskLevel, 'HIGH_RISK');
    assert.equal(staffView.verifications[0].score, 0.85);
    assert.equal(staffView.verifications[0].signals.length, 1);

    // Creator / non-staff view: redacted
    const creatorView = await env.service.getSubmissionDetails('sub_priv', { isStaff: false });
    assert.equal(creatorView.verifications[0].riskLevel, undefined);
    assert.equal(creatorView.verifications[0].score, undefined);
    assert.equal(creatorView.verifications[0].signals, undefined);
  });

  test('manual approval transitions to APPROVED and prevents duplicate approval', async () => {
    const env = createMockSubmissionEnvironment();

    env.submissions.set('sub_app', {
      id: 'sub_app',
      status: 'UNDER_REVIEW',
      verifications: [],
      snapshots: []
    });

    const approved = await env.service.approveSubmission('sub_app', actor, 'Clean creator review');
    assert.equal(approved.status, 'APPROVED');
    assert.ok(approved.verifiedAt);

    // Audit event recorded
    const auditApprove = env.auditEvents.find((e) => e.action === 'SUBMISSION_APPROVE');
    assert.ok(auditApprove);
    assert.equal(auditApprove.entityId, 'sub_app');
    assert.equal(auditApprove.reason, 'Clean creator review');

    // Attempting to approve again throws AlreadyReviewedError
    await assert.rejects(
      () => env.service.approveSubmission('sub_app', actor),
      AlreadyReviewedError
    );
  });

  test('manual rejection strictly requires a non-empty reason and preserves data', async () => {
    const env = createMockSubmissionEnvironment();

    env.submissions.set('sub_rej', {
      id: 'sub_rej',
      status: 'UNDER_REVIEW',
      verifications: [{ id: 'v1', status: 'COMPLETED' }],
      snapshots: [{ id: 'snap1', views: 5000n }]
    });

    // Empty reason throws MissingRejectionReasonError
    await assert.rejects(
      () => env.service.rejectSubmission('sub_rej', actor, ''),
      MissingRejectionReasonError
    );

    // Valid rejection succeeds
    const rejected = await env.service.rejectSubmission(
      'sub_rej',
      actor,
      'Video contains unauthorized copyrighted background audio'
    );
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.rejectionReason, 'Video contains unauthorized copyrighted background audio');

    // Audit event recorded
    const auditRej = env.auditEvents.find((e) => e.action === 'SUBMISSION_REJECT');
    assert.ok(auditRej);
    assert.equal(auditRej.entityId, 'sub_rej');

    // Verify historical snapshots and verifications are preserved
    const subRecord = env.submissions.get('sub_rej');
    assert.equal(subRecord.verifications.length, 1);
    assert.equal(subRecord.snapshots.length, 1);
  });

  test('flagging and placing under review updates status and logs audit', async () => {
    const env = createMockSubmissionEnvironment();

    env.submissions.set('sub_flag', {
      id: 'sub_flag',
      status: 'PENDING_VERIFICATION',
      verifications: [],
      snapshots: []
    });

    const flagged = await env.service.flagOrReviewSubmission(
      'sub_flag',
      'FLAGGED',
      actor,
      'Abnormal velocity surge reported'
    );
    assert.equal(flagged.status, 'FLAGGED');

    const auditFlag = env.auditEvents.find((e) => e.action === 'SUBMISSION_FLAGGED');
    assert.ok(auditFlag);
  });
});
