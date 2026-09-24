import { prisma } from '../../database/client.js';

export class SubmissionRepository {
  constructor(dbClient = prisma) {
    this.db = dbClient;
  }

  /**
   * Create a new video submission record with Phase 10B snapshot and policy fields
   * @param {object} params
   * @param {string} params.userId
   * @param {string} params.campaignId
   * @param {'YOUTUBE'|'TIKTOK'|'INSTAGRAM'|'FACEBOOK'} params.platform
   * @param {string} params.url
   * @param {string} params.normalizedUrl
   * @param {object} [params.requirementsSnapshot]
   * @param {boolean} [params.retentionRequired=false]
   * @param {number|null} [params.retentionDays=null]
   * @param {string} [params.retentionStatus='NOT_REQUIRED']
   * @param {number|null} [params.durationSeconds=null]
   * @param {string} [params.durationStatus='PENDING_CHECK']
   * @returns {Promise<object>}
   */
  async createSubmission({
    userId,
    campaignId,
    platform,
    url,
    normalizedUrl,
    requirementsSnapshot = null,
    retentionRequired = false,
    retentionDays = null,
    retentionStatus = 'NOT_REQUIRED',
    durationSeconds = null,
    durationStatus = 'PENDING_CHECK'
  }) {
    return this.db.submission.create({
      data: {
        userId,
        campaignId,
        platform,
        url,
        normalizedUrl,
        status: 'PENDING_VERIFICATION',
        requirementsSnapshot,
        retentionRequired,
        retentionDays,
        retentionStatus,
        durationSeconds,
        durationStatus
      },
      include: {
        campaign: {
          select: { id: true, name: true, clientName: true, payRate: true, totalBudget: true, consumedBudget: true }
        }
      }
    });
  }

  /**
   * Get submission by ID
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async getSubmissionById(id) {
    return this.db.submission.findUnique({
      where: { id },
      include: {
        campaign: true,
        user: true
      }
    });
  }

  /**
   * Check for an active duplicate submission in the campaign for this normalized URL
   * Allows resubmission if an earlier submission was REJECTED.
   * Supports both (campaignId, normalizedUrl) and legacy (userId, campaignId, normalizedUrl).
   * @param {string} campaignIdOrUserId
   * @param {string} campaignIdOrNormalizedUrl
   * @param {string} [normalizedUrlOptional]
   * @returns {Promise<object|null>}
   */
  async findDuplicateSubmission(campaignIdOrUserId, campaignIdOrNormalizedUrl, normalizedUrlOptional) {
    let campaignId = campaignIdOrUserId;
    let normalizedUrl = campaignIdOrNormalizedUrl;

    if (normalizedUrlOptional !== undefined) {
      // Called with legacy (userId, campaignId, normalizedUrl) signature
      campaignId = campaignIdOrNormalizedUrl;
      normalizedUrl = normalizedUrlOptional;
    }

    return this.db.submission.findFirst({
      where: {
        campaignId,
        normalizedUrl,
        status: {
          not: 'REJECTED'
        }
      }
    });
  }

  /**
   * Get paginated submissions for a user
   * @param {string} userId
   * @param {object} [options={}]
   * @param {number} [options.page=1]
   * @param {number} [options.limit=5]
   * @param {string} [options.campaignId]
   * @returns {Promise<{ items: Array<object>, total: number, page: number, totalPages: number }>}
   */
  async getUserSubmissions(userId, { page = 1, limit = 5, campaignId = undefined } = {}) {
    const skip = (Math.max(1, page) - 1) * limit;

    const where = {
      userId,
      ...(campaignId ? { campaignId } : {})
    };

    const [total, items] = await Promise.all([
      this.db.submission.count({ where }),
      this.db.submission.findMany({
        where,
        skip,
        take: limit,
        orderBy: { submittedAt: 'desc' },
        include: {
          campaign: {
            select: { id: true, name: true, clientName: true }
          }
        }
      })
    ]);

    return {
      items,
      total,
      page,
      totalPages: Math.ceil(total / limit) || 1
    };
  }

  /**
   * Update submission status and verification details
   * @param {string} id
   * @param {'PENDING_VERIFICATION'|'UNDER_REVIEW'|'APPROVED'|'REJECTED'|'FLAGGED'} status
   * @param {object} [details={}]
   * @param {Date|null} [details.verifiedAt]
   * @param {string|null} [details.rejectionReason]
   * @returns {Promise<object>}
   */
  async updateSubmissionStatus(id, status, { verifiedAt = null, rejectionReason = null } = {}) {
    return this.db.submission.update({
      where: { id },
      data: {
        status,
        verifiedAt,
        rejectionReason,
        updatedAt: new Date()
      }
    });
  }

  /**
   * Update retention policy lifecycle status
   * @param {string} id
   * @param {object} params
   * @param {string} [params.retentionStatus]
   * @param {Date|null} [params.approvedAt]
   * @param {Date|null} [params.retentionDeadline]
   * @param {Date|null} [params.retentionViolatedAt]
   * @param {string|null} [params.retentionViolationReason]
   * @returns {Promise<object>}
   */
  async updateRetentionStatus(id, {
    retentionStatus,
    approvedAt,
    retentionDeadline,
    retentionViolatedAt = null,
    retentionViolationReason = null
  }) {
    const data = {};
    if (retentionStatus !== undefined) data.retentionStatus = retentionStatus;
    if (approvedAt !== undefined) data.approvedAt = approvedAt;
    if (retentionDeadline !== undefined) data.retentionDeadline = retentionDeadline;
    if (retentionViolatedAt !== undefined) data.retentionViolatedAt = retentionViolatedAt;
    if (retentionViolationReason !== undefined) data.retentionViolationReason = retentionViolationReason;

    return this.db.submission.update({
      where: { id },
      data: {
        ...data,
        updatedAt: new Date()
      }
    });
  }

  /**
   * Update video availability status
   * @param {string} id
   * @param {object} params
   * @param {string} params.lastAvailabilityStatus
   * @returns {Promise<object>}
   */
  async updateAvailabilityStatus(id, { lastAvailabilityStatus }) {
    return this.db.submission.update({
      where: { id },
      data: {
        lastAvailabilityStatus,
        updatedAt: new Date()
      }
    });
  }

  /**
   * Arbitrary submission field update
   * @param {string} id
   * @param {object} data
   * @returns {Promise<object>}
   */
  async updateSubmission(id, data) {
    return this.db.submission.update({
      where: { id },
      data: {
        ...data,
        updatedAt: new Date()
      }
    });
  }
}

export const submissionRepository = new SubmissionRepository();
export default submissionRepository;
