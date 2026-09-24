export class AppError extends Error {
  /**
   * @param {string} message
   * @param {string} [code='INTERNAL_ERROR']
   * @param {number} [statusCode=500]
   * @param {Record<string, any>} [details={}]
   */
  constructor(message, code = 'INTERNAL_ERROR', statusCode = 500, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message, details = {}) {
    super(message, 'VALIDATION_ERROR', 400, details);
  }
}

export class DatabaseError extends AppError {
  constructor(message, details = {}) {
    super(message, 'DATABASE_ERROR', 500, details);
  }
}

export class ProviderError extends AppError {
  constructor(message, provider = 'unknown', details = {}) {
    super(message, 'PROVIDER_ERROR', 502, { provider, ...details });
  }
}

export class QueueError extends AppError {
  constructor(message, queueName = 'unknown', details = {}) {
    super(message, 'QUEUE_ERROR', 500, { queueName, ...details });
  }
}

/**
 * Format error for safe logging and reporting
 * @param {Error|AppError} error
 * @returns {Record<string, any>}
 */
export function formatError(error) {
  if (error instanceof AppError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      statusCode: error.statusCode,
      details: error.details,
      stack: error.stack,
      userMessage: `⚠️ ${error.message}`
    };
  }

  return {
    name: error.name || 'Error',
    code: 'UNEXPECTED_ERROR',
    message: error.message || 'An unexpected error occurred',
    statusCode: 500,
    stack: error.stack,
    userMessage: '❌ An unexpected error occurred while processing your request. Please try again later.'
  };
}
