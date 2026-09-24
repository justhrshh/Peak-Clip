import { adjustmentRepository as defaultRepo } from './adjustment.repository.js';
import { prisma } from '../../database/client.js';
import { Prisma } from '@prisma/client';
import { logger } from '../../utils/logger.js';

export class AdjustmentService {
  constructor(repo = defaultRepo, dbClient = prisma) {
    this.repo = repo;
    this.prisma = dbClient;
  }

  /**
   * Create auditable financial adjustments when a submission violates retention requirements
   *
   * Business Rules:
   * - Does NOT modify or delete original Earning rows.
   * - Does NOT modify completed Payout rows.
   * - Creates an explicit, signed negative adjustment row referencing each original earning.
   * - Fully idempotent: subsequent runs will not produce duplicate adjustments.
   *
   * @param {object} submission
   * @param {string} violationReason
   * @param {object} [tx=null]
   * @returns {Promise<Array<object>>}
   */
  async createRetentionViolationAdjustments(submission, violationReason, tx = null) {
    const client = tx || this.prisma;

    // 1. Resolve all eligible earnings associated with this submission
    const earnings = await client.earning.findMany({
      where: {
        submissionId: submission.id,
        status: 'ELIGIBLE'
      }
    });

    if (earnings.length === 0) {
      logger.info(
        { submissionId: submission.id },
        'No eligible earnings found for retention-violated submission; no financial adjustments required'
      );
      return [];
    }

    const createdAdjustments = [];

    for (const earning of earnings) {
      // 2. Check idempotency: does adjustment already exist for this earning?
      const existing = await this.repo.getAdjustmentByEarningAndType(
        earning.id,
        'RETENTION_VIOLATION',
        client
      );

      if (existing) {
        logger.info(
          { submissionId: submission.id, earningId: earning.id, adjustmentId: existing.id },
          'Retention violation adjustment already exists for earning (idempotent)'
        );
        createdAdjustments.push(existing);
        continue;
      }

      // 3. Negate earning amount (e.g. grossAmount $50.00 -> amount -$50.00)
      const earningAmount = new Prisma.Decimal(earning.grossAmount);
      const adjustmentAmount = earningAmount.negated();

      const adjustment = await this.repo.createAdjustment(
        {
          userId: submission.userId,
          campaignId: submission.campaignId,
          submissionId: submission.id,
          earningId: earning.id,
          type: 'RETENTION_VIOLATION',
          amount: adjustmentAmount,
          currency: earning.currency || 'USD',
          reason: violationReason || 'Video unavailable/deleted before required retention period ended',
          source: 'SYSTEM_RETENTION_WORKER',
          metadata: {
            originalEarningId: earning.id,
            originalGrossAmount: earningAmount.toFixed(2),
            originalEligibleViews: earning.eligibleViews ? earning.eligibleViews.toString() : '0'
          }
        },
        client
      );

      logger.warn(
        {
          submissionId: submission.id,
          earningId: earning.id,
          adjustmentId: adjustment.id,
          userId: submission.userId,
          amount: adjustment.amount.toString()
        },
        'Created auditable retention violation financial adjustment'
      );

      createdAdjustments.push(adjustment);
    }

    return createdAdjustments;
  }

  /**
   * Create auditable financial adjustments when an approved submission is rejected post-approval
   *
   * Business Rules:
   * - Does NOT modify or delete original Earning rows.
   * - Does NOT modify completed Payout rows.
   * - Creates an explicit, signed negative adjustment row referencing each original earning.
   * - Fully idempotent: subsequent runs will not produce duplicate adjustments.
   *
   * @param {object} submission
   * @param {string} reason
   * @param {string} [actorDiscordId='ADMIN']
   * @param {object} [tx=null]
   * @returns {Promise<Array<object>>}
   */
  async createPostApprovalRejectionAdjustments(submission, reason, actorDiscordId = 'ADMIN', tx = null) {
    const client = tx || this.prisma;

    // 1. Resolve all eligible earnings associated with this submission
    const earnings = await client.earning.findMany({
      where: {
        submissionId: submission.id,
        status: 'ELIGIBLE'
      }
    });

    if (earnings.length === 0) {
      logger.info(
        { submissionId: submission.id },
        'No eligible earnings found for post-approval rejected submission; no financial adjustments required'
      );
      return [];
    }

    const createdAdjustments = [];

    for (const earning of earnings) {
      // 2. Check idempotency: does adjustment already exist for this earning?
      const existing = await this.repo.getAdjustmentByEarningAndType(
        earning.id,
        'POST_APPROVAL_REJECTION',
        client
      );

      if (existing) {
        logger.info(
          { submissionId: submission.id, earningId: earning.id, adjustmentId: existing.id },
          'Post-approval rejection adjustment already exists for earning (idempotent)'
        );
        createdAdjustments.push(existing);
        continue;
      }

      // 3. Negate earning amount (e.g. grossAmount $40.00 -> amount -$40.00)
      const earningAmount = new Prisma.Decimal(earning.grossAmount);
      const adjustmentAmount = earningAmount.negated();

      const adjustment = await this.repo.createAdjustment(
        {
          userId: submission.userId,
          campaignId: submission.campaignId,
          submissionId: submission.id,
          earningId: earning.id,
          type: 'POST_APPROVAL_REJECTION',
          amount: adjustmentAmount,
          currency: earning.currency || 'USD',
          reason: reason || 'Submission rejected during post-approval moderation review',
          source: 'ADMIN_MODERATION',
          metadata: {
            actorDiscordId,
            originalEarningId: earning.id,
            originalGrossAmount: earningAmount.toFixed(2),
            originalEligibleViews: earning.eligibleViews ? earning.eligibleViews.toString() : '0'
          }
        },
        client
      );

      logger.warn(
        {
          submissionId: submission.id,
          earningId: earning.id,
          adjustmentId: adjustment.id,
          userId: submission.userId,
          amount: adjustment.amount.toString()
        },
        'Created auditable post-approval rejection financial adjustment'
      );

      createdAdjustments.push(adjustment);
    }

    return createdAdjustments;
  }

  /**
   * Get all adjustments for a creator
   * @param {string} userId
   * @param {string} [currency='USD']
   * @returns {Promise<Array<object>>}
   */
  async getUserAdjustments(userId, currency = 'USD') {
    return this.repo.getAdjustmentsByUserId(userId, currency);
  }

  /**
   * Get net adjustment amount for a creator
   * @param {string} userId
   * @param {string} [currency='USD']
   * @returns {Promise<Prisma.Decimal>}
   */
  async getNetAdjustmentAmount(userId, currency = 'USD') {
    return this.repo.getNetAdjustmentAmount(userId, currency);
  }
}

export const adjustmentService = new AdjustmentService();
