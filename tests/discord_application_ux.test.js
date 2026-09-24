import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { config } from '../src/config/index.js';
import {
  AdminRole,
  AdminPermission,
  assertAdminPermission
} from '../src/modules/admin/admin.auth.js';
import {
  UnauthorizedAdminActionError,
  InsufficientPermissionError
} from '../src/modules/admin/admin.errors.js';
import { userService } from '../src/modules/users/user.service.js';
import { campaignService } from '../src/modules/campaigns/campaign.service.js';
import { statisticsService } from '../src/modules/statistics/statistics.service.js';
import { earningsService } from '../src/modules/earnings/earnings.service.js';
import { payoutService } from '../src/modules/payouts/payout.service.js';
import { payoutProfileService } from '../src/modules/payout-profile/payout-profile.service.js';
import { adminSubmissionService } from '../src/modules/admin/admin.submission.service.js';
import { adminPayoutService } from '../src/modules/admin/admin.payout.service.js';
import { adminCreatorService } from '../src/modules/admin/admin.creator.service.js';
import {
  buildCreatorDashboardEmbed,
  buildCreatorProfileEmbed,
  buildAdminControlCenterEmbed,
  buildCreatorClipsListEmbed,
  buildCreatorClipDetailEmbed,
  buildPayoutWizardEmbed
} from '../src/bot/embeds/dashboard.embeds.js';
import {
  buildCreatorDashboardActionRows,
  buildNavigationBackRow,
  buildDashboardPaginationRow,
  buildPayoutHubActionRows,
  buildPayoutWizardActionRow,
  buildAdminControlCenterRows,
  buildAdminNavRow
} from '../src/bot/components/dashboard.components.js';
import {
  handleCreatorDashboard,
  handleDashboardCampaigns,
  handleDashboardCampaignDetail,
  handleDashboardMyClips,
  handleDashboardClipDetail,
  handleDashboardEarnings,
  handleDashboardPayout,
  handleDashboardProfile,
  handleDashboardBack,
  handleDashboardRefresh,
  handlePayoutProfileSetup,
  handlePayoutProfileView,
  handlePayoutWizStep,
  handlePayoutWizConfirm,
  handleAdminControlCenter,
  handleAdminReviewQueueNav,
  handleAdminPayoutQueueNav,
  handleAdminCampaignsNav,
  handleAdminCreatorsNav,
  handleAdminReportsNav
} from '../src/bot/interactions/dashboard.interactions.js';
import { handleInteraction } from '../src/bot/interactions/router.js';
import dashboardCommand from '../src/bot/commands/dashboard.js';

describe('Phase 10H — Discord Application UX & Button Navigation', () => {
  const ADMIN_ROLE_ID = 'dev_admin_role_snowflake';
  const CM_ROLE_ID = 'dev_cm_role_snowflake';

  let originalAdminRoleIds;
  let originalCmRoleIds;
  let originalGetOrCreate;
  let originalGetUserOverview;
  let originalGetAvailableBalance;
  let originalListPayoutRequests;
  let originalGetActiveCampaigns;
  let originalGetUserCampaigns;
  let originalGetCampaignById;
  let originalGetCreatorVideos;
  let originalGetSubmissionStats;
  let originalGetCreatorCampaigns;
  let originalGetUserEarnings;
  let originalGetProfile;
  let originalCreatePayout;
  let originalListReviewQueue;
  let originalAdminListPayouts;
  let originalSearchCreators;

  const mockUser = {
    id: 'usr_creator_001',
    discordId: '111111111111111111',
    username: 'test_creator',
    displayName: 'Test Creator',
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00Z')
  };

  const mockAdminUser = {
    id: 'usr_admin_001',
    discordId: '999999999999999999',
    username: 'test_admin',
    displayName: 'Test Admin',
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00Z')
  };

  beforeEach(() => {
    originalAdminRoleIds = config.admin.adminRoleIds;
    originalCmRoleIds = config.admin.campaignManagerRoleIds;
    config.admin.adminRoleIds = [ADMIN_ROLE_ID];
    config.admin.campaignManagerRoleIds = [CM_ROLE_ID];

    // Mock User Service
    originalGetOrCreate = userService.getOrCreateFromDiscord;
    userService.getOrCreateFromDiscord = async (discordUser) => {
      if (discordUser.id === mockAdminUser.discordId) return mockAdminUser;
      return {
        id: `usr_${discordUser.id}`,
        discordId: discordUser.id,
        username: discordUser.username || `user_${discordUser.id}`,
        status: 'ACTIVE',
        createdAt: new Date('2026-01-01T00:00:00Z')
      };
    };

    // Mock Statistics Service
    originalGetUserOverview = statisticsService.getUserOverview;
    statisticsService.getUserOverview = async (userId) => ({
      userId,
      submissionsCount: { total: 10, approved: 8, underReview: 2, rejected: 0 },
      totalViews: { knownSum: 50000n, availability: 'COMPLETE' },
      totalEligibleViews: 45000n,
      campaignsCount: { active: 2, total: 3 },
      financials: {
        totalEarned: '450.00',
        availableBalance: '250.00',
        reservedBalance: '50.00',
        completedPayouts: '150.00',
        currency: 'USD'
      }
    });

    originalGetCreatorVideos = statisticsService.getCreatorVideos;
    statisticsService.getCreatorVideos = async (userId, options) => ({
      videos: [
        {
          id: 'sub_001',
          url: 'https://youtube.com/shorts/clip1',
          platform: 'YOUTUBE',
          campaignName: 'Summer Launch',
          status: 'APPROVED',
          views: 10000n,
          eligibleViews: 9000n,
          grossEarnings: '90.00',
          retentionRequired: true,
          retentionStatus: 'ACTIVE'
        },
        {
          id: 'sub_002',
          url: 'https://tiktok.com/@creator/video/clip2',
          platform: 'TIKTOK',
          campaignName: 'Brand Sprint',
          status: 'PENDING_VERIFICATION', // internal status that must map to safe status
          views: 5000n,
          eligibleViews: 0n,
          grossEarnings: '0.00',
          retentionRequired: false
        }
      ],
      total: 2,
      page: options?.page || 1,
      limit: options?.limit || 5
    });

    originalGetSubmissionStats = statisticsService.getSubmissionStatistics;
    statisticsService.getSubmissionStatistics = async (userId, submissionId) => ({
      submission: {
        id: submissionId,
        userId,
        url: 'https://youtube.com/shorts/clip1',
        platform: 'YOUTUBE',
        createdAt: new Date('2026-02-01T00:00:00Z'),
        campaign: { name: 'Summer Launch' },
        retentionRequired: true,
        retentionStatus: 'ACTIVE',
        retentionDeadline: new Date('2026-03-01T00:00:00Z'),
        rejectionReason: null,
        adminNote: null
      },
      status: 'APPROVED',
      metrics: { views: 10000n },
      financials: { eligibleViews: 9000n, grossEarnings: '90.00' }
    });

    originalGetCreatorCampaigns = statisticsService.getCreatorCampaigns;
    statisticsService.getCreatorCampaigns = async (userId) => ({
      campaigns: [
        {
          campaignId: 'camp_001',
          campaignName: 'Summer Launch',
          status: 'ACTIVE',
          clientName: 'Acme Corp',
          grossEarnings: '90.00'
        }
      ],
      total: 1
    });

    originalGetUserEarnings = earningsService.getUserEarnings;
    earningsService.getUserEarnings = async (userId) => ({
      userId,
      currency: 'USD',
      eligibleEarnings: 250,
      pendingEarnings: 50,
      totalGrossEarnings: 300,
      minimumPayout: 10,
      isPayoutThresholdReached: true,
      totalEligibleViews: 45000n,
      activeCampaignsCount: 1
    });

    // Mock Payout Service
    originalGetAvailableBalance = payoutService.getAvailablePayoutBalance;
    payoutService.getAvailablePayoutBalance = async (userId) => ({
      availableBalance: 250.00,
      currency: 'USD'
    });

    originalListPayoutRequests = payoutService.listPayoutRequests;
    payoutService.listPayoutRequests = async () => [];

    originalCreatePayout = payoutService.createPayoutRequest;
    payoutService.createPayoutRequest = async (userId, amount, currency) => ({
      id: 'payout_req_123',
      userId,
      amount,
      currency,
      status: 'REQUESTED',
      createdAt: new Date()
    });

    // Mock Payout Profile Service
    originalGetProfile = payoutProfileService.getProfileByUserId;
    payoutProfileService.getProfileByUserId = async (userId) => ({
      id: 'prof_001',
      userId,
      walletAddress: '0x71C8363837381F025701262B49f43E92B690ce57',
      network: 'Ethereum',
      walletName: 'MetaMask',
      creatorHandle: '@test_creator',
      platform: 'YOUTUBE',
      verifiedAt: new Date()
    });

    // Mock Campaign Service
    originalGetActiveCampaigns = campaignService.getActiveCampaigns;
    campaignService.getActiveCampaigns = async () => ({
      campaigns: [
        {
          id: 'camp_001',
          name: 'Summer Launch',
          status: 'ACTIVE',
          totalBudget: 1000,
          payRate: 10.0,
          clientName: 'Acme Corp'
        }
      ],
      total: 1
    });

    originalGetUserCampaigns = campaignService.getUserCampaigns;
    campaignService.getUserCampaigns = async () => [
      {
        campaignId: 'camp_001',
        status: 'ACTIVE'
      }
    ];

    originalGetCampaignById = campaignService.getCampaignById;
    campaignService.getCampaignById = async (id) => ({
      id,
      name: 'Summer Launch',
      status: 'ACTIVE',
      totalBudget: 1000,
      remainingBudget: 500,
      payRate: 10.0,
      clientName: 'Acme Corp',
      description: 'Promote summer collection'
    });

    // Mock Admin Services
    originalListReviewQueue = adminSubmissionService.listReviewQueue;
    adminSubmissionService.listReviewQueue = async () => [
      {
        id: 'sub_rev_001',
        platform: 'TIKTOK',
        status: 'UNDER_REVIEW',
        url: 'https://tiktok.com/@c/video/1',
        user: { discordId: '111111111111111111' }
      }
    ];

    originalAdminListPayouts = adminPayoutService.listPayoutRequests;
    adminPayoutService.listPayoutRequests = async () => [
      {
        id: 'pay_001',
        amount: 100.0,
        status: 'REQUESTED',
        user: { discordId: '111111111111111111' }
      }
    ];

    originalSearchCreators = adminCreatorService.searchCreators;
    adminCreatorService.searchCreators = async () => [
      {
        id: 'usr_001',
        username: 'top_creator',
        discordId: '111111111111111111',
        status: 'ACTIVE',
        createdAt: new Date('2026-01-01T00:00:00Z')
      }
    ];
  });

  afterEach(() => {
    config.admin.adminRoleIds = originalAdminRoleIds;
    config.admin.campaignManagerRoleIds = originalCmRoleIds;
    userService.getOrCreateFromDiscord = originalGetOrCreate;
    statisticsService.getUserOverview = originalGetUserOverview;
    statisticsService.getCreatorVideos = originalGetCreatorVideos;
    statisticsService.getSubmissionStatistics = originalGetSubmissionStats;
    statisticsService.getCreatorCampaigns = originalGetCreatorCampaigns;
    earningsService.getUserEarnings = originalGetUserEarnings;
    payoutService.getAvailablePayoutBalance = originalGetAvailableBalance;
    payoutService.listPayoutRequests = originalListPayoutRequests;
    payoutService.createPayoutRequest = originalCreatePayout;
    payoutProfileService.getProfileByUserId = originalGetProfile;
    campaignService.getActiveCampaigns = originalGetActiveCampaigns;
    campaignService.getUserCampaigns = originalGetUserCampaigns;
    campaignService.getCampaignById = originalGetCampaignById;
    adminSubmissionService.listReviewQueue = originalListReviewQueue;
    adminPayoutService.listPayoutRequests = originalAdminListPayouts;
    adminCreatorService.searchCreators = originalSearchCreators;
  });

  // Helper to create mock Discord Button Interaction
  function createMockButtonInteraction({
    customId,
    userId = '111111111111111111',
    roles = []
  }) {
    let deferred = false;
    let replied = false;
    let replyPayload = null;
    let editPayload = null;
    let followUpPayload = null;

    const memberRolesCache = new Map(roles.map((r) => [r, { id: r }]));

    return {
      id: `int_${Date.now()}`,
      type: 3,
      customId,
      user: { id: userId, username: `user_${userId}` },
      member: {
        id: userId,
        roles: {
          cache: memberRolesCache,
          highest: { id: roles[0] || 'everyone', position: roles.length > 0 ? 10 : 0 }
        },
        permissions: new PermissionsBitField()
      },
      guildId: config.discord.guildId || 'dev_guild_12345',
      isButton: () => true,
      isStringSelectMenu: () => false,
      isChatInputCommand: () => false,
      isModalSubmit: () => false,
      deferUpdate: async () => { deferred = true; },
      deferReply: async () => { deferred = true; },
      reply: async (payload) => {
        replied = true;
        replyPayload = payload;
      },
      editReply: async (payload) => {
        editPayload = payload;
      },
      followUp: async (payload) => {
        followUpPayload = payload;
      },
      get _state() {
        return { deferred, replied, replyPayload, editPayload, followUpPayload };
      }
    };
  }

  // =========================================================================
  // 1. CREATOR DASHBOARD (/dashboard & [ 🏠 Dashboard ])
  // =========================================================================
  describe('1. Creator Dashboard View & Components', () => {
    test('renders Creator Dashboard embed with balance, active clips, and views', async () => {
      const data = {
        availableBalance: '250.00',
        currency: 'USD',
        activeClipsCount: 10,
        approvedClipsCount: 8,
        underReviewClipsCount: 2,
        totalViews: 50000n,
        eligibleViews: 45000n,
        activePayout: null
      };

      const embed = buildCreatorDashboardEmbed(data, { username: 'test_creator' });
      assert.equal(embed.data.title, '🎬 PEAK CLIP — CREATOR CENTER');
      const serialized = JSON.stringify(embed.data);
      assert.ok(serialized.includes('$250.00 USD'));
      assert.ok(serialized.includes('Active Clips'));
      assert.ok(serialized.includes('50,000'));
    });

    test('buildCreatorDashboardActionRows generates 7 navigation buttons with user isolation', () => {
      const rows = buildCreatorDashboardActionRows('usr_creator_001');
      assert.equal(rows.length, 2);

      const row1Buttons = rows[0].components;
      const row2Buttons = rows[1].components;

      assert.equal(row1Buttons.length, 5);
      assert.equal(row1Buttons[0].data.label, '🎯 Campaigns');
      assert.equal(row1Buttons[0].data.custom_id, 'dash_campaigns:usr_creator_001:1');
      assert.equal(row1Buttons[1].data.label, '🎬 Submissions');
      assert.equal(row1Buttons[2].data.label, '📊 Stats');
      assert.equal(row1Buttons[3].data.label, '💰 Earnings');
      assert.equal(row1Buttons[4].data.label, '💸 Payouts');

      assert.equal(row2Buttons.length, 2);
      assert.equal(row2Buttons[0].data.label, '👤 Profile');
      assert.equal(row2Buttons[1].data.label, '🔄 Refresh');
    });

    test('handleCreatorDashboard loads metrics and edits reply with dashboard', async () => {
      const interaction = createMockButtonInteraction({ customId: 'dash_home:usr_111111111111111111' });
      await handleCreatorDashboard(interaction, 'usr_111111111111111111');

      assert.ok(interaction._state.editPayload);
      assert.equal(interaction._state.editPayload.embeds.length, 1);
      assert.equal(interaction._state.editPayload.components.length, 2);
      assert.equal(interaction._state.editPayload.embeds[0].data.title, '🎬 PEAK CLIP — CREATOR CENTER');
    });

    test('/dashboard slash command executes handleCreatorDashboard', async () => {
      let executed = false;
      const mockSlashInteraction = {
        isChatInputCommand: () => true,
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        user: { id: '111111111111111111', username: 'test_creator' },
        guildId: config.discord.guildId || 'dev_guild_12345',
        deferReply: async () => {},
        editReply: async (payload) => {
          executed = true;
          assert.equal(payload.embeds[0].data.title, '🎬 PEAK CLIP — CREATOR CENTER');
        }
      };

      await dashboardCommand.execute(mockSlashInteraction);
      assert.equal(executed, true);
    });
  });

  // =========================================================================
  // 2. CAMPAIGNS SUBVIEW
  // =========================================================================
  describe('2. Campaigns Subview & Navigation', () => {
    test('handleDashboardCampaigns renders paginated list with Dashboard button', async () => {
      const interaction = createMockButtonInteraction({ customId: 'dash_campaigns:usr_111111111111111111:1' });
      await handleDashboardCampaigns(interaction, 'usr_111111111111111111', 1);

      assert.ok(interaction._state.editPayload);
      const components = interaction._state.editPayload.components;
      // Campaign list now includes a select menu row + a pagination/nav row (2 rows when campaigns exist)
      assert.ok(components.length >= 1, 'Must have at least 1 component row');

      // The nav/pagination row is always last — find Dashboard button in last row
      const lastRow = components[components.length - 1];
      const navButtons = lastRow.components;
      const homeButton = navButtons.find((b) => b.data.label === '🏠 Dashboard');
      assert.ok(homeButton, 'Must contain [ 🏠 Dashboard ] button (Zero dead-end screen)');
    });

    test('handleDashboardCampaignDetail renders details and Back button', async () => {
      const interaction = createMockButtonInteraction({ customId: 'dash_campaign_view:usr_111111111111111111:camp_001' });
      await handleDashboardCampaignDetail(interaction, 'usr_111111111111111111', 'camp_001');

      assert.ok(interaction._state.editPayload);
      const components = interaction._state.editPayload.components;
      const navRow = components[components.length - 1];
      const backBtn = navRow.components.find((b) => b.data.label === '◀ Back');
      const homeBtn = navRow.components.find((b) => b.data.label === '🏠 Dashboard');
      assert.ok(backBtn && homeBtn, 'Campaign detail must contain Back and Dashboard buttons');
    });
  });

  // =========================================================================
  // 3. MY CLIPS SUBVIEW & SAFE REDACTION
  // =========================================================================
  describe('3. My Clips Subview & Privacy Redaction', () => {
    test('buildCreatorClipsListEmbed displays ONLY safe statuses (APPROVED, UNDER REVIEW, REJECTED)', () => {
      const clips = [
        {
          platform: 'YOUTUBE',
          campaignName: 'Campaign A',
          url: 'https://youtube.com/shorts/clip1',
          status: 'APPROVED',
          views: 1000n,
          eligibleViews: 1000n,
          grossEarnings: '10.00'
        },
        {
          platform: 'TIKTOK',
          campaignName: 'Campaign B',
          url: 'https://tiktok.com/@c/video/clip2',
          status: 'PENDING_VERIFICATION', // should map to UNDER REVIEW
          views: 500n,
          eligibleViews: 0n,
          grossEarnings: '0.00'
        }
      ];

      const embed = buildCreatorClipsListEmbed(clips, 1, 1, { username: 'creator' });
      const rawText = JSON.stringify(embed.data);

      assert.ok(rawText.includes('APPROVED'));
      assert.ok(rawText.includes('UNDER REVIEW'));

      // Strictly verify no internal risk indicators leak
      assert.equal(rawText.includes('LOW_RISK'), false);
      assert.equal(rawText.includes('HIGH_RISK'), false);
      assert.equal(rawText.includes('riskScore'), false);
      assert.equal(rawText.includes('PENDING_VERIFICATION'), false);
    });

    test('buildCreatorClipsListEmbed supports repository item structure (campaign.name, latestViews, totalEarned)', () => {
      const repoItems = [
        {
          id: 'sub_123',
          platform: 'YOUTUBE',
          campaign: { id: 'c1', name: 'DEV YouTube Campaign' },
          url: 'https://youtube.com/watch?v=abc',
          normalizedUrl: 'https://youtube.com/watch?v=abc',
          status: 'APPROVED',
          latestViews: 45000n,
          eligibleViews: 45000n,
          grossEarnings: '45.00'
        },
        {
          id: 'sub_456',
          platform: 'TIKTOK',
          campaign: { id: 'c2', name: 'DEV Secondary Campaign' },
          url: 'https://tiktok.com/@u/video/xyz',
          normalizedUrl: 'https://tiktok.com/@u/video/xyz',
          status: 'APPROVED',
          latestViews: null,
          eligibleViews: 0n,
          grossEarnings: '0.00'
        }
      ];

      const embed = buildCreatorClipsListEmbed(repoItems, 1, 1, { username: 'harshdevil15' });
      const rawText = JSON.stringify(embed.data);

      assert.ok(rawText.includes('DEV YouTube Campaign'));
      assert.ok(rawText.includes('DEV Secondary Campaign'));
      assert.ok(rawText.includes('45,000'));
      assert.equal(rawText.includes('No Clips Found'), false);
    });

    test('handleDashboardClipDetail renders safe details without internal fraud signals', async () => {
      const interaction = createMockButtonInteraction({ customId: 'dash_clip_view:usr_111111111111111111:sub_001' });
      await handleDashboardClipDetail(interaction, 'usr_111111111111111111', 'sub_001');

      assert.ok(interaction._state.editPayload);
      const embed = interaction._state.editPayload.embeds[0];
      const serialized = JSON.stringify(embed.data);

      assert.ok(serialized.includes('Safe Status: **`APPROVED`**'));
      assert.equal(serialized.includes('risk'), false);
      assert.equal(serialized.includes('flag'), false);

      // Back navigation present
      const navRow = interaction._state.editPayload.components[0];
      const backBtn = navRow.components.find((b) => b.data.label === '◀ Back');
      assert.ok(backBtn);
    });
  });

  // =========================================================================
  // 4. EARNINGS & BALANCES FROM AUTHORITATIVE LEDGER
  // =========================================================================
  describe('4. Authoritative Earnings & Breakdown', () => {
    test('handleDashboardEarnings renders authoritative balance and breakdown', async () => {
      const interaction = createMockButtonInteraction({ customId: 'dash_earnings:usr_111111111111111111' });
      await handleDashboardEarnings(interaction, 'usr_111111111111111111');

      assert.ok(interaction._state.editPayload);
      const embed = interaction._state.editPayload.embeds[0];
      assert.ok(embed.data.title.includes('Earnings'));

      const navRow = interaction._state.editPayload.components[0];
      const homeBtn = navRow.components.find((b) => b.data.label === '🏠 Dashboard');
      assert.ok(homeBtn);
    });
  });

  // =========================================================================
  // 5. PAYOUT HUB & WIZARD FLOW
  // =========================================================================
  describe('5. Payout Hub & Step-by-Step Wizard', () => {
    test('buildPayoutHubActionRows shows Setup Profile when no profile exists', () => {
      const rows = buildPayoutHubActionRows({
        userId: 'usr_1',
        hasProfile: false,
        hasActivePayout: false
      });

      const setupBtn = rows[0].components.find((b) => b.data.label.includes('Set Up Payout Profile'));
      assert.ok(setupBtn);
    });

    test('buildPayoutHubActionRows shows Request Payout and Profile options when profile exists', () => {
      const rows = buildPayoutHubActionRows({
        userId: 'usr_1',
        hasProfile: true,
        hasActivePayout: false
      });

      const reqBtn = rows[0].components.find((b) => b.data.label.includes('Request Payout'));
      const viewBtn = rows[0].components.find((b) => b.data.label.includes('View Profile'));
      const editBtn = rows[0].components.find((b) => b.data.label.includes('Update Profile'));

      assert.ok(reqBtn && viewBtn && editBtn);
    });

    test('buildPayoutHubActionRows includes Cancel button only when payout is cancellable', () => {
      const rows = buildPayoutHubActionRows({
        userId: 'usr_1',
        hasProfile: true,
        hasActivePayout: true,
        activePayoutId: 'pay_123',
        canCancel: true
      });

      const cancelBtn = rows[1].components.find((b) => b.data.label.includes('Cancel Payout'));
      assert.ok(cancelBtn);
      assert.equal(cancelBtn.data.custom_id, 'payout_cancel_btn:usr_1:pay_123');
    });

    test('buildPayoutWizardEmbed correctly renders each wizard step with masked destination', () => {
      const wizardData = {
        amount: '100.00',
        currency: 'USD',
        availableBalance: '250.00',
        profile: {
          walletAddress: '0x71C8363837381F025701262B49f43E92B690ce57',
          network: 'Ethereum',
          creatorHandle: '@creator'
        }
      };

      // Step 1: Amount
      const step1 = buildPayoutWizardEmbed(1, wizardData);
      assert.ok(step1.data.title.includes('Step 1'));

      // Step 2: Destination check (masked)
      const step2 = buildPayoutWizardEmbed(2, wizardData);
      assert.ok(step2.data.title.includes('Step 2'));
      assert.ok(step2.data.description.includes('0x71C8'));
      assert.ok(step2.data.description.includes('ce57'));
      assert.equal(step2.data.description.includes('0x71C8363837381F025701262B49f43E92B690ce57'), false);

      // Step 3: Evidence guidelines
      const step3 = buildPayoutWizardEmbed(3, wizardData);
      assert.ok(step3.data.title.includes('Step 3'));
      assert.ok(step3.data.description.includes('under 40 seconds'));

      // Step 4: Final Confirmation
      const step4 = buildPayoutWizardEmbed(4, wizardData);
      assert.ok(step4.data.title.includes('CONFIRM PAYOUT REQUEST'));
      assert.ok(step4.data.description.includes('0x71C8'));
      assert.ok(step4.data.description.includes('ce57'));
    });

    test('buildPayoutWizardActionRow provides back and cancel options at all steps', () => {
      for (let s = 1; s <= 4; s++) {
        const row = buildPayoutWizardActionRow('usr_1', s);
        assert.ok(row.components.length >= 2);
        const hasBackOrCancel = row.components.some(
          (b) => b.data.label.includes('Back') || b.data.label.includes('Cancel')
        );
        assert.ok(hasBackOrCancel, `Step ${s} must have back or cancel navigation`);
      }
    });

    test('handlePayoutWizConfirm creates payout request and returns success embed', async () => {
      const interaction = createMockButtonInteraction({ customId: 'payout_wiz_confirm:usr_111111111111111111' });
      await handlePayoutWizConfirm(interaction, 'usr_111111111111111111');

      assert.ok(interaction._state.editPayload);
      assert.ok(interaction._state.editPayload.embeds[0].data.title.includes('Submitted Successfully'));
    });
  });

  // =========================================================================
  // 6. CREATOR PROFILE VIEW
  // =========================================================================
  describe('6. Creator Profile View & Masking', () => {
    test('buildCreatorProfileEmbed masks wallet address and formats joined date', () => {
      const user = {
        username: 'creator_1',
        createdAt: new Date('2026-01-15T00:00:00Z')
      };
      const profile = {
        walletAddress: '0x71C8363837381F025701262B49f43E92B690ce57',
        network: 'Ethereum',
        verifiedAt: new Date()
      };

      const embed = buildCreatorProfileEmbed(user, profile, { activeCampaignsCount: 3 }, { username: 'creator_1' });
      const serialized = JSON.stringify(embed.data);

      assert.ok(serialized.includes('0x71C8'));
      assert.ok(serialized.includes('ce57'));
      assert.equal(serialized.includes('0x71C8363837381F025701262B49f43E92B690ce57'), false);
      assert.ok(serialized.includes('**3** joined'));
    });

    test('handleDashboardProfile displays profile and Dashboard button', async () => {
      const interaction = createMockButtonInteraction({ customId: 'dash_profile:usr_111111111111111111' });
      await handleDashboardProfile(interaction, 'usr_111111111111111111');

      assert.ok(interaction._state.editPayload);
      assert.ok(interaction._state.editPayload.embeds[0].data.title.includes('Creator Profile'));
      const homeBtn = interaction._state.editPayload.components[0].components.find((b) => b.data.label === '🏠 Dashboard');
      assert.ok(homeBtn);
    });
  });

  // =========================================================================
  // 7. STAFF CONTROL CENTER
  // =========================================================================
  describe('7. Staff Control Center & Admin Subviews', () => {
    test('handleAdminControlCenter rejects non-administrative callers server-side', async () => {
      const interaction = createMockButtonInteraction({
        customId: 'admin_dash_home',
        userId: '111111111111111111',
        roles: [] // Regular creator, no admin roles
      });

      await assert.rejects(
        () => handleAdminControlCenter(interaction),
        (err) => err instanceof UnauthorizedAdminActionError || err instanceof InsufficientPermissionError
      );
    });

    test('handleAdminControlCenter renders Control Center embed for authorized staff', async () => {
      const interaction = createMockButtonInteraction({
        customId: 'admin_dash_home',
        userId: mockAdminUser.discordId,
        roles: [ADMIN_ROLE_ID]
      });

      await handleAdminControlCenter(interaction);

      assert.ok(interaction._state.editPayload);
      assert.equal(interaction._state.editPayload.embeds[0].data.title, '🛡️ PEAK CLIP — CONTROL CENTER');
      assert.equal(interaction._state.editPayload.components.length, 3);
    });

    test('buildAdminControlCenterRows provides buttons for Review Queue, Payout Queue, Campaigns, Creators, Reports, Refresh', () => {
      const rows = buildAdminControlCenterRows();
      assert.equal(rows.length, 3);

      const allLabels = rows.flatMap((r) => r.components.map((c) => c.data.label));

      assert.ok(allLabels.includes('📋 Review Queue'));
      assert.ok(allLabels.includes('💸 Payout Queue'));
      assert.ok(allLabels.includes('🎯 Campaigns'));
      assert.ok(allLabels.includes('👥 Creators'));
      assert.ok(allLabels.includes('📊 Reports'));
      assert.ok(allLabels.includes('🔄 Refresh'));
    });

    test('handleAdminReviewQueueNav renders review queue and Admin Nav Row', async () => {
      const interaction = createMockButtonInteraction({
        customId: 'admin_dash_reviews:1',
        userId: mockAdminUser.discordId,
        roles: [ADMIN_ROLE_ID]
      });

      await handleAdminReviewQueueNav(interaction, 1);

      assert.ok(interaction._state.editPayload);
      assert.ok(interaction._state.editPayload.embeds[0].data.title.includes('Review Queue'));
      const controlBtn = interaction._state.editPayload.components[0].components.find((b) => b.data.label === '🛡️ Control Center');
      assert.ok(controlBtn);
    });

    test('handleAdminPayoutQueueNav renders payout queue and Admin Nav Row', async () => {
      const interaction = createMockButtonInteraction({
        customId: 'admin_dash_payouts:1',
        userId: mockAdminUser.discordId,
        roles: [ADMIN_ROLE_ID]
      });

      await handleAdminPayoutQueueNav(interaction, 1);

      assert.ok(interaction._state.editPayload);
      assert.ok(interaction._state.editPayload.embeds[0].data.title.includes('Payout Review Queue'));
      const controlBtn = interaction._state.editPayload.components[0].components.find((b) => b.data.label === '🛡️ Control Center');
      assert.ok(controlBtn);
    });

    test('handleAdminReportsNav renders system reports embed and Admin Nav Row', async () => {
      const interaction = createMockButtonInteraction({
        customId: 'admin_dash_reports',
        userId: mockAdminUser.discordId,
        roles: [ADMIN_ROLE_ID]
      });

      await handleAdminReportsNav(interaction);

      assert.ok(interaction._state.editPayload);
      assert.ok(interaction._state.editPayload.embeds[0].data.title.includes('System & Performance Reports'));
    });
  });

  // =========================================================================
  // 8. SECURITY & ANTI-TAMPERING
  // =========================================================================
  describe('8. Server-Side Security & Anti-Tampering', () => {
    test('creator cannot access another creators dashboard data via tampered customId', async () => {
      // User B attempts to access User A's data
      const interaction = createMockButtonInteraction({
        customId: 'dash_clips:usr_creator_OTHER:1',
        userId: '111111111111111111' // Maps to usr_111111111111111111 != usr_creator_OTHER
      });

      await handleDashboardMyClips(interaction, 'usr_creator_OTHER', 1);

      assert.ok(interaction._state.followUpPayload);
      assert.ok(interaction._state.followUpPayload.content.includes('Unauthorized'));
    });

    test('handleDashboardBack verifies targetUserId matches caller identity', async () => {
      const interaction = createMockButtonInteraction({
        customId: 'dash_back:usr_OTHER:home',
        userId: '111111111111111111'
      });

      await handleDashboardBack(interaction, 'usr_OTHER', 'home');

      assert.ok(interaction._state.followUpPayload);
      assert.ok(interaction._state.followUpPayload.content.includes('Unauthorized'));
    });
  });

  // =========================================================================
  // 9. ROUTER DISPATCH & ZERO DEAD-END INTEGRITY
  // =========================================================================
  describe('9. Router Integration & Navigation Integrity', () => {
    test('router dispatches dash_home button click', async () => {
      const interaction = createMockButtonInteraction({
        customId: 'dash_home:usr_111111111111111111',
        userId: '111111111111111111'
      });

      await handleInteraction(interaction);
      assert.ok(interaction._state.editPayload);
      assert.equal(interaction._state.editPayload.embeds[0].data.title, '🎬 PEAK CLIP — CREATOR CENTER');
    });

    test('router dispatches dash_open button click (e.g. from #welcome)', async () => {
      const interaction = createMockButtonInteraction({
        customId: 'dash_open',
        userId: '111111111111111111'
      });

      await handleInteraction(interaction);
      assert.ok(interaction._state.editPayload);
      assert.equal(interaction._state.editPayload.embeds[0].data.title, '🎬 PEAK CLIP — CREATOR CENTER');
    });

    test('router gracefully ignores noop_ page buttons without error', async () => {
      const interaction = createMockButtonInteraction({
        customId: 'noop_page:1',
        userId: '111111111111111111'
      });

      await handleInteraction(interaction);
      assert.equal(interaction._state.deferred, true);
    });

    test('router catches and sanitizes unauthorized admin button interaction', async () => {
      const interaction = createMockButtonInteraction({
        customId: 'admin_dash_home',
        userId: '111111111111111111',
        roles: [] // Unauthorized
      });

      await handleInteraction(interaction);

      // Router catches the UnauthorizedAdminActionError/InsufficientPermissionError
      // and responds safely without crashing — no reference ID in permission messages
      assert.ok(interaction._state.replyPayload || interaction._state.editPayload);
      const payload = interaction._state.replyPayload || interaction._state.editPayload;
      assert.ok(payload.content, 'Error response must have content');
      // Accept either legacy ephemeral:true or modern flags:MessageFlags.Ephemeral (64)
      const isEphemeral = payload.ephemeral === true || (payload.flags & 64) !== 0;
      assert.ok(isEphemeral, 'Error response must be ephemeral');
    });


    test('zero dead-end screens: buildNavigationBackRow always provides Dashboard or Back', () => {
      const backHome = buildNavigationBackRow('usr_1', 'home');
      assert.equal(backHome.components.length, 1);
      assert.equal(backHome.components[0].data.label, '🏠 Dashboard');

      const backWithTarget = buildNavigationBackRow('usr_1', 'dash_campaigns:1');
      assert.equal(backWithTarget.components.length, 2);
      assert.equal(backWithTarget.components[0].data.label, '◀ Back');
      assert.equal(backWithTarget.components[1].data.label, '🏠 Dashboard');
    });

    test('zero dead-end screens: buildAdminNavRow always provides Control Center', () => {
      const row = buildAdminNavRow('admin_dash_home');
      assert.equal(row.components.length, 2);
      assert.equal(row.components[0].data.label, '◀ Back');
      assert.equal(row.components[1].data.label, '🛡️ Control Center');
    });
  });
});
