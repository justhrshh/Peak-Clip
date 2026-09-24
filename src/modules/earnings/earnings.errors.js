import { AppError } from '../../utils/errors.js';

export class EarningsError extends AppError {
  /**
   * @param {string} message
   * @param {string} [code='EARNINGS_ERROR']
   * @param {number} [statusCode=500]
   * @param {Record<string, any>} [details={}]
   */
  constructor(message, code = 'EARNINGS_ERROR', statusCode = 500, details = {}) {
    super(message, code, statusCode, details);
  }
}

export class IneligibleSubmissionError extends EarningsError {
  /**
   * @param {string} submissionId
   * @param {string} reason
   * @param {Record<string, any>} [details={}]
   */
  constructor(submissionId, reason, details = {}) {
    super(
      `Submission ${submissionId} is ineligible for earnings: ${reason}`,
      'INELIGIBLE_SUBMISSION',
      422,
      { submissionId, reason, ...details }
    );
  }
}

export class DuplicateEarningError extends EarningsError {
  /**
   * @param {string} sourceSnapshotId
   * @param {Record<string, any>} [details={}]
   */
  constructor(sourceSnapshotId, details = {}) {
    super(
      `Earning already credited for metric snapshot: ${sourceSnapshotId}`,
      'DUPLICATE_EARNING',
      409,
      { sourceSnapshotId, ...details }
    );
  }
}

export class UnauthorizedEarningAccessError extends EarningsError {
  /**
   * @param {string} message
   * @param {Record<string, any>} [details={}]
   */
  constructor(message = 'You do not have permission to access these earnings records.', details = {}) {
    super(message, 'UNAUTHORIZED_EARNING_ACCESS', 403, details);
  }
}
