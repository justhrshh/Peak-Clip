/**
 * Phase 10E: Payout Evidence Constants, Requirements & Creator Instructions
 */

export const STRUCTURED_EVIDENCE_REJECTION_REASONS = Object.freeze({
  TELEMETRY_MISMATCH: 'TELEMETRY_MISMATCH',
  DURATION_EXCEEDED: 'DURATION_EXCEEDED',
  CORRUPTED_FILE: 'CORRUPTED_FILE',
  INSUFFICIENT_TELEMETRY: 'INSUFFICIENT_TELEMETRY',
  SUSPICIOUS_EDITING: 'SUSPICIOUS_EDITING',
  WRONG_ACCOUNT: 'WRONG_ACCOUNT',
  OVER_DURATION: 'OVER_DURATION',
  INVALID_FILE: 'INVALID_FILE',
  INCOMPLETE_ANALYTICS: 'INCOMPLETE_ANALYTICS',
  PROFILE_NOT_VISIBLE: 'PROFILE_NOT_VISIBLE',
  ANALYTICS_NOT_VISIBLE: 'ANALYTICS_NOT_VISIBLE',
  EDITED_OR_MANIPULATED: 'EDITED_OR_MANIPULATED',
  PLATFORM_MISMATCH: 'PLATFORM_MISMATCH',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
  OTHER: 'OTHER'
});

export const CREATOR_SAFE_EVIDENCE_LABELS = Object.freeze({
  TELEMETRY_MISMATCH: 'Analytics Telemetry Mismatch With Submission',
  DURATION_EXCEEDED: 'Screen Recording Exceeds 40 Seconds Limit',
  CORRUPTED_FILE: 'Corrupted, Empty, or Unreadable Video File',
  INSUFFICIENT_TELEMETRY: 'Insufficient Telemetry Elements Displayed in Recording',
  SUSPICIOUS_EDITING: 'Visible Editing, Splicing, or Tampering Detected',
  WRONG_ACCOUNT: 'Account or Channel Name Does Not Match Payout Destination',
  OVER_DURATION: 'Recording Exceeds 40 Seconds Limit',
  INVALID_FILE: 'Invalid Video File Format or Corrupted Media',
  INCOMPLETE_ANALYTICS: 'Incomplete Analytics Telemetry Displayed',
  PROFILE_NOT_VISIBLE: 'Channel Name / Profile Handle Not Clearly Visible',
  ANALYTICS_NOT_VISIBLE: 'Analytics Metrics Not Clearly Visible or Obscured',
  EDITED_OR_MANIPULATED: 'Recording Contains Visible Splices, Edits, or Lags',
  PLATFORM_MISMATCH: 'Analytics Dashboard Does Not Match Claimed Video Platform',
  INSUFFICIENT_EVIDENCE: 'Insufficient Analytics Verification Evidence',
  OTHER: 'Operational Review Decision'
});

export const EVIDENCE_STATUS = Object.freeze({
  UPLOADED: 'UPLOADED',
  PENDING_REVIEW: 'PENDING_REVIEW',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED'
});

export const CREATOR_SCREEN_RECORDING_INSTRUCTIONS = Object.freeze({
  TITLE: '🎬 Screen Recording Instructions',
  BODY:
    'Start the screen recording from this chat, then:\n\n' +
    '📈 **Open your Analytics Dashboard**\n' +
    '🏷️ **Show your name/profile**\n' +
    '👁️ **Show how many people watched your videos**\n' +
    '📅 **Show the age breakdown of your audience**\n' +
    '🌎 **Show the countries your audience is from**\n' +
    '⚧️ **Show the gender breakdown of your audience**\n\n' +
    '⏳ Please keep the entire recording under 40 seconds so it’s quick and easy to upload.\n' +
    '✨ Make sure all the analytics are clearly visible in the recording.\n\n' +
    '*Make sure there are no obvious lags or edits in the video. If evidence is found to be intentionally fabricated, the account may be subject to moderation according to existing platform rules.*'
});

export const PLATFORM_EVIDENCE_REQUIREMENTS = Object.freeze({
  YOUTUBE: Object.freeze({
    supported: true,
    platform: 'YOUTUBE',
    title: 'YouTube Studio Analytics',
    requiredTelemetry: ['profile_name', 'views', 'audience_age', 'audience_countries', 'gender'],
    maxDurationSeconds: 40
  }),
  TIKTOK: Object.freeze({
    supported: false,
    platform: 'TIKTOK',
    status: 'CAPABILITY_BOUNDARY',
    message: 'TikTok provider capability boundary: video analytics evidence workflow is currently unconfigured.',
    maxDurationSeconds: 40
  }),
  INSTAGRAM: Object.freeze({
    supported: false,
    platform: 'INSTAGRAM',
    status: 'CAPABILITY_BOUNDARY',
    message: 'Instagram provider capability boundary: video analytics evidence workflow is currently unconfigured.',
    maxDurationSeconds: 40
  }),
  FACEBOOK: Object.freeze({
    supported: false,
    platform: 'FACEBOOK',
    status: 'CAPABILITY_BOUNDARY',
    message: 'Facebook provider capability boundary: video analytics evidence workflow is currently unconfigured.',
    maxDurationSeconds: 40
  })
});

/**
 * Validate that a reason is a valid structured evidence rejection reason
 * @param {string} reason
 * @returns {boolean}
 */
export function isValidEvidenceRejectionReason(reason) {
  return Object.values(STRUCTURED_EVIDENCE_REJECTION_REASONS).includes(reason);
}

/**
 * Get human-readable safe label for creator display
 * @param {string} reason
 * @returns {string}
 */
export function getCreatorSafeEvidenceLabel(reason) {
  return CREATOR_SAFE_EVIDENCE_LABELS[reason] || reason || 'Operational Review Decision';
}
