import {
  ConfigurationAuthError,
  RateLimitProviderError,
  TransientProviderError,
  PermanentContentError
} from '../../modules/verification/verification.errors.js';

export class ApifyError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'ApifyError';
    this.context = context;
  }
}

export class ApifyAuthError extends ApifyError {
  constructor(message = 'Apify authentication failed. Invalid or missing API token.', context = {}) {
    super(message, context);
    this.name = 'ApifyAuthError';
  }
}

export class ApifyRateLimitError extends ApifyError {
  constructor(message = 'Apify API rate limit exceeded.', context = {}) {
    super(message, context);
    this.name = 'ApifyRateLimitError';
  }
}

export class ApifyTimeoutError extends ApifyError {
  constructor(message = 'Apify Actor run timed out.', context = {}) {
    super(message, context);
    this.name = 'ApifyTimeoutError';
  }
}

export class ApifyServerError extends ApifyError {
  constructor(message = 'Apify upstream server error.', context = {}) {
    super(message, context);
    this.name = 'ApifyServerError';
  }
}

export class ApifyContentNotFoundError extends ApifyError {
  constructor(message = 'Target content not found or removed on source platform.', context = {}) {
    super(message, context);
    this.name = 'ApifyContentNotFoundError';
  }
}

/**
 * Maps Apify specific errors to system-wide verification errors
 *
 * @param {Error} error
 * @param {string} platform
 * @param {object} [context={}]
 * @returns {Error}
 */
export function mapApifyError(error, platform, context = {}) {
  const safeContext = { ...context, platform };

  if (error instanceof ApifyAuthError) {
    return new ConfigurationAuthError(
      `Apify authentication failed: ${error.message}. Check APIFY_API_TOKEN.`,
      platform,
      safeContext
    );
  }

  if (error instanceof ApifyRateLimitError) {
    return new RateLimitProviderError(
      `Apify rate limit exceeded for ${platform}: ${error.message}`,
      platform,
      safeContext
    );
  }

  if (error instanceof ApifyTimeoutError) {
    return new TransientProviderError(
      `Apify Actor run timed out for ${platform}: ${error.message}`,
      platform,
      safeContext
    );
  }

  if (error instanceof ApifyContentNotFoundError) {
    return new PermanentContentError(
      `${platform} content is private, removed, or not found: ${error.message}`,
      platform,
      safeContext
    );
  }

  if (error instanceof ApifyServerError) {
    return new TransientProviderError(
      `Apify upstream service error for ${platform}: ${error.message}`,
      platform,
      safeContext
    );
  }

  // Already a standard domain error
  if (
    error instanceof ConfigurationAuthError ||
    error instanceof RateLimitProviderError ||
    error instanceof TransientProviderError ||
    error instanceof PermanentContentError
  ) {
    return error;
  }

  // Fallback to transient provider error so jobs are retried safely
  return new TransientProviderError(
    `Unexpected provider error during ${platform} scraping: ${error.message}`,
    platform,
    safeContext
  );
}
