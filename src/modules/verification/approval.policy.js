/**
 * Approval Decision Service / Policy
 *
 * ARCHITECTURAL PRINCIPLE:
 * RISK LEVEL != SUBMISSION APPROVAL
 *
 * Verification determines evidence, anomalies, and risk tier (LOW_RISK, REVIEW_REQUIRED, HIGH_RISK).
 * The Approval Decision layer evaluates business eligibility and transitions the final Submission status.
 */
export class ApprovalPolicy {
  /**
   * Determine submission status transition based on verification assessment and business rules
   * @param {object} params
   * @param {'LOW_RISK'|'REVIEW_REQUIRED'|'HIGH_RISK'} params.riskLevel
   * @param {Array<string>} [params.primaryReasons]
   * @param {object} [params.submission]
   * @param {object} [params.options]
   * @returns {{ status: 'APPROVED'|'UNDER_REVIEW'|'FLAGGED'|'REJECTED', reason: string|null }}
   */
  evaluateApprovalDecision({ riskLevel, primaryReasons = [], submission = null, options = {} }) {
    switch (riskLevel) {
      case 'LOW_RISK':
        // Policy: LOW_RISK verifies clean engagement metrics and qualifies for automated approval
        return {
          status: 'APPROVED',
          reason: null
        };

      case 'REVIEW_REQUIRED':
        // Policy: Anomalies or unverified metrics require human staff review before any payout
        return {
          status: 'UNDER_REVIEW',
          reason: primaryReasons.length > 0 ? primaryReasons.join('; ') : 'Flagged for human review'
        };

      case 'HIGH_RISK':
        // Policy: Substantial anomalies; flagged for priority investigation. Does NOT auto-reject as fraud.
        return {
          status: 'FLAGGED',
          reason: primaryReasons.length > 0 ? primaryReasons.join('; ') : 'High anomaly score requires investigation'
        };

      default:
        return {
          status: 'UNDER_REVIEW',
          reason: 'Unknown risk classification; placed under review by default'
        };
    }
  }
}

export const defaultApprovalPolicy = new ApprovalPolicy();
export default defaultApprovalPolicy;
