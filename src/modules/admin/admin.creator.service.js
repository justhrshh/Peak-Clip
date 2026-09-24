import { prisma } from '../../database/client.js';
import { adminAuditService as defaultAuditService } from './audit.service.js';
import { UserNotFoundError } from '../users/user.errors.js';
import { InvalidAdminActionError } from './admin.errors.js';
import { logger } from '../../utils/logger.js';

export class AdminCreatorService {
  constructor(dbClient = prisma, auditService = defaultAuditService) {
    this.db = dbClient;
    this.auditService = auditService;
  }

  /**
   * Search creators by Discord ID or username
   *
   * @param {string} query
   * @param {object} [options={}]
   * @param {number} [options.limit=10]
   * @returns {Promise<Array<object>>}
   */
  async searchCreators(query, { limit = 10 } = {}) {
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return [];
    }

    const trimmed = query.trim();

    return this.db.user.findMany({
      where: {
        OR: [
          { discordId: trimmed },
          { username: { contains: trimmed, mode: 'insensitive' } },
          { displayName: { contains: trimmed, mode: 'insensitive' } }
        ]
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        discordId: true,
        username: true,
        displayName: true,
        status: true,
        createdAt: true,
        lastSeenAt: true
      }
    });
  }

  /**
   * Get operational details for a creator
   *
   * @param {string} userIdentifier - internal UUID or Discord ID
   * @returns {Promise<object>}
   */
  async getCreatorDetails(userIdentifier) {
    const user = await this.db.user.findFirst({
      where: {
        OR: [
          { id: userIdentifier },
          { discordId: userIdentifier }
        ]
      },
      include: {
        campaignMemberships: {
          include: {
            campaign: {
              select: {
                id: true,
                name: true,
                slug: true,
                status: true
              }
            }
          },
          orderBy: { joinedAt: 'desc' }
        },
        _count: {
          select: {
            submissions: true,
            payoutRequests: true
          }
        }
      }
    });

    if (!user) {
      throw new UserNotFoundError(userIdentifier);
    }

    // Aggregate submissions by status
    const submissionBreakdown = await this.db.submission.groupBy({
      by: ['status'],
      where: { userId: user.id },
      _count: { id: true }
    });

    const statusCounts = {
      APPROVED: 0,
      UNDER_REVIEW: 0,
      FLAGGED: 0,
      REJECTED: 0,
      PENDING_VERIFICATION: 0
    };

    for (const group of submissionBreakdown) {
      statusCounts[group.status] = group._count.id;
    }

    return {
      id: user.id,
      discordId: user.discordId,
      username: user.username,
      displayName: user.displayName,
      status: user.status,
      createdAt: user.createdAt,
      lastSeenAt: user.lastSeenAt,
      memberships: user.campaignMemberships,
      totalSubmissions: user._count.submissions,
      submissionStatusBreakdown: statusCounts,
      totalPayoutRequests: user._count.payoutRequests
    };
  }

  /**
   * Update creator status (ACTIVE, SUSPENDED, BANNED)
   *
   * Invariant:
   * Suspended/banned users are immediately prohibited from submitting clips,
   * joining campaigns, or requesting payouts. Existing historical records
   * remain completely intact.
   *
   * @param {string} userIdentifier - internal UUID or Discord snowflake
   * @param {'ACTIVE'|'SUSPENDED'|'BANNED'} targetStatus
   * @param {object} actor - { discordId, userId }
   * @param {string|null} [reason]
   * @returns {Promise<object>}
   */
  async updateCreatorStatus(userIdentifier, targetStatus, actor, reason = null) {
    if (!['ACTIVE', 'SUSPENDED', 'BANNED'].includes(targetStatus)) {
      throw new InvalidAdminActionError(`Invalid creator status: ${targetStatus}. Must be ACTIVE, SUSPENDED, or BANNED.`);
    }

    const user = await this.db.user.findFirst({
      where: {
        OR: [
          { id: userIdentifier },
          { discordId: userIdentifier }
        ]
      }
    });

    if (!user) {
      throw new UserNotFoundError(userIdentifier);
    }

    const previousStatus = user.status;
    const updated = await this.db.user.update({
      where: { id: user.id },
      data: { status: targetStatus }
    });

    await this.auditService.logAction({
      actorUserId: actor?.userId || null,
      actorDiscordId: actor.discordId,
      action: `CREATOR_${targetStatus}`,
      entityType: 'CREATOR',
      entityId: user.id,
      previousState: { status: previousStatus },
      newState: { status: targetStatus },
      reason
    });

    logger.info({ userId: user.id, discordId: user.discordId, from: previousStatus, to: targetStatus, actorDiscordId: actor.discordId }, 'Creator status updated by admin');
    return updated;
  }
}

export const adminCreatorService = new AdminCreatorService();
export default adminCreatorService;
