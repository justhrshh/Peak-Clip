import { adminAuditRepository as defaultRepo } from './audit.repository.js';
import { logger } from '../../utils/logger.js';

export class AdminAuditService {
  constructor(repo = defaultRepo) {
    this.repo = repo;
  }

  /**
   * Record an immutable administrative action
   *
   * @param {object} params
   * @param {string|null} [params.actorUserId]
   * @param {string} params.actorDiscordId
   * @param {string} params.action
   * @param {'CAMPAIGN'|'CREATOR'|'SUBMISSION'|'PAYOUT'|'MEMBERSHIP'} params.entityType
   * @param {string} params.entityId
   * @param {object|null} [params.previousState]
   * @param {object|null} [params.newState]
   * @param {string|null} [params.reason]
   * @param {object|null} [params.metadata]
   * @param {object} [tx] - Optional transaction client
   * @returns {Promise<object>}
   */
  async logAction(params, tx = null) {
    logger.info(
      {
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        actorDiscordId: params.actorDiscordId
      },
      'Recording admin audit event'
    );

    return this.repo.recordEvent(params, tx);
  }

  /**
   * Query the append-only audit trail
   *
   * @param {object} [filter={}]
   * @returns {Promise<{ items: Array<object>, total: number, page: number, totalPages: number }>}
   */
  async getAuditTrail(filter = {}) {
    return this.repo.listEvents(filter);
  }
}

export const adminAuditService = new AdminAuditService();
export default adminAuditService;
