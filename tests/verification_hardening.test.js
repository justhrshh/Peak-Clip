import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VERIFICATION_POLICY,
  resolveVerificationPolicy
} from '../src/modules/verification/policy.js';
import {
  calculateRatio,
  calculateEngagementRatios,
  analyzeMetricSignals
} from '../src/modules/verification/analyzer.js';
import { assessVerificationRisk } from '../src/modules/verification/risk.assessor.js';
import { ApprovalPolicy } from '../src/modules/verification/approval.policy.js';
import {
  TransientProviderError,
  ConfigurationAuthError,
  PermanentContentError
} from '../src/modules/verification/verification.errors.js';
import { VerificationService } from '../src/modules/verification/verification.service.js';

// In-memory test repository helpers
function createMockVerificationRepo() {
  const verifications = new Map();
  const snapshots = [];
  const signals = [];

  return {
    verifications,
    snapshots,
    signals,
    async createMetricSnapshot(data) {
      const snap = {
        id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        ...data,
        capturedAt: new Date()
      };
      snapshots.push(snap);
      return snap;
    },
    async getHistoricalSnapshots(submissionId) {
      return snapshots
        .filter((s) => s.submissionId === submissionId)
        .sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
    },
    async upsertVerification({ submissionId, status, riskLevel, score, startedAt, completedAt, lastError }) {
      let v = verifications.get(submissionId);
      if (!v) {
        v = {
          id: `ver_${Date.now()}`,
          submissionId,
          status,
          riskLevel: riskLevel || 'LOW_RISK',
          score: score ?? null,
          startedAt: startedAt || new Date(),
          completedAt: completedAt || null,
          lastError: lastError || null,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        verifications.set(submissionId, v);
        return v;
      }
      v.status = status;
      if (riskLevel) v.riskLevel = riskLevel;
      if (score !== undefined) v.score = score;
      if (completedAt) v.completedAt = completedAt;
      v.lastError = lastError;
      v.updatedAt = new Date();
      return v;
    },
    async getVerificationBySubmissionId(submissionId) {
      return verifications.get(submissionId) || null;
    },
    async addVerificationSignals(verificationId, newSignals = []) {
      for (const s of newSignals) {
        signals.push({ id: `sig_${Date.now()}`, verificationId, ...s });
      }
      return newSignals;
    }
  };
}

function createMockSubmissionRepo() {
  const submissions = new Map();

  return {
    submissions,
    async getSubmissionById(id) {
      return submissions.get(id) || null;
    },
    async updateSubmissionStatus(id, status, details = {}) {
      const sub = submissions.get(id);
      if (sub) {
        sub.status = status;
        if (details.verifiedAt !== undefined) sub.verifiedAt = details.verifiedAt;
        if (details.rejectionReason !== undefined) sub.rejectionReason = details.rejectionReason;
        sub.updatedAt = new Date();
        return sub;
      }
      return null;
    }
  };
}

describe('Verification Policy & Configurable Thresholds', () => {
  test('policy resolver merges custom thresholds with defaults', () => {
    const custom = resolveVerificationPolicy({
      suddenGrowthMultiplier: 15,
      likeViewRatio: { low: 0.005 }
    });

    assert.equal(custom.suddenGrowthMultiplier, 15);
    assert.equal(custom.likeViewRatio.low, 0.005);
    assert.equal(custom.likeViewRatio.high, DEFAULT_VERIFICATION_POLICY.likeViewRatio.high);
    assert.equal(custom.minimumViewsForRatioAnalysis, DEFAULT_VERIFICATION_POLICY.minimumViewsForRatioAnalysis);
  });

  test('analyzer respects custom policy thresholds', () => {
    // A clip with likeViewRatio = 0.003 (0.3%)
    // Under default policy (low = 0.001), 0.3% is NORMAL (no signal).
    // Under custom strict policy (low = 0.005), 0.3% triggers LIKE_VIEW_RATIO.
    const snapshot = {
      views: 10000n,
      likes: 30n, // 0.3%
      comments: 10n,
      capturedAt: new Date(),
      metadata: { availability: { views: 'AVAILABLE', likes: 'AVAILABLE', comments: 'AVAILABLE' } }
    };

    const defaultSignals = analyzeMetricSignals(snapshot, [], DEFAULT_VERIFICATION_POLICY);
    assert.equal(defaultSignals.some((s) => s.type === 'LIKE_VIEW_RATIO'), false);

    const strictPolicy = resolveVerificationPolicy({ likeViewRatio: { low: 0.005 } });
    const strictSignals = analyzeMetricSignals(snapshot, [], strictPolicy);
    assert.equal(strictSignals.some((s) => s.type === 'LIKE_VIEW_RATIO'), true);
  });

  test('risk assessor respects custom score thresholds', () => {
    const signals = [
      { type: 'SUDDEN_GROWTH', severity: 'MEDIUM', explanation: 'Velocity spike' }
    ];

    // Under default policy, 1 medium signal = 0.20 score -> LOW_RISK
    const defaultAssessment = assessVerificationRisk(signals, DEFAULT_VERIFICATION_POLICY);
    assert.equal(defaultAssessment.riskLevel, 'LOW_RISK');

    // Under strict policy with reviewRequiredScore: 0.15 -> REVIEW_REQUIRED
    const strictPolicy = resolveVerificationPolicy({
      riskThresholds: { reviewRequiredScore: 0.15 }
    });
    const strictAssessment = assessVerificationRisk(signals, strictPolicy);
    assert.equal(strictAssessment.riskLevel, 'REVIEW_REQUIRED');
  });
});

describe('Metric Availability Semantics (0 vs Null)', () => {
  test('metric value 0 is treated as a valid zero count when AVAILABLE', () => {
    const ratios = calculateEngagementRatios({
      views: 5000n,
      likes: 0n,
      comments: 0n,
      shares: null
    });

    assert.equal(ratios.likeViewRatio, 0.0);
    assert.equal(ratios.commentViewRatio, 0.0);
    assert.equal(ratios.shareViewRatio, null); // shares unavailable
    assert.equal(ratios.engagementViewRatio, 0.0);
  });

  test('unavailable metric is treated as null and prevents ratio calculation', () => {
    const ratios = calculateEngagementRatios({
      views: null,
      likes: 100n,
      comments: 10n,
      shares: null
    });

    assert.equal(ratios.likeViewRatio, null);
    assert.equal(ratios.commentViewRatio, null);
    assert.equal(ratios.engagementViewRatio, null);
  });

  test('unavailable denominator does not emit false zero-based signals', () => {
    const unavailableSnapshot = {
      views: null,
      likes: null,
      comments: null,
      metadata: {
        availability: { views: 'UNAVAILABLE', likes: 'UNAVAILABLE', comments: 'UNAVAILABLE' }
      }
    };

    const signals = analyzeMetricSignals(unavailableSnapshot, []);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].type, 'DATA_UNAVAILABLE');
    assert.equal(signals.some((s) => s.type === 'COMMENT_VIEW_RATIO'), false);
    assert.equal(signals.some((s) => s.type === 'LIKE_VIEW_RATIO'), false);
  });
});

describe('Risk Assessment vs Submission Approval Decoupling', () => {
  test('approval policy maps risk levels cleanly without hard-coded conflation', () => {
    const approvalPolicy = new ApprovalPolicy();

    const lowRiskDecision = approvalPolicy.evaluateApprovalDecision({
      riskLevel: 'LOW_RISK',
      primaryReasons: []
    });
    assert.equal(lowRiskDecision.status, 'APPROVED');

    const reviewDecision = approvalPolicy.evaluateApprovalDecision({
      riskLevel: 'REVIEW_REQUIRED',
      primaryReasons: ['Atypical like/view ratio']
    });
    assert.equal(reviewDecision.status, 'UNDER_REVIEW');
    assert.ok(reviewDecision.reason.includes('Atypical'));

    const highRiskDecision = approvalPolicy.evaluateApprovalDecision({
      riskLevel: 'HIGH_RISK',
      primaryReasons: ['Velocity surge + drop in views']
    });
    assert.equal(highRiskDecision.status, 'FLAGGED');
  });

  test('custom approval policy can intercept LOW_RISK to require manual approval', async () => {
    const verRepo = createMockVerificationRepo();
    const subRepo = createMockSubmissionRepo();

    const sub = {
      id: 'sub_manual_approval_needed',
      platform: 'YOUTUBE',
      url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      status: 'PENDING_VERIFICATION'
    };
    subRepo.submissions.set(sub.id, sub);

    const mockProvider = {
      getCurrentMetrics: async () => ({
        isAvailable: true,
        views: 20000n,
        likes: 1000n,
        comments: 50n,
        shares: null,
        status: 'AVAILABLE'
      })
    };

    // Custom Approval Policy: Never auto-approve, hold all submissions for manual disbursement review
    const manualApprovalPolicy = {
      evaluateApprovalDecision: ({ riskLevel }) => ({
        status: 'UNDER_REVIEW',
        reason: `Verification completed (${riskLevel}); queued for disbursement team review`
      })
    };

    const service = new VerificationService(verRepo, subRepo, () => mockProvider, manualApprovalPolicy);
    const result = await service.runVerification(sub.id);

    // Verification engine correctly assessed LOW_RISK
    assert.equal(result.riskLevel, 'LOW_RISK');
    // But approval policy decoupled final submission status to UNDER_REVIEW
    assert.equal(result.submissionStatus, 'UNDER_REVIEW');

    const updatedSub = await subRepo.getSubmissionById(sub.id);
    assert.equal(updatedSub.status, 'UNDER_REVIEW');
  });
});

describe('Provider Error Taxonomy & Recovery', () => {
  test('transient error is marked retryable', () => {
    const err429 = new TransientProviderError('Rate limit', 'YOUTUBE', { status: 429 });
    assert.equal(err429.details.retryable, true);
    assert.equal(err429.details.category, 'TRANSIENT');

    const err503 = new TransientProviderError('Service down', 'YOUTUBE', { status: 503 });
    assert.equal(err503.details.retryable, true);
  });

  test('configuration auth error marks submission UNDER_REVIEW rather than REJECTED', async () => {
    const verRepo = createMockVerificationRepo();
    const subRepo = createMockSubmissionRepo();

    const sub = {
      id: 'sub_bad_api_key',
      platform: 'YOUTUBE',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      status: 'PENDING_VERIFICATION'
    };
    subRepo.submissions.set(sub.id, sub);

    const mockProvider = {
      getCurrentMetrics: async () => {
        throw new ConfigurationAuthError('YouTube API key is invalid', 'YOUTUBE');
      }
    };

    const service = new VerificationService(verRepo, subRepo, () => mockProvider);
    const result = await service.runVerification(sub.id);

    assert.equal(result.status, 'FAILED');
    assert.equal(result.category, 'CONFIGURATION_OR_AUTH');
    assert.equal(result.permanent, false);
    assert.equal(result.requiresStaffAction, true);

    // Creator's submission must NOT be rejected due to bot operator's bad API key!
    const updatedSub = await subRepo.getSubmissionById(sub.id);
    assert.equal(updatedSub.status, 'UNDER_REVIEW');
  });

  test('permanent content failure marks submission REJECTED immediately', async () => {
    const verRepo = createMockVerificationRepo();
    const subRepo = createMockSubmissionRepo();

    const sub = {
      id: 'sub_deleted',
      platform: 'YOUTUBE',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      status: 'PENDING_VERIFICATION'
    };
    subRepo.submissions.set(sub.id, sub);

    const mockProvider = {
      getCurrentMetrics: async () => {
        throw new PermanentContentError('Video deleted', 'YOUTUBE');
      }
    };

    const service = new VerificationService(verRepo, subRepo, () => mockProvider);
    const result = await service.runVerification(sub.id);

    assert.equal(result.status, 'FAILED');
    assert.equal(result.category, 'PERMANENT_CONTENT');

    const updatedSub = await subRepo.getSubmissionById(sub.id);
    assert.equal(updatedSub.status, 'REJECTED');
  });
});
