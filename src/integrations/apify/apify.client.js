import { ApifyClient } from 'apify-client';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import {
  ApifyError,
  ApifyAuthError,
  ApifyRateLimitError,
  ApifyTimeoutError,
  ApifyServerError
} from './apify.errors.js';

export class ApifyClientService {
  /**
   * @param {string} [apiToken]
   * @param {object} [clientInstance] - Injectable ApifyClient instance for tests
   */
  constructor(apiToken, clientInstance = null) {
    this.token = arguments.length > 0 && apiToken !== undefined
      ? apiToken
      : config.providers?.apify?.apiToken;
    this.client = clientInstance || (this.token ? new ApifyClient({ token: this.token }) : null);
    this._inflight = new Map();
  }

  /**
   * Check if Apify service is configured with a valid token
   * @returns {boolean}
   */
  isConfigured() {
    return Boolean(this.token && typeof this.token === 'string' && this.token.trim().length > 0);
  }

  /**
   * Call an Apify Actor and retrieve the dataset items
   *
   * Features:
   * - Enforces timeout protection to limit external costs
   * - Deduplicates concurrent identical requests
   * - Never exposes API token in logs or exceptions
   * - Classifies upstream errors into clean domain types
   *
   * @param {string} actorId - Apify actor name or ID (e.g. 'clockworks/free-tiktok-scraper')
   * @param {object} input - Input payload for the actor
   * @param {object} [options={}]
   * @param {number} [options.timeoutSecs] - Max seconds to wait for run completion
   * @param {number} [options.maxItems=1] - Maximum items to retrieve from dataset
   * @returns {Promise<Array<object>>} Raw items from default dataset
   */
  async callActor(actorId, input, options = {}) {
    if (!this.isConfigured() || !this.client) {
      throw new ApifyAuthError('Apify API token is not configured (APIFY_API_TOKEN is empty)');
    }

    const timeoutSecs = options.timeoutSecs || config.providers?.apify?.timeoutSecs || 60;
    const maxItems = options.maxItems || 1;

    // Concurrency Deduplication Key: prevent redundant duplicate actor runs
    const dedupKey = `${actorId}:${JSON.stringify(input)}`;
    if (this._inflight.has(dedupKey)) {
      logger.debug({ actorId }, 'Reusing existing in-flight Apify Actor execution');
      return this._inflight.get(dedupKey);
    }

    const runPromise = (async () => {
      const startTime = Date.now();
      logger.info(
        { actorId, timeoutSecs, maxItems },
        'Starting Apify Actor run'
      );

      let run;
      try {
        // Start Actor run and wait for it to finish (or timeout)
        run = await this.client.actor(actorId).call(input, {
          timeout: timeoutSecs,
          memory: 512
        });
      } catch (err) {
        const durationMs = Date.now() - startTime;
        this._handleActorCallError(err, actorId, durationMs);
      }

      const durationMs = Date.now() - startTime;
      const runId = run?.id || 'unknown';
      const status = run?.status || 'UNKNOWN';

      logger.info(
        { actorId, runId, status, durationMs },
        'Apify Actor run finished'
      );

      if (status === 'TIMED-OUT') {
        throw new ApifyTimeoutError(`Apify Actor ${actorId} timed out after ${durationMs}ms`, {
          actorId,
          runId,
          durationMs
        });
      }

      if (status === 'FAILED' || status === 'ABORTED') {
        throw new ApifyServerError(`Apify Actor ${actorId} finished with status ${status}`, {
          actorId,
          runId,
          status,
          durationMs
        });
      }

      // Retrieve dataset items
      try {
        const datasetId = run.defaultDatasetId;
        const dataset = await this.client.dataset(datasetId).listItems({
          limit: maxItems
        });

        const items = dataset.items || [];
        logger.debug(
          { actorId, runId, itemsCount: items.length },
          'Retrieved Apify dataset items'
        );

        return items;
      } catch (err) {
        throw new ApifyServerError(`Failed to fetch dataset items for actor ${actorId}: ${err.message}`, {
          actorId,
          runId
        });
      }
    })();

    // Store in-flight promise and cleanup on settled
    this._inflight.set(dedupKey, runPromise);
    try {
      return await runPromise;
    } finally {
      this._inflight.delete(dedupKey);
    }
  }

  /**
   * Classify Apify SDK / HTTP errors without leaking credentials
   * @private
   */
  _handleActorCallError(err, actorId, durationMs) {
    const status = err.statusCode || err.status || 0;
    const msg = err.message || '';

    logger.warn(
      { actorId, status, durationMs, errorMsg: msg },
      'Apify actor invocation encountered an error'
    );

    if (status === 401 || status === 403 || msg.includes('token is not valid') || msg.includes('Unauthorized')) {
      throw new ApifyAuthError(`Apify authentication failed: ${msg}`, { actorId, status });
    }

    if (status === 429 || msg.includes('rate limit') || msg.includes('too many requests')) {
      throw new ApifyRateLimitError(`Apify rate limit exceeded: ${msg}`, { actorId, status });
    }

    if (msg.includes('timed out') || msg.includes('TIMEOUT') || durationMs >= 55000) {
      throw new ApifyTimeoutError(`Apify run timed out after ${durationMs}ms: ${msg}`, {
        actorId,
        durationMs
      });
    }

    if (status >= 500) {
      throw new ApifyServerError(`Apify upstream server error (${status}): ${msg}`, { actorId, status });
    }

    throw new ApifyError(`Apify Actor ${actorId} failed: ${msg}`, { actorId, status });
  }
}

export const apifyClientService = new ApifyClientService();
export default apifyClientService;
