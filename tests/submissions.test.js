import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseAndNormalizeUrl } from '../src/modules/submissions/url.parser.js';
import {
  InvalidSubmissionUrlError,
  UnsupportedPlatformError,
  CampaignNotJoinableError,
  NotCampaignMemberError,
  DuplicateSubmissionError,
  PlatformNotAllowedError,
  UserNotEligibleError
} from '../src/modules/submissions/submission.errors.js';
import { SubmissionService } from '../src/modules/submissions/submission.service.js';

// Mock in-memory repositories for pure, lightning-fast unit testing
function createMockSubRepo() {
  const submissions = new Map();

  return {
    submissions,
    async createSubmission({ userId, campaignId, platform, url, normalizedUrl, ...rest }) {
      const key = `${userId}_${campaignId}_${normalizedUrl}`;
      if (submissions.has(key)) {
        const error = new Error('Unique constraint failed on the fields: (`user_id`,`campaign_id`,`normalized_url`)');
        error.code = 'P2002';
        throw error;
      }

      const record = {
        id: `sub_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        userId,
        campaignId,
        platform,
        url,
        normalizedUrl,
        status: 'PENDING_VERIFICATION',
        submittedAt: new Date(),
        updatedAt: new Date(),
        verifiedAt: null,
        rejectionReason: null,
        campaign: { id: campaignId, name: 'Mock Campaign', clientName: 'Mock Client' },
        ...rest
      };

      submissions.set(key, record);
      return { ...record };
    },
    async getSubmissionById(id) {
      for (const s of submissions.values()) {
        if (s.id === id) return { ...s };
      }
      return null;
    },
    async findDuplicateSubmission(arg1, arg2, arg3) {
      const campaignId = arg3 ? arg2 : arg1;
      const normalizedUrl = arg3 ? arg3 : arg2;
      for (const s of submissions.values()) {
        if (s.campaignId === campaignId && s.normalizedUrl === normalizedUrl) {
          return { ...s };
        }
      }
      return null;
    },
    async getUserSubmissions(userId, { page = 1, limit = 5, campaignId } = {}) {
      let filtered = Array.from(submissions.values()).filter((s) => s.userId === userId);
      if (campaignId) {
        filtered = filtered.filter((s) => s.campaignId === campaignId);
      }
      const total = filtered.length;
      const skip = (page - 1) * limit;
      const items = filtered.slice(skip, skip + limit);
      return {
        items,
        total,
        page,
        totalPages: Math.ceil(total / limit) || 1
      };
    },
    async updateSubmissionStatus(id, status, { verifiedAt = null, rejectionReason = null } = {}) {
      for (const s of submissions.values()) {
        if (s.id === id) {
          s.status = status;
          s.verifiedAt = verifiedAt;
          s.rejectionReason = rejectionReason;
          s.updatedAt = new Date();
          return { ...s };
        }
      }
      return null;
    }
  };
}

function createMockCampRepo() {
  const campaigns = new Map();
  const memberships = new Map();

  return {
    campaigns,
    memberships,
    async findById(id) {
      return campaigns.get(id) || null;
    },
    async findMembership(userId, campaignId) {
      return memberships.get(`${userId}_${campaignId}`) || null;
    }
  };
}

function createMockUserRepo() {
  const users = new Map();

  return {
    users,
    async findById(id) {
      return users.get(id) || null;
    }
  };
}

describe('URL Parser & Platform Normalization', () => {
  test('valid YouTube URLs are detected and normalized', () => {
    // Shorts
    const shorts = parseAndNormalizeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ?si=tracking123');
    assert.equal(shorts.platform, 'YOUTUBE');
    assert.equal(shorts.contentId, 'dQw4w9WgXcQ');
    assert.equal(shorts.normalizedUrl, 'https://www.youtube.com/shorts/dQw4w9WgXcQ');

    // Standard Watch URL
    const watch = parseAndNormalizeUrl('https://youtube.com/watch?v=dQw4w9WgXcQ&utm_source=twitter&t=10s');
    assert.equal(watch.platform, 'YOUTUBE');
    assert.equal(watch.contentId, 'dQw4w9WgXcQ');
    assert.equal(watch.normalizedUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    // Shortened youtu.be
    const shortDomain = parseAndNormalizeUrl('https://youtu.be/dQw4w9WgXcQ?si=abc');
    assert.equal(shortDomain.platform, 'YOUTUBE');
    assert.equal(shortDomain.contentId, 'dQw4w9WgXcQ');
    assert.equal(shortDomain.normalizedUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  test('valid TikTok URLs are detected and normalized', () => {
    // Web Video URL with user
    const tiktokWeb = parseAndNormalizeUrl(
      'https://www.tiktok.com/@creator/video/7123456789012345678?is_from_webapp=1&sender_device=pc'
    );
    assert.equal(tiktokWeb.platform, 'TIKTOK');
    assert.equal(tiktokWeb.contentId, '7123456789012345678');
    assert.equal(tiktokWeb.normalizedUrl, 'https://www.tiktok.com/@creator/video/7123456789012345678');

    // Mobile shortlink vm.tiktok.com
    const tiktokShort = parseAndNormalizeUrl('https://vm.tiktok.com/ZM8abc123/?utm_campaign=share');
    assert.equal(tiktokShort.platform, 'TIKTOK');
    assert.equal(tiktokShort.contentId, 'ZM8abc123');
    assert.equal(tiktokShort.normalizedUrl, 'https://vm.tiktok.com/ZM8abc123');
  });

  test('valid Instagram URLs are detected and normalized', () => {
    // Reel
    const reel = parseAndNormalizeUrl('https://www.instagram.com/reel/C1234abcdEF/?igsh=trackingParam');
    assert.equal(reel.platform, 'INSTAGRAM');
    assert.equal(reel.contentId, 'C1234abcdEF');
    assert.equal(reel.normalizedUrl, 'https://www.instagram.com/reel/C1234abcdEF/');

    // Post
    const post = parseAndNormalizeUrl('https://instagram.com/p/C1234abcdEF/');
    assert.equal(post.platform, 'INSTAGRAM');
    assert.equal(post.contentId, 'C1234abcdEF');
    assert.equal(post.normalizedUrl, 'https://www.instagram.com/p/C1234abcdEF/');
  });

  test('malformed URLs are rejected', () => {
    assert.throws(() => parseAndNormalizeUrl('not-a-valid-url'), InvalidSubmissionUrlError);
    assert.throws(() => parseAndNormalizeUrl('http://'), InvalidSubmissionUrlError);
    assert.throws(() => parseAndNormalizeUrl(''), InvalidSubmissionUrlError);
  });

  test('non-HTTP/HTTPS protocols are rejected', () => {
    assert.throws(() => parseAndNormalizeUrl('javascript:alert(1)'), InvalidSubmissionUrlError);
    assert.throws(() => parseAndNormalizeUrl('file:///etc/passwd'), InvalidSubmissionUrlError);
    assert.throws(() => parseAndNormalizeUrl('ftp://example.com/video.mp4'), InvalidSubmissionUrlError);
  });

  test('unsupported domains are rejected', () => {
    assert.throws(() => parseAndNormalizeUrl('https://vimeo.com/123456'), UnsupportedPlatformError);
    assert.throws(() => parseAndNormalizeUrl('https://dailymotion.com/video/123'), UnsupportedPlatformError);
    assert.throws(() => parseAndNormalizeUrl('https://twitter.com/i/status/123'), UnsupportedPlatformError);
  });
});

describe('Submission Engine Business Rules', () => {
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;

  function setupFixture() {
    const subRepo = createMockSubRepo();
    const campRepo = createMockCampRepo();
    const userRepo = createMockUserRepo();

    // Mock queue recorder
    const enqueuedJobs = [];
    const mockService = new SubmissionService(subRepo, campRepo, userRepo);
    mockService.queueVerificationJob = async (submissionId) => {
      enqueuedJobs.push({ submissionId, jobId: `verify:${submissionId}` });
    };

    // Valid active user
    const user = { id: 'usr_active', discordId: '111', status: 'ACTIVE' };
    userRepo.users.set(user.id, user);

    // Valid active campaign
    const campaign = {
      id: 'cmp_active',
      name: 'Summer Clips',
      status: 'ACTIVE',
      startsAt: new Date(now.getTime() - dayMs),
      endsAt: new Date(now.getTime() + 10 * dayMs),
      requirements: { allowedPlatforms: ['youtube', 'tiktok'] }
    };
    campRepo.campaigns.set(campaign.id, campaign);

    // Active membership
    campRepo.memberships.set(`${user.id}_${campaign.id}`, {
      userId: user.id,
      campaignId: campaign.id,
      status: 'ACTIVE'
    });

    return { subRepo, campRepo, userRepo, service: mockService, user, campaign, enqueuedJobs };
  }

  test('active campaign member can submit valid clip', async () => {
    const { service, user, campaign, enqueuedJobs } = setupFixture();

    const sub = await service.createSubmission({
      userId: user.id,
      campaignId: campaign.id,
      rawUrl: 'https://www.youtube.com/shorts/dQw4w9WgXcQ?si=test123'
    });

    assert.ok(sub.id);
    assert.equal(sub.platform, 'YOUTUBE');
    assert.equal(sub.normalizedUrl, 'https://www.youtube.com/shorts/dQw4w9WgXcQ');
    assert.equal(sub.status, 'PENDING_VERIFICATION');

    // Verified queue dispatch
    assert.equal(enqueuedJobs.length, 1);
    assert.equal(enqueuedJobs[0].submissionId, sub.id);
    assert.equal(enqueuedJobs[0].jobId, `verify:${sub.id}`);
  });

  test('non-member cannot submit to campaign', async () => {
    const { service, campRepo, user } = setupFixture();

    const campaign2 = {
      id: 'cmp_unjoined',
      status: 'ACTIVE',
      startsAt: new Date(now.getTime() - dayMs),
      endsAt: new Date(now.getTime() + 10 * dayMs),
      requirements: { allowedPlatforms: ['youtube'] }
    };
    campRepo.campaigns.set(campaign2.id, campaign2);

    await assert.rejects(
      async () =>
        service.createSubmission({
          userId: user.id,
          campaignId: campaign2.id,
          rawUrl: 'https://www.youtube.com/shorts/dQw4w9WgXcQ'
        }),
      NotCampaignMemberError
    );
  });

  test('suspended or banned user cannot submit clips', async () => {
    const { service, userRepo, user, campaign } = setupFixture();

    // Suspended
    user.status = 'SUSPENDED';
    await assert.rejects(
      async () =>
        service.createSubmission({
          userId: user.id,
          campaignId: campaign.id,
          rawUrl: 'https://www.youtube.com/shorts/dQw4w9WgXcQ'
        }),
      UserNotEligibleError
    );

    // Banned
    user.status = 'BANNED';
    await assert.rejects(
      async () =>
        service.createSubmission({
          userId: user.id,
          campaignId: campaign.id,
          rawUrl: 'https://www.youtube.com/shorts/dQw4w9WgXcQ'
        }),
      UserNotEligibleError
    );
  });

  test('inactive campaign cannot accept submission', async () => {
    const { service, campaign, user } = setupFixture();

    campaign.status = 'PAUSED';
    await assert.rejects(
      async () =>
        service.createSubmission({
          userId: user.id,
          campaignId: campaign.id,
          rawUrl: 'https://www.youtube.com/shorts/dQw4w9WgXcQ'
        }),
      CampaignNotJoinableError
    );
  });

  test('campaign outside date window cannot accept submission', async () => {
    const { service, campaign, user } = setupFixture();

    // Ended yesterday
    campaign.endsAt = new Date(now.getTime() - dayMs);
    await assert.rejects(
      async () =>
        service.createSubmission({
          userId: user.id,
          campaignId: campaign.id,
          rawUrl: 'https://www.youtube.com/shorts/dQw4w9WgXcQ'
        }),
      CampaignNotJoinableError
    );
  });

  test('platform not allowed by campaign requirements is rejected', async () => {
    const { service, campaign, user } = setupFixture();

    // Campaign allows only YouTube and TikTok
    campaign.requirements = { allowedPlatforms: ['youtube', 'tiktok'] };

    // Attempt Instagram submission
    await assert.rejects(
      async () =>
        service.createSubmission({
          userId: user.id,
          campaignId: campaign.id,
          rawUrl: 'https://www.instagram.com/reel/C1234abcdEF/'
        }),
      PlatformNotAllowedError
    );
  });

  test('duplicate normalized URL for same user and campaign is rejected', async () => {
    const { service, user, campaign } = setupFixture();

    await service.createSubmission({
      userId: user.id,
      campaignId: campaign.id,
      rawUrl: 'https://www.youtube.com/shorts/dQw4w9WgXcQ?si=first_attempt'
    });

    // Submitting same clip with different tracking params
    await assert.rejects(
      async () =>
        service.createSubmission({
          userId: user.id,
          campaignId: campaign.id,
          rawUrl: 'https://www.youtube.com/shorts/dQw4w9WgXcQ?si=second_attempt'
        }),
      DuplicateSubmissionError
    );
  });

  test('duplicate normalized URL submitted by a DIFFERENT user to the same campaign is rejected (campaign-wide)', async () => {
    const { service, campRepo, userRepo, user, campaign } = setupFixture();

    // User 1 submits clip
    await service.createSubmission({
      userId: user.id,
      campaignId: campaign.id,
      rawUrl: 'https://www.youtube.com/shorts/dQw4w9WgXcQ'
    });

    // User 2 joins the same campaign
    const user2 = { id: 'usr_creator_2', discordId: 'disc_2', status: 'ACTIVE' };
    userRepo.users.set(user2.id, user2);
    campRepo.memberships.set(`${user2.id}_${campaign.id}`, {
      userId: user2.id,
      campaignId: campaign.id,
      status: 'ACTIVE'
    });

    // User 2 attempts to submit the same clip
    await assert.rejects(
      async () =>
        service.createSubmission({
          userId: user2.id,
          campaignId: campaign.id,
          rawUrl: 'https://www.youtube.com/shorts/dQw4w9WgXcQ?tracking=different'
        }),
      DuplicateSubmissionError
    );
  });

  test('same URL can exist across different campaigns', async () => {
    const { service, campRepo, user, campaign } = setupFixture();

    // Create first submission
    const sub1 = await service.createSubmission({
      userId: user.id,
      campaignId: campaign.id,
      rawUrl: 'https://www.youtube.com/shorts/dQw4w9WgXcQ'
    });
    assert.ok(sub1.id);

    // Second campaign
    const campaignB = {
      id: 'cmp_beta',
      name: 'Autumn Clips',
      status: 'ACTIVE',
      startsAt: new Date(now.getTime() - dayMs),
      endsAt: new Date(now.getTime() + 10 * dayMs),
      requirements: { allowedPlatforms: ['youtube'] }
    };
    campRepo.campaigns.set(campaignB.id, campaignB);
    campRepo.memberships.set(`${user.id}_${campaignB.id}`, {
      userId: user.id,
      campaignId: campaignB.id,
      status: 'ACTIVE'
    });

    // Submitting same URL to second campaign succeeds
    const sub2 = await service.createSubmission({
      userId: user.id,
      campaignId: campaignB.id,
      rawUrl: 'https://www.youtube.com/shorts/dQw4w9WgXcQ'
    });
    assert.ok(sub2.id);
    assert.notEqual(sub1.id, sub2.id);
  });

  test('database unique constraint race condition is caught as DuplicateSubmissionError', async () => {
    const { service, subRepo, user, campaign } = setupFixture();

    // Bypass service check to simulate simultaneous race condition reaching DB create
    subRepo.createSubmission = async () => {
      const p2002 = new Error('Unique constraint failed on the fields: (`user_id`,`campaign_id`,`normalized_url`)');
      p2002.code = 'P2002';
      throw p2002;
    };

    await assert.rejects(
      async () =>
        service.createSubmission({
          userId: user.id,
          campaignId: campaign.id,
          rawUrl: 'https://www.youtube.com/shorts/dQw4w9WgXcQ'
        }),
      DuplicateSubmissionError
    );
  });
});
