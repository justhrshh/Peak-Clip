import { AppError } from '../../utils/errors.js';

export class UnauthorizedAdminActionError extends AppError {
  constructor(message = 'You are not authorized to perform this administrative action.') {
    super(message, 403);
    this.name = 'UnauthorizedAdminActionError';
  }
}

export class InsufficientPermissionError extends AppError {
  constructor(requiredPermission, userRoles = []) {
    super(
      `Insufficient administrative permissions. Required: ${requiredPermission}. Current roles: [${userRoles.join(', ')}]`,
      403
    );
    this.name = 'InsufficientPermissionError';
    this.requiredPermission = requiredPermission;
    this.userRoles = userRoles;
  }
}

export class InvalidCampaignConfigurationError extends AppError {
  constructor(message, details = null) {
    super(message, 400);
    this.name = 'InvalidCampaignConfigurationError';
    this.details = details;
  }
}

export class MissingRejectionReasonError extends AppError {
  constructor(message = 'A clear, non-empty rejection reason is required.') {
    super(message, 400);
    this.name = 'MissingRejectionReasonError';
  }
}

export class CurrencyModificationForbiddenError extends AppError {
  constructor(campaignId, currentCurrency, requestedCurrency) {
    super(
      `Cannot modify currency for campaign '${campaignId}' from ${currentCurrency} to ${requestedCurrency}: campaign has existing submissions or earnings. Altering currency corrupts accounting history.`,
      400
    );
    this.name = 'CurrencyModificationForbiddenError';
    this.campaignId = campaignId;
    this.currentCurrency = currentCurrency;
    this.requestedCurrency = requestedCurrency;
  }
}

export class AlreadyReviewedError extends AppError {
  constructor(entityType, entityId, currentStatus) {
    super(
      `${entityType} '${entityId}' has already been reviewed and is currently '${currentStatus}'.`,
      409
    );
    this.name = 'AlreadyReviewedError';
    this.entityType = entityType;
    this.entityId = entityId;
    this.currentStatus = currentStatus;
  }
}

export class InvalidAdminActionError extends AppError {
  constructor(message, details = null) {
    super(message, 400);
    this.name = 'InvalidAdminActionError';
    this.details = details;
  }
}
