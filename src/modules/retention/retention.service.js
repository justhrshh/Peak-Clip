import { prisma } from '../../database/client.js';
import { getPlatformProvider } from '../../providers/index.js';
import { parseAndNormalizeUrl } from '../submissions/url.parser.js';
import { adjustmentService as defaultAdjustmentService } from '../adjustments/adjustment.service.js';
import { AdminAuditRepository } from '../admin/audit.repository.js';
import { notifyRetentionViolation } from '../../bot/notifications/creator.notifications.js';
import { notifyStaffEarlyDeletion } from '../../bot/notifications/staff.notifications.js';
import {
  PermanentContentError,
  TransientProviderError,
  ConfigurationAuthError
} from '../verification/verification.errors.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

export class RetentionService {
  constructor(
    dbClient = prisma,
    adjustmentService = defaultAdjustmentService,
    auditRepo = new AdminAuditRepository(dbClient),
    providerResolver = getPlatformProvider,
    options = {}
  ) {
    this.prisma = dbClient;
    this.adjustmentService = adjustmentService;
    this.auditRepo = auditRepo;
    this.providerResolver = providerResolver;
    this.options = options;
    this._inMemoryStrikes = new Map();
  }

  /**
   * Get consecutive failure strike count for a submission
   * @param {string} submissionId
   * @returns {Promise<number>}
   */
  async getStrikes(submissionId) {
    if (this.prisma?.systemSetting?.findUnique) {
      try {
        const row = await this.prisma.systemSetting.findUnique({
          where: { key: `retention_strikes:${submissionId}` }
        });
        if (row?.value) {
          const count = parseInt(row.value, 10);
          return isNaN(count) ? 0 : count;
        }
      } catch (err) {
        logger.warn({ submissionId, err: err.message }, 'Failed to read retention strikes from systemSetting');
      }
    }
    return this._inMemoryStrikes.get(submissionId) || 0;
  }

  /**
   * Record consecutive failure strike count
   * @param {string} submissionId
   * @param {number} strikes
   */
  async _setStrikes(submissionId, strikes) {
    this._inMemoryStrikes.set(submissionId, strikes);
    if (this.prisma?.systemSetting?.upsert) {
      try {
        await this.prisma.systemSetting.upsert({
          where: { key: `retention_strikes:${submissionId}` },
          create: { key: `retention_strikes:${submissionId}`, value: String(strikes) },
          update: { value: String(strikes) }
        });
      } catch (err) {
        logger.warn({ submissionId, err: err.message }, 'Failed to persist retention strikes to systemSetting');
      }
    }
  }

  /**
   * Reset consecutive failure strike count
   * @param {string} submissionId
   */
  async _resetStrikes(submissionId) {
    this._inMemoryStrikes.delete(submissionId);
    if (this.prisma?.systemSetting?.delete) {
      try {
        await this.prisma.systemSetting.delete({
          where: { key: `retention_strikes:${submissionId}` }
        }).catch(() => {});
      } catch (err) {
        // Ignore deletion errors
      }
    }
  }

  /**
   * Evaluate and monitor retention status for a submission
   *
   * Business Rules:
   * - Only processes submissions with retentionRequired = true and retentionStatus = ACTIVE.
   * - ACTIVE -> FULFILLED: when now >= retentionDeadline AND content remains available.
   * - ACTIVE -> VIOLATED: when content is confirmed deleted/private before retentionDeadline.
   * - DATA_UNAVAILABLE from boundary provider is NEVER treated as deletion.
   * - VIOLATED triggers auditable financial adjustment without mutating original earnings.
   * - Transitions from terminal states (FULFILLED, VIOLATED) are strictly rejected.
   *
   * @param {string} submissionId
   * @param {object} [options={}]
   * @param {Date} [options.now=new Date()]
   * @returns {Promise<object>} Result of the retention evaluation
   */
  async checkSubmissionRetention(submissionId, options = {}) {
    const now = options.now || new Date();

    // 1. Fetch submission with campaign and user relations
    const submission = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      include: {
        campaign: true,
        user: true,
        earnings: true
      }
    });

    if (!submission) {
      logger.warn({ submissionId }, 'Retention check aborted: submission not found');
      return { status: 'NOT_FOUND' };
    }

    // 2. State guards
    if (!submission.retentionRequired || submission.retentionStatus === 'NOT_REQUIRED') {
      logger.debug({ submissionId }, 'Retention not required for submission');
      return { status: 'NOT_REQUIRED' };
    }

    if (submission.retentionStatus === 'FULFILLED') {
      logger.debug({ submissionId }, 'Submission retention is already FULFILLED (terminal state)');
      return { status: 'FULFILLED', alreadyTerminal: true };
    }

    if (submission.retentionStatus === 'VIOLATED') {
      logger.debug({ submissionId }, 'Submission retention is already VIOLATED (terminal state)');
      return { status: 'VIOLATED', alreadyTerminal: true };
    }

    if (submission.retentionStatus !== 'ACTIVE') {
      logger.debug({ submissionId, retentionStatus: submission.retentionStatus }, 'Submission not in ACTIVE retention monitoring');
      return { status: submission.retentionStatus };
    }

    const requiredStrikes = options.deletionStrikes ?? options.requiredStrikes ?? this.options?.deletionStrikes ?? config?.retention?.deletionStrikesRequired ?? 3;

    // 3. Resolve platform provider and video identity
    const provider = this.providerResolver(submission.platform);
    const parsed = parseAndNormalizeUrl(submission.url);
    const contentId = parsed.videoId || parsed.cleanUrl;

    let availabilityRes;
    try {
      availabilityRes = await provider.getAvailability(contentId);
    } catch (err) {
      // 4A. Permanent deletion or private video detected
      if (err instanceof PermanentContentError) {
        logger.warn({ submissionId, reason: err.message }, 'Video definitively unavailable/deleted during retention check');
        const currentStrikes = (await this.getStrikes(submissionId)) + 1;
        await this._setStrikes(submissionId, currentStrikes);

        if (currentStrikes >= requiredStrikes) {
          await this._resetStrikes(submissionId);
          return this._transitionToViolated(submission, err.message, now);
        }

        logger.warn(
          { submissionId, currentStrikes, requiredStrikes },
          `Retention strike recorded (${currentStrikes}/${requiredStrikes}); penalty deferred until threshold reached`
        );

        await this.prisma.submission.update({
          where: { id: submissionId },
          data: {
            lastAvailabilityStatus: 'UNAVAILABLE'
          }
        });

        return {
          status: 'ACTIVE',
          retentionStatus: 'ACTIVE',
          strikes: currentStrikes,
          requiredStrikes,
          reason: err.message
        };
      }

      // 4B. Transient error -> re-throw to allow BullMQ retry/backoff (no strike recorded)
      if (err instanceof TransientProviderError) {
        logger.warn({ submissionId, err: err.message }, 'Transient error during retention check; will retry');
        throw err;
      }

      // 4C. Configuration or auth error -> do not penalize creator (no strike recorded)
      if (err instanceof ConfigurationAuthError) {
        logger.error({ submissionId, err: err.message }, 'Provider configuration error during retention check');
        await this.prisma.submission.update({
          where: { id: submissionId },
          data: {
            lastAvailabilityStatus: 'AUTH_ERROR'
          }
        });
        return { status: 'ACTIVE', reason: 'PROVIDER_AUTH_ERROR' };
      }

      throw err;
    }

    // 5. Handle provider availability response
    // 5A. Boundary providers returning DATA_UNAVAILABLE: NEVER treat as deletion (no strike recorded)
    if (availabilityRes.status === 'DATA_UNAVAILABLE') {
      logger.info({ submissionId, platform: submission.platform }, 'Platform metrics/availability DATA_UNAVAILABLE; maintaining ACTIVE status');
      await this.prisma.submission.update({
        where: { id: submissionId },
        data: {
          lastAvailabilityStatus: 'DATA_UNAVAILABLE'
        }
      });
      return { status: 'ACTIVE', availability: 'DATA_UNAVAILABLE' };
    }

    // 5B. Content definitively unavailable
    if (availabilityRes.isAvailable === false || availabilityRes.status === 'UNAVAILABLE') {
      const reason = availabilityRes.reason || 'Video unavailable/deleted before retention deadline';
      const currentStrikes = (await this.getStrikes(submissionId)) + 1;
      await this._setStrikes(submissionId, currentStrikes);

      if (currentStrikes >= requiredStrikes) {
        await this._resetStrikes(submissionId);
        return this._transitionToViolated(submission, reason, now);
      }

      logger.warn(
        { submissionId, currentStrikes, requiredStrikes },
        `Retention strike recorded (${currentStrikes}/${requiredStrikes}); penalty deferred until threshold reached`
      );

      await this.prisma.submission.update({
        where: { id: submissionId },
        data: {
          lastAvailabilityStatus: 'UNAVAILABLE'
        }
      });

      return {
        status: 'ACTIVE',
        retentionStatus: 'ACTIVE',
        strikes: currentStrikes,
        requiredStrikes,
        reason
      };
    }

    // 5C. Content is LIVE and available: reset strikes to 0
    await this._resetStrikes(submissionId);
    const deadline = submission.retentionDeadline ? new Date(submission.retentionDeadline) : null;
    const isDeadlineReached = deadline && now.getTime() >= deadline.getTime();

    if (isDeadlineReached) {
      // Transition: ACTIVE -> FULFILLED
      logger.info({ submissionId, deadline, now }, 'Submission successfully completed retention period; transitioning to FULFILLED');

      const updated = await this.prisma.submission.update({
        where: { id: submissionId },
        data: {
          retentionStatus: 'FULFILLED',
          lastAvailabilityStatus: 'AVAILABLE'
        }
      });

      // Audit event
      await this.auditRepo.recordEvent({
        actorUserId: null,
        actorDiscordId: 'SYSTEM',
        action: 'RETENTION_FULFILLED',
        entityType: 'SUBMISSION',
        entityId: submission.id,
        previousState: { retentionStatus: 'ACTIVE' },
        newState: { retentionStatus: 'FULFILLED' },
        reason: 'Retention period fulfilled with content verified live'
      });

      return { status: 'FULFILLED', submission: updated };
    }

    // Content live, but deadline not yet reached -> remain ACTIVE
    await this.prisma.submission.update({
      where: { id: submissionId },
      data: {
        lastAvailabilityStatus: 'AVAILABLE'
      }
    });

    return { status: 'ACTIVE', availability: 'AVAILABLE', deadline };
  }

  /**
   * Internal helper to atomically transition submission to VIOLATED
   * @private
   */
  async _transitionToViolated(submission, reason, now) {
    const updated = await this.prisma.submission.update({
      where: { id: submission.id },
      data: {
        retentionStatus: 'VIOLATED',
        retentionViolatedAt: now,
        retentionViolationReason: reason,
        lastAvailabilityStatus: 'UNAVAILABLE'
      }
    });

    // 1. Audit event
    await this.auditRepo.recordEvent({
      actorUserId: null,
      actorDiscordId: 'SYSTEM',
      action: 'RETENTION_VIOLATED',
      entityType: 'SUBMISSION',
      entityId: submission.id,
      previousState: { retentionStatus: 'ACTIVE' },
      newState: {
        retentionStatus: 'VIOLATED',
        retentionViolatedAt: now,
        reason
      },
      reason: `Retention violated: ${reason}`
    });

    // 2. Financial adjustments for all eligible earnings (without mutating original Earning rows)
    const adjustments = await this.adjustmentService.createRetentionViolationAdjustments(
      submission,
      reason
    );

    // 3. Creator notification via Discord DM
    if (submission.user?.discordId) {
      await notifyRetentionViolation({
        discordId: submission.user.discordId,
        campaignName: submission.campaign?.name || 'Campaign',
        retentionDays: submission.retentionDays || submission.campaign?.retentionDays || 30,
        violationReason: 'Video unavailable/deleted'
      });
    }

    // 4. Staff operational alert
    notifyStaffEarlyDeletion({
      submission,
      reason
    }).catch(() => {});

    return {
      status: 'VIOLATED',
      submission: updated,
      reason,
      adjustments
    };
  }
}

export const retentionService = new RetentionService();
