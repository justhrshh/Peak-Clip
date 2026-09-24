import { AppError } from '../../utils/errors.js';

export class InvalidSubmissionUrlError extends AppError {
  constructor(message, details = {}) {
    super(message, 'INVALID_SUBMISSION_URL', 400, details);
  }
}

export class UnsupportedPlatformError extends AppError {
  constructor(hostname, details = {}) {
    super(`Unsupported platform or domain: ${hostname}`, 'UNSUPPORTED_PLATFORM', 400, { hostname, ...details });
  }
}

export class PlatformNotAllowedError extends AppError {
  constructor(platform, allowedPlatforms = []) {
    const formattedPlatform = platform.charAt(0).toUpperCase() + platform.slice(1).toLowerCase();
    super(
      `${formattedPlatform} submissions aren't allowed for this campaign. Allowed: ${allowedPlatforms.join(', ')}`,
      'PLATFORM_NOT_ALLOWED',
      400,
      { platform, allowedPlatforms }
    );
  }
}

export class ClipDurationOutOfRangeError extends AppError {
  constructor(actualSeconds, minSeconds, maxSeconds) {
    super(
      `This campaign accepts clips between ${minSeconds} and ${maxSeconds} seconds.${actualSeconds != null ? ` Clip duration was ${actualSeconds} seconds.` : ''}`,
      'CLIP_DURATION_OUT_OF_RANGE',
      400,
      { actualSeconds, minSeconds, maxSeconds }
    );
  }
}

export class CampaignBudgetExhaustedSubmissionError extends AppError {
  constructor(campaignId) {
    super(
      'This campaign has reached its budget and is no longer accepting submissions.',
      'CAMPAIGN_BUDGET_EXHAUSTED',
      400,
      { campaignId }
    );
  }
}

export class RetentionPolicyError extends AppError {
  constructor(message, details = {}) {
    super(message, 'RETENTION_POLICY_ERROR', 400, details);
  }
}

export class CampaignNotJoinableError extends AppError {
  constructor(campaignId, reason) {
    super(`Campaign ${campaignId} cannot accept submissions: ${reason}`, 'CAMPAIGN_NOT_JOINABLE', 400, {
      campaignId,
      reason
    });
  }
}

export class NotCampaignMemberError extends AppError {
  constructor(userId, campaignId) {
    super('You must be an active member of this campaign before submitting clips.', 'NOT_CAMPAIGN_MEMBER', 403, {
      userId,
      campaignId
    });
  }
}

export class DuplicateSubmissionError extends AppError {
  constructor(normalizedUrl, details = {}) {
    super(
      'You have already submitted this clip URL to this campaign.',
      'DUPLICATE_SUBMISSION',
      409,
      { normalizedUrl, ...details }
    );
  }
}

export class UserNotEligibleError extends AppError {
  constructor(userId, status) {
    super(`User is not eligible to submit clips (status: ${status})`, 'USER_NOT_ELIGIBLE', 403, {
      userId,
      status
    });
  }
}

export class SubmissionNotFoundError extends AppError {
  constructor(identifier) {
    super(`Submission not found: ${identifier}`, 'SUBMISSION_NOT_FOUND', 404, { identifier });
  }
}

