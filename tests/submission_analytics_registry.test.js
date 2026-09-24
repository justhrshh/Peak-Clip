import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AdminSubmissionRepository } from '../src/modules/admin/admin.submission.repository.js';

describe('Submission Analytics & Metric Snapshots Calculation', () => {
  test('calculates accurate growth deltas between chronological snapshots', async () => {
    const mockSnapshots = [
      { id: 'snap1', views: 1000n, likes: 50n, comments: 5n, shares: 2n, capturedAt: new Date('2026-09-01T00:00:00Z'), source: 'HOURLY_WORKER' },
      { id: 'snap2', views: 1500n, likes: 80n, comments: 8n, shares: 3n, capturedAt: new Date('2026-09-01T01:00:00Z'), source: 'HOURLY_WORKER' },
      { id: 'snap3', views: 2200n, likes: 110n, comments: 12n, shares: 5n, capturedAt: new Date('2026-09-01T02:00:00Z'), source: 'HOURLY_WORKER' }
    ];

    const mockPrisma = {
      submission: {
        findUnique: async () => ({
          id: 'sub_analytics_1',
          platform: 'YOUTUBE',
          status: 'APPROVED',
          url: 'https://youtube.com/watch?v=abc',
          snapshots: mockSnapshots
        })
      }
    };

    const repo = new AdminSubmissionRepository(mockPrisma);
    const result = await repo.getSubmissionAnalytics('sub_analytics_1', { page: 1, limit: 10 });

    assert.equal(result.totalSnapshots, 3);
    assert.equal(result.snapshots.length, 3);
    assert.equal(result.items.length, 3);

    // Most recent snapshot should be first in desc order (snap3)
    const latest = result.snapshots[0];
    assert.equal(latest.id, 'snap3');
    assert.equal(latest.views, 2200);
    assert.equal(latest.viewsGained, 700); // 2200 - 1500
    assert.equal(latest.likesGained, 30);   // 110 - 80

    // Middle snapshot (snap2)
    const mid = result.snapshots[1];
    assert.equal(mid.id, 'snap2');
    assert.equal(mid.views, 1500);
    assert.equal(mid.viewsGained, 500); // 1500 - 1000
    assert.equal(mid.likesGained, 30);  // 80 - 50

    // Oldest snapshot (snap1)
    const oldest = result.snapshots[2];
    assert.equal(oldest.id, 'snap1');
    assert.equal(oldest.views, 1000);
    assert.equal(oldest.viewsGained, 0); // Baseline snapshot has 0 previous delta


  });

  test('handles submissions with zero snapshots gracefully', async () => {
    const mockPrisma = {
      submission: {
        findUnique: async () => ({
          id: 'sub_empty',
          platform: 'FACEBOOK',
          status: 'PENDING_VERIFICATION',
          snapshots: []
        })
      }
    };

    const repo = new AdminSubmissionRepository(mockPrisma);
    const result = await repo.getSubmissionAnalytics('sub_empty', { page: 1, limit: 10 });

    assert.equal(result.totalSnapshots, 0);
    assert.equal(result.snapshots.length, 0);
    assert.equal(result.items.length, 0);
    assert.equal(result.submission.platform, 'FACEBOOK');
  });
});

describe('Submission Registry Repository Filtering & Stats', () => {
  test('getSubmissionRegistryStats aggregates counts by status and platform including Facebook', async () => {
    const mockPrisma = {
      submission: {
        count: async (query) => {
          if (!query?.where) return 10;
          if (query.where.status === 'PENDING_VERIFICATION') return 2;
          if (query.where.status === 'UNDER_REVIEW') return 2;
          if (query.where.status === 'APPROVED') return 5;
          if (query.where.status === 'REJECTED') return 0;
          if (query.where.status === 'FLAGGED') return 1;
          if (query.where.status === 'POST_APPROVAL_REVIEW') return 0;
          if (query.where.platform === 'YOUTUBE') return 4;
          if (query.where.platform === 'TIKTOK') return 3;
          if (query.where.platform === 'INSTAGRAM') return 1;
          if (query.where.platform === 'FACEBOOK') return 2;
          if (query.where.snapshots) return 6;
          if (query.where.lastAvailabilityStatus) return 2;
          return 0;
        }
      }
    };

    const repo = new AdminSubmissionRepository(mockPrisma);
    const stats = await repo.getSubmissionRegistryStats();

    assert.equal(stats.total, 10);
    assert.equal(stats.byStatus.APPROVED, 5);
    assert.equal(stats.byStatus.UNDER_REVIEW, 2);
    assert.equal(stats.byPlatform.YOUTUBE, 4);
    assert.equal(stats.byPlatform.TIKTOK, 3);
    assert.equal(stats.byPlatform.INSTAGRAM, 1);
    assert.equal(stats.byPlatform.FACEBOOK, 2);
    assert.equal(stats.trackedCount, 6);
    assert.equal(stats.unavailableCount, 2);
  });

  test('listSubmissions builds correct where clause for platform=FACEBOOK and status=APPROVED', async () => {
    let capturedWhere = null;

    const mockPrisma = {
      submission: {
        findMany: async ({ where }) => {
          capturedWhere = where;
          return [];
        },
        count: async () => 0
      }
    };

    const repo = new AdminSubmissionRepository(mockPrisma);
    await repo.listSubmissions({ platform: 'FACEBOOK', status: 'APPROVED', page: 1, limit: 10 });

    assert.equal(capturedWhere.platform, 'FACEBOOK');
    assert.equal(capturedWhere.status, 'APPROVED');
  });

  test('listSubmissions applies case-insensitive OR search across ID, URL, username, and discordId', async () => {
    let capturedWhere = null;

    const mockPrisma = {
      submission: {
        findMany: async ({ where }) => {
          capturedWhere = where;
          return [];
        },
        count: async () => 0
      }
    };

    const repo = new AdminSubmissionRepository(mockPrisma);
    await repo.listSubmissions({ search: 'test_creator', page: 1, limit: 10 });

    assert.ok(Array.isArray(capturedWhere.OR));
    assert.equal(capturedWhere.OR.length, 6);
    assert.ok(capturedWhere.OR.some((clause) => clause.id?.contains === 'test_creator'));
    assert.ok(capturedWhere.OR.some((clause) => clause.url?.contains === 'test_creator'));
    assert.ok(capturedWhere.OR.some((clause) => clause.user?.username?.contains === 'test_creator'));
  });
});
