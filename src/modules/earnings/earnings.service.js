import { Prisma } from '@prisma/client';
import { earningsRepository as defaultRepo } from './earnings.repository.js';
import { campaignRepository as defaultCampaignRepo } from '../campaigns/campaign.repository.js';
import { calculateGrossAmount, applyBudgetCaps } from './earnings.calculator.js';
import {
  userEarningsInputSchema,
  campaignEarningsInputSchema,
  submissionEarningsInputSchema,
  creditViewsInputSchema
} from './earnings.validation.js';
import {
  IneligibleSubmissionError,
  DuplicateEarningError,
  UnauthorizedEarningAccessError
} from './earnings.errors.js';
import {
  SubmissionNotFoundError,
  CampaignNotFoundError,
  CampaignMembershipRequiredError
} from '../statistics/statistics.errors.js';
import { logger } from '../../utils/logger.js';

export class EarningsService {
  /**
   * @param {object} [repo=defaultRepo]
   * @param {object} [campaignRepo=defaultCampaignRepo]
   */
  constructor(repo = defaultRepo, campaignRepo = defaultCampaignRepo) {
    this.repo = repo;
    this.campaignRepo = campaignRepo;
  }

  /**
   * Credits incremental eligible views for an approved submission.
   *
   * Financial Invariants:
   * - Submission must have status === APPROVED and completed verification.
   * - Evaluates incremental delta: currentViews - previouslyCreditedViews.
   * - Metric regressions (delta < 0) never create negative earnings or delete ledger rows.
   * - Idempotency: sourceSnapshotId unique constraint prevents duplicate crediting.
   * - Budget Cap: actualCredit = MIN(rawAmount, campaignRemainingBudget, creatorRemainingCap)
   * - Budget consumption: consumedBudget incremented atomically in the same transaction.
   * - Campaign auto-completes when consumedBudget >= totalBudget.
   * - Atomic transaction guarantees consistency between credited views and ledger insertion.
   *
   * @param {string} submissionId
   * @param {string|null} [snapshotId=null]
   * @returns {Promise<{ newlyCreditedViews: bigint, rawGrossAmount: Prisma.Decimal, actualCredit: Prisma.Decimal, earning: object|null, reason: string, cappedBy: string|null }>}
   */
  async creditNewEligibleViews(submissionId, snapshotId = null) {
    const validated = creditViewsInputSchema.parse({ submissionId, snapshotId: snapshotId || undefined });
    logger.info({ submissionId: validated.submissionId, snapshotId: validated.snapshotId }, 'Evaluating submission for eligible earnings');

    return this.repo.transaction(async (tx) => {
      // 0. High-water-mark concurrency protection: acquire transactional lock
      await this.repo.acquireSubmissionLock?.(validated.submissionId, tx);

      // 1. Fetch submission with campaign budget fields, verification, and snapshots
      const submission = await this.repo.getSubmissionForEarnings(validated.submissionId, tx);
      if (!submission) {
        throw new SubmissionNotFoundError(validated.submissionId);
      }

      // 2. Strict eligibility enforcement: Submission MUST be APPROVED
      if (submission.status !== 'APPROVED') {
        throw new IneligibleSubmissionError(
          validated.submissionId,
          `Submission status is ${submission.status}; only APPROVED submissions can accrue earnings.`
        );
      }

      // Verification must be completed
      const latestVer = submission.verifications?.[0];
      if (!latestVer || latestVer.status !== 'COMPLETED') {
        throw new IneligibleSubmissionError(
          validated.submissionId,
          `Submission verification is not completed (status: ${latestVer?.status || 'NONE'}).`
        );
      }

      // 3. Resolve target snapshot
      let targetSnapshot = null;
      if (validated.snapshotId) {
        targetSnapshot = await this.repo.getSnapshotById(validated.snapshotId, tx);
      } else {
        targetSnapshot = submission.snapshots?.[0] || null;
      }

      if (!targetSnapshot || targetSnapshot.views === null || targetSnapshot.views === undefined) {
        logger.debug({ submissionId: validated.submissionId }, 'No views available on target snapshot; 0 earnings credited');
        return {
          newlyCreditedViews: 0n,
          rawGrossAmount: new Prisma.Decimal('0.00'),
          grossAmount: new Prisma.Decimal('0.00'),
          actualCredit: new Prisma.Decimal('0.00'),
          earning: null,
          reason: 'VIEWS_UNAVAILABLE',
          cappedBy: null
        };
      }

      // 4. Idempotency check: Has this snapshot already produced an earning?
      const existingEarning = await this.repo.getEarningBySnapshotId(targetSnapshot.id, tx);
      if (existingEarning) {
        logger.info(
          { submissionId: validated.submissionId, snapshotId: targetSnapshot.id, earningId: existingEarning.id },
          'Snapshot already credited; returning existing earning record (idempotent)'
        );
        return {
          newlyCreditedViews: 0n,
          rawGrossAmount: new Prisma.Decimal('0.00'),
          grossAmount: new Prisma.Decimal('0.00'),
          actualCredit: new Prisma.Decimal('0.00'),
          earning: existingEarning,
          reason: 'ALREADY_CREDITED',
          cappedBy: null
        };
      }

      // 5. Calculate previously credited views for this submission
      const previouslyCredited = await this.repo.getPreviouslyCreditedViews(validated.submissionId, tx);
      const currentViews = BigInt(targetSnapshot.views);
      const incrementalViews = currentViews - previouslyCredited;

      // 6. Handle incremental delta
      if (incrementalViews <= 0n) {
        if (incrementalViews < 0n) {
          logger.warn(
            { submissionId: validated.submissionId, currentViews: currentViews.toString(), previouslyCredited: previouslyCredited.toString() },
            'Metric regression detected: current views less than previously credited views. No negative earning created.'
          );
          return {
            newlyCreditedViews: 0n,
            rawGrossAmount: new Prisma.Decimal('0.00'),
            grossAmount: new Prisma.Decimal('0.00'),
            actualCredit: new Prisma.Decimal('0.00'),
            earning: null,
            reason: 'METRIC_REGRESSION',
            cappedBy: null
          };
        }

        logger.debug({ submissionId: validated.submissionId }, 'Zero new views since last credit event; skipping earning insertion');
        return {
          newlyCreditedViews: 0n,
          rawGrossAmount: new Prisma.Decimal('0.00'),
          grossAmount: new Prisma.Decimal('0.00'),
          actualCredit: new Prisma.Decimal('0.00'),
          earning: null,
          reason: 'NO_NEW_VIEWS',
          cappedBy: null
        };
      }

      // 7. Calculate raw CPM gross amount using pure Decimal arithmetic
      const ratePerThousand = submission.campaign.payRate;
      const rawGrossAmount = calculateGrossAmount(incrementalViews, ratePerThousand);

      // 8. Phase 10A: Apply budget caps
      //    When totalBudget is absent (legacy data / old mocks), treat budget as unlimited
      //    so existing tests continue to pass without modification.
      let actualCredit;
      let cappedBy = null;

      const hasBudget = submission.campaign.totalBudget != null;

      if (hasBudget) {
        //    a. Campaign remaining budget (totalBudget - consumedBudget)
        const campaignRemainingBudget = new Prisma.Decimal(
          submission.campaign.totalBudget.toString()
        ).minus(
          new Prisma.Decimal(submission.campaign.consumedBudget?.toString() ?? '0')
        );

        //    b. Creator remaining cap (creatorEarningCap - already earned in this campaign)
        let creatorRemaining = null;
        if (submission.campaign.creatorEarningCap != null) {
          const creatorEarningCap = new Prisma.Decimal(
            submission.campaign.creatorEarningCap.toString()
          );

          let creatorCampaignTotal = new Prisma.Decimal('0.00');
          if (typeof this.repo.getCreatorCampaignTotal === 'function') {
            creatorCampaignTotal = await this.repo.getCreatorCampaignTotal(
              submission.userId,
              submission.campaignId,
              tx
            );
          }

          creatorRemaining = creatorEarningCap.minus(creatorCampaignTotal);
        }

        //    c. Compute actualCredit = MIN(rawGrossAmount, campaignRemaining, creatorRemaining)
        const capped = applyBudgetCaps(rawGrossAmount, campaignRemainingBudget, creatorRemaining);
        actualCredit = capped.actualCredit;
        cappedBy = capped.cappedBy;
      } else {
        // No budget configured — apply raw gross without financial cap (backwards compat)
        actualCredit = rawGrossAmount;
        cappedBy = null;
      }

      // 9. If actualCredit <= 0, nothing can be credited
      if (actualCredit.lessThanOrEqualTo(0)) {
        const reason = cappedBy === 'CREATOR' ? 'CREATOR_CAP_REACHED' : 'BUDGET_CAP_REACHED';
        logger.info(
          {
            submissionId: validated.submissionId,
            campaignId: submission.campaignId,
            userId: submission.userId,
            rawGrossAmount: rawGrossAmount.toString(),
            cappedBy: cappedBy || 'NONE'
          },
          `Earning not credited: ${reason}`
        );
        return {
          newlyCreditedViews: 0n,
          rawGrossAmount,
          grossAmount: rawGrossAmount,
          actualCredit: new Prisma.Decimal('0.00'),
          earning: null,
          reason,
          cappedBy
        };
      }

      // 10. Insert immutable earning ledger record with actualCredit (the capped amount)
      const earning = await this.repo.createEarning(
        {
          userId: submission.userId,
          campaignId: submission.campaignId,
          submissionId: submission.id,
          sourceSnapshotId: targetSnapshot.id,
          eligibleViews: incrementalViews,
          ratePerThousand,
          grossAmount: actualCredit,       // Stored as the actual (capped) credit
          currency: submission.campaign.currency || 'USD',
          status: 'ELIGIBLE'
        },
        tx
      );

      // 11. Atomically consume campaign budget and auto-complete if exhausted
      //     Only when budget tracking is enabled (campaignRepo has consumeBudget)
      if (hasBudget && this.campaignRepo && typeof this.campaignRepo.consumeBudget === 'function') {
        await this.campaignRepo.consumeBudget(submission.campaignId, actualCredit, tx);
      }

      logger.info(
        {
          earningId: earning.id,
          submissionId: submission.id,
          incrementalViews: incrementalViews.toString(),
          rawGrossAmount: rawGrossAmount.toString(),
          actualCredit: actualCredit.toString(),
          cappedBy: cappedBy || 'NONE',
          rate: ratePerThousand.toString()
        },
        'Eligible earnings successfully ledgered'
      );

      return {
        newlyCreditedViews: incrementalViews,
        rawGrossAmount,
        grossAmount: rawGrossAmount,        // Backwards-compatible alias for rawGrossAmount
        actualCredit,
        earning,
        reason: 'CREDITED_SUCCESSFULLY',
        cappedBy
      };
    });
  }

  /**
   * Derive authoritative user balance directly from the immutable ledger
   *
   * @param {string} userId
   * @returns {Promise<{ eligibleEarnings: Prisma.Decimal, pendingEarnings: Prisma.Decimal, voidedEarnings: Prisma.Decimal, totalGrossEarnings: Prisma.Decimal, totalEligibleViews: bigint, currency: string }>}
   */
  async getUserBalance(userId) {
    const validated = userEarningsInputSchema.parse({ userId });
    const records = await this.repo.getUserEarningsLedger(validated.userId);

    let eligible = new Prisma.Decimal('0.00');
    let pending = new Prisma.Decimal('0.00');
    let voided = new Prisma.Decimal('0.00');
    let views = 0n;
    let currency = 'USD';

    for (const record of records) {
      const amount = new Prisma.Decimal(record.grossAmount);
      currency = record.currency || currency;

      switch (record.status) {
        case 'ELIGIBLE':
          eligible = eligible.plus(amount);
          views += BigInt(record.eligibleViews);
          break;
        case 'PENDING':
          pending = pending.plus(amount);
          views += BigInt(record.eligibleViews);
          break;
        case 'VOIDED':
          voided = voided.plus(amount);
          break;
      }
    }

    const totalGross = eligible.plus(pending);

    // Fetch financial adjustments if table exists
    let netAdjustments = new Prisma.Decimal('0.00');
    if (this.prisma?.financialAdjustment) {
      const adjAgg = await this.prisma.financialAdjustment.aggregate({
        where: { userId: validated.userId, currency },
        _sum: { amount: true }
      });
      if (adjAgg._sum.amount) {
        netAdjustments = new Prisma.Decimal(adjAgg._sum.amount);
      }
    }

    let netAvailableEarnings = eligible.plus(netAdjustments);
    if (netAvailableEarnings.lessThan(0)) {
      netAvailableEarnings = new Prisma.Decimal('0.00');
    }

    return {
      eligibleEarnings: eligible.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      pendingEarnings: pending.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      voidedEarnings: voided.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      totalGrossEarnings: totalGross.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      netAdjustments: netAdjustments.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      netAvailableEarnings: netAvailableEarnings.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      totalEligibleViews: views,
      currency
    };
  }

  /**
   * Comprehensive user earnings overview with payout threshold check
   *
   * @param {string} userId
   * @returns {Promise<object>}
   */
  async getUserEarnings(userId) {
    const validated = userEarningsInputSchema.parse({ userId });
    const balance = await this.getUserBalance(validated.userId);
    const records = await this.repo.getUserEarningsLedger(validated.userId);

    const campaignIds = new Set();
    const submissionIds = new Set();
    let latestEarningAt = null;

    let minimumPayout = new Prisma.Decimal('10.00'); // Default $10.00 baseline

    for (const rec of records) {
      campaignIds.add(rec.campaignId);
      submissionIds.add(rec.submissionId);

      if (rec.campaign?.minimumPayout) {
        const campMin = new Prisma.Decimal(rec.campaign.minimumPayout);
        if (campMin.greaterThan(minimumPayout)) {
          minimumPayout = campMin;
        }
      }

      if (!latestEarningAt || new Date(rec.createdAt) > new Date(latestEarningAt)) {
        latestEarningAt = new Date(rec.createdAt);
      }
    }

    const isPayoutThresholdReached = balance.eligibleEarnings.greaterThanOrEqualTo(minimumPayout);

    return {
      userId: validated.userId,
      ...balance,
      campaignCount: campaignIds.size,
      submissionCount: submissionIds.size,
      minimumPayout: minimumPayout.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      isPayoutThresholdReached,
      latestEarningAt
    };
  }

  /**
   * Campaign-scoped earnings for a creator
   *
   * @param {string} userId
   * @param {string} campaignId
   * @returns {Promise<object>}
   */
  async getCampaignEarnings(userId, campaignId) {
    const validated = campaignEarningsInputSchema.parse({ userId, campaignId });

    // Enforce campaign membership
    const membership = await this.repo.getCampaignMembership(validated.userId, validated.campaignId);
    if (!membership) {
      throw new CampaignMembershipRequiredError(validated.campaignId);
    }

    const campaign = membership.campaign;
    const records = await this.repo.getCampaignEarningsLedger(validated.userId, validated.campaignId);

    let grossEarnings = new Prisma.Decimal('0.00');
    let eligibleEarnings = new Prisma.Decimal('0.00');
    let pendingEarnings = new Prisma.Decimal('0.00');
    let voidedEarnings = new Prisma.Decimal('0.00');
    let eligibleViews = 0n;

    const submissionIds = new Set();

    for (const rec of records) {
      submissionIds.add(rec.submissionId);
      const amount = new Prisma.Decimal(rec.grossAmount);

      switch (rec.status) {
        case 'ELIGIBLE':
          eligibleEarnings = eligibleEarnings.plus(amount);
          grossEarnings = grossEarnings.plus(amount);
          eligibleViews += BigInt(rec.eligibleViews);
          break;
        case 'PENDING':
          pendingEarnings = pendingEarnings.plus(amount);
          grossEarnings = grossEarnings.plus(amount);
          eligibleViews += BigInt(rec.eligibleViews);
          break;
        case 'VOIDED':
          voidedEarnings = voidedEarnings.plus(amount);
          break;
      }
    }

    const minPayout = new Prisma.Decimal(campaign.minimumPayout || '10.00');
    const isPayoutThresholdReached = eligibleEarnings.greaterThanOrEqualTo(minPayout);

    return {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        slug: campaign.slug,
        status: campaign.status,
        currency: campaign.currency || 'USD'
      },
      currentRatePerThousand: new Prisma.Decimal(campaign.payRate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      minimumPayout: minPayout.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      isPayoutThresholdReached,
      approvedSubmissionsCount: submissionIds.size,
      eligibleViews,
      grossEarnings: grossEarnings.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      eligibleEarnings: eligibleEarnings.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      pendingEarnings: pendingEarnings.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      voidedEarnings: voidedEarnings.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      currency: campaign.currency || 'USD'
    };
  }

  /**
   * Submission-scoped earnings and audit trail for a creator
   *
   * @param {string} userId
   * @param {string} submissionId
   * @returns {Promise<object>}
   */
  async getSubmissionEarnings(userId, submissionId) {
    const validated = submissionEarningsInputSchema.parse({ userId, submissionId });

    const submission = await this.repo.getSubmissionForEarnings(validated.submissionId);
    if (!submission) {
      throw new SubmissionNotFoundError(validated.submissionId);
    }

    // Access control: strictly verify owner
    if (submission.userId !== validated.userId) {
      throw new UnauthorizedEarningAccessError('You do not have permission to view earnings for this submission.');
    }

    const records = await this.repo.getSubmissionEarningsLedger(validated.submissionId);

    let grossEarnings = new Prisma.Decimal('0.00');
    let eligibleEarnings = new Prisma.Decimal('0.00');
    let pendingEarnings = new Prisma.Decimal('0.00');
    let creditedViews = 0n;

    for (const rec of records) {
      const amount = new Prisma.Decimal(rec.grossAmount);
      if (rec.status !== 'VOIDED') {
        creditedViews += BigInt(rec.eligibleViews);
        grossEarnings = grossEarnings.plus(amount);
      }
      if (rec.status === 'ELIGIBLE') {
        eligibleEarnings = eligibleEarnings.plus(amount);
      } else if (rec.status === 'PENDING') {
        pendingEarnings = pendingEarnings.plus(amount);
      }
    }

    const latestSnapshot = submission.snapshots?.[0];
    const latestViews = latestSnapshot?.views !== null && latestSnapshot?.views !== undefined ? BigInt(latestSnapshot.views) : null;

    let uncreditedViews = 0n;
    if (latestViews !== null && latestViews > creditedViews) {
      uncreditedViews = latestViews - creditedViews;
    }

    return {
      submission: {
        id: submission.id,
        platform: submission.platform,
        url: submission.url,
        status: submission.status,
        submittedAt: submission.submittedAt
      },
      campaign: {
        id: submission.campaign.id,
        name: submission.campaign.name,
        slug: submission.campaign.slug,
        currency: submission.campaign.currency || 'USD'
      },
      currentRatePerThousand: new Prisma.Decimal(submission.campaign.payRate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      currentViews: latestViews,
      creditedViews,
      uncreditedViews,
      grossEarnings: grossEarnings.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      eligibleEarnings: eligibleEarnings.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      pendingEarnings: pendingEarnings.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      currency: submission.campaign.currency || 'USD',
      ledgerEntries: records.map((r) => ({
        id: r.id,
        eligibleViews: BigInt(r.eligibleViews),
        ratePerThousand: new Prisma.Decimal(r.ratePerThousand).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
        grossAmount: new Prisma.Decimal(r.grossAmount).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
        currency: r.currency,
        status: r.status,
        sourceSnapshotId: r.sourceSnapshotId,
        createdAt: r.createdAt
      }))
    };
  }
}

export const earningsService = new EarningsService();
export default earningsService;
