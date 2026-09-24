import { AppError } from '../../utils/errors.js';

export class StatisticsError extends AppError {
  /**
   * @param {string} message
   * @param {string} [code='STATISTICS_ERROR']
   * @param {number} [statusCode=500]
   * @param {Record<string, any>} [details={}]
   */
  constructor(message, code = 'STATISTICS_ERROR', statusCode = 500, details = {}) {
    super(message, code, statusCode, details);
  }
}

export class UnauthorizedAccessError extends StatisticsError {
  /**
   * @param {string} message
   * @param {Record<string, any>} [details={}]
   */
  constructor(message = 'You do not have permission to view these statistics.', details = {}) {
    super(message, 'UNAUTHORIZED_ACCESS', 403, details);
  }
}

export class CampaignMembershipRequiredError extends StatisticsError {
  /**
   * @param {string} campaignId
   * @param {Record<string, any>} [details={}]
   */
  constructor(campaignId, details = {}) {
    super(
      `You must be a member of this campaign to view its statistics.`,
      'CAMPAIGN_MEMBERSHIP_REQUIRED',
      403,
      { campaignId, ...details }
    );
  }
}

export class SubmissionNotFoundError extends StatisticsError {
  /**
   * @param {string} submissionId
   */
  constructor(submissionId) {
    super(`Submission not found: ${submissionId}`, 'SUBMISSION_NOT_FOUND', 404, { submissionId });
  }
}

export class CampaignNotFoundError extends StatisticsError {
  /**
   * @param {string} campaignId
   */
  constructor(campaignId) {
    super(`Campaign not found: ${campaignId}`, 'CAMPAIGN_NOT_FOUND', 404, { campaignId });
  }
}
