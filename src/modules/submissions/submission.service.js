import { submissionRepository as defaultSubRepo } from './submission.repository.js';
import { campaignRepository as defaultCampRepo } from '../campaigns/campaign.repository.js';
import { userRepository as defaultUserRepo } from '../users/user.repository.js';
import { userService as defaultUserService } from '../users/user.service.js';
import { parseAndNormalizeUrl } from './url.parser.js';
import { getQueue, QUEUE_NAMES } from '../../queues/index.js';
import { logger } from '../../utils/logger.js';
import {
  CampaignNotJoinableError,
  NotCampaignMemberError,
  DuplicateSubmissionError,
  PlatformNotAllowedError,
  SubmissionNotFoundError,
  UserNotEligibleError,
  CampaignBudgetExhaustedSubmissionError
} from './submission.errors.js';

let _verificationService = null;
async function getVerificationService() {
  if (!_verificationService) {
    const mod = await import('../verification/verification.service.js');
    _verificationService = mod.verificationService;
  }
  return _verificationService;
}

export class SubmissionService {
  constructor(
    subRepo = defaultSubRepo,
    campRepo = defaultCampRepo,
    userRepo = defaultUserRepo,
    userService = defaultUserService,
    verificationService = null
  ) {
    this.subRepo = subRepo;
    this.campRepo = campRepo;
    this.userRepo = userRepo;
    this.userService = userService;
    this.verificationService = verificationService;
  }

  /**
   * Process and persist a new video submission from a creator
   * @param {object} params
   * @param {string} params.userId - Internal user UUID
   * @param {string} params.campaignId - Campaign UUID
   * @param {string} params.rawUrl - User-provided URL
   * @returns {Promise<object>} Created submission
   */
  async createSubmission({ userId, campaignId, rawUrl }) {
    // 1. Validate user eligibility
    const user = await this.userRepo.findById(userId);
    if (!user) {
      throw new UserNotEligibleError(userId, 'USER_NOT_FOUND');
    }
    if (user.status !== 'ACTIVE') {
      throw new UserNotEligibleError(userId, user.status);
    }

    // 2. Validate campaign active window and budget completion
    const campaign = await this.campRepo.findById(campaignId);
    if (!campaign) {
      throw new CampaignNotJoinableError(campaignId, 'Campaign does not exist');
    }
    if (campaign.status === 'COMPLETED' || (campaign.remainingBudget !== undefined && Number(campaign.remainingBudget) <= 0 && campaign.totalBudget && Number(campaign.totalBudget) > 0)) {
      throw new CampaignBudgetExhaustedSubmissionError(campaignId);
    }
    if (campaign.status !== 'ACTIVE') {
      throw new CampaignNotJoinableError(campaignId, `Campaign is currently ${campaign.status}`);
    }

    const now = new Date();
    if (now < new Date(campaign.startsAt)) {
      throw new CampaignNotJoinableError(campaignId, 'Campaign has not started yet');
    }
    if (now > new Date(campaign.endsAt)) {
      throw new CampaignNotJoinableError(campaignId, 'Campaign has already ended');
    }

    // 3. Verify active campaign membership
    const membership = await this.campRepo.findMembership(userId, campaignId);
    if (!membership || membership.status !== 'ACTIVE') {
      throw new NotCampaignMemberError(userId, campaignId);
    }

    // 4. Validate URL & detect platform
    const { platform, normalizedUrl, contentId } = parseAndNormalizeUrl(rawUrl);

    // 5. Verify platform is allowed by campaign requirements
    const allowedPlatforms = (campaign.requirements?.allowedPlatforms || ['youtube']).map((p) =>
      p.toUpperCase()
    );
    if (allowedPlatforms.length > 0 && !allowedPlatforms.includes(platform)) {
      throw new PlatformNotAllowedError(platform, allowedPlatforms);
    }

    // 6. Check for duplicates (Application layer check)
    const existing = await this.subRepo.findDuplicateSubmission(userId, campaignId, normalizedUrl);
    if (existing) {
      throw new DuplicateSubmissionError(normalizedUrl, {
        submissionId: existing.id,
        submittedAt: existing.submittedAt
      });
    }

    // 7. Snapshot campaign requirements at submission time (Phase 10B)
    const requirementsSnapshot = {
      allowedPlatforms,
      minClipDurationSeconds: campaign.minClipDurationSeconds ?? 7,
      maxClipDurationSeconds: campaign.maxClipDurationSeconds ?? 120,
      retentionRequired: Boolean(campaign.retentionRequired),
      retentionDays: campaign.retentionDays ?? null,
      payRate: campaign.payRate != null ? campaign.payRate.toString() : '0.00',
      creatorEarningCap: campaign.creatorEarningCap != null ? campaign.creatorEarningCap.toString() : null,
      capturedAt: new Date().toISOString()
    };

    const retentionRequired = Boolean(campaign.retentionRequired);
    const retentionDays = campaign.retentionDays || null;
    const retentionStatus = retentionRequired ? 'PENDING_CHECK' : 'NOT_REQUIRED';

    // 8. Persist submission (Database level race condition guard)
    let submission;
    try {
      submission = await this.subRepo.createSubmission({
        userId,
        campaignId,
        platform,
        url: rawUrl.trim(),
        normalizedUrl,
        requirementsSnapshot,
        retentionRequired,
        retentionDays,
        retentionStatus
      });
      logger.info(
        { submissionId: submission.id, platform, campaignId, userId },
        'Submission created successfully with requirements snapshot'
      );
    } catch (dbError) {
      // Prisma P2002: Unique constraint violation on (userId, campaignId, normalizedUrl)
      if (dbError.code === 'P2002') {
        throw new DuplicateSubmissionError(normalizedUrl, { originalError: dbError.message });
      }
      throw dbError;
    }

    // 8. Safely enqueue verification job (idempotent with deduplication jobId)
    await this.queueVerificationJob(submission.id);

    // 9. Instant Verification & Auto-Approval upon upload
    const verService = this.verificationService || (this.subRepo === defaultSubRepo ? await getVerificationService() : null);
    if (verService && typeof verService.runVerification === 'function') {
      try {
        await verService.runVerification(submission.id, { forceRefresh: true });
        const refreshed = await this.subRepo.getSubmissionById(submission.id);
        if (refreshed) {
          submission = refreshed;
        }
      } catch (verErr) {
        logger.warn(
          { submissionId: submission.id, err: verErr.message },
          'Instant verification deferred to background worker'
        );
      }
    }

    return submission;
  }

  /**
   * Enqueue verification job safely with deduplication
   * @param {string} submissionId
   */
  async queueVerificationJob(submissionId) {
    try {
      const queue = getQueue(QUEUE_NAMES.VERIFICATION);
      await queue.add(
        'verification:submission',
        { submissionId },
        {
          jobId: `verify_${submissionId}`, // Deduplication key
          removeOnComplete: true,
          attempts: 3
        }
      );
      logger.debug({ submissionId }, 'Verification job successfully enqueued');
    } catch (queueErr) {
      // Redis might be in deferred/offline mode in development
      logger.warn(
        { submissionId, err: queueErr.message },
        'Unable to enqueue verification job immediately; will run in deferred mode'
      );
    }
  }

  /**
   * Get single submission by ID
   * @param {string} id
   * @returns {Promise<object>}
   */
  async getSubmissionById(id) {
    const sub = await this.subRepo.getSubmissionById(id);
    if (!sub) {
      throw new SubmissionNotFoundError(id);
    }
    return sub;
  }

  /**
   * Get user submissions with pagination
   * @param {string} userId
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async getUserSubmissions(userId, options = {}) {
    return this.subRepo.getUserSubmissions(userId, options);
  }
}

export const submissionService = new SubmissionService();
export default submissionService;
