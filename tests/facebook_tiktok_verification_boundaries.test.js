import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseAndNormalizeUrl } from '../src/modules/submissions/url.parser.js';
import { InvalidSubmissionUrlError } from '../src/modules/submissions/submission.errors.js';
import { TikTokProvider } from '../src/providers/tiktok/tiktok.provider.js';
import { FacebookProvider } from '../src/providers/facebook/facebook.provider.js';
import { hasProviderCapability, getProviderCapabilities } from '../src/providers/capabilities.js';
import { evaluatePollingEligibility, isSubmissionEligibleForPolling } from '../src/modules/verification/polling.policy.js';
import { AdminSubmissionService } from '../src/modules/admin/admin.submission.service.js';
import {
  buildStaffSubmissionDetailEmbed,
  buildStaffSubmissionAnalyticsEmbed
} from '../src/bot/embeds/staff.embeds.js';
import { buildStaffSubmissionDetailRow } from '../src/bot/components/staff.components.js';
import { buildStaffManualMetricsModal } from '../src/bot/components/staff.modals.js';
import { STAFF_COMPONENTS, staffIds } from '../src/bot/components/staffComponentIds.js';

describe('Facebook & TikTok URL Parsing & Normalization', () => {
  describe('Facebook URL Parser', () => {
    test('parses standard Facebook Reel URL', () => {
      const res = parseAndNormalizeUrl('https://www.facebook.com/reel/1029384756/');
      assert.equal(res.platform, 'FACEBOOK');
      assert.equal(res.contentId, '1029384756');
      assert.equal(res.normalizedUrl, 'https://www.facebook.com/reel/1029384756/');
    });

    test('parses fb.watch shortlinks', () => {
      const res = parseAndNormalizeUrl('https://fb.watch/xyz987abc/');
      assert.equal(res.platform, 'FACEBOOK');
      assert.equal(res.contentId, 'xyz987abc');
      assert.equal(res.normalizedUrl, 'https://fb.watch/xyz987abc/');
    });

    test('parses Facebook share reel URL (/share/r/ID)', () => {
      const res = parseAndNormalizeUrl('https://www.facebook.com/share/r/456789123/');
      assert.equal(res.platform, 'FACEBOOK');
      assert.equal(res.contentId, '456789123');
      assert.equal(res.normalizedUrl, 'https://www.facebook.com/reel/456789123/');
    });

    test('parses Facebook share video URL (/share/v/ID)', () => {
      const res = parseAndNormalizeUrl('https://www.facebook.com/share/v/998877665/');
      assert.equal(res.platform, 'FACEBOOK');
      assert.equal(res.contentId, '998877665');
      assert.equal(res.normalizedUrl, 'https://www.facebook.com/reel/998877665/');
    });

    test('parses Facebook watch query URL (/watch/?v=ID)', () => {
      const res = parseAndNormalizeUrl('https://www.facebook.com/watch/?v=1122334455');
      assert.equal(res.platform, 'FACEBOOK');
      assert.equal(res.contentId, '1122334455');
      assert.equal(res.normalizedUrl, 'https://www.facebook.com/watch/?v=1122334455');
    });

    test('strips tracking parameters from Facebook URLs (fbclid, utm_*)', () => {
      const res = parseAndNormalizeUrl('https://www.facebook.com/reel/1029384756/?fbclid=IwAR123456&utm_source=messenger');
      assert.equal(res.platform, 'FACEBOOK');
      assert.equal(res.contentId, '1029384756');
      assert.equal(res.normalizedUrl, 'https://www.facebook.com/reel/1029384756/');
    });

    test('rejects malformed Facebook URL without valid video ID', () => {
      assert.throws(
        () => parseAndNormalizeUrl('https://www.facebook.com/groups/feed/'),
        InvalidSubmissionUrlError
      );
    });
  });

  describe('TikTok URL Parser', () => {
    test('parses web TikTok video URL (/@creator/video/ID)', () => {
      const res = parseAndNormalizeUrl('https://www.tiktok.com/@peakclips/video/7123456789012345678');
      assert.equal(res.platform, 'TIKTOK');
      assert.equal(res.contentId, '7123456789012345678');
      assert.equal(res.normalizedUrl, 'https://www.tiktok.com/@peakclips/video/7123456789012345678');
    });

    test('parses TikTok shortlink (vm.tiktok.com/ID)', () => {
      const res = parseAndNormalizeUrl('https://vm.tiktok.com/ZM8xYzA12/');
      assert.equal(res.platform, 'TIKTOK');
      assert.equal(res.contentId, 'ZM8xYzA12');
      assert.equal(res.normalizedUrl, 'https://vm.tiktok.com/ZM8xYzA12');
    });

    test('strips tracking parameters from TikTok URLs', () => {
      const res = parseAndNormalizeUrl('https://www.tiktok.com/@peakclips/video/7123456789012345678?is_from_webapp=1&sender_device=pc');
      assert.equal(res.platform, 'TIKTOK');
      assert.equal(res.contentId, '7123456789012345678');
      assert.equal(res.normalizedUrl, 'https://www.tiktok.com/@peakclips/video/7123456789012345678');
    });

    test('rejects malformed TikTok URL without video ID', () => {
      assert.throws(
        () => parseAndNormalizeUrl('https://www.tiktok.com/@onlyuser'),
        InvalidSubmissionUrlError
      );
    });
  });
});

describe('Platform Capability Matrix & Polling Protection', () => {
  test('Facebook capability matrix enables fetchViews: true for automated scraping', () => {
    assert.equal(hasProviderCapability('FACEBOOK', 'fetchViews'), true);
    assert.equal(hasProviderCapability('FACEBOOK', 'fetchLikes'), true);
    assert.equal(hasProviderCapability('FACEBOOK', 'fetchComments'), true);
  });

  test('TikTok capability matrix enables fetchViews: true for automated scraping', () => {
    assert.equal(hasProviderCapability('TIKTOK', 'fetchViews'), true);
    assert.equal(hasProviderCapability('TIKTOK', 'fetchLikes'), true);
    assert.equal(hasProviderCapability('TIKTOK', 'fetchComments'), true);
  });

  test('YouTube and Instagram retain fetchViews: true for hourly tracking', () => {
    assert.equal(hasProviderCapability('YOUTUBE', 'fetchViews'), true);
    assert.equal(hasProviderCapability('INSTAGRAM', 'fetchViews'), true);
  });

  test('evaluatePollingEligibility accepts approved Facebook submissions for hourly polling', () => {
    const fbSub = {
      id: 'sub_fb_1',
      platform: 'FACEBOOK',
      status: 'APPROVED',
      user: { status: 'ACTIVE' },
      campaign: { status: 'ACTIVE' }
    };
    const check = evaluatePollingEligibility(fbSub);
    assert.equal(check.eligible, true);
  });

  test('evaluatePollingEligibility accepts approved TikTok submissions for hourly polling', () => {
    const ttSub = {
      id: 'sub_tt_1',
      platform: 'TIKTOK',
      status: 'APPROVED',
      user: { status: 'ACTIVE' },
      campaign: { status: 'ACTIVE' }
    };
    const check = evaluatePollingEligibility(ttSub);
    assert.equal(check.eligible, true);
  });
});

describe('Provider Boundaries & Zero Fabricated Numbers', () => {
  test('TikTokProvider returns DATA_UNAVAILABLE with null metrics (zero scraping)', async () => {
    const provider = new TikTokProvider(null);
    const metrics = await provider.getCurrentMetrics('7123456789012345678');
    assert.equal(metrics.status, 'DATA_UNAVAILABLE');
    assert.equal(metrics.views, null);
    assert.equal(metrics.likes, null);
    assert.equal(metrics.comments, null);
    assert.equal(metrics.durationSeconds, null);
    assert.match(metrics.reason, /OAuth/i);

    const videoMetrics = await provider.getVideoMetrics('7123456789012345678');
    assert.equal(videoMetrics.status, 'DATA_UNAVAILABLE');

    const avail = await provider.getAvailability('7123456789012345678');
    assert.equal(avail.status, 'DATA_UNAVAILABLE');
  });

  test('FacebookProvider returns DATA_UNAVAILABLE when unauthenticated (zero scraping)', async () => {
    const provider = new FacebookProvider(''); // empty token
    const metrics = await provider.getCurrentMetrics('1029384756');
    assert.equal(metrics.status, 'DATA_UNAVAILABLE');
    assert.equal(metrics.views, null);
    assert.equal(metrics.likes, null);
    assert.equal(metrics.comments, null);
    assert.match(metrics.reason, /Meta Graph API authorization/i);
  });
});

describe('Manual Metrics Ingestion & Audit Integrity', () => {
  function createMockRepo(submissionData) {
    const snapshots = [];
    const updates = [];
    const auditLogs = [];

    const repo = {
      db: {
        metricSnapshot: {
          create: async ({ data }) => {
            const snap = { id: `snap_${Date.now()}_${Math.random()}`, ...data };
            snapshots.push(snap);
            return snap;
          }
        }
      },
      getSubmissionWithFullDetails: async (id) => {
        if (id !== submissionData.id) return null;
        return { ...submissionData, snapshots };
      },
      updateSubmission: async (id, data) => {
        updates.push({ id, data });
        Object.assign(submissionData, data);
        return submissionData;
      }
    };

    const auditService = {
      logAction: async (log) => {
        auditLogs.push(log);
        return log;
      }
    };

    return { repo, auditService, snapshots, updates, auditLogs };
  }

  test('recordManualMetrics successfully records manual snapshot and emits audit log', async () => {
    const initialSubmission = {
      id: 'sub_fb_manual_123',
      platform: 'FACEBOOK',
      status: 'APPROVED',
      url: 'https://www.facebook.com/reel/1029384756/',
      verifiedAt: null
    };

    const { repo, auditService, snapshots, updates, auditLogs } = createMockRepo(initialSubmission);
    const service = new AdminSubmissionService(repo, auditService);

    const actor = { discordId: 'staff_moderator_99', userId: 'user_mod_99' };
    const result = await service.recordManualMetrics(
      'sub_fb_manual_123',
      {
        views: '25400',
        likes: '1230',
        comments: '88',
        shares: '14',
        notes: 'Verified via creator Facebook Reel interface'
      },
      actor
    );

    // Verify snapshot creation
    assert.ok(result.snapshot);
    assert.equal(result.snapshot.source, 'MANUAL');
    assert.equal(result.snapshot.views, 25400n);
    assert.equal(result.snapshot.likes, 1230n);
    assert.equal(result.snapshot.comments, 88n);
    assert.equal(result.snapshot.shares, 14n);
    assert.equal(result.snapshot.metadata.enteredBy, 'STAFF_MANUAL_VERIFICATION');
    assert.equal(result.snapshot.metadata.actorDiscordId, 'staff_moderator_99');
    assert.equal(result.snapshot.metadata.notes, 'Verified via creator Facebook Reel interface');

    // Verify submission update
    assert.equal(result.submission.lastAvailabilityStatus, 'MANUALLY_VERIFIED');
    assert.ok(result.submission.verifiedAt instanceof Date);

    // Verify audit log
    assert.equal(auditLogs.length, 1);
    const log = auditLogs[0];
    assert.equal(log.action, 'SUBMISSION_MANUAL_METRICS');
    assert.equal(log.entityType, 'SUBMISSION');
    assert.equal(log.entityId, 'sub_fb_manual_123');
    assert.equal(log.actorDiscordId, 'staff_moderator_99');
    assert.equal(log.newState.views, '25400');
    assert.equal(log.newState.likes, '1230');
    assert.equal(log.newState.snapshotId, result.snapshot.id);
    assert.equal(log.reason, 'Verified via creator Facebook Reel interface');
  });

  test('recordManualMetrics validates views requirement and rejects invalid inputs', async () => {
    const initialSubmission = {
      id: 'sub_fb_test_invalid',
      platform: 'FACEBOOK',
      status: 'APPROVED',
      url: 'https://www.facebook.com/reel/1029384756/'
    };

    const { repo, auditService } = createMockRepo(initialSubmission);
    const service = new AdminSubmissionService(repo, auditService);
    const actor = { discordId: 'staff_1' };

    // Empty views
    await assert.rejects(
      () => service.recordManualMetrics('sub_fb_test_invalid', { views: '' }, actor),
      /Valid views count \(>= 0\) is required/
    );

    // Non-numeric views
    await assert.rejects(
      () => service.recordManualMetrics('sub_fb_test_invalid', { views: 'not_a_number' }, actor),
      /Valid views count \(>= 0\) is required/
    );

    // Negative views
    await assert.rejects(
      () => service.recordManualMetrics('sub_fb_test_invalid', { views: '-50' }, actor),
      /Valid views count \(>= 0\) is required/
    );
  });

  test('recordManualMetrics handles optional likes and comments as null when omitted', async () => {
    const initialSubmission = {
      id: 'sub_fb_partial',
      platform: 'FACEBOOK',
      status: 'APPROVED',
      url: 'https://www.facebook.com/reel/1029384756/'
    };

    const { repo, auditService } = createMockRepo(initialSubmission);
    const service = new AdminSubmissionService(repo, auditService);
    const actor = { discordId: 'staff_1' };

    const result = await service.recordManualMetrics(
      'sub_fb_partial',
      { views: '1000' }, // likes, comments, shares omitted
      actor
    );

    assert.equal(result.snapshot.views, 1000n);
    assert.equal(result.snapshot.likes, null);
    assert.equal(result.snapshot.comments, null);
    assert.equal(result.snapshot.shares, null);
  });
});

describe('Staff UI & Embed Boundary Presentation', () => {
  test('buildStaffSubmissionDetailEmbed renders manual verification state for Facebook without snapshot', () => {
    const sub = {
      id: 'sub_fb_empty',
      platform: 'FACEBOOK',
      status: 'APPROVED',
      url: 'https://www.facebook.com/reel/1029384756/',
      userId: 'user_1',
      campaignId: 'camp_1',
      snapshots: []
    };

    const embed = buildStaffSubmissionDetailEmbed(sub);
    const metricsField = embed.data.fields.find((f) => f.name === '📊 Current Metrics');
    const trackingField = embed.data.fields.find((f) => f.name === '📡 Tracking & Availability');

    assert.ok(metricsField);
    assert.match(metricsField.value, /Awaiting staff verification/);
    assert.match(metricsField.value, /Manual Entry Required/);

    assert.ok(trackingField);
    assert.match(trackingField.value, /MANUAL_VERIFICATION_ONLY/);
    assert.match(trackingField.value, /Hourly polling disabled/);
  });

  test('buildStaffSubmissionDetailEmbed renders verified snapshot with MANUAL source badge', () => {
    const sub = {
      id: 'sub_fb_with_snap',
      platform: 'FACEBOOK',
      status: 'APPROVED',
      url: 'https://www.facebook.com/reel/1029384756/',
      userId: 'user_1',
      campaignId: 'camp_1',
      snapshots: [
        {
          views: 15420n,
          likes: 830n,
          comments: 24n,
          source: 'MANUAL',
          capturedAt: new Date()
        }
      ]
    };

    const embed = buildStaffSubmissionDetailEmbed(sub);
    const metricsField = embed.data.fields.find((f) => f.name === '📊 Current Metrics');

    assert.ok(metricsField);
    assert.match(metricsField.value, /15,420/);
    assert.match(metricsField.value, /830/);
    assert.match(metricsField.value, /✍️ MANUAL/);
  });

  test('buildStaffSubmissionDetailEmbed renders provider unavailable state for TikTok', () => {
    const sub = {
      id: 'sub_tt_empty',
      platform: 'TIKTOK',
      status: 'APPROVED',
      url: 'https://www.tiktok.com/@user/video/7123456789012345678',
      userId: 'user_1',
      campaignId: 'camp_1',
      snapshots: []
    };

    const embed = buildStaffSubmissionDetailEmbed(sub);
    const metricsField = embed.data.fields.find((f) => f.name === '📊 Current Metrics');
    const trackingField = embed.data.fields.find((f) => f.name === '📡 Tracking & Availability');

    assert.ok(metricsField);
    assert.match(metricsField.value, /Official API unavailable/);
    assert.match(metricsField.value, /Partner Integration Required/);

    assert.ok(trackingField);
    assert.match(trackingField.value, /PROVIDER_UNAVAILABLE/);
    assert.match(trackingField.value, /No automatic polling/);
  });

  test('buildStaffSubmissionAnalyticsEmbed marks snapshots as MANUAL vs AUTO', () => {
    const analyticsData = {
      submission: { id: 'sub_fb_analytics', platform: 'FACEBOOK', status: 'APPROVED' },
      snapshots: [
        {
          capturedAt: new Date('2026-09-23T10:00:00Z'),
          views: 20000n,
          likes: 1000n,
          comments: 50n,
          shares: 10n,
          source: 'MANUAL'
        },
        {
          capturedAt: new Date('2026-09-23T09:00:00Z'),
          views: 18000n,
          likes: 900n,
          comments: 40n,
          shares: 5n,
          source: 'PROVIDER'
        }
      ],
      page: 1,
      totalPages: 1,
      totalSnapshots: 2,
      totalViewsGained: 2000
    };

    const embed = buildStaffSubmissionAnalyticsEmbed(analyticsData);
    assert.ok(embed.data.description);
    assert.match(embed.data.description, /\[✍️ MANUAL\]/);
    assert.match(embed.data.description, /\[🤖 AUTO\]/);
  });

  test('buildStaffSubmissionDetailRow includes Enter Metrics button for Facebook and respects row limits', () => {
    const fbSub = {
      id: 'sub_fb_row_test',
      status: 'UNDER_REVIEW',
      url: 'https://www.facebook.com/reel/1029384756/',
      platform: 'FACEBOOK'
    };

    const rows = buildStaffSubmissionDetailRow(fbSub);
    assert.equal(rows.length, 2);

    const row1Components = rows[0].components;
    // Row 1 max is 5 in Discord
    assert.ok(row1Components.length <= 5, 'Row 1 exceeds Discord 5 button limit');

    // Verify Enter Metrics button customId and label
    const enterMetricsBtn = row1Components.find(
      (c) => c.data?.custom_id === staffIds.subManualMetrics('sub_fb_row_test')
    );
    assert.ok(enterMetricsBtn, 'Enter Metrics button not found in Row 1');
    assert.match(enterMetricsBtn.data.label, /Enter Metrics/);
  });

  test('buildStaffManualMetricsModal contains all 5 required/optional fields', () => {
    const modal = buildStaffManualMetricsModal('sub_modal_test');
    assert.equal(modal.data.custom_id, `${STAFF_COMPONENTS.SUB_MANUAL_MODAL}:sub_modal_test`);

    const fields = modal.components.map((row) => row.components[0].data);
    assert.equal(fields.length, 5);

    const viewsField = fields.find((f) => f.custom_id === 'views');
    assert.ok(viewsField);
    assert.equal(viewsField.required, true);

    const likesField = fields.find((f) => f.custom_id === 'likes');
    assert.ok(likesField);
    assert.equal(likesField.required, false);

    const commentsField = fields.find((f) => f.custom_id === 'comments');
    assert.ok(commentsField);
    assert.equal(commentsField.required, false);

    const sharesField = fields.find((f) => f.custom_id === 'shares');
    assert.ok(sharesField);
    assert.equal(sharesField.required, false);

    const notesField = fields.find((f) => f.custom_id === 'notes');
    assert.ok(notesField);
    assert.equal(notesField.required, false);
  });
});
