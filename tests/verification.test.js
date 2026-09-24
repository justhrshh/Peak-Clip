import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getProviderForPlatform } from '../src/providers/index.js';
import { YouTubeProvider } from '../src/providers/youtube/youtube.provider.js';
import { TikTokProvider } from '../src/providers/tiktok/tiktok.provider.js';
import { InstagramProvider } from '../src/providers/instagram/instagram.provider.js';
import { UnsupportedPlatformError } from '../src/modules/submissions/submission.errors.js';
import {
  TransientProviderError,
  PermanentProviderError
} from '../src/modules/verification/verification.errors.js';
import {
  calculateRatio,
  calculateEngagementRatios,
  analyzeMetricSignals
} from '../src/modules/verification/analyzer.js';
import { assessVerificationRisk } from '../src/modules/verification/risk.assessor.js';
import { VerificationService } from '../src/modules/verification/verification.service.js';

// In-memory mock repositories for verification testing
function createMockVerificationRepo() {
  const verifications = new Map();
  const snapshots = [];
  const signals = [];

  return {
    verifications,
    snapshots,
    signals,
    async createMetricSnapshot({ submissionId, views, likes, comments, shares, metadata, source }) {
      const snap = {
        id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        submissionId,
        views: BigInt(views),
        likes: BigInt(likes),
        comments: BigInt(comments),
        shares: shares !== null && shares !== undefined ? BigInt(shares) : null,
        capturedAt: new Date(),
        source: source || 'PROVIDER',
        metadata
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
          updatedAt: new Date(),
          signals: []
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
        signals.push({ id: `sig_${Date.now()}`, verificationId, ...s, createdAt: new Date() });
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

describe('Platform Provider Architecture', () => {
  test('supported platforms resolve their respective providers', () => {
    assert.ok(getProviderForPlatform('YOUTUBE') instanceof YouTubeProvider);
    assert.ok(getProviderForPlatform('TIKTOK') instanceof TikTokProvider);
    assert.ok(getProviderForPlatform('INSTAGRAM') instanceof InstagramProvider);
  });

  test('unsupported platform throws UnsupportedPlatformError', () => {
    assert.throws(() => getProviderForPlatform('VIMEO'), UnsupportedPlatformError);
  });

  test('TikTok provider boundary returns DATA_UNAVAILABLE cleanly', async () => {
    const provider = new TikTokProvider();
    const result = await provider.getCurrentMetrics('71234567890');
    assert.equal(result.status, 'DATA_UNAVAILABLE');
    assert.equal(result.views, null);
    assert.ok(result.reason.includes('OAuth'));
  });

  test('Instagram provider boundary returns DATA_UNAVAILABLE cleanly', async () => {
    const provider = new InstagramProvider();
    const result = await provider.getCurrentMetrics('C1234abcdEF');
    assert.equal(result.status, 'DATA_UNAVAILABLE');
    assert.equal(result.views, null);
    assert.ok(result.reason.includes('Graph API'));
  });

  test('YouTube provider handles unconfigured API key by returning DATA_UNAVAILABLE', async () => {
    const provider = new YouTubeProvider(undefined);
    const result = await provider.getCurrentMetrics('dQw4w9WgXcQ');
    assert.equal(result.status, 'DATA_UNAVAILABLE');
    assert.equal(result.views, null);
  });

  test('provider errors are classified correctly', () => {
    const transientErr = new TransientProviderError('rate limit', 'YOUTUBE');
    assert.equal(transientErr.details.retryable, true);

    const permanentErr = new PermanentProviderError('video deleted', 'YOUTUBE');
    assert.equal(permanentErr.details.retryable, false);
  });
});

describe('Metric Calculations & Anomaly Analyzer', () => {
  test('calculates engagement ratios safely with zero/null denominators', () => {
    // Normal case
    const normal = calculateEngagementRatios({
      views: 10000n,
      likes: 500n,
      comments: 50n,
      shares: 20n
    });
    assert.equal(normal.likeViewRatio, 0.05);
    assert.equal(normal.commentViewRatio, 0.005);
    assert.equal(normal.shareViewRatio, 0.002);
    assert.equal(normal.engagementViewRatio, 0.057);

    // Zero views denominator
    const zero = calculateEngagementRatios({
      views: 0n,
      likes: 0n,
      comments: 0n,
      shares: null
    });
    assert.equal(zero.likeViewRatio, null);
    assert.equal(zero.commentViewRatio, null);
    assert.equal(zero.shareViewRatio, null);

    // Null values
    assert.equal(calculateRatio(null, 1000), null);
    assert.equal(calculateRatio(50, null), null);
  });

  test('normal organic metrics do not produce anomalous signals or HIGH_RISK', () => {
    const snapshot = {
      views: 15000n,
      likes: 600n, // 4% like ratio
      comments: 75n,
      shares: null,
      capturedAt: new Date()
    };

    const prior = {
      views: 10000n,
      likes: 400n,
      comments: 50n,
      capturedAt: new Date(Date.now() - 3600000) // 1 hr ago
    };

    const signals = analyzeMetricSignals(snapshot, [prior]);
    assert.equal(signals.length, 0);

    const assessment = assessVerificationRisk(signals);
    assert.equal(assessment.riskLevel, 'LOW_RISK');
    assert.ok(assessment.score < 0.30);
  });

  test('metric regression produces METRIC_INCONSISTENCY signal', () => {
    const current = {
      views: 8000n, // Dropped from 10,000
      likes: 400n,
      comments: 50n,
      capturedAt: new Date()
    };

    const prior = {
      views: 10000n,
      likes: 400n,
      comments: 50n,
      capturedAt: new Date(Date.now() - 3600000)
    };

    const signals = analyzeMetricSignals(current, [prior]);
    const inconsistencySignal = signals.find((s) => s.type === 'METRIC_INCONSISTENCY');

    assert.ok(inconsistencySignal);
    assert.equal(inconsistencySignal.severity, 'HIGH');
    assert.ok(inconsistencySignal.explanation.includes('decreased'));

    // High severity signal escalates risk assessment to REVIEW_REQUIRED
    const assessment = assessVerificationRisk(signals);
    assert.equal(assessment.riskLevel, 'REVIEW_REQUIRED');
  });

  test('atypical like/view ratio produces LIKE_VIEW_RATIO signal', () => {
    // Abnormally low like ratio: 5 likes on 50,000 views (0.01%)
    const lowLikes = {
      views: 50000n,
      likes: 5n,
      comments: 2n,
      capturedAt: new Date()
    };

    const signals = analyzeMetricSignals(lowLikes, []);
    const ratioSignal = signals.find((s) => s.type === 'LIKE_VIEW_RATIO');

    assert.ok(ratioSignal);
    assert.equal(ratioSignal.severity, 'MEDIUM');
  });

  test('sudden velocity spike produces SUDDEN_GROWTH signal', () => {
    const now = Date.now();
    const snap0 = { views: 1000n, capturedAt: new Date(now - 7200000) }; // 2 hrs ago
    const snap1 = { views: 1100n, capturedAt: new Date(now - 3600000) }; // 1 hr ago (velocity: 100 views/hr)
    const snap2 = { views: 25000n, capturedAt: new Date(now) };          // now (velocity: 23,900 views/hr > 10x prior)

    const signals = analyzeMetricSignals(snap2, [snap0, snap1]);
    const growthSignal = signals.find((s) => s.type === 'SUDDEN_GROWTH');

    assert.ok(growthSignal);
    assert.equal(growthSignal.severity, 'MEDIUM');
    assert.ok(growthSignal.explanation.includes('accelerated'));
  });

  test('risk assessment remains explainable with primary reasons', () => {
    const signals = [
      {
        type: 'METRIC_INCONSISTENCY',
        severity: 'HIGH',
        explanation: 'Observed view count decreased by 5,000'
      },
      {
        type: 'LIKE_VIEW_RATIO',
        severity: 'MEDIUM',
        explanation: 'Like-to-view ratio is 0.02%'
      }
    ];

    const assessment = assessVerificationRisk(signals);
    assert.equal(assessment.riskLevel, 'REVIEW_REQUIRED');
    assert.ok(assessment.primaryReasons.length > 0);
    assert.ok(assessment.primaryReasons[0].includes('HIGH'));
  });
});

describe('Verification Service Lifecycle & Worker', () => {
  test('successful verification completes and transitions submission to APPROVED for LOW_RISK', async () => {
    const verRepo = createMockVerificationRepo();
    const subRepo = createMockSubmissionRepo();

    // Submission fixture
    const submission = {
      id: 'sub_test_1',
      platform: 'YOUTUBE',
      url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      status: 'PENDING_VERIFICATION'
    };
    subRepo.submissions.set(submission.id, submission);

    // Mock provider returning healthy organic metrics
    const mockProvider = {
      getCurrentMetrics: async () => ({
        isAvailable: true,
        views: 12500n,
        likes: 500n,
        comments: 45n,
        shares: null,
        status: 'AVAILABLE'
      })
    };

    const service = new VerificationService(verRepo, subRepo, () => mockProvider);
    const result = await service.runVerification(submission.id);

    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.riskLevel, 'LOW_RISK');
    assert.equal(result.submissionStatus, 'APPROVED');

    // Verify database updates
    const storedVer = await verRepo.getVerificationBySubmissionId(submission.id);
    assert.equal(storedVer.status, 'COMPLETED');
    assert.equal(storedVer.riskLevel, 'LOW_RISK');

    const updatedSub = await subRepo.getSubmissionById(submission.id);
    assert.equal(updatedSub.status, 'APPROVED');
    assert.ok(updatedSub.verifiedAt);
  });

  test('permanent provider failure marks submission REJECTED and does not retry', async () => {
    const verRepo = createMockVerificationRepo();
    const subRepo = createMockSubmissionRepo();

    const submission = {
      id: 'sub_deleted_clip',
      platform: 'YOUTUBE',
      url: 'https://www.youtube.com/watch?v=deleted12345',
      status: 'PENDING_VERIFICATION'
    };
    subRepo.submissions.set(submission.id, submission);

    // Mock provider throwing non-retryable permanent error
    const mockProvider = {
      getCurrentMetrics: async () => {
        throw new PermanentProviderError('Video was deleted by creator', 'YOUTUBE');
      }
    };

    const service = new VerificationService(verRepo, subRepo, () => mockProvider);
    const result = await service.runVerification(submission.id);

    assert.equal(result.status, 'FAILED');
    assert.equal(result.permanent, true);

    const updatedSub = await subRepo.getSubmissionById(submission.id);
    assert.equal(updatedSub.status, 'REJECTED');
    assert.ok(updatedSub.rejectionReason.includes('deleted'));
  });

  test('transient provider failure throws retryable error to trigger queue backoff', async () => {
    const verRepo = createMockVerificationRepo();
    const subRepo = createMockSubmissionRepo();

    const submission = {
      id: 'sub_network_error',
      platform: 'YOUTUBE',
      url: 'https://www.youtube.com/watch?v=tempunavailable',
      status: 'PENDING_VERIFICATION'
    };
    subRepo.submissions.set(submission.id, submission);

    const mockProvider = {
      getCurrentMetrics: async () => {
        throw new TransientProviderError('YouTube API rate limit exceeded', 'YOUTUBE');
      }
    };

    const service = new VerificationService(verRepo, subRepo, () => mockProvider);

    await assert.rejects(
      async () => service.runVerification(submission.id),
      TransientProviderError
    );

    const storedVer = await verRepo.getVerificationBySubmissionId(submission.id);
    assert.equal(storedVer.status, 'PENDING');
  });

  test('repeated verification calls are idempotent', async () => {
    const verRepo = createMockVerificationRepo();
    const subRepo = createMockSubmissionRepo();

    const submission = {
      id: 'sub_idempotent',
      platform: 'YOUTUBE',
      url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      status: 'PENDING_VERIFICATION'
    };
    subRepo.submissions.set(submission.id, submission);

    const mockProvider = {
      getCurrentMetrics: async () => ({
        isAvailable: true,
        views: 5000n,
        likes: 200n,
        comments: 20n,
        shares: null,
        status: 'AVAILABLE'
      })
    };

    const service = new VerificationService(verRepo, subRepo, () => mockProvider);

    // Call 1
    const run1 = await service.runVerification(submission.id);
    assert.equal(run1.status, 'COMPLETED');

    // Call 2
    const run2 = await service.runVerification(submission.id);
    assert.equal(run2.status, 'COMPLETED');

    // Only 1 verification record exists for this submission
    assert.equal(verRepo.verifications.size, 1);
  });
});
