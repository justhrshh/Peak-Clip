import { prisma } from '../../database/client.js';

export class ModerationRepository {
  constructor(dbClient = prisma) {
    this.prisma = dbClient;
  }

  /**
   * Append an immutable moderation history record
   * @param {object} data
   * @param {object} [tx=null]
   * @returns {Promise<object>}
   */
  async createHistoryEntry(data, tx = null) {
    const client = tx || this.prisma;
    return client.submissionModerationHistory.create({
      data: {
        submissionId: data.submissionId,
        action: data.action,
        previousStatus: data.previousStatus,
        newStatus: data.newStatus,
        actorUserId: data.actorUserId || null,
        actorDiscordId: data.actorDiscordId || 'SYSTEM',
        actorType: data.actorType || 'SYSTEM',
        reason: data.reason || null,
        notes: data.notes || null,
        verificationId: data.verificationId || null,
        evidence: data.evidence || null
      }
    });
  }

  /**
   * Fetch all moderation history entries for a submission in chronological order
   * @param {string} submissionId
   * @param {object} [tx=null]
   * @returns {Promise<Array<object>>}
   */
  async getHistoryBySubmissionId(submissionId, tx = null) {
    const client = tx || this.prisma;
    return client.submissionModerationHistory.findMany({
      where: { submissionId },
      orderBy: { createdAt: 'asc' }
    });
  }
}

export const moderationRepository = new ModerationRepository();
