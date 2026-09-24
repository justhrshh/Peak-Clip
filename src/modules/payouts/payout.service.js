import { Prisma } from '@prisma/client';
import { payoutRepository as defaultRepo } from './payout.repository.js';
import { getDisbursementProvider as defaultProviderResolver } from '../../providers/disbursement/index.js';
import {
  validatePayoutTransition,
  isReservingStatus
} from './payout.state-machine.js';
import {
  createPayoutInputSchema,
  cancelPayoutInputSchema,
  reviewPayoutInputSchema,
  rejectPayoutInputSchema,
  disbursePayoutInputSchema
} from './payout.validation.js';
import {
  InsufficientBalanceError,
  BelowMinimumPayoutError,
  UnauthorizedPayoutAccessError,
  InactiveUserError,
  PayoutNotFoundError,
  PayoutEvidenceRequiredError,
  InvalidEvidenceError
} from './payout.errors.js';
import { AdminAuditRepository } from '../admin/audit.repository.js';
import { payoutProfileService as defaultProfileService, PayoutProfileError } from '../payout-profile/payout-profile.service.js';
import { evidenceService as defaultEvidenceService } from '../evidence/evidence.service.js';
import { logger } from '../../utils/logger.js';

export class PayoutService {
  /**
   * @param {object} [repo=defaultRepo]
   * @param {function} [providerResolver=defaultProviderResolver]
   * @param {object} [auditRepo=null]
   * @param {object} [profileService=defaultProfileService]
   * @param {object} [evidenceService=defaultEvidenceService]
   */
  constructor(
    repo = defaultRepo,
    providerResolver = defaultProviderResolver,
    auditRepo = null,
    profileService = defaultProfileService,
    evidenceService = defaultEvidenceService
  ) {
    this.repo = repo;
    this.providerResolver = providerResolver;
    this.auditRepo = auditRepo || (repo.prisma ? new AdminAuditRepository(repo.prisma) : null);
    this.profileService = profileService;
    this.evidenceService = evidenceService;
  }

  /**
   * Get creator's available payout balance and reservations
   *
   * @param {string} userId
   * @param {string} [currency='USD']
   * @returns {Promise<object>}
   */
  async getAvailablePayoutBalance(userId, currency = 'USD') {
    return this.repo.getPayoutBalanceBreakdown(userId, currency);
  }

  /**
   * Create a new creator payout request
   *
   * Atomic Transaction Guarantee:
   * 1. Validates user is active.
   * 2. Authoritatively derives available balance from the immutable ledger.
   * 3. Validates minimum payout and balance sufficiency.
   * 4. Inserts PayoutRequest and logs immutable PayoutEvent.
   * 5. Active status immediately reserves funds against subsequent requests.
   *
   * @param {string} userId
   * @param {string|number|Prisma.Decimal} amount
   * @param {string} [currency='USD']
   * @param {object} [options={}]
   * @param {object} [options.profileSnapshot]
   * @param {boolean} [options.enforceProfile]
   * @param {object} [options.evidence]
   * @returns {Promise<object>}
   */
  async createPayoutRequest(userId, amount, currency = 'USD', options = {}) {
    const validated = createPayoutInputSchema.parse({
      userId,
      amount: amount.toString(),
      currency
    });

    const requestedAmount = new Prisma.Decimal(validated.amount).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    logger.info({ userId: validated.userId, amount: requestedAmount.toFixed(2), currency: validated.currency }, 'Processing payout request');

    return this.repo.transaction(async (tx) => {
      // 0. Concurrency lock: prevent simultaneous requests from overdrawing available balance
      await this.repo.acquireUserPayoutLock?.(validated.userId, tx);

      // 1. Verify user exists and is ACTIVE
      const user = await this.repo.getUserById(validated.userId, tx);
      if (!user) {
        throw new PayoutNotFoundError(validated.userId);
      }
      if (user.status !== 'ACTIVE') {
        throw new InactiveUserError(validated.userId, user.status);
      }

      // 2. Authoritatively derive current balance & minimum payout inside transaction
      const balance = await this.repo.getPayoutBalanceBreakdown(validated.userId, validated.currency, tx);

      // 3. Minimum payout check
      if (requestedAmount.lessThan(balance.minimumPayout)) {
        throw new BelowMinimumPayoutError(
          requestedAmount.toFixed(2),
          balance.minimumPayout.toFixed(2),
          validated.currency
        );
      }

      // 4. Balance sufficiency check
      if (requestedAmount.greaterThan(balance.availableBalance)) {
        throw new InsufficientBalanceError(
          requestedAmount.toFixed(2),
          balance.availableBalance.toFixed(2),
          validated.currency
        );
      }

      // 4.5. Phase 10E: Check and snapshot Payout Profile
      let profileSnapshot = options.profileSnapshot || null;
      if (!profileSnapshot && this.profileService && typeof this.profileService.getProfileByUserId === 'function') {
        const profile = await this.profileService.getProfileByUserId(validated.userId, tx);
        const shouldEnforce = options.enforceProfile === true || (this.repo === defaultRepo && options.enforceProfile !== false);
        if (!profile && shouldEnforce) {
          throw new PayoutProfileError('A payout profile must be configured before requesting a payout.', 'PROFILE_REQUIRED');
        }
        if (profile) {
          profileSnapshot = {
            profileId: profile.id,
            walletAddress: profile.walletAddress,
            network: profile.network,
            walletName: profile.walletName,
            creatorHandle: profile.creatorHandle,
            platform: profile.platform,
            snapshottedAt: new Date().toISOString()
          };
        }
      }

      // 4.6. Phase 10H.8: Strictly enforce analytics screen recording requirement
      const shouldEnforceEvidence = options.enforceEvidence === true || (this.repo === defaultRepo && options.enforceEvidence !== false && Boolean(this.evidenceService));
      if (shouldEnforceEvidence) {
        if (!options.evidence || !options.evidence.buffer || options.evidence.buffer.length === 0) {
          throw new PayoutEvidenceRequiredError('An analytics screen recording under 40 seconds is required to submit a payout request.');
        }
      }

      // 5. Create PayoutRequest (status: REQUESTED actively reserves the amount)
      const payoutRequest = await this.repo.createPayoutRequest(
        {
          userId: validated.userId,
          amount: requestedAmount,
          currency: validated.currency,
          status: 'REQUESTED',
          profileSnapshot
        },
        tx
      );

      // 5.5. Phase 10E: Attach evidence if provided
      if (options.evidence && this.evidenceService && typeof this.evidenceService.attachEvidence === 'function') {
        await this.evidenceService.attachEvidence({
          payoutRequestId: payoutRequest.id,
          userId: validated.userId,
          platform: profileSnapshot?.platform || options.platform || 'YOUTUBE',
          buffer: options.evidence.buffer,
          filename: options.evidence.filename,
          mimeType: options.evidence.mimeType,
          clientDurationSeconds: options.evidence.durationSeconds || null
        }, tx);
      }

      // 6. Record immutable audit event
      await this.repo.recordPayoutEvent(
        {
          payoutRequestId: payoutRequest.id,
          type: 'REQUESTED',
          actorUserId: validated.userId,
          metadata: {
            requestedAmount: requestedAmount.toFixed(2),
            currency: validated.currency,
            availableBalanceBefore: balance.availableBalance.toFixed(2),
            hasProfileSnapshot: Boolean(profileSnapshot)
          }
        },
        tx
      );

      logger.info(
        { payoutRequestId: payoutRequest.id, userId: validated.userId, amount: requestedAmount.toFixed(2) },
        'Payout request successfully created and balance reserved'
      );

      return payoutRequest;
    });
  }

  /**
   * Get user's complete payout request history
   *
   * @param {string} userId
   * @returns {Promise<Array<object>>}
   */
  async getUserPayoutHistory(userId) {
    return this.repo.getUserPayoutRequests(userId);
  }

  /**
   * Creator cancels their own pending payout request (releases reservation)
   *
   * @param {string} userId
   * @param {string} payoutRequestId
   * @param {string} [reason]
   * @returns {Promise<object>}
   */
  async cancelPayoutRequest(userId, payoutRequestId, reason = null) {
    const validated = cancelPayoutInputSchema.parse({ userId, payoutRequestId, reason: reason || undefined });

    return this.repo.transaction(async (tx) => {
      // 0. Concurrency lock on user balance to prevent race conditions with disbursements/requests
      await this.repo.acquirePayoutBalanceLock?.(validated.userId, tx);

      const payout = await this.repo.getPayoutRequestById(validated.payoutRequestId, tx);
      if (!payout) {
        throw new PayoutNotFoundError(validated.payoutRequestId);
      }

      // Creator ownership enforcement
      if (payout.userId !== validated.userId) {
        throw new UnauthorizedPayoutAccessError('You can only cancel your own payout requests.');
      }

      // Validate state machine transition (disallows PROCESSING -> CANCELLED, COMPLETED -> CANCELLED, CANCELLED -> CANCELLED)
      validatePayoutTransition(payout.status, 'CANCELLED');

      const cancellationReason = validated.reason || 'Cancelled by creator';
      const cancelledAt = new Date();

      const updated = await this.repo.updatePayoutRequest(
        payout.id,
        {
          status: 'CANCELLED',
          cancelledAt,
          cancelledBy: validated.userId,
          cancellationReason,
          failureReason: cancellationReason
        },
        tx
      );

      // Record immutable payout lifecycle event
      await this.repo.recordPayoutEvent(
        {
          payoutRequestId: payout.id,
          type: 'CANCELLED',
          actorUserId: validated.userId,
          metadata: {
            reason: cancellationReason,
            releasedAmount: payout.amount?.toString ? payout.amount.toString() : String(payout.amount)
          }
        },
        tx
      );

      // Record administrative audit event
      if (this.auditRepo) {
        await this.auditRepo.recordEvent(
          {
            actorUserId: validated.userId,
            actorDiscordId: payout.user?.discordId || 'UNKNOWN',
            action: 'PAYOUT_CANCEL',
            entityType: 'PAYOUT',
            entityId: payout.id,
            previousState: { status: payout.status },
            newState: { status: 'CANCELLED', cancelledAt, reason: cancellationReason },
            reason: cancellationReason
          },
          tx
        );
      }

      logger.info(
        { payoutRequestId: payout.id, userId: validated.userId, releasedAmount: payout.amount },
        'Payout request cancelled and reservation released'
      );
      return updated;
    });
  }

  // ==========================================
  // STAFF / ADMIN REVIEW & DISBURSEMENT LAYER
  // ==========================================

  /**
   * List payout requests for staff review
   * @param {object} [filter={}]
   * @returns {Promise<Array<object>>}
   */
  async listPayoutRequests(filter = {}) {
    return this.repo.listPayoutRequests(filter);
  }

  /**
   * Move payout request to UNDER_REVIEW
   * @param {string} payoutRequestId
   * @param {string} reviewerUserId
   * @param {string} [notes]
   * @returns {Promise<object>}
   */
  async reviewPayoutRequest(payoutRequestId, reviewerUserId, notes = null) {
    const validated = reviewPayoutInputSchema.parse({ payoutRequestId, reviewerUserId, notes: notes || undefined });

    return this.repo.transaction(async (tx) => {
      const payout = await this.repo.getPayoutRequestById(validated.payoutRequestId, tx);
      if (!payout) throw new PayoutNotFoundError(validated.payoutRequestId);

      validatePayoutTransition(payout.status, 'UNDER_REVIEW');

      const updated = await this.repo.updatePayoutRequest(
        payout.id,
        {
          status: 'UNDER_REVIEW',
          reviewedAt: new Date(),
          reviewedBy: validated.reviewerUserId
        },
        tx
      );

      await this.repo.recordPayoutEvent(
        {
          payoutRequestId: payout.id,
          type: 'UNDER_REVIEW',
          actorUserId: validated.reviewerUserId,
          metadata: { notes: validated.notes }
        },
        tx
      );

      return updated;
    });
  }

  /**
   * Approve payout request
   * @param {string} payoutRequestId
   * @param {string} reviewerUserId
   * @returns {Promise<object>}
   */
  async approvePayoutRequest(payoutRequestId, reviewerUserId) {
    const validated = reviewPayoutInputSchema.parse({ payoutRequestId, reviewerUserId });

    return this.repo.transaction(async (tx) => {
      const payout = await this.repo.getPayoutRequestById(validated.payoutRequestId, tx);
      if (!payout) throw new PayoutNotFoundError(validated.payoutRequestId);

      validatePayoutTransition(payout.status, 'APPROVED');

      const updated = await this.repo.updatePayoutRequest(
        payout.id,
        {
          status: 'APPROVED',
          reviewedAt: new Date(),
          reviewedBy: validated.reviewerUserId
        },
        tx
      );

      await this.repo.recordPayoutEvent(
        {
          payoutRequestId: payout.id,
          type: 'APPROVED',
          actorUserId: validated.reviewerUserId
        },
        tx
      );

      logger.info({ payoutRequestId: payout.id, reviewerUserId }, 'Payout request approved');
      return updated;
    });
  }

  /**
   * Reject payout request (releases balance reservation)
   * @param {string} payoutRequestId
   * @param {string} reviewerUserId
   * @param {string} rejectionReason
   * @returns {Promise<object>}
   */
  async rejectPayoutRequest(payoutRequestId, reviewerUserId, rejectionReason) {
    const validated = rejectPayoutInputSchema.parse({ payoutRequestId, reviewerUserId, rejectionReason });

    return this.repo.transaction(async (tx) => {
      const payout = await this.repo.getPayoutRequestById(validated.payoutRequestId, tx);
      if (!payout) throw new PayoutNotFoundError(validated.payoutRequestId);

      validatePayoutTransition(payout.status, 'REJECTED');

      const updated = await this.repo.updatePayoutRequest(
        payout.id,
        {
          status: 'REJECTED',
          reviewedAt: new Date(),
          reviewedBy: validated.reviewerUserId,
          rejectionReason: validated.rejectionReason
        },
        tx
      );

      await this.repo.recordPayoutEvent(
        {
          payoutRequestId: payout.id,
          type: 'REJECTED',
          actorUserId: validated.reviewerUserId,
          metadata: { rejectionReason: validated.rejectionReason }
        },
        tx
      );

      logger.info({ payoutRequestId: payout.id, reviewerUserId, rejectionReason }, 'Payout request rejected');
      return updated;
    });
  }

  /**
   * Process disbursement through the pluggable disbursement provider
   * Transitions payout to PROCESSING
   *
   * @param {string} payoutRequestId
   * @param {string} [providerName='MANUAL']
   * @param {object} [options={}]
   * @param {boolean} [options.skipGate=false]
   * @param {boolean} [options.enforceGate=false]
   * @returns {Promise<object>}
   */
  async processDisbursement(payoutRequestId, providerName = 'MANUAL', options = {}) {
    const validated = disbursePayoutInputSchema.parse({ payoutRequestId, provider: providerName });

    return this.repo.transaction(async (tx) => {
      // 0. Concurrency lock: prevent simultaneous disbursement processing
      await this.repo.acquirePayoutRequestLock?.(validated.payoutRequestId, tx);

      const payout = await this.repo.getPayoutRequestById(validated.payoutRequestId, tx);
      if (!payout) throw new PayoutNotFoundError(validated.payoutRequestId);

      validatePayoutTransition(payout.status, 'PROCESSING');

      // Phase 10E: Payout Approval Gate Check
      const shouldEnforceGate = options.skipGate !== true && (this.repo === defaultRepo || options.enforceGate === true);
      if (shouldEnforceGate) {
        if (!payout.profileSnapshot) {
          throw new Error('Payout cannot proceed to processing: missing required payout profile snapshot.');
        }

        const evidenceList = payout.evidence || (this.evidenceService ? await this.evidenceService.getEvidenceForPayout(payout.id) : []);
        if (!evidenceList || evidenceList.length === 0) {
          throw new Error('Payout cannot proceed to processing: no verification evidence has been submitted.');
        }

        const latestEvidence = evidenceList[0];
        if (latestEvidence.status !== 'ACCEPTED') {
          throw new Error(`Payout cannot proceed to processing: attached evidence is in '${latestEvidence.status}' status. Staff must accept evidence before disbursement.`);
        }
      }

      const provider = this.providerResolver(validated.provider);
      const disbursementRes = await provider.createDisbursement({
        payoutRequestId: payout.id,
        amount: payout.amount,
        currency: payout.currency
      });

      // Update payout request status
      const updatedPayout = await this.repo.updatePayoutRequest(
        payout.id,
        {
          status: 'PROCESSING',
          processingAt: new Date()
        },
        tx
      );

      // Create disbursement record
      const disbursement = await this.repo.createDisbursement(
        {
          payoutRequestId: payout.id,
          provider: provider.name,
          providerReference: disbursementRes.providerReference,
          amount: payout.amount,
          currency: payout.currency,
          status: disbursementRes.status || 'PROCESSING',
          attemptedAt: new Date(),
          metadata: disbursementRes.metadata || {}
        },
        tx
      );

      await this.repo.recordPayoutEvent(
        {
          payoutRequestId: payout.id,
          type: 'PROCESSING',
          metadata: {
            provider: provider.name,
            providerReference: disbursementRes.providerReference,
            disbursementId: disbursement.id
          }
        },
        tx
      );

      return {
        payoutRequest: updatedPayout,
        disbursement
      };
    });
  }

  /**
   * Complete disbursement (permanently consumes balance)
   *
   * @param {string} payoutRequestId
   * @param {string} [providerReference]
   * @returns {Promise<object>}
   */
  async markDisbursementCompleted(payoutRequestId, providerReference = null) {
    return this.repo.transaction(async (tx) => {
      const payout = await this.repo.getPayoutRequestById(payoutRequestId, tx);
      if (!payout) throw new PayoutNotFoundError(payoutRequestId);

      validatePayoutTransition(payout.status, 'COMPLETED');

      const now = new Date();

      // Update active disbursement record if exists
      const activeDisbursement = payout.disbursements?.[0];
      if (activeDisbursement) {
        await this.repo.updateDisbursement(
          activeDisbursement.id,
          {
            status: 'COMPLETED',
            completedAt: now,
            providerReference: providerReference || activeDisbursement.providerReference
          },
          tx
        );
      }

      // Update payout request to COMPLETED
      const updatedPayout = await this.repo.updatePayoutRequest(
        payout.id,
        {
          status: 'COMPLETED',
          completedAt: now
        },
        tx
      );

      await this.repo.recordPayoutEvent(
        {
          payoutRequestId: payout.id,
          type: 'COMPLETED',
          metadata: {
            completedAt: now.toISOString(),
            providerReference: providerReference || activeDisbursement?.providerReference
          }
        },
        tx
      );

      logger.info({ payoutRequestId: payout.id, amount: payout.amount.toString() }, 'Payout successfully completed');
      return updatedPayout;
    });
  }

  /**
   * Fail disbursement (releases balance reservation, allowing retry)
   *
   * @param {string} payoutRequestId
   * @param {string} failureReason
   * @returns {Promise<object>}
   */
  async markDisbursementFailed(payoutRequestId, failureReason) {
    return this.repo.transaction(async (tx) => {
      const payout = await this.repo.getPayoutRequestById(payoutRequestId, tx);
      if (!payout) throw new PayoutNotFoundError(payoutRequestId);

      validatePayoutTransition(payout.status, 'FAILED');

      const activeDisbursement = payout.disbursements?.[0];
      if (activeDisbursement) {
        await this.repo.updateDisbursement(
          activeDisbursement.id,
          {
            status: 'FAILED',
            failureReason
          },
          tx
        );
      }

      const updatedPayout = await this.repo.updatePayoutRequest(
        payout.id,
        {
          status: 'FAILED',
          failureReason
        },
        tx
      );

      await this.repo.recordPayoutEvent(
        {
          payoutRequestId: payout.id,
          type: 'FAILED',
          metadata: { failureReason }
        },
        tx
      );

      logger.warn({ payoutRequestId: payout.id, failureReason }, 'Payout disbursement failed; reservation released');
      return updatedPayout;
    });
  }
}

export const payoutService = new PayoutService();
export default payoutService;
