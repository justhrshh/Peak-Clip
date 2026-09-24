import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeProvider } from '../../src/providers/youtube/youtube.provider.js';

const isIntegrationEnabled = process.env.RUN_PROVIDER_INTEGRATION_TESTS === 'true';
const apiKey = process.env.YOUTUBE_API_KEY;

describe('Live YouTube Provider Integration Tests (Opt-In)', { concurrency: 1 }, () => {
  if (!isIntegrationEnabled || !apiKey) {
    test('skipped: live integration test requires RUN_PROVIDER_INTEGRATION_TESTS=true and YOUTUBE_API_KEY', (t) => {
      t.skip('Skipping live YouTube integration tests: RUN_PROVIDER_INTEGRATION_TESTS not enabled or YOUTUBE_API_KEY missing');
    });
    return;
  }

  // Canonical YouTube video (Rick Astley - Never Gonna Give You Up)
  const CANONICAL_VIDEO_ID = 'dQw4w9WgXcQ';

  test('fetches real metrics from YouTube Data API v3 and normalizes correctly', async () => {
    const provider = new YouTubeProvider({ apiKey });
    const result = await provider.getCurrentMetrics(CANONICAL_VIDEO_ID);

    assert.equal(result.isAvailable, true);
    assert.equal(result.status, 'AVAILABLE');

    // Metrics should be non-negative BigInts
    assert.equal(typeof result.views, 'bigint');
    assert.ok(result.views > 1000000000n, 'Views should exceed 1 billion');

    // Likes may be bigint or null (if hidden)
    if (result.likes !== null) {
      assert.equal(typeof result.likes, 'bigint');
      assert.ok(result.likes > 0n);
      assert.equal(result.availability.likes, 'AVAILABLE');
    } else {
      assert.equal(result.availability.likes, 'UNAVAILABLE');
    }

    // Comments may be bigint or null (if disabled)
    if (result.comments !== null) {
      assert.equal(typeof result.comments, 'bigint');
      assert.ok(result.comments > 0n);
      assert.equal(result.availability.comments, 'AVAILABLE');
    } else {
      assert.equal(result.availability.comments, 'UNAVAILABLE');
    }

    // Shares are unsupported by public YouTube API
    assert.equal(result.shares, null);
    assert.equal(result.availability.shares, 'NOT_SUPPORTED');

    // Metadata should contain title and channelTitle
    assert.ok(result.metadata);
    assert.ok(result.metadata.title);
    assert.ok(result.metadata.channelTitle);
  });

  test('returns PERMANENT_CONTENT error for non-existent video', async () => {
    const provider = new YouTubeProvider({ apiKey });
    await assert.rejects(
      () => provider.getCurrentMetrics('non_existent_id_99999999'),
      (err) => {
        assert.equal(err.name, 'PermanentContentError');
        return true;
      }
    );
  });
});
