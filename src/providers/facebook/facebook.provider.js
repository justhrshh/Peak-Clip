import { BasePlatformProvider } from '../base.provider.js';
import { apifyClientService } from '../../integrations/apify/apify.client.js';
import { normalizeFacebookOutput } from '../../integrations/apify/apify.normalizer.js';
import { mapApifyError } from '../../integrations/apify/apify.errors.js';
import { parseAndNormalizeUrl } from '../../modules/submissions/url.parser.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import {
  PermanentContentError,
  TransientProviderError,
  ConfigurationAuthError,
  RateLimitProviderError
} from '../../modules/verification/verification.errors.js';

const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0';

export class FacebookProvider extends BasePlatformProvider {
  /**
   * @param {...*} args
   */
  constructor(...args) {
    super('FACEBOOK');
    const isApifyFirst = args[0] && typeof args[0] === 'object' && (typeof args[0].callActor === 'function' || typeof args[0].isConfigured === 'function');
    if (isApifyFirst) {
      this.apifyClient = args[0];
      this.actorId = args[1] || config.providers?.apify?.facebookActorId || 'apify/facebook-posts-scraper';
      this.metaAccessToken = args[2] !== undefined ? args[2] : config.providers?.metaAccessToken;
      this.fetchFn = args[3] || globalThis.fetch;
    } else {
      // Legacy or explicit signature:
      // If args[0] === null || args[0] === '' => explicit unauthenticated (disable both Apify and Meta)
      // If typeof args[1] === 'function' => custom fetchFn provided for Meta Graph API (disable Apify)
      const isExplicitUnauth = args[0] === null || args[0] === '';
      const hasCustomFetch = typeof args[1] === 'function';

      this.apifyClient = (isExplicitUnauth || hasCustomFetch) ? null : apifyClientService;
      this.actorId = config.providers?.apify?.facebookActorId || 'apify/facebook-posts-scraper';
      this.metaAccessToken = args[0] !== undefined ? args[0] : config.providers?.metaAccessToken;
      this.fetchFn = typeof args[1] === 'function' ? args[1] : globalThis.fetch;
    }
  }

  /**
   * Resolve target Facebook URL from string (contentId or full URL)
   * @private
   */
  _resolveUrl(contentIdOrUrl) {
    if (typeof contentIdOrUrl !== 'string') return '';
    const trimmed = contentIdOrUrl.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      try {
        const u = new URL(trimmed);
        return `${u.origin}${u.pathname}`;
      } catch {
        return trimmed;
      }
    }
    // Reconstruct canonical Reel URL from ID
    return `https://www.facebook.com/reel/${trimmed}/`;
  }

  /**
   * Retrieve current Facebook metrics via Apify public scraper (or Meta Graph API fallback)
   *
   * @param {string} contentIdOrUrl
   * @returns {Promise<object>} Standardized provider result
   */
  async getCurrentMetrics(contentIdOrUrl) {
    const targetUrl = this._resolveUrl(contentIdOrUrl);

    // 1. Primary: Automated scraping via Apify if configured
    if (this.apifyClient && this.apifyClient.isConfigured()) {
      const input = {
        startUrls: [{ url: targetUrl }],
        resultsLimit: 1
      };

      let items;
      try {
        items = await this.apifyClient.callActor(this.actorId, input);
      } catch (err) {
        throw mapApifyError(err, 'FACEBOOK', { url: targetUrl, actorId: this.actorId });
      }

      if (!items || items.length === 0) {
        throw new PermanentContentError(
          'Facebook Reel/Video not found or is private (scraper returned 0 items)',
          'FACEBOOK',
          { url: targetUrl, actorId: this.actorId }
        );
      }

      const normalized = normalizeFacebookOutput(items[0], targetUrl);

      if (normalized.status === 'NOT_FOUND' || normalized.isPermanentDisappearance) {
        throw new PermanentContentError(
          normalized.reason || 'Facebook content is private, removed, or unavailable',
          'FACEBOOK',
          { url: targetUrl, actorId: this.actorId }
        );
      }

      return normalized;
    }

    // 2. Secondary: Meta Graph API fallback if Meta access token is configured
    if (this.metaAccessToken) {
      return this._fetchMetaGraphMetrics(contentIdOrUrl);
    }

    const contentId = typeof contentIdOrUrl === 'string' && !contentIdOrUrl.startsWith('http')
      ? contentIdOrUrl
      : (targetUrl.match(/\/(?:reel|reels|watch|videos)\/([A-Za-z0-9_-]+)/)?.[1] || null);

    // 3. Graceful fallback when neither is configured
    logger.debug({ targetUrl }, 'Facebook scraping skipped: APIFY_API_TOKEN and META_ACCESS_TOKEN unconfigured');
    return {
      platform: 'FACEBOOK',
      url: targetUrl,
      contentId,
      isAvailable: true,
      views: null,
      likes: null,
      comments: null,
      shares: null,
      durationSeconds: null,
      publishedAt: null,
      status: 'DATA_UNAVAILABLE',
      availability: {
        views: 'TEMPORARILY_UNAVAILABLE',
        likes: 'TEMPORARILY_UNAVAILABLE',
        comments: 'TEMPORARILY_UNAVAILABLE',
        shares: 'NOT_SUPPORTED',
        duration: 'NOT_SUPPORTED'
      },
      reason: 'Facebook metrics currently DATA_UNAVAILABLE (Apify API token unconfigured / zero Meta Graph API authorization configured)'
    };
  }

  /**
   * Meta Graph API fallback implementation
   * @private
   */
  async _fetchMetaGraphMetrics(contentIdOrUrl) {
    let contentId = contentIdOrUrl;
    if (typeof contentIdOrUrl === 'string' && (contentIdOrUrl.startsWith('http://') || contentIdOrUrl.startsWith('https://'))) {
      const match = contentIdOrUrl.match(/\/(?:reel|reels|watch|videos)\/([A-Za-z0-9_-]+)/);
      if (match) contentId = match[1];
    }

    const fields = ['id', 'title', 'description', 'length', 'views', 'likes.summary(true)', 'comments.summary(true)', 'created_time'];
    const fieldQuery = `&fields=${fields.join(',')}`;
    const url = `${GRAPH_API_BASE}/${contentId}?access_token=${encodeURIComponent(this.metaAccessToken)}${fieldQuery}`;

    let response;
    try {
      response = await this.fetchFn(url, { method: 'GET', headers: { Accept: 'application/json' } });
    } catch (err) {
      throw new TransientProviderError(`Meta Graph API network failure: ${err.message}`, 'FACEBOOK', { contentId });
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new TransientProviderError('Meta Graph API returned malformed JSON', 'FACEBOOK', { contentId });
    }

    if (!response.ok || data.error) {
      const errObj = data?.error || {};
      const status = response.status;
      if (status === 401 || errObj.code === 190) {
        throw new ConfigurationAuthError(`Meta Graph API auth failed: ${errObj.message}`, 'FACEBOOK');
      }
      if (status === 429 || [4, 17, 32, 613].includes(errObj.code)) {
        throw new RateLimitProviderError(`Meta Graph API rate limit: ${errObj.message}`, 'FACEBOOK');
      }
      if (status === 404 || errObj.code === 803 || (errObj.code === 100 && errObj.message?.includes('does not exist'))) {
        throw new PermanentContentError(`Facebook video not found: ${errObj.message}`, 'FACEBOOK');
      }
      throw new TransientProviderError(`Meta Graph API error: ${errObj.message}`, 'FACEBOOK');
    }

    const views = data.views != null ? BigInt(data.views) : null;
    const likes = data.likes?.summary?.total_count != null ? BigInt(data.likes.summary.total_count) : null;
    const comments = data.comments?.summary?.total_count != null ? BigInt(data.comments.summary.total_count) : null;
    const durationSeconds = data.length != null ? Math.round(Number(data.length)) : null;

    return {
      isAvailable: true,
      platform: 'FACEBOOK',
      views,
      likes,
      comments,
      shares: null,
      publishedAt: data.created_time || null,
      durationSeconds,
      status: 'AVAILABLE',
      availability: {
        views: views !== null ? 'AVAILABLE' : 'UNAVAILABLE',
        likes: likes !== null ? 'AVAILABLE' : 'UNAVAILABLE',
        comments: comments !== null ? 'AVAILABLE' : 'UNAVAILABLE',
        shares: 'NOT_SUPPORTED',
        duration: durationSeconds !== null ? 'AVAILABLE' : 'NOT_SUPPORTED'
      },
      metadata: {
        source: 'META_GRAPH_API',
        id: data.id,
        title: data.title || null
      }
    };
  }

  /**
   * Check content availability
   * @param {string} contentIdOrUrl
   */
  async getAvailability(contentIdOrUrl) {
    try {
      const metrics = await this.getCurrentMetrics(contentIdOrUrl);
      if (metrics.status === 'DATA_UNAVAILABLE') {
        return {
          isAvailable: true,
          status: 'DATA_UNAVAILABLE',
          reason: metrics.reason
        };
      }
      return {
        isAvailable: metrics.isAvailable,
        status: metrics.status || 'AVAILABLE'
      };
    } catch (err) {
      if (err instanceof PermanentContentError) {
        return {
          isAvailable: false,
          status: 'NOT_FOUND',
          reason: err.message,
          isPermanentDisappearance: true
        };
      }
      throw err;
    }
  }

  /**
   * Check clip duration
   * @param {string} contentIdOrUrl
   */
  async getDuration(contentIdOrUrl) {
    const metrics = await this.getCurrentMetrics(contentIdOrUrl);
    return {
      durationSeconds: metrics.durationSeconds ?? null,
      status: metrics.durationSeconds != null ? 'AVAILABLE' : 'NOT_SUPPORTED'
    };
  }

  /**
   * Fetch video metadata
   * @param {string} contentIdOrUrl
   */
  async getVideo(contentIdOrUrl) {
    const metrics = await this.getCurrentMetrics(contentIdOrUrl);
    return {
      ...metrics,
      contentId: metrics.contentId || (typeof contentIdOrUrl === 'string' && !contentIdOrUrl.startsWith('http') ? contentIdOrUrl : null)
    };
  }

  /**
   * Fetch author metadata
   * @param {string} contentIdOrUrl
   */
  async getAuthor(contentIdOrUrl) {
    return {
      platform: 'FACEBOOK',
      authorId: null,
      status: 'DATA_UNAVAILABLE'
    };
  }

  /**
   * Alias for getCurrentMetrics matching polling worker contract
   * @param {string} contentIdOrUrl
   */
  async getVideoMetrics(contentIdOrUrl) {
    return this.getCurrentMetrics(contentIdOrUrl);
  }
}

export const facebookProvider = new FacebookProvider();
export default facebookProvider;
