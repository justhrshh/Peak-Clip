import { payoutService as defaultPayoutService } from '../payouts/payout.service.js';
import { evidenceService as defaultEvidenceService } from '../evidence/evidence.service.js';
import { adminAuditService as defaultAuditService } from './audit.service.js';
import { logger } from '../../utils/logger.js';

export class AdminPayoutService {
  constructor(
    payoutService = defaultPayoutService,
    auditService = defaultAuditService,
    evidenceService = defaultEvidenceService
  ) {
    this.payoutService = payoutService;
    this.auditService = auditService;
    this.evidenceService = evidenceService;
  }

  /**
   * List payout requests for staff review
   *
   * @param {object} [filter={}]
   * @returns {Promise<Array<object>>}
   */
  async listPayoutRequests(filter = {}) {
    return this.payoutService.listPayoutRequests(filter);
  }

  /**
   * Get single payout request details
   *
   * @param {string} payoutRequestId
   * @returns {Promise<object>}
   */
  async getPayoutDetails(payoutRequestId) {
    return this.payoutService.repo.getPayoutRequestById(payoutRequestId);
  }

  /**
   * Put payout under staff review
   *
   * @param {string} payoutRequestId
   * @param {object} actor - { discordId, userId }
   * @param {string} [notes]
   * @returns {Promise<object>}
   */
  async reviewPayout(payoutRequestId, actor, notes = null) {
    const updated = await this.payoutService.reviewPayoutRequest(payoutRequestId, actor.discordId, notes);

    await this.auditService.logAction({
      actorUserId: actor?.userId || null,
      actorDiscordId: actor.discordId,
      action: 'PAYOUT_REVIEW',
      entityType: 'PAYOUT',
      entityId: payoutRequestId,
      newState: { status: updated.status },
      reason: notes
    });

    return updated;
  }

  /**
   * Approve payout request
   * Restricted strictly to ADMIN role.
   *
   * @param {string} payoutRequestId
   * @param {object} actor - { discordId, userId }
   * @returns {Promise<object>}
   */
  async approvePayout(payoutRequestId, actor) {
    const existing = await this.payoutService.repo.getPayoutRequestById(payoutRequestId);
    if (existing && existing.status === 'REQUESTED') {
      await this.payoutService.reviewPayoutRequest(payoutRequestId, actor.discordId, 'Staff review initiated approval');
    }
    const updated = await this.payoutService.approvePayoutRequest(payoutRequestId, actor.discordId);

    await this.auditService.logAction({
      actorUserId: actor?.userId || null,
      actorDiscordId: actor.discordId,
      action: 'PAYOUT_APPROVE',
      entityType: 'PAYOUT',
      entityId: payoutRequestId,
      newState: { status: updated.status }
    });

    logger.info({ payoutRequestId, actorDiscordId: actor.discordId }, 'Payout request approved by admin');
    return updated;
  }

  /**
   * Reject payout request (releases reserved funds back to creator balance)
   * Restricted strictly to ADMIN role.
   *
   * @param {string} payoutRequestId
   * @param {object} actor - { discordId, userId }
   * @param {string} rejectionReason
   * @returns {Promise<object>}
   */
  async rejectPayout(payoutRequestId, actor, rejectionReason) {
    const updated = await this.payoutService.rejectPayoutRequest(payoutRequestId, actor.discordId, rejectionReason);

    await this.auditService.logAction({
      actorUserId: actor?.userId || null,
      actorDiscordId: actor.discordId,
      action: 'PAYOUT_REJECT',
      entityType: 'PAYOUT',
      entityId: payoutRequestId,
      newState: { status: updated.status, rejectionReason },
      reason: rejectionReason
    });

    logger.info({ payoutRequestId, actorDiscordId: actor.discordId, rejectionReason }, 'Payout request rejected by admin');
    return updated;
  }

  /**
   * Process manual disbursement through pluggable disbursement provider
   * Restricted strictly to ADMIN role.
   *
   * Utilizes transactional advisory lock to prevent duplicate concurrent executions.
   *
   * @param {string} payoutRequestId
   * @param {object} actor - { discordId, userId }
   * @param {string} [providerName='MANUAL']
   * @returns {Promise<object>}
   */
  async processDisbursement(payoutRequestId, actor, providerName = 'MANUAL') {
    const result = await this.payoutService.processDisbursement(payoutRequestId, providerName);

    await this.auditService.logAction({
      actorUserId: actor?.userId || null,
      actorDiscordId: actor.discordId,
      action: 'PAYOUT_PROCESS',
      entityType: 'PAYOUT',
      entityId: payoutRequestId,
      newState: {
        status: result.payoutRequest.status,
        disbursementId: result.disbursement.id,
        providerReference: result.disbursement.providerReference
      }
    });

    logger.info({ payoutRequestId, actorDiscordId: actor.discordId }, 'Disbursement initiated by admin');
    return result;
  }

  /**
   * Mark disbursement as completed
   * Permanently consumes balance.
   *
   * @param {string} payoutRequestId
   * @param {object} actor
   * @param {string} [providerReference]
   * @returns {Promise<object>}
   */
  async completeDisbursement(payoutRequestId, actor, providerReference = null) {
    const updated = await this.payoutService.markDisbursementCompleted(payoutRequestId, providerReference);

    await this.auditService.logAction({
      actorUserId: actor?.userId || null,
      actorDiscordId: actor.discordId,
      action: 'PAYOUT_COMPLETE',
      entityType: 'PAYOUT',
      entityId: payoutRequestId,
      newState: { status: updated.status, providerReference }
    });

    logger.info({ payoutRequestId, actorDiscordId: actor.discordId }, 'Disbursement marked completed by admin');
    return updated;
  }

  /**
   * Mark disbursement as failed
   * Releases balance or permits retry.
   *
   * @param {string} payoutRequestId
   * @param {object} actor
   * @param {string} [failureReason]
   * @returns {Promise<object>}
   */
  async failDisbursement(payoutRequestId, actor, failureReason = null) {
    const updated = await this.payoutService.markDisbursementFailed(payoutRequestId, failureReason);

    await this.auditService.logAction({
      actorUserId: actor?.userId || null,
      actorDiscordId: actor.discordId,
      action: 'PAYOUT_FAIL',
      entityType: 'PAYOUT',
      entityId: payoutRequestId,
      newState: { status: updated.status, failureReason },
      reason: failureReason
    });

    logger.info({ payoutRequestId, actorDiscordId: actor.discordId, failureReason }, 'Disbursement marked failed by admin');
    return updated;
  }

  /**
   * Retry a failed payout request
   *
   * @param {string} payoutRequestId
   * @param {object} actor
   * @param {string} [providerName='MANUAL']
   * @returns {Promise<object>}
   */
  async retryPayout(payoutRequestId, actor, providerName = 'MANUAL') {
    const result = await this.payoutService.retryPayoutRequest(payoutRequestId, providerName);

    await this.auditService.logAction({
      actorUserId: actor?.userId || null,
      actorDiscordId: actor.discordId,
      action: 'PAYOUT_RETRY',
      entityType: 'PAYOUT',
      entityId: payoutRequestId,
      newState: { status: result.payoutRequest.status }
    });

    logger.info({ payoutRequestId, actorDiscordId: actor.discordId }, 'Payout retried by admin');
    return result;
  }

  /**
   * Accept payout evidence
   *
   * @param {string} evidenceId
   * @param {object} actor - { discordId, userId }
   * @returns {Promise<object>}
   */
  async acceptEvidence(evidenceId, actor) {
    const updated = await this.evidenceService.acceptEvidence(evidenceId, actor.discordId);

    await this.auditService.logAction({
      actorUserId: actor?.userId || null,
      actorDiscordId: actor.discordId,
      action: 'PAYOUT_EVIDENCE_ACCEPT',
      entityType: 'PAYOUT_EVIDENCE',
      entityId: evidenceId,
      newState: { status: updated.status }
    });

    logger.info({ evidenceId, actorDiscordId: actor.discordId }, 'Payout evidence accepted by admin');
    return updated;
  }

  /**
   * Reject payout evidence
   *
   * @param {string} evidenceId
   * @param {object} actor - { discordId, userId }
   * @param {object} [options={}] - { structuredReason, notes }
   * @returns {Promise<object>}
   */
  async rejectEvidence(evidenceId, actor, options = {}, maybeNotes = null) {
    const opts = typeof options === 'string'
      ? { structuredReason: options, notes: maybeNotes }
      : (options || {});
    const updated = await this.evidenceService.rejectEvidence(evidenceId, actor.discordId, opts);

    await this.auditService.logAction({
      actorUserId: actor?.userId || null,
      actorDiscordId: actor.discordId,
      action: 'PAYOUT_EVIDENCE_REJECT',
      entityType: 'PAYOUT_EVIDENCE',
      entityId: evidenceId,
      newState: { status: updated.status, rejectionReason: updated.rejectionReason },
      reason: updated.rejectionReason
    });

    logger.info({ evidenceId, actorDiscordId: actor.discordId, rejectionReason: updated.rejectionReason }, 'Payout evidence rejected by admin');
    return updated;
  }
}

export const adminPayoutService = new AdminPayoutService();
export default adminPayoutService;
