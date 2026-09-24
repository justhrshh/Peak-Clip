import { Prisma } from '@prisma/client';
import { prisma } from '../../database/client.js';
import { payoutRepository as defaultPayoutRepo } from '../payouts/payout.repository.js';

export class StatisticsRepository {
  constructor(dbClient = prisma, payoutRepo = defaultPayoutRepo) {
    this.prisma = dbClient;
    this.payoutRepo = payoutRepo;
  }

  /**
   * Get user campaign membership for a specific campaign
   * @param {string} userId
   * @param {string} campaignId
   * @returns {Promise<object|null>}
   */
  async getCampaignMembership(userId, campaignId) {
    return this.prisma.campaignMember.findUnique({
      where: {
        userId_campaignId: {
          userId,
          campaignId
        }
      },
      include: {
        campaign: true
      }
    });
  }

  /**
   * Get all campaign memberships for a user
   * @param {string} userId
   * @returns {Promise<Array<object>>}
   */
  async getUserCampaignMemberships(userId) {
    return this.prisma.campaignMember.findMany({
      where: { userId },
      include: {
        campaign: true
      },
      orderBy: { joinedAt: 'desc' }
    });
  }

  /**
   * Get campaign by ID
   * @param {string} campaignId
   * @returns {Promise<object|null>}
   */
  async getCampaignById(campaignId) {
    return this.prisma.campaign.findUnique({
      where: { id: campaignId }
    });
  }

  /**
   * Fetch submissions belonging to a user (and optionally filtered by campaign)
   * with each submission's latest MetricSnapshot, latest Verification, and eligible earnings.
   *
   * @param {string} userId
   * @param {string|null} [campaignId=null]
   * @returns {Promise<Array<object>>}
   */
  async getUserSubmissionsWithLatestSnapshots(userId, campaignId = null) {
    const whereClause = { userId };
    if (campaignId) {
      whereClause.campaignId = campaignId;
    }

    return this.prisma.submission.findMany({
      where: whereClause,
      include: {
        campaign: {
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            payRate: true,
            creatorEarningCap: true,
            clientName: true
          }
        },
        snapshots: {
          orderBy: [
            { capturedAt: 'desc' },
            { id: 'desc' }
          ],
          take: 1
        },
        verifications: {
          orderBy: [
            { createdAt: 'desc' },
            { id: 'desc' }
          ],
          take: 1
        },
        earnings: {
          where: { status: 'ELIGIBLE' },
          select: {
            id: true,
            eligibleViews: true,
            grossAmount: true,
            currency: true,
            status: true
          }
        }
      },
      orderBy: { submittedAt: 'desc' }
    });
  }

  /**
   * Fetch a single submission by ID along with its campaign, latest verification,
   * eligible earnings, and complete historical snapshot sequence ordered chronologically.
   *
   * @param {string} submissionId
   * @returns {Promise<object|null>}
   */
  async getSubmissionWithHistory(submissionId) {
    return this.prisma.submission.findUnique({
      where: { id: submissionId },
      include: {
        campaign: true,
        verifications: {
          orderBy: [
            { createdAt: 'desc' },
            { id: 'desc' }
          ],
          take: 1,
          include: {
            signals: {
              select: {
                id: true,
                type: true,
                severity: true,
                explanation: true,
                createdAt: true
              }
            }
          }
        },
        snapshots: {
          orderBy: [
            { capturedAt: 'asc' },
            { id: 'asc' }
          ]
        },
        earnings: {
          where: { status: 'ELIGIBLE' },
          select: {
            id: true,
            eligibleViews: true,
            grossAmount: true,
            currency: true,
            status: true
          }
        }
      }
    });
  }

  /**
   * Get creator's authoritative payout balance breakdown
   * @param {string} userId
   * @param {string} [currency='USD']
   * @returns {Promise<object>}
   */
  async getCreatorPayoutBalances(userId, currency = 'USD') {
    return this.payoutRepo.getPayoutBalanceBreakdown(userId, currency);
  }

  /**
   * Get creator's campaigns breakdown (paginated)
   *
   * @param {string} userId
   * @param {object} [options={}]
   * @param {number} [options.page=1]
   * @param {number} [options.limit=5]
   * @returns {Promise<{ items: Array<object>, total: number, page: number, totalPages: number }>}
   */
  async getCreatorCampaignBreakdown(userId, { page = 1, limit = 5 } = {}) {
    const skip = (Math.max(1, page) - 1) * limit;

    const [total, memberships] = await Promise.all([
      this.prisma.campaignMember.count({ where: { userId } }),
      this.prisma.campaignMember.findMany({
        where: { userId },
        skip,
        take: limit,
        orderBy: { joinedAt: 'desc' },
        include: {
          campaign: true
        }
      })
    ]);

    const campaignIds = memberships.map((m) => m.campaignId);

    // Fetch user's submissions in these campaigns
    const submissions = await this.prisma.submission.findMany({
      where: {
        userId,
        campaignId: { in: campaignIds }
      },
      include: {
        snapshots: {
          orderBy: [
            { capturedAt: 'desc' },
            { id: 'desc' }
          ],
          take: 1
        },
        earnings: {
          where: { status: 'ELIGIBLE' }
        }
      }
    });

    // Fetch user's financial adjustments in these campaigns
    const adjustments = await this.prisma.financialAdjustment.findMany({
      where: {
        userId,
        campaignId: { in: campaignIds }
      }
    });

    const items = memberships.map((m) => {
      const camp = m.campaign;
      const campSubs = submissions.filter((s) => s.campaignId === camp.id);
      const campAdjustments = adjustments.filter((a) => a.campaignId === camp.id);

      let approvedClips = 0;
      let underReviewClips = 0;
      let rejectedClips = 0;
      let observedViewsSum = 0n;
      let eligibleViewsSum = 0n;
      let grossEarnings = new Prisma.Decimal('0.00');

      for (const s of campSubs) {
        if (s.status === 'APPROVED') approvedClips++;
        else if (s.status === 'UNDER_REVIEW' || s.status === 'PENDING_VERIFICATION' || s.status === 'FLAGGED' || s.status === 'POST_APPROVAL_REVIEW') underReviewClips++;
        else if (s.status === 'REJECTED') rejectedClips++;

        const latestSnap = s.snapshots?.[0];
        if (latestSnap?.views !== null && latestSnap?.views !== undefined) {
          observedViewsSum += BigInt(latestSnap.views);
        }

        for (const e of s.earnings || []) {
          eligibleViewsSum += BigInt(e.eligibleViews);
          grossEarnings = grossEarnings.plus(new Prisma.Decimal(e.grossAmount));
        }
      }

      let netAdjustments = new Prisma.Decimal('0.00');
      for (const a of campAdjustments) {
        netAdjustments = netAdjustments.plus(new Prisma.Decimal(a.amount));
      }

      const totalEarned = grossEarnings.plus(netAdjustments);
      const capDecimal = new Prisma.Decimal(camp.creatorEarningCap || 600);
      let capConsumedPercent = 0;
      if (capDecimal.greaterThan(0)) {
        capConsumedPercent = Number(
          totalEarned.dividedBy(capDecimal).times(100).toFixed(2)
        );
      }

      return {
        campaignId: camp.id,
        campaignName: camp.name,
        campaignSlug: camp.slug,
        campaignStatus: camp.status,
        clientName: camp.clientName,
        cpm: new Prisma.Decimal(camp.payRate).toFixed(2),
        creatorEarningCap: capDecimal.toFixed(2),
        currency: camp.currency,
        joinedAt: m.joinedAt,
        clips: {
          total: campSubs.length,
          approved: approvedClips,
          underReview: underReviewClips,
          rejected: rejectedClips
        },
        totalObservedViews: observedViewsSum,
        totalEligibleViews: eligibleViewsSum,
        grossEarnings: grossEarnings.toFixed(2),
        netAdjustments: netAdjustments.toFixed(2),
        totalEarned: totalEarned.toFixed(2),
        capConsumedPercent
      };
    });

    return {
      items,
      total,
      page: Math.max(1, page),
      totalPages: Math.ceil(total / limit) || 1
    };
  }

  /**
   * Get creator platform breakdown across all submissions
   *
   * @param {string} userId
   * @returns {Promise<Array<object>>}
   */
  async getCreatorPlatformBreakdown(userId) {
    const platforms = ['YOUTUBE', 'TIKTOK', 'INSTAGRAM', 'FACEBOOK'];

    const submissions = await this.prisma.submission.findMany({
      where: { userId },
      include: {
        snapshots: {
          orderBy: [
            { capturedAt: 'desc' },
            { id: 'desc' }
          ],
          take: 1
        },
        earnings: {
          where: { status: 'ELIGIBLE' }
        },
        financialAdjustments: true
      }
    });

    return platforms.map((plat) => {
      const platSubs = submissions.filter((s) => s.platform === plat);
      const totalClips = platSubs.length;
      let approvedClips = 0;
      let underReviewClips = 0;
      let rejectedClips = 0;

      let clipsWithViews = 0;
      let observedViewsSum = 0n;
      let eligibleViewsSum = 0n;
      let totalEarnings = new Prisma.Decimal('0.00');

      for (const s of platSubs) {
        if (s.status === 'APPROVED') approvedClips++;
        else if (s.status === 'UNDER_REVIEW' || s.status === 'PENDING_VERIFICATION' || s.status === 'FLAGGED' || s.status === 'POST_APPROVAL_REVIEW') underReviewClips++;
        else if (s.status === 'REJECTED') rejectedClips++;

        const snap = s.snapshots?.[0];
        if (snap?.views !== null && snap?.views !== undefined) {
          clipsWithViews++;
          observedViewsSum += BigInt(snap.views);
        }

        for (const e of s.earnings || []) {
          eligibleViewsSum += BigInt(e.eligibleViews);
          totalEarnings = totalEarnings.plus(new Prisma.Decimal(e.grossAmount));
        }

        for (const a of s.financialAdjustments || []) {
          totalEarnings = totalEarnings.plus(new Prisma.Decimal(a.amount));
        }
      }

      let availability = 'UNAVAILABLE';
      if (totalClips > 0 && clipsWithViews === totalClips) {
        availability = 'COMPLETE';
      } else if (clipsWithViews > 0) {
        availability = 'PARTIAL';
      }

      return {
        platform: plat,
        clips: {
          total: totalClips,
          approved: approvedClips,
          underReview: underReviewClips,
          rejected: rejectedClips
        },
        observedViews: {
          sum: clipsWithViews > 0 ? observedViewsSum : null,
          availability,
          countWithViews: clipsWithViews,
          totalClips
        },
        eligibleViews: eligibleViewsSum,
        totalEarnings: totalEarnings.toFixed(2)
      };
    });
  }

  /**
   * Get creator channel / account breakdown
   *
   * @param {string} userId
   * @returns {Promise<Array<object>>}
   */
  async getCreatorChannelBreakdown(userId) {
    const [submissions, payoutProfile] = await Promise.all([
      this.prisma.submission.findMany({
        where: { userId },
        include: {
          snapshots: {
            orderBy: [
              { capturedAt: 'desc' },
              { id: 'desc' }
            ],
            take: 1
          },
          earnings: {
            where: { status: 'ELIGIBLE' }
          },
          financialAdjustments: true
        }
      }),
      this.prisma.payoutProfile.findUnique({
        where: { userId }
      })
    ]);

    const channelMap = new Map();

    for (const s of submissions) {
      const snap = s.snapshots?.[0];
      const meta = snap?.metadata || {};
      let channelName = meta.channelTitle || meta.channelId || null;

      if (!channelName && payoutProfile && payoutProfile.platform === s.platform && payoutProfile.creatorHandle) {
        channelName = payoutProfile.creatorHandle;
      }

      if (!channelName) {
        channelName = 'Unknown / Unspecified';
      }

      const key = `${s.platform}:${channelName}`;
      if (!channelMap.has(key)) {
        channelMap.set(key, {
          channelName,
          platform: s.platform,
          totalClips: 0,
          approvedClips: 0,
          observedViews: 0n,
          hasViews: false,
          eligibleViews: 0n,
          totalEarnings: new Prisma.Decimal('0.00')
        });
      }

      const entry = channelMap.get(key);
      entry.totalClips++;
      if (s.status === 'APPROVED') entry.approvedClips++;

      if (snap?.views !== null && snap?.views !== undefined) {
        entry.hasViews = true;
        entry.observedViews += BigInt(snap.views);
      }

      for (const e of s.earnings || []) {
        entry.eligibleViews += BigInt(e.eligibleViews);
        entry.totalEarnings = entry.totalEarnings.plus(new Prisma.Decimal(e.grossAmount));
      }

      for (const a of s.financialAdjustments || []) {
        entry.totalEarnings = entry.totalEarnings.plus(new Prisma.Decimal(a.amount));
      }
    }

    return Array.from(channelMap.values()).map((ch) => ({
      channelName: ch.channelName,
      platform: ch.platform,
      clips: {
        total: ch.totalClips,
        approved: ch.approvedClips
      },
      observedViews: ch.hasViews ? ch.observedViews : null,
      eligibleViews: ch.eligibleViews,
      totalEarnings: ch.totalEarnings.toFixed(2)
    }));
  }

  /**
   * Get paginated creator videos / clips with status, retention, latest views, and earnings
   *
   * @param {string} userId
   * @param {object} [options={}]
   * @param {string|null} [options.campaignId=null]
   * @param {number} [options.page=1]
   * @param {number} [options.limit=10]
   * @returns {Promise<{ items: Array<object>, total: number, page: number, totalPages: number }>}
   */
  async getCreatorVideos(userId, { campaignId = null, page = 1, limit = 10 } = {}) {
    const skip = (Math.max(1, page) - 1) * limit;

    const where = { userId };
    if (campaignId && campaignId !== 'all') {
      where.campaignId = campaignId;
    }

    const [total, submissions] = await Promise.all([
      this.prisma.submission.count({ where }),
      this.prisma.submission.findMany({
        where,
        skip,
        take: limit,
        orderBy: { submittedAt: 'desc' },
        include: {
          campaign: {
            select: {
              id: true,
              name: true,
              slug: true,
              status: true
            }
          },
          snapshots: {
            orderBy: [
              { capturedAt: 'desc' },
              { id: 'desc' }
            ],
            take: 1
          },
          verifications: {
            orderBy: [
              { createdAt: 'desc' },
              { id: 'desc' }
            ],
            take: 1
          },
          earnings: {
            where: { status: 'ELIGIBLE' }
          },
          financialAdjustments: true
        }
      })
    ]);

    const items = submissions.map((s) => {
      const snap = s.snapshots?.[0];
      const ver = s.verifications?.[0];
      const title = snap?.metadata?.title || null;

      let eligibleViews = 0n;
      let grossEarnings = new Prisma.Decimal('0.00');

      for (const e of s.earnings || []) {
        eligibleViews += BigInt(e.eligibleViews);
        grossEarnings = grossEarnings.plus(new Prisma.Decimal(e.grossAmount));
      }

      let netAdjustments = new Prisma.Decimal('0.00');
      for (const a of s.financialAdjustments || []) {
        netAdjustments = netAdjustments.plus(new Prisma.Decimal(a.amount));
      }

      return {
        id: s.id,
        title,
        url: s.url,
        normalizedUrl: s.normalizedUrl,
        platform: s.platform,
        status: s.status,
        campaign: {
          id: s.campaign.id,
          name: s.campaign.name,
          slug: s.campaign.slug,
          status: s.campaign.status
        },
        submittedAt: s.submittedAt,
        verifiedAt: s.verifiedAt,
        rejectionReason: s.rejectionReason,
        retentionStatus: s.retentionStatus,
        retentionRequired: s.retentionRequired,
        retentionDeadline: s.retentionDeadline,
        durationSeconds: s.durationSeconds,
        riskLevel: ver?.riskLevel || null,
        latestViews: snap?.views !== null && snap?.views !== undefined ? BigInt(snap.views) : null,
        eligibleViews,
        grossEarnings: grossEarnings.toFixed(2),
        netAdjustments: netAdjustments.toFixed(2),
        totalEarned: grossEarnings.plus(netAdjustments).toFixed(2),
        lastCapturedAt: snap?.capturedAt || null
      };
    });

    return {
      items,
      total,
      page: Math.max(1, page),
      totalPages: Math.ceil(total / limit) || 1
    };
  }

  /**
   * Get comprehensive campaign analytics for admin control plane
   *
   * @param {string} campaignId
   * @param {object} [options={}]
   * @param {number} [options.page=1]
   * @param {number} [options.limit=10]
   * @param {'views'|'earnings'|'clips'|'activity'} [options.sortBy='views']
   * @param {'asc'|'desc'} [options.sortOrder='desc']
   * @returns {Promise<object|null>}
   */
  async getCampaignAnalytics(campaignId, { page = 1, limit = 10, sortBy = 'views', sortOrder = 'desc' } = {}) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId }
    });

    if (!campaign) return null;

    // Concurrently query submissions, members, earnings, and adjustments for this campaign
    const [members, submissions, earnings, adjustments] = await Promise.all([
      this.prisma.campaignMember.findMany({
        where: { campaignId },
        include: {
          user: {
            select: {
              id: true,
              discordId: true,
              username: true,
              displayName: true,
              status: true
            }
          }
        }
      }),
      this.prisma.submission.findMany({
        where: { campaignId },
        include: {
          snapshots: {
            orderBy: [
              { capturedAt: 'desc' },
              { id: 'desc' }
            ],
            take: 1
          },
          user: {
            select: {
              id: true,
              discordId: true,
              username: true,
              displayName: true
            }
          }
        }
      }),
      this.prisma.earning.findMany({
        where: { campaignId, status: 'ELIGIBLE' }
      }),
      this.prisma.financialAdjustment.findMany({
        where: { campaignId }
      })
    ]);

    // 1. Overview counts & status breakdown
    const statusCounts = {
      APPROVED: 0,
      PENDING_VERIFICATION: 0,
      UNDER_REVIEW: 0,
      FLAGGED: 0,
      POST_APPROVAL_REVIEW: 0,
      REJECTED: 0
    };

    let totalObservedViews = 0n;
    for (const s of submissions) {
      if (statusCounts[s.status] !== undefined) {
        statusCounts[s.status]++;
      }
      const snap = s.snapshots?.[0];
      if (snap?.views !== null && snap?.views !== undefined) {
        totalObservedViews += BigInt(snap.views);
      }
    }

    // 2. Financial reach & reconciliation
    let totalEligibleViews = 0n;
    let totalCreditedEarnings = new Prisma.Decimal('0.00');
    for (const e of earnings) {
      totalEligibleViews += BigInt(e.eligibleViews);
      totalCreditedEarnings = totalCreditedEarnings.plus(new Prisma.Decimal(e.grossAmount));
    }

    let netAdjustments = new Prisma.Decimal('0.00');
    for (const a of adjustments) {
      netAdjustments = netAdjustments.plus(new Prisma.Decimal(a.amount));
    }

    const totalBudgetLoad = totalCreditedEarnings.plus(netAdjustments);
    const totalBudget = new Prisma.Decimal(campaign.totalBudget || 0);
    const consumedBudget = new Prisma.Decimal(campaign.consumedBudget || 0);
    const remainingBudget = Prisma.Decimal.max(0, totalBudget.minus(consumedBudget));
    let fulfillmentPercent = 0;
    if (totalBudget.greaterThan(0)) {
      fulfillmentPercent = Number(consumedBudget.dividedBy(totalBudget).times(100).toFixed(2));
    }

    // 3. Platform breakdown
    const platformMap = new Map();
    for (const plat of ['YOUTUBE', 'TIKTOK', 'INSTAGRAM', 'FACEBOOK']) {
      platformMap.set(plat, {
        platform: plat,
        totalSubmissions: 0,
        approvedSubmissions: 0,
        observedViews: 0n,
        eligibleViews: 0n,
        creditedEarnings: new Prisma.Decimal('0.00')
      });
    }

    for (const s of submissions) {
      const pEntry = platformMap.get(s.platform);
      if (pEntry) {
        pEntry.totalSubmissions++;
        if (s.status === 'APPROVED') pEntry.approvedSubmissions++;
        const snap = s.snapshots?.[0];
        if (snap?.views !== null && snap?.views !== undefined) {
          pEntry.observedViews += BigInt(snap.views);
        }
      }
    }

    for (const e of earnings) {
      // Find submission platform
      const sub = submissions.find((s) => s.id === e.submissionId);
      if (sub && platformMap.has(sub.platform)) {
        const pEntry = platformMap.get(sub.platform);
        pEntry.eligibleViews += BigInt(e.eligibleViews);
        pEntry.creditedEarnings = pEntry.creditedEarnings.plus(new Prisma.Decimal(e.grossAmount));
      }
    }

    const platforms = Array.from(platformMap.values()).map((p) => ({
      platform: p.platform,
      totalSubmissions: p.totalSubmissions,
      approvedSubmissions: p.approvedSubmissions,
      observedViews: p.observedViews,
      eligibleViews: p.eligibleViews,
      creditedEarnings: p.creditedEarnings.toFixed(2)
    }));

    // 4. Channel breakdown
    const channelMap = new Map();
    for (const s of submissions) {
      const snap = s.snapshots?.[0];
      const meta = snap?.metadata || {};
      const channelName = meta.channelTitle || meta.channelId || 'Unknown / Unspecified';
      const key = `${s.platform}:${channelName}`;

      if (!channelMap.has(key)) {
        channelMap.set(key, {
          channelName,
          platform: s.platform,
          totalClips: 0,
          observedViews: 0n,
          creditedEarnings: new Prisma.Decimal('0.00')
        });
      }

      const ch = channelMap.get(key);
      ch.totalClips++;
      if (snap?.views !== null && snap?.views !== undefined) {
        ch.observedViews += BigInt(snap.views);
      }
    }

    for (const e of earnings) {
      const sub = submissions.find((s) => s.id === e.submissionId);
      if (sub) {
        const snap = sub.snapshots?.[0];
        const meta = snap?.metadata || {};
        const channelName = meta.channelTitle || meta.channelId || 'Unknown / Unspecified';
        const key = `${sub.platform}:${channelName}`;
        if (channelMap.has(key)) {
          const ch = channelMap.get(key);
          ch.creditedEarnings = ch.creditedEarnings.plus(new Prisma.Decimal(e.grossAmount));
        }
      }
    }

    const channels = Array.from(channelMap.values()).map((ch) => ({
      channelName: ch.channelName,
      platform: ch.platform,
      totalClips: ch.totalClips,
      observedViews: ch.observedViews,
      creditedEarnings: ch.creditedEarnings.toFixed(2)
    }));

    // 5. Creator performance table (Neutral, non-evaluative reporting)
    const creatorMap = new Map();

    // Initialize all members
    for (const m of members) {
      creatorMap.set(m.userId, {
        userId: m.userId,
        discordId: m.user.discordId,
        username: m.user.username,
        displayName: m.user.displayName,
        totalClips: 0,
        approvedClips: 0,
        eligibleViews: 0n,
        observedViews: 0n,
        creditedEarnings: new Prisma.Decimal('0.00'),
        lastActivity: m.joinedAt
      });
    }

    for (const s of submissions) {
      if (!creatorMap.has(s.userId)) {
        creatorMap.set(s.userId, {
          userId: s.userId,
          discordId: s.user?.discordId || 'unknown',
          username: s.user?.username || 'Unknown',
          displayName: s.user?.displayName || 'Unknown',
          totalClips: 0,
          approvedClips: 0,
          eligibleViews: 0n,
          observedViews: 0n,
          creditedEarnings: new Prisma.Decimal('0.00'),
          lastActivity: s.submittedAt
        });
      }
      const c = creatorMap.get(s.userId);
      c.totalClips++;
      if (s.status === 'APPROVED') c.approvedClips++;

      const snap = s.snapshots?.[0];
      if (snap?.views !== null && snap?.views !== undefined) {
        c.observedViews += BigInt(snap.views);
      }

      if (new Date(s.submittedAt) > new Date(c.lastActivity)) {
        c.lastActivity = s.submittedAt;
      }
    }

    for (const e of earnings) {
      const c = creatorMap.get(e.userId);
      if (c) {
        c.eligibleViews += BigInt(e.eligibleViews);
        c.creditedEarnings = c.creditedEarnings.plus(new Prisma.Decimal(e.grossAmount));
      }
    }

    for (const a of adjustments) {
      const c = creatorMap.get(a.userId);
      if (c) {
        c.creditedEarnings = c.creditedEarnings.plus(new Prisma.Decimal(a.amount));
      }
    }

    const capDecimal = new Prisma.Decimal(campaign.creatorEarningCap || 600);
    const allCreators = Array.from(creatorMap.values()).map((c) => {
      let capUsedPercent = 0;
      if (capDecimal.greaterThan(0)) {
        capUsedPercent = Number(
          c.creditedEarnings.dividedBy(capDecimal).times(100).toFixed(2)
        );
      }
      return {
        userId: c.userId,
        discordId: c.discordId,
        username: c.username,
        displayName: c.displayName,
        totalClips: c.totalClips,
        approvedClips: c.approvedClips,
        eligibleViews: c.eligibleViews,
        observedViews: c.observedViews,
        creditedEarnings: c.creditedEarnings.toFixed(2),
        capUsedPercent,
        lastActivity: c.lastActivity
      };
    });

    // Neutral sorting: views, earnings, clips, activity
    allCreators.sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'views') {
        if (a.eligibleViews > b.eligibleViews) cmp = 1;
        else if (a.eligibleViews < b.eligibleViews) cmp = -1;
      } else if (sortBy === 'earnings') {
        const earnA = new Prisma.Decimal(a.creditedEarnings);
        const earnB = new Prisma.Decimal(b.creditedEarnings);
        cmp = earnA.comparedTo(earnB);
      } else if (sortBy === 'clips') {
        cmp = a.totalClips - b.totalClips;
      } else if (sortBy === 'activity') {
        cmp = new Date(a.lastActivity).getTime() - new Date(b.lastActivity).getTime();
      }

      return sortOrder === 'asc' ? cmp : -cmp;
    });

    const totalCreators = allCreators.length;
    const skip = (Math.max(1, page) - 1) * limit;
    const paginatedCreators = allCreators.slice(skip, skip + limit);

    // Average credited earning per creator
    let avgCreditedEarning = new Prisma.Decimal('0.00');
    if (totalCreators > 0) {
      avgCreditedEarning = totalCreditedEarnings.dividedBy(totalCreators).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    }

    // 6. Final Financial Reconciliation
    const financialReconciliation = {
      totalBudget: totalBudget.toFixed(2),
      consumedBudget: consumedBudget.toFixed(2),
      remainingBudget: remainingBudget.toFixed(2),
      fulfillmentPercent,
      reconciledGrossEarnings: totalCreditedEarnings.toFixed(2),
      reconciledNetAdjustments: netAdjustments.toFixed(2),
      reconciledTotalLoad: totalBudgetLoad.toFixed(2),
      budgetDiscrepancy: consumedBudget.minus(totalBudgetLoad).toFixed(2),
      isReconciled: consumedBudget.equals(totalBudgetLoad)
    };

    return {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        slug: campaign.slug,
        clientName: campaign.clientName,
        status: campaign.status,
        cpm: new Prisma.Decimal(campaign.payRate).toFixed(2),
        creatorEarningCap: capDecimal.toFixed(2),
        currency: campaign.currency,
        startsAt: campaign.startsAt,
        endsAt: campaign.endsAt,
        retentionRequired: campaign.retentionRequired,
        retentionDays: campaign.retentionDays
      },
      overview: {
        totalSubmissions: submissions.length,
        statusBreakdown: statusCounts,
        activeMembers: members.filter((m) => m.status === 'ACTIVE').length,
        totalMembers: members.length
      },
      reach: {
        totalObservedViews,
        totalEligibleViews
      },
      financial: {
        totalBudget: totalBudget.toFixed(2),
        consumedBudget: consumedBudget.toFixed(2),
        remainingBudget: remainingBudget.toFixed(2),
        fulfillmentPercent,
        totalCreditedEarnings: totalCreditedEarnings.toFixed(2),
        netAdjustments: netAdjustments.toFixed(2),
        totalCreators,
        avgCreditedEarning: avgCreditedEarning.toFixed(2)
      },
      platforms,
      channels,
      creators: {
        items: paginatedCreators,
        total: totalCreators,
        page: Math.max(1, page),
        totalPages: Math.ceil(totalCreators / limit) || 1,
        sortBy,
        sortOrder
      },
      financialReconciliation
    };
  }
}

export const statisticsRepository = new StatisticsRepository();
export default statisticsRepository;
