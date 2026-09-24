import { AppError } from '../../utils/errors.js';

export class CampaignNotFoundError extends AppError {
  constructor(identifier) {
    super(`Campaign not found: ${identifier}`, 'CAMPAIGN_NOT_FOUND', 404, { identifier });
  }
}

export class CampaignNotActiveError extends AppError {
  constructor(campaignId, status) {
    super(
      `Campaign ${campaignId} is not active (current status: ${status})`,
      'CAMPAIGN_NOT_ACTIVE',
      400,
      { campaignId, status }
    );
  }
}

export class CampaignWindowError extends AppError {
  constructor(campaignId, message, details = {}) {
    super(message, 'CAMPAIGN_WINDOW_ERROR', 400, { campaignId, ...details });
  }
}

export class CampaignBudgetExhaustedError extends AppError {
  constructor(campaignId) {
    super(
      `Campaign ${campaignId} has reached its total budget and is no longer accepting new earnings or joins.`,
      'CAMPAIGN_BUDGET_EXHAUSTED',
      400,
      { campaignId }
    );
  }
}

export class InvalidStatusTransitionError extends AppError {
  constructor(currentStatus, targetStatus) {
    super(
      `Invalid campaign status transition from ${currentStatus} to ${targetStatus}`,
      'INVALID_STATUS_TRANSITION',
      400,
      { currentStatus, targetStatus }
    );
  }
}

export class MembershipError extends AppError {
  constructor(message, details = {}) {
    super(message, 'MEMBERSHIP_ERROR', 400, details);
  }
}

export class CampaignNotJoinableError extends AppError {
  constructor(campaignId, reason, details = {}) {
    super(
      `Campaign ${campaignId} cannot be joined: ${reason}`,
      'CAMPAIGN_NOT_JOINABLE',
      400,
      { campaignId, reason, ...details }
    );
  }
}
