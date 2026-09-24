import { InvalidPayoutStatusTransitionError } from './payout.errors.js';

/**
 * Payout Request State Machine
 *
 * Centralized lifecycle transition rules:
 *
 * REQUESTED     -> UNDER_REVIEW, CANCELLED, REJECTED
 * UNDER_REVIEW  -> APPROVED, REJECTED, CANCELLED
 * APPROVED      -> PROCESSING, CANCELLED
 * PROCESSING    -> COMPLETED, FAILED
 * FAILED        -> PROCESSING (retry attempt)
 *
 * Terminal states:
 * COMPLETED (permanent consumption of funds)
 * REJECTED  (funds reservation released)
 * CANCELLED (funds reservation released)
 */
export const ALLOWED_PAYOUT_TRANSITIONS = Object.freeze({
  REQUESTED: Object.freeze(['UNDER_REVIEW', 'CANCELLED', 'REJECTED']),
  UNDER_REVIEW: Object.freeze(['APPROVED', 'REJECTED', 'CANCELLED']),
  APPROVED: Object.freeze(['PROCESSING', 'CANCELLED']),
  PROCESSING: Object.freeze(['COMPLETED', 'FAILED']),
  FAILED: Object.freeze(['PROCESSING']),
  COMPLETED: Object.freeze([]),
  REJECTED: Object.freeze([]),
  CANCELLED: Object.freeze([])
});

/**
 * Statuses that actively hold and reserve available balance
 */
export const RESERVING_PAYOUT_STATUSES = Object.freeze([
  'REQUESTED',
  'UNDER_REVIEW',
  'APPROVED',
  'PROCESSING'
]);

/**
 * Validate status transition
 * @param {string} fromStatus
 * @param {string} toStatus
 * @throws {InvalidPayoutStatusTransitionError}
 */
export function validatePayoutTransition(fromStatus, toStatus) {
  const allowed = ALLOWED_PAYOUT_TRANSITIONS[fromStatus];
  if (!allowed || !allowed.includes(toStatus)) {
    throw new InvalidPayoutStatusTransitionError(fromStatus, toStatus);
  }
  return true;
}

/**
 * Check if a status reserves balance
 * @param {string} status
 * @returns {boolean}
 */
export function isReservingStatus(status) {
  return RESERVING_PAYOUT_STATUSES.includes(status);
}

/**
 * Check if a status permanently consumes balance
 * @param {string} status
 * @returns {boolean}
 */
export function isCompletedStatus(status) {
  return status === 'COMPLETED';
}
