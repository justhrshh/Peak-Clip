import { Prisma } from '@prisma/client';
import { prisma } from '../../database/client.js';

export class CampaignRepository {
  constructor(dbClient = prisma) {
    this.db = dbClient;
  }

  /**
   * Find active campaigns within their valid date window and with remaining budget.
   * Returns campaigns with computed fulfillment fields.
   * @param {Date} [now=new Date()]
   * @returns {Promise<Array<object>>}
   */
  async findActive(now = new Date()) {
    const campaigns = await this.db.campaign.findMany({
      where: {
        status: 'ACTIVE',
        startsAt: { lte: now },
        endsAt: { gte: now }
      },
      orderBy: { startsAt: 'desc' }
    });
    return campaigns.map(withFulfillment);
  }

  /**
   * Find a campaign by UUID
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async findById(id) {
    const campaign = await this.db.campaign.findUnique({
      where: { id }
    });
    return campaign ? withFulfillment(campaign) : null;
  }

  /**
   * Find a campaign by slug
   * @param {string} slug
   * @returns {Promise<object|null>}
   */
  async findBySlug(slug) {
    const campaign = await this.db.campaign.findUnique({
      where: { slug }
    });
    return campaign ? withFulfillment(campaign) : null;
  }

  /**
   * Create a new campaign
   * @param {object} data
   * @returns {Promise<object>}
   */
  async create(data) {
    const campaign = await this.db.campaign.create({ data });
    return withFulfillment(campaign);
  }

  /**
   * Update campaign status
   * @param {string} id
   * @param {string} status
   * @returns {Promise<object>}
   */
  async updateStatus(id, status) {
    const campaign = await this.db.campaign.update({
      where: { id },
      data: { status }
    });
    return withFulfillment(campaign);
  }

  /**
   * Atomically consume campaign budget after an earning is credited.
   *
   * Increments consumedBudget by the credited amount.
   * If consumedBudget >= totalBudget, auto-transitions campaign status to COMPLETED.
   *
   * Note: This always uses the repository's own database client (not the earnings tx),
   * because the earnings repo and campaign repo use separate Prisma clients. Double-counting
   * is prevented by the unique constraint on earning.sourceSnapshotId — not by shared tx.
   *
   * @param {string} campaignId
   * @param {Prisma.Decimal|string|number} amount - The actual credited amount
   * @param {object} [_tx=null] - Ignored (earnings repo tx, not campaign repo tx)
   * @returns {Promise<object>} Updated campaign with fulfillment fields
   */
  async consumeBudget(campaignId, amount, _tx = null) {
    const amountDec = new Prisma.Decimal(amount.toString());

    // Atomically increment consumedBudget using campaign repo's own db client
    const updated = await this.db.campaign.update({
      where: { id: campaignId },
      data: {
        consumedBudget: {
          increment: amountDec
        }
      }
    });

    const remaining = new Prisma.Decimal(updated.totalBudget.toString()).minus(
      new Prisma.Decimal(updated.consumedBudget.toString())
    );

    // Auto-complete campaign if budget fully consumed
    if (remaining.lessThanOrEqualTo(0) && updated.status === 'ACTIVE') {
      const completed = await this.db.campaign.update({
        where: { id: campaignId },
        data: { status: 'COMPLETED' }
      });
      return withFulfillment(completed);
    }

    return withFulfillment(updated);
  }

  /**
   * Get the remaining budget for a campaign (within optional transaction).
   * @param {string} campaignId
   * @param {object} [tx=null]
   * @returns {Promise<Prisma.Decimal>}
   */
  async getRemainingBudget(campaignId, tx = null) {
    const client = tx || this.db;
    const campaign = await client.campaign.findUnique({
      where: { id: campaignId },
      select: { totalBudget: true, consumedBudget: true }
    });
    if (!campaign) return new Prisma.Decimal('0.00');
    return new Prisma.Decimal(campaign.totalBudget.toString()).minus(
      new Prisma.Decimal(campaign.consumedBudget.toString())
    );
  }

  /**
   * Find membership record for a specific user and campaign
   * @param {string} userId
   * @param {string} campaignId
   * @returns {Promise<object|null>}
   */
  async findMembership(userId, campaignId) {
    return this.db.campaignMember.findUnique({
      where: {
        userId_campaignId: {
          userId,
          campaignId
        }
      }
    });
  }

  /**
   * Upsert a campaign membership record
   * @param {string} userId
   * @param {string} campaignId
   * @param {'ACTIVE'|'LEFT'|'REMOVED'} status
   * @returns {Promise<object>}
   */
  async upsertMembership(userId, campaignId, status = 'ACTIVE') {
    return this.db.campaignMember.upsert({
      where: {
        userId_campaignId: {
          userId,
          campaignId
        }
      },
      update: {
        status,
        updatedAt: new Date()
      },
      create: {
        userId,
        campaignId,
        status,
        joinedAt: new Date()
      }
    });
  }

  /**
   * Update existing membership status
   * @param {string} userId
   * @param {string} campaignId
   * @param {'ACTIVE'|'LEFT'|'REMOVED'} status
   * @returns {Promise<object>}
   */
  async updateMembershipStatus(userId, campaignId, status) {
    return this.db.campaignMember.update({
      where: {
        userId_campaignId: {
          userId,
          campaignId
        }
      },
      data: {
        status,
        updatedAt: new Date()
      }
    });
  }

  /**
   * Find all campaigns a user has joined
   * @param {string} userId
   * @returns {Promise<Array<object>>}
   */
  async findUserMemberships(userId) {
    return this.db.campaignMember.findMany({
      where: { userId },
      include: {
        campaign: true
      },
      orderBy: { joinedAt: 'desc' }
    });
  }

  /**
   * Find all members of a specific campaign
   * @param {string} campaignId
   * @returns {Promise<Array<object>>}
   */
  async findCampaignMembers(campaignId) {
    return this.db.campaignMember.findMany({
      where: { campaignId },
      include: {
        user: true
      },
      orderBy: { joinedAt: 'desc' }
    });
  }
}

/**
 * Attach computed fulfillment fields to a raw campaign record.
 * Uses pure Decimal arithmetic — never floating point.
 * @param {object} campaign - Raw Prisma campaign record
 * @returns {object} Campaign enriched with remainingBudget and fulfillmentPercent
 */
function withFulfillment(campaign) {
  const total = new Prisma.Decimal(campaign.totalBudget?.toString() ?? '0');
  const consumed = new Prisma.Decimal(campaign.consumedBudget?.toString() ?? '0');
  const remaining = total.minus(consumed);

  let fulfillmentPercent = new Prisma.Decimal('0.00');
  if (total.greaterThan(0)) {
    fulfillmentPercent = consumed
      .dividedBy(total)
      .times(100)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  }

  return {
    ...campaign,
    totalBudget: total,
    consumedBudget: consumed,
    remainingBudget: remaining.greaterThanOrEqualTo(0) ? remaining : new Prisma.Decimal('0.00'),
    fulfillmentPercent
  };
}

export { withFulfillment };

export const campaignRepository = new CampaignRepository();
export default campaignRepository;
