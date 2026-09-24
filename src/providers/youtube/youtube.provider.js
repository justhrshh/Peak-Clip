import { BasePlatformProvider } from '../base.provider.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { parseAndNormalizeUrl } from '../../modules/submissions/url.parser.js';
import {
  TransientProviderError,
  PermanentContentError,
  ConfigurationAuthError,
  RateLimitProviderError
} from '../../modules/verification/verification.errors.js';

/**
 * Parse an ISO 8601 duration string (e.g. 'PT1M15S', 'PT30S', 'PT1H2M3S') into total seconds
 * @param {string} duration - ISO 8601 duration string
 * @returns {number|null} Total seconds or null if invalid
 */
export function parseIsoDuration(duration) {
  if (!duration || typeof duration !== 'string') return null;

  const match = duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;

  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);

  return hours * 3600 + minutes * 60 + seconds;
}

export class YouTubeProvider extends BasePlatformProvider {
  /**
   * @param {string} [apiKey]
   * @param {function} [fetchFn=globalThis.fetch] - Injectable fetch for fixture testing
   */
  constructor(apiKey, fetchFn = globalThis.fetch) {
    super('YOUTUBE');
    this.apiKey = arguments.length > 0 ? apiKey : config.providers?.youtubeApiKey;
    this.fetchFn = fetchFn || globalThis.fetch;
  }

  /**
   * Normalizes raw YouTube Data API v3 item response into the standardized provider contract
   * @param {object} item - YouTube API resource item
   * @param {string} videoId
   * @returns {object}
   */
  normalizeApiResponse(item, videoId) {
    if (!item) {
      throw new PermanentContentError('YouTube video not found, deleted, or removed', 'YOUTUBE', { videoId });
    }

    // Check video availability & privacy status
    const uploadStatus = item.status?.uploadStatus;
    const privacyStatus = item.status?.privacyStatus;

    if (privacyStatus === 'private') {
      throw new PermanentContentError('YouTube video is private and cannot be verified', 'YOUTUBE', { videoId });
    }
    if (uploadStatus === 'rejected' || uploadStatus === 'deleted') {
      throw new PermanentContentError(`YouTube video was ${uploadStatus}`, 'YOUTUBE', { videoId });
    }

    const stats = item.statistics || {};
    const snippet = item.snippet || {};
    const contentDetails = item.contentDetails || {};

    const hasViews = stats.viewCount !== undefined && stats.viewCount !== null;
    const hasLikes = stats.likeCount !== undefined && stats.likeCount !== null;
    const hasComments = stats.commentCount !== undefined && stats.commentCount !== null;

    const durationSeconds = contentDetails.duration ? parseIsoDuration(contentDetails.duration) : null;
    const hasDuration = durationSeconds !== null;

    return {
      platform: 'YOUTUBE',
      externalId: videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      isAvailable: true,
      views: hasViews ? BigInt(stats.viewCount) : null,
      likes: hasLikes ? BigInt(stats.likeCount) : null,
      comments: hasComments ? BigInt(stats.commentCount) : null,
      shares: null, // Note: YouTube Data API v3 does not expose public video shares
      durationSeconds,
      status: 'AVAILABLE',
      availability: {
        views: hasViews ? 'AVAILABLE' : 'UNAVAILABLE',
        likes: hasLikes ? 'AVAILABLE' : 'UNAVAILABLE',
        comments: hasComments ? 'AVAILABLE' : 'UNAVAILABLE',
        shares: 'NOT_SUPPORTED',
        duration: hasDuration ? 'AVAILABLE' : 'UNAVAILABLE'
      },
      metadata: {
        title: snippet.title || null,
        channelTitle: snippet.channelTitle || null,
        publishedAt: snippet.publishedAt || null,
        channelId: snippet.channelId || null,
        rawDuration: contentDetails.duration || null
      }
    };
  }

  /**
   * Retrieve current YouTube video engagement metrics via Data API v3
   * @param {string} videoId
   * @returns {Promise<object>}
   */
  async getCurrentMetrics(videoIdOrUrl) {
    let videoId = videoIdOrUrl;
    if (typeof videoIdOrUrl === 'string' && (videoIdOrUrl.includes('/') || videoIdOrUrl.includes('youtube.com') || videoIdOrUrl.includes('youtu.be') || videoIdOrUrl.includes('?'))) {
      try {
        const parsed = parseAndNormalizeUrl(videoIdOrUrl);
        if (parsed.contentId) {
          videoId = parsed.contentId;
        }
      } catch {
        const match = videoIdOrUrl.match(/(?:shorts\/|v\/|watch\?v=|youtu\.be\/|\/v=|^)([a-zA-Z0-9_-]{11})/);
        if (match) videoId = match[1];
      }
    }

    if (!this.apiKey) {
      logger.debug('YouTube API key not configured; returning DATA_UNAVAILABLE');
      return {
        platform: 'YOUTUBE',
        externalId: videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        isAvailable: true,
        views: null,
        likes: null,
        comments: null,
        shares: null,
        durationSeconds: null,
        status: 'DATA_UNAVAILABLE',
        availability: {
          views: 'UNAVAILABLE',
          likes: 'UNAVAILABLE',
          comments: 'UNAVAILABLE',
          shares: 'NOT_SUPPORTED',
          duration: 'UNAVAILABLE'
        },
        reason: 'YOUTUBE_API_KEY is not configured in environment'
      };
    }

    const endpoint = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,status,contentDetails&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(this.apiKey)}`;

    let response;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      response = await this.fetchFn(endpoint, {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });
      clearTimeout(timeout);
    } catch (err) {
      throw new TransientProviderError(`YouTube network request failed: ${err.message}`, 'YOUTUBE');
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');

      // Check for bad API key / invalid credentials
      if (response.status === 400 && (errorText.includes('API key not valid') || errorText.includes('keyInvalid'))) {
        throw new ConfigurationAuthError('YouTube API key is invalid or unauthorized', 'YOUTUBE', {
          status: response.status
        });
      }

      // Quota / Rate limit (403 quotaExceeded or 429)
      if (response.status === 429 || (response.status === 403 && (errorText.includes('quotaExceeded') || errorText.includes('rateLimitExceeded')))) {
        const retryAfterHeader = response.headers?.get?.('retry-after');
        const retryAfterMs = (parseInt(retryAfterHeader, 10) || 60) * 1000;
        throw new RateLimitProviderError('YouTube API quota or rate limit exceeded', 'YOUTUBE', retryAfterMs, {
          status: response.status
        });
      }

      if (response.status === 403) {
        throw new ConfigurationAuthError('YouTube API permission denied or key restricted', 'YOUTUBE', { status: 403 });
      }

      if (response.status === 404) {
        throw new PermanentContentError('YouTube video not found (HTTP 404)', 'YOUTUBE', { videoId });
      }

      if (response.status >= 500) {
        throw new TransientProviderError(`YouTube upstream service error (${response.status})`, 'YOUTUBE');
      }

      throw new PermanentContentError(`YouTube API error HTTP ${response.status}`, 'YOUTUBE');
    }

    let data;
    try {
      data = await response.json();
    } catch (parseErr) {
      throw new TransientProviderError('Malformed JSON received from YouTube Data API', 'YOUTUBE');
    }

    const item = data.items?.[0];
    return this.normalizeApiResponse(item, videoId);
  }

  /**
   * Alias for getCurrentMetrics matching polling worker contract
   * @param {string} videoId
   * @returns {Promise<object>}
   */
  async getVideoMetrics(videoId) {
    return this.getCurrentMetrics(videoId);
  }

  /**
   * Check video availability
   * @param {string} videoId
   */
  async getAvailability(videoId) {
    try {
      const result = await this.getCurrentMetrics(videoId);
      return { isAvailable: result.isAvailable, status: result.status, availability: result.availability };
    } catch (err) {
      if (err instanceof PermanentContentError) {
        return { isAvailable: false, status: 'UNAVAILABLE', reason: err.message };
      }
      throw err;
    }
  }

  /**
   * Fetch video clip duration in seconds
   * @param {string} videoId
   * @returns {Promise<{ durationSeconds: number|null, status: string, reason?: string }>}
   */
  async getDuration(videoId) {
    try {
      const result = await this.getCurrentMetrics(videoId);
      return {
        durationSeconds: result.durationSeconds,
        status: result.availability?.duration || 'UNAVAILABLE'
      };
    } catch (err) {
      if (err instanceof PermanentContentError) {
        return { durationSeconds: null, status: 'UNAVAILABLE', reason: err.message };
      }
      throw err;
    }
  }
}

export const youtubeProvider = new YouTubeProvider();
export default youtubeProvider;
