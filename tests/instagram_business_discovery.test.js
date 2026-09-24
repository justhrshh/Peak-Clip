import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramProvider } from '../src/providers/instagram/instagram.provider.js';
import { parseAndNormalizeUrl } from '../src/modules/submissions/url.parser.js';
import { InvalidSubmissionUrlError } from '../src/modules/submissions/submission.errors.js';
import {
  ConfigurationAuthError,
  RateLimitProviderError,
  PermanentContentError,
  TransientProviderError
} from '../src/modules/verification/verification.errors.js';
import { hasProviderCapability, getProviderCapabilities } from '../src/providers/capabilities.js';
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

describe('Instagram URL Parsing & Normalization', () => {
  test('extracts shortcode from standard Instagram Reel URL', () => {
    const result = parseAndNormalizeUrl('https://www.instagram.com/reel/C8xYz123AbC/');
    assert.equal(result.platform, 'INSTAGRAM');
    assert.equal(result.contentId, 'C8xYz123AbC');
    assert.equal(result.normalizedUrl, 'https://www.instagram.com/reel/C8xYz123AbC/');
    assert.equal(result.username, null);
  });

  test('extracts shortcode from Instagram Post URL (/p/)', () => {
    const result = parseAndNormalizeUrl('https://www.instagram.com/p/C9aBcDeF456/');
    assert.equal(result.platform, 'INSTAGRAM');
    assert.equal(result.contentId, 'C9aBcDeF456');
    assert.equal(result.normalizedUrl, 'https://www.instagram.com/p/C9aBcDeF456/');
  });

  test('normalizes URL without trailing slash and without www', () => {
    const result = parseAndNormalizeUrl('https://instagram.com/reel/D0eFgHiJ789');
    assert.equal(result.platform, 'INSTAGRAM');
    assert.equal(result.contentId, 'D0eFgHiJ789');
    assert.equal(result.normalizedUrl, 'https://www.instagram.com/reel/D0eFgHiJ789/');
  });

  test('extracts creator username from user-prefixed Instagram Reel URL', () => {
    const result = parseAndNormalizeUrl('https://www.instagram.com/creator_handle/reel/C8xYz123AbC/');
    assert.equal(result.platform, 'INSTAGRAM');
    assert.equal(result.contentId, 'C8xYz123AbC');
    assert.equal(result.username, 'creator_handle');
    assert.equal(result.normalizedUrl, 'https://www.instagram.com/reel/C8xYz123AbC/');
  });

  test('extracts creator username from user-prefixed Instagram Post URL', () => {
    const result = parseAndNormalizeUrl('https://www.instagram.com/creator.pro/p/C9aBcDeF456/');
    assert.equal(result.platform, 'INSTAGRAM');
    assert.equal(result.contentId, 'C9aBcDeF456');
    assert.equal(result.username, 'creator.pro');
    assert.equal(result.normalizedUrl, 'https://www.instagram.com/p/C9aBcDeF456/');
  });

  test('strips tracking query parameters (igsh, utm_source, etc.)', () => {
    const url = 'https://www.instagram.com/reel/C8xYz123AbC/?igsh=MzRlODBiNWFlZA==&utm_source=ig_web_copy_link';
    const result = parseAndNormalizeUrl(url);
    assert.equal(result.normalizedUrl, 'https://www.instagram.com/reel/C8xYz123AbC/');
    assert.equal(result.contentId, 'C8xYz123AbC');
  });

  test('throws InvalidSubmissionUrlError on malformed Instagram URL', () => {
    assert.throws(
      () => parseAndNormalizeUrl('https://www.instagram.com/direct/inbox/'),
      InvalidSubmissionUrlError
    );
  });
});

describe('Instagram Provider — Unauthenticated Boundary', () => {
  const provider = new InstagramProvider(null, null);

  test('has platform name INSTAGRAM', () => {
    assert.equal(provider.platform, 'INSTAGRAM');
    assert.equal(provider.name, 'INSTAGRAM');
  });

  test('getCurrentMetrics returns DATA_UNAVAILABLE cleanly with 0 fabricated numbers', async () => {
    const result = await provider.getCurrentMetrics('C8xYz123AbC');
    assert.equal(result.status, 'DATA_UNAVAILABLE');
    assert.equal(result.views, null);
    assert.equal(result.likes, null);
    assert.equal(result.comments, null);
    assert.equal(result.shares, null);
    assert.equal(result.availability.views, 'UNAVAILABLE');
    assert.equal(result.availability.likes, 'UNAVAILABLE');
    assert.ok(result.reason.includes('META_ACCESS_TOKEN is not configured'));
  });

  test('getAvailability returns DATA_UNAVAILABLE when unconfigured', async () => {
    const result = await provider.getAvailability('C8xYz123AbC');
    assert.equal(result.status, 'DATA_UNAVAILABLE');
  });

  test('getDuration returns NOT_SUPPORTED', async () => {
    const result = await provider.getDuration('C8xYz123AbC');
    assert.equal(result.status, 'NOT_SUPPORTED');
    assert.equal(result.durationSeconds, null);
  });
});

describe('Instagram Provider — Authenticated Business Discovery Flow', () => {
  const MOCK_TOKEN = 'EAAB_test_meta_token';
  const MOCK_BIZ_ID = '17841400000000001';

  test('successfully resolves target username, discovers public media, and matches Reel', async () => {
    const mockDiscoveryResponse = {
      business_discovery: {
        id: '17841405555555555',
        username: 'pro_creator',
        name: 'Professional Creator',
        followers_count: 50000,
        media: {
          data: [
            {
              id: '18000000000000001',
              caption: 'My awesome clip #epic',
              comments_count: 187,
              like_count: 4200,
              media_type: 'VIDEO',
              media_product_type: 'REELS',
              permalink: 'https://www.instagram.com/reel/C8xYz123AbC/',
              timestamp: '2026-09-20T12:00:00+0000',
              username: 'pro_creator'
            },
            {
              id: '18000000000000002',
              caption: 'Another clip',
              comments_count: 50,
              like_count: 1000,
              permalink: 'https://www.instagram.com/reel/OtherShortcode/'
            }
          ]
        }
      }
    };

    const mockFetch = async (url) => {
      if (url.includes('business_discovery')) {
        return {
          ok: true,
          status: 200,
          json: async () => mockDiscoveryResponse
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const provider = new InstagramProvider(MOCK_TOKEN, MOCK_BIZ_ID, mockFetch);
    const result = await provider.getCurrentMetrics('https://www.instagram.com/pro_creator/reel/C8xYz123AbC/');

    assert.equal(result.status, 'AVAILABLE');
    assert.equal(result.isAvailable, true);
    assert.equal(result.likes, 4200n);
    assert.equal(result.comments, 187n);
    assert.equal(result.views, null, 'Public Business Discovery views must be null (not fabricated to 0)');
    assert.equal(result.shares, null, 'Shares are not supported via public Business Discovery');
    assert.equal(result.metadata.username, 'pro_creator');
    assert.equal(result.metadata.id, '18000000000000001');
    assert.equal(result.availability.likes, 'AVAILABLE');
    assert.equal(result.availability.comments, 'AVAILABLE');
    assert.equal(result.availability.views, 'UNAVAILABLE');
  });

  test('auto-discovers linked Instagram Business Account if businessAccountId is not pre-configured', async () => {
    let meAccountsCalled = false;
    let businessDiscoveryCalled = false;

    const mockFetch = async (url) => {
      if (url.includes('me/accounts')) {
        meAccountsCalled = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: 'page_123',
                name: 'Clipping Agency Page',
                instagram_business_account: { id: 'auto_discovered_ig_id' }
              }
            ]
          })
        };
      }
      if (url.includes('business_discovery')) {
        businessDiscoveryCalled = true;
        assert.ok(url.includes('auto_discovered_ig_id'), 'Must query against auto-discovered IG ID');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            business_discovery: {
              username: 'top_creator',
              media: {
                data: [
                  {
                    id: '12345',
                    permalink: 'https://www.instagram.com/reel/AutoDiscoverCode/',
                    like_count: 50,
                    comments_count: 5
                  }
                ]
              }
            }
          })
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const provider = new InstagramProvider(MOCK_TOKEN, null, mockFetch);
    const result = await provider.getCurrentMetrics('https://www.instagram.com/top_creator/reel/AutoDiscoverCode/');

    assert.ok(meAccountsCalled);
    assert.ok(businessDiscoveryCalled);
    assert.equal(result.status, 'AVAILABLE');
    assert.equal(result.likes, 50n);
  });

  test('resolves target username via oEmbed when URL contains only shortcode', async () => {
    let oembedCalled = false;

    const mockFetch = async (url) => {
      if (url.includes('instagram_oembed')) {
        oembedCalled = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            author_name: 'oembed_creator',
            html: '<blockquote class="instagram-media"><a href="https://www.instagram.com/p/ShortcodeOnly/">A post shared by Creator (@oembed_creator)</a></blockquote>'
          })
        };
      }
      if (url.includes('business_discovery')) {
        assert.ok(url.includes('oembed_creator'), 'Must query username resolved from oEmbed');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            business_discovery: {
              username: 'oembed_creator',
              media: {
                data: [
                  {
                    id: '123',
                    permalink: 'https://www.instagram.com/reel/ShortcodeOnly/',
                    like_count: 999,
                    comments_count: 11
                  }
                ]
              }
            }
          })
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const provider = new InstagramProvider(MOCK_TOKEN, MOCK_BIZ_ID, mockFetch);
    const result = await provider.getCurrentMetrics('ShortcodeOnly');

    assert.ok(oembedCalled);
    assert.equal(result.status, 'AVAILABLE');
    assert.equal(result.likes, 999n);
    assert.equal(result.comments, 11n);
  });
});

describe('Instagram Provider — Error Classifications & Resiliency', () => {
  const MOCK_TOKEN = 'test_token';
  const MOCK_BIZ_ID = 'test_biz_id';

  test('handles personal or ineligible creator account (code 100 / subcode 2207052)', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          message: 'User is not a business account',
          code: 100,
          error_subcode: 2207052
        }
      })
    });

    const provider = new InstagramProvider(MOCK_TOKEN, MOCK_BIZ_ID, mockFetch);
    const result = await provider.getCurrentMetrics('https://www.instagram.com/personal_user/reel/C8xYz123AbC/');

    assert.equal(result.status, 'DATA_UNAVAILABLE');
    assert.ok(result.reason.includes('INSTAGRAM_ACCOUNT_NOT_ELIGIBLE'));
    assert.equal(result.isAvailable, false);
  });

  test('handles media not found among creator public media (wrong-media prevention)', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        business_discovery: {
          username: 'creator_no_match',
          media: {
            data: [
              {
                id: '99999',
                permalink: 'https://www.instagram.com/reel/CompletelyDifferentCode/',
                like_count: 10
              }
            ]
          }
        }
      })
    });

    const provider = new InstagramProvider(MOCK_TOKEN, MOCK_BIZ_ID, mockFetch);
    const result = await provider.getCurrentMetrics('https://www.instagram.com/creator_no_match/reel/MyWantedCode/');

    assert.equal(result.status, 'DATA_UNAVAILABLE');
    assert.ok(result.reason.includes('INSTAGRAM_MEDIA_NOT_FOUND'));
    assert.equal(result.isAvailable, false);
  });

  test('throws ConfigurationAuthError on expired Meta token (code 190)', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({
        error: {
          message: 'Error validating access token: Session has expired.',
          code: 190
        }
      })
    });

    const provider = new InstagramProvider(MOCK_TOKEN, MOCK_BIZ_ID, mockFetch);
    await assert.rejects(
      () => provider.getCurrentMetrics('https://www.instagram.com/creator/reel/C8xYz123/'),
      (err) => {
        assert.ok(err instanceof ConfigurationAuthError);
        assert.equal(err.details.retryable, false);
        return true;
      }
    );
  });

  test('throws RateLimitProviderError on rate limit exceeded (code 4)', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          message: 'Application request limit reached',
          code: 4
        }
      })
    });

    const provider = new InstagramProvider(MOCK_TOKEN, MOCK_BIZ_ID, mockFetch);
    await assert.rejects(
      () => provider.getCurrentMetrics('https://www.instagram.com/creator/reel/C8xYz123/'),
      (err) => {
        assert.ok(err instanceof RateLimitProviderError);
        assert.equal(err.details.retryable, true);
        return true;
      }
    );
  });

  test('throws TransientProviderError on Meta Graph API 500 error', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({
        error: {
          message: 'Internal server error',
          code: 2
        }
      })
    });

    const provider = new InstagramProvider(MOCK_TOKEN, MOCK_BIZ_ID, mockFetch);
    await assert.rejects(
      () => provider.getCurrentMetrics('https://www.instagram.com/creator/reel/C8xYz123/'),
      (err) => {
        assert.ok(err instanceof TransientProviderError);
        assert.equal(err.details.retryable, true);
        return true;
      }
    );
  });
});

describe('Instagram Capabilities & Polling Policy Integration', () => {
  test('capabilities matrix declares fetchViews and authenticatedMetrics for INSTAGRAM', () => {
    assert.equal(hasProviderCapability('INSTAGRAM', 'fetchViews'), true);
    assert.equal(hasProviderCapability('INSTAGRAM', 'fetchLikes'), true);
    assert.equal(hasProviderCapability('INSTAGRAM', 'fetchComments'), true);
    assert.equal(hasProviderCapability('INSTAGRAM', 'authenticatedMetrics'), true);
    assert.equal(hasProviderCapability('INSTAGRAM', 'fetchShares'), false);
    assert.equal(hasProviderCapability('INSTAGRAM', 'fetchDuration'), false);
  });

  test('evaluatePollingEligibility approves APPROVED Instagram clip in ACTIVE campaign', () => {
    const submission = {
      id: 'sub_ig_1',
      platform: 'INSTAGRAM',
      status: 'APPROVED',
      deletedAt: null,
      user: { id: 'usr_1', status: 'ACTIVE' },
      campaign: { id: 'cmp_1', status: 'ACTIVE', endDate: null }
    };

    const result = evaluatePollingEligibility(submission);
    assert.equal(result.eligible, true);
    assert.equal(result.reason, 'ELIGIBLE');
    assert.equal(isSubmissionEligibleForPolling(submission), true);
  });

  test('hasMetricsChanged correctly detects like/comment growth when views are null', () => {
    const snapshot = {
      views: null,
      likes: 100n,
      comments: 10n
    };

    // Identical metrics -> duplicate skipped
    assert.equal(hasMetricsChanged(snapshot, { views: null, likes: 100n, comments: 10n }), false);

    // Likes grew -> snapshot captured
    assert.equal(hasMetricsChanged(snapshot, { views: null, likes: 120n, comments: 10n }), true);

    // Comments grew -> snapshot captured
    assert.equal(hasMetricsChanged(snapshot, { views: null, likes: 100n, comments: 15n }), true);
  });
});

describe('Instagram Submission Analytics & Manual Staff Refresh', () => {
  test('getSubmissionAnalytics correctly computes delta growth for Instagram snapshots', async () => {
    const snapshots = [
      { id: 'snap_0', views: null, likes: 100n, comments: 10n, shares: null, capturedAt: new Date('2026-09-23T10:00:00Z') },
      { id: 'snap_1', views: null, likes: 150n, comments: 15n, shares: null, capturedAt: new Date('2026-09-23T11:00:00Z') }
    ];

    const mockPrisma = {
      submission: {
        findUnique: async () => ({
          id: 'sub_ig_analytics',
          platform: 'INSTAGRAM',
          status: 'APPROVED',
          url: 'https://www.instagram.com/reel/C8xYz123/',
          snapshots
        })
      }
    };

    const repo = new AdminSubmissionRepository(mockPrisma);
    const analytics = await repo.getSubmissionAnalytics('sub_ig_analytics');

    assert.equal(analytics.totalSnapshots, 2);
    assert.equal(analytics.snapshots[0].likesGained, 50); // 150 - 100
    assert.equal(analytics.snapshots[0].commentsGained, 5); // 15 - 10
  });

  test('buildStaffSubmissionDetailEmbed renders Instagram submission telemetry', () => {
    const submission = {
      id: 'sub_ig_embed_test',
      platform: 'INSTAGRAM',
      status: 'APPROVED',
      url: 'https://www.instagram.com/reel/C8xYz123AbC/',
      userId: 'usr_1',
      campaignId: 'cmp_1',
      durationSeconds: null,
      retentionRequired: false,
      lastAvailabilityStatus: 'AVAILABLE',
      submittedAt: new Date('2026-09-20T10:00:00Z'),
      verifiedAt: new Date('2026-09-20T10:05:00Z'),
      user: { discordId: '123456789', username: 'ig_creator' },
      campaign: { name: 'Instagram Creator Campaign' },
      verifications: [{ riskLevel: 'LOW_RISK', score: 5 }],
      snapshots: [
        {
          id: 'snap_ig_latest',
          views: null,
          likes: 4200n,
          comments: 187n,
          shares: null,
          capturedAt: new Date('2026-09-23T14:00:00Z')
        }
      ]
    };

    const embed = buildStaffSubmissionDetailEmbed(submission);
    assert.ok(embed);

    const fields = embed.data.fields;
    const metricsField = fields.find((f) => f.name === '📊 Current Metrics');
    assert.ok(metricsField);
    assert.ok(metricsField.value.includes('4,200'));
    assert.ok(metricsField.value.includes('187'));
    assert.ok(metricsField.value.includes('N/A')); // Views are N/A for public Instagram Business Discovery

    const trackingField = fields.find((f) => f.name === '📡 Tracking & Availability');
    assert.ok(trackingField);
    assert.ok(trackingField.value.includes('ACTIVE_TRACKING'));
  });
});
