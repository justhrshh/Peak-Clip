import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeProvider } from '../src/providers/youtube/youtube.provider.js';
import {
  evaluatePollingEligibility,
  isSubmissionEligibleForPolling,
  hasMetricsChanged
} from '../src/modules/verification/polling.policy.js';
import { AdminSubmissionRepository } from '../src/modules/admin/admin.submission.repository.js';
import { AdminSubmissionService } from '../src/modules/admin/admin.submission.service.js';
import {
  buildStaffSubmissionDetailEmbed,
  buildStaffSubmissionAnalyticsEmbed
} from '../src/bot/embeds/staff.embeds.js';
import {
  TransientProviderError,
  PermanentContentError,
  ConfigurationAuthError,
  RateLimitProviderError
} from '../src/modules/verification/verification.errors.js';
import { YOUTUBE_FIXTURES } from './fixtures/youtube.fixtures.js';

describe('YouTube Tracking Pipeline — Provider Normalization & Metric Integrity', () => {
  const provider = new YouTubeProvider('test_api_key');

  test('YouTube metrics accurately captures BigInt views, likes, comments with metadata', () => {
    const item = {
      ...YOUTUBE_FIXTURES.STANDARD_VIDEO.items[0],
      contentDetails: { duration: 'PT3M32S' }
    };
    const normalized = provider.normalizeApiResponse(item, 'dQw4w9WgXcQ');

    assert.equal(normalized.platform, 'YOUTUBE');
    assert.equal(typeof normalized.views, 'bigint');
    assert.equal(normalized.views, 1500000n);
    assert.equal(normalized.likes, 150000n);
    assert.equal(normalized.comments, 25000n);
    assert.equal(normalized.shares, null, 'Public YouTube API does not provide video shares');
    assert.equal(normalized.durationSeconds, 212);
    assert.equal(normalized.availability.views, 'AVAILABLE');
    assert.equal(normalized.availability.duration, 'AVAILABLE');
    assert.equal(normalized.metadata.channelTitle, 'Rick Astley');
  });

  test('Preserves null when metrics are unavailable and distinguishes from 0', () => {
    const item = YOUTUBE_FIXTURES.HIDDEN_LIKES_VIDEO.items[0];
    const normalized = provider.normalizeApiResponse(item, 'vid_hidden');

    assert.equal(normalized.views, 50000n);
    assert.equal(normalized.likes, null, 'Hidden likes must be null, never 0');
    assert.equal(normalized.availability.likes, 'UNAVAILABLE');
    assert.equal(normalized.availability.views, 'AVAILABLE');
  });

  test('Distinguishes authentic zero counts from unavailable/null', () => {
    const item = YOUTUBE_FIXTURES.ZERO_VIEWS_VIDEO.items[0];
    const normalized = provider.normalizeApiResponse(item, 'vid_zero');

    assert.equal(normalized.views, 0n);
    assert.equal(normalized.likes, 0n);
    assert.equal(normalized.comments, 0n);
    assert.equal(normalized.availability.views, 'AVAILABLE');
  });
});

describe('YouTube Tracking Pipeline — Polling Eligibility Policy', () => {
  const baseActiveSubmission = {
    id: 'sub_123',
    status: 'APPROVED',
    platform: 'YOUTUBE',
    deletedAt: null,
    user: { id: 'usr_1', status: 'ACTIVE' },
    campaign: { id: 'cmp_1', status: 'ACTIVE', endDate: null }
  };

  test('Approves eligible APPROVED YouTube clip in ACTIVE campaign', () => {
    const res = evaluatePollingEligibility(baseActiveSubmission);
    assert.equal(res.eligible, true);
    assert.equal(res.reason, 'ELIGIBLE');
    assert.equal(isSubmissionEligibleForPolling(baseActiveSubmission), true);
  });

  test('Rejects non-APPROVED submissions (PENDING_VERIFICATION, UNDER_REVIEW, REJECTED)', () => {
    const pending = { ...baseActiveSubmission, status: 'PENDING_VERIFICATION' };
    assert.equal(evaluatePollingEligibility(pending).eligible, false);

    const review = { ...baseActiveSubmission, status: 'UNDER_REVIEW' };
    assert.equal(evaluatePollingEligibility(review).eligible, false);

    const rejected = { ...baseActiveSubmission, status: 'REJECTED' };
    assert.equal(evaluatePollingEligibility(rejected).eligible, false);
  });

  test('Rejects platforms without fetchViews capability (UNKNOWN_PLATFORM)', () => {
    const unkSub = { ...baseActiveSubmission, platform: 'UNKNOWN_PLATFORM' };
    const res = evaluatePollingEligibility(unkSub);
    assert.equal(res.eligible, false);
    assert.ok(res.reason.includes('PLATFORM_UNKNOWN_PLATFORM_METRICS_UNSUPPORTED'));
  });

  test('Rejects submissions with inactive or suspended creators', () => {
    const suspended = { ...baseActiveSubmission, user: { id: 'usr_1', status: 'SUSPENDED' } };
    assert.equal(evaluatePollingEligibility(suspended).eligible, false);

    const banned = { ...baseActiveSubmission, user: { id: 'usr_1', status: 'BANNED' } };
    assert.equal(evaluatePollingEligibility(banned).eligible, false);
  });

  test('Rejects submissions with expired campaign outside grace period', () => {
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    const expiredCamp = {
      ...baseActiveSubmission,
      campaign: { id: 'cmp_1', status: 'ENDED', endDate: longAgo }
    };
    const res = evaluatePollingEligibility(expiredCamp);
    assert.equal(res.eligible, false);
    assert.equal(res.reason, 'CAMPAIGN_TRACKING_WINDOW_EXPIRED');
  });
});

describe('YouTube Tracking Pipeline — Duplicate Prevention & Snapshot Policy', () => {
  test('Returns true if no previous snapshot exists (initial snapshot requirement)', () => {
    const changed = hasMetricsChanged(null, { views: 100n, likes: 10n, comments: 2n });
    assert.equal(changed, true);
  });

  test('Returns false if views, likes, and comments are identical (skips duplicate snapshot)', () => {
    const latestSnapshot = {
      views: 1500n,
      likes: 100n,
      comments: 10n
    };
    const newMetrics = {
      views: 1500n,
      likes: 100n,
      comments: 10n
    };

    const changed = hasMetricsChanged(latestSnapshot, newMetrics);
    assert.equal(changed, false, 'Should skip duplicate snapshot insertion when metrics are identical');
  });

  test('Returns true if views have grown', () => {
    const latestSnapshot = {
      views: 1500n,
      likes: 100n,
      comments: 10n
    };
    const newMetrics = {
      views: 1550n,
      likes: 100n,
      comments: 10n
    };

    assert.equal(hasMetricsChanged(latestSnapshot, newMetrics), true);
  });

  test('Returns true if likes have changed even if views are unchanged', () => {
    const latestSnapshot = {
      views: 1500n,
      likes: 100n,
      comments: 10n
    };
    const newMetrics = {
      views: 1500n,
      likes: 120n,
      comments: 10n
    };

    assert.equal(hasMetricsChanged(latestSnapshot, newMetrics), true);
  });
});

describe('YouTube Tracking Pipeline — Historical Growth Analytics & BigInt Metrics', () => {
  test('Calculates sequential deltas and total views gained across hourly intervals', async () => {
    const t0 = new Date('2026-09-23T10:00:00Z');
    const t1 = new Date('2026-09-23T11:00:00Z');
    const t2 = new Date('2026-09-23T12:00:00Z');

    const snapshots = [
      { id: 'snap_0', views: 50000n, likes: 2000n, comments: 100n, shares: null, capturedAt: t0 },
      { id: 'snap_1', views: 65000n, likes: 2500n, comments: 120n, shares: null, capturedAt: t1 },
      { id: 'snap_2', views: 80000n, likes: 3000n, comments: 150n, shares: null, capturedAt: t2 }
    ];

    const mockPrisma = {
      submission: {
        findUnique: async () => ({
          id: 'sub_yt_1',
          platform: 'YOUTUBE',
          status: 'APPROVED',
          url: 'https://youtube.com/watch?v=abcdef',
          snapshots
        })
      }
    };

    const repo = new AdminSubmissionRepository(mockPrisma);
    const analytics = await repo.getSubmissionAnalytics('sub_yt_1', { page: 1, limit: 5 });

    assert.equal(analytics.totalSnapshots, 3);
    assert.equal(analytics.totalViewsGained, 30000); // 80000 - 50000
    assert.equal(analytics.successfulChecks, 3);
    assert.equal(analytics.unavailableChecks, 0);

    // Latest snapshot is index 0 in reversed view
    assert.equal(analytics.snapshots[0].id, 'snap_2');
    assert.equal(analytics.snapshots[0].viewsGained, 15000); // 80000 - 65000
    assert.equal(analytics.snapshots[0].likesGained, 500);

    // Mid snapshot
    assert.equal(analytics.snapshots[1].id, 'snap_1');
    assert.equal(analytics.snapshots[1].viewsGained, 15000); // 65000 - 50000
    assert.equal(analytics.snapshots[1].likesGained, 500);

    // Initial snapshot baseline
    assert.equal(analytics.snapshots[2].id, 'snap_0');
    assert.equal(analytics.snapshots[2].viewsGained, 0);
  });

  test('Correctly handles very large BigInt view counts without precision crash', async () => {
    const largeSnapshots = [
      { id: 'snap_huge_1', views: 2500000000n, likes: 50000000n, comments: 1000000n, shares: null, capturedAt: new Date() },
      { id: 'snap_huge_2', views: 2500100000n, likes: 50005000n, comments: 1000100n, shares: null, capturedAt: new Date() }
    ];

    const mockPrisma = {
      submission: {
        findUnique: async () => ({
          id: 'sub_yt_huge',
          platform: 'YOUTUBE',
          status: 'APPROVED',
          url: 'https://youtube.com/watch?v=huge',
          snapshots: largeSnapshots
        })
      }
    };

    const repo = new AdminSubmissionRepository(mockPrisma);
    const analytics = await repo.getSubmissionAnalytics('sub_yt_huge');

    assert.equal(analytics.totalViewsGained, 100000);
    assert.equal(analytics.snapshots[0].views, 2500100000);
  });
});

describe('YouTube Tracking Pipeline — Manual Refresh & Audit Logging', () => {
  test('refreshSubmissionMetrics fetches live metrics, records snapshot, and audit logs', async () => {
    let capturedSnapshot = null;
    let capturedAudit = null;
    let updatedSubmissionData = null;

    const mockDb = {
      metricSnapshot: {
        create: async ({ data }) => {
          capturedSnapshot = data;
          return { id: 'snap_manual_1', ...data };
        }
      },
      submission: {
        findUnique: async () => ({
          id: 'sub_manual_refresh',
          platform: 'YOUTUBE',
          status: 'APPROVED',
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          snapshots: []
        }),
        update: async ({ data }) => {
          updatedSubmissionData = data;
          return { id: 'sub_manual_refresh', ...data };
        }
      }
    };

    const mockAuditService = {
      logAction: async (entry) => {
        capturedAudit = entry;
      }
    };

    const mockRepo = new AdminSubmissionRepository(mockDb);
    const service = new AdminSubmissionService(mockRepo, mockAuditService);

    // Execute staff on-demand refresh
    const actor = { discordId: 'staff_123', userId: 'usr_staff' };
    const result = await service.refreshSubmissionMetrics('sub_manual_refresh', actor);

    assert.ok(result.metrics);
    assert.equal(result.metrics.platform, 'YOUTUBE');
    assert.ok(capturedAudit, 'Must record audit log entry');
    assert.equal(capturedAudit.action, 'SUBMISSION_REFRESH_METRICS');
    assert.equal(capturedAudit.actorDiscordId, 'staff_123');
    assert.equal(capturedAudit.entityId, 'sub_manual_refresh');
    assert.ok(updatedSubmissionData);
  });
});

describe('YouTube Tracking Pipeline — Staff Embeds UI Rendering', () => {
  test('buildStaffSubmissionDetailEmbed renders current metrics, availability, and tracking state', () => {
    const submission = {
      id: 'sub_embed_test',
      platform: 'YOUTUBE',
      status: 'APPROVED',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      userId: 'usr_1',
      campaignId: 'cmp_1',
      durationSeconds: 95,
      retentionRequired: true,
      retentionDays: 14,
      retentionStatus: 'ACTIVE',
      lastAvailabilityStatus: 'AVAILABLE',
      submittedAt: new Date('2026-09-20T10:00:00Z'),
      verifiedAt: new Date('2026-09-20T10:05:00Z'),
      user: { discordId: '123456789', username: 'top_creator' },
      campaign: { name: 'Fall Gaming Highlights' },
      verifications: [{ riskLevel: 'LOW_RISK', score: 10 }],
      snapshots: [
        {
          id: 'snap_latest',
          views: 125000n,
          likes: 8500n,
          comments: 420n,
          shares: null,
          capturedAt: new Date('2026-09-23T14:00:00Z')
        }
      ]
    };

    const embed = buildStaffSubmissionDetailEmbed(submission);
    assert.ok(embed);

    const fields = embed.data.fields;
    const metricsField = fields.find((f) => f.name === '📊 Current Metrics');
    assert.ok(metricsField, 'Must include Current Metrics field');
    assert.ok(metricsField.value.includes('125,000'));
    assert.ok(metricsField.value.includes('8,500'));
    assert.ok(metricsField.value.includes('420'));

    const trackingField = fields.find((f) => f.name === '📡 Tracking & Availability');
    assert.ok(trackingField, 'Must include Tracking & Availability field');
    assert.ok(trackingField.value.includes('ACTIVE_TRACKING'));
    assert.ok(trackingField.value.includes('AVAILABLE'));
  });

  test('buildStaffSubmissionAnalyticsEmbed renders growth totals and tracking duration', () => {
    const analyticsData = {
      submission: { id: 'sub_analytics_test', platform: 'YOUTUBE', status: 'APPROVED' },
      snapshots: [
        {
          id: 'snap_1',
          views: 50000,
          likes: 2000,
          comments: 100,
          shares: null,
          viewsGained: 5000,
          likesGained: 200,
          capturedAt: new Date('2026-09-23T12:00:00Z')
        }
      ],
      page: 1,
      totalPages: 1,
      totalSnapshots: 5,
      totalViewsGained: 25000,
      successfulChecks: 5,
      unavailableChecks: 0,
      firstTracked: { capturedAt: new Date('2026-09-23T08:00:00Z') },
      latestTracked: { capturedAt: new Date('2026-09-23T12:00:00Z') }
    };

    const embed = buildStaffSubmissionAnalyticsEmbed(analyticsData);
    assert.ok(embed);

    const fields = embed.data.fields;
    const growthField = fields.find((f) => f.name === '📈 Total Views Gained');
    assert.ok(growthField);
    assert.ok(growthField.value.includes('25,000'));

    const checksField = fields.find((f) => f.name === '📡 Polling Checks');
    assert.ok(checksField);
    assert.ok(checksField.value.includes('5') && checksField.value.includes('ok'));

    const durationField = fields.find((f) => f.name === '⏱️ Tracking Duration');
    assert.ok(durationField);
  });
});

describe('YouTube Tracking Pipeline — Error Resiliency & Worker Strategy', () => {
  test('PermanentContentError is fatal and non-retryable', () => {
    const error = new PermanentContentError('Video is private', 'YOUTUBE');
    assert.equal(error.statusCode, 400);
    assert.equal(error.details.retryable, false);
    assert.equal(error.details.category, 'PERMANENT_CONTENT');
  });

  test('TransientProviderError is retryable by BullMQ exponential backoff', () => {
    const error = new TransientProviderError('Connection timeout', 'YOUTUBE');
    assert.equal(error.statusCode, 503);
    assert.equal(error.details.retryable, true);
  });

  test('RateLimitProviderError carries retry-after metadata', () => {
    const error = new RateLimitProviderError('Quota exceeded', 'YOUTUBE', 60000);
    assert.equal(error.statusCode, 429);
    assert.equal(error.details.retryable, true);
    assert.equal(error.details.retryAfterMs, 60000);
  });

  test('ConfigurationAuthError is non-retryable and flags operator configuration required', () => {
    const error = new ConfigurationAuthError('Invalid API key', 'YOUTUBE');
    assert.equal(error.statusCode, 500);
    assert.equal(error.details.retryable, false);
    assert.equal(error.details.category, 'CONFIGURATION_OR_AUTH');
  });
});
