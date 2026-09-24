import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FacebookProvider } from '../src/providers/facebook/facebook.provider.js';
import { parseAndNormalizeUrl } from '../src/modules/submissions/url.parser.js';
import { InvalidSubmissionUrlError } from '../src/modules/submissions/submission.errors.js';
import {
  ConfigurationAuthError,
  RateLimitProviderError,
  PermanentContentError,
  TransientProviderError
} from '../src/modules/verification/verification.errors.js';
import { hasProviderCapability, getProviderCapabilities } from '../src/providers/capabilities.js';
import { buildStaffSubmissionDetailRow } from '../src/bot/components/staff.components.js';

describe('Facebook URL Parser & Identity Normalization', () => {
  test('extracts ID from Facebook Reel URL', () => {
    const result = parseAndNormalizeUrl('https://www.facebook.com/reel/123456789012345/');
    assert.equal(result.platform, 'FACEBOOK');
    assert.equal(result.contentId, '123456789012345');
    assert.equal(result.normalizedUrl, 'https://www.facebook.com/reel/123456789012345/');
  });

  test('extracts ID from Facebook Watch URL with query param', () => {
    const result = parseAndNormalizeUrl('https://www.facebook.com/watch/?v=987654321098765&ref=sharing');
    assert.equal(result.platform, 'FACEBOOK');
    assert.equal(result.contentId, '987654321098765');
    assert.equal(result.normalizedUrl, 'https://www.facebook.com/watch/?v=987654321098765');
  });

  test('extracts ID from fb.watch shortlink', () => {
    const result = parseAndNormalizeUrl('https://fb.watch/abCdEfGhIj/');
    assert.equal(result.platform, 'FACEBOOK');
    assert.equal(result.contentId, 'abCdEfGhIj');
    assert.equal(result.normalizedUrl, 'https://fb.watch/abCdEfGhIj/');
  });

  test('extracts ID from fb.me shortlink', () => {
    const result = parseAndNormalizeUrl('https://fb.me/xyz987654');
    assert.equal(result.platform, 'FACEBOOK');
    assert.equal(result.contentId, 'xyz987654');
    assert.equal(result.normalizedUrl, 'https://fb.watch/xyz987654/');
  });

  test('extracts ID from /share/r/ short URL', () => {
    const result = parseAndNormalizeUrl('https://www.facebook.com/share/r/shareReelId123/');
    assert.equal(result.platform, 'FACEBOOK');
    assert.equal(result.contentId, 'shareReelId123');
    assert.equal(result.normalizedUrl, 'https://www.facebook.com/reel/shareReelId123/');
  });

  test('extracts ID from /share/v/ short URL', () => {
    const result = parseAndNormalizeUrl('https://www.facebook.com/share/v/shareVideoId456/');
    assert.equal(result.platform, 'FACEBOOK');
    assert.equal(result.contentId, 'shareVideoId456');
    assert.equal(result.normalizedUrl, 'https://www.facebook.com/reel/shareVideoId456/');
  });

  test('extracts ID from user video URL /username/videos/12345', () => {
    const result = parseAndNormalizeUrl('https://www.facebook.com/creator_page/videos/555666777888999/');
    assert.equal(result.platform, 'FACEBOOK');
    assert.equal(result.contentId, '555666777888999');
    assert.equal(result.normalizedUrl, 'https://www.facebook.com/watch/?v=555666777888999');
  });

  test('extracts ID from legacy /video.php?v=12345', () => {
    const result = parseAndNormalizeUrl('https://www.facebook.com/video.php?v=112233445566');
    assert.equal(result.platform, 'FACEBOOK');
    assert.equal(result.contentId, '112233445566');
    assert.equal(result.normalizedUrl, 'https://www.facebook.com/watch/?v=112233445566');
  });

  test('strips web. subdomain and m. subdomain', () => {
    const resultWeb = parseAndNormalizeUrl('https://web.facebook.com/reel/123456789/');
    assert.equal(resultWeb.platform, 'FACEBOOK');
    assert.equal(resultWeb.contentId, '123456789');

    const resultM = parseAndNormalizeUrl('https://m.facebook.com/reel/123456789/');
    assert.equal(resultM.platform, 'FACEBOOK');
    assert.equal(resultM.contentId, '123456789');
  });

  test('throws InvalidSubmissionUrlError on invalid Facebook URL path', () => {
    assert.throws(
      () => parseAndNormalizeUrl('https://www.facebook.com/messages/t/12345'),
      InvalidSubmissionUrlError
    );
  });
});

describe('Facebook Provider — Unauthenticated Boundary (Default)', () => {
  const provider = new FacebookProvider(null); // Explicit unauthenticated

  test('provider has platform name FACEBOOK', () => {
    assert.equal(provider.platform, 'FACEBOOK');
    assert.equal(provider.name, 'FACEBOOK');
  });

  test('getCurrentMetrics returns DATA_UNAVAILABLE cleanly with 0 fabricated numbers', async () => {
    const result = await provider.getCurrentMetrics('123456789');
    assert.equal(result.status, 'DATA_UNAVAILABLE');
    assert.equal(result.isAvailable, true);
    assert.equal(result.views, null);
    assert.equal(result.likes, null);
    assert.equal(result.comments, null);
    assert.equal(result.shares, null);
    assert.equal(result.durationSeconds, null);
    assert.equal(result.availability.views, 'TEMPORARILY_UNAVAILABLE');
    assert.equal(result.availability.shares, 'NOT_SUPPORTED');
    assert.ok(result.reason.includes('Meta Graph API authorization'));
  });

  test('getVideoMetrics worker alias returns identical DATA_UNAVAILABLE contract', async () => {
    const result = await provider.getVideoMetrics('123456789');
    assert.equal(result.status, 'DATA_UNAVAILABLE');
    assert.equal(result.views, null);
  });

  test('getAvailability returns DATA_UNAVAILABLE', async () => {
    const result = await provider.getAvailability('123456789');
    assert.equal(result.status, 'DATA_UNAVAILABLE');
    assert.equal(result.isAvailable, true);
  });

  test('getDuration returns NOT_SUPPORTED', async () => {
    const result = await provider.getDuration('123456789');
    assert.equal(result.status, 'NOT_SUPPORTED');
    assert.equal(result.durationSeconds, null);
  });

  test('getVideo returns DATA_UNAVAILABLE video object', async () => {
    const result = await provider.getVideo('123456789');
    assert.equal(result.status, 'DATA_UNAVAILABLE');
    assert.equal(result.platform, 'FACEBOOK');
    assert.equal(result.contentId, '123456789');
  });

  test('getAuthor returns DATA_UNAVAILABLE author object', async () => {
    const result = await provider.getAuthor('123456789');
    assert.equal(result.status, 'DATA_UNAVAILABLE');
    assert.equal(result.authorId, null);
  });
});

describe('Facebook Provider — Authenticated Meta Graph API', () => {
  test('fetches and normalizes live video metrics via Graph API', async () => {
    const mockApiResponse = {
      id: 'fb_vid_123',
      title: 'Amazing Reel',
      description: 'Check out this clip',
      length: 45.6,
      views: 75000,
      likes: { summary: { total_count: 3200 } },
      comments: { summary: { total_count: 150 } }
    };

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => mockApiResponse
    });

    const provider = new FacebookProvider('valid_meta_token', mockFetch);
    const metrics = await provider.getCurrentMetrics('fb_vid_123');

    assert.equal(metrics.status, 'AVAILABLE');
    assert.equal(metrics.views, 75000n);
    assert.equal(metrics.likes, 3200n);
    assert.equal(metrics.comments, 150n);
    assert.equal(metrics.shares, null);
    assert.equal(metrics.durationSeconds, 46);
    assert.equal(metrics.metadata.title, 'Amazing Reel');
    assert.equal(metrics.availability.views, 'AVAILABLE');
  });

  test('maps Meta OAuth error 190 to ConfigurationAuthError', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({
        error: {
          message: 'Error validating access token: Session has expired.',
          type: 'OAuthException',
          code: 190
        }
      })
    });

    const provider = new FacebookProvider('expired_token', mockFetch);
    await assert.rejects(
      async () => provider.getCurrentMetrics('fb_vid_123'),
      ConfigurationAuthError
    );
  });

  test('maps Meta rate limit code 4 to RateLimitProviderError', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 429,
      json: async () => ({
        error: {
          message: 'Application request limit reached',
          type: 'OAuthException',
          code: 4
        }
      })
    });

    const provider = new FacebookProvider('rate_limited_token', mockFetch);
    await assert.rejects(
      async () => provider.getCurrentMetrics('fb_vid_123'),
      RateLimitProviderError
    );
  });

  test('maps missing video code 803 to PermanentContentError', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 404,
      json: async () => ({
        error: {
          message: 'Some of the aliases you requested do not exist: fb_vid_deleted',
          type: 'OAuthException',
          code: 803
        }
      })
    });

    const provider = new FacebookProvider('valid_token', mockFetch);
    await assert.rejects(
      async () => provider.getCurrentMetrics('fb_vid_deleted'),
      PermanentContentError
    );
  });

  test('maps Meta 500 error to TransientProviderError', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({
        error: {
          message: 'An unknown error occurred on Meta servers',
          type: 'OAuthException',
          code: 2
        }
      })
    });

    const provider = new FacebookProvider('valid_token', mockFetch);
    await assert.rejects(
      async () => provider.getCurrentMetrics('fb_vid_123'),
      TransientProviderError
    );
  });
});

describe('Facebook Platform Capabilities Contract', () => {
  test('capabilities matrix declares authenticatedMetrics true for FACEBOOK', () => {
    const caps = getProviderCapabilities('FACEBOOK');
    assert.equal(caps.authenticatedMetrics, true);
    assert.equal(hasProviderCapability('FACEBOOK', 'authenticatedMetrics'), true);
  });

  test('capabilities matrix declares automated fetchViews true for FACEBOOK', () => {
    assert.equal(hasProviderCapability('FACEBOOK', 'fetchViews'), true);
    assert.equal(hasProviderCapability('FACEBOOK', 'fetchShares'), true);
  });
});

describe('Staff Submission Detail — Open Video Button Component', () => {
  test('creates 🎬 Open Video link button when submission URL is provided', () => {
    const submission = {
      id: 'sub_fb_123',
      status: 'APPROVED',
      url: 'https://www.facebook.com/reel/123456789/'
    };

    const rows = buildStaffSubmissionDetailRow(submission);
    assert.ok(Array.isArray(rows));
    assert.ok(rows.length >= 1);

    // First row should contain the Open Video link button
    const firstRowComponents = rows[0].components;
    const openVideoBtn = firstRowComponents.find((c) => c.data?.label === '🎬 Open Video');
    assert.ok(openVideoBtn, 'Expected 🎬 Open Video button in first action row');
    assert.equal(openVideoBtn.data.style, 5); // ButtonStyle.Link = 5
    assert.equal(openVideoBtn.data.url, 'https://www.facebook.com/reel/123456789/');
  });

  test('omits Open Video button when submission URL is null or non-http', () => {
    const rows = buildStaffSubmissionDetailRow('sub_no_url', 'UNDER_REVIEW', null);
    const firstRowComponents = rows[0].components;
    const openVideoBtn = firstRowComponents.find((c) => c.data?.label === '🎬 Open Video');
    assert.equal(openVideoBtn, undefined);
  });
});
