import { adminSubmissionRepository as defaultRepo } from './admin.submission.repository.js';
import { adminAuditService as defaultAuditService } from './audit.service.js';
import { moderationRepository as defaultModerationRepo } from '../moderation/moderation.repository.js';
import { adjustmentService as defaultAdjustmentService } from '../adjustments/adjustment.service.js';
import {
  MODERATION_ACTIONS,
  STRUCTURED_REJECTION_REASONS,
  isValidStructuredReason,
  getCreatorSafeReasonLabel
} from '../moderation/moderation.constants.js';
import { notifySubmissionRejection } from '../../bot/notifications/creator.notifications.js';
import { SubmissionNotFoundError } from '../submissions/submission.errors.js';
import {
  MissingRejectionReasonError,
  AlreadyReviewedError
} from './admin.errors.js';
import { getPlatformProvider } from '../../providers/index.js';
import { parseAndNormalizeUrl } from '../submissions/url.parser.js';
import { logger } from '../../utils/logger.js';

export class AdminSubmissionService {
  constructor(
    repo = defaultRepo,
    auditService = defaultAuditService,
    moderationRepo = defaultModerationRepo,
    adjustmentService = defaultAdjustmentService
  ) {
    this.repo = repo;
    this.auditService = auditService;
    if (repo !== defaultRepo && moderationRepo === defaultModerationRepo) {
      this.moderationRepo = repo.moderationRepo || {
        createHistoryEntry: async (entry) => ({ id: 'mock-hist-id', ...entry }),
        getHistoryBySubmissionId: async () => []
      };
    } else {
      this.moderationRepo = moderationRepo;
    }

    if (repo !== defaultRepo && adjustmentService === defaultAdjustmentService) {
      this.adjustmentService = repo.adjustmentService || {
        createPostApprovalRejectionAdjustments: async () => []
      };
    } else {
      this.adjustmentService = adjustmentService;
    }
  }

  /**
   * List paginated submissions with operational filtering
   *
   * @param {object} [options={}]
   * @returns {Promise<object>}
   */
  async listSubmissions(options = {}) {
    return this.repo.listSubmissions(options);
  }

  /**
   * List submissions requiring manual moderator review
   * (UNDER_REVIEW, POST_APPROVAL_REVIEW, FLAGGED)
   *
   * @param {object} [options={}]
   * @returns {Promise<object>}
   */
  async listReviewQueue(options = {}) {
    return this.repo.listReviewQueue(options);
  }

  /**
   * Retrieve complete submission operational details
   *
   * Creator Privacy Guarantee:
   * If isStaff === false, internal risk scores, verification signals, and raw anomaly evidence
   * are strictly redacted before returning.
   *
   * @param {string} submissionId
   * @param {object} [options={}]
   * @param {boolean} [options.isStaff=true]
   * @returns {Promise<object>}
   */
  async getSubmissionDetails(submissionId, { isStaff = true } = {}) {
    const submission = await this.repo.getSubmissionWithFullDetails(submissionId);
    if (!submission) {
      throw new SubmissionNotFoundError(submissionId);
    }

    if (!isStaff) {
      // Redact internal risk and signal evidence for creator-facing views
      const sanitizedVerifications = (submission.verifications || []).map((v) => ({
        id: v.id,
        status: v.status,
        completedAt: v.completedAt
        // Omit riskLevel, score, lastError, signals
      }));

      const sanitizedHistory = (submission.moderationHistory || []).map((h) => ({
        id: h.id,
        action: h.action,
        newStatus: h.newStatus,
        createdAt: h.createdAt,
        reason: h.reason ? getCreatorSafeReasonLabel(h.reason) : null,
        notes: h.notes
        // Omit actorDiscordId, actorUserId, actorType, evidence, verificationId
      }));

      return {
        ...submission,
        verifications: sanitizedVerifications,
        moderationHistory: sanitizedHistory
      };
    }

    return submission;
  }

  /**
   * Authorized manual approval of a submission
   *
   * Supports approval from UNDER_REVIEW, POST_APPROVAL_REVIEW, or FLAGGED.
   *
   * @param {string} submissionId
   * @param {object} actor - { discordId, userId }
   * @param {string|null} [notes]
   * @returns {Promise<object>}
   */
  async approveSubmission(submissionId, actor, notes = null) {
    const submission = await this.repo.getSubmissionWithFullDetails(submissionId);
    if (!submission) {
      throw new SubmissionNotFoundError(submissionId);
    }

    if (submission.status === 'APPROVED') {
      throw new AlreadyReviewedError('Submission', submissionId, 'APPROVED');
    }

    const previousStatus = submission.status;
    const isPostApprovalRestore = previousStatus === 'POST_APPROVAL_REVIEW';
    const approvedAt = new Date();

    let retentionFields = {};
    if (submission.retentionRequired && !submission.retentionDeadline) {
      const retentionDays = submission.retentionDays || submission.requirementsSnapshot?.retentionDays || 0;
      retentionFields = {
        approvedAt,
        retentionDeadline: new Date(approvedAt.getTime() + retentionDays * 86400000),
        retentionStatus: 'ACTIVE'
      };
    }

    const updated = await this.repo.updateSubmission(submissionId, {
      status: 'APPROVED',
      verifiedAt: approvedAt,
      rejectionReason: null,
      structuredReason: null,
      moderatedAt: approvedAt,
      moderatedBy: actor.discordId,
      moderationNotes: notes || null,
      ...retentionFields
    });

    const action = isPostApprovalRestore
      ? MODERATION_ACTIONS.POST_APPROVAL_RESTORED
      : MODERATION_ACTIONS.ADMIN_APPROVED;

    if (this.moderationRepo && typeof this.moderationRepo.createHistoryEntry === 'function') {
      await this.moderationRepo.createHistoryEntry({
        submissionId,
        action,
        previousStatus,
        newStatus: 'APPROVED',
        actorUserId: actor?.userId || null,
        actorDiscordId: actor.discordId,
        actorType: 'STAFF',
        reason: notes || (isPostApprovalRestore ? 'Submission restored after post-approval review' : 'Approved by staff'),
        notes: notes || null
      });
    }

    await this.auditService.logAction({
      actorUserId: actor?.userId || null,
      actorDiscordId: actor.discordId,
      action: isPostApprovalRestore ? 'SUBMISSION_POST_APPROVAL_RESTORE' : 'SUBMISSION_APPROVE',
      entityType: 'SUBMISSION',
      entityId: submissionId,
      previousState: { status: previousStatus },
      newState: { status: 'APPROVED', verifiedAt: updated.verifiedAt, ...retentionFields },
      reason: notes || (isPostApprovalRestore ? 'Submission restored after post-approval review' : 'Manually approved by staff')
    });

    logger.info({ submissionId, actorDiscordId: actor.discordId, action }, 'Submission approved/restored by admin');
    return updated;
  }

  /**
   * Authorized manual rejection of a submission
   *
   * @param {string} submissionId
   * @param {object} actor - { discordId, userId }
   * @param {object|string} reasonOrOptions - Either structured string reason or { structuredReason, notes }
   * @returns {Promise<object>}
   */
  async rejectSubmission(submissionId, actor, reasonOrOptions) {
    let structuredReason = null;
    let notes = null;

    if (typeof reasonOrOptions === 'string') {
      if (!reasonOrOptions || reasonOrOptions.trim().length === 0) {
        throw new MissingRejectionReasonError('A valid rejection reason must be provided.');
      }
      if (isValidStructuredReason(reasonOrOptions)) {
        structuredReason = reasonOrOptions;
      } else {
        structuredReason = STRUCTURED_REJECTION_REASONS.OTHER;
        notes = reasonOrOptions.trim();
      }
    } else if (reasonOrOptions && typeof reasonOrOptions === 'object') {
      if (!reasonOrOptions.structuredReason || !isValidStructuredReason(reasonOrOptions.structuredReason)) {
        throw new MissingRejectionReasonError('A valid structured rejection reason must be provided.');
      }
      structuredReason = reasonOrOptions.structuredReason;
      notes = reasonOrOptions.notes || reasonOrOptions.rejectionReason || null;
    } else {
      throw new MissingRejectionReasonError('A valid rejection reason must be provided.');
    }

    const submission = await this.repo.getSubmissionWithFullDetails(submissionId);
    if (!submission) {
      throw new SubmissionNotFoundError(submissionId);
    }

    // If submission is already approved or in post-approval review, delegate to post-approval rejection
    if (submission.status === 'APPROVED' || submission.status === 'POST_APPROVAL_REVIEW') {
      return this.rejectPostApproval(submissionId, actor, { structuredReason, notes });
    }

    const previousStatus = submission.status;
    const safeReason = getCreatorSafeReasonLabel(structuredReason);
    const rejectionReasonText = notes || safeReason;

    const updated = await this.repo.updateSubmission(submissionId, {
      status: 'REJECTED',
      structuredReason,
      rejectionReason: rejectionReasonText,
      moderatedAt: new Date(),
      moderatedBy: actor.discordId,
      moderationNotes: notes || null
    });

    if (this.moderationRepo && typeof this.moderationRepo.createHistoryEntry === 'function') {
      await this.moderationRepo.createHistoryEntry({
        submissionId,
        action: MODERATION_ACTIONS.ADMIN_REJECTED,
        previousStatus,
        newStatus: 'REJECTED',
        actorUserId: actor?.userId || null,
        actorDiscordId: actor.discordId,
        actorType: 'STAFF',
        reason: structuredReason,
        notes: notes || null
      });
    }

    await this.auditService.logAction({
      actorUserId: actor?.userId || null,
      actorDiscordId: actor.discordId,
      action: 'SUBMISSION_REJECT',
      entityType: 'SUBMISSION',
      entityId: submissionId,
      previousState: { status: previousStatus },
      newState: { status: 'REJECTED', structuredReason, rejectionReason: updated.rejectionReason },
      reason: notes || structuredReason
    });

    // Notify creator via Discord DM (safe, non-internal)
    if (submission.user?.discordId) {
      notifySubmissionRejection({
        discordId: submission.user.discordId,
        campaignName: submission.campaign?.name,
        safeReason,
        adminNote: notes
      }).catch((err) => {
        logger.warn({ submissionId, err: err.message }, 'Failed to dispatch creator rejection notification');
      });
    }

    logger.info({ submissionId, actorDiscordId: actor.discordId, structuredReason }, 'Submission rejected by admin');
    return updated;
  }

  /**
   * Move an approved submission into post-approval review
   *
   * @param {string} submissionId
   * @param {object} actor
   * @param {object} [options={}]
   * @param {string} [options.reason]
   * @param {string} [options.notes]
   * @returns {Promise<object>}
   */
  async startPostApprovalReview(submissionId, actor, { reason = 'Initiated post-approval fraud investigation', notes = null } = {}) {
    const submission = await this.repo.getSubmissionWithFullDetails(submissionId);
    if (!submission) {
      throw new SubmissionNotFoundError(submissionId);
    }

    if (submission.status !== 'APPROVED') {
      throw new Error(`Only APPROVED submissions can be placed into post-approval review. Current status: ${submission.status}`);
    }

    const previousStatus = submission.status;
    const updated = await this.repo.updateSubmission(submissionId, {
      status: 'POST_APPROVAL_REVIEW',
      moderatedAt: new Date(),
      moderatedBy: actor.discordId,
      moderationNotes: notes || reason
    });

    if (this.moderationRepo && typeof this.moderationRepo.createHistoryEntry === 'function') {
      await this.moderationRepo.createHistoryEntry({
        submissionId,
        action: MODERATION_ACTIONS.POST_APPROVAL_REVIEW_STARTED,
        previousStatus,
        newStatus: 'POST_APPROVAL_REVIEW',
        actorUserId: actor?.userId || null,
        actorDiscordId: actor.discordId,
        actorType: 'STAFF',
        reason,
        notes
      });
    }

    await this.auditService.logAction({
      actorUserId: actor?.userId || null,
      actorDiscordId: actor.discordId,
      action: 'SUBMISSION_POST_APPROVAL_REVIEW',
      entityType: 'SUBMISSION',
      entityId: submissionId,
      previousState: { status: previousStatus },
      newState: { status: 'POST_APPROVAL_REVIEW' },
      reason: notes || reason
    });

    logger.info({ submissionId, actorDiscordId: actor.discordId }, 'Submission moved to post-approval review');
    return updated;
  }

  /**
   * Flag a submission for deeper fraud investigation or staff inspection
   *
   * @param {string} submissionId
   * @param {object} actor - { discordId, userId }
   * @param {string} [reason='Flagged by staff inspection']
   * @returns {Promise<object>}
   */
  async flagSubmission(submissionId, actor, reason = 'Flagged by staff inspection') {
    const submission = await this.repo.getSubmissionWithFullDetails(submissionId);
    if (!submission) {
      throw new SubmissionNotFoundError(submissionId);
    }

    const previousStatus = submission.status;
    const flaggedAt = new Date();

    const updated = await this.repo.updateSubmission(submissionId, {
      status: 'FLAGGED',
      moderatedAt: flaggedAt,
      moderatedBy: actor.discordId,
      moderationNotes: reason
    });

    if (this.moderationRepo && typeof this.moderationRepo.createHistoryEntry === 'function') {
      await this.moderationRepo.createHistoryEntry({
        submissionId,
        action: 'FLAGGED',
        previousStatus,
        newStatus: 'FLAGGED',
        actorUserId: actor?.userId || null,
        actorDiscordId: actor.discordId,
        actorType: 'STAFF',
        reason,
        notes: reason
      });
    }

    await this.auditService.logAction({
      actorUserId: actor?.userId || null,
      actorDiscordId: actor.discordId,
      action: 'SUBMISSION_FLAG',
      entityType: 'SUBMISSION',
      entityId: submissionId,
      previousState: { status: previousStatus },
      newState: { status: 'FLAGGED' },
      reason
    });

    logger.info({ submissionId, actorDiscordId: actor.discordId }, 'Submission flagged by staff inspection');
    return updated;
  }

  /**
   * Reject a previously approved submission post-approval
   *
   * Financial Decoupling & Invariants:
   * - Sets submission status to REJECTED.
   * - Leaves original Earning records unmodified (NO mutation / NO deletion).
   * - Leaves completed Payout records unmodified (NO retroactive clawback of paid funds).
   * - Generates negative FinancialAdjustment rows referencing original earnings.
   * - Records immutable moderation history & audit events.
   * - Sends creator-safe notification.
   *
   * @param {string} submissionId
   * @param {object} actor
   * @param {object} options
   * @param {string} options.structuredReason
   * @param {string|null} [options.notes]
   * @returns {Promise<object>}
   */
  async rejectPostApproval(submissionId, actor, { structuredReason, notes = null } = {}) {
    if (!structuredReason || !isValidStructuredReason(structuredReason)) {
      throw new MissingRejectionReasonError('A valid structured rejection reason must be provided for post-approval rejection.');
    }

    const submission = await this.repo.getSubmissionWithFullDetails(submissionId);
    if (!submission) {
      throw new SubmissionNotFoundError(submissionId);
    }

    if (submission.status !== 'APPROVED' && submission.status !== 'POST_APPROVAL_REVIEW') {
      throw new Error(`Submission must be in APPROVED or POST_APPROVAL_REVIEW status for post-approval rejection. Current status: ${submission.status}`);
    }

    const previousStatus = submission.status;
    const safeReason = getCreatorSafeReasonLabel(structuredReason);
    const rejectionReasonText = notes ? `${safeReason}: ${notes}` : safeReason;

    // 1. Create auditable negative financial adjustments for all eligible earnings
    let adjustments = [];
    if (this.adjustmentService && typeof this.adjustmentService.createPostApprovalRejectionAdjustments === 'function') {
      adjustments = await this.adjustmentService.createPostApprovalRejectionAdjustments(
        submission,
        notes || safeReason,
        actor.discordId
      );
    }

    // 2. Transition submission status to REJECTED
    const updated = await this.repo.updateSubmission(submissionId, {
      status: 'REJECTED',
      structuredReason,
      rejectionReason: rejectionReasonText,
      moderatedAt: new Date(),
      moderatedBy: actor.discordId,
      moderationNotes: notes || null
    });

    // 3. Record immutable moderation history entry
    if (this.moderationRepo && typeof this.moderationRepo.createHistoryEntry === 'function') {
      await this.moderationRepo.createHistoryEntry({
        submissionId,
        action: MODERATION_ACTIONS.POST_APPROVAL_REJECTED,
        previousStatus,
        newStatus: 'REJECTED',
        actorUserId: actor?.userId || null,
        actorDiscordId: actor.discordId,
        actorType: 'STAFF',
        reason: structuredReason,
        notes: notes || null,
        evidence: {
          adjustmentsCreated: adjustments.length,
          adjustmentIds: adjustments.map((a) => a.id)
        }
      });
    }

    // 4. Record admin audit log
    await this.auditService.logAction({
      actorUserId: actor?.userId || null,
      actorDiscordId: actor.discordId,
      action: 'SUBMISSION_POST_APPROVAL_REJECT',
      entityType: 'SUBMISSION',
      entityId: submissionId,
      previousState: { status: previousStatus },
      newState: { status: 'REJECTED', structuredReason, adjustmentsCreated: adjustments.length },
      reason: notes || structuredReason
    });

    // 5. Notify creator
    if (submission.user?.discordId) {
      notifySubmissionRejection({
        discordId: submission.user.discordId,
        campaignName: submission.campaign?.name,
        safeReason,
        adminNote: notes
      }).catch((err) => {
        logger.warn({ submissionId, err: err.message }, 'Failed to dispatch creator post-approval rejection notification');
      });
    }

    logger.warn(
      { submissionId, actorDiscordId: actor.discordId, adjustmentsCount: adjustments.length },
      'Submission rejected post-approval with financial adjustments generated'
    );

    return {
      submission: updated,
      adjustments
    };
  }

  /**
   * Place submission under review or flag for investigation
   *
   * @param {string} submissionId
   * @param {'FLAGGED'|'UNDER_REVIEW'} targetStatus
   * @param {object} actor
   * @param {string} reason
   * @returns {Promise<object>}
   */
  async flagOrReviewSubmission(submissionId, targetStatus, actor, reason) {
    const submission = await this.repo.getSubmissionWithFullDetails(submissionId);
    if (!submission) {
      throw new SubmissionNotFoundError(submissionId);
    }

    const previousStatus = submission.status;
    const updated = await this.repo.updateSubmission(submissionId, {
      status: targetStatus,
      rejectionReason: reason || null,
      moderatedAt: new Date(),
      moderatedBy: actor.discordId,
      moderationNotes: reason || null
    });

    if (this.moderationRepo && typeof this.moderationRepo.createHistoryEntry === 'function') {
      await this.moderationRepo.createHistoryEntry({
        submissionId,
        action: targetStatus === 'FLAGGED' ? 'FLAGGED' : MODERATION_ACTIONS.SENT_TO_REVIEW,
        previousStatus,
        newStatus: targetStatus,
        actorUserId: actor?.userId || null,
        actorDiscordId: actor.discordId,
        actorType: 'STAFF',
        reason
      });
    }

    await this.auditService.logAction({
      actorUserId: actor?.userId || null,
      actorDiscordId: actor.discordId,
      action: `SUBMISSION_${targetStatus}`,
      entityType: 'SUBMISSION',
      entityId: submissionId,
      previousState: { status: previousStatus },
      newState: { status: targetStatus, reason },
      reason
    });

    logger.info({ submissionId, from: previousStatus, to: targetStatus, actorDiscordId: actor.discordId }, 'Submission status updated by admin');
    return updated;
  }

  /**
   * Fetch latest metrics on-demand from the authoritative provider
   * Records a timestamped MetricSnapshot and updates submission availability.
   *
   * @param {string} submissionId
   * @param {object} actor - { discordId, userId }
   * @returns {Promise<object>}
   */
  async refreshSubmissionMetrics(submissionId, actor) {
    const submission = await (typeof this.repo.getSubmissionBasic === 'function'
      ? this.repo.getSubmissionBasic(submissionId)
      : this.repo.getSubmissionWithFullDetails(submissionId));
    if (!submission) {
      throw new SubmissionNotFoundError(submissionId);
    }

    const provider = getPlatformProvider(submission.platform);
    const { contentId } = parseAndNormalizeUrl(submission.url);
    // For Instagram, pass the full original URL so Apify can use any share tokens (e.g. ?stkn=...)
    // For all other platforms, pass the normalized contentId to avoid URL-as-ID confusion
    const metricsInput = submission.platform === 'INSTAGRAM' ? (submission.url || contentId) : contentId;
    const metricsRes = await provider.getVideoMetrics(metricsInput);

    let snapshot = null;
    if (metricsRes && metricsRes.status !== 'DATA_UNAVAILABLE') {
      const newMetrics = {
        views: metricsRes.views != null ? BigInt(metricsRes.views) : null,
        likes: metricsRes.likes != null ? BigInt(metricsRes.likes) : null,
        comments: metricsRes.comments != null ? BigInt(metricsRes.comments) : null,
        shares: metricsRes.shares != null ? BigInt(metricsRes.shares) : null
      };

      if (this.repo.db?.metricSnapshot?.create) {
        snapshot = await this.repo.db.metricSnapshot.create({
          data: {
            submissionId: submission.id,
            views: newMetrics.views,
            likes: newMetrics.likes,
            comments: newMetrics.comments,
            shares: newMetrics.shares,
            capturedAt: new Date(),
            metadata: {
              polledBy: 'STAFF_ON_DEMAND',
              actorDiscordId: actor.discordId,
              provider: provider.name || submission.platform,
              status: metricsRes.status || 'AVAILABLE',
              availability: metricsRes.availability || null
            }
          }
        });
      }
    }

    const updated = await this.repo.updateSubmission(submissionId, {
      lastAvailabilityStatus: metricsRes?.status || 'DATA_UNAVAILABLE'
    });

    await this.auditService.logAction({
      actorUserId: actor?.userId || null,
      actorDiscordId: actor.discordId,
      action: 'SUBMISSION_REFRESH_METRICS',
      entityType: 'SUBMISSION',
      entityId: submissionId,
      newState: {
        lastAvailabilityStatus: updated.lastAvailabilityStatus,
        snapshotId: snapshot?.id || null
      }
    });

    logger.info({ submissionId, actorDiscordId: actor.discordId }, 'Submission metrics refreshed by staff');

    // Retrieve fresh full details once for downstream view rendering
    let fullSubmission;
    try {
      fullSubmission = await this.getSubmissionDetails(submissionId, { isStaff: true });
    } catch {
      fullSubmission = updated;
    }

    return {
      submission: fullSubmission,
      snapshot,
      metrics: metricsRes,
      lastAvailabilityStatus: updated.lastAvailabilityStatus
    };
  }

  /**
   * Record manually verified metrics for a submission (e.g. for Facebook or manual review)
   *
   * @param {string} submissionId
   * @param {object} metricData - { views, likes, comments, shares, notes }
   * @param {object} actor - { discordId, userId }
   * @returns {Promise<object>}
   */
  async recordManualMetrics(submissionId, metricData = {}, actor = {}) {
    const submission = await this.repo.getSubmissionWithFullDetails(submissionId);
    if (!submission) {
      throw new SubmissionNotFoundError(submissionId);
    }

    const { views, likes, comments, shares, notes } = metricData;

    if (views == null || views === '' || isNaN(Number(views)) || Number(views) < 0) {
      throw new Error('Valid views count (>= 0) is required for manual metrics');
    }

    const parsedViews = BigInt(views);
    const parsedLikes = (likes != null && likes !== '' && !isNaN(Number(likes)) && Number(likes) >= 0)
      ? BigInt(likes)
      : null;
    const parsedComments = (comments != null && comments !== '' && !isNaN(Number(comments)) && Number(comments) >= 0)
      ? BigInt(comments)
      : null;
    const parsedShares = (shares != null && shares !== '' && !isNaN(Number(shares)) && Number(shares) >= 0)
      ? BigInt(shares)
      : null;

    let snapshot = null;
    if (this.repo.db?.metricSnapshot?.create) {
      snapshot = await this.repo.db.metricSnapshot.create({
        data: {
          submissionId: submission.id,
          views: parsedViews,
          likes: parsedLikes,
          comments: parsedComments,
          shares: parsedShares,
          capturedAt: new Date(),
          source: 'MANUAL',
          metadata: {
            enteredBy: 'STAFF_MANUAL_VERIFICATION',
            actorDiscordId: actor?.discordId || 'UNKNOWN',
            actorUserId: actor?.userId || null,
            notes: notes || null,
            platform: submission.platform
          }
        }
      });
    }

    const updatePayload = {
      lastAvailabilityStatus: 'MANUALLY_VERIFIED'
    };
    if (!submission.verifiedAt) {
      updatePayload.verifiedAt = new Date();
    }

    const updated = await this.repo.updateSubmission(submissionId, updatePayload);

    await this.auditService.logAction({
      actorUserId: actor?.userId || null,
      actorDiscordId: actor?.discordId || 'UNKNOWN',
      action: 'SUBMISSION_MANUAL_METRICS',
      entityType: 'SUBMISSION',
      entityId: submissionId,
      newState: {
        lastAvailabilityStatus: updated.lastAvailabilityStatus,
        snapshotId: snapshot?.id || null,
        views: parsedViews.toString(),
        likes: parsedLikes ? parsedLikes.toString() : null,
        comments: parsedComments ? parsedComments.toString() : null,
        shares: parsedShares ? parsedShares.toString() : null
      },
      reason: notes || 'Staff manually entered verified metrics'
    });

    logger.info({ submissionId, actorDiscordId: actor?.discordId, snapshotId: snapshot?.id }, 'Manual metrics recorded by staff');
    return { submission: updated, snapshot };
  }

  /**
   * Retrieve historical metric growth analytics
   *
   * @param {string} submissionId
   * @param {object} [options={}]
   * @returns {Promise<object|null>}
   */
  async getSubmissionAnalytics(submissionId, options = {}) {
    return this.repo.getSubmissionAnalytics(submissionId, options);
  }

  /**
   * Retrieve aggregate submission stats for dashboard
   *
   * @returns {Promise<object>}
   */
  async getSubmissionRegistryStats() {
    return this.repo.getSubmissionRegistryStats();
  }
}

export const adminSubmissionService = new AdminSubmissionService();
export default adminSubmissionService;
