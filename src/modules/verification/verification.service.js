import { verificationRepository as defaultVerificationRepo } from './verification.repository.js';
import { submissionRepository as defaultSubmissionRepo } from '../submissions/submission.repository.js';
import { moderationRepository as defaultModerationRepo } from '../moderation/moderation.repository.js';
import { getProviderForPlatform } from '../../providers/index.js';
import { parseAndNormalizeUrl } from '../submissions/url.parser.js';
import { analyzeMetricSignals } from './analyzer.js';
import { assessVerificationRisk } from './risk.assessor.js';
import { defaultApprovalPolicy } from './approval.policy.js';
import { DEFAULT_VERIFICATION_POLICY } from './policy.js';
import { MODERATION_ACTIONS, STRUCTURED_REJECTION_REASONS } from '../moderation/moderation.constants.js';
import { notifySubmissionUnderReview } from '../../bot/notifications/creator.notifications.js';
import { notifyStaffSuspiciousClip, notifyStaffManualReviewRequired } from '../../bot/notifications/staff.notifications.js';
import { logger } from '../../utils/logger.js';
import {
  TransientProviderError,
  PermanentContentError,
  ConfigurationAuthError,
  VerificationFailedError
} from './verification.errors.js';
import { config } from '../../config/index.js';

export class VerificationService {
  constructor(
    verificationRepo = defaultVerificationRepo,
    submissionRepo = defaultSubmissionRepo,
    providerResolver = getProviderForPlatform,
    approvalPolicy = defaultApprovalPolicy,
    policy = DEFAULT_VERIFICATION_POLICY,
    moderationRepo = defaultModerationRepo
  ) {
    if (verificationRepo && typeof verificationRepo === 'object' && verificationRepo.verificationRepo) {
      this.verificationRepo = verificationRepo.verificationRepo;
      this.submissionRepo = verificationRepo.submissionRepo || defaultSubmissionRepo;
      this.providerResolver = verificationRepo.providerResolver || getProviderForPlatform;
      this.approvalPolicy = verificationRepo.approvalPolicy || defaultApprovalPolicy;
      this.policy = verificationRepo.policy || DEFAULT_VERIFICATION_POLICY;
      this.moderationRepo = verificationRepo.moderationRepo || defaultModerationRepo;
    } else {
      this.verificationRepo = verificationRepo;
      this.submissionRepo = submissionRepo;
      this.providerResolver = providerResolver;
      this.approvalPolicy = approvalPolicy;
      this.policy = policy;
      this.moderationRepo = moderationRepo;
    }

    if (this.submissionRepo !== defaultSubmissionRepo && this.moderationRepo === defaultModerationRepo) {
      this.moderationRepo = {
        createHistoryEntry: async (entry) => ({ id: 'mock-hist-id', ...entry }),
        getHistoryBySubmissionId: async () => []
      };
    }
  }

  /**
   * Run the end-to-end verification and engagement integrity analysis for a submission
   * @param {string} submissionId
   * @param {object} [options={}]
   * @param {boolean} [options.forceRefresh=false]
   * @returns {Promise<object>}
   */
  async runVerification(submissionId, { forceRefresh = false } = {}) {
    logger.info({ submissionId, forceRefresh }, 'Starting submission verification pipeline');

    // 1. Load submission
    const submission = await this.submissionRepo.getSubmissionById(submissionId);
    if (!submission) {
      throw new VerificationFailedError(submissionId, 'Submission not found');
    }

    // 2. Idempotency Check: Avoid duplicate processing on rapid job retry
    const existingVer = await this.verificationRepo.getVerificationBySubmissionId(submissionId);
    if (existingVer && existingVer.status === 'COMPLETED' && !forceRefresh) {
      const secondsSinceCompletion = (Date.now() - new Date(existingVer.completedAt || existingVer.updatedAt).getTime()) / 1000;
      if (secondsSinceCompletion < 60) {
        logger.info({ submissionId, verificationId: existingVer.id }, 'Verification recently completed; returning cached result (idempotent)');
        return {
          status: 'COMPLETED',
          verificationId: existingVer.id,
          riskLevel: existingVer.riskLevel,
          score: existingVer.score,
          submissionStatus: submission.status,
          idempotent: true
        };
      }
    }

    // 3. Mark verification IN_PROGRESS
    const verification = await this.verificationRepo.upsertVerification({
      submissionId,
      status: 'IN_PROGRESS',
      startedAt: new Date(),
      lastError: null
    });

    // 4. Resolve platform provider & content identifier
    const provider = this.providerResolver(submission.platform);
    const { contentId } = parseAndNormalizeUrl(submission.url);

    const providerInput = submission.platform === 'INSTAGRAM' ? (submission.url || contentId) : (contentId || submission.url);

    let providerResult;
    try {
      providerResult = await provider.getCurrentMetrics(providerInput);
    } catch (err) {
      // 4A. Permanent content failures (deleted, private, 404)
      if (err instanceof PermanentContentError) {
        logger.warn({ submissionId, err: err.message }, 'Permanent content failure in provider verification');
        await this.verificationRepo.upsertVerification({
          submissionId,
          status: 'FAILED',
          lastError: err.message,
          completedAt: new Date()
        });

        const updateData = {
          status: 'REJECTED',
          rejectionReason: err.message,
          structuredReason: STRUCTURED_REJECTION_REASONS.VIDEO_DELETED_UNAVAILABLE,
          moderatedAt: new Date(),
          moderatedBy: 'SYSTEM'
        };

        if (typeof this.submissionRepo.updateSubmission === 'function') {
          await this.submissionRepo.updateSubmission(submissionId, updateData);
        } else {
          await this.submissionRepo.updateSubmissionStatus(submissionId, 'REJECTED', updateData);
        }

        if (this.moderationRepo && typeof this.moderationRepo.createHistoryEntry === 'function') {
          await this.moderationRepo.createHistoryEntry({
            submissionId,
            action: MODERATION_ACTIONS.AUTO_REJECTED,
            previousStatus: submission.status,
            newStatus: 'REJECTED',
            actorDiscordId: 'SYSTEM',
            actorType: 'SYSTEM',
            reason: err.message
          }).catch(e => logger.warn({ submissionId, err: e.message }, 'Failed to record moderation history'));
        }

        return {
          status: 'FAILED',
          category: 'PERMANENT_CONTENT',
          permanent: true,
          reason: err.message
        };
      }

      // 4B. Configuration or authorization failures (missing or invalid API key, expired OAuth)
      // IMPORTANT: Operator/system issue. Must NOT cause submission to be marked permanently invalid!
      if (err instanceof ConfigurationAuthError) {
        logger.error({ submissionId, err: err.message }, 'Configuration/authorization failure in provider verification');
        await this.verificationRepo.upsertVerification({
          submissionId,
          status: 'FAILED',
          lastError: `Operator configuration required: ${err.message}`,
          completedAt: new Date()
        });

        // Place under review so staff can fix API keys without penalizing creator
        const updateData = {
          status: 'UNDER_REVIEW',
          rejectionReason: 'Verification delayed pending provider configuration review',
          moderatedAt: new Date(),
          moderatedBy: 'SYSTEM'
        };

        if (typeof this.submissionRepo.updateSubmission === 'function') {
          await this.submissionRepo.updateSubmission(submissionId, updateData);
        } else {
          await this.submissionRepo.updateSubmissionStatus(submissionId, 'UNDER_REVIEW', updateData);
        }

        if (this.moderationRepo && typeof this.moderationRepo.createHistoryEntry === 'function') {
          await this.moderationRepo.createHistoryEntry({
            submissionId,
            action: MODERATION_ACTIONS.SENT_TO_REVIEW,
            previousStatus: submission.status,
            newStatus: 'UNDER_REVIEW',
            actorDiscordId: 'SYSTEM',
            actorType: 'SYSTEM',
            reason: `Operator configuration required: ${err.message}`
          }).catch(e => logger.warn({ submissionId, err: e.message }, 'Failed to record moderation history'));
        }

        return {
          status: 'FAILED',
          category: 'CONFIGURATION_OR_AUTH',
          permanent: false,
          requiresStaffAction: true,
          reason: err.message
        };
      }

      // 4C. Transient retryable errors (rate limits 429, timeouts, 502/503)
      if (err instanceof TransientProviderError) {
        logger.warn({ submissionId, err: err.message }, 'Transient failure in provider verification (retryable)');
        await this.verificationRepo.upsertVerification({
          submissionId,
          status: 'PENDING',
          lastError: err.message
        });
        // Re-throw so BullMQ triggers exponential backoff
        throw err;
      }

      throw err;
    }

    // 4D. Check clip duration if duration is AVAILABLE
    const durationSeconds = providerResult.durationSeconds ?? null;
    const durationAvailability = providerResult.availability?.duration || (durationSeconds !== null ? 'AVAILABLE' : 'UNAVAILABLE');

    if (durationAvailability === 'AVAILABLE' && durationSeconds !== null) {
      const minDuration = submission.requirementsSnapshot?.minClipDurationSeconds ?? submission.campaign?.minClipDurationSeconds ?? 7;
      const maxDuration = submission.requirementsSnapshot?.maxClipDurationSeconds ?? submission.campaign?.maxClipDurationSeconds ?? 120;

      if (durationSeconds < minDuration || durationSeconds > maxDuration) {
        const rejectionReason = `This campaign accepts clips between ${minDuration} and ${maxDuration} seconds. Clip duration was ${durationSeconds} seconds.`;
        logger.warn({ submissionId, durationSeconds, minDuration, maxDuration }, 'Clip duration outside allowed range');

        await this.verificationRepo.upsertVerification({
          submissionId,
          status: 'COMPLETED',
          riskLevel: 'HIGH_RISK',
          score: 100,
          completedAt: new Date()
        });

        const updateData = {
          status: 'REJECTED',
          rejectionReason,
          structuredReason: STRUCTURED_REJECTION_REASONS.CAMPAIGN_REQUIREMENT_VIOLATION,
          verifiedAt: new Date(),
          durationSeconds,
          durationStatus: 'AVAILABLE',
          moderatedAt: new Date(),
          moderatedBy: 'SYSTEM'
        };

        if (typeof this.submissionRepo.updateSubmission === 'function') {
          await this.submissionRepo.updateSubmission(submissionId, updateData);
        } else {
          await this.submissionRepo.updateSubmissionStatus(submissionId, 'REJECTED', updateData);
        }

        if (this.moderationRepo && typeof this.moderationRepo.createHistoryEntry === 'function') {
          await this.moderationRepo.createHistoryEntry({
            submissionId,
            action: MODERATION_ACTIONS.AUTO_REJECTED,
            previousStatus: submission.status,
            newStatus: 'REJECTED',
            actorDiscordId: 'SYSTEM',
            actorType: 'SYSTEM',
            reason: rejectionReason
          }).catch(e => logger.warn({ submissionId, err: e.message }, 'Failed to record moderation history'));
        }

        return {
          status: 'COMPLETED',
          riskLevel: 'HIGH_RISK',
          score: 100,
          submissionStatus: 'REJECTED',
          reason: rejectionReason,
          durationSeconds
        };
      }
    }

    // 4E. Check submission window & publishedAt (IMP-04: Fail closed if publishedAt missing or unparseable)
    const rawPublishedAt = providerResult.publishedAt || providerResult.metadata?.publishedAt || null;
    let publishedAt = null;
    if (rawPublishedAt) {
      const parsedDate = new Date(rawPublishedAt);
      if (!isNaN(parsedDate.getTime())) {
        publishedAt = parsedDate;
      }
    }

    const campaignWindowHours = submission.campaign?.submissionWindowHours ||
      submission.campaign?.requirements?.submissionWindowHours ||
      submission.requirementsSnapshot?.submissionWindowHours ||
      config?.submissionWindowHours ||
      1;
    const maxSubmissionAgeSeconds = Math.round(Number(campaignWindowHours) * 3600);

    if (!publishedAt) {
      const reviewReason = 'Publication timestamp missing or unparseable - requires manual staff verification';
      logger.warn({ submissionId, rawPublishedAt, platform: submission.platform }, reviewReason);

      await this.verificationRepo.upsertVerification({
        submissionId,
        status: 'COMPLETED',
        riskLevel: 'REVIEW_REQUIRED',
        score: 50,
        completedAt: new Date()
      });

      const underReviewUpdate = {
        status: 'UNDER_REVIEW',
        rejectionReason: reviewReason,
        structuredReason: 'MANUAL_REVIEW_REQUIRED',
        verifiedAt: new Date(),
        durationSeconds,
        durationStatus: durationAvailability,
        lastAvailabilityStatus: providerResult.status,
        moderatedAt: new Date(),
        moderatedBy: 'SYSTEM'
      };

      if (typeof this.submissionRepo.updateSubmission === 'function') {
        await this.submissionRepo.updateSubmission(submissionId, underReviewUpdate);
      } else {
        await this.submissionRepo.updateSubmissionStatus(submissionId, 'UNDER_REVIEW', underReviewUpdate);
      }

      if (this.moderationRepo && typeof this.moderationRepo.createHistoryEntry === 'function') {
        await this.moderationRepo.createHistoryEntry({
          submissionId,
          action: MODERATION_ACTIONS.SENT_TO_REVIEW,
          previousStatus: submission.status,
          newStatus: 'UNDER_REVIEW',
          actorDiscordId: 'SYSTEM',
          actorType: 'SYSTEM',
          reason: reviewReason
        }).catch((e) => logger.warn({ submissionId, err: e.message }, 'Failed to record moderation history'));
      }

      if (submission.user?.discordId) {
        notifySubmissionUnderReview({
          discordId: submission.user.discordId,
          campaignName: submission.campaign?.name,
          videoUrl: submission.url
        }).catch((e) => logger.warn({ submissionId, err: e.message }, 'Failed to notify creator of under review'));
      }

      notifyStaffManualReviewRequired({
        submission,
        reason: reviewReason
      }).catch((e) => logger.warn({ submissionId, err: e.message }, 'Failed to dispatch staff alert for review'));

      return {
        status: 'COMPLETED',
        riskLevel: 'REVIEW_REQUIRED',
        score: 50,
        submissionStatus: 'UNDER_REVIEW',
        reason: reviewReason,
        publishedAt: null,
        submissionAgeSeconds: null,
        durationSeconds
      };
    }

    const submittedTime = new Date(submission.submittedAt || submission.createdAt || Date.now()).getTime();
    const publishedTime = publishedAt.getTime();
    const submissionAgeSeconds = Math.floor((submittedTime - publishedTime) / 1000);

    // Future publication timestamp check (with 60-second clock skew tolerance)
    if (publishedTime > submittedTime + 60000) {
      const rejectionReason = `Invalid publication timestamp: video publication time (${publishedAt.toISOString()}) is in the future relative to submission time.`;
      logger.warn({ submissionId, publishedAt: publishedAt.toISOString(), submittedTime }, 'Future publication timestamp detected');

      await this.verificationRepo.upsertVerification({
        submissionId,
        status: 'COMPLETED',
        riskLevel: 'HIGH_RISK',
        score: 100,
        completedAt: new Date()
      });

      const updateData = {
        status: 'REJECTED',
        rejectionReason,
        structuredReason: STRUCTURED_REJECTION_REASONS.CAMPAIGN_REQUIREMENT_VIOLATION,
        verifiedAt: new Date(),
        durationSeconds,
        durationStatus: durationAvailability,
        moderatedAt: new Date(),
        moderatedBy: 'SYSTEM'
      };

      if (typeof this.submissionRepo.updateSubmission === 'function') {
        await this.submissionRepo.updateSubmission(submissionId, updateData);
      } else {
        await this.submissionRepo.updateSubmissionStatus(submissionId, 'REJECTED', updateData);
      }

      if (this.moderationRepo && typeof this.moderationRepo.createHistoryEntry === 'function') {
        await this.moderationRepo.createHistoryEntry({
          submissionId,
          action: MODERATION_ACTIONS.AUTO_REJECTED,
          previousStatus: submission.status,
          newStatus: 'REJECTED',
          actorDiscordId: 'SYSTEM',
          actorType: 'SYSTEM',
          reason: rejectionReason
        }).catch(e => logger.warn({ submissionId, err: e.message }, 'Failed to record moderation history'));
      }

      return {
        status: 'COMPLETED',
        riskLevel: 'HIGH_RISK',
        score: 100,
        submissionStatus: 'REJECTED',
        reason: rejectionReason,
        publishedAt: publishedAt.toISOString(),
        submissionAgeSeconds
      };
    }

    // Configurable submission window check: submitted time must be <= maxSubmissionAgeSeconds after publication
    // Exactly maxSubmissionAgeSeconds is eligible (deterministic boundary: age > maxSubmissionAgeSeconds is ineligible)
    if (submissionAgeSeconds > maxSubmissionAgeSeconds) {
      const windowStr = campaignWindowHours === 1 ? '1 hour' : `${campaignWindowHours} hours`;
      const minutesOld = Math.floor(submissionAgeSeconds / 60);
      const rejectionReason = `Submission window expired: clips must be submitted within ${windowStr} of publication. This video was published ${minutesOld} minutes prior to submission.`;
      logger.warn({ submissionId, submissionAgeSeconds, minutesOld, maxSubmissionAgeSeconds }, 'Submission exceeded publication window');

      await this.verificationRepo.upsertVerification({
        submissionId,
        status: 'COMPLETED',
        riskLevel: 'HIGH_RISK',
        score: 100,
        completedAt: new Date()
      });

      const updateData = {
        status: 'REJECTED',
        rejectionReason,
        structuredReason: STRUCTURED_REJECTION_REASONS.CAMPAIGN_REQUIREMENT_VIOLATION,
        verifiedAt: new Date(),
        durationSeconds,
        durationStatus: durationAvailability,
        moderatedAt: new Date(),
        moderatedBy: 'SYSTEM'
      };

      if (typeof this.submissionRepo.updateSubmission === 'function') {
        await this.submissionRepo.updateSubmission(submissionId, updateData);
      } else {
        await this.submissionRepo.updateSubmissionStatus(submissionId, 'REJECTED', updateData);
      }

      if (this.moderationRepo && typeof this.moderationRepo.createHistoryEntry === 'function') {
        await this.moderationRepo.createHistoryEntry({
          submissionId,
          action: MODERATION_ACTIONS.AUTO_REJECTED,
          previousStatus: submission.status,
          newStatus: 'REJECTED',
          actorDiscordId: 'SYSTEM',
          actorType: 'SYSTEM',
          reason: rejectionReason
        }).catch(e => logger.warn({ submissionId, err: e.message }, 'Failed to record moderation history'));
      }

      return {
        status: 'COMPLETED',
        riskLevel: 'HIGH_RISK',
        score: 100,
        submissionStatus: 'REJECTED',
        reason: rejectionReason,
        publishedAt: publishedAt.toISOString(),
        submissionAgeSeconds
      };
    }

    // 5. Handle DATA_UNAVAILABLE capability response
    if (providerResult.status === 'DATA_UNAVAILABLE' || providerResult.views === null) {
      logger.info({ submissionId, platform: submission.platform }, 'Platform metrics currently DATA_UNAVAILABLE');

      const signal = {
        type: 'DATA_UNAVAILABLE',
        severity: 'HIGH',
        value: {
          reason: providerResult.reason || 'Provider returned unavailable metrics',
          availability: providerResult.availability || {}
        },
        explanation: `Platform metrics are currently unavailable: ${providerResult.reason || 'Authorization required'}`
      };

      const assessment = assessVerificationRisk([signal], this.policy);

      await this.verificationRepo.addVerificationSignals(verification.id, [signal]);
      await this.verificationRepo.upsertVerification({
        submissionId,
        status: 'COMPLETED',
        riskLevel: assessment.riskLevel,
        score: assessment.score,
        completedAt: new Date()
      });

      // Decoupled approval decision
      const decision = this.approvalPolicy.evaluateApprovalDecision({
        riskLevel: assessment.riskLevel,
        primaryReasons: assessment.primaryReasons,
        submission
      });

      const dataUnavailUpdate = {
        status: decision.status,
        rejectionReason: decision.reason,
        durationSeconds: null,
        durationStatus: durationAvailability,
        lastAvailabilityStatus: providerResult.status,
        moderatedAt: new Date(),
        moderatedBy: 'SYSTEM'
      };

      if (typeof this.submissionRepo.updateSubmission === 'function') {
        await this.submissionRepo.updateSubmission(submissionId, dataUnavailUpdate);
      } else {
        await this.submissionRepo.updateSubmissionStatus(submissionId, decision.status, dataUnavailUpdate);
      }

      if (this.moderationRepo && typeof this.moderationRepo.createHistoryEntry === 'function') {
        const action = decision.status === 'APPROVED' ? MODERATION_ACTIONS.AUTO_APPROVED :
                       decision.status === 'UNDER_REVIEW' ? MODERATION_ACTIONS.SENT_TO_REVIEW :
                       MODERATION_ACTIONS.AUTO_REJECTED;
        await this.moderationRepo.createHistoryEntry({
          submissionId,
          action,
          previousStatus: submission.status,
          newStatus: decision.status,
          actorDiscordId: 'SYSTEM',
          actorType: 'SYSTEM',
          reason: decision.reason,
          verificationId: verification.id,
          evidence: {
            riskLevel: assessment.riskLevel,
            score: assessment.score
          }
        }).catch(e => logger.warn({ submissionId, err: e.message }, 'Failed to record moderation history'));
      }

      if (decision.status === 'UNDER_REVIEW' && submission.user?.discordId) {
        notifySubmissionUnderReview({
          discordId: submission.user.discordId,
          campaignName: submission.campaign?.name,
          videoUrl: submission.url
        }).catch(e => logger.warn({ submissionId, err: e.message }, 'Failed to notify creator of under review'));
      }

      if (decision.status === 'FLAGGED' || assessment.riskLevel === 'HIGH_RISK') {
        notifyStaffSuspiciousClip({
          submission,
          reason: decision.reason || assessment.primaryReasons?.join('; ') || 'High risk signals detected; flagged for staff review',
          snapshot: null,
          signals: [signal]
        }).catch(e => logger.warn({ submissionId, err: e.message }, 'Failed to alert staff for flagged clip'));
      } else if (decision.status === 'UNDER_REVIEW') {
        notifyStaffManualReviewRequired({
          submission,
          reason: decision.reason || 'Metrics unavailable; manual review required'
        }).catch(e => logger.warn({ submissionId, err: e.message }, 'Failed to alert staff for review'));
      }

      return {
        status: 'COMPLETED',
        riskLevel: assessment.riskLevel,
        score: assessment.score,
        submissionStatus: decision.status,
        signals: [signal],
        publishedAt: publishedAt ? publishedAt.toISOString() : null,
        submissionAgeSeconds
      };
    }

    // 6. Query historical snapshots to detect trajectory changes
    const historicalSnapshots = await this.verificationRepo.getHistoricalSnapshots(submissionId);

    // 7. Record new immutable metric snapshot with explicit availability metadata
    const newSnapshot = await this.verificationRepo.createMetricSnapshot({
      submissionId,
      views: providerResult.views,
      likes: providerResult.likes,
      comments: providerResult.comments,
      shares: providerResult.shares,
      metadata: {
        availability: providerResult.availability || {
          views: providerResult.views !== null ? 'AVAILABLE' : 'UNAVAILABLE',
          likes: providerResult.likes !== null ? 'AVAILABLE' : 'UNAVAILABLE',
          comments: providerResult.comments !== null ? 'AVAILABLE' : 'UNAVAILABLE',
          shares: providerResult.shares !== null ? 'AVAILABLE' : 'NOT_SUPPORTED',
          duration: durationAvailability
        },
        ...(providerResult.metadata || {})
      }
    });

    // 8. Perform signal analysis using configurable policy
    const signals = analyzeMetricSignals(newSnapshot, historicalSnapshots, this.policy);

    // 9. Deterministic explainable risk assessment
    const assessment = assessVerificationRisk(signals, this.policy);

    // 10. Persist signals and update verification state
    await this.verificationRepo.addVerificationSignals(verification.id, signals);
    await this.verificationRepo.upsertVerification({
      submissionId,
      status: 'COMPLETED',
      riskLevel: assessment.riskLevel,
      score: assessment.score,
      completedAt: new Date()
    });

    // 11. Decoupled Approval Decision: Risk Level != Submission Approval
    const approvalDecision = this.approvalPolicy.evaluateApprovalDecision({
      riskLevel: assessment.riskLevel,
      primaryReasons: assessment.primaryReasons,
      submission
    });

    // Retention policy activation on approval (Phase 10B)
    let retentionUpdate = {};
    if (approvalDecision.status === 'APPROVED' && submission.retentionRequired) {
      const approvedAt = new Date();
      const retentionDays = submission.retentionDays || submission.requirementsSnapshot?.retentionDays || 0;
      const retentionDeadline = new Date(approvedAt.getTime() + retentionDays * 86400000);
      retentionUpdate = {
        approvedAt,
        retentionDeadline,
        retentionStatus: 'ACTIVE'
      };
    }

    const mainUpdateData = {
      status: approvalDecision.status,
      verifiedAt: new Date(),
      rejectionReason: approvalDecision.reason,
      durationSeconds,
      durationStatus: durationAvailability,
      lastAvailabilityStatus: providerResult.status === 'AVAILABLE' ? 'AVAILABLE' : providerResult.status,
      moderatedAt: new Date(),
      moderatedBy: 'SYSTEM',
      ...retentionUpdate
    };

    if (typeof this.submissionRepo.updateSubmission === 'function') {
      await this.submissionRepo.updateSubmission(submissionId, mainUpdateData);
    } else {
      await this.submissionRepo.updateSubmissionStatus(submissionId, approvalDecision.status, mainUpdateData);
    }

    if (this.moderationRepo && typeof this.moderationRepo.createHistoryEntry === 'function') {
      const action = approvalDecision.status === 'APPROVED' ? MODERATION_ACTIONS.AUTO_APPROVED :
                     approvalDecision.status === 'UNDER_REVIEW' ? MODERATION_ACTIONS.SENT_TO_REVIEW :
                     MODERATION_ACTIONS.AUTO_REJECTED;
      await this.moderationRepo.createHistoryEntry({
        submissionId,
        action,
        previousStatus: submission.status,
        newStatus: approvalDecision.status,
        actorDiscordId: 'SYSTEM',
        actorType: 'SYSTEM',
        reason: approvalDecision.reason,
        verificationId: verification.id,
        evidence: {
          riskLevel: assessment.riskLevel,
          score: assessment.score,
          primaryReasons: assessment.primaryReasons,
          signalsCount: signals.length
        }
      }).catch(e => logger.warn({ submissionId, err: e.message }, 'Failed to record moderation history'));
    }

    if (approvalDecision.status === 'UNDER_REVIEW' && submission.user?.discordId) {
      notifySubmissionUnderReview({
        discordId: submission.user.discordId,
        campaignName: submission.campaign?.name,
        videoUrl: submission.url
      }).catch(e => logger.warn({ submissionId, err: e.message }, 'Failed to notify creator of under review'));
    }

    if (approvalDecision.status === 'FLAGGED' || assessment.riskLevel === 'HIGH_RISK' || signals.some(s => s.severity === 'CRITICAL')) {
      notifyStaffSuspiciousClip({
        submission,
        reason: approvalDecision.reason || assessment.primaryReasons?.join('; ') || 'High risk metric anomaly detected',
        snapshot: newSnapshot,
        signals
      }).catch(e => logger.warn({ submissionId, err: e.message }, 'Failed to dispatch staff alert for suspicious clip'));
    } else if (approvalDecision.status === 'UNDER_REVIEW') {
      notifyStaffManualReviewRequired({
        submission,
        reason: approvalDecision.reason || assessment.primaryReasons?.join('; ') || 'Submission requires staff review'
      }).catch(e => logger.warn({ submissionId, err: e.message }, 'Failed to dispatch staff alert for review'));
    }

    logger.info(
      {
        submissionId,
        riskLevel: assessment.riskLevel,
        score: assessment.score,
        signalsCount: signals.length,
        submissionStatus: approvalDecision.status,
        durationSeconds,
        retentionStatus: retentionUpdate.retentionStatus || submission.retentionStatus
      },
      'Submission verification pipeline completed'
    );

    return {
      status: 'COMPLETED',
      verificationId: verification.id,
      riskLevel: assessment.riskLevel,
      score: assessment.score,
      submissionStatus: approvalDecision.status,
      signals,
      snapshot: newSnapshot,
      durationSeconds,
      publishedAt: publishedAt ? publishedAt.toISOString() : null,
      submissionAgeSeconds,
      retentionStatus: retentionUpdate.retentionStatus || submission.retentionStatus
    };
  }

  /**
   * Check public video accessibility and evaluate retention status (Phase 10B)
   * @param {string} submissionId
   * @returns {Promise<{ isAvailable: boolean, availabilityStatus: string, retentionStatus: string|null, reason?: string }>}
   */
  async checkSubmissionAvailability(submissionId) {
    const submission = await this.submissionRepo.getSubmissionById(submissionId);
    if (!submission) {
      throw new VerificationFailedError(submissionId, 'Submission not found');
    }

    const provider = this.providerResolver(submission.platform);
    const { contentId } = parseAndNormalizeUrl(submission.url);

    const now = new Date();
    let availabilityResult;
    try {
      availabilityResult = await provider.getAvailability(submission.url || contentId);
    } catch (err) {
      if (err instanceof PermanentContentError) {
        availabilityResult = { isAvailable: false, status: 'UNAVAILABLE', reason: err.message };
      } else {
        throw err;
      }
    }

    const isAvailable = Boolean(availabilityResult.isAvailable);
    const availabilityStatus = availabilityResult.status || (isAvailable ? 'AVAILABLE' : 'UNAVAILABLE');

    let updatedRetentionStatus = submission.retentionStatus;
    let retentionViolatedAt = submission.retentionViolatedAt || null;
    let retentionViolationReason = submission.retentionViolationReason || null;

    // Evaluate retention status if submission is subject to retention
    if (submission.retentionStatus === 'ACTIVE') {
      if (!isAvailable) {
        // Video is deleted, private, or removed before deadline -> VIOLATED
        updatedRetentionStatus = 'VIOLATED';
        retentionViolatedAt = now;
        retentionViolationReason = availabilityResult.reason || 'Video is no longer publicly accessible before retention deadline';
      } else if (submission.retentionDeadline && now >= new Date(submission.retentionDeadline)) {
        // Video remained available throughout the retention window -> FULFILLED
        updatedRetentionStatus = 'FULFILLED';
      }
    }

    if (typeof this.submissionRepo.updateSubmission === 'function') {
      await this.submissionRepo.updateSubmission(submissionId, {
        lastAvailabilityStatus: availabilityStatus,
        retentionStatus: updatedRetentionStatus,
        retentionViolatedAt,
        retentionViolationReason
      });
    }

    logger.info(
      { submissionId, isAvailable, availabilityStatus, retentionStatus: updatedRetentionStatus },
      'Submission availability check completed'
    );

    return {
      isAvailable,
      availabilityStatus,
      retentionStatus: updatedRetentionStatus,
      reason: availabilityResult.reason
    };
  }

  /**
   * Get active verification record with signals
   * @param {string} submissionId
   */
  async getVerification(submissionId) {
    return this.verificationRepo.getVerificationBySubmissionId(submissionId);
  }

  /**
   * Get detected verification signals
   * @param {string} submissionId
   */
  async getVerificationSignals(submissionId) {
    const verification = await this.verificationRepo.getVerificationBySubmissionId(submissionId);
    return verification?.signals || [];
  }
}

export const verificationService = new VerificationService();
export default verificationService;
