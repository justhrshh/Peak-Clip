import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';

import { parseAndNormalizeUrl } from '../src/modules/submissions/url.parser.js';
import { parseIsoDuration } from '../src/providers/youtube/youtube.provider.js';
import { getProviderForPlatform, facebookProvider, tiktokProvider, instagramProvider, youtubeProvider } from '../src/providers/index.js';
import { FacebookProvider } from '../src/providers/facebook/facebook.provider.js';
import { PLATFORM_CAPABILITIES, hasProviderCapability, getProviderCapabilities } from '../src/providers/capabilities.js';
import {
  InvalidSubmissionUrlError,
  UnsupportedPlatformError,
  PlatformNotAllowedError,
  DuplicateSubmissionError,
  ClipDurationOutOfRangeError,
  CampaignBudgetExhaustedSubmissionError
} from '../src/modules/submissions/submission.errors.js';
import { SubmissionService } from '../src/modules/submissions/submission.service.js';
import { VerificationService } from '../src/modules/verification/verification.service.js';
import {
  buildCampaignPickerForSubmit,
  buildSubmitModal
} from '../src/bot/components/submission.components.js';
import {
  buildSubmissionSuccessEmbed,
  buildUserSubmissionsEmbed
} from '../src/bot/embeds/submission.embeds.js';

// In-memory test environment factory
function createTestEnvironment() {
  const users = new Map();
  const campaigns = new Map();
  const memberships = new Map();
  const submissions = new Map();
  const verifications = new Map();
  const snapshots = new Map();
  const signals = new Map();

  const userRepo = {
    async findById(id) {
      return users.get(id) || null;
    }
  };

  const campRepo = {
    async findById(id) {
      return campaigns.get(id) || null;
    },
    async findMembership(userId, campaignId) {
      return memberships.get(`${userId}_${campaignId}`) || null;
    }
  };

  const subRepo = {
    async createSubmission(data) {
      const key = `${data.userId}_${data.campaignId}_${data.normalizedUrl}`;
      if (submissions.has(key)) {
        const err = new Error('Unique constraint failed on (userId, campaignId, normalizedUrl)');
        err.code = 'P2002';
        throw err;
      }
      const record = {
        id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        status: 'PENDING_VERIFICATION',
        submittedAt: new Date(),
        updatedAt: new Date(),
        verifiedAt: null,
        rejectionReason: null,
        ...data
      };
      submissions.set(record.id, record);
      submissions.set(key, record);
      return { ...record };
    },
    async getSubmissionById(id) {
      return submissions.get(id) || null;
    },
    async findDuplicateSubmission(userId, campaignId, normalizedUrl) {
      return submissions.get(`${userId}_${campaignId}_${normalizedUrl}`) || null;
    },
    async updateSubmissionStatus(id, status, details = {}) {
      const sub = submissions.get(id);
      if (!sub) return null;
      Object.assign(sub, { status, ...details, updatedAt: new Date() });
      return { ...sub };
    },
    async updateSubmission(id, data) {
      const sub = submissions.get(id);
      if (!sub) return null;
      Object.assign(sub, { ...data, updatedAt: new Date() });
      return { ...sub };
    }
  };

  const verRepo = {
    async getVerificationBySubmissionId(submissionId) {
      return verifications.get(submissionId) || null;
    },
    async upsertVerification(data) {
      const existing = verifications.get(data.submissionId) || {};
      const record = {
        id: existing.id || `ver_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        ...existing,
        ...data,
        updatedAt: new Date()
      };
      verifications.set(data.submissionId, record);
      return { ...record };
    },
    async addVerificationSignals(verId, sigs) {
      const current = signals.get(verId) || [];
      signals.set(verId, [...current, ...sigs]);
      return sigs;
    },
    async getHistoricalSnapshots(submissionId) {
      return Array.from(snapshots.values()).filter((s) => s.submissionId === submissionId);
    },
    async createMetricSnapshot(data) {
      const id = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const record = { id, capturedAt: new Date(), ...data };
      snapshots.set(id, record);
      return { ...record };
    }
  };

  const submissionService = new SubmissionService(subRepo, campRepo, userRepo);
  const verificationService = new VerificationService({
    verificationRepo: verRepo,
    submissionRepo: subRepo
  });

  return {
    users,
    campaigns,
    memberships,
    submissions,
    verifications,
    snapshots,
    userRepo,
    campRepo,
    subRepo,
    verRepo,
    submissionService,
    verificationService
  };
}

describe('Phase 10B — Submission Requirements, Multi-Platform Boundaries & Retention Policy', () => {
  // =========================================================================
  // 1. SUBMISSION PLATFORM ENFORCEMENT & URL PARSER
  // =========================================================================
  describe('1. Platform Enforcement & URL Parsing', () => {
    test('parses and normalizes standard YouTube watch and Shorts URLs', () => {
      const p1 = parseAndNormalizeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      assert.equal(p1.platform, 'YOUTUBE');
      assert.equal(p1.contentId, 'dQw4w9WgXcQ');
      assert.equal(p1.normalizedUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

      const p2 = parseAndNormalizeUrl('https://youtube.com/shorts/abcdef12345?si=tracking');
      assert.equal(p2.platform, 'YOUTUBE');
      assert.equal(p2.contentId, 'abcdef12345');
      assert.equal(p2.normalizedUrl, 'https://www.youtube.com/shorts/abcdef12345');
    });

    test('parses and normalizes TikTok web and shortlink URLs', () => {
      const p1 = parseAndNormalizeUrl('https://www.tiktok.com/@creator/video/7123456789012345678');
      assert.equal(p1.platform, 'TIKTOK');
      assert.equal(p1.contentId, '7123456789012345678');

      const p2 = parseAndNormalizeUrl('https://vm.tiktok.com/ZM8abc123/');
      assert.equal(p2.platform, 'TIKTOK');
      assert.equal(p2.contentId, 'ZM8abc123');
    });

    test('parses and normalizes Instagram Reel URLs', () => {
      const p = parseAndNormalizeUrl('https://www.instagram.com/reel/C-xyz123abc/?igsh=tracking');
      assert.equal(p.platform, 'INSTAGRAM');
      assert.equal(p.contentId, 'C-xyz123abc');
      assert.equal(p.normalizedUrl, 'https://www.instagram.com/reel/C-xyz123abc/');
    });

    test('parses and normalizes Facebook Reel, Watch, and fb.watch URLs', () => {
      const p1 = parseAndNormalizeUrl('https://www.facebook.com/reel/123456789012345');
      assert.equal(p1.platform, 'FACEBOOK');
      assert.equal(p1.contentId, '123456789012345');
      assert.equal(p1.normalizedUrl, 'https://www.facebook.com/reel/123456789012345/');

      const p2 = parseAndNormalizeUrl('https://fb.watch/shortcode123/');
      assert.equal(p2.platform, 'FACEBOOK');
      assert.equal(p2.contentId, 'shortcode123');
      assert.equal(p2.normalizedUrl, 'https://fb.watch/shortcode123/');

      const p3 = parseAndNormalizeUrl('https://www.facebook.com/watch/?v=987654321');
      assert.equal(p3.platform, 'FACEBOOK');
      assert.equal(p3.contentId, '987654321');
    });

    test('throws InvalidSubmissionUrlError for malformed or unsupported protocols', () => {
      assert.throws(() => parseAndNormalizeUrl('not-a-url'), InvalidSubmissionUrlError);
      assert.throws(() => parseAndNormalizeUrl('ftp://youtube.com/watch?v=1234567890'), InvalidSubmissionUrlError);
      assert.throws(() => parseAndNormalizeUrl(''), InvalidSubmissionUrlError);
    });

    test('throws UnsupportedPlatformError for unrecognized domain', () => {
      assert.throws(() => parseAndNormalizeUrl('https://twitter.com/user/status/12345'), UnsupportedPlatformError);
      assert.throws(() => parseAndNormalizeUrl('https://vimeo.com/12345678'), UnsupportedPlatformError);
    });

    test('enforces campaign allowed-platform sets: accepts allowed, rejects disallowed', async () => {
      const env = createTestEnvironment();
      const userId = 'usr_clipper';
      const campId = 'cmp_yt_tiktok';

      env.users.set(userId, { id: userId, status: 'ACTIVE' });
      env.campaigns.set(campId, {
        id: campId,
        name: 'YT + TikTok Only',
        status: 'ACTIVE',
        startsAt: new Date(Date.now() - 86400000),
        endsAt: new Date(Date.now() + 86400000),
        requirements: { allowedPlatforms: ['youtube', 'tiktok'] }
      });
      env.memberships.set(`${userId}_${campId}`, { id: 'mem_1', userId, campaignId: campId, status: 'ACTIVE' });

      // Allowed YouTube
      const ytSub = await env.submissionService.createSubmission({
        userId,
        campaignId: campId,
        rawUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
      });
      assert.equal(ytSub.platform, 'YOUTUBE');

      // Allowed TikTok
      const ttSub = await env.submissionService.createSubmission({
        userId,
        campaignId: campId,
        rawUrl: 'https://www.tiktok.com/@creator/video/7123456789012345678'
      });
      assert.equal(ttSub.platform, 'TIKTOK');

      // Disallowed Instagram -> rejected with clean user-facing error
      await assert.rejects(
        () =>
          env.submissionService.createSubmission({
            userId,
            campaignId: campId,
            rawUrl: 'https://www.instagram.com/reel/C-xyz123abc/'
          }),
        (err) => {
          assert.ok(err instanceof PlatformNotAllowedError);
          assert.match(err.message, /Instagram submissions aren't allowed for this campaign/i);
          return true;
        }
      );

      // Disallowed Facebook -> rejected with clean user-facing error
      await assert.rejects(
        () =>
          env.submissionService.createSubmission({
            userId,
            campaignId: campId,
            rawUrl: 'https://www.facebook.com/reel/123456789012345'
          }),
        (err) => {
          assert.ok(err instanceof PlatformNotAllowedError);
          assert.match(err.message, /Facebook submissions aren't allowed for this campaign/i);
          return true;
        }
      );
    });
  });

  // =========================================================================
  // 2. PLATFORM PROVIDER BOUNDARIES & ZERO FAKE METRICS
  // =========================================================================
  describe('2. Platform Provider Boundaries', () => {
    test('Facebook provider returns DATA_UNAVAILABLE and never invents metrics', async () => {
      const p = new FacebookProvider(null);
      const metrics = await p.getCurrentMetrics('fb_12345');
      assert.equal(metrics.status, 'DATA_UNAVAILABLE');
      assert.equal(metrics.views, null);
      assert.equal(metrics.likes, null);
      assert.equal(metrics.comments, null);
      assert.equal(metrics.shares, null);
      assert.equal(metrics.durationSeconds, null);
      assert.equal(metrics.availability.views, 'TEMPORARILY_UNAVAILABLE');
      assert.equal(metrics.availability.duration, 'NOT_SUPPORTED');
    });

    test('Facebook provider getAvailability returns DATA_UNAVAILABLE', async () => {
      const p = new FacebookProvider(null);
      const avail = await p.getAvailability('fb_12345');
      assert.equal(avail.status, 'DATA_UNAVAILABLE');
      assert.equal(avail.isAvailable, true);
    });

    test('TikTok and Instagram boundary providers return DATA_UNAVAILABLE with null metrics', async () => {
      const tt = await tiktokProvider.getCurrentMetrics('tt_123');
      assert.equal(tt.status, 'DATA_UNAVAILABLE');
      assert.equal(tt.views, null);

      const ig = await instagramProvider.getCurrentMetrics('ig_123');
      assert.equal(ig.status, 'DATA_UNAVAILABLE');
      assert.equal(ig.views, null);
    });

    test('provider registry resolves Facebook provider cleanly', () => {
      const p = getProviderForPlatform('FACEBOOK');
      assert.equal(p.platform, 'FACEBOOK');
    });

    test('capabilities matrix exposes explicit capabilities per platform', () => {
      assert.equal(hasProviderCapability('YOUTUBE', 'fetchViews'), true);
      assert.equal(hasProviderCapability('YOUTUBE', 'fetchDuration'), true);
      assert.equal(hasProviderCapability('TIKTOK', 'fetchViews'), true);
      assert.equal(hasProviderCapability('TIKTOK', 'fetchDuration'), true);
      assert.equal(hasProviderCapability('INSTAGRAM', 'fetchDuration'), false);
      assert.equal(hasProviderCapability('FACEBOOK', 'fetchDuration'), true);
    });
  });

  // =========================================================================
  // 3. CLIP DURATION VERIFICATION & CAPABILITY
  // =========================================================================
  describe('3. Clip Duration Verification', () => {
    test('parseIsoDuration correctly converts ISO 8601 strings to seconds', () => {
      assert.equal(parseIsoDuration('PT6S'), 6);
      assert.equal(parseIsoDuration('PT7S'), 7);
      assert.equal(parseIsoDuration('PT30S'), 30);
      assert.equal(parseIsoDuration('PT1M'), 60);
      assert.equal(parseIsoDuration('PT1M15S'), 75);
      assert.equal(parseIsoDuration('PT2M'), 120);
      assert.equal(parseIsoDuration('PT2M1S'), 121);
      assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
      assert.equal(parseIsoDuration('invalid'), null);
      assert.equal(parseIsoDuration(null), null);
    });

    test('rejects 6s clip when campaign enforces 7s minimum', async () => {
      const env = createTestEnvironment();
      const sub = {
        id: 'sub_dur_6',
        platform: 'YOUTUBE',
        url: 'https://www.youtube.com/watch?v=short6s',
        requirementsSnapshot: { minClipDurationSeconds: 7, maxClipDurationSeconds: 120 }
      };
      env.submissions.set(sub.id, sub);

      env.verificationService.providerResolver = () => ({
        async getCurrentMetrics() {
          return {
            isAvailable: true,
            views: 5000n,
            likes: 200n,
            comments: 10n,
            shares: null,
            durationSeconds: 6,
            status: 'AVAILABLE',
            availability: { views: 'AVAILABLE', duration: 'AVAILABLE' }
          };
        }
      });

      const result = await env.verificationService.runVerification(sub.id);
      assert.equal(result.submissionStatus, 'REJECTED');
      assert.match(result.reason, /accepts clips between 7 and 120 seconds/i);
      assert.match(result.reason, /duration was 6 seconds/i);
    });

    test('accepts 7s, 30s, and 120s clips within default bounds', async () => {
      for (const dur of [7, 30, 120]) {
        const env = createTestEnvironment();
        const paddedDur = String(dur).padStart(3, '0');
        const sub = {
          id: `sub_dur_${dur}`,
          platform: 'YOUTUBE',
          url: `https://www.youtube.com/watch?v=dur_${paddedDur}_abc`,
          requirementsSnapshot: { minClipDurationSeconds: 7, maxClipDurationSeconds: 120 }
        };
        env.submissions.set(sub.id, sub);

        env.verificationService.providerResolver = () => ({
          async getCurrentMetrics() {
            return {
              isAvailable: true,
              views: 10000n,
              likes: 500n,
              comments: 20n,
              shares: null,
              durationSeconds: dur,
              status: 'AVAILABLE',
              availability: { views: 'AVAILABLE', duration: 'AVAILABLE' },
              publishedAt: new Date().toISOString()
            };
          }
        });

        const result = await env.verificationService.runVerification(sub.id);
        assert.equal(result.submissionStatus, 'APPROVED');
        assert.equal(result.durationSeconds, dur);
      }
    });

    test('rejects 121s clip when campaign enforces 120s maximum', async () => {
      const env = createTestEnvironment();
      const sub = {
        id: 'sub_dur_121',
        platform: 'YOUTUBE',
        url: 'https://www.youtube.com/watch?v=dur_121_abcd',
        requirementsSnapshot: { minClipDurationSeconds: 7, maxClipDurationSeconds: 120 }
      };
      env.submissions.set(sub.id, sub);

      env.verificationService.providerResolver = () => ({
        async getCurrentMetrics() {
          return {
            isAvailable: true,
            views: 5000n,
            likes: 200n,
            comments: 10n,
            shares: null,
            durationSeconds: 121,
            status: 'AVAILABLE',
            availability: { views: 'AVAILABLE', duration: 'AVAILABLE' }
          };
        }
      });

      const result = await env.verificationService.runVerification(sub.id);
      assert.equal(result.submissionStatus, 'REJECTED');
      assert.match(result.reason, /accepts clips between 7 and 120 seconds/i);
      assert.match(result.reason, /duration was 121 seconds/i);
    });

    test('campaign duration override (15s–60s) is strictly respected', async () => {
      const env = createTestEnvironment();
      const snapshot = { minClipDurationSeconds: 15, maxClipDurationSeconds: 60 };

      // 14s -> rejected
      const sub1 = { id: 'sub_14s', platform: 'YOUTUBE', url: 'https://youtube.com/watch?v=dur_014_abcd', requirementsSnapshot: snapshot };
      env.submissions.set(sub1.id, sub1);
      env.verificationService.providerResolver = () => ({
        async getCurrentMetrics() {
          return { isAvailable: true, views: 5000n, likes: 200n, comments: 10n, shares: null, durationSeconds: 14, status: 'AVAILABLE', availability: { views: 'AVAILABLE', duration: 'AVAILABLE' } };
        }
      });
      const res1 = await env.verificationService.runVerification(sub1.id);
      assert.equal(res1.submissionStatus, 'REJECTED');

      // 30s -> accepted
      const sub2 = { id: 'sub_30s', platform: 'YOUTUBE', url: 'https://youtube.com/watch?v=dur_030_abcd', requirementsSnapshot: snapshot };
      env.submissions.set(sub2.id, sub2);
      env.verificationService.providerResolver = () => ({
        async getCurrentMetrics() {
          return { isAvailable: true, views: 5000n, likes: 200n, comments: 10n, shares: null, durationSeconds: 30, status: 'AVAILABLE', availability: { views: 'AVAILABLE', duration: 'AVAILABLE' }, publishedAt: new Date().toISOString() };
        }
      });
      const res2 = await env.verificationService.runVerification(sub2.id);
      assert.equal(res2.submissionStatus, 'APPROVED');

      // 61s -> rejected
      const sub3 = { id: 'sub_61s', platform: 'YOUTUBE', url: 'https://youtube.com/watch?v=dur_061_abcd', requirementsSnapshot: snapshot };
      env.submissions.set(sub3.id, sub3);
      env.verificationService.providerResolver = () => ({
        async getCurrentMetrics() {
          return { isAvailable: true, views: 5000n, likes: 200n, comments: 10n, shares: null, durationSeconds: 61, status: 'AVAILABLE', availability: { views: 'AVAILABLE', duration: 'AVAILABLE' } };
        }
      });
      const res3 = await env.verificationService.runVerification(sub3.id);
      assert.equal(res3.submissionStatus, 'REJECTED');
    });

    test('unavailable duration on boundary provider does NOT fabricate 0 or pass/fail falsely', async () => {
      const env = createTestEnvironment();
      const sub = {
        id: 'sub_boundary_tt',
        platform: 'TIKTOK',
        url: 'https://www.tiktok.com/@creator/video/1234567890',
        requirementsSnapshot: { minClipDurationSeconds: 7, maxClipDurationSeconds: 120 }
      };
      env.submissions.set(sub.id, sub);

      const result = await env.verificationService.runVerification(sub.id);
      const savedSub = env.submissions.get(sub.id);

      assert.equal(savedSub.durationSeconds, null);
      assert.equal(savedSub.durationStatus, 'NOT_SUPPORTED');
    });
  });

  // =========================================================================
  // 4. SUBMISSION REQUIREMENTS SNAPSHOT & HISTORICAL LOCKING
  // =========================================================================
  describe('4. Submission Requirements Snapshot', () => {
    test('snapshots full campaign rules at submission creation time', async () => {
      const env = createTestEnvironment();
      const userId = 'usr_alice';
      const campId = 'cmp_snap_test';

      env.users.set(userId, { id: userId, status: 'ACTIVE' });
      env.campaigns.set(campId, {
        id: campId,
        name: 'Snap Test Camp',
        status: 'ACTIVE',
        payRate: new Prisma.Decimal('2.50'),
        creatorEarningCap: new Prisma.Decimal('500.00'),
        minClipDurationSeconds: 10,
        maxClipDurationSeconds: 90,
        retentionRequired: true,
        retentionDays: 14,
        startsAt: new Date(Date.now() - 86400000),
        endsAt: new Date(Date.now() + 86400000),
        requirements: { allowedPlatforms: ['youtube', 'tiktok'] }
      });
      env.memberships.set(`${userId}_${campId}`, { id: 'mem_1', userId, campaignId: campId, status: 'ACTIVE' });

      const sub = await env.submissionService.createSubmission({
        userId,
        campaignId: campId,
        rawUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
      });

      assert.ok(sub.requirementsSnapshot);
      assert.equal(sub.requirementsSnapshot.minClipDurationSeconds, 10);
      assert.equal(sub.requirementsSnapshot.maxClipDurationSeconds, 90);
      assert.equal(sub.requirementsSnapshot.retentionRequired, true);
      assert.equal(sub.requirementsSnapshot.retentionDays, 14);
      assert.equal(sub.requirementsSnapshot.payRate, '2.5');
      assert.equal(sub.requirementsSnapshot.creatorEarningCap, '500');
      assert.deepEqual(sub.requirementsSnapshot.allowedPlatforms, ['YOUTUBE', 'TIKTOK']);
    });

    test('subsequent campaign edits do NOT alter the locked submission requirements snapshot', async () => {
      const env = createTestEnvironment();
      const userId = 'usr_bob';
      const campId = 'cmp_mutate_test';

      const camp = {
        id: campId,
        name: 'Initial Camp',
        status: 'ACTIVE',
        payRate: new Prisma.Decimal('1.00'),
        creatorEarningCap: new Prisma.Decimal('600.00'),
        minClipDurationSeconds: 7,
        maxClipDurationSeconds: 120,
        retentionRequired: false,
        retentionDays: null,
        startsAt: new Date(Date.now() - 86400000),
        endsAt: new Date(Date.now() + 86400000),
        requirements: { allowedPlatforms: ['youtube'] }
      };
      env.users.set(userId, { id: userId, status: 'ACTIVE' });
      env.campaigns.set(campId, camp);
      env.memberships.set(`${userId}_${campId}`, { id: 'mem_1', userId, campaignId: campId, status: 'ACTIVE' });

      const sub = await env.submissionService.createSubmission({
        userId,
        campaignId: campId,
        rawUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
      });

      // Admin modifies campaign afterwards
      camp.payRate = new Prisma.Decimal('5.00');
      camp.minClipDurationSeconds = 30;
      camp.retentionRequired = true;
      camp.retentionDays = 60;

      // Submission snapshot remains intact at original values
      const loaded = env.submissions.get(sub.id);
      assert.equal(loaded.requirementsSnapshot.payRate, '1');
      assert.equal(loaded.requirementsSnapshot.minClipDurationSeconds, 7);
      assert.equal(loaded.requirementsSnapshot.retentionRequired, false);
    });
  });

  // =========================================================================
  // 5. RETENTION POLICY & VIDEO AVAILABILITY MONITORING
  // =========================================================================
  describe('5. Retention Policy & Video Availability', () => {
    test('submission without retention requirement defaults to NOT_REQUIRED', async () => {
      const env = createTestEnvironment();
      const userId = 'usr_c1';
      const campId = 'cmp_no_ret';

      env.users.set(userId, { id: userId, status: 'ACTIVE' });
      env.campaigns.set(campId, {
        id: campId,
        name: 'No Retention Camp',
        status: 'ACTIVE',
        retentionRequired: false,
        startsAt: new Date(Date.now() - 86400000),
        endsAt: new Date(Date.now() + 86400000),
        requirements: { allowedPlatforms: ['youtube'] }
      });
      env.memberships.set(`${userId}_${campId}`, { id: 'mem_1', userId, campaignId: campId, status: 'ACTIVE' });

      const sub = await env.submissionService.createSubmission({
        userId,
        campaignId: campId,
        rawUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
      });

      assert.equal(sub.retentionRequired, false);
      assert.equal(sub.retentionStatus, 'NOT_REQUIRED');
    });

    test('approval calculates exact retention deadline for 7, 30, and 45 days', async () => {
      for (const days of [7, 30, 45]) {
        const env = createTestEnvironment();
        const sub = {
          id: `sub_ret_${days}`,
          platform: 'YOUTUBE',
          url: 'https://youtube.com/watch?v=ret_test',
          retentionRequired: true,
          retentionDays: days,
          retentionStatus: 'PENDING_CHECK',
          requirementsSnapshot: { retentionRequired: true, retentionDays: days }
        };
        env.submissions.set(sub.id, sub);

        env.verificationService.providerResolver = () => ({
          async getCurrentMetrics() {
            return {
              isAvailable: true,
              views: 1000n,
              likes: 50n,
              comments: 5n,
              shares: null,
              durationSeconds: 30,
              status: 'AVAILABLE',
              availability: { views: 'AVAILABLE', duration: 'AVAILABLE' },
              publishedAt: new Date().toISOString()
            };
          }
        });

        const before = Date.now();
        const result = await env.verificationService.runVerification(sub.id);
        const after = Date.now();

        assert.equal(result.submissionStatus, 'APPROVED');
        assert.equal(result.retentionStatus, 'ACTIVE');

        const savedSub = env.submissions.get(sub.id);
        assert.equal(savedSub.retentionStatus, 'ACTIVE');
        assert.ok(savedSub.approvedAt);
        assert.ok(savedSub.retentionDeadline);

        const expectedMs = days * 86400000;
        const actualDiff = new Date(savedSub.retentionDeadline).getTime() - new Date(savedSub.approvedAt).getTime();
        assert.equal(actualDiff, expectedMs);
      }
    });

    test('availability check detects deleted video before deadline and transitions to VIOLATED', async () => {
      const env = createTestEnvironment();
      const approvedAt = new Date(Date.now() - 86400000); // approved 1 day ago
      const deadline = new Date(Date.now() + 86400000 * 6); // deadline 6 days in future

      const sub = {
        id: 'sub_violated_test',
        platform: 'YOUTUBE',
        url: 'https://youtube.com/watch?v=deleted_clip',
        retentionRequired: true,
        retentionDays: 7,
        retentionStatus: 'ACTIVE',
        approvedAt,
        retentionDeadline: deadline
      };
      env.submissions.set(sub.id, sub);

      // Provider returns unavailable / deleted
      env.verificationService.providerResolver = () => ({
        async getAvailability() {
          return {
            isAvailable: false,
            status: 'UNAVAILABLE',
            reason: 'Video was deleted by creator'
          };
        }
      });

      const check = await env.verificationService.checkSubmissionAvailability(sub.id);
      assert.equal(check.isAvailable, false);
      assert.equal(check.retentionStatus, 'VIOLATED');

      const updated = env.submissions.get(sub.id);
      assert.equal(updated.retentionStatus, 'VIOLATED');
      assert.ok(updated.retentionViolatedAt);
      assert.match(updated.retentionViolationReason, /deleted by creator/i);
    });

    test('availability check after retention deadline passes transitions to FULFILLED', async () => {
      const env = createTestEnvironment();
      const approvedAt = new Date(Date.now() - 86400000 * 10); // approved 10 days ago
      const deadline = new Date(Date.now() - 86400000 * 3); // deadline was 3 days ago

      const sub = {
        id: 'sub_fulfilled_test',
        platform: 'YOUTUBE',
        url: 'https://youtube.com/watch?v=live_clip',
        retentionRequired: true,
        retentionDays: 7,
        retentionStatus: 'ACTIVE',
        approvedAt,
        retentionDeadline: deadline
      };
      env.submissions.set(sub.id, sub);

      // Video is still live
      env.verificationService.providerResolver = () => ({
        async getAvailability() {
          return { isAvailable: true, status: 'AVAILABLE' };
        }
      });

      const check = await env.verificationService.checkSubmissionAvailability(sub.id);
      assert.equal(check.isAvailable, true);
      assert.equal(check.retentionStatus, 'FULFILLED');

      const updated = env.submissions.get(sub.id);
      assert.equal(updated.retentionStatus, 'FULFILLED');
    });
  });

  // =========================================================================
  // 6. DUPLICATES & BUDGET EXHAUSTION
  // =========================================================================
  describe('6. Duplicate Protection & Campaign Completion Guard', () => {
    test('same creator + same campaign + same normalized URL is rejected', async () => {
      const env = createTestEnvironment();
      const userId = 'usr_dup';
      const campId = 'cmp_dup';

      env.users.set(userId, { id: userId, status: 'ACTIVE' });
      env.campaigns.set(campId, {
        id: campId,
        name: 'Dup Camp',
        status: 'ACTIVE',
        startsAt: new Date(Date.now() - 86400000),
        endsAt: new Date(Date.now() + 86400000),
        requirements: { allowedPlatforms: ['youtube'] }
      });
      env.memberships.set(`${userId}_${campId}`, { id: 'mem_1', userId, campaignId: campId, status: 'ACTIVE' });

      // First submission succeeds
      await env.submissionService.createSubmission({
        userId,
        campaignId: campId,
        rawUrl: 'https://www.youtube.com/watch?v=same_video_123'
      });

      // Second submission of same video to same campaign throws DuplicateSubmissionError
      await assert.rejects(
        () =>
          env.submissionService.createSubmission({
            userId,
            campaignId: campId,
            rawUrl: 'https://www.youtube.com/watch?v=same_video_123'
          }),
        DuplicateSubmissionError
      );
    });

    test('same creator + different campaign + same normalized URL is allowed', async () => {
      const env = createTestEnvironment();
      const userId = 'usr_cross_camp';
      const camp1 = 'cmp_1';
      const camp2 = 'cmp_2';

      env.users.set(userId, { id: userId, status: 'ACTIVE' });
      const commonCamp = {
        status: 'ACTIVE',
        startsAt: new Date(Date.now() - 86400000),
        endsAt: new Date(Date.now() + 86400000),
        requirements: { allowedPlatforms: ['youtube'] }
      };
      env.campaigns.set(camp1, { id: camp1, name: 'Camp 1', ...commonCamp });
      env.campaigns.set(camp2, { id: camp2, name: 'Camp 2', ...commonCamp });
      env.memberships.set(`${userId}_${camp1}`, { id: 'mem_1', userId, campaignId: camp1, status: 'ACTIVE' });
      env.memberships.set(`${userId}_${camp2}`, { id: 'mem_2', userId, campaignId: camp2, status: 'ACTIVE' });

      const sub1 = await env.submissionService.createSubmission({
        userId,
        campaignId: camp1,
        rawUrl: 'https://www.youtube.com/watch?v=shared_video'
      });
      assert.equal(sub1.campaignId, camp1);

      const sub2 = await env.submissionService.createSubmission({
        userId,
        campaignId: camp2,
        rawUrl: 'https://www.youtube.com/watch?v=shared_video'
      });
      assert.equal(sub2.campaignId, camp2);
    });

    test('submitting to COMPLETED campaign throws CampaignBudgetExhaustedSubmissionError', async () => {
      const env = createTestEnvironment();
      const userId = 'usr_exhaust';
      const campId = 'cmp_exhausted';

      env.users.set(userId, { id: userId, status: 'ACTIVE' });
      env.campaigns.set(campId, {
        id: campId,
        name: 'Fulfilled Camp',
        status: 'COMPLETED',
        startsAt: new Date(Date.now() - 86400000),
        endsAt: new Date(Date.now() + 86400000),
        requirements: { allowedPlatforms: ['youtube'] }
      });
      env.memberships.set(`${userId}_${campId}`, { id: 'mem_1', userId, campaignId: campId, status: 'ACTIVE' });

      await assert.rejects(
        () =>
          env.submissionService.createSubmission({
            userId,
            campaignId: campId,
            rawUrl: 'https://www.youtube.com/watch?v=some_video'
          }),
        (err) => {
          assert.ok(err instanceof CampaignBudgetExhaustedSubmissionError);
          assert.match(err.message, /reached its budget and is no longer accepting submissions/i);
          return true;
        }
      );
    });
  });

  // =========================================================================
  // 7. SUBMISSION UX & COMPONENTS
  // =========================================================================
  describe('7. Submission Discord UX', () => {
    test('buildCampaignPickerForSubmit renders allowed platforms, duration, and CPM', () => {
      const memberships = [
        {
          campaign: {
            id: 'cmp_ux_1',
            name: 'Gaming Showcase',
            clientName: 'Apex Studio',
            payRate: new Prisma.Decimal('1.80'),
            minClipDurationSeconds: 15,
            maxClipDurationSeconds: 60,
            retentionRequired: true,
            retentionDays: 14,
            requirements: { allowedPlatforms: ['youtube', 'tiktok'] }
          }
        }
      ];

      const row = buildCampaignPickerForSubmit(memberships);
      assert.ok(row);
      const menu = row.components[0];
      assert.equal(menu.options.length, 1);
      assert.match(menu.options[0].data.description, /1\.80 CPM/);
      assert.match(menu.options[0].data.description, /15s-60s/);
      assert.match(menu.options[0].data.description, /14d retention/);
    });

    test('buildSubmitModal communicates duration boundaries in input label', () => {
      const camp = {
        minClipDurationSeconds: 10,
        maxClipDurationSeconds: 90,
        requirements: { allowedPlatforms: ['YouTube', 'TikTok'] }
      };

      const modal = buildSubmitModal('cmp_1', 'Apex Gaming', camp);
      assert.ok(modal);
      const input = modal.components[0].components[0];
      assert.match(input.data.label, /10s–90s/);
      assert.match(input.data.placeholder, /YouTube, TikTok/);
    });

    test('buildSubmissionSuccessEmbed includes duration rules and retention', () => {
      const sub = {
        id: 'sub_embed_12345678',
        platform: 'YOUTUBE',
        status: 'PENDING_VERIFICATION',
        normalizedUrl: 'https://youtube.com/watch?v=embed_test'
      };
      const camp = {
        name: 'Apex Gaming',
        clientName: 'Apex Studio',
        minClipDurationSeconds: 7,
        maxClipDurationSeconds: 120,
        retentionRequired: true,
        retentionDays: 30
      };

      const embed = buildSubmissionSuccessEmbed(sub, camp);
      assert.ok(embed);
      const durationField = embed.data.fields.find((f) => f.name.includes('Duration Rules'));
      assert.ok(durationField);
      assert.match(durationField.value, /7s – 120s/);

      const retField = embed.data.fields.find((f) => f.name.includes('Retention'));
      assert.ok(retField);
      assert.match(retField.value, /30 days post-approval/);
    });

    test('buildUserSubmissionsEmbed includes duration and retention status for active retention clip', () => {
      const deadline = new Date('2026-10-21T00:00:00Z');
      const items = [
        {
          id: 'sub_list_1234',
          platform: 'FACEBOOK',
          status: 'APPROVED',
          submittedAt: new Date(),
          normalizedUrl: 'https://facebook.com/reel/12345',
          durationSeconds: 45,
          retentionRequired: true,
          retentionStatus: 'ACTIVE',
          retentionDeadline: deadline,
          campaign: { name: 'Meta Campaign' }
        }
      ];

      const embed = buildUserSubmissionsEmbed({ items, page: 1, totalPages: 1, total: 1 });
      assert.ok(embed);
      const field = embed.data.fields[0];
      assert.match(field.name, /📘 FACEBOOK/);
      assert.match(field.value, /Duration:\*\* 45s/);
      assert.match(field.value, /Retention:\*\* 🟢 Active Retention/);
    });
  });
});
