import { BasePlatformProvider } from '../base.provider.js';
import { apifyClientService } from '../../integrations/apify/apify.client.js';
import { normalizeTikTokOutput } from '../../integrations/apify/apify.normalizer.js';
import { mapApifyError } from '../../integrations/apify/apify.errors.js';
import { parseAndNormalizeUrl } from '../../modules/submissions/url.parser.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import {
  PermanentContentError,
  TransientProviderError
} from '../../modules/verification/verification.errors.js';

export class TikTokProvider extends BasePlatformProvider {
  /**
   * @param {object} [apifyClient=apifyClientService] - Injectable Apify client service
   * @param {string} [actorId] - Injectable actor ID
   */
  constructor(apifyClient = apifyClientService, actorId = null) {
    super('TIKTOK');
    this.apifyClient = apifyClient !== undefined ? apifyClient : apifyClientService;
    this.actorId = actorId || config.providers?.apify?.tiktokActorId || 'clockworks/free-tiktok-scraper';
  }

  /**
   * Resolve target TikTok URL from string (contentId or full URL)
   * @private
   */
  _resolveUrl(contentIdOrUrl) {
    if (typeof contentIdOrUrl !== 'string') return '';
    const trimmed = contentIdOrUrl.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed;
    }
    // TikTok video IDs are 15-22 digit snowflakes. Non-numeric or short test IDs are boundaries:
    if (/^\d{15,22}$/.test(trimmed)) {
      return `https://www.tiktok.com/video/${trimmed}`;
    }
    return '';
  }

  /**
   * Retrieve current TikTok video metrics via Apify public scraper
   *
   * @param {string} videoIdOrUrl
   * @returns {Promise<object>} Standardized provider result
   */
  async getCurrentMetrics(videoIdOrUrl) {
    const targetUrl = this._resolveUrl(videoIdOrUrl);

    if (!targetUrl || !this.apifyClient || !this.apifyClient.isConfigured()) {
      logger.debug({ targetUrl, videoIdOrUrl }, 'TikTok Apify scraping skipped: unconfigured or non-snowflake URL');
      return {
        platform: 'TIKTOK',
        url: targetUrl || '',
        isAvailable: true,
        views: null,
        likes: null,
        comments: null,
        shares: null,
        durationSeconds: null,
        publishedAt: null,
        status: 'DATA_UNAVAILABLE',
        availability: {
          views: 'UNAVAILABLE',
          likes: 'UNAVAILABLE',
          comments: 'UNAVAILABLE',
          shares: 'UNAVAILABLE',
          duration: 'NOT_SUPPORTED'
        },
        reason: 'TikTok metrics currently DATA_UNAVAILABLE (Apify API token unconfigured / zero OAuth credentials configured)'
      };
    }

    const input = {
      postURLs: [targetUrl],
      commentsPerPost: 0,
      maxItems: 1
    };

    let items;
    try {
      items = await this.apifyClient.callActor(this.actorId, input);
    } catch (err) {
      throw mapApifyError(err, 'TIKTOK', { url: targetUrl, actorId: this.actorId });
    }

    if (!items || items.length === 0) {
      throw new PermanentContentError(
        'TikTok video not found or is private (scraper returned 0 items)',
        'TIKTOK',
        { url: targetUrl, actorId: this.actorId }
      );
    }

    const normalized = normalizeTikTokOutput(items[0], targetUrl);

    if (normalized.status === 'NOT_FOUND' || normalized.isPermanentDisappearance) {
      throw new PermanentContentError(
        normalized.reason || 'TikTok video is private, removed, or unavailable',
        'TIKTOK',
        { url: targetUrl, actorId: this.actorId }
      );
    }

    return normalized;
  }

  /**
   * Check video availability
   * @param {string} videoIdOrUrl
   */
  async getAvailability(videoIdOrUrl) {
    try {
      const metrics = await this.getCurrentMetrics(videoIdOrUrl);
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
   * Check video duration
   * @param {string} videoIdOrUrl
   */
  async getDuration(videoIdOrUrl) {
    const metrics = await this.getCurrentMetrics(videoIdOrUrl);
    return {
      durationSeconds: metrics.durationSeconds ?? null,
      status: metrics.durationSeconds != null ? 'AVAILABLE' : 'NOT_SUPPORTED'
    };
  }

  /**
   * Fetch video metadata
   * @param {string} videoIdOrUrl
   */
  async getVideo(videoIdOrUrl) {
    return this.getCurrentMetrics(videoIdOrUrl);
  }

  /**
   * Alias for getCurrentMetrics matching polling worker contract
   * @param {string} videoIdOrUrl
   */
  async getVideoMetrics(videoIdOrUrl) {
    return this.getCurrentMetrics(videoIdOrUrl);
  }
}

export const tiktokProvider = new TikTokProvider();
export default tiktokProvider;
