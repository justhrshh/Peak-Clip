import { AppError } from '../../utils/errors.js';

/**
 * Transient retryable provider failures (network timeouts, rate limits 429, upstream 502/503)
 */
export class TransientProviderError extends AppError {
  constructor(message, provider = 'unknown', details = {}) {
    super(message, 'TRANSIENT_PROVIDER_ERROR', 503, {
      provider,
      category: 'TRANSIENT',
      retryable: true,
      ...details
    });
  }
}

/**
 * Configuration or authorization errors (missing API key, invalid credentials, expired OAuth)
 * Operator/infrastructure failure — must NOT cause submission to be marked permanently invalid
 */
export class ConfigurationAuthError extends AppError {
  constructor(message, provider = 'unknown', details = {}) {
    super(message, 'CONFIGURATION_AUTH_ERROR', 500, {
      provider,
      category: 'CONFIGURATION_OR_AUTH',
      retryable: false, // Do not hammer provider when credentials are bad
      requiresStaffAction: true,
      ...details
    });
  }
}

/**
 * Permanent content failures (video deleted, private video, 404, removed by creator)
 * Content is permanently inaccessible
 */
export class PermanentContentError extends AppError {
  constructor(message, provider = 'unknown', details = {}) {
    super(message, 'PERMANENT_CONTENT_ERROR', 400, {
      provider,
      category: 'PERMANENT_CONTENT',
      retryable: false,
      ...details
    });
  }
}

/**
 * Backward compatibility alias for PermanentContentError
 */
export class PermanentProviderError extends PermanentContentError {
  constructor(message, provider = 'unknown', details = {}) {
    super(message, provider, details);
  }
}

/**
 * Malformed identifier or invalid provider query request
 */
export class ValidationProviderError extends AppError {
  constructor(message, provider = 'unknown', details = {}) {
    super(message, 'VALIDATION_PROVIDER_ERROR', 400, {
      provider,
      category: 'VALIDATION',
      retryable: false,
      ...details
    });
  }
}

/**
 * Rate limit (HTTP 429) provider failure with backoff awareness
 */
export class RateLimitProviderError extends AppError {
  constructor(message, provider = 'unknown', retryAfterMs = 60000, details = {}) {
    super(message, 'RATE_LIMIT_PROVIDER_ERROR', 429, {
      provider,
      category: 'RATE_LIMIT',
      retryable: true,
      retryAfterMs,
      ...details
    });
  }
}

/**
 * Unsupported provider operation (e.g. attempting to fetch metrics from a boundary with no metric API)
 */
export class UnsupportedOperationError extends AppError {
  constructor(message, provider = 'unknown', operation = 'fetchMetrics', details = {}) {
    super(message, 'UNSUPPORTED_OPERATION', 400, {
      provider,
      operation,
      category: 'UNSUPPORTED',
      retryable: false,
      ...details
    });
  }
}

/**
 * General verification execution failure
 */
export class VerificationFailedError extends AppError {
  constructor(submissionId, reason, details = {}) {
    super(`Verification failed for submission ${submissionId}: ${reason}`, 'VERIFICATION_FAILED', 500, {
      submissionId,
      reason,
      ...details
    });
  }
}
