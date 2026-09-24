import { Prisma } from '@prisma/client';
import { campaignRepository as defaultCampaignRepo } from '../campaigns/campaign.repository.js';
import { adminCampaignRepository as defaultAdminCampaignRepo } from './admin.campaign.repository.js';
import { adminAuditService as defaultAuditService } from './audit.service.js';
import {
  campaignCreateSchema,
  campaignRequirementsSchema,
  validateStatusTransition,
  ADMIN_SETTABLE_STATUSES
} from '../campaigns/campaign.validation.js';
import { CAMPAIGN_POLICY } from '../campaigns/campaign.policy.js';
import {
  CampaignNotFoundError,
  MembershipError
} from '../campaigns/campaign.errors.js';
import {
  InvalidCampaignConfigurationError,
  CurrencyModificationForbiddenError
} from './admin.errors.js';
import { statisticsService as defaultStatsService } from '../statistics/statistics.service.js';
import { logger } from '../../utils/logger.js';

export class AdminCampaignService {
  constructor(
    campaignRepo = defaultCampaignRepo,
    adminCampaignRepo = defaultAdminCampaignRepo,
    auditService = defaultAuditService,
    statsService = defaultStatsService
  ) {
    this.campaignRepo = campaignRepo;
    this.adminCampaignRepo = adminCampaignRepo;
    this.auditService = auditService;
    this.statsService = statsService;
  }

  /**
   * Create a new campaign with complete validation and audit logging.
   * Phase 10A: persists totalBudget, creatorEarningCap, clip duration, retention.
   *
   * @param {object} data
   * @param {object} actor - { discordId, userId }
   * @returns {Promise<object>}
   */
  async createCampaign(data, actor) {
    const validated = campaignCreateSchema.parse(data);

    // Slug uniqueness check
    const existing = await this.campaignRepo.findBySlug(validated.slug);
    if (existing) {
      throw new InvalidCampaignConfigurationError(`Campaign slug '${validated.slug}' is already in use.`);
    }

    const payRateDecimal = new Prisma.Decimal(validated.payRate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    const minPayoutDecimal = new Prisma.Decimal(validated.minimumPayout || 0).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    const totalBudgetDecimal = new Prisma.Decimal(validated.totalBudget).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    const creatorEarningCapDecimal = new Prisma.Decimal(
      validated.creatorEarningCap ?? Number(CAMPAIGN_POLICY.DEFAULT_CREATOR_EARNING_CAP)
    ).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

    const campaign = await this.campaignRepo.create({
      name: validated.name,
      slug: validated.slug,
      description: validated.description,
      clientName: validated.clientName,
      status: 'DRAFT',
      payRate: payRateDecimal,
      minimumPayout: minPayoutDecimal,
      currency: data.currency ? String(data.currency).toUpperCase() : CAMPAIGN_POLICY.DEFAULT_CURRENCY,
      startsAt: validated.startsAt,
      endsAt: validated.endsAt,
      // Phase 10A budget fields
      totalBudget: totalBudgetDecimal,
      consumedBudget: new Prisma.Decimal('0.00'),
      creatorEarningCap: creatorEarningCapDecimal,
      // Phase 10A clip duration policy
      minClipDurationSeconds: validated.minClipDurationSeconds ?? CAMPAIGN_POLICY.DEFAULT_MIN_CLIP_DURATION_SECONDS,
      maxClipDurationSeconds: validated.maxClipDurationSeconds ?? CAMPAIGN_POLICY.DEFAULT_MAX_CLIP_DURATION_SECONDS,
      // Phase 10A retention policy
      retentionRequired: validated.retentionRequired ?? false,
      retentionDays: validated.retentionRequired ? (validated.retentionDays ?? null) : null,
      requirements: validated.requirements
    });

    await this.auditService.logAction({
      actorUserId: actor?.userId || null,
      actorDiscordId: actor.discordId,
      action: 'CAMPAIGN_CREATE',
      entityType: 'CAMPAIGN',
      entityId: campaign.id,
      newState: {
        name: campaign.name,
        slug: campaign.slug,
        payRate: campaign.payRate.toString(),
        totalBudget: totalBudgetDecimal.toString(),
        creatorEarningCap: creatorEarningCapDecimal.toString(),
        currency: campaign.currency,
        status: campaign.status
      }
    });

    logger.info({ campaignId: campaign.id, slug: campaign.slug, actorDiscordId: actor.discordId }, 'Campaign created by admin');
    return campaign;
  }

  /**
   * Edit existing campaign with historical financial protection.
   *
   * Financial Invariants:
   * 1. Changing payRate applies only to future credits; historical Earning rows remain locked.
   * 2. Changing currency is strictly forbidden if campaign already has submissions or earnings.
   * 3. totalBudget can be increased but NEVER decreased below consumedBudget.
   * 4. Date integrity: endsAt must remain chronologically after startsAt.
   *
   * @param {string} campaignId
   * @param {object} data
   * @param {object} actor
   * @returns {Promise<object>}
   */
  async editCampaign(campaignId, data, actor) {
    const campaign = await this.campaignRepo.findById(campaignId);
    if (!campaign) {
      throw new CampaignNotFoundError(campaignId);
    }

    const previousState = {
      name: campaign.name,
      payRate: campaign.payRate?.toFixed ? campaign.payRate.toFixed(2) : String(campaign.payRate),
      totalBudget: campaign.totalBudget?.toFixed ? campaign.totalBudget.toFixed(2) : String(campaign.totalBudget),
      currency: campaign.currency,
      startsAt: campaign.startsAt,
      endsAt: campaign.endsAt
    };

    const updateData = {};

    // 1. Currency Change Protection
    if (data.currency && data.currency.toUpperCase() !== campaign.currency) {
      const activity = await this.adminCampaignRepo.getCampaignActivity(campaignId);
      if (activity.hasSubmissions || activity.hasEarnings) {
        throw new CurrencyModificationForbiddenError(campaignId, campaign.currency, data.currency.toUpperCase());
      }
      updateData.currency = data.currency.toUpperCase();
    }

    // 2. Pay Rate Update (Only affects subsequent view increments)
    if (data.payRate !== undefined) {
      const parsedRate = Number(data.payRate);
      if (isNaN(parsedRate) || parsedRate <= 0) {
        throw new InvalidCampaignConfigurationError('Campaign pay rate must be greater than 0.');
      }
      updateData.payRate = new Prisma.Decimal(data.payRate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    }

    // 3. Minimum Payout Update
    if (data.minimumPayout !== undefined) {
      const parsedMin = Number(data.minimumPayout);
      if (isNaN(parsedMin) || parsedMin < 0) {
        throw new InvalidCampaignConfigurationError('Minimum payout must be 0 or greater.');
      }
      updateData.minimumPayout = new Prisma.Decimal(data.minimumPayout).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    }

    // 4. Phase 10A: Total Budget Update
    //    Cannot be decreased below consumedBudget — that would make the accounting impossible.
    if (data.totalBudget !== undefined) {
      const parsedBudget = Number(data.totalBudget);
      if (isNaN(parsedBudget) || parsedBudget <= 0) {
        throw new InvalidCampaignConfigurationError('Total budget must be greater than 0.');
      }
      const newBudgetDec = new Prisma.Decimal(data.totalBudget).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      const currentConsumed = new Prisma.Decimal(campaign.consumedBudget?.toString() ?? '0');
      if (newBudgetDec.lessThan(currentConsumed)) {
        throw new InvalidCampaignConfigurationError(
          `Cannot reduce totalBudget to $${newBudgetDec.toFixed(2)} — campaign has already consumed $${currentConsumed.toFixed(2)}.`
        );
      }
      updateData.totalBudget = newBudgetDec;
    }

    // 5. Phase 10A: Creator Earning Cap Update
    if (data.creatorEarningCap !== undefined) {
      const parsedCap = Number(data.creatorEarningCap);
      if (isNaN(parsedCap) || parsedCap <= 0) {
        throw new InvalidCampaignConfigurationError('Creator earning cap must be greater than 0.');
      }
      updateData.creatorEarningCap = new Prisma.Decimal(data.creatorEarningCap).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    }

    // 6. Phase 10A: Clip Duration Updates
    if (data.minClipDurationSeconds !== undefined) {
      const minDur = parseInt(data.minClipDurationSeconds, 10);
      if (isNaN(minDur) || minDur < 1) {
        throw new InvalidCampaignConfigurationError('Minimum clip duration must be at least 1 second.');
      }
      updateData.minClipDurationSeconds = minDur;
    }
    if (data.maxClipDurationSeconds !== undefined) {
      const maxDur = parseInt(data.maxClipDurationSeconds, 10);
      if (isNaN(maxDur) || maxDur < 1) {
        throw new InvalidCampaignConfigurationError('Maximum clip duration must be at least 1 second.');
      }
      updateData.maxClipDurationSeconds = maxDur;
    }
    const effectiveMin = updateData.minClipDurationSeconds ?? campaign.minClipDurationSeconds;
    const effectiveMax = updateData.maxClipDurationSeconds ?? campaign.maxClipDurationSeconds;
    if (effectiveMax < effectiveMin) {
      throw new InvalidCampaignConfigurationError('maxClipDurationSeconds must be >= minClipDurationSeconds.');
    }

    // 7. Phase 10A: Retention Policy Updates
    if (data.retentionRequired !== undefined) {
      updateData.retentionRequired = Boolean(data.retentionRequired);
    }
    if (data.retentionDays !== undefined) {
      const days = parseInt(data.retentionDays, 10);
      if (isNaN(days) || days < 1) {
        throw new InvalidCampaignConfigurationError('Retention days must be at least 1.');
      }
      updateData.retentionDays = days;
    }
    const effectiveRetentionRequired = updateData.retentionRequired ?? campaign.retentionRequired;
    const effectiveRetentionDays = updateData.retentionDays ?? campaign.retentionDays;
    if (effectiveRetentionRequired && !effectiveRetentionDays) {
      throw new InvalidCampaignConfigurationError('retentionDays must be set when retentionRequired is true.');
    }

    // 8. Date Window & Integrity
    const newStartsAt = data.startsAt ? new Date(data.startsAt) : campaign.startsAt;
    const newEndsAt = data.endsAt ? new Date(data.endsAt) : campaign.endsAt;

    if (data.startsAt || data.endsAt) {
      if (newEndsAt <= newStartsAt) {
        throw new InvalidCampaignConfigurationError('Campaign endsAt must be chronologically after startsAt.');
      }
      if (data.startsAt) updateData.startsAt = newStartsAt;
      if (data.endsAt) updateData.endsAt = newEndsAt;
    }

    // 9. Requirements Shape Validation
    if (data.requirements) {
      const parsedReqs = campaignRequirementsSchema.parse(data.requirements);
      updateData.requirements = parsedReqs;
    }

    // 10. Text Details
    if (data.name) updateData.name = String(data.name).trim();
    if (data.description) updateData.description = String(data.description).trim();
    if (data.clientName) updateData.clientName = String(data.clientName).trim();

    const updated = await this.campaignRepo.db.campaign.update({
      where: { id: campaignId },
      data: updateData
    });

    await this.auditService.logAction({
      actorUserId: actor?.userId || null,
      actorDiscordId: actor.discordId,
      action: 'CAMPAIGN_UPDATE',
      entityType: 'CAMPAIGN',
      entityId: campaign.id,
      previousState,
      newState: {
        name: updated.name,
        payRate: updated.payRate?.toFixed ? updated.payRate.toFixed(2) : String(updated.payRate),
        totalBudget: updated.totalBudget?.toFixed ? updated.totalBudget.toFixed(2) : String(updated.totalBudget),
        currency: updated.currency,
        startsAt: updated.startsAt,
        endsAt: updated.endsAt
      },
      reason: data.reason || null
    });

    logger.info({ campaignId, actorDiscordId: actor.discordId }, 'Campaign updated by admin');
    return updated;
  }

  /**
   * Transition campaign status with date integrity check.
   * COMPLETED is a system-only state; it cannot be set by admin.
   *
   * @param {string} campaignId
   * @param {string} targetStatus
   * @param {object} actor
   * @param {string} [reason]
   * @returns {Promise<object>}
   */
  async setCampaignStatus(campaignId, targetStatus, actor, reason = null) {
    // Guard: COMPLETED is system-only; admin cannot force-complete a campaign
    if (targetStatus === 'COMPLETED') {
      throw new InvalidCampaignConfigurationError(
        'COMPLETED status is set automatically when a campaign budget is fully consumed. Use budget management instead.'
      );
    }

    const campaign = await this.campaignRepo.findById(campaignId);
    if (!campaign) {
      throw new CampaignNotFoundError(campaignId);
    }

    validateStatusTransition(campaign.status, targetStatus);

    // Date Integrity: cannot activate an expired campaign
    if (targetStatus === 'ACTIVE') {
      const now = new Date();
      if (new Date(campaign.endsAt) <= now) {
        throw new InvalidCampaignConfigurationError(
          `Cannot activate campaign '${campaign.name}': campaign end date (${new Date(campaign.endsAt).toISOString()}) has already passed. Please update endsAt first.`
        );
      }
    }

    const updated = await this.campaignRepo.updateStatus(campaignId, targetStatus);

    await this.auditService.logAction({
      actorUserId: actor?.userId || null,
      actorDiscordId: actor.discordId,
      action: `CAMPAIGN_${targetStatus}`,
      entityType: 'CAMPAIGN',
      entityId: campaign.id,
      previousState: { status: campaign.status },
      newState: { status: updated.status },
      reason
    });

    logger.info({ campaignId, from: campaign.status, to: targetStatus, actorDiscordId: actor.discordId }, 'Campaign status transitioned');
    return updated;
  }

  /**
   * Alias for setCampaignStatus
   */
  async updateStatus(campaignId, targetStatus, actor, reason = null) {
    return this.setCampaignStatus(campaignId, targetStatus, actor, reason);
  }

  /**
   * List paginated campaigns with member and submission summaries
   *
   * @param {object} [options={}]
   * @returns {Promise<object>}
   */
  async listCampaigns(options = {}) {
    return this.adminCampaignRepo.listCampaigns(options);
  }

  /**
   * Get detailed aggregated view of a campaign (no N+1)
   *
   * @param {string} campaignId
   * @returns {Promise<object>}
   */
  async getCampaignDetails(campaignId) {
    const details = await this.adminCampaignRepo.getCampaignDetails(campaignId);
    if (!details) {
      throw new CampaignNotFoundError(campaignId);
    }
    return details;
  }

  /**
   * List campaign members with pagination
   *
   * @param {string} campaignId
   * @param {object} [options={}]
   * @returns {Promise<object>}
   */
  async listMembers(campaignId, options = {}) {
    return this.adminCampaignRepo.listMembers(campaignId, options);
  }

  /**
   * Remove a member from a campaign (sets status to REMOVED).
   * Preserves historical earnings, submissions, and database row.
   *
   * @param {string} campaignId
   * @param {string} userId
   * @param {object} actor
   * @param {string} [reason]
   * @returns {Promise<object>}
   */
  async removeMember(campaignId, userId, actor, reason = null) {
    const membership = await this.campaignRepo.findMembership(userId, campaignId);
    if (!membership || membership.status !== 'ACTIVE') {
      throw new MembershipError('User is not an active member of this campaign.');
    }

    const updated = await this.campaignRepo.updateMembershipStatus(userId, campaignId, 'REMOVED');

    await this.auditService.logAction({
      actorUserId: actor?.userId || null,
      actorDiscordId: actor.discordId,
      action: 'MEMBER_REMOVE',
      entityType: 'MEMBERSHIP',
      entityId: `${userId}_${campaignId}`,
      previousState: { status: membership.status },
      newState: { status: 'REMOVED' },
      reason
    });

    logger.info({ campaignId, userId, actorDiscordId: actor.discordId }, 'Member removed from campaign by admin');
    return updated;
  }

  /**
   * Reactivate a previously removed or left member
   *
   * @param {string} campaignId
   * @param {string} userId
   * @param {object} actor
   * @returns {Promise<object>}
   */
  async reactivateMember(campaignId, userId, actor) {
    const membership = await this.campaignRepo.findMembership(userId, campaignId);
    if (!membership) {
      throw new MembershipError('Membership record not found.');
    }

    const updated = await this.campaignRepo.updateMembershipStatus(userId, campaignId, 'ACTIVE');

    await this.auditService.logAction({
      actorUserId: actor?.userId || null,
      actorDiscordId: actor.discordId,
      action: 'MEMBER_REACTIVATE',
      entityType: 'MEMBERSHIP',
      entityId: `${userId}_${campaignId}`,
      previousState: { status: membership.status },
      newState: { status: 'ACTIVE' }
    });

    logger.info({ campaignId, userId, actorDiscordId: actor.discordId }, 'Member reactivated in campaign by admin');
    return updated;
  }

  /**
   * Get operational campaign analytics report
   *
   * @param {string} campaignId
   * @param {object} actor
   * @param {object} [options={}]
   * @returns {Promise<object>}
   */
  async getCampaignAnalyticsReport(campaignId, actor, options = {}) {
    return this.statsService.getCampaignReport(campaignId, options);
  }

  /**
   * Get final campaign performance report with strict financial reconciliation
   *
   * @param {string} campaignId
   * @param {object} actor
   * @returns {Promise<object>}
   */
  async getFinalCampaignReport(campaignId, actor) {
    return this.statsService.getCampaignReport(campaignId);
  }
}

export const adminCampaignService = new AdminCampaignService();
export default adminCampaignService;
