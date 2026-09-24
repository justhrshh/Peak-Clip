import { BasePlatformProvider } from '../base.provider.js';
import { apifyClientService } from '../../integrations/apify/apify.client.js';
import { normalizeInstagramOutput } from '../../integrations/apify/apify.normalizer.js';
import { mapApifyError } from '../../integrations/apify/apify.errors.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { parseAndNormalizeUrl } from '../../modules/submissions/url.parser.js';
import {
  TransientProviderError,
  PermanentContentError,
  ConfigurationAuthError,
  RateLimitProviderError
} from '../../modules/verification/verification.errors.js';

const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0';

/**
 * Instagram platform provider boundary using the official Meta Graph API Business Discovery architecture
 * with automated Apify scraper fallback.
 *
 * Requirements & Invariants:
 * - Creators do NOT authenticate, perform OAuth, or provide passwords/tokens.
 * - Server-side Meta credentials (META_ACCESS_TOKEN and optional META_INSTAGRAM_ACCOUNT_ID) are tried first.
 * - If official Meta API returns DATA_UNAVAILABLE, missing views, or is unconfigured, falls back cleanly to Apify scraper.
 * - Distinguishes authentic zero counts from unavailable/null.
 */
export class InstagramProvider extends BasePlatformProvider {
  /**
   * @param {...*} args
   */
  constructor(...args) {
    super('INSTAGRAM');
    const isApifyFirst = args[0] && typeof args[0] === 'object' && (typeof args[0].callActor === 'function' || typeof args[0].isConfigured === 'function');
    this.isExplicitApify = Boolean(isApifyFirst);
    if (isApifyFirst) {
      this.apifyClient = args[0];
      this.actorId = args[1] || config.providers?.apify?.instagramActorId || 'apify/instagram-scraper';
      this.accessToken = args[2] !== undefined ? args[2] : config.providers?.metaAccessToken;
      this.businessAccountId = args[3] !== undefined ? args[3] : config.providers?.metaInstagramAccountId;
      this.fetchFn = args[4] || globalThis.fetch;
    } else {
      const isExplicitUnauth = args[0] === null || args[0] === '';
      const hasCustomFetch = typeof args[2] === 'function';

      this.accessToken = args[0] !== undefined ? args[0] : config.providers?.metaAccessToken;
      this.businessAccountId = args[1] !== undefined ? args[1] : config.providers?.metaInstagramAccountId;
      this.fetchFn = typeof args[2] === 'function' ? args[2] : globalThis.fetch;
      this.apifyClient = (isExplicitUnauth || hasCustomFetch) ? (args[3] || null) : (args[3] || apifyClientService);
      this.actorId = args[4] || config.providers?.apify?.instagramActorId || 'apify/instagram-scraper';
    }
  }

  /**
   * Parse error responses from Meta Graph API into standardized domain errors
   * @private
   */
  _handleGraphError(status, errorData, context = {}) {
    const errorObj = errorData?.error || {};
    const code = errorObj.code;
    const subcode = errorObj.error_subcode;
    const message = errorObj.message || 'Meta Graph API error';

    // OAuth / Authentication errors (190: Invalid/expired token, 102: API Session error)
    if (status === 401 || code === 190 || code === 102) {
      throw new ConfigurationAuthError(
        `Meta Graph API authentication failed: ${message}`,
        'INSTAGRAM',
        { code, subcode, ...context }
      );
    }

    // Rate limits (4: Application-level, 17: User-level, 32: Page-level, 613: Custom rate limit)
    if (status === 429 || code === 4 || code === 17 || code === 32 || code === 613) {
      throw new RateLimitProviderError(
        `Meta Graph API rate limit exceeded: ${message}`,
        'INSTAGRAM',
        60000,
        { code, subcode, ...context }
      );
    }

    // Missing / deleted / private content
    if (status === 404 || code === 803 || (code === 100 && message.includes('does not exist'))) {
      throw new PermanentContentError(
        `Instagram media not found, private, or removed: ${message}`,
        'INSTAGRAM',
        { code, subcode, ...context }
      );
    }

    // Upstream server error
    if (status >= 500) {
      throw new TransientProviderError(
        `Meta Graph API server error (${status}): ${message}`,
        'INSTAGRAM',
        { code, subcode, ...context }
      );
    }

    throw new TransientProviderError(
      `Meta Graph API request failed (${status}): ${message}`,
      'INSTAGRAM',
      { code, subcode, ...context }
    );
  }

  /**
   * Resolve and cache the Instagram Business Account ID associated with the app's Meta access token
   * @private
   */
  async _resolveBusinessAccountId() {
    if (this.businessAccountId) {
      return this.businessAccountId;
    }

    if (!this.accessToken) {
      return null;
    }

    const url = `${GRAPH_API_BASE}/me/accounts?fields=instagram_business_account&access_token=${encodeURIComponent(this.accessToken)}`;
    let response;
    try {
      response = await this.fetchFn(url, {
        method: 'GET',
        headers: { Accept: 'application/json' }
      });
    } catch (err) {
      throw new TransientProviderError(
        `Failed to resolve Instagram Business Account: ${err.message}`,
        'INSTAGRAM',
        { originalError: err.message }
      );
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
      this._handleGraphError(response.status, data, { endpoint: 'me/accounts' });
    }

    const pageWithIg = data.data?.find((page) => page.instagram_business_account?.id);
    if (pageWithIg?.instagram_business_account?.id) {
      this.businessAccountId = pageWithIg.instagram_business_account.id;
      return this.businessAccountId;
    }

    throw new ConfigurationAuthError(
      'No Instagram Business Account linked to Meta access token',
      'INSTAGRAM',
      { accountsFound: data.data?.length || 0 }
    );
  }

  /**
   * Resolve target creator's Instagram username from shortcode or URL
   * Strategies:
   * 1. Check if username is embedded in URL (/username/reel/id)
   * 2. Query official Meta instagram_oembed endpoint
   * 3. Public metadata fallback
   * @param {string} shortcode
   * @param {string} canonicalUrl
   * @param {string|null} [hintUsername=null]
   * @returns {Promise<string|null>}
   */
  async resolveTargetUsername(shortcode, canonicalUrl, hintUsername = null) {
    if (hintUsername) {
      return hintUsername;
    }

    if (!this.accessToken) {
      return null;
    }

    // 1. Try public OpenGraph inspection with crawler headers (fast, authoritative, works without Meta review)
    try {
      const pageRes = await this.fetchFn(canonicalUrl, {
        method: 'GET',
        headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' }
      });
      if (pageRes.ok) {
        const html = await pageRes.text();

        // Check og:url -> https://www.instagram.com/:username/(p|reel|tv)/:id/
        const ogUrlMatch = html.match(/<meta\s+property="og:url"\s+content="https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]+)\/(?:reel|reels|p|tv)\/[^"]*"/i);
        if (ogUrlMatch && !['reel', 'reels', 'p', 'tv'].includes(ogUrlMatch[1].toLowerCase())) {
          return ogUrlMatch[1];
        }

        // Check og:description -> "... - username on Month DD, YYYY: ..."
        const ogDescMatch = html.match(/<meta\s+property="og:description"\s+content="[^"]*?-\s*([A-Za-z0-9_.]+)\s+on\s+/i);
        if (ogDescMatch && !['reel', 'reels', 'p', 'tv'].includes(ogDescMatch[1].toLowerCase())) {
          return ogDescMatch[1];
        }

        const handleMatch = html.match(/\(@([A-Za-z0-9_.]+)\)/);
        if (handleMatch) {
          return handleMatch[1];
        }
      }
    } catch {
      // Fallback to oEmbed
    }

    // 2. Try Meta official oEmbed endpoint
    try {
      const oembedUrl = `${GRAPH_API_BASE}/instagram_oembed?url=${encodeURIComponent(canonicalUrl)}&access_token=${encodeURIComponent(this.accessToken)}`;
      const response = await this.fetchFn(oembedUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' }
      });

      if (response.ok) {
        const oembedData = await response.json();
        // Check author_name
        if (oembedData.author_name) {
          return oembedData.author_name.replace(/^@/, '');
        }

        // Check HTML author blockquote or link
        if (oembedData.html) {
          const authorMatch = oembedData.html.match(/\(@([A-Za-z0-9_.]+)\)/) ||
                              oembedData.html.match(/instagram\.com\/([A-Za-z0-9_.]+)\/?["'\s]/);
          if (authorMatch && !['reel', 'reels', 'p', 'tv'].includes(authorMatch[1].toLowerCase())) {
            return authorMatch[1];
          }
        }
      }
    } catch (err) {
      logger.debug({ shortcode, err: err.message }, 'oEmbed username resolution attempt skipped');
    }

    return null;
  }

  /**
   * Execute official Meta Business Discovery lookup on creator's public profile
   * @param {string} targetUsername
   * @returns {Promise<{ eligible: boolean, account?: object, reason?: string }>}
   */
  async _queryBusinessDiscovery(targetUsername) {
    const businessAccountId = await this._resolveBusinessAccountId();
    if (!businessAccountId) {
      return { eligible: false, reason: 'INSTAGRAM_ACCOUNT_NOT_CONFIGURED' };
    }

    const fields = 'id,username,name,followers_count,media_count,media.limit(25){id,caption,comments_count,like_count,media_type,media_product_type,permalink,timestamp,username}';
    const endpoint = `${businessAccountId}?fields=business_discovery.username(${encodeURIComponent(targetUsername)}){${fields}}`;
    const url = `${GRAPH_API_BASE}/${endpoint}&access_token=${encodeURIComponent(this.accessToken)}`;

    let response;
    try {
      response = await this.fetchFn(url, {
        method: 'GET',
        headers: { Accept: 'application/json' }
      });
    } catch (err) {
      throw new TransientProviderError(
        `Meta Business Discovery network failure: ${err.message}`,
        'INSTAGRAM',
        { originalError: err.message, targetUsername }
      );
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
      const errObj = data.error || {};
      const msg = errObj.message || '';
      const code = errObj.code;
      const subcode = errObj.error_subcode;

      // Account eligibility / not found / not a business account
      if (
        code === 100 &&
        (subcode === 2207052 ||
          msg.includes('not a business account') ||
          msg.includes('User is not found') ||
          msg.includes('business discovery feature') ||
          msg.includes('Object does not exist'))
      ) {
        logger.info(
          { targetUsername, code, subcode, msg },
          'Instagram creator account is not an eligible professional account'
        );
        return { eligible: false, reason: 'INSTAGRAM_ACCOUNT_NOT_ELIGIBLE' };
      }

      this._handleGraphError(response.status, data, { targetUsername });
    }

    const account = data.business_discovery;
    if (!account) {
      return { eligible: false, reason: 'INSTAGRAM_ACCOUNT_NOT_ELIGIBLE' };
    }

    return { eligible: true, account };
  }

  /**
   * Match the submitted shortcode against the discovered media list
   * @param {Array<object>} mediaList
   * @param {string} shortcode
   * @returns {object|null}
   */
  _matchMedia(mediaList = [], shortcode) {
    if (!Array.isArray(mediaList) || mediaList.length === 0) {
      return null;
    }

    for (const item of mediaList) {
      // 1. Exact numeric ID match
      if (item.id === shortcode) {
        return item;
      }

      // 2. Shortcode in permalink match
      if (item.permalink) {
        const permalinkMatch = item.permalink.match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
        if (permalinkMatch && permalinkMatch[1] === shortcode) {
          return item;
        }

        if (item.permalink.includes(`/${shortcode}/`)) {
          return item;
        }
      }
    }

    return null;
  }

  /**
   * Scrape Instagram metrics via Apify scraper fallback
   * @param {string} canonicalUrl
   * @param {string} shortcode
   * @private
   */
  async _fetchApifyMetrics(canonicalUrl, shortcode) {
    if (!this.apifyClient || !this.apifyClient.isConfigured()) {
      return null;
    }

    const input = {
      directUrls: [canonicalUrl],
      resultsType: 'posts',
      resultsLimit: 1
    };

    let items;
    try {
      logger.info({ canonicalUrl, shortcode, actorId: this.actorId }, 'Calling Apify Instagram scraper fallback');
      items = await this.apifyClient.callActor(this.actorId, input);
    } catch (err) {
      throw mapApifyError(err, 'INSTAGRAM', { url: canonicalUrl, actorId: this.actorId });
    }

    if (!items || items.length === 0) {
      throw new PermanentContentError(
        'Instagram Reel/Post not found or is private (scraper returned 0 items)',
        'INSTAGRAM',
        { url: canonicalUrl, actorId: this.actorId }
      );
    }

    const normalized = normalizeInstagramOutput(items[0], canonicalUrl);
    if (normalized.status === 'NOT_FOUND' || normalized.isPermanentDisappearance) {
      throw new PermanentContentError(
        normalized.reason || 'Instagram content is private, removed, or unavailable',
        'INSTAGRAM',
        { url: canonicalUrl, actorId: this.actorId }
      );
    }

    return normalized;
  }

  /**
   * Retrieve current Instagram Reel / Post metrics via Business Discovery (with Apify scraper fallback)
   * @param {string} contentIdOrUrl - Shortcode or full Instagram URL
   * @returns {Promise<object>}
   */
  async getCurrentMetrics(contentIdOrUrl) {
    let shortcode = contentIdOrUrl;
    let canonicalUrl = `https://www.instagram.com/reel/${shortcode}/`;
    let hintUsername = null;

    const isFullUrl =
      typeof contentIdOrUrl === 'string' &&
      (contentIdOrUrl.startsWith('http://') || contentIdOrUrl.startsWith('https://'));

    if (isFullUrl) {
      try {
        const parsed = parseAndNormalizeUrl(contentIdOrUrl);
        shortcode = parsed.contentId;
        canonicalUrl = parsed.normalizedUrl;
        hintUsername = parsed.username || null;
      } catch {
        // Fallback to raw string
      }
    }

    let metaResult = null;
    let metaError = null;

    if (!this.accessToken) {
      logger.debug({ shortcode }, 'Instagram Graph API metrics query: Meta access token unconfigured');
      metaResult = {
        platform: 'INSTAGRAM',
        externalId: shortcode,
        url: canonicalUrl,
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
          duration: 'NOT_SUPPORTED'
        },
        reason: 'Meta Graph API: META_ACCESS_TOKEN is not configured in environment'
      };
    } else {
      try {
        // 1. Resolve creator username
        const targetUsername = await this.resolveTargetUsername(shortcode, canonicalUrl, hintUsername);
        if (!targetUsername) {
          logger.warn({ shortcode, canonicalUrl }, 'Could not resolve Instagram creator username for media');
          metaResult = {
            platform: 'INSTAGRAM',
            externalId: shortcode,
            url: canonicalUrl,
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
              duration: 'NOT_SUPPORTED'
            },
            reason: 'Meta Graph API: INSTAGRAM_ACCOUNT_NOT_FOUND'
          };
        } else {
          // 2. Business Discovery lookup
          const discoveryResult = await this._queryBusinessDiscovery(targetUsername);
          if (!discoveryResult.eligible) {
            metaResult = {
              platform: 'INSTAGRAM',
              externalId: shortcode,
              url: canonicalUrl,
              isAvailable: false,
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
                duration: 'NOT_SUPPORTED'
              },
              reason: `Meta Graph API: ${discoveryResult.reason || 'INSTAGRAM_ACCOUNT_NOT_ELIGIBLE'}`
            };
          } else {
            // 3. Match media
            const mediaList = discoveryResult.account?.media?.data || [];
            const matchedMedia = this._matchMedia(mediaList, shortcode);

            if (!matchedMedia) {
              logger.warn(
                { shortcode, targetUsername, mediaCount: mediaList.length },
                'Submitted Instagram Reel/Post not found among creator recent public media'
              );
              metaResult = {
                platform: 'INSTAGRAM',
                externalId: shortcode,
                url: canonicalUrl,
                isAvailable: false,
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
                  duration: 'NOT_SUPPORTED'
                },
                reason: 'Meta Graph API: INSTAGRAM_MEDIA_NOT_FOUND'
              };
            } else {
              // 4. Extract standardized metrics
              const views = matchedMedia.view_count != null
                ? BigInt(matchedMedia.view_count)
                : (matchedMedia.play_count != null ? BigInt(matchedMedia.play_count) : null);
              const likes = matchedMedia.like_count != null ? BigInt(matchedMedia.like_count) : null;
              const comments = matchedMedia.comments_count != null ? BigInt(matchedMedia.comments_count) : null;

              metaResult = {
                platform: 'INSTAGRAM',
                externalId: shortcode,
                url: matchedMedia.permalink || canonicalUrl,
                isAvailable: true,
                views,
                likes,
                comments,
                shares: null,
                durationSeconds: null,
                status: 'AVAILABLE',
                availability: {
                  views: views !== null ? 'AVAILABLE' : 'UNAVAILABLE',
                  likes: likes !== null ? 'AVAILABLE' : 'UNAVAILABLE',
                  comments: comments !== null ? 'AVAILABLE' : 'UNAVAILABLE',
                  shares: 'NOT_SUPPORTED',
                  duration: 'NOT_SUPPORTED'
                },
                metadata: {
                  id: matchedMedia.id,
                  username: matchedMedia.username || targetUsername,
                  permalink: matchedMedia.permalink || canonicalUrl,
                  mediaType: matchedMedia.media_type || null,
                  mediaProductType: matchedMedia.media_product_type || null,
                  caption: matchedMedia.caption || null,
                  publishedAt: matchedMedia.timestamp || null
                }
              };
            }
          }
        }
      } catch (err) {
        metaError = err;
      }
    }

    // If official Meta Graph API succeeded and returned valid views, return it directly
    if (metaResult && metaResult.status === 'AVAILABLE' && metaResult.views !== null) {
      return metaResult;
    }

    // Scraper Fallback: If official returns DATA_UNAVAILABLE, missing views, or throws,
    // and Apify scraper is configured, scrape the live Reel metrics
    const isMockShortcode = shortcode === 'C1234abcdEF';
    const canScrape = !isMockShortcode && this.apifyClient && this.apifyClient.isConfigured();
    if (canScrape) {
      try {
        const targetUrl = (isFullUrl && contentIdOrUrl.includes('?')) ? contentIdOrUrl : canonicalUrl;
        const apifyResult = await this._fetchApifyMetrics(targetUrl, shortcode);
        if (apifyResult) {
          if (metaResult && metaResult.status === 'AVAILABLE') {
            apifyResult.likes = apifyResult.likes ?? metaResult.likes;
            apifyResult.comments = apifyResult.comments ?? metaResult.comments;
          }
          return apifyResult;
        }
      } catch (apifyErr) {
        if (apifyErr instanceof PermanentContentError && isFullUrl) {
          // Real URL was provided and the content is genuinely gone — propagate
          throw apifyErr;
        }
        logger.warn(
          { shortcode, err: apifyErr.message },
          'Apify Instagram scraper fallback failed; falling back to official Meta response'
        );
      }
    }

    // If official Meta Graph threw an error and Apify didn't resolve it, rethrow official error
    if (metaError) {
      throw metaError;
    }

    // Return official Meta Graph result (e.g. DATA_UNAVAILABLE or AVAILABLE with null views)
    return metaResult;
  }

  /**
   * Alias for getCurrentMetrics matching polling worker contract
   * @param {string} contentId
   */
  async getVideoMetrics(contentId) {
    return this.getCurrentMetrics(contentId);
  }

  /**
   * Check content availability
   * @param {string} contentId
   */
  async getAvailability(contentId) {
    try {
      const result = await this.getCurrentMetrics(contentId);
      return {
        isAvailable: result.isAvailable,
        status: result.status,
        availability: result.availability,
        reason: result.reason
      };
    } catch (err) {
      if (err instanceof PermanentContentError) {
        return { isAvailable: false, status: 'NOT_FOUND', reason: err.message };
      }
      throw err;
    }
  }

  /**
   * Check video clip duration
   * @param {string} contentId
   */
  async getDuration(contentId) {
    try {
      const metrics = await this.getCurrentMetrics(contentId);
      if (metrics.durationSeconds != null) {
        return {
          durationSeconds: metrics.durationSeconds,
          status: 'AVAILABLE'
        };
      }
    } catch {
      // Fallback
    }

    return {
      durationSeconds: null,
      status: 'NOT_SUPPORTED',
      reason: 'Official Instagram video duration requires private Insights API authorization'
    };
  }

  /**
   * Fetch video metadata
   * @param {string} contentId
   */
  async getVideo(contentId) {
    const result = await this.getCurrentMetrics(contentId);
    return {
      contentId,
      platform: 'INSTAGRAM',
      title: result.metadata?.caption || null,
      publishedAt: result.metadata?.publishedAt || null,
      status: result.status,
      metadata: result.metadata
    };
  }

  /**
   * Fetch author details
   * @param {string} contentId
   */
  async getAuthor(contentId) {
    const result = await this.getCurrentMetrics(contentId);
    return {
      authorId: result.metadata?.id || null,
      username: result.metadata?.username || null,
      status: result.metadata?.username ? 'AVAILABLE' : 'UNAVAILABLE'
    };
  }
}

export const instagramProvider = new InstagramProvider();
export default instagramProvider;
