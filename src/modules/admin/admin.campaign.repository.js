import { prisma } from '../../database/client.js';

export class AdminCampaignRepository {
  constructor(dbClient = prisma) {
    this.db = dbClient;
  }

  /**
   * List paginated campaigns with member and submission counts
   *
   * @param {object} [options={}]
   * @param {string} [options.status]
   * @param {string} [options.search]
   * @param {number} [options.page=1]
   * @param {number} [options.limit=10]
   * @returns {Promise<{ items: Array<object>, total: number, page: number, totalPages: number }>}
   */
  async listCampaigns({ status, search, page = 1, limit = 10 } = {}) {
    const skip = (Math.max(1, page) - 1) * limit;

    const where = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
        { clientName: { contains: search, mode: 'insensitive' } }
      ];
    }

    const [total, items] = await Promise.all([
      this.db.campaign.count({ where }),
      this.db.campaign.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: {
              members: true,
              submissions: true
            }
          }
        }
      })
    ]);

    return {
      items,
      total,
      page: Math.max(1, page),
      totalPages: Math.ceil(total / limit) || 1
    };
  }

  /**
   * Get campaign detail with comprehensive aggregates (no N+1)
   *
   * @param {string} campaignId
   * @returns {Promise<object|null>}
   */
  async getCampaignDetails(campaignId) {
    const campaign = await this.db.campaign.findUnique({
      where: { id: campaignId }
    });

    if (!campaign) return null;

    // Concurrently aggregate members, submission status breakdown, earnings sum, and approved views
    const [memberCount, submissionCounts, earningsAggregate, approvedSubs] = await Promise.all([
      this.db.campaignMember.count({
        where: { campaignId, status: 'ACTIVE' }
      }),
      this.db.submission.groupBy({
        by: ['status'],
        where: { campaignId },
        _count: { id: true }
      }),
      this.db.earning.aggregate({
        where: { campaignId, status: 'ELIGIBLE' },
        _sum: {
          grossAmount: true,
          eligibleViews: true
        }
      }),
      this.db.submission?.findMany
        ? this.db.submission.findMany({
            where: { campaignId, status: 'APPROVED' },
            include: {
              snapshots: {
                orderBy: { capturedAt: 'desc' },
                take: 1
              }
            }
          }).catch(() => [])
        : []
    ]);

    const statusCounts = {
      APPROVED: 0,
      UNDER_REVIEW: 0,
      FLAGGED: 0,
      REJECTED: 0,
      PENDING_VERIFICATION: 0
    };

    let totalSubmissions = 0;
    for (const group of submissionCounts) {
      statusCounts[group.status] = group._count.id;
      totalSubmissions += group._count.id;
    }

    let approvedViewsSum = 0n;
    for (const sub of (approvedSubs || [])) {
      const snapViews = sub.snapshots?.[0]?.views;
      const rawViews = snapViews != null ? snapViews : sub.views;
      if (rawViews != null && rawViews !== '') {
        try {
          approvedViewsSum += BigInt(rawViews);
        } catch {
          // ignore parsing error
        }
      }
    }

    const payRateNum = Number(campaign.payRate || 0);
    const viewsBasedConsumed = (Number(approvedViewsSum) / 1000) * payRateNum;
    const recordedConsumed = Number(campaign.consumedBudget || 0);
    const earningsConsumed = Number(earningsAggregate?._sum?.grossAmount || 0);
    const liveConsumed = Math.max(recordedConsumed, earningsConsumed, viewsBasedConsumed);

    return {
      ...campaign,
      consumedBudget: liveConsumed > recordedConsumed ? liveConsumed.toFixed(2) : campaign.consumedBudget,
      metrics: {
        activeMembers: memberCount,
        totalSubmissions,
        statusBreakdown: statusCounts,
        totalEligibleEarnings: earningsAggregate?._sum?.grossAmount || 0,
        totalCreditedViews: earningsAggregate?._sum?.eligibleViews || 0n,
        approvedViews: approvedViewsSum,
        liveConsumedBudget: liveConsumed
      }
    };
  }

  /**
   * List paginated members of a campaign
   *
   * @param {string} campaignId
   * @param {object} [options={}]
   * @param {string} [options.status]
   * @param {number} [options.page=1]
   * @param {number} [options.limit=20]
   * @returns {Promise<{ items: Array<object>, total: number, page: number, totalPages: number }>}
   */
  async listMembers(campaignId, { status, page = 1, limit = 20 } = {}) {
    const skip = (Math.max(1, page) - 1) * limit;

    const where = { campaignId };
    if (status) where.status = status;

    const [total, items] = await Promise.all([
      this.db.campaignMember.count({ where }),
      this.db.campaignMember.findMany({
        where,
        skip,
        take: limit,
        orderBy: { joinedAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              discordId: true,
              username: true,
              displayName: true,
              status: true
            }
          }
        }
      })
    ]);

    return {
      items,
      total,
      page: Math.max(1, page),
      totalPages: Math.ceil(total / limit) || 1
    };
  }

  /**
   * Check if campaign has any submissions or earnings
   * Used for safety checks (e.g. currency change prevention)
   *
   * @param {string} campaignId
   * @returns {Promise<{ hasSubmissions: boolean, hasEarnings: boolean }>}
   */
  async getCampaignActivity(campaignId) {
    const [subCount, earnCount] = await Promise.all([
      this.db.submission.count({ where: { campaignId } }),
      this.db.earning.count({ where: { campaignId } })
    ]);

    return {
      hasSubmissions: subCount > 0,
      hasEarnings: earnCount > 0
    };
  }
}

export const adminCampaignRepository = new AdminCampaignRepository();
export default adminCampaignRepository;
