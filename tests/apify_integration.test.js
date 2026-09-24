import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ApifyClientService } from '../src/integrations/apify/apify.client.js';
import {
  ApifyAuthError,
  ApifyRateLimitError,
  ApifyTimeoutError,
  ApifyServerError,
  mapApifyError
} from '../src/integrations/apify/apify.errors.js';
import {
  parseCount,
  parseDate,
  normalizeTikTokOutput,
  normalizeFacebookOutput,
  normalizeInstagramOutput
} from '../src/integrations/apify/apify.normalizer.js';
import { TikTokProvider } from '../src/providers/tiktok/tiktok.provider.js';
import { FacebookProvider } from '../src/providers/facebook/facebook.provider.js';
import { InstagramProvider } from '../src/providers/instagram/instagram.provider.js';
import { evaluatePollingEligibility } from '../src/modules/verification/polling.policy.js';
import { hasProviderCapability } from '../src/providers/capabilities.js';
import {
  PermanentContentError,
  TransientProviderError,
  RateLimitProviderError
} from '../src/modules/verification/verification.errors.js';

describe('Apify Integration & Automated Providers Test Suite', () => {

  // =========================================================================
  // 1. APIFY CLIENT SERVICE & ERROR MAPPING
  // =========================================================================
  describe('1. Apify Client Service & Error Mapping', () => {
    test('isConfigured returns false when token is empty or undefined', () => {
      const client = new ApifyClientService('');
      assert.equal(client.isConfigured(), false);
      const clientNull = new ApifyClientService(null);
      assert.equal(clientNull.isConfigured(), false);
    });

    test('isConfigured returns true when token is present', () => {
      const client = new ApifyClientService('apify_api_mock_token_123');
      assert.equal(client.isConfigured(), true);
    });

    test('callActor throws ApifyAuthError when unconfigured', async () => {
      const client = new ApifyClientService('');
      await assert.rejects(
        () => client.callActor('mock/actor', {}),
        ApifyAuthError
      );
    });

    test('maps 401/403 to ApifyAuthError and 429 to ApifyRateLimitError', () => {
      const authErr = mapApifyError(new ApifyAuthError('Invalid token'), 'TIKTOK');
      assert.equal(authErr.name, 'ConfigurationAuthError');

      const rateErr = mapApifyError(new ApifyRateLimitError('Too many requests'), 'TIKTOK');
      assert.equal(rateErr.name, 'RateLimitProviderError');

      const timeoutErr = mapApifyError(new ApifyTimeoutError('Timed out'), 'TIKTOK');
      assert.equal(timeoutErr.name, 'TransientProviderError');

      const serverErr = mapApifyError(new ApifyServerError('500 internal'), 'TIKTOK');
      assert.equal(serverErr.name, 'TransientProviderError');
    });

    test('in-flight request deduplication prevents duplicate concurrent calls', async () => {
      let callCount = 0;
      const mockSdk = {
        actor: () => ({
          call: async () => {
            callCount++;
            await new Promise((r) => setTimeout(r, 20));
            return { id: 'run_1', defaultDatasetId: 'ds_1', status: 'SUCCEEDED' };
          }
        }),
        dataset: () => ({
          listItems: async () => ({ items: [{ result: 'ok' }] })
        })
      };

      const client = new ApifyClientService('mock_token', mockSdk);
      const input = { postURLs: ['https://tiktok.com/@u/video/1'] };

      const [res1, res2] = await Promise.all([
        client.callActor('test-actor', input),
        client.callActor('test-actor', input)
      ]);

      assert.equal(callCount, 1);
      assert.deepEqual(res1, res2);
    });
  });

  // =========================================================================
  // 2. NORMALIZER & PRECISION HANDLING
  // =========================================================================
  describe('2. Metric Normalizer & Precision Handling', () => {
    test('parseCount parses exact integers into BigInt', () => {
      const res = parseCount(12500);
      assert.equal(res.value, 12500n);
      assert.equal(res.isRounded, false);
      assert.equal(res.raw, '12500');
    });

    test('parseCount parses rounded suffix strings (K, M, B) without pretending exact precision', () => {
      const kRes = parseCount('45.5K');
      assert.equal(kRes.value, 45500n);
      assert.equal(kRes.isRounded, true);
      assert.equal(kRes.raw, '45.5K');

      const mRes = parseCount('3.2M');
      assert.equal(mRes.value, 3200000n);
      assert.equal(mRes.isRounded, true);
      assert.equal(mRes.raw, '3.2M');

      const bRes = parseCount('1.1B');
      assert.equal(bRes.value, 1100000000n);
      assert.equal(bRes.isRounded, true);
      assert.equal(bRes.raw, '1.1B');
    });

    test('parseDate safely parses ISO strings, timestamps, and unix epoch seconds', () => {
      const iso = parseDate('2026-09-23T12:00:00.000Z');
      assert.equal(iso.toISOString(), '2026-09-23T12:00:00.000Z');

      const epochSec = parseDate(1790164800);
      assert.equal(epochSec.getTime(), 1790164800000);

      const nullDate = parseDate(null);
      assert.equal(nullDate, null);
    });

    test('normalizeTikTokOutput correctly parses valid TikTok item', () => {
      const rawItem = {
        id: '7123456789012345678',
        playCount: 154200,
        diggCount: 12500,
        commentCount: 840,
        shareCount: 320,
        createTimeISO: '2026-09-23T10:00:00.000Z',
        duration: 35,
        authorMeta: { name: 'creator_peak' }
      };

      const result = normalizeTikTokOutput(rawItem, 'https://www.tiktok.com/@creator_peak/video/7123456789012345678');
      assert.equal(result.status, 'AVAILABLE');
      assert.equal(result.platform, 'TIKTOK');
      assert.equal(result.views, 154200n);
      assert.equal(result.likes, 12500n);
      assert.equal(result.comments, 840n);
      assert.equal(result.shares, 320n);
      assert.equal(result.durationSeconds, 35);
      assert.equal(result.publishedAt, '2026-09-23T10:00:00.000Z');
      assert.equal(result.availability.views, 'AVAILABLE');
      assert.equal(result.availability.likes, 'AVAILABLE');
      assert.equal(result.metadata.author, 'creator_peak');
    });

    test('normalizeTikTokOutput flags deleted or private videos', () => {
      const deletedItem = { error: 'not_found', statusCode: 10204 };
      const res = normalizeTikTokOutput(deletedItem, 'https://www.tiktok.com/@u/video/1');
      assert.equal(res.status, 'NOT_FOUND');
      assert.equal(res.isPermanentDisappearance, true);

      const privateItem = { privateItem: true };
      const resPriv = normalizeTikTokOutput(privateItem, 'https://www.tiktok.com/@u/video/2');
      assert.equal(resPriv.status, 'NOT_FOUND');
      assert.equal(resPriv.isPermanentDisappearance, true);
    });

    test('normalizeFacebookOutput correctly parses valid Facebook Reel item with rounded views', () => {
      const rawItem = {
        id: '1029384756',
        playCount: '1.2M',
        reactionCount: 4500,
        commentsCount: 120,
        sharesCount: 55,
        timestamp: '2026-09-23T11:00:00.000Z',
        duration: 25,
        authorName: 'Peak Pages'
      };

      const result = normalizeFacebookOutput(rawItem, 'https://www.facebook.com/reel/1029384756/');
      assert.equal(result.status, 'AVAILABLE');
      assert.equal(result.platform, 'FACEBOOK');
      assert.equal(result.views, 1200000n);
      assert.equal(result.metadata.isRounded, true);
      assert.equal(result.metadata.rawViews, '1.2M');
      assert.equal(result.likes, 4500n);
      assert.equal(result.comments, 120n);
      assert.equal(result.shares, 55n);
      assert.equal(result.publishedAt, '2026-09-23T11:00:00.000Z');
      assert.equal(result.durationSeconds, 25);
    });

    test('normalizeFacebookOutput flags removed or unavailable Facebook Reels', () => {
      const removedItem = { unavailable: true, error: 'post_deleted' };
      const res = normalizeFacebookOutput(removedItem, 'https://www.facebook.com/reel/1');
      assert.equal(res.status, 'NOT_FOUND');
      assert.equal(res.isPermanentDisappearance, true);
    });

    test('normalizeInstagramOutput extracts standard Reel metrics with views', () => {
      const item = {
        id: '3328842104538965644',
        shortCode: 'Ddj5RcXMEiM',
        commentsCount: 0,
        likesCount: 42,
        videoPlayCount: 1556,
        videoDuration: 10.958,
        timestamp: '2026-09-21T19:19:25.000Z',
        ownerUsername: 'chainovaxe'
      };

      const result = normalizeInstagramOutput(item, 'https://www.instagram.com/reel/Ddj5RcXMEiM/');
      assert.equal(result.status, 'AVAILABLE');
      assert.equal(result.platform, 'INSTAGRAM');
      assert.equal(result.views, 1556n);
      assert.equal(result.likes, 42n);
      assert.equal(result.comments, 0n);
      assert.equal(result.durationSeconds, 11);
      assert.equal(result.publishedAt, '2026-09-21T19:19:25.000Z');
      assert.equal(result.metadata.author, 'chainovaxe');
      assert.equal(result.availability.views, 'AVAILABLE');
      assert.equal(result.availability.likes, 'AVAILABLE');
    });

    test('normalizeInstagramOutput flags removed or private Instagram Reels', () => {
      const privateItem = { isPrivate: true, error: 'post_deleted' };
      const res = normalizeInstagramOutput(privateItem, 'https://www.instagram.com/reel/Ddj5RcXMEiM/');
      assert.equal(res.status, 'NOT_FOUND');
      assert.equal(res.isPermanentDisappearance, true);
    });
  });

  // =========================================================================
  // 3. TIKTOK PROVIDER (MOCKED APIFY INTEGRATION)
  // =========================================================================
  describe('3. TikTok Provider via Apify', () => {
    test('returns DATA_UNAVAILABLE when Apify token is unconfigured', async () => {
      const mockClient = { isConfigured: () => false };
      const provider = new TikTokProvider(mockClient);

      const res = await provider.getCurrentMetrics('https://www.tiktok.com/@user/video/7123456789012345678');
      assert.equal(res.status, 'DATA_UNAVAILABLE');
      assert.equal(res.views, null);
      assert.match(res.reason, /Apify API token unconfigured/i);
    });

    test('extracts metrics for standard TikTok URL', async () => {
      const mockClient = {
        isConfigured: () => true,
        callActor: async (actorId, input) => {
          assert.equal(input.postURLs[0], 'https://www.tiktok.com/@user/video/7123456789012345678');
          return [{
            id: '7123456789012345678',
            playCount: 50000,
            diggCount: 4000,
            commentCount: 200,
            shareCount: 100,
            createTimeISO: '2026-09-23T11:30:00.000Z',
            duration: 15
          }];
        }
      };

      const provider = new TikTokProvider(mockClient);
      const res = await provider.getCurrentMetrics('https://www.tiktok.com/@user/video/7123456789012345678');

      assert.equal(res.status, 'AVAILABLE');
      assert.equal(res.views, 50000n);
      assert.equal(res.likes, 4000n);
      assert.equal(res.comments, 200n);
      assert.equal(res.shares, 100n);
      assert.equal(res.durationSeconds, 15);
      assert.equal(res.publishedAt, '2026-09-23T11:30:00.000Z');
    });

    test('supports vm.tiktok.com shortlinks without error', async () => {
      let calledUrl = null;
      const mockClient = {
        isConfigured: () => true,
        callActor: async (actorId, input) => {
          calledUrl = input.postURLs[0];
          return [{ playCount: 1000, diggCount: 100 }];
        }
      };

      const provider = new TikTokProvider(mockClient);
      const res = await provider.getCurrentMetrics('https://vm.tiktok.com/ZM8x7yZ/');
      assert.equal(calledUrl, 'https://vm.tiktok.com/ZM8x7yZ/');
      assert.equal(res.views, 1000n);
    });

    test('throws PermanentContentError when TikTok video is deleted or private', async () => {
      const mockClient = {
        isConfigured: () => true,
        callActor: async () => [{ error: 'not_found' }]
      };

      const provider = new TikTokProvider(mockClient);
      await assert.rejects(
        () => provider.getCurrentMetrics('https://www.tiktok.com/@u/video/7123456789012345678'),
        PermanentContentError
      );
    });

    test('throws TransientProviderError on Apify timeout', async () => {
      const mockClient = {
        isConfigured: () => true,
        callActor: async () => {
          throw new ApifyTimeoutError('Actor execution timed out');
        }
      };

      const provider = new TikTokProvider(mockClient);
      await assert.rejects(
        () => provider.getCurrentMetrics('https://www.tiktok.com/@u/video/7123456789012345678'),
        TransientProviderError
      );
    });

    test('throws RateLimitProviderError on Apify rate limit', async () => {
      const mockClient = {
        isConfigured: () => true,
        callActor: async () => {
          throw new ApifyRateLimitError('Rate limit exceeded');
        }
      };

      const provider = new TikTokProvider(mockClient);
      await assert.rejects(
        () => provider.getCurrentMetrics('https://www.tiktok.com/@u/video/7123456789012345678'),
        RateLimitProviderError
      );
    });
  });

  // =========================================================================
  // 4. FACEBOOK PROVIDER (MOCKED APIFY INTEGRATION)
  // =========================================================================
  describe('4. Facebook Provider via Apify', () => {
    test('returns DATA_UNAVAILABLE when Apify token and Meta token are unconfigured', async () => {
      const mockClient = { isConfigured: () => false };
      const provider = new FacebookProvider(mockClient, null, null);

      const res = await provider.getCurrentMetrics('https://www.facebook.com/reel/1029384756/');
      assert.equal(res.status, 'DATA_UNAVAILABLE');
      assert.equal(res.views, null);
    });

    test('extracts metrics for standard Facebook Reel URL', async () => {
      const mockClient = {
        isConfigured: () => true,
        callActor: async (actorId, input) => {
          assert.equal(input.startUrls[0].url, 'https://www.facebook.com/reel/1029384756/');
          return [{
            id: '1029384756',
            viewCount: 85000,
            reactionCount: 3200,
            commentsCount: 150,
            sharesCount: 75,
            timestamp: '2026-09-23T11:15:00.000Z',
            duration: 20
          }];
        }
      };

      const provider = new FacebookProvider(mockClient, null, null);
      const res = await provider.getCurrentMetrics('https://www.facebook.com/reel/1029384756/');

      assert.equal(res.status, 'AVAILABLE');
      assert.equal(res.views, 85000n);
      assert.equal(res.likes, 3200n);
      assert.equal(res.comments, 150n);
      assert.equal(res.shares, 75n);
      assert.equal(res.durationSeconds, 20);
      assert.equal(res.publishedAt, '2026-09-23T11:15:00.000Z');
    });

    test('supports fb.watch shortlinks and share/r URLs', async () => {
      let calledUrl = null;
      const mockClient = {
        isConfigured: () => true,
        callActor: async (actorId, input) => {
          calledUrl = input.startUrls[0].url;
          return [{ viewCount: 5000, reactionCount: 300 }];
        }
      };

      const provider = new FacebookProvider(mockClient, null, null);

      await provider.getCurrentMetrics('https://fb.watch/xyz987abc/');
      assert.equal(calledUrl, 'https://fb.watch/xyz987abc/');

      await provider.getCurrentMetrics('https://www.facebook.com/share/r/456789123/');
      assert.equal(calledUrl, 'https://www.facebook.com/share/r/456789123/');
    });

    test('throws PermanentContentError when Facebook video is removed or private', async () => {
      const mockClient = {
        isConfigured: () => true,
        callActor: async () => [{ unavailable: true }]
      };

      const provider = new FacebookProvider(mockClient, null, null);
      await assert.rejects(
        () => provider.getCurrentMetrics('https://www.facebook.com/reel/1029384756/'),
        PermanentContentError
      );
    });

    test('throws TransientProviderError on Apify timeout', async () => {
      const mockClient = {
        isConfigured: () => true,
        callActor: async () => {
          throw new ApifyTimeoutError('Actor execution timed out');
        }
      };

      const provider = new FacebookProvider(mockClient, null, null);
      await assert.rejects(
        () => provider.getCurrentMetrics('https://www.facebook.com/reel/1029384756/'),
        TransientProviderError
      );
    });
  });

  // =========================================================================
  // 4.5. INSTAGRAM PROVIDER VIA APIFY FALLBACK
  // =========================================================================
  describe('4.5. Instagram Provider via Apify Fallback', () => {
    test('falls back to Apify scraper when Meta token is unconfigured', async () => {
      const mockClient = {
        isConfigured: () => true,
        callActor: async (actorId, input) => {
          assert.equal(input.directUrls[0], 'https://www.instagram.com/reel/Ddj5RcXMEiM/');
          return [{
            shortCode: 'Ddj5RcXMEiM',
            videoPlayCount: 1556,
            likesCount: 42,
            commentsCount: 0,
            videoDuration: 10.958,
            timestamp: '2026-09-21T19:19:25.000Z',
            ownerUsername: 'chainovaxe'
          }];
        }
      };

      const provider = new InstagramProvider(mockClient, 'apify/instagram-scraper', null, null);
      const res = await provider.getCurrentMetrics('https://www.instagram.com/reels/Ddj5RcXMEiM/');

      assert.equal(res.status, 'AVAILABLE');
      assert.equal(res.platform, 'INSTAGRAM');
      assert.equal(res.views, 1556n);
      assert.equal(res.likes, 42n);
      assert.equal(res.comments, 0n);
      assert.equal(res.durationSeconds, 11);
      assert.equal(res.metadata.author, 'chainovaxe');
      assert.equal(res.metadata.source, 'APIFY_SCRAPER');
    });

    test('falls back to Apify scraper when Meta Graph API returns null views', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          business_discovery: {
            username: 'test_creator',
            media: {
              data: [
                {
                  id: 'ig_123',
                  permalink: 'https://www.instagram.com/reel/Ddj5RcXMEiM/',
                  like_count: 40,
                  comments_count: 5
                }
              ]
            }
          }
        })
      });

      const mockApify = {
        isConfigured: () => true,
        callActor: async () => [{
          shortCode: 'Ddj5RcXMEiM',
          videoPlayCount: 2000,
          likesCount: 40,
          commentsCount: 5,
          videoDuration: 15
        }]
      };

      // In this setup: custom fetch returns data with views=null, so Apify fallback provides views=2000n
      const provider = new InstagramProvider(mockApify, 'apify/instagram-scraper', 'meta_token', 'biz_id', mockFetch);
      const res = await provider.getCurrentMetrics('https://www.instagram.com/test_creator/reel/Ddj5RcXMEiM/');

      assert.equal(res.status, 'AVAILABLE');
      assert.equal(res.views, 2000n);
      assert.equal(res.likes, 40n);
      assert.equal(res.durationSeconds, 15);
    });

    test('getDuration returns duration resolved from Apify scraper', async () => {
      const mockApify = {
        isConfigured: () => true,
        callActor: async () => [{
          videoDuration: 12.4
        }]
      };

      const provider = new InstagramProvider(mockApify, 'apify/instagram-scraper', null, null);
      const res = await provider.getDuration('Ddj5RcXMEiM');
      assert.equal(res.status, 'AVAILABLE');
      assert.equal(res.durationSeconds, 12);
    });
  });

  // =========================================================================
  // 5. HOURLY POLLING & CAPABILITY INTEGRATION
  // =========================================================================
  describe('5. Hourly Polling & Capability Integration', () => {
    test('Facebook and TikTok capabilities are now enabled for automated tracking', () => {
      assert.equal(hasProviderCapability('FACEBOOK', 'fetchViews'), true);
      assert.equal(hasProviderCapability('FACEBOOK', 'fetchLikes'), true);
      assert.equal(hasProviderCapability('TIKTOK', 'fetchViews'), true);
      assert.equal(hasProviderCapability('TIKTOK', 'fetchLikes'), true);
      assert.equal(hasProviderCapability('TIKTOK', 'checkAvailability'), true);
      assert.equal(hasProviderCapability('FACEBOOK', 'checkAvailability'), true);
    });

    test('Approved Facebook and TikTok clips in active campaigns are eligible for hourly polling', () => {
      const campaign = { id: 'c1', status: 'ACTIVE' };
      const user = { id: 'u1', status: 'ACTIVE' };

      const fbSub = { platform: 'FACEBOOK', status: 'APPROVED', campaign, user };
      const ttSub = { platform: 'TIKTOK', status: 'APPROVED', campaign, user };

      const fbEligible = evaluatePollingEligibility(fbSub);
      assert.equal(fbEligible.eligible, true);

      const ttEligible = evaluatePollingEligibility(ttSub);
      assert.equal(ttEligible.eligible, true);
    });

    test('Unapproved Facebook and TikTok clips remain ineligible for polling', () => {
      const campaign = { id: 'c1', status: 'ACTIVE' };
      const user = { id: 'u1', status: 'ACTIVE' };

      const fbUnderReview = { platform: 'FACEBOOK', status: 'UNDER_REVIEW', campaign, user };
      const ttFlagged = { platform: 'TIKTOK', status: 'FLAGGED', campaign, user };

      assert.equal(evaluatePollingEligibility(fbUnderReview).eligible, false);
      assert.equal(evaluatePollingEligibility(ttFlagged).eligible, false);
    });
  });
});
