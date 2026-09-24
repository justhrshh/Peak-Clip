import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeProvider } from '../src/providers/youtube/youtube.provider.js';
import { YOUTUBE_FIXTURES } from './fixtures/youtube.fixtures.js';
import {
  TransientProviderError,
  PermanentContentError,
  ConfigurationAuthError,
  RateLimitProviderError
} from '../src/modules/verification/verification.errors.js';
import { parseAndNormalizeUrl } from '../src/modules/submissions/url.parser.js';

describe('YouTube Provider API Response Normalization', () => {
  const provider = new YouTubeProvider('test_api_key');

  test('normalizes standard video response with full metrics', () => {
    const item = YOUTUBE_FIXTURES.STANDARD_VIDEO.items[0];
    const normalized = provider.normalizeApiResponse(item, 'dQw4w9WgXcQ');

    assert.equal(normalized.platform, 'YOUTUBE');
    assert.equal(normalized.externalId, 'dQw4w9WgXcQ');
    assert.equal(normalized.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(normalized.isAvailable, true);
    assert.equal(normalized.views, 1500000n);
    assert.equal(normalized.likes, 150000n);
    assert.equal(normalized.comments, 25000n);
    assert.equal(normalized.shares, null);
    assert.equal(normalized.availability.views, 'AVAILABLE');
    assert.equal(normalized.availability.likes, 'AVAILABLE');
    assert.equal(normalized.availability.comments, 'AVAILABLE');
    assert.equal(normalized.availability.shares, 'NOT_SUPPORTED');
    assert.equal(normalized.metadata.title, 'Rick Astley - Never Gonna Give You Up (Official Music Video)');
    assert.equal(normalized.metadata.channelTitle, 'Rick Astley');
  });

  test('preserves null for hidden likes (does NOT convert to zero)', () => {
    const item = YOUTUBE_FIXTURES.HIDDEN_LIKES_VIDEO.items[0];
    const normalized = provider.normalizeApiResponse(item, 'vid_hidden_likes');

    assert.equal(normalized.views, 50000n);
    assert.equal(normalized.likes, null, 'Hidden likes must be null, never 0');
    assert.equal(normalized.comments, 1200n);
    assert.equal(normalized.availability.likes, 'UNAVAILABLE');
    assert.equal(normalized.availability.views, 'AVAILABLE');
  });

  test('preserves null for disabled comments (does NOT convert to zero)', () => {
    const item = YOUTUBE_FIXTURES.DISABLED_COMMENTS_VIDEO.items[0];
    const normalized = provider.normalizeApiResponse(item, 'vid_no_comments');

    assert.equal(normalized.views, 25000n);
    assert.equal(normalized.likes, 800n);
    assert.equal(normalized.comments, null, 'Disabled comments must be null, never 0');
    assert.equal(normalized.availability.comments, 'UNAVAILABLE');
    assert.equal(normalized.availability.views, 'AVAILABLE');
  });

  test('preserves true zero counts (0 is treated as 0n, not null)', () => {
    const item = YOUTUBE_FIXTURES.ZERO_VIEWS_VIDEO.items[0];
    const normalized = provider.normalizeApiResponse(item, 'vid_zero_views');

    assert.equal(normalized.views, 0n);
    assert.equal(normalized.likes, 0n);
    assert.equal(normalized.comments, 0n);
    assert.equal(normalized.availability.views, 'AVAILABLE');
    assert.equal(normalized.availability.likes, 'AVAILABLE');
  });

  test('throws PermanentContentError for private video', () => {
    const item = YOUTUBE_FIXTURES.PRIVATE_VIDEO.items[0];
    assert.throws(
      () => provider.normalizeApiResponse(item, 'vid_private'),
      (err) => {
        assert.ok(err instanceof PermanentContentError);
        assert.ok(err.message.includes('private'));
        return true;
      }
    );
  });

  test('throws PermanentContentError for rejected/removed video', () => {
    const item = YOUTUBE_FIXTURES.REJECTED_VIDEO.items[0];
    assert.throws(
      () => provider.normalizeApiResponse(item, 'vid_rejected'),
      (err) => {
        assert.ok(err instanceof PermanentContentError);
        assert.ok(err.message.includes('rejected'));
        return true;
      }
    );
  });

  test('throws PermanentContentError for deleted/empty video list', () => {
    assert.throws(
      () => provider.normalizeApiResponse(null, 'vid_missing'),
      (err) => {
        assert.ok(err instanceof PermanentContentError);
        assert.ok(err.message.includes('not found, deleted, or removed'));
        return true;
      }
    );
  });
});

describe('YouTube Provider Network & Error Classification', () => {
  test('handles 403 quotaExceeded by throwing RateLimitProviderError', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 403,
      text: async () => YOUTUBE_FIXTURES.QUOTA_EXCEEDED_BODY,
      headers: new Map()
    });

    const client = new YouTubeProvider('test_key', mockFetch);
    await assert.rejects(
      () => client.getCurrentMetrics('test_vid'),
      (err) => {
        assert.ok(err instanceof RateLimitProviderError);
        assert.equal(err.statusCode, 429);
        assert.equal(err.details.retryable, true);
        return true;
      }
    );
  });

  test('handles 429 rate limit with retry-after header', async () => {
    const headers = new Map([['retry-after', '120']]);
    const mockFetch = async () => ({
      ok: false,
      status: 429,
      text: async () => 'Rate limit exceeded',
      headers: { get: (k) => headers.get(k) }
    });

    const client = new YouTubeProvider('test_key', mockFetch);
    await assert.rejects(
      () => client.getCurrentMetrics('test_vid'),
      (err) => {
        assert.ok(err instanceof RateLimitProviderError);
        assert.equal(err.details.retryAfterMs, 120000);
        return true;
      }
    );
  });

  test('handles 400 invalid API key by throwing ConfigurationAuthError', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 400,
      text: async () => YOUTUBE_FIXTURES.INVALID_API_KEY_BODY,
      headers: new Map()
    });

    const client = new YouTubeProvider('test_key', mockFetch);
    await assert.rejects(
      () => client.getCurrentMetrics('test_vid'),
      (err) => {
        assert.ok(err instanceof ConfigurationAuthError);
        assert.equal(err.details.category, 'CONFIGURATION_OR_AUTH');
        assert.equal(err.details.retryable, false);
        return true;
      }
    );
  });

  test('handles upstream 500 error by throwing TransientProviderError', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 500,
      text: async () => 'Internal server error',
      headers: new Map()
    });

    const client = new YouTubeProvider('test_key', mockFetch);
    await assert.rejects(
      () => client.getCurrentMetrics('test_vid'),
      (err) => {
        assert.ok(err instanceof TransientProviderError);
        assert.equal(err.details.retryable, true);
        return true;
      }
    );
  });

  test('handles network failure / timeout by throwing TransientProviderError', async () => {
    const mockFetch = async () => {
      throw new Error('Connection reset by peer');
    };

    const client = new YouTubeProvider('test_key', mockFetch);
    await assert.rejects(
      () => client.getCurrentMetrics('test_vid'),
      (err) => {
        assert.ok(err instanceof TransientProviderError);
        assert.equal(err.details.retryable, true);
        return true;
      }
    );
  });

  test('handles malformed JSON body safely', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      }
    });

    const client = new YouTubeProvider('test_key', mockFetch);
    await assert.rejects(
      () => client.getCurrentMetrics('test_vid'),
      (err) => {
        assert.ok(err instanceof TransientProviderError);
        assert.ok(err.message.includes('Malformed JSON'));
        return true;
      }
    );
  });

  test('returns DATA_UNAVAILABLE cleanly when API key is unconfigured', async () => {
    const client = new YouTubeProvider('');
    const result = await client.getCurrentMetrics('any_vid');
    assert.equal(result.status, 'DATA_UNAVAILABLE');
    assert.equal(result.isAvailable, true);
    assert.equal(result.views, null);
  });
});

describe('YouTube URL & Video ID Parsing Formats', () => {
  test('extracts ID from standard watch URL', () => {
    const res = parseAndNormalizeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(res.platform, 'YOUTUBE');
    assert.equal(res.contentId, 'dQw4w9WgXcQ');
    assert.equal(res.normalizedUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  test('extracts ID from Shorts URL', () => {
    const res = parseAndNormalizeUrl('https://youtube.com/shorts/3Z0WjT7gZkw');
    assert.equal(res.platform, 'YOUTUBE');
    assert.equal(res.contentId, '3Z0WjT7gZkw');
    assert.equal(res.normalizedUrl, 'https://www.youtube.com/shorts/3Z0WjT7gZkw');
  });

  test('extracts ID from youtu.be shortlink', () => {
    const res = parseAndNormalizeUrl('https://youtu.be/dQw4w9WgXcQ?si=abcdef123');
    assert.equal(res.platform, 'YOUTUBE');
    assert.equal(res.contentId, 'dQw4w9WgXcQ');
    assert.equal(res.normalizedUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  test('extracts ID from embed URL', () => {
    const res = parseAndNormalizeUrl('https://www.youtube.com/embed/dQw4w9WgXcQ');
    assert.equal(res.platform, 'YOUTUBE');
    assert.equal(res.contentId, 'dQw4w9WgXcQ');
    assert.equal(res.normalizedUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  test('strips tracking parameters without altering normalized identity', () => {
    const urlWithTracking = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=twitter&si=tracking123&fbclid=abc';
    const res = parseAndNormalizeUrl(urlWithTracking);
    assert.equal(res.normalizedUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });
});
