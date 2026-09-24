import { prisma } from '../../database/client.js';
import { Prisma } from '@prisma/client';

export class AdjustmentRepository {
  constructor(dbClient = prisma) {
    this.prisma = dbClient;
  }

  /**
   * Create an auditable financial adjustment
   * @param {object} data
   * @param {object} [tx=null]
   * @returns {Promise<object>}
   */
  async createAdjustment(data, tx = null) {
    const client = tx || this.prisma;
    return client.financialAdjustment.create({
      data: {
        userId: data.userId,
        campaignId: data.campaignId,
        submissionId: data.submissionId,
        earningId: data.earningId || null,
        type: data.type || 'RETENTION_VIOLATION',
        amount: new Prisma.Decimal(data.amount),
        currency: data.currency || 'USD',
        reason: data.reason,
        source: data.source || 'SYSTEM_RETENTION_WORKER',
        metadata: data.metadata || null
      }
    });
  }

  /**
   * Find adjustment by earning ID and type (idempotency check)
   * @param {string} earningId
   * @param {string} type
   * @param {object} [tx=null]
   * @returns {Promise<object|null>}
   */
  async getAdjustmentByEarningAndType(earningId, type = 'RETENTION_VIOLATION', tx = null) {
    const client = tx || this.prisma;
    return client.financialAdjustment.findUnique({
      where: {
        earningId_type: {
          earningId,
          type
        }
      }
    });
  }

  /**
   * Get all adjustments for a specific submission
   * @param {string} submissionId
   * @param {object} [tx=null]
   * @returns {Promise<Array<object>>}
   */
  async getAdjustmentsBySubmissionId(submissionId, tx = null) {
    const client = tx || this.prisma;
    return client.financialAdjustment.findMany({
      where: { submissionId },
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
   * Get all adjustments for a creator
   * @param {string} userId
   * @param {string} [currency='USD']
   * @param {object} [tx=null]
   * @returns {Promise<Array<object>>}
   */
  async getAdjustmentsByUserId(userId, currency = 'USD', tx = null) {
    const client = tx || this.prisma;
    return client.financialAdjustment.findMany({
      where: { userId, currency },
      include: {
        campaign: { select: { name: true, slug: true } },
        submission: { select: { platform: true, url: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
   * Aggregate total adjustment amount for a creator
   * @param {string} userId
   * @param {string} [currency='USD']
   * @param {object} [tx=null]
   * @returns {Promise<Prisma.Decimal>}
   */
  async getNetAdjustmentAmount(userId, currency = 'USD', tx = null) {
    const client = tx || this.prisma;
    const agg = await client.financialAdjustment.aggregate({
      where: { userId, currency },
      _sum: { amount: true }
    });

    return agg._sum.amount ? new Prisma.Decimal(agg._sum.amount) : new Prisma.Decimal('0.00');
  }
}

export const adjustmentRepository = new AdjustmentRepository();
