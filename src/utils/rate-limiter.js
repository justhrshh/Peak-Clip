import { AppError } from './errors.js';
import { config } from '../config/index.js';

export class RateLimitExceededError extends AppError {
  /**
   * @param {string} action
   * @param {number} retryAfterSeconds
   */
  constructor(action, retryAfterSeconds) {
    super(
      `Rate limit exceeded for action '${action}'. Please wait ${retryAfterSeconds} second(s) before retrying.`,
      'RATE_LIMIT_EXCEEDED',
      429,
      { action, retryAfterSeconds }
    );
  }
}

/**
 * Robust in-memory sliding window rate limiter
 * Tracks request timestamps per key with automatic garbage collection of expired buckets.
 */
class RateLimiter {
  constructor() {
    this.buckets = new Map();
  }

  /**
   * Check and consume rate limit token
   *
   * @param {string} key - Identifier (e.g. `submit:usr_123`)
   * @param {number} limit - Maximum requests allowed in window
   * @param {number} windowSeconds - Sliding window duration in seconds
   * @returns {{ allowed: boolean, remaining: number, resetSeconds: number }}
   */
  consume(key, limit, windowSeconds) {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const windowStart = now - windowMs;

    let timestamps = this.buckets.get(key) || [];

    // Filter out timestamps outside current sliding window
    timestamps = timestamps.filter((t) => t > windowStart);

    if (timestamps.length >= limit) {
      const oldestInWindow = timestamps[0];
      const resetSeconds = Math.max(1, Math.ceil((oldestInWindow + windowMs - now) / 1000));
      this.buckets.set(key, timestamps);
      return {
        allowed: false,
        remaining: 0,
        resetSeconds
      };
    }

    // Record this request
    timestamps.push(now);
    this.buckets.set(key, timestamps);

    return {
      allowed: true,
      remaining: limit - timestamps.length,
      resetSeconds: windowSeconds
    };
  }

  /**
   * Clear all buckets (useful in test teardown)
   */
  reset() {
    this.buckets.clear();
  }
}

export const rateLimiter = new RateLimiter();

/**
 * Enforce rate limit for submission creation
 * @param {string} userId
 * @throws {RateLimitExceededError}
 */
export function enforceSubmissionRateLimit(userId) {
  const limit = config.rateLimits?.submitPerMinute || 10;
  const result = rateLimiter.consume(`submit:${userId}`, limit, 60);
  if (!result.allowed) {
    throw new RateLimitExceededError('submit_clip', result.resetSeconds);
  }
}

/**
 * Enforce rate limit for payout requests
 * @param {string} userId
 * @throws {RateLimitExceededError}
 */
export function enforcePayoutRateLimit(userId) {
  const limit = config.rateLimits?.payoutPerMinute || 5;
  const result = rateLimiter.consume(`payout:${userId}`, limit, 60);
  if (!result.allowed) {
    throw new RateLimitExceededError('request_payout', result.resetSeconds);
  }
}
