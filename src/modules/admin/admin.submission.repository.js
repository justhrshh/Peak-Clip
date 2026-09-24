import { prisma } from '../../database/client.js';

export class AdminSubmissionRepository {
  constructor(dbClient = prisma) {
    this.db = dbClient;
  }

  /**
   * List paginated submissions with operational filters and relations
   *
   * @param {object} [options={}]
   * @param {'PENDING_VERIFICATION'|'UNDER_REVIEW'|'APPROVED'|'REJECTED'|'FLAGGED'} [options.status]
   * @param {string} [options.campaignId]
   * @param {'YOUTUBE'|'TIKTOK'|'INSTAGRAM'} [options.platform]
   * @param {'LOW_RISK'|'REVIEW_REQUIRED'|'HIGH_RISK'} [options.riskLevel]
   * @param {number} [options.page=1]
   * @param {number} [options.limit=10]
   * @returns {Promise<{ items: Array<object>, total: number, page: number, totalPages: number }>}
   */
  async listSubmissions({
    status,
    campaignId,
    platform,
    riskLevel,
    userId,
    search,
    activeCampaign,
    page = 1,
    limit = 10
  } = {}) {
    const skip = (Math.max(1, page) - 1) * limit;

    const where = {};
    if (status && status !== 'ALL') where.status = status;
    if (campaignId) where.campaignId = campaignId;
    if (platform && platform !== 'ALL') where.platform = platform;
    if (userId) where.userId = userId;
    if (activeCampaign) {
      where.campaign = { status: 'ACTIVE' };
    }
    if (riskLevel) {
      where.verifications = {
        some: { riskLevel }
      };
    }
    if (search && search.trim()) {
      const q = search.trim();
      where.OR = [
        { id: { contains: q, mode: 'insensitive' } },
        { url: { contains: q, mode: 'insensitive' } },
        { normalizedUrl: { contains: q, mode: 'insensitive' } },
        { user: { username: { contains: q, mode: 'insensitive' } } },
        { user: { displayName: { contains: q, mode: 'insensitive' } } },
        { user: { discordId: { contains: q } } }
      ];
    }

    const [total, items] = await Promise.all([
      this.db.submission.count({ where }),
      this.db.submission.findMany({
        where,
        skip,
        take: limit,
        orderBy: { submittedAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              discordId: true,
              username: true,
              displayName: true,
              status: true
            }
          },
          campaign: {
            select: {
              id: true,
              name: true,
              slug: true,
              currency: true,
              payRate: true
            }
          },
          verifications: {
            take: 1,
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              status: true,
              riskLevel: true,
              score: true,
              completedAt: true,
              lastError: true
            }
          },
          snapshots: {
            take: 1,
            orderBy: { capturedAt: 'desc' },
            select: {
              id: true,
              views: true,
              likes: true,
              comments: true,
              shares: true,
              capturedAt: true
            }
          }
        }
      })
    ]);

    return {
      items,
      total,
      page: Math.max(1, page),
      totalPages: Math.ceil(total / limit) || 1
    };
  }

  /**
   * List submissions requiring human moderator attention
   * Filters specifically by UNDER_REVIEW, POST_APPROVAL_REVIEW, and FLAGGED statuses.
   *
   * @param {object} [options={}]
   * @param {string} [options.campaignId]
   * @param {'YOUTUBE'|'TIKTOK'|'INSTAGRAM'|'FACEBOOK'} [options.platform]
   * @param {number} [options.page=1]
   * @param {number} [options.limit=10]
   * @returns {Promise<{ items: Array<object>, total: number, page: number, totalPages: number }>}
   */
  async listReviewQueue({ campaignId, platform, page = 1, limit = 10, status, includePending = false } = {}) {
    const skip = (Math.max(1, page) - 1) * limit;
    const reviewStatuses = includePending
      ? ['PENDING_VERIFICATION', 'UNDER_REVIEW', 'POST_APPROVAL_REVIEW', 'FLAGGED']
      : ['UNDER_REVIEW', 'POST_APPROVAL_REVIEW', 'FLAGGED'];

    const where = {
      status: status ? status : { in: reviewStatuses }
    };

    if (campaignId) where.campaignId = campaignId;
    if (platform) where.platform = platform;

    const [total, items] = await Promise.all([
      this.db.submission.count({ where }),
      this.db.submission.findMany({
        where,
        skip,
        take: limit,
        orderBy: { submittedAt: 'asc' }, // Oldest pending review first
        include: {
          user: {
            select: {
              id: true,
              discordId: true,
              username: true,
              displayName: true,
              status: true
            }
          },
          campaign: {
            select: {
              id: true,
              name: true,
              slug: true,
              currency: true,
              payRate: true
            }
          },
          verifications: {
            take: 1,
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              status: true,
              riskLevel: true,
              score: true,
              completedAt: true,
              lastError: true
            }
          },
          snapshots: {
            take: 1,
            orderBy: { capturedAt: 'desc' },
            select: {
              id: true,
              views: true,
              likes: true,
              comments: true,
              shares: true,
              capturedAt: true
            }
          },
          moderationHistory: {
            take: 1,
            orderBy: { createdAt: 'desc' }
          }
        }
      })
    ]);

    return {
      items,
      total,
      page: Math.max(1, page),
      totalPages: Math.ceil(total / limit) || 1
    };
  }

  /**
   * Get submission with full operational verification details
   *
   * @param {string} submissionId
   * @returns {Promise<object|null>}
   */
  async getSubmissionWithFullDetails(submissionId) {
    return this.db.submission.findUnique({
      where: { id: submissionId },
      include: {
        user: {
          select: {
            id: true,
            discordId: true,
            username: true,
            displayName: true,
            status: true
          }
        },
        campaign: true,
        verifications: {
          orderBy: { createdAt: 'desc' },
          include: {
            signals: {
              orderBy: { createdAt: 'asc' }
            }
          }
        },
        snapshots: {
          orderBy: { capturedAt: 'desc' },
          take: 10
        },
        earnings: {
          where: { status: 'ELIGIBLE' },
          orderBy: { createdAt: 'desc' }
        },
        financialAdjustments: {
          orderBy: { createdAt: 'desc' }
        },
        moderationHistory: {
          orderBy: { createdAt: 'asc' }
        }
      }
    });
  }

  /**
   * Get minimal submission properties for metric provider lookup.
   * Avoids expensive multi-table relational joins.
   *
   * @param {string} submissionId
   * @returns {Promise<object|null>}
   */
  async getSubmissionBasic(submissionId) {
    return this.db.submission.findUnique({
      where: { id: submissionId },
      select: {
        id: true,
        platform: true,
        url: true,
        status: true,
        userId: true,
        campaignId: true
      }
    });
  }

  /**
   * Update submission status and rejection reason
   *
   * @param {string} submissionId
   * @param {object} data
   * @param {object} [tx]
   * @returns {Promise<object>}
   */
  async updateSubmission(submissionId, data, tx = null) {
    const client = tx || this.db;
    return client.submission.update({
      where: { id: submissionId },
      data: {
        ...data,
        updatedAt: new Date()
      }
    });
  }

  /**
   * Retrieve historical metric snapshots with growth delta calculations
   *
   * @param {string} submissionId
   * @param {object} [options={}]
   * @param {number} [options.page=1]
   * @param {number} [options.limit=5]
   * @returns {Promise<object|null>}
   */
  async getSubmissionAnalytics(submissionId, { page = 1, limit = 5 } = {}) {
    const submission = await this.db.submission.findUnique({
      where: { id: submissionId },
      include: {
        campaign: true,
        user: true,
        snapshots: {
          orderBy: { capturedAt: 'asc' }
        }
      }
    });

    if (!submission) return null;

    const allSnapshots = submission.snapshots || [];
    let prevViews = null;
    let prevLikes = null;
    let prevComments = null;
    let prevShares = null;

    const chronological = allSnapshots.map((snap) => {
      const v = snap.views != null ? Number(snap.views) : null;
      const l = snap.likes != null ? Number(snap.likes) : null;
      const c = snap.comments != null ? Number(snap.comments) : null;
      const s = snap.shares != null ? Number(snap.shares) : null;

      const viewsGained = prevViews != null && v != null ? Math.max(0, v - prevViews) : 0;
      const likesGained = prevLikes != null && l != null ? Math.max(0, l - prevLikes) : 0;
      const commentsGained = prevComments != null && c != null ? Math.max(0, c - prevComments) : 0;
      const sharesGained = prevShares != null && s != null ? Math.max(0, s - prevShares) : 0;

      if (v != null) prevViews = v;
      if (l != null) prevLikes = l;
      if (c != null) prevComments = c;
      if (s != null) prevShares = s;

      const engRate = v && v > 0 && (l != null || c != null || s != null)
        ? (((Number(l || 0) + Number(c || 0) + Number(s || 0)) / v) * 100).toFixed(2) + '%'
        : 'N/A';

      return {
        id: snap.id,
        capturedAt: snap.capturedAt,
        views: v,
        likes: l,
        comments: c,
        shares: s,
        viewsGained,
        likesGained,
        commentsGained,
        sharesGained,
        engagementRate: engRate,
        metadata: snap.metadata,
        status: snap.metadata?.status || (v != null ? 'AVAILABLE' : 'DATA_UNAVAILABLE')
      };
    });

    const reversed = [...chronological].reverse();
    const totalSnapshots = chronological.length;
    const totalPages = Math.ceil(totalSnapshots / limit) || 1;
    const safePage = Math.min(Math.max(1, page), totalPages);
    const paginatedItems = reversed.slice((safePage - 1) * limit, safePage * limit);

    const first = chronological[0] || null;
    const latest = chronological[chronological.length - 1] || null;
    const successfulChecks = chronological.filter((c) => c.views != null).length;
    const unavailableChecks = chronological.filter((c) => c.views == null).length;

    const totalViewsGained = first?.views != null && latest?.views != null
      ? Math.max(0, latest.views - first.views)
      : 0;

    return {
      submission,
      totalSnapshots,
      page: safePage,
      totalPages,
      items: paginatedItems,
      snapshots: paginatedItems,
      firstTracked: first,
      latestTracked: latest,
      totalViewsGained,
      successfulChecks,
      unavailableChecks
    };
  }

  /**
   * Get database-wide submission metrics for dashboard and reports
   *
   * @returns {Promise<object>}
   */
  async getSubmissionRegistryStats() {
    const [
      total,
      pending,
      underReview,
      approved,
      rejected,
      flagged,
      postApproval,
      youtubeCount,
      tiktokCount,
      instagramCount,
      facebookCount,
      trackedCount,
      unavailableCount
    ] = await Promise.all([
      this.db.submission.count(),
      this.db.submission.count({ where: { status: 'PENDING_VERIFICATION' } }),
      this.db.submission.count({ where: { status: 'UNDER_REVIEW' } }),
      this.db.submission.count({ where: { status: 'APPROVED' } }),
      this.db.submission.count({ where: { status: 'REJECTED' } }),
      this.db.submission.count({ where: { status: 'FLAGGED' } }),
      this.db.submission.count({ where: { status: 'POST_APPROVAL_REVIEW' } }),
      this.db.submission.count({ where: { platform: 'YOUTUBE' } }),
      this.db.submission.count({ where: { platform: 'TIKTOK' } }),
      this.db.submission.count({ where: { platform: 'INSTAGRAM' } }),
      this.db.submission.count({ where: { platform: 'FACEBOOK' } }),
      this.db.submission.count({ where: { snapshots: { some: { views: { not: null } } } } }),
      this.db.submission.count({ where: { lastAvailabilityStatus: { in: ['UNAVAILABLE', 'DATA_UNAVAILABLE', 'DELETED', 'PRIVATE', 'RATE_LIMITED', 'API_ERROR'] } } })
    ]);

    return {
      total,
      pending,
      underReview,
      approved,
      rejected,
      flagged,
      postApproval,
      byStatus: {
        PENDING_VERIFICATION: pending,
        UNDER_REVIEW: underReview,
        APPROVED: approved,
        REJECTED: rejected,
        FLAGGED: flagged,
        POST_APPROVAL_REVIEW: postApproval
      },
      byPlatform: {
        YOUTUBE: youtubeCount,
        TIKTOK: tiktokCount,
        INSTAGRAM: instagramCount,
        FACEBOOK: facebookCount
      },
      platforms: {
        youtube: youtubeCount,
        tiktok: tiktokCount,
        instagram: instagramCount,
        facebook: facebookCount
      },
      trackedCount,
      unavailableCount
    };
  }

}

export const adminSubmissionRepository = new AdminSubmissionRepository();
export default adminSubmissionRepository;
