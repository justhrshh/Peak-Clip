import { Prisma } from '@prisma/client';
import { prisma } from '../../database/client.js';
import { campaignRepository as defaultCampaignRepo } from './campaign.repository.js';
import { userService as defaultUserService } from '../users/user.service.js';
import {
  CampaignNotFoundError,
  CampaignNotActiveError,
  CampaignWindowError,
  CampaignBudgetExhaustedError,
  MembershipError
} from './campaign.errors.js';
import { validateStatusTransition } from './campaign.validation.js';
import { logger } from '../../utils/logger.js';

export class CampaignService {
  constructor(campaignRepo = defaultCampaignRepo, userService = defaultUserService) {
    this.campaignRepo = campaignRepo;
    this.userService = userService;
  }

  /**
   * List all currently active campaigns within valid date range.
   * Returned objects include computed fulfillment fields.
   * @returns {Promise<Array<object>>}
   */
  async listActiveCampaigns() {
    const now = new Date();
    return this.campaignRepo.findActive(now);
  }

  /**
   * Get campaign by ID (includes fulfillment fields)
   * @param {string} id
   * @returns {Promise<object>}
   */
  async getCampaignById(id) {
    const campaign = await this.campaignRepo.findById(id);
    if (!campaign) {
      throw new CampaignNotFoundError(id);
    }
    return campaign;
  }

  /**
   * Get campaign by unique slug (includes fulfillment fields)
   * @param {string} slug
   * @returns {Promise<object>}
   */
  async getCampaignBySlug(slug) {
    const campaign = await this.campaignRepo.findBySlug(slug);
    if (!campaign) {
      throw new CampaignNotFoundError(slug);
    }
    return campaign;
  }

  /**
   * Compute fulfillment summary for a campaign.
   * @param {object} campaign - Campaign with totalBudget and consumedBudget
   * @returns {{ totalBudget: Prisma.Decimal, consumedBudget: Prisma.Decimal, remainingBudget: Prisma.Decimal, fulfillmentPercent: Prisma.Decimal }}
   */
  getCampaignFulfillment(campaign) {
    return {
      totalBudget: campaign.totalBudget,
      consumedBudget: campaign.consumedBudget,
      remainingBudget: campaign.remainingBudget,
      fulfillmentPercent: campaign.fulfillmentPercent
    };
  }

  /**
   * Get real-time live budget details for a campaign, computing live view consumption
   * from approved clip snapshots and updating the database consumedBudget if it exceeds
   * the stored value.
   *
   * @param {string} campaignId
   * @returns {Promise<object>}
   */
  async getCampaignLiveBudget(campaignId) {
    const db = this.campaignRepo?.db || prisma;
    const campaign = await db.campaign.findUnique({
      where: { id: campaignId },
      include: {
        submissions: {
          where: { status: 'APPROVED' },
          include: {
            snapshots: {
              orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
              take: 1
            }
          }
        }
      }
    });

    if (!campaign) {
      throw new CampaignNotFoundError(campaignId);
    }

    let approvedViewsSum = 0n;
    for (const sub of campaign.submissions || []) {
      const rawViews = sub.snapshots?.[0]?.views;
      if (rawViews !== undefined && rawViews !== null) {
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
    const liveConsumed = Math.max(recordedConsumed, viewsBasedConsumed);
    const totalBudgetNum = Number(campaign.totalBudget || 0);
    const remainingBudgetNum = Math.max(0, totalBudgetNum - liveConsumed);
    const fulfillmentPercentNum = totalBudgetNum > 0
      ? Math.min(100, (liveConsumed / totalBudgetNum) * 100)
      : 0;

    // Persist live consumed budget if it increased
    if (liveConsumed > recordedConsumed && db?.campaign?.update) {
      await db.campaign.update({
        where: { id: campaign.id },
        data: { consumedBudget: new Prisma.Decimal(liveConsumed.toFixed(2)) }
      }).catch(() => {});
    }

    return {
      id: campaign.id,
      name: campaign.name,
      slug: campaign.slug,
      status: campaign.status,
      currency: campaign.currency || 'USD',
      payRate: payRateNum,
      totalBudget: totalBudgetNum,
      consumedBudget: liveConsumed,
      remainingBudget: remainingBudgetNum,
      fulfillmentPercent: fulfillmentPercentNum,
      approvedViews: approvedViewsSum
    };
  }

  /**
   * Check if a campaign can currently be joined based on:
   * 1. Status must be ACTIVE
   * 2. Date window must be valid (started but not ended)
   * 3. Budget must not be exhausted
   *
   * @param {object} campaign
   * @throws {CampaignNotActiveError|CampaignWindowError|CampaignBudgetExhaustedError}
   */
  assertCampaignJoinable(campaign) {
    if (campaign.status === 'COMPLETED') {
      throw new CampaignBudgetExhaustedError(campaign.id);
    }

    if (campaign.status !== 'ACTIVE') {
      throw new CampaignNotActiveError(campaign.id, campaign.status);
    }

    const now = new Date();
    const startsAt = new Date(campaign.startsAt);
    const endsAt = new Date(campaign.endsAt);

    if (now < startsAt) {
      throw new CampaignWindowError(
        campaign.id,
        `Campaign has not started yet. Starts at ${startsAt.toISOString()}`,
        { startsAt, now }
      );
    }

    if (now > endsAt) {
      throw new CampaignWindowError(
        campaign.id,
        `Campaign has already concluded. Ended at ${endsAt.toISOString()}`,
        { endsAt, now }
      );
    }

    // Budget exhaustion check (uses computed remainingBudget)
    if (campaign.remainingBudget && campaign.remainingBudget.lessThanOrEqualTo(0)) {
      throw new CampaignBudgetExhaustedError(campaign.id);
    }

    return true;
  }

  /**
   * Join a campaign
   * Business Rules:
   * 1. Only ACTIVE campaigns (with remaining budget) can be joined.
   * 2. Campaign outside start/end window cannot be joined.
   * 3. Suspended/banned users cannot join campaigns.
   * 4. Idempotent: joining twice returns existing active membership.
   * 5. Leaving does not destroy historical membership data; rejoining reactivates it.
   * @param {string} userId - Internal user UUID
   * @param {string} campaignId - Campaign UUID
   * @returns {Promise<object>} Membership record
   */
  async joinCampaign(userId, campaignId) {
    // 1. Verify user eligibility
    const user = await this.userService.getProfile(userId);
    this.userService.assertUserCanParticipate(user);

    // 2. Verify campaign exists and is joinable
    const campaign = await this.getCampaignById(campaignId);
    this.assertCampaignJoinable(campaign);

    // 3. Check existing membership
    const existingMembership = await this.campaignRepo.findMembership(userId, campaignId);

    if (existingMembership) {
      if (existingMembership.status === 'ACTIVE') {
        logger.info({ userId, campaignId }, 'User already has active membership in campaign (idempotent join)');
        return existingMembership;
      }

      // Re-joining an inactive/left membership
      logger.info({ userId, campaignId, previousStatus: existingMembership.status }, 'Reactivating campaign membership');
      return this.campaignRepo.updateMembershipStatus(userId, campaignId, 'ACTIVE');
    }

    // 4. Create new membership
    logger.info({ userId, campaignId }, 'User joining campaign');
    return this.campaignRepo.upsertMembership(userId, campaignId, 'ACTIVE');
  }

  /**
   * Leave a campaign
   * Preserves historical membership record by transitioning to 'LEFT'
   * @param {string} userId
   * @param {string} campaignId
   * @returns {Promise<object>}
   */
  async leaveCampaign(userId, campaignId) {
    const existingMembership = await this.campaignRepo.findMembership(userId, campaignId);

    if (!existingMembership || existingMembership.status !== 'ACTIVE') {
      throw new MembershipError('You are not currently an active member of this campaign', {
        userId,
        campaignId,
        currentStatus: existingMembership?.status || 'NONE'
      });
    }

    logger.info({ userId, campaignId }, 'User leaving campaign');
    return this.campaignRepo.updateMembershipStatus(userId, campaignId, 'LEFT');
  }

  /**
   * Get all campaigns a user has joined (active or historical)
   * @param {string} userId
   * @returns {Promise<Array<object>>}
   */
  async getUserCampaigns(userId) {
    return this.campaignRepo.findUserMemberships(userId);
  }

  /**
   * Transition campaign status according to state machine rules
   * @param {string} campaignId
   * @param {string} targetStatus
   * @returns {Promise<object>}
   */
  async transitionStatus(campaignId, targetStatus) {
    const campaign = await this.getCampaignById(campaignId);
    validateStatusTransition(campaign.status, targetStatus);

    logger.info({ campaignId, from: campaign.status, to: targetStatus }, 'Transitioning campaign status');
    return this.campaignRepo.updateStatus(campaignId, targetStatus);
  }
}

export const campaignService = new CampaignService();
export default campaignService;
