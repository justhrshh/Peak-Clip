/**
 * Phase 10D Structured Rejection Reasons and Creator-Safe Labels
 */
export const STRUCTURED_REJECTION_REASONS = Object.freeze({
  SUSPICIOUS_ENGAGEMENT: 'SUSPICIOUS_ENGAGEMENT',
  INVALID_MANIPULATED_METRICS: 'INVALID_MANIPULATED_METRICS',
  CAMPAIGN_REQUIREMENT_VIOLATION: 'CAMPAIGN_REQUIREMENT_VIOLATION',
  CONTENT_VIOLATION: 'CONTENT_VIOLATION',
  DUPLICATE_REUSED_CONTENT: 'DUPLICATE_REUSED_CONTENT',
  VIDEO_DELETED_UNAVAILABLE: 'VIDEO_DELETED_UNAVAILABLE',
  INSUFFICIENT_ANALYTICS_EVIDENCE: 'INSUFFICIENT_ANALYTICS_EVIDENCE',
  PLATFORM_VIOLATION: 'PLATFORM_VIOLATION',
  RETENTION_REQUIREMENT_VIOLATION: 'RETENTION_REQUIREMENT_VIOLATION',
  OTHER: 'OTHER'
});

export const CREATOR_SAFE_REJECTION_LABELS = Object.freeze({
  SUSPICIOUS_ENGAGEMENT: 'Suspicious Engagement',
  INVALID_MANIPULATED_METRICS: 'Invalid / Manipulated Metrics',
  CAMPAIGN_REQUIREMENT_VIOLATION: 'Campaign Requirement Violation',
  CONTENT_VIOLATION: 'Content Policy Violation',
  DUPLICATE_REUSED_CONTENT: 'Duplicate or Reused Content',
  VIDEO_DELETED_UNAVAILABLE: 'Video Unavailable or Deleted',
  INSUFFICIENT_ANALYTICS_EVIDENCE: 'Insufficient Analytics Evidence',
  PLATFORM_VIOLATION: 'Platform Policy Violation',
  RETENTION_REQUIREMENT_VIOLATION: 'Retention Requirement Violation',
  OTHER: 'Operational Review Decision'
});

export const MODERATION_ACTIONS = Object.freeze({
  AUTO_APPROVED: 'AUTO_APPROVED',
  AUTO_REJECTED: 'AUTO_REJECTED',
  SENT_TO_REVIEW: 'SENT_TO_REVIEW',
  ADMIN_APPROVED: 'ADMIN_APPROVED',
  ADMIN_REJECTED: 'ADMIN_REJECTED',
  POST_APPROVAL_REVIEW_STARTED: 'POST_APPROVAL_REVIEW_STARTED',
  POST_APPROVAL_REJECTED: 'POST_APPROVAL_REJECTED',
  POST_APPROVAL_RESTORED: 'POST_APPROVAL_RESTORED'
});

/**
 * Validate that a reason string is an allowed structured reason
 * @param {string} reason
 * @returns {boolean}
 */
export function isValidStructuredReason(reason) {
  return Object.values(STRUCTURED_REJECTION_REASONS).includes(reason);
}

/**
 * Get creator-safe label for a structured reason
 * @param {string} reason
 * @returns {string}
 */
export function getCreatorSafeReasonLabel(reason) {
  return CREATOR_SAFE_REJECTION_LABELS[reason] || reason || 'Operational Review Decision';
}
