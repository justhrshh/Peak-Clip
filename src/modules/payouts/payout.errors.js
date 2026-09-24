import { AppError } from '../../utils/errors.js';

export class PayoutError extends AppError {
  /**
   * @param {string} message
   * @param {string} [code='PAYOUT_ERROR']
   * @param {number} [statusCode=500]
   * @param {Record<string, any>} [details={}]
   */
  constructor(message, code = 'PAYOUT_ERROR', statusCode = 500, details = {}) {
    super(message, code, statusCode, details);
  }
}

export class InsufficientBalanceError extends PayoutError {
  /**
   * @param {string} requested
   * @param {string} available
   * @param {string} currency
   */
  constructor(requested, available, currency) {
    super(
      `Insufficient available balance. Requested: ${requested} ${currency}, Available: ${available} ${currency}`,
      'INSUFFICIENT_BALANCE',
      400,
      { requested, available, currency }
    );
  }
}

export class BelowMinimumPayoutError extends PayoutError {
  /**
   * @param {string} requested
   * @param {string} minimum
   * @param {string} currency
   */
  constructor(requested, minimum, currency) {
    super(
      `Requested amount ${requested} ${currency} is below the minimum payout requirement of ${minimum} ${currency}`,
      'BELOW_MINIMUM_PAYOUT',
      400,
      { requested, minimum, currency }
    );
  }
}

export class InvalidPayoutStatusTransitionError extends PayoutError {
  /**
   * @param {string} fromStatus
   * @param {string} toStatus
   */
  constructor(fromStatus, toStatus) {
    super(
      `Invalid payout status transition from '${fromStatus}' to '${toStatus}'`,
      'INVALID_PAYOUT_STATUS_TRANSITION',
      400,
      { fromStatus, toStatus }
    );
  }
}

export class UnauthorizedPayoutAccessError extends PayoutError {
  /**
   * @param {string} message
   */
  constructor(message = 'You do not have permission to access or modify this payout request.') {
    super(message, 'UNAUTHORIZED_PAYOUT_ACCESS', 403);
  }
}

export class InactiveUserError extends PayoutError {
  /**
   * @param {string} userId
   * @param {string} status
   */
  constructor(userId, status) {
    super(
      `User ${userId} cannot request payouts because account status is ${status}`,
      'INACTIVE_USER',
      403,
      { userId, status }
    );
  }
}

export class InvalidCurrencyError extends PayoutError {
  /**
   * @param {string} currency
   * @param {string} reason
   */
  constructor(currency, reason = 'Unsupported or invalid currency') {
    super(`Invalid currency '${currency}': ${reason}`, 'INVALID_CURRENCY', 400, { currency, reason });
  }
}

export class PayoutNotFoundError extends PayoutError {
  /**
   * @param {string} payoutRequestId
   */
  constructor(payoutRequestId) {
    super(`Payout request not found: ${payoutRequestId}`, 'PAYOUT_NOT_FOUND', 404, { payoutRequestId });
  }
}

export class PayoutEvidenceRequiredError extends PayoutError {
  constructor(message = 'An analytics screen recording under 40 seconds is required to submit a payout request.') {
    super(message, 'PAYOUT_EVIDENCE_REQUIRED', 400);
    this.name = 'PayoutEvidenceRequiredError';
  }
}

export class InvalidEvidenceError extends PayoutError {
  constructor(message = 'Uploaded analytics evidence is invalid or does not meet platform requirements.') {
    super(message, 'INVALID_EVIDENCE', 400);
    this.name = 'InvalidEvidenceError';
  }
}
