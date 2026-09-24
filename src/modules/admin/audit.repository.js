import { prisma } from '../../database/client.js';

export class AdminAuditRepository {
  constructor(dbClient = prisma) {
    this.db = dbClient;
  }

  /**
   * Append an immutable administrative audit event
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
   * @param {object} [tx] - Optional transactional client
   * @returns {Promise<object>}
   */
  async recordEvent(params, tx = null) {
    const client = tx || this.db;

    return client.adminAuditEvent.create({
      data: {
        actorUserId: params.actorUserId || null,
        actorDiscordId: String(params.actorDiscordId),
        action: params.action,
        entityType: params.entityType,
        entityId: String(params.entityId),
        previousState: params.previousState ?? undefined,
        newState: params.newState ?? undefined,
        reason: params.reason || null,
        metadata: params.metadata ?? undefined
      }
    });
  }

  /**
   * List paginated audit events with optional filters
   *
   * @param {object} [options={}]
   * @param {string} [options.entityType]
   * @param {string} [options.entityId]
   * @param {string} [options.actorDiscordId]
   * @param {string} [options.action]
   * @param {number} [options.page=1]
   * @param {number} [options.limit=20]
   * @returns {Promise<{ items: Array<object>, total: number, page: number, totalPages: number }>}
   */
  async listEvents({
    entityType,
    entityId,
    actorDiscordId,
    action,
    page = 1,
    limit = 20
  } = {}) {
    const skip = (Math.max(1, page) - 1) * limit;

    const where = {};
    if (entityType) where.entityType = entityType;
    if (entityId) where.entityId = String(entityId);
    if (actorDiscordId) where.actorDiscordId = String(actorDiscordId);
    if (action) where.action = action;

    const [total, items] = await Promise.all([
      this.db.adminAuditEvent.count({ where }),
      this.db.adminAuditEvent.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' }
      })
    ]);

    return {
      items,
      total,
      page: Math.max(1, page),
      totalPages: Math.ceil(total / limit) || 1
    };
  }

  // NOTE: Deliberately NO update or delete methods exist here.
  // Administrative audit records are strictly immutable and append-only.
}

export const adminAuditRepository = new AdminAuditRepository();
export default adminAuditRepository;
