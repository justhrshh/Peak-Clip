import { EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { prisma } from '../../database/client.js';
import { staffIds, STAFF_COMPONENTS } from '../components/staffComponentIds.js';
import { userService } from '../../modules/users/user.service.js';
import { campaignService } from '../../modules/campaigns/campaign.service.js';
import { statisticsService } from '../../modules/statistics/statistics.service.js';
import { earningsService } from '../../modules/earnings/earnings.service.js';
import { payoutService } from '../../modules/payouts/payout.service.js';
import { payoutProfileService } from '../../modules/payout-profile/payout-profile.service.js';
import { adminSubmissionService } from '../../modules/admin/admin.submission.service.js';
import { adminPayoutService } from '../../modules/admin/admin.payout.service.js';
import { adminCampaignService } from '../../modules/admin/admin.campaign.service.js';
import { adminCreatorService } from '../../modules/admin/admin.creator.service.js';
import {
  assertAdminPermission,
  AdminPermission,
  AdminRole
} from '../../modules/admin/admin.auth.js';
import {
  buildCreatorDashboardEmbed,
  buildCreatorProfileEmbed,
  buildAdminControlCenterEmbed,
  buildCreatorClipsListEmbed,
  buildCreatorClipDetailEmbed,
  buildPayoutWizardEmbed
} from '../embeds/dashboard.embeds.js';
import {
  buildCampaignListEmbed,
  buildCampaignDetailEmbed
} from '../embeds/campaign.embeds.js';
import {
  buildUserEarningsEmbed
} from '../embeds/earnings.embeds.js';
import {
  buildUserPayoutEmbed,
  buildPayoutProfileEmbed
} from '../embeds/payout.embeds.js';
import {
  buildCreatorDashboardActionRows,
  buildNavigationBackRow,
  buildDashboardPaginationRow,
  buildPayoutHubActionRows,
  buildAdminControlCenterRows,
  buildAdminNavRow,
  buildPayoutWizardActionRow
} from '../components/dashboard.components.js';
import {
  buildPayoutProfileModal,
  buildPayoutModal
} from '../components/payout.components.js';
import {
  buildCampaignActionRow,
  buildCampaignSelectMenu
} from '../components/campaign.components.js';
import { logger } from '../../utils/logger.js';

const PAGE_SIZE = 5;

/**
 * Helper to acknowledge creator interactions safely and idempotently:
 * - Public channel entry points (dash_open, pub_dash_*) open an EPHEMERAL reply.
 * - In-dashboard navigation buttons update the existing ephemeral view in place.
 *
 * @param {import('discord.js').Interaction} interaction
 */
export async function acknowledgeCreatorInteraction(interaction) {
  if (interaction.deferred || interaction.replied) return;

  const isPublicEntry =
    !interaction.customId ||
    interaction.customId === 'dash_open' ||
    interaction.customId.startsWith('pub_') ||
    (typeof interaction.isChatInputCommand === 'function' && interaction.isChatInputCommand());

  if (isPublicEntry) {
    if (typeof interaction.deferReply === 'function') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
  } else {
    if (typeof interaction.deferUpdate === 'function') {
      await interaction.deferUpdate().catch(async () => {
        if (!interaction.deferred && !interaction.replied && typeof interaction.deferReply === 'function') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        }
      });
    } else if (typeof interaction.deferReply === 'function') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
  }
}

/**
 * Handle opening or refreshing the Creator Center Dashboard
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {string} [targetUserId=null]
 * @param {boolean} [isRefresh=false]
 */
export async function handleCreatorDashboard(interaction, targetUserId = null, isRefresh = false) {
  // 1. Acknowledge interaction safely
  await acknowledgeCreatorInteraction(interaction);

  // 2. Authorize / resolve creator user
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  // Cross-creator access guard (supports internal UUID or Discord Snowflake ID)
  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    const errorMsg = '❌ You can only view and manage your own Creator Dashboard.';
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: errorMsg, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  // If user requested a live refresh, attempt to refresh their most recent approved submission metrics
  if (isRefresh) {
    try {
      if (prisma?.submission?.findFirst) {
        const staleSub = await prisma.submission.findFirst({
          where: {
            userId: user.id,
            status: 'APPROVED'
          },
          include: {
            snapshots: {
              orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
              take: 1
            }
          },
          orderBy: { updatedAt: 'desc' }
        });

        const lastSnap = staleSub?.snapshots?.[0];
        const isStale = !lastSnap || (Date.now() - new Date(lastSnap.capturedAt).getTime() > 120000);
        if (staleSub && isStale) {
          await adminSubmissionService.refreshSubmissionMetrics(staleSub.id, {
            discordId: interaction.user.id,
            userId: user.id
          }).catch((err) => {
            logger.warn({ err: err?.message, submissionId: staleSub.id }, 'Non-fatal error refreshing submission metrics during creator refresh');
          });
        }
      }
    } catch (refreshErr) {
      logger.warn({ err: refreshErr?.message }, 'Non-fatal error checking stale submissions on refresh');
    }
  }

  // 3. Authoritatively fetch creator metrics, ledger breakdown & campaigns
  const [overview, balance, payoutRequests, userCampaigns, activeCampaigns] = await Promise.all([
    statisticsService.getUserOverview(user.id).catch(() => ({})),
    payoutService.getAvailablePayoutBalance(user.id).catch(() => ({ availableBalance: 0, currency: 'USD' })),
    payoutService.listPayoutRequests({ userId: user.id }).catch(() => []),
    campaignService.getUserCampaigns(user.id).catch(() => []),
    campaignService.listActiveCampaigns().catch(() => [])
  ]);

  // Compute live budget consumption for campaigns
  const activeJoined = (userCampaigns || []).filter((m) => m.status === 'ACTIVE');
  const targetCampaigns = activeJoined.length > 0
    ? activeJoined.map((m) => ({ id: m.campaignId, isMember: true }))
    : (activeCampaigns || []).slice(0, 2).map((c) => ({ id: c.id, isMember: false }));

  const campaignSummaries = [];
  for (const tc of targetCampaigns) {
    try {
      const liveBudget = await campaignService.getCampaignLiveBudget(tc.id);
      campaignSummaries.push({
        ...liveBudget,
        isMember: tc.isMember
      });
    } catch (campErr) {
      logger.debug({ err: campErr?.message, campaignId: tc.id }, 'Error getting live campaign budget for dashboard');
    }
  }

  // Resolve active/pending payout if any
  const activePayout = Array.isArray(payoutRequests)
    ? payoutRequests.find((p) => ['REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING'].includes(p.status)) || null
    : null;

  const dashboardData = {
    availableBalance: (Number(balance?.availableBalance) || 0).toFixed(2),
    currency: balance?.currency || 'USD',
    activeClipsCount: overview?.totalSubmissions ?? overview?.submissionsCount?.total ?? 0,
    approvedClipsCount: overview?.approvedSubmissions ?? overview?.submissionsCount?.approved ?? 0,
    underReviewClipsCount: overview?.underReviewSubmissions ?? overview?.submissionsCount?.underReview ?? 0,
    totalViews: overview?.totalViews?.knownSum ?? 0n,
    eligibleViews: overview?.totalEligibleViews ?? 0n,
    activePayout: activePayout ? {
      id: activePayout.id,
      amount: activePayout.amount,
      status: activePayout.status
    } : null,
    campaigns: campaignSummaries,
    isRefresh: Boolean(isRefresh)
  };

  // 4. Build embed & component action rows
  const embed = buildCreatorDashboardEmbed(dashboardData, interaction.user);
  const rows = buildCreatorDashboardActionRows(user.id);

  // 5. Respond and return immediately (no fall-through)
  await interaction.editReply({
    embeds: [embed],
    components: rows
  });

  return;
}

/**
 * Handle [ 🎯 Campaigns ] button in Creator Dashboard
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {string} targetUserId
 * @param {number} [page=1]
 */
export async function handleDashboardCampaigns(interaction, targetUserId, page = 1) {
  await acknowledgeCreatorInteraction(interaction);
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({ content: '❌ Unauthorized.', flags: MessageFlags.Ephemeral });
    return;
  }

  const p = Math.max(1, parseInt(page, 10) || 1);
  const allCampaigns = await campaignService.listActiveCampaigns().catch(() => []);
  const total = allCampaigns.length;
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
  const campaigns = allCampaigns.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);

  const userCampaigns = await campaignService.getUserCampaigns(user.id).catch(() => []);
  const embed = buildCampaignListEmbed(campaigns, userCampaigns);
  const paginationRow = buildDashboardPaginationRow('dash_campaigns', user.id, p, totalPages, 'dash_home');

  // Build campaign select menu so creators can drill into a campaign detail
  const selectMenuRow = buildCampaignSelectMenu(campaigns);

  const components = selectMenuRow
    ? [selectMenuRow, paginationRow]
    : [paginationRow];

  await interaction.editReply({
    embeds: [embed],
    components
  });
  return;
}

/**
 * Handle viewing specific campaign detail card
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {string} targetUserId
 * @param {string} campaignId
 */
export async function handleDashboardCampaignDetail(interaction, targetUserId, campaignId) {
  if ((typeof interaction.isButton === 'function' && interaction.isButton()) || (typeof interaction.isStringSelectMenu === 'function' && interaction.isStringSelectMenu())) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }
  }
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({ content: '❌ Unauthorized.', flags: MessageFlags.Ephemeral });
    return;
  }

  const [campaign, userCampaigns] = await Promise.all([
    campaignService.getCampaignById(campaignId).catch(() => null),
    campaignService.getUserCampaigns(user.id).catch(() => [])
  ]);

  if (!campaign) {
    await interaction.editReply({
      content: '⚠️ This campaign could not be found or has ended.',
      embeds: [],
      components: [buildNavigationBackRow(user.id, 'dash_campaigns:1')]
    });
    return;
  }

  const membership = userCampaigns.find((m) => m.campaignId === campaign.id && m.status === 'ACTIVE');
  const embed = buildCampaignDetailEmbed(campaign, membership);
  // Pass full campaign to action row so budget/status-based join state is correct
  const actionRow = buildCampaignActionRow(campaign.id, Boolean(membership), campaign);
  const navRow = buildNavigationBackRow(user.id, 'dash_campaigns:1');

  await interaction.editReply({
    embeds: [embed],
    components: [actionRow, navRow]
  });
  return;
}

/**
 * Handle [ 🚀 Join Campaign ] button inside creator dashboard
 * Verifies campaign state, creator eligibility, then calls existing joinCampaign service.
 * Refreshes the campaign detail view on success.
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {string} campaignId
 */
export async function handleDashboardCampaignJoin(interaction, campaignId) {
  await acknowledgeCreatorInteraction(interaction);
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  // Resolve and validate campaign (service enforces all policy rules)
  const campaign = await campaignService.getCampaignById(campaignId).catch(() => null);
  if (!campaign) {
    await interaction.editReply({
      content: '⚠️ Campaign not found. It may have been removed or the link is outdated.',
      embeds: [],
      components: []
    });
    return;
  }

  // Delegate entirely to existing service — enforces status, budget, window, user eligibility
  await campaignService.joinCampaign(user.id, campaignId);

  // Refresh campaign data after join
  const updatedCampaign = await campaignService.getCampaignById(campaignId).catch(() => campaign);

  const embed = buildCampaignDetailEmbed(updatedCampaign, { status: 'ACTIVE' });
  const actionRow = buildCampaignActionRow(updatedCampaign.id, true, updatedCampaign);
  const navRow = buildNavigationBackRow(user.id, 'dash_campaigns:1');

  await interaction.editReply({
    content: '✅ **Joined!** You are now an active member of this campaign.',
    embeds: [embed],
    components: [actionRow, navRow]
  });
}

/**
 * Handle [ 🎬 My Clips ] button in Creator Dashboard
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {string} targetUserId
 * @param {number} [page=1]
 */
export async function handleDashboardMyClips(interaction, targetUserId, page = 1) {
  await acknowledgeCreatorInteraction(interaction);
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({ content: '❌ Unauthorized.', flags: MessageFlags.Ephemeral });
    return;
  }

  const p = Math.max(1, parseInt(page, 10) || 1);
  const result = await statisticsService.getCreatorVideos(user.id, { page: p, limit: PAGE_SIZE })
    .catch((err) => {
      logger.warn({ err: err?.message, userId: user.id }, 'Error retrieving creator videos in dashboard');
      return { items: [], total: 0, page: p, totalPages: 1 };
    });

  const clips = result.items || result.videos || [];
  const total = result.total !== undefined ? result.total : clips.length;
  const totalPages = result.totalPages || Math.ceil(total / PAGE_SIZE) || 1;

  const embed = buildCreatorClipsListEmbed(clips, p, totalPages, interaction.user);
  const paginationRow = buildDashboardPaginationRow('dash_clips', user.id, p, totalPages, 'dash_home');

  await interaction.editReply({
    embeds: [embed],
    components: [paginationRow]
  });
  return;
}

/**
 * Handle [ 💰 Earnings ] button in Creator Dashboard
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {string} targetUserId
 */
export async function handleDashboardEarnings(interaction, targetUserId) {
  await acknowledgeCreatorInteraction(interaction);
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({ content: '❌ Unauthorized.', flags: MessageFlags.Ephemeral });
    return;
  }

  const earnings = await earningsService.getUserEarnings(user.id).catch(() => ({}));
  const embed = buildUserEarningsEmbed(earnings, interaction.user);
  const navRow = buildNavigationBackRow(user.id, 'home');

  await interaction.editReply({
    embeds: [embed],
    components: [navRow]
  });
  return;
}

/**
 * Handle [ 💸 Payout ] button in Creator Dashboard
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {string} targetUserId
 */
export async function handleDashboardPayout(interaction, targetUserId) {
  await acknowledgeCreatorInteraction(interaction);
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({ content: '❌ Unauthorized.', flags: MessageFlags.Ephemeral });
    return;
  }

  const [balance, profile, payoutRequests] = await Promise.all([
    payoutService.getAvailablePayoutBalance(user.id).catch(() => ({ availableBalance: 0, currency: 'USD' })),
    payoutProfileService.getProfileByUserId(user.id).catch(() => null),
    payoutService.listPayoutRequests({ userId: user.id }).catch(() => [])
  ]);

  const activePayout = Array.isArray(payoutRequests)
    ? payoutRequests.find((p) => ['REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING'].includes(p.status)) || null
    : null;

  const canCancel = activePayout && ['REQUESTED', 'UNDER_REVIEW', 'APPROVED'].includes(activePayout.status);

  const embed = buildUserPayoutEmbed(balance, payoutRequests || [], interaction.user, profile);
  const rows = buildPayoutHubActionRows({
    userId: user.id,
    hasProfile: Boolean(profile),
    hasActivePayout: Boolean(activePayout),
    activePayoutId: activePayout?.id || null,
    canCancel
  });

  await interaction.editReply({
    embeds: [embed],
    components: rows
  });
  return;
}

/**
 * Handle [ 👤 Profile ] button in Creator Dashboard
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {string} targetUserId
 */
export async function handleDashboardProfile(interaction, targetUserId) {
  await acknowledgeCreatorInteraction(interaction);
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({ content: '❌ Unauthorized.', flags: MessageFlags.Ephemeral });
    return;
  }

  const [profile, overview] = await Promise.all([
    payoutProfileService.getProfileByUserId(user.id).catch(() => null),
    statisticsService.getUserOverview(user.id).catch(() => ({}))
  ]);

  const embed = buildCreatorProfileEmbed(
    user,
    profile,
    { activeCampaignsCount: overview?.activeCampaignsJoined ?? overview?.campaignsCount?.active ?? 0 },
    interaction.user
  );
  const navRow = buildNavigationBackRow(user.id, 'home');

  await interaction.editReply({
    embeds: [embed],
    components: [navRow]
  });
  return;
}

/**
 * Handle opening the Staff Control Center Dashboard
 *
 * @param {import('discord.js').Interaction} interaction
 */
export async function handleAdminControlCenter(interaction) {
  // Enforce administrative permissions server-side before acknowledging interaction
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_VIEW);

  if (typeof interaction.isButton === 'function' && interaction.isButton()) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  } else if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const [
    reviewQueue,
    payoutRequests,
    activeCampaigns,
    totalCreators,
    regStats,
    retentionMonitoringCount,
    deletionAlertsCount,
    creatorsRequiringAttention
  ] = await Promise.all([
    adminSubmissionService.listReviewQueue({ limit: 100, includePending: true }).catch(() => []),
    adminPayoutService.listPayoutRequests({ status: 'REQUESTED' }).catch(() => []),
    campaignService.listActiveCampaigns().catch(() => []),
    prisma.user.count().catch(() => 0),
    adminSubmissionService.getSubmissionRegistryStats().catch(() => null),
    prisma.submission.count({ where: { status: 'APPROVED', retentionStatus: { in: ['PENDING_CHECK', 'ACTIVE'] } } }).catch(() => 0),
    prisma.submission.count({ where: { retentionStatus: 'VIOLATED' } }).catch(() => 0),
    prisma.user.count({ where: { status: { in: ['SUSPENDED', 'BANNED'] } } }).catch(() => 0)
  ]);

  const queueItems = Array.isArray(reviewQueue) ? reviewQueue : (reviewQueue?.items || []);
  const payoutItems = Array.isArray(payoutRequests) ? payoutRequests : (payoutRequests?.items || []);
  const campaignItems = Array.isArray(activeCampaigns) ? activeCampaigns : (activeCampaigns?.items || []);

  const pendingReviewCount = (regStats?.pending ?? 0) + (regStats?.underReview ?? 0);
  const suspiciousClipsCount = (regStats?.flagged ?? 0) + (regStats?.postApproval ?? 0);

  const metrics = {
    pendingReviewCount: pendingReviewCount || queueItems.length,
    reviewQueueCount: pendingReviewCount || queueItems.length,
    suspiciousClipsCount,
    trackingCount: regStats?.approved ?? 0,
    deletionAlertsCount: deletionAlertsCount || 0,
    retentionMonitoringCount: retentionMonitoringCount || 0,
    payoutQueueCount: payoutRequests?.total ?? payoutItems.length,
    creatorsRequiringAttention: creatorsRequiringAttention || 0,
    totalCreatorsCount: totalCreators || 0,
    activeCampaignsCount: activeCampaigns?.total ?? campaignItems.length,
    systemStatus: 'OPERATIONAL',
    totalSubmissions: regStats?.total ?? 0,
    flaggedCount: regStats?.flagged ?? 0,
    approvedCount: regStats?.approved ?? 0,
    youtubeTrackedCount: regStats?.platforms?.youtube ?? 0
  };

  const embed = buildAdminControlCenterEmbed(metrics, interaction.user);
  const rows = buildAdminControlCenterRows();

  await interaction.editReply({
    embeds: [embed],
    components: rows
  });
  return;
}

/**
 * Handle Staff Review Queue Navigation
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {number} [page=1]
 */
export async function handleAdminReviewQueueNav(interaction, page = 1) {
  // Enforce administrative permissions server-side before acknowledging interaction
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_REVIEW);

  if (typeof interaction.isButton === 'function' && interaction.isButton()) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  } else if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const p = Math.max(1, parseInt(page, 10) || 1);
  const queueResult = await adminSubmissionService.listReviewQueue({ page: p, limit: PAGE_SIZE, includePending: true });
  const queue = Array.isArray(queueResult) ? queueResult : (queueResult?.items || []);
  const totalItems = queueResult?.total ?? (await prisma.submission.count({
    where: { status: { in: ['PENDING_VERIFICATION', 'UNDER_REVIEW', 'POST_APPROVAL_REVIEW', 'FLAGGED'] } }
  }).catch(() => queue.length));
  const totalPages = queueResult?.totalPages ?? (Math.ceil(totalItems / PAGE_SIZE) || 1);

  // Build review queue embed
  const embed = new EmbedBuilder()
    .setTitle(`📋 Staff Review Queue — Page ${p}/${totalPages}`)
    .setDescription(queue.length === 0
      ? '✅ No submissions currently pending review.'
      : queue.map((sub, i) => `${(p - 1) * PAGE_SIZE + i + 1}. **${sub.platform}** • \`${sub.status}\` • <@${sub.user?.discordId || 'Creator'}>\n[Video Link](${sub.url})`).join('\n\n'))
    .setColor(0x3498db)
    .setTimestamp();

  // Add individual inspect buttons for submissions so staff can review them right from the dashboard
  const inspectRow = new ActionRowBuilder();
  if (queue.length > 0) {
    queue.slice(0, 5).forEach((sub, i) => {
      const idx = (p - 1) * PAGE_SIZE + i + 1;
      inspectRow.addComponents(
        new ButtonBuilder()
          .setCustomId(staffIds.subView(sub.id))
          .setLabel(`🔎 Review #${idx}`)
          .setStyle(ButtonStyle.Primary)
      );
    });
  }

  const navRow = buildAdminNavRow(STAFF_COMPONENTS.HOME);
  const components = inspectRow.components.length > 0 ? [navRow, inspectRow] : [navRow];

  await interaction.editReply({
    embeds: [embed],
    components
  });
  return;
}

/**
 * Handle Staff Payout Queue Navigation
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {number} [page=1]
 */
export async function handleAdminPayoutQueueNav(interaction, page = 1) {
  // Enforce administrative permissions server-side before acknowledging interaction
  assertAdminPermission(interaction, AdminPermission.PAYOUT_VIEW);

  if (typeof interaction.isButton === 'function' && interaction.isButton()) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  } else if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const p = Math.max(1, parseInt(page, 10) || 1);
  const rawRequests = await adminPayoutService.listPayoutRequests({ status: 'REQUESTED', page: p, limit: PAGE_SIZE }).catch(() => []);
  const requests = Array.isArray(rawRequests) ? rawRequests : (rawRequests?.items || []);
  const totalItems = rawRequests?.total ?? (await prisma.payoutRequest.count({
    where: { status: 'REQUESTED' }
  }).catch(() => requests.length));
  const totalPages = rawRequests?.totalPages ?? (Math.ceil(totalItems / PAGE_SIZE) || 1);

  const embed = new EmbedBuilder()
    .setTitle(`💸 Staff Payout Review Queue — Page ${p}/${totalPages}`)
    .setDescription(requests.length === 0
      ? '✅ No payout requests currently pending review.'
      : requests.map((req, i) => `${(p - 1) * PAGE_SIZE + i + 1}. **$${Number(req.amount).toFixed(2)}** • \`${req.status}\` • Creator: <@${req.user?.discordId || req.userId}>`).join('\n\n'))
    .setColor(0x2ecc71)
    .setTimestamp();

  const inspectRow = new ActionRowBuilder();
  if (requests.length > 0) {
    requests.slice(0, 5).forEach((req, i) => {
      const idx = (p - 1) * PAGE_SIZE + i + 1;
      inspectRow.addComponents(
        new ButtonBuilder()
          .setCustomId(staffIds.pqViewReq(req.id))
          .setLabel(`🔎 Payout #${idx}`)
          .setStyle(ButtonStyle.Primary)
      );
    });
  }

  const navRow = buildAdminNavRow(STAFF_COMPONENTS.HOME);
  const components = inspectRow.components.length > 0 ? [navRow, inspectRow] : [navRow];

  await interaction.editReply({
    embeds: [embed],
    components
  });
  return;
}

/**
 * Handle Staff Campaigns Navigation
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {number} [page=1]
 */
export async function handleAdminCampaignsNav(interaction, page = 1) {
  // Enforce administrative permissions server-side before acknowledging interaction
  assertAdminPermission(interaction, AdminPermission.CAMPAIGN_EDIT);

  if (typeof interaction.isButton === 'function' && interaction.isButton()) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  } else if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const p = Math.max(1, parseInt(page, 10) || 1);
  const rawCampaigns = await campaignService.listActiveCampaigns().catch(() => []);
  const allCampaigns = Array.isArray(rawCampaigns) ? rawCampaigns : (rawCampaigns?.items || []);
  const campaigns = allCampaigns.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
  const totalPages = rawCampaigns?.totalPages ?? (Math.ceil(allCampaigns.length / PAGE_SIZE) || 1);

  const embed = new EmbedBuilder()
    .setTitle(`🎯 Active Campaign Management — Page ${p}/${totalPages}`)
    .setDescription(campaigns.length === 0
      ? 'No active campaigns found.'
      : campaigns.map((c, i) => `${(p - 1) * PAGE_SIZE + i + 1}. **${c.name}** (\`${c.status}\`)\nBudget: $${c.totalBudget} | CPM: $${c.payRate}`).join('\n\n'))
    .setColor(0xe67e22)
    .setTimestamp();

  const inspectRow = new ActionRowBuilder();
  if (campaigns.length > 0) {
    campaigns.slice(0, 4).forEach((c, i) => {
      const idx = (p - 1) * PAGE_SIZE + i + 1;
      inspectRow.addComponents(
        new ButtonBuilder()
          .setCustomId(staffIds.cmpView(c.id))
          .setLabel(`🎯 #${idx}`)
          .setStyle(ButtonStyle.Primary)
      );
    });
  }
  inspectRow.addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.cmpCreateBtn())
      .setLabel('➕ Create')
      .setStyle(ButtonStyle.Success)
  );

  const navRow = buildAdminNavRow(STAFF_COMPONENTS.HOME);
  const components = [navRow, inspectRow];

  await interaction.editReply({
    embeds: [embed],
    components
  });
  return;
}

/**
 * Handle Staff Creators Navigation
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {number} [page=1]
 */
export async function handleAdminCreatorsNav(interaction, page = 1) {
  // Enforce administrative permissions server-side before acknowledging interaction
  assertAdminPermission(interaction, AdminPermission.CREATOR_VIEW);

  if (typeof interaction.isButton === 'function' && interaction.isButton()) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  } else if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const p = Math.max(1, parseInt(page, 10) || 1);
  const totalCount = await prisma.user.count().catch(() => 0);
  const totalPages = Math.ceil(totalCount / PAGE_SIZE) || 1;
  const rawCreators = await prisma.user.findMany({
    skip: (p - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    orderBy: { createdAt: 'desc' },
    select: { id: true, discordId: true, username: true, displayName: true, status: true, createdAt: true }
  }).catch(() => []);
  const creators = Array.isArray(rawCreators) ? rawCreators : (rawCreators?.items || []);

  const embed = new EmbedBuilder()
    .setTitle(`👥 Staff Creator Management — Page ${p}/${totalPages}`)
    .setDescription(creators.length === 0
      ? 'No creators registered yet.'
      : creators.map((cr, i) => `${(p - 1) * PAGE_SIZE + i + 1}. **${cr.username}** (\`${cr.status}\`) • <@${cr.discordId}>\nJoined: <t:${Math.floor(new Date(cr.createdAt).getTime() / 1000)}:R>`).join('\n\n'))
    .setColor(0x9b59b6)
    .setTimestamp();

  const inspectRow = new ActionRowBuilder();
  if (creators.length > 0) {
    creators.slice(0, 4).forEach((cr, i) => {
      const idx = (p - 1) * PAGE_SIZE + i + 1;
      inspectRow.addComponents(
        new ButtonBuilder()
          .setCustomId(staffIds.crView(cr.id))
          .setLabel(`👤 #${idx}`)
          .setStyle(ButtonStyle.Primary)
      );
    });
  }
  inspectRow.addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.crSearchBtn())
      .setLabel('🔍 Search')
      .setStyle(ButtonStyle.Secondary)
  );

  const navRow = buildAdminNavRow(STAFF_COMPONENTS.HOME);
  const components = [navRow, inspectRow];

  await interaction.editReply({
    embeds: [embed],
    components
  });
  return;
}

/**
 * Handle Staff Reports Navigation
 *
 * @param {import('discord.js').Interaction} interaction
 */
export async function handleAdminReportsNav(interaction) {
  // Enforce administrative permissions server-side before acknowledging interaction
  assertAdminPermission(interaction, AdminPermission.AUDIT_VIEW);

  if (typeof interaction.isButton === 'function' && interaction.isButton()) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  } else if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const [
    totalCampaigns,
    activeCampaigns,
    totalSubmissions,
    pendingSubmissions,
    approvedSubmissions,
    totalCreators,
    earningsAggregate,
    payoutDisbursedAggregate,
    payoutPendingAggregate
  ] = await Promise.all([
    prisma.campaign.count().catch(() => 0),
    prisma.campaign.count({ where: { status: 'ACTIVE' } }).catch(() => 0),
    prisma.submission.count().catch(() => 0),
    prisma.submission.count({ where: { status: { in: ['UNDER_REVIEW', 'PENDING_VERIFICATION', 'FLAGGED', 'POST_APPROVAL_REVIEW'] } } }).catch(() => 0),
    prisma.submission.count({ where: { status: 'APPROVED' } }).catch(() => 0),
    prisma.user.count().catch(() => 0),
    prisma.earning.aggregate({ _sum: { grossAmount: true } }).catch(() => ({ _sum: { grossAmount: 0 } })),
    prisma.payoutRequest.aggregate({ where: { status: 'COMPLETED' }, _sum: { amount: true } }).catch(() => ({ _sum: { amount: 0 } })),
    prisma.payoutRequest.aggregate({ where: { status: { in: ['REQUESTED', 'APPROVED', 'PROCESSING'] } }, _sum: { amount: true } }).catch(() => ({ _sum: { amount: 0 } }))
  ]);

  const embed = new EmbedBuilder()
    .setTitle('📊 Administrative System & Performance Reports')
    .setDescription('Platform metrics, verification flow, creator participation, and financial commitments.')
    .addFields(
      { name: '🎯 Active Campaigns', value: `**${activeCampaigns}** live / **${totalCampaigns}** total`, inline: true },
      { name: '👥 Registered Creators', value: `**${totalCreators}** creators`, inline: true },
      { name: '⚙️ System Health', value: '🟢 `OPERATIONAL`', inline: true },
      { name: '📥 Submissions', value: `Total: **${totalSubmissions}**\nApproved: **${approvedSubmissions}**\nIn Review: **${pendingSubmissions}**`, inline: true },
      { name: '💰 Total Earnings Credited', value: `$**${Number(earningsAggregate?._sum?.grossAmount || 0).toFixed(2)}**`, inline: true },
      { name: '💸 Disbursed Volume', value: `$**${Number(payoutDisbursedAggregate?._sum?.amount || 0).toFixed(2)}**`, inline: true },
      { name: '⏳ Pending Payout Liability', value: `$**${Number(payoutPendingAggregate?._sum?.amount || 0).toFixed(2)}**`, inline: true }
    )
    .setColor(0x1abc9c)
    .setTimestamp();

  const navRow = buildAdminNavRow(STAFF_COMPONENTS.HOME);

  await interaction.editReply({
    embeds: [embed],
    components: [navRow]
  });
  return;
}

/**
 * Handle viewing specific clip detail card
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {string} targetUserId
 * @param {string} submissionId
 */
export async function handleDashboardClipDetail(interaction, targetUserId, submissionId) {
  if (typeof interaction.isButton === 'function' && interaction.isButton()) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  }
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({ content: '❌ Unauthorized.', flags: MessageFlags.Ephemeral });
    return;
  }

  const clipStats = await statisticsService.getSubmissionStatistics(user.id, submissionId);
  const clipData = {
    platform: clipStats.submission.platform,
    url: clipStats.submission.url,
    campaignName: clipStats.submission.campaign?.name || 'Campaign',
    status: clipStats.status,
    createdAt: clipStats.submission.createdAt,
    views: clipStats.metrics.views || 0n,
    eligibleViews: clipStats.financials.eligibleViews || 0n,
    grossEarnings: clipStats.financials.grossEarnings || '0.00',
    retentionRequired: clipStats.submission.retentionRequired,
    retentionStatus: clipStats.submission.retentionStatus,
    retentionDeadline: clipStats.submission.retentionDeadline,
    rejectionReason: clipStats.submission.rejectionReason,
    adminNote: clipStats.submission.adminNote
  };

  const embed = buildCreatorClipDetailEmbed(clipData, interaction.user);
  const navRow = buildNavigationBackRow(user.id, 'dash_clips:1');

  await interaction.editReply({
    embeds: [embed],
    components: [navRow]
  });
  return;
}

/**
 * Handle Back navigation button
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {string} targetUserId
 * @param {string} targetView
 */
export async function handleDashboardBack(interaction, targetUserId, targetView) {
  if (typeof interaction.isButton === 'function' && interaction.isButton()) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  }
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({ content: '❌ Unauthorized.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (!targetView || targetView === 'home' || targetView === 'dash_home') {
    return handleCreatorDashboard(interaction, user.id);
  }

  if (targetView.startsWith('dash_campaigns')) {
    const page = parseInt(targetView.split(':')[1], 10) || 1;
    return handleDashboardCampaigns(interaction, user.id, page);
  }

  if (targetView.startsWith('dash_clips')) {
    const page = parseInt(targetView.split(':')[1], 10) || 1;
    return handleDashboardMyClips(interaction, user.id, page);
  }

  if (targetView.startsWith('dash_payout')) {
    return handleDashboardPayout(interaction, user.id);
  }

  return handleCreatorDashboard(interaction, user.id);
}

/**
 * Handle Dashboard in-place Refresh
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {string} targetUserId
 */
export async function handleDashboardRefresh(interaction, targetUserId) {
  return handleCreatorDashboard(interaction, targetUserId, true);
}

/**
 * Handle Payout Profile Setup button (opens modal)
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {string} targetUserId
 */
export async function handlePayoutProfileSetup(interaction, targetUserId) {
  const user = await userService.getOrCreateFromDiscord(interaction.user);
  if (targetUserId && targetUserId !== user.id) {
    await interaction.reply({ content: '❌ Unauthorized.', flags: MessageFlags.Ephemeral });
    return;
  }

  const profile = await payoutProfileService.getProfileByUserId(user.id).catch(() => null);
  const modal = buildPayoutProfileModal(user.id, profile);
  await interaction.showModal(modal);
}

/**
 * Handle Payout Profile View button
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {string} targetUserId
 */
export async function handlePayoutProfileView(interaction, targetUserId) {
  await acknowledgeCreatorInteraction(interaction);
  const user = await userService.getOrCreateFromDiscord(interaction.user);
  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({ content: '❌ Unauthorized.', flags: MessageFlags.Ephemeral });
    return;
  }

  const profile = await payoutProfileService.getProfileByUserId(user.id).catch(() => null);
  const embed = buildPayoutProfileEmbed(profile, interaction.user);
  const navRow = buildNavigationBackRow(user.id, 'dash_payout');

  await interaction.editReply({
    embeds: [embed],
    components: [navRow]
  });
}

/**
 * Handle Payout Wizard Step navigation
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {string} targetUserId
 * @param {number} step
 */
export async function handlePayoutWizStep(interaction, targetUserId, step = 1) {
  if (interaction.isButton()) await interaction.deferUpdate().catch(() => {});
  const user = await userService.getOrCreateFromDiscord(interaction.user);
  if (targetUserId && targetUserId !== user.id) {
    await interaction.followUp({ content: '❌ Unauthorized.', flags: MessageFlags.Ephemeral });
    return;
  }

  const [balance, profile] = await Promise.all([
    payoutService.getAvailablePayoutBalance(user.id),
    payoutProfileService.getProfileByUserId(user.id).catch(() => null)
  ]);

  const stepNum = parseInt(step, 10) || 1;
  const wizardData = {
    availableBalance: balance.availableBalance.toFixed(2),
    currency: balance.currency,
    minimumPayout: 10,
    amount: balance.availableBalance.toFixed(2),
    profile
  };

  const embed = buildPayoutWizardEmbed(stepNum, wizardData);
  const row = buildPayoutWizardActionRow(user.id, stepNum);

  await interaction.editReply({
    embeds: [embed],
    components: [row]
  });
}

/**
 * Handle Payout Wizard Confirmation submission
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {string} targetUserId
 */
export async function handlePayoutWizConfirm(interaction, targetUserId) {
  if (interaction.isButton()) await interaction.deferUpdate().catch(() => {});
  const user = await userService.getOrCreateFromDiscord(interaction.user);
  if (targetUserId && targetUserId !== user.id) {
    await interaction.followUp({ content: '❌ Unauthorized.', flags: MessageFlags.Ephemeral });
    return;
  }

  const balance = await payoutService.getAvailablePayoutBalance(user.id);
  const payout = await payoutService.createPayoutRequest(user.id, balance.availableBalance.toFixed(2), balance.currency);

  const embed = new EmbedBuilder()
    .setTitle('✅ Payout Request Submitted Successfully')
    .setDescription(`Your payout request \`${payout.id}\` for **$${Number(payout.amount).toFixed(2)} ${payout.currency}** has been submitted and is under review by staff.`)
    .setColor(0x2ecc71)
    .setTimestamp();

  const navRow = buildNavigationBackRow(user.id, 'home');

  await interaction.editReply({
    embeds: [embed],
    components: [navRow]
  });
}

/**
 * Handle Staff Suspicious Clips Queue Navigation
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {number} [page=1]
 */
export async function handleAdminSuspiciousNav(interaction, page = 1) {
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_REVIEW);

  if (typeof interaction.isButton === 'function' && interaction.isButton()) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  } else if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const p = Math.max(1, parseInt(page, 10) || 1);
  const where = { status: { in: ['FLAGGED', 'POST_APPROVAL_REVIEW'] } };
  const [totalItems, clips] = await Promise.all([
    prisma.submission.count({ where }).catch(() => 0),
    prisma.submission.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (p - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { user: true, campaign: true }
    }).catch(() => [])
  ]);

  const totalPages = Math.ceil(totalItems / PAGE_SIZE) || 1;

  const embed = new EmbedBuilder()
    .setTitle(`⚠️ Staff Suspicious Clips Queue — Page ${p}/${totalPages}`)
    .setDescription(clips.length === 0
      ? '✅ No suspicious clips currently flagged.'
      : clips.map((sub, i) => {
          const idx = (p - 1) * PAGE_SIZE + i + 1;
          const creator = `<@${sub.user?.discordId || 'Creator'}>`;
          const reason = sub.rejectionReason || sub.structuredReason || 'SUSPICIOUS_VELOCITY_OR_ANOMALY';
          return `${idx}. **${sub.platform}** • \`${sub.status}\` • ${creator}\nCampaign: **${sub.campaign?.name || 'Campaign'}** | Reason: \`${reason}\`\n[Video Link](${sub.url})`;
        }).join('\n\n'))
    .setColor(0xe74c3c)
    .setTimestamp();

  const inspectRow = new ActionRowBuilder();
  if (clips.length > 0) {
    clips.slice(0, 5).forEach((sub, i) => {
      const idx = (p - 1) * PAGE_SIZE + i + 1;
      inspectRow.addComponents(
        new ButtonBuilder()
          .setCustomId(staffIds.subView(sub.id))
          .setLabel(`🔎 Inspect #${idx}`)
          .setStyle(ButtonStyle.Danger)
      );
    });
  }

  const navRow = buildAdminNavRow(STAFF_COMPONENTS.HOME);
  const components = inspectRow.components.length > 0 ? [navRow, inspectRow] : [navRow];

  await interaction.editReply({
    embeds: [embed],
    components
  });
}

/**
 * Handle Staff Active Tracking Queue Navigation
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {number} [page=1]
 */
export async function handleAdminTrackingNav(interaction, page = 1) {
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_VIEW);

  if (typeof interaction.isButton === 'function' && interaction.isButton()) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  } else if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const p = Math.max(1, parseInt(page, 10) || 1);
  const where = { status: 'APPROVED' };
  const [totalItems, clips] = await Promise.all([
    prisma.submission.count({ where }).catch(() => 0),
    prisma.submission.findMany({
      where,
      orderBy: { verifiedAt: 'desc' },
      skip: (p - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        user: true,
        campaign: true,
        snapshots: {
          orderBy: { capturedAt: 'desc' },
          take: 1
        }
      }
    }).catch(() => [])
  ]);

  const totalPages = Math.ceil(totalItems / PAGE_SIZE) || 1;

  const embed = new EmbedBuilder()
    .setTitle(`📡 Staff Active Tracking Queue — Page ${p}/${totalPages}`)
    .setDescription(clips.length === 0
      ? 'ℹ️ No approved clips currently tracked.'
      : clips.map((sub, i) => {
          const idx = (p - 1) * PAGE_SIZE + i + 1;
          const creator = `<@${sub.user?.discordId || 'Creator'}>`;
          const views = sub.snapshots?.[0]?.views ? Number(sub.snapshots[0].views).toLocaleString() : 'Pending poll';
          return `${idx}. **${sub.platform}** • Approved • ${creator}\nCampaign: **${sub.campaign?.name || 'Campaign'}** | Views: **${views}**\n[Video Link](${sub.url})`;
        }).join('\n\n'))
    .setColor(0x3498db)
    .setTimestamp();

  const inspectRow = new ActionRowBuilder();
  if (clips.length > 0) {
    clips.slice(0, 5).forEach((sub, i) => {
      const idx = (p - 1) * PAGE_SIZE + i + 1;
      inspectRow.addComponents(
        new ButtonBuilder()
          .setCustomId(staffIds.subView(sub.id))
          .setLabel(`🔎 View #${idx}`)
          .setStyle(ButtonStyle.Primary)
      );
    });
  }

  const navRow = buildAdminNavRow(STAFF_COMPONENTS.HOME);
  const components = inspectRow.components.length > 0 ? [navRow, inspectRow] : [navRow];

  await interaction.editReply({
    embeds: [embed],
    components
  });
}

/**
 * Handle Staff Early Deletion Alerts Queue Navigation
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {number} [page=1]
 */
export async function handleAdminDeletionsNav(interaction, page = 1) {
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_VIEW);

  if (typeof interaction.isButton === 'function' && interaction.isButton()) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  } else if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const p = Math.max(1, parseInt(page, 10) || 1);
  const where = { retentionStatus: 'VIOLATED' };
  const [totalItems, clips] = await Promise.all([
    prisma.submission.count({ where }).catch(() => 0),
    prisma.submission.findMany({
      where,
      orderBy: { retentionViolatedAt: 'desc' },
      skip: (p - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { user: true, campaign: true }
    }).catch(() => [])
  ]);

  const totalPages = Math.ceil(totalItems / PAGE_SIZE) || 1;

  const embed = new EmbedBuilder()
    .setTitle(`🚨 Staff Deletion Alerts Queue — Page ${p}/${totalPages}`)
    .setDescription(clips.length === 0
      ? '✅ No early deletion violations detected.'
      : clips.map((sub, i) => {
          const idx = (p - 1) * PAGE_SIZE + i + 1;
          const creator = `<@${sub.user?.discordId || 'Creator'}>`;
          const reason = sub.retentionViolationReason || 'Video removed before 30 days';
          const time = sub.retentionViolatedAt ? `<t:${Math.floor(new Date(sub.retentionViolatedAt).getTime() / 1000)}:R>` : 'Recently';
          return `${idx}. **${sub.platform}** • \`EARLY_DELETION\` • ${creator}\nCampaign: **${sub.campaign?.name || 'Campaign'}** | Violated: ${time}\nReason: \`${reason}\`\n[Video Link](${sub.url})`;
        }).join('\n\n'))
    .setColor(0x992d22)
    .setTimestamp();

  const inspectRow = new ActionRowBuilder();
  if (clips.length > 0) {
    clips.slice(0, 5).forEach((sub, i) => {
      const idx = (p - 1) * PAGE_SIZE + i + 1;
      inspectRow.addComponents(
        new ButtonBuilder()
          .setCustomId(staffIds.subView(sub.id))
          .setLabel(`🔎 Inspect #${idx}`)
          .setStyle(ButtonStyle.Danger)
      );
    });
  }

  const navRow = buildAdminNavRow(STAFF_COMPONENTS.HOME);
  const components = inspectRow.components.length > 0 ? [navRow, inspectRow] : [navRow];

  await interaction.editReply({
    embeds: [embed],
    components
  });
}

/**
 * Handle Staff 30-Day Retention Monitoring Queue Navigation
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {number} [page=1]
 */
export async function handleAdminMonitoringNav(interaction, page = 1) {
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_VIEW);

  if (typeof interaction.isButton === 'function' && interaction.isButton()) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  } else if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const p = Math.max(1, parseInt(page, 10) || 1);
  const where = { status: 'APPROVED', retentionStatus: { in: ['PENDING_CHECK', 'ACTIVE'] } };
  const [totalItems, clips] = await Promise.all([
    prisma.submission.count({ where }).catch(() => 0),
    prisma.submission.findMany({
      where,
      orderBy: { retentionDeadline: 'asc' },
      skip: (p - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { user: true, campaign: true }
    }).catch(() => [])
  ]);

  const totalPages = Math.ceil(totalItems / PAGE_SIZE) || 1;

  const embed = new EmbedBuilder()
    .setTitle(`🛡️ Staff 30-Day Retention Monitoring — Page ${p}/${totalPages}`)
    .setDescription(clips.length === 0
      ? '✅ No clips currently in 30-day retention monitoring window.'
      : clips.map((sub, i) => {
          const idx = (p - 1) * PAGE_SIZE + i + 1;
          const creator = `<@${sub.user?.discordId || 'Creator'}>`;
          const deadline = sub.retentionDeadline ? `<t:${Math.floor(new Date(sub.retentionDeadline).getTime() / 1000)}:R>` : 'Pending calculation';
          return `${idx}. **${sub.platform}** • \`${sub.retentionStatus}\` • ${creator}\nCampaign: **${sub.campaign?.name || 'Campaign'}** | Deadline: ${deadline}\n[Video Link](${sub.url})`;
        }).join('\n\n'))
    .setColor(0x2ecc71)
    .setTimestamp();

  const inspectRow = new ActionRowBuilder();
  if (clips.length > 0) {
    clips.slice(0, 5).forEach((sub, i) => {
      const idx = (p - 1) * PAGE_SIZE + i + 1;
      inspectRow.addComponents(
        new ButtonBuilder()
          .setCustomId(staffIds.subView(sub.id))
          .setLabel(`🔎 View #${idx}`)
          .setStyle(ButtonStyle.Primary)
      );
    });
  }

  const navRow = buildAdminNavRow(STAFF_COMPONENTS.HOME);
  const components = inspectRow.components.length > 0 ? [navRow, inspectRow] : [navRow];

  await interaction.editReply({
    embeds: [embed],
    components
  });
}


