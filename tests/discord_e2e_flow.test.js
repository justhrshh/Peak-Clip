import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { Collection } from 'discord.js';
import { config } from '../src/config/index.js';

import * as registerCommand from '../src/bot/commands/register.js';
import * as campaignsCommand from '../src/bot/commands/campaigns.js';
import * as statisticsCommand from '../src/bot/commands/statistics.js';
import * as earningsCommand from '../src/bot/commands/earnings.js';
import * as payoutCommand from '../src/bot/commands/payout.js';

import { handleCampaignJoin } from '../src/bot/interactions/campaign.interactions.js';
import { handleModalSubmitClip } from '../src/bot/interactions/submission.interactions.js';
import {
  handlePayoutRequestButton,
  handlePayoutModalSubmit,
  handlePayoutEvidenceSubmitButton
} from '../src/bot/interactions/payout.interactions.js';
import { handleAdminButtonInteraction } from '../src/bot/interactions/admin.interactions.js';

import { userService } from '../src/modules/users/user.service.js';
import { campaignService } from '../src/modules/campaigns/campaign.service.js';
import { submissionService } from '../src/modules/submissions/submission.service.js';
import { statisticsService } from '../src/modules/statistics/statistics.service.js';
import { earningsService } from '../src/modules/earnings/earnings.service.js';
import { payoutService } from '../src/modules/payouts/payout.service.js';
import { payoutProfileService } from '../src/modules/payout-profile/payout-profile.service.js';
import { payoutDraftManager } from '../src/modules/payouts/payout-draft.manager.js';
import { buildMockMp4Buffer } from '../src/modules/evidence/evidence.validator.js';
import { adminPayoutService } from '../src/modules/admin/admin.payout.service.js';
import { VerificationService } from '../src/modules/verification/verification.service.js';
import { ApprovalPolicy } from '../src/modules/verification/approval.policy.js';

describe('Discord End-to-End Application Lifecycle Flow', () => {
  const ADMIN_ROLE_ID = 'dev_admin_role_snowflake';
  const CREATOR_ROLE_ID = 'dev_creator_role_snowflake';

  // In-memory unified lifecycle store
  const store = {
    users: new Map(),
    campaigns: new Map(),
    memberships: new Map(),
    submissions: new Map(),
    snapshots: new Map(),
    verifications: new Map(),
    earnings: new Map(),
    payoutProfiles: new Map(),
    payoutEvidence: new Map(),
    payoutRequests: new Map(),
    disbursements: new Map(),
    payoutEvents: [],
    auditLogs: []
  };

  let originalAdminRoleIds;
  let originalServices = {};

  beforeEach(() => {
    // Clear in-memory store
    store.users.clear();
    store.campaigns.clear();
    store.memberships.clear();
    store.submissions.clear();
    store.snapshots.clear();
    store.verifications.clear();
    store.earnings.clear();
    store.payoutProfiles.clear();
    store.payoutEvidence.clear();
    store.payoutRequests.clear();
    store.disbursements.clear();
    store.payoutEvents.length = 0;
    store.auditLogs.length = 0;

    // Configure Admin Role and Creator Role
    originalAdminRoleIds = config.admin.adminRoleIds;
    config.admin.adminRoleIds = [ADMIN_ROLE_ID];
    config.discord.creatorRoleId = CREATOR_ROLE_ID;

    // Seed Active Campaign
    store.campaigns.set('cmp_gaming_2026', {
      id: 'cmp_gaming_2026',
      name: 'Fall 2026 Gaming Showcase',
      slug: 'fall-2026-gaming',
      clientName: 'Apex Studio',
      payRate: new Prisma.Decimal('2.00'), // $2.00 per 1k views = $0.002/view
      currency: 'USD',
      startsAt: new Date(Date.now() - 86400000), // 1 day ago
      endsAt: new Date(Date.now() + 86400000 * 30), // 30 days ahead
      status: 'ACTIVE',
      allowedPlatforms: ['YOUTUBE'],
      minViews: 1000,
      maxPayoutPerCreator: new Prisma.Decimal('5000.00'),
      totalBudget: new Prisma.Decimal('20000.00'),
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // Wire in-memory mock repositories to domain services
    originalServices = {
      userService_userRepo: userService.userRepo,
      campaignService_campaignRepo: campaignService.campaignRepo,
      submissionService_subRepo: submissionService.subRepo,
      submissionService_campRepo: submissionService.campRepo,
      submissionService_userRepo: submissionService.userRepo,
      submissionService_queue: submissionService.queueVerificationJob,
      statisticsService_repo: statisticsService.repo,
      earningsService_repo: earningsService.repo,
      earningsService_campaignRepo: earningsService.campaignRepo,
      payoutService_repo: payoutService.repo,
      adminPayoutService_disbursementRouter: adminPayoutService.disbursementRouter,
      payoutProfileService_getProfile: payoutProfileService.getProfile,
      payoutProfileService_getProfileByUserId: payoutProfileService.getProfileByUserId,
      payoutProfileService_saveProfile: payoutProfileService.saveProfile
    };

    payoutProfileService.getProfile = async (userId) => {
      return store.payoutProfiles.get(userId) || null;
    };
    payoutProfileService.getProfileByUserId = payoutProfileService.getProfile;
    payoutProfileService.saveProfile = async (userId, data) => {
      const prof = {
        id: `prof_${Date.now()}`,
        userId,
        walletAddress: data.walletAddress,
        network: data.network,
        walletName: data.walletName || 'Standard',
        platform: data.platform || 'YOUTUBE',
        createdAt: new Date(),
        updatedAt: new Date()
      };
      store.payoutProfiles.set(userId, prof);
      return prof;
    };

    // User Repo Mock
    const mockUserRepo = {
      async upsertFromDiscord({ discordId, username, displayName, avatarUrl }) {
        let u = Array.from(store.users.values()).find((user) => user.discordId === discordId);
        if (!u) {
          u = {
            id: `usr_${discordId}`,
            discordId,
            username,
            displayName,
            avatarUrl,
            status: 'ACTIVE',
            createdAt: new Date(),
            updatedAt: new Date(),
            lastSeenAt: new Date()
          };
          store.users.set(u.id, u);
        }
        return u;
      },
      async findByDiscordId(discordId) {
        return Array.from(store.users.values()).find((u) => u.discordId === discordId) || null;
      },
      async findById(id) {
        return store.users.get(id) || null;
      },
      async findWithMemberships(id) {
        const u = store.users.get(id);
        if (!u) return null;
        const mems = Array.from(store.memberships.values()).filter((m) => m.userId === id);
        return { ...u, memberships: mems };
      },
      async updateLastSeen(id) {
        const u = store.users.get(id);
        if (u) u.lastSeenAt = new Date();
        return u;
      }
    };

    // Campaign Repo Mock
    const mockCampRepo = {
      async findActive() {
        return Array.from(store.campaigns.values()).filter((c) => c.status === 'ACTIVE');
      },
      async findById(id) {
        return store.campaigns.get(id) || null;
      },
      async findMembership(userId, campaignId) {
        const key = `${userId}_${campaignId}`;
        return store.memberships.get(key) || null;
      },
      async createMembership({ userId, campaignId }) {
        const key = `${userId}_${campaignId}`;
        const mem = {
          id: `mem_${Date.now()}`,
          userId,
          campaignId,
          status: 'ACTIVE',
          joinedAt: new Date()
        };
        store.memberships.set(key, mem);
        return mem;
      },
      async upsertMembership(userId, campaignId, status = 'ACTIVE') {
        const key = `${userId}_${campaignId}`;
        const mem = {
          id: `mem_${Date.now()}`,
          userId,
          campaignId,
          status,
          joinedAt: new Date()
        };
        store.memberships.set(key, mem);
        return mem;
      },
      async getUserMemberships(userId) {
        return Array.from(store.memberships.values()).filter((m) => m.userId === userId);
      },
      async findUserMemberships(userId) {
        return Array.from(store.memberships.values()).filter((m) => m.userId === userId);
      },
      async consumeBudget(campaignId, amount) {
        const camp = store.campaigns.get(campaignId);
        if (camp) {
          const amt = new Prisma.Decimal(amount.toString());
          camp.consumedBudget = (camp.consumedBudget || new Prisma.Decimal('0.00')).plus(amt);
        }
        return camp;
      }
    };

    // Submission Repo Mock
    const mockSubRepo = {
      async createSubmission({ userId, campaignId, platform, url, normalizedUrl }) {
        const sub = {
          id: `sub_${Date.now()}`,
          userId,
          campaignId,
          platform,
          url,
          normalizedUrl,
          status: 'PENDING_VERIFICATION',
          submittedAt: new Date(),
          updatedAt: new Date(),
          campaign: store.campaigns.get(campaignId)
        };
        store.submissions.set(sub.id, sub);
        return sub;
      },
      async getSubmissionById(id) {
        return store.submissions.get(id) || null;
      },
      async findDuplicateSubmission(userId, campaignId, normalizedUrl) {
        for (const s of store.submissions.values()) {
          if (s.userId === userId && s.campaignId === campaignId && s.normalizedUrl === normalizedUrl) {
            return s;
          }
        }
        return null;
      },
      async updateSubmissionStatus(id, status) {
        const sub = store.submissions.get(id);
        if (!sub) throw new Error('Not found');
        sub.status = status;
        sub.updatedAt = new Date();
        return sub;
      }
    };

    // Verification Repo Mock
    const mockVerRepo = {
      async getVerificationBySubmissionId(submissionId) {
        return store.verifications.get(submissionId) || null;
      },
      async getLatestVerificationBySubmissionId(submissionId) {
        return store.verifications.get(submissionId) || null;
      },
      async upsertVerification(data) {
        let v = store.verifications.get(data.submissionId);
        if (!v) {
          v = { id: `ver_${Date.now()}`, ...data };
          store.verifications.set(data.submissionId, v);
        } else {
          Object.assign(v, data);
        }
        return v;
      },
      async addVerificationSignals() {
        return [];
      },
      async getHistoricalSnapshots(submissionId) {
        return Array.from(store.snapshots.values()).filter((s) => s.submissionId === submissionId);
      },
      async createMetricSnapshot(data) {
        const snap = { id: `snap_${Date.now()}`, ...data, capturedAt: new Date() };
        store.snapshots.set(snap.id, snap);
        return snap;
      }
    };

    // Earnings Repo Mock
    const mockEarningsRepo = {
      async transaction(cb) {
        return cb(mockEarningsRepo);
      },
      async acquireSubmissionLock() {},
      async getSubmissionForEarnings(submissionId) {
        const sub = store.submissions.get(submissionId);
        if (!sub) return null;
        const camp = store.campaigns.get(sub.campaignId);
        const ver = store.verifications.get(submissionId);
        const snaps = Array.from(store.snapshots.values()).filter((s) => s.submissionId === submissionId);
        return {
          ...sub,
          campaign: camp,
          verifications: ver ? [ver] : [],
          snapshots: snaps.length > 0 ? [snaps[snaps.length - 1]] : []
        };
      },
      async getSnapshotById(id) {
        return store.snapshots.get(id) || null;
      },
      async getPreviouslyCreditedViews(submissionId) {
        let sum = 0n;
        for (const e of store.earnings.values()) {
          if (e.submissionId === submissionId && e.status !== 'VOIDED') {
            sum += BigInt(e.eligibleViews);
          }
        }
        return sum;
      },
      async getEarningBySnapshotId(snapshotId) {
        for (const e of store.earnings.values()) {
          if (e.sourceSnapshotId === snapshotId && e.status !== 'VOIDED') return e;
        }
        return null;
      },
      async createEarning(data) {
        const earn = { id: `earn_${Date.now()}`, ...data, createdAt: new Date() };
        store.earnings.set(earn.id, earn);
        return earn;
      },
      async getUserEarningsBreakdown(userId, currency = 'USD') {
        let eligible = new Prisma.Decimal('0.00');
        let totalViews = 0n;
        for (const e of store.earnings.values()) {
          if (e.userId === userId && e.status === 'ELIGIBLE' && e.currency === currency) {
            eligible = eligible.add(e.amount);
            totalViews += BigInt(e.eligibleViews);
          }
        }
        return {
          totalEligible: eligible,
          totalVoided: new Prisma.Decimal('0.00'),
          totalCreditedViews: totalViews
        };
      },
      async getCampaignEarningsSummary(userId, campaignId) {
        let total = new Prisma.Decimal('0.00');
        for (const e of store.earnings.values()) {
          if (e.userId === userId && e.campaignId === campaignId && e.status === 'ELIGIBLE') {
            total = total.add(e.amount);
          }
        }
        return {
          campaign: store.campaigns.get(campaignId),
          totalEarnings: total,
          currency: 'USD',
          earningsCount: store.earnings.size
        };
      },
      async getUserEarningsHistory(userId) {
        return Array.from(store.earnings.values()).filter((e) => e.userId === userId);
      },
      async getUserEarningsLedger(userId) {
        return Array.from(store.earnings.values())
          .filter((e) => e.userId === userId)
          .map((e) => ({
            ...e,
            campaign: store.campaigns.get(e.campaignId)
          }));
      },
      async getCreatorCampaignTotal(userId, campaignId) {
        let total = new Prisma.Decimal('0.00');
        for (const e of store.earnings.values()) {
          if (e.userId === userId && e.campaignId === campaignId && e.status !== 'VOIDED') {
            total = total.plus(new Prisma.Decimal((e.grossAmount || e.amount || 0).toString()));
          }
        }
        return total;
      }
    };

    // Statistics Repo Mock
    const mockStatsRepo = {
      async getUserAggregatedMetrics(userId) {
        let totalViews = 0n;
        let totalLikes = 0n;
        let totalComments = 0n;
        for (const snap of store.snapshots.values()) {
          totalViews += BigInt(snap.views || 0);
          totalLikes += BigInt(snap.likes || 0);
          totalComments += BigInt(snap.comments || 0);
        }
        return {
          totalViews,
          totalLikes,
          totalComments,
          totalShares: null,
          hasCompleteData: true,
          metricsUnavailable: false
        };
      },
      async getUserCampaignMemberships(userId) {
        return Array.from(store.memberships.values())
          .filter((m) => m.userId === userId)
          .map((m) => ({ ...m, campaign: store.campaigns.get(m.campaignId) }));
      },
      async getUserSubmissionsWithLatestSnapshots(userId) {
        return Array.from(store.submissions.values())
          .filter((s) => s.userId === userId)
          .map((s) => ({
            ...s,
            campaign: store.campaigns.get(s.campaignId),
            snapshots: Array.from(store.snapshots.values()).filter((snap) => snap.submissionId === s.id)
          }));
      }
    };

    // Payout Repo Mock
    const mockPayoutRepo = {
      async transaction(cb) {
        return cb(mockPayoutRepo);
      },
      async acquireUserBalanceLock() {},
      async acquireUserPayoutLock() {},
      async acquirePayoutRequestLock() {},
      async getUserById(id) {
        return store.users.get(id) || null;
      },
      async getAvailableBalance(userId, currency = 'USD') {
        return this.getPayoutBalanceBreakdown(userId, currency);
      },
      async getPayoutBalanceBreakdown(userId, currency = 'USD') {
        let eligible = new Prisma.Decimal('0.00');
        for (const e of store.earnings.values()) {
          if (e.userId === userId && e.status === 'ELIGIBLE' && e.currency === currency) {
            eligible = eligible.add(e.grossAmount || e.amount);
          }
        }
        let reserved = new Prisma.Decimal('0.00');
        for (const p of store.payoutRequests.values()) {
          if (p.userId === userId && ['REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING', 'SUBMITTED'].includes(p.status)) {
            reserved = reserved.add(p.amount);
          }
        }
        const available = eligible.minus(reserved);
        return {
          totalEligible: eligible,
          reservedBalance: reserved,
          availableBalance: available.lessThan(0) ? new Prisma.Decimal('0.00') : available,
          currency,
          minimumPayout: new Prisma.Decimal('10.00')
        };
      },
      async createPayoutRequest(data) {
        const pr = {
          id: `pay_${Date.now()}`,
          ...data,
          status: data.status || 'REQUESTED',
          createdAt: new Date(),
          updatedAt: new Date()
        };
        store.payoutRequests.set(pr.id, pr);
        return pr;
      },
      payoutEvidence: {
        async create({ data }) {
          const ev = { id: `ev_${Date.now()}`, ...data, createdAt: new Date(), updatedAt: new Date() };
          store.payoutEvidence.set(ev.id, ev);
          return ev;
        },
        async findMany({ where }) {
          let list = Array.from(store.payoutEvidence.values());
          if (where?.payoutRequestId) list = list.filter((e) => e.payoutRequestId === where.payoutRequestId);
          return list;
        },
        async findFirst({ where }) {
          const list = await this.findMany({ where });
          return list[0] || null;
        }
      },
      async getUserPayoutRequests(userId) {
        return Array.from(store.payoutRequests.values()).filter((p) => p.userId === userId);
      },
      async getPayoutRequestById(id) {
        const pr = store.payoutRequests.get(id);
        if (!pr) return null;
        const dis = Array.from(store.disbursements.values()).filter((d) => d.payoutRequestId === id);
        return { ...pr, disbursements: dis, user: store.users.get(pr.userId) };
      },
      async updatePayoutRequest(id, data) {
        const pr = store.payoutRequests.get(id);
        if (!pr) throw new Error('Payout request not found');
        Object.assign(pr, data, { updatedAt: new Date() });
        return pr;
      },
      async getUserPayoutHistory(userId) {
        return Array.from(store.payoutRequests.values()).filter((p) => p.userId === userId);
      },
      async createDisbursement(data) {
        const d = { id: `dis_${Date.now()}`, ...data, createdAt: new Date() };
        store.disbursements.set(d.id, d);
        return d;
      },
      async updateDisbursement(id, data) {
        const d = store.disbursements.get(id);
        if (d) Object.assign(d, data, { updatedAt: new Date() });
        return d;
      },
      async recordPayoutEvent(event) {
        store.payoutEvents.push(event);
      }
    };

    // Apply mocks to singletons
    userService.userRepo = mockUserRepo;
    campaignService.campaignRepo = mockCampRepo;
    submissionService.subRepo = mockSubRepo;
    submissionService.campRepo = mockCampRepo;
    submissionService.userRepo = mockUserRepo;
    submissionService.queueVerificationJob = async () => {}; // In-memory noop
    statisticsService.repo = mockStatsRepo;
    earningsService.repo = mockEarningsRepo;
    earningsService.campaignRepo = mockCampRepo;
    payoutService.repo = mockPayoutRepo;
    adminPayoutService.payoutService.repo = mockPayoutRepo;
    adminPayoutService.auditService = {
      logAction: async (params) => {
        store.auditLogs.push(params);
        return params;
      }
    };
    adminPayoutService.disbursementRouter = {
      resolve: () => ({
        name: 'MANUAL',
        async createDisbursement({ payoutRequestId }) {
          return { providerReference: `MAN_REF_${payoutRequestId}`, status: 'PROCESSING' };
        }
      })
    };

    // Store references for tests
    store.verRepo = mockVerRepo;
  });

  afterEach(() => {
    config.admin.adminRoleIds = originalAdminRoleIds;
    config.discord.creatorRoleId = null;
    userService.userRepo = originalServices.userService_userRepo;
    campaignService.campaignRepo = originalServices.campaignService_campaignRepo;
    submissionService.subRepo = originalServices.submissionService_subRepo;
    submissionService.campRepo = originalServices.submissionService_campRepo;
    submissionService.userRepo = originalServices.submissionService_userRepo;
    submissionService.queueVerificationJob = originalServices.submissionService_queue;
    statisticsService.repo = originalServices.statisticsService_repo;
    earningsService.repo = originalServices.earningsService_repo;
    earningsService.campaignRepo = originalServices.earningsService_campaignRepo;
    payoutService.repo = originalServices.payoutService_repo;
    adminPayoutService.disbursementRouter = originalServices.adminPayoutService_disbursementRouter;
    payoutProfileService.getProfile = originalServices.payoutProfileService_getProfile;
    payoutProfileService.getProfileByUserId = originalServices.payoutProfileService_getProfileByUserId;
    payoutProfileService.saveProfile = originalServices.payoutProfileService_saveProfile;
  });

  function createMockInteraction(options = {}) {
    const replies = [];
    const followUps = [];
    let modalShown = null;
    let deferred = false;
    let replied = false;

    const rolesMap = new Map();
    if (options.roles) {
      for (const r of options.roles) {
        rolesMap.set(r, { id: r });
      }
    }

    const memberRolesCache = new Collection(rolesMap);
    const addedRoles = [];

    const member = options.member || {
      roles: {
        cache: memberRolesCache,
        add: async (role) => {
          addedRoles.push(role);
          memberRolesCache.set(role.id, role);
        }
      },
      permissions: options.permissions || 0n
    };

    const guildRolesCache = new Collection([
      [CREATOR_ROLE_ID, { id: CREATOR_ROLE_ID, name: 'Creator' }],
      [ADMIN_ROLE_ID, { id: ADMIN_ROLE_ID, name: 'Peak Admin' }]
    ]);

    return {
      id: `int_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      guildId: config.discord?.guildId || 'dev_guild_123',
      guild: {
        id: config.discord?.guildId || 'dev_guild_123',
        roles: { cache: guildRolesCache }
      },
      user: options.user || { id: 'creator_discord_101', username: 'pro_clipper', displayName: 'Pro Clipper' },
      member,
      customId: options.customId,
      commandName: options.commandName,
      replies,
      followUps,
      addedRoles,
      get deferred() {
        return deferred;
      },
      get replied() {
        return replied;
      },
      isChatInputCommand: () => !!options.commandName,
      isButton: () => options.isButton !== undefined ? options.isButton : !!options.customId && !options.isMenu && !options.isModal,
      isStringSelectMenu: () => !!options.isMenu,
      isModalSubmit: () => !!options.isModal,
      async reply(payload) {
        replied = true;
        replies.push(payload);
        return payload;
      },
      async followUp(payload) {
        followUps.push(payload);
        return payload;
      },
      async deferReply() {
        deferred = true;
      },
      async deferUpdate() {
        deferred = true;
      },
      async editReply(payload) {
        replies.push(payload);
        return payload;
      },
      async showModal(modal) {
        modalShown = modal;
      },
      fields: {
        getTextInputValue: (fieldId) => options.fieldValues?.[fieldId] || ''
      },
      getModalShown: () => modalShown
    };
  }

  test('Complete application lifecycle: /verify -> join campaign -> submit clip -> verify & credit -> check stats/earnings -> payout request -> admin approve & process', async () => {
    const creatorDiscordUser = {
      id: 'discord_top_creator',
      username: 'top_creator',
      displayName: 'Top Creator'
    };

    // =========================================================================
    // STEP 1: Creator Onboarding (/register)
    // =========================================================================
    const registerInteraction = createMockInteraction({
      commandName: 'register',
      user: creatorDiscordUser
    });

    await registerCommand.execute(registerInteraction);

    assert.equal(registerInteraction.replies.length, 1);
    const registerEmbed = registerInteraction.replies[0].embeds[0];
    assert.match(registerEmbed.data.title, /Welcome to Peak Clip, Top Creator!/);
    assert.equal(registerInteraction.addedRoles.length, 1);
    assert.equal(registerInteraction.addedRoles[0].name, 'Creator');

    // Confirm user persisted in store
    const creatorUser = Array.from(store.users.values()).find((u) => u.discordId === creatorDiscordUser.id);
    assert.ok(creatorUser);
    assert.equal(creatorUser.status, 'ACTIVE');

    // =========================================================================
    // STEP 2: Explore Campaigns & Join
    // =========================================================================
    const campaignsInteraction = createMockInteraction({
      commandName: 'campaigns',
      user: creatorDiscordUser
    });
    await campaignsCommand.execute(campaignsInteraction);

    assert.equal(campaignsInteraction.replies.length, 1);
    const campEmbed = campaignsInteraction.replies[0].embeds[0];
    assert.match(campEmbed.data.title, /Active.*Campaigns/i);

    // Creator clicks Join button
    const joinInteraction = createMockInteraction({
      customId: 'campaign:join:cmp_gaming_2026',
      user: creatorDiscordUser
    });
    await handleCampaignJoin(joinInteraction, 'cmp_gaming_2026');

    assert.equal(joinInteraction.replies.length, 1);
    const joinEmbed = joinInteraction.replies[0].embeds[0];
    assert.match(joinEmbed.data.title, /Campaign Joined/i);

    // Verify active membership established
    const membership = store.memberships.get(`${creatorUser.id}_cmp_gaming_2026`);
    assert.ok(membership);
    assert.equal(membership.status, 'ACTIVE');

    // =========================================================================
    // STEP 3: Submit Video Clip via Modal
    // =========================================================================
    const submitInteraction = createMockInteraction({
      customId: 'submit:modal:cmp_gaming_2026',
      user: creatorDiscordUser,
      isModal: true,
      fieldValues: {
        'submit:url_input': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
      }
    });
    await handleModalSubmitClip(submitInteraction, 'cmp_gaming_2026');

    assert.equal(submitInteraction.replies.length, 1);
    const submitEmbed = submitInteraction.replies[0].embeds[0];
    assert.match(submitEmbed.data.title, /Submission Received/i);

    const submission = Array.from(store.submissions.values()).find((s) => s.userId === creatorUser.id);
    assert.ok(submission);
    assert.equal(submission.status, 'PENDING_VERIFICATION');

    // =========================================================================
    // STEP 4: Verification Pipeline Engine Execution (Auto-Approval)
    // =========================================================================
    const fakeProvider = {
      name: 'YOUTUBE',
      async getCurrentMetrics() {
        return {
          isAvailable: true,
          views: 50000n,
          likes: 2500n,
          comments: 200n,
          shares: null,
          status: 'AVAILABLE',
          availability: { views: 'AVAILABLE', likes: 'AVAILABLE', comments: 'AVAILABLE', shares: 'NOT_SUPPORTED' },
          metadata: { title: 'Viral Showcase', channelTitle: 'Top Creator' }
        };
      }
    };

    const verService = new VerificationService({
      submissionRepo: submissionService.subRepo,
      verificationRepo: store.verRepo,
      providerResolver: () => fakeProvider,
      approvalPolicy: new ApprovalPolicy()
    });

    const verResult = await verService.runVerification(submission.id);
    assert.equal(verResult.status, 'COMPLETED');
    assert.equal(verResult.submissionStatus, 'APPROVED');

    // =========================================================================
    // STEP 5: Metric Snapshot & Authoritative Earnings Calculation
    // =========================================================================
    const snapshot = await store.verRepo.createMetricSnapshot({
      submissionId: submission.id,
      views: 50000n,
      likes: 2500n,
      comments: 200n,
      shares: null,
      status: 'AVAILABLE'
    });

    // Run earnings calculation: 50,000 views * $2.00 / 1000 = $100.00
    const earnResult = await earningsService.creditNewEligibleViews(submission.id, snapshot.id);
    assert.equal(earnResult.reason, 'CREDITED_SUCCESSFULLY');
    assert.equal(earnResult.grossAmount.toFixed(2), '100.00');

    // =========================================================================
    // STEP 6: Check Statistics View (/statistics)
    // =========================================================================
    const statsInteraction = createMockInteraction({
      commandName: 'statistics',
      user: creatorDiscordUser
    });
    await statisticsCommand.execute(statsInteraction);

    assert.equal(statsInteraction.replies.length, 1);
    const statsEmbed = statsInteraction.replies[0].embeds[0];
    assert.match(statsEmbed.data.title, /Performance Overview/i);
    const engagementField = statsEmbed.data.fields.find((f) => f.name.includes('Engagement Totals'));
    assert.match(engagementField.value, /50,000/);

    // =========================================================================
    // STEP 7: Check Earnings View (/earnings)
    // =========================================================================
    const earningsInteraction = createMockInteraction({
      commandName: 'earnings',
      user: creatorDiscordUser
    });
    await earningsCommand.execute(earningsInteraction);

    assert.equal(earningsInteraction.replies.length, 1);
    const earnEmbed = earningsInteraction.replies[0].embeds[0];
    assert.match(earnEmbed.data.title, /Clipping Earnings/i);
    const balanceField = earnEmbed.data.fields.find((f) => f.name.includes('Balance Summary'));
    assert.match(balanceField.value, /100\.00/);

    // =========================================================================
    // STEP 8: Creator Requests Payout (/payout -> Modal -> Instructions -> Evidence -> Submit)
    // =========================================================================
    // Configure Creator Payout Profile
    await payoutProfileService.saveProfile(creatorUser.id, {
      walletAddress: '0x71C234567890abcdef1234567890abcdef1234',
      network: 'ETHEREUM',
      walletName: 'MetaMask',
      platform: 'YOUTUBE'
    });

    const payoutBtnInteraction = createMockInteraction({
      customId: `payout_request_btn:${creatorUser.id}`,
      user: creatorDiscordUser
    });
    await handlePayoutRequestButton(payoutBtnInteraction, creatorUser.id);
    assert.ok(payoutBtnInteraction.getModalShown());

    // Submit Payout Modal for $50.00
    const payoutModalInteraction = createMockInteraction({
      customId: `payout_modal:${creatorUser.id}`,
      user: creatorDiscordUser,
      isModal: true,
      fieldValues: {
        payout_amount_input: '50.00'
      }
    });
    await handlePayoutModalSubmit(payoutModalInteraction, creatorUser.id);

    assert.equal(payoutModalInteraction.replies.length, 1);
    const instructionsEmbed = payoutModalInteraction.replies[0].embeds[0];
    assert.match(instructionsEmbed.data.title, /Analytics Verification/i);

    // Attach valid screen recording evidence to draft
    payoutDraftManager.attachEvidence(creatorUser.id, {
      buffer: buildMockMp4Buffer(20),
      filename: 'creator_stats.mp4',
      mimeType: 'video/mp4',
      fileSize: 2048,
      durationSeconds: 20.0,
      format: 'mp4'
    });

    // Submit Payout
    const payoutSubmitInteraction = createMockInteraction({
      customId: `payout_ev_submit:${creatorUser.id}`,
      user: creatorDiscordUser
    });
    await handlePayoutEvidenceSubmitButton(payoutSubmitInteraction, creatorUser.id);

    assert.equal(payoutSubmitInteraction.replies.length, 1);
    const payoutSuccessEmbed = payoutSubmitInteraction.replies[0].embeds[0];
    assert.match(payoutSuccessEmbed.data.title, /Payout Request Submitted/);

    const payout = Array.from(store.payoutRequests.values()).find((p) => p.userId === creatorUser.id);
    assert.ok(payout);
    assert.equal(payout.amount.toFixed(2), '50.00');
    assert.equal(payout.status, 'REQUESTED');

    // Assert funds are atomically reserved in balance
    const postBalance = await payoutService.getAvailablePayoutBalance(creatorUser.id);
    assert.equal(postBalance.totalEligible.toFixed(2), '100.00');
    assert.equal(postBalance.reservedBalance.toFixed(2), '50.00');
    assert.equal(postBalance.availableBalance.toFixed(2), '50.00');

    // =========================================================================
    // STEP 9: Staff Reviews & Approves Payout (admin_payout_approve:)
    // =========================================================================
    const adminDiscordUser = { id: 'admin_discord_999', username: 'peak_admin' };

    // Move to UNDER_REVIEW per state machine
    await adminPayoutService.reviewPayout(payout.id, { discordId: adminDiscordUser.id, userId: null }, 'Staff review');
    assert.equal(store.payoutRequests.get(payout.id).status, 'UNDER_REVIEW');

    const adminApproveInteraction = createMockInteraction({
      customId: `admin_payout_approve:${payout.id}`,
      user: adminDiscordUser,
      roles: [ADMIN_ROLE_ID]
    });

    await handleAdminButtonInteraction(adminApproveInteraction);

    assert.equal(adminApproveInteraction.replies.length, 1);
    assert.match(adminApproveInteraction.replies[0].content, /APPROVED/);

    const approvedPayout = store.payoutRequests.get(payout.id);
    assert.equal(approvedPayout.status, 'APPROVED');

    // =========================================================================
    // STEP 10: Admin Processes Disbursement (admin_payout_process:)
    // =========================================================================
    const adminProcessInteraction = createMockInteraction({
      customId: `admin_payout_process:${payout.id}`,
      user: adminDiscordUser,
      roles: [ADMIN_ROLE_ID]
    });

    await handleAdminButtonInteraction(adminProcessInteraction);

    assert.equal(adminProcessInteraction.replies.length, 1);
    assert.match(adminProcessInteraction.replies[0].content, /Disbursement processed for payout/);

    const completedPayout = store.payoutRequests.get(payout.id);
    assert.ok(['COMPLETED', 'PROCESSING'].includes(completedPayout.status));

    // =========================================================================
    // STEP 11: Final State & Ledger Integrity Verification
    // =========================================================================
    const finalBalance = await payoutService.getAvailablePayoutBalance(creatorUser.id);
    assert.equal(finalBalance.availableBalance.toFixed(2), '50.00');
    assert.equal(store.payoutEvents.length >= 2, true); // PENDING -> APPROVED -> PROCESSING
    assert.equal(store.disbursements.size, 1);
  });
});
