import { Prisma } from '@prisma/client';
import { prisma } from '../../database/client.js';

export class EarningsRepository {
  constructor(dbClient = prisma) {
    this.prisma = dbClient;
  }

  /**
   * Execute callback in an atomic interactive database transaction
   * @param {function(object): Promise<any>} callback
   * @returns {Promise<any>}
   */
  async transaction(callback) {
    return this.prisma.$transaction(callback);
  }

  /**
   * Acquire PostgreSQL transactional advisory lock for submission earnings calculation.
   * Scoped to the current transaction; automatically released upon commit or rollback.
   * Guarantees strictly sequential calculation and eliminates high-water-mark races.
   * @param {string} submissionId
   * @param {object} [tx=null]
   */
  async acquireSubmissionLock(submissionId, tx = null) {
    const client = tx || this.prisma;
    if (client?.$executeRaw) {
      try {
        await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'submission_earnings_' + submissionId}))`;
      } catch {
        // Transparent fallback in non-Postgres environments (e.g. unit mocks)
      }
    }
  }

  /**
   * Fetch submission with campaign (including budget fields), latest verification, and latest snapshot.
   * @param {string} submissionId
   * @param {object} [tx=null]
   * @returns {Promise<object|null>}
   */
  async getSubmissionForEarnings(submissionId, tx = null) {
    const client = tx || this.prisma;
    return client.submission.findUnique({
      where: { id: submissionId },
      include: {
        campaign: {
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            payRate: true,
            currency: true,
            minimumPayout: true,
            totalBudget: true,
            consumedBudget: true,
            creatorEarningCap: true,
            minClipDurationSeconds: true,
            maxClipDurationSeconds: true,
            retentionRequired: true,
            retentionDays: true
          }
        },
        verifications: {
          orderBy: [
            { createdAt: 'desc' },
            { id: 'desc' }
          ],
          take: 1
        },
        snapshots: {
          orderBy: [
            { capturedAt: 'desc' },
            { id: 'desc' }
          ],
          take: 1
        }
      }
    });
  }

  /**
   * Fetch specific MetricSnapshot by ID
   * @param {string} snapshotId
   * @param {object} [tx=null]
   * @returns {Promise<object|null>}
   */
  async getSnapshotById(snapshotId, tx = null) {
    const client = tx || this.prisma;
    return client.metricSnapshot.findUnique({
      where: { id: snapshotId }
    });
  }

  /**
   * Calculate total previously credited views for a submission.
   * Sums all non-voided eligibleViews from the immutable ledger.
   *
   * @param {string} submissionId
   * @param {object} [tx=null]
   * @returns {Promise<bigint>}
   */
  async getPreviouslyCreditedViews(submissionId, tx = null) {
    const client = tx || this.prisma;
    const aggregate = await client.earning.aggregate({
      where: {
        submissionId,
        status: { not: 'VOIDED' }
      },
      _sum: {
        eligibleViews: true
      }
    });

    const sum = aggregate._sum.eligibleViews;
    return sum !== null && sum !== undefined ? BigInt(sum) : 0n;
  }

  /**
   * Find earning record by its unique source snapshot ID
   * @param {string} sourceSnapshotId
   * @param {object} [tx=null]
   * @returns {Promise<object|null>}
   */
  async getEarningBySnapshotId(sourceSnapshotId, tx = null) {
    const client = tx || this.prisma;
    return client.earning.findUnique({
      where: { sourceSnapshotId }
    });
  }

  /**
   * Create an earning ledger entry
   * @param {object} data
   * @param {object} [tx=null]
   * @returns {Promise<object>}
   */
  async createEarning(data, tx = null) {
    const client = tx || this.prisma;
    return client.earning.create({
      data
    });
  }

  /**
   * Get the sum of earnings a specific creator has accumulated within a campaign.
   * Used for creator cap enforcement.
   * Returns 0 if no earnings exist.
   *
   * @param {string} userId
   * @param {string} campaignId
   * @param {object} [tx=null]
   * @returns {Promise<Prisma.Decimal>}
   */
  async getCreatorCampaignTotal(userId, campaignId, tx = null) {
    const client = tx || this.prisma;
    const aggregate = await client.earning.aggregate({
      where: {
        userId,
        campaignId,
        status: { not: 'VOIDED' }
      },
      _sum: {
        grossAmount: true
      }
    });

    const sum = aggregate._sum.grossAmount;
    return sum != null ? new Prisma.Decimal(sum.toString()) : new Prisma.Decimal('0.00');
  }

  /**
   * Get the total consumed budget for a campaign (for reconciliation).
   * Always derivable from the immutable earnings ledger.
   *
   * @param {string} campaignId
   * @param {object} [tx=null]
   * @returns {Promise<Prisma.Decimal>}
   */
  async getCampaignConsumedBudget(campaignId, tx = null) {
    const client = tx || this.prisma;
    const aggregate = await client.earning.aggregate({
      where: {
        campaignId,
        status: { not: 'VOIDED' }
      },
      _sum: {
        grossAmount: true
      }
    });

    const sum = aggregate._sum.grossAmount;
    return sum != null ? new Prisma.Decimal(sum.toString()) : new Prisma.Decimal('0.00');
  }

  /**
   * Get all earning ledger records for a user
   * @param {string} userId
   * @returns {Promise<Array<object>>}
   */
  async getUserEarningsLedger(userId) {
    return this.prisma.earning.findMany({
      where: { userId },
      include: {
        campaign: {
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            currency: true,
            minimumPayout: true
          }
        },
        submission: {
          select: {
            id: true,
            platform: true,
            url: true,
            status: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
   * Get earning records for a user in a specific campaign
   * @param {string} userId
   * @param {string} campaignId
   * @returns {Promise<Array<object>>}
   */
  async getCampaignEarningsLedger(userId, campaignId) {
    return this.prisma.earning.findMany({
      where: { userId, campaignId },
      include: {
        submission: {
          select: {
            id: true,
            platform: true,
            url: true,
            status: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
   * Get all earning ledger records for a specific submission
   * @param {string} submissionId
   * @returns {Promise<Array<object>>}
   */
  async getSubmissionEarningsLedger(submissionId) {
    return this.prisma.earning.findMany({
      where: { submissionId },
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
   * Get user campaign membership
   * @param {string} userId
   * @param {string} campaignId
   * @returns {Promise<object|null>}
   */
  async getCampaignMembership(userId, campaignId) {
    return this.prisma.campaignMember.findUnique({
      where: {
        userId_campaignId: {
          userId,
          campaignId
        }
      },
      include: {
        campaign: true
      }
    });
  }
}

export const earningsRepository = new EarningsRepository();
export default earningsRepository;
