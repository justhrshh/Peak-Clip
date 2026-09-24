import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { formatError, AppError } from '../../utils/errors.js';
import { MessageFlags, EmbedBuilder } from 'discord.js';
import { channelInactivityManager } from '../provisioning/channel.inactivity.js';
import {
  CampaignBudgetExhaustedError,
  CampaignNotFoundError,
  CampaignNotActiveError,
  CampaignNotJoinableError,
  MembershipError
} from '../../modules/campaigns/campaign.errors.js';
import {
  CampaignBudgetExhaustedSubmissionError,
  NotCampaignMemberError,
  PlatformNotAllowedError,
  DuplicateSubmissionError,
  ClipDurationOutOfRangeError,
  InvalidSubmissionUrlError,
  UnsupportedPlatformError
} from '../../modules/submissions/submission.errors.js';
import {
  UnauthorizedAdminActionError,
  InsufficientPermissionError,
  AlreadyReviewedError
} from '../../modules/admin/admin.errors.js';
import {
  PayoutError,
  InvalidPayoutStatusTransitionError
} from '../../modules/payouts/payout.errors.js';
import { PayoutProfileError } from '../../modules/payout-profile/payout-profile.service.js';
import { EvidenceValidationError } from '../../modules/evidence/evidence.validator.js';
import { CREATOR_COMPONENTS } from '../components/creatorComponentIds.js';
import { STAFF_COMPONENTS } from '../components/staffComponentIds.js';
import {
  handleStaffReviewQueueHub,
  handleStaffReviewQueueView,
  handleStaffSubmissionView,
  handleStaffSubmissionReverify,
  handleStaffSubmissionApprove,
  handleStaffSubmissionKeepReview,
  handleStaffSubmissionRejectBtn,
  handleStaffSubmissionRejectModalSubmit,
  handleStaffSubmissionFlag,
  handleStaffSubmissionRegistryList,
  handleStaffSubmissionRegistryDetail,
  handleStaffSubmissionRefreshMetrics,
  handleStaffSubmissionManualMetricsBtn,
  handleStaffSubmissionManualMetricsModalSubmit,
  handleStaffSubmissionAnalytics,
  handleStaffSubmissionSearchBtn,
  handleStaffSubmissionSearchModalSubmit,
  handleStaffCreatorHub,
  handleStaffCreatorList,
  handleStaffCreatorSearchBtn,
  handleStaffCreatorSearchModalSubmit,
  handleStaffCreatorView,
  handleStaffCreatorStatus,
  handleStaffCreatorSubs,
  handleStaffCampaignHub,
  handleStaffCampaignList,
  handleStaffCampaignCreateBtn,
  handleStaffCampaignCreateModalSubmit,
  handleStaffCampaignView,
  handleStaffCampaignStatus,
  handleStaffCampaignReport,
  handleStaffPayoutHub,
  handleStaffPayoutQueueView,
  handleStaffPayoutHistory,
  handleStaffPayoutViewReq,
  handleStaffEvidenceReview,
  handleStaffEvidenceAccept,
  handleStaffEvidenceRejectBtn,
  handleStaffEvidenceRejectModalSubmit,
  handleStaffPayoutApprove,
  handleStaffPayoutRejectBtn,
  handleStaffPayoutRejectModalSubmit,
  handleStaffPayoutProcess,
  handleStaffAuditHub,
  handleStaffAuditList,
  handleStaffSystemStatus,
  handleStaffBotErrorsRefresh,
  handleStaffChannelReset
} from './staff.interactions.js';


import {
  handleCampaignSelect,
  handleCampaignJoin,
  handleCampaignLeave,
  handleCampaignList
} from './campaign.interactions.js';
import {
  handleCampaignSelectForSubmit,
  handleModalSubmitClip,
  handleSubmissionsPagination,
  handlePublicSubmitClip
} from './submission.interactions.js';
import {
  handleStatsOverview,
  handleStatsCampaignsList,
  handleStatsPlatforms,
  handleStatsChannels,
  handleStatsCampaignSelect,
  handleStatsClipsList,
  handleStatsClipSelect,
  handleStatsRefresh
} from './statistics.interactions.js';
import {
  handleEarningsOverview,
  handleEarningsCampaignsList,
  handleEarningsCampaignSelect,
  handleEarningsRefresh
} from './earnings.interactions.js';
import {
  handlePayoutRequestButton,
  handlePayoutProfileButton,
  handlePayoutModalSubmit,
  handlePayoutProfileModalSubmit,
  handlePayoutRefresh,
  handlePayoutCancelButton,
  handlePayoutCancelConfirm,
  handlePayoutCancelKeep,
  handlePayoutEvidenceUploadButton,
  handlePayoutEvidenceReviewButton,
  handlePayoutEvidenceSubmitButton,
  handlePayoutEvidenceCancelButton,
  handlePayoutEvidenceBackButton
} from './payout.interactions.js';
import { handleAdminButtonInteraction } from './admin.interactions.js';
import {
  handleCreatorDashboard,
  handleDashboardCampaigns,
  handleDashboardCampaignDetail,
  handleDashboardCampaignJoin,
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
  handleAdminReportsNav,
  handleAdminSuspiciousNav,
  handleAdminTrackingNav,
  handleAdminDeletionsNav,
  handleAdminMonitoringNav
} from './dashboard.interactions.js';

/**
 * Main interaction router for Discord events
 * Dispatches slash commands, buttons, menus, and modals to their respective thin handlers
 * Provides guild isolation, correlation ID tracing, customId tampering protection, and error sanitation
 * @param {import('discord.js').Interaction} interaction
 */
export async function handleInteraction(interaction) {
  const correlationId = `int_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const identifier = interaction.commandName || interaction.customId || 'unknown';
  const userId = interaction.user?.id;
  const guildId = interaction.guildId;

  logger.info({ correlationId, interactionId: interaction.id, type: interaction.type, user: userId, guildId, target: identifier }, 'Interaction received');

  if (interaction.channel) {
    channelInactivityManager.touch(interaction.channel);
  }

  const safeReply = async (payload) => {
    try {
      const isNonEphemeralChannelMessage = interaction.message && (!interaction.message.flags || (typeof interaction.message.flags.has === 'function' ? !interaction.message.flags.has(MessageFlags.Ephemeral) : !(interaction.message.flags & MessageFlags.Ephemeral)));

      if (interaction.replied) {
        if (isNonEphemeralChannelMessage && payload.flags && typeof interaction.followUp === 'function') {
          return await interaction.followUp(payload);
        }
        if (typeof interaction.editReply === 'function') {
          return await interaction.editReply(payload);
        }
        if (typeof interaction.followUp === 'function') {
          return await interaction.followUp(payload);
        }
        logger.warn({ correlationId, interactionId: interaction.id }, 'Interaction already replied; skipping safeReply');
        return;
      }

      if (interaction.deferred) {
        if (isNonEphemeralChannelMessage && payload.flags && typeof interaction.followUp === 'function') {
          return await interaction.followUp(payload);
        } else if (typeof interaction.editReply === 'function') {
          return await interaction.editReply(payload);
        } else if (typeof interaction.followUp === 'function') {
          return await interaction.followUp(payload);
        }
      } else if (typeof interaction.reply === 'function') {
        return await interaction.reply(payload);
      } else if (typeof interaction.update === 'function') {
        return await interaction.update(payload);
      }
    } catch (replyErr) {
      logger.warn(
        { correlationId, err: replyErr.message },
        'Initial safeReply attempt failed'
      );
    }
  };

  try {
    // 0. Guild isolation guard: If guild is configured, reject interactions originating from foreign guilds
    if (config.discord?.guildId && guildId && guildId !== config.discord.guildId) {
      logger.warn({ correlationId, guildId, configuredGuildId: config.discord.guildId }, 'Interaction rejected: foreign guild');
      await safeReply({
        content: `⚠️ This bot is configured for a specific server and cannot process requests here. (Reference: ${correlationId})`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // 1. Slash Commands
    if (interaction.isChatInputCommand()) {
      const command = interaction.client?.commands?.get(interaction.commandName);

      if (!command) {
        logger.warn({ correlationId, commandName: interaction.commandName }, 'Command not found in registry');
        await safeReply({
          content: `⚠️ This command is currently unavailable or unrecognized. (Reference: ${correlationId})`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      await command.execute(interaction);
      logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
      return;
    }

    // 2. Select Menus
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'campaign:select') {
        await handleCampaignSelect(interaction);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (interaction.customId === 'submit:campaign:select') {
        await handleCampaignSelectForSubmit(interaction);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (interaction.customId.startsWith('stats_select_campaign:')) {
        const targetUserId = interaction.customId.split(':')[1];
        await handleStatsCampaignSelect(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (interaction.customId.startsWith('stats_select_clip:')) {
        const targetUserId = interaction.customId.split(':')[1];
        await handleStatsClipSelect(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (interaction.customId.startsWith('earnings_select_campaign:')) {
        const targetUserId = interaction.customId.split(':')[1];
        await handleEarningsCampaignSelect(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (interaction.customId === 'admin_camp_report_sub_select') {
        const submissionId = interaction.values[0];
        await handleStaffSubmissionView(interaction, submissionId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // Catch-all for tampered or unrecognized select menu custom IDs
      logger.warn({ correlationId, customId: interaction.customId }, 'Unrecognized or tampered select menu custom ID');
      await safeReply({
        content: `⚠️ This menu action is unrecognized, invalid, or expired. (Reference: ${correlationId})`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // 3. Buttons
    if (interaction.isButton()) {
      const customId = interaction.customId;

      if (customId === 'campaign:list') {
        await handleCampaignList(interaction);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('campaign:join:')) {
        const campaignId = customId.split(':')[2];
        await handleCampaignJoin(interaction, campaignId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('campaign:leave:')) {
        const campaignId = customId.split(':')[2];
        await handleCampaignLeave(interaction, campaignId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('submission:list:')) {
        const page = parseInt(customId.split(':')[2], 10) || 1;
        await handleSubmissionsPagination(interaction, page);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('stats_overview:')) {
        const targetUserId = customId.split(':')[1];
        await handleStatsOverview(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('stats_campaigns:')) {
        const parts = customId.split(':');
        const targetUserId = parts[1];
        const page = parts[2] ? parseInt(parts[2], 10) || 1 : 1;
        await handleStatsCampaignsList(interaction, targetUserId, page);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('stats_platforms:')) {
        const targetUserId = customId.split(':')[1];
        await handleStatsPlatforms(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('stats_channels:')) {
        const targetUserId = customId.split(':')[1];
        await handleStatsChannels(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('stats_clips:')) {
        const [, targetUserId, campaignId, pageStr] = customId.split(':');
        await handleStatsClipsList(interaction, targetUserId, campaignId, parseInt(pageStr, 10) || 1);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('stats_refresh:')) {
        const [, targetUserId, viewType, extraId] = customId.split(':');
        await handleStatsRefresh(interaction, targetUserId, viewType, extraId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('earnings_overview:')) {
        const targetUserId = customId.split(':')[1];
        await handleEarningsOverview(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('earnings_campaigns:')) {
        const targetUserId = customId.split(':')[1];
        await handleEarningsCampaignsList(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('earnings_refresh:')) {
        const [, targetUserId, viewType, extraId] = customId.split(':');
        await handleEarningsRefresh(interaction, targetUserId, viewType, extraId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('payout_request_btn:')) {
        const targetUserId = customId.split(':')[1];
        await handlePayoutRequestButton(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('payout_profile_btn:')) {
        const targetUserId = customId.split(':')[1];
        await handlePayoutProfileButton(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('payout_refresh:')) {
        const targetUserId = customId.split(':')[1];
        await handlePayoutRefresh(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('payout_cancel_btn:')) {
        const parts = customId.split(':');
        const targetUserId = parts[1];
        const payoutId = parts[2];
        await handlePayoutCancelButton(interaction, targetUserId, payoutId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('payout_cancel_confirm:')) {
        const parts = customId.split(':');
        const targetUserId = parts[1];
        const payoutId = parts[2];
        await handlePayoutCancelConfirm(interaction, targetUserId, payoutId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('payout_cancel_keep:')) {
        const parts = customId.split(':');
        const targetUserId = parts[1];
        const payoutId = parts[2];
        await handlePayoutCancelKeep(interaction, targetUserId, payoutId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('payout_ev_upload:')) {
        const targetUserId = customId.split(':')[1];
        await handlePayoutEvidenceUploadButton(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('payout_ev_review:')) {
        const targetUserId = customId.split(':')[1];
        await handlePayoutEvidenceReviewButton(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('payout_ev_submit:')) {
        const targetUserId = customId.split(':')[1];
        await handlePayoutEvidenceSubmitButton(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('payout_ev_cancel:')) {
        const targetUserId = customId.split(':')[1];
        await handlePayoutEvidenceCancelButton(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('payout_ev_back:')) {
        const targetUserId = customId.split(':')[1];
        await handlePayoutEvidenceBackButton(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // No-op buttons (e.g. page indicators)
      if (customId.startsWith('noop_')) {
        await interaction.deferUpdate().catch(() => {});
        return;
      }

      // Creator Dashboard persistent entry point
      if (customId === CREATOR_COMPONENTS.OPEN_DASHBOARD) {
        await handleCreatorDashboard(interaction, null);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // Public Creator Channel persistent button entry points (all reply ephemerally)
      if (customId === CREATOR_COMPONENTS.PUB_CAMPAIGNS || customId === CREATOR_COMPONENTS.PUB_CAMPAIGNS_REFRESH) {
        await handleDashboardCampaigns(interaction, null, 1);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === CREATOR_COMPONENTS.PUB_SUBMIT) {
        await handlePublicSubmitClip(interaction);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === CREATOR_COMPONENTS.PUB_CLIPS || customId === CREATOR_COMPONENTS.PUB_SUBMISSIONS_REFRESH) {
        await handleDashboardMyClips(interaction, null, 1);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === CREATOR_COMPONENTS.PUB_STATS || customId === CREATOR_COMPONENTS.PUB_STATS_REFRESH) {
        await handleStatsOverview(interaction, null);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === CREATOR_COMPONENTS.PUB_EARNINGS || customId === CREATOR_COMPONENTS.PUB_EARNINGS_REFRESH) {
        await handleDashboardEarnings(interaction, null);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === CREATOR_COMPONENTS.PUB_PAYOUT_REQUEST) {
        await handlePayoutRequestButton(interaction, null);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === CREATOR_COMPONENTS.PUB_PROFILE) {
        await handlePayoutProfileView(interaction, null);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === CREATOR_COMPONENTS.PUB_PAYOUT_HISTORY || customId === CREATOR_COMPONENTS.PUB_PAYOUTS_REFRESH) {
        await handleDashboardPayout(interaction, null);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // Creator Dashboard internal home navigation (dash_home or dash_home:<userId>)
      if (customId === CREATOR_COMPONENTS.DASH_HOME || customId.startsWith(`${CREATOR_COMPONENTS.DASH_HOME}:`)) {
        const targetUserId = customId.includes(':') ? customId.split(':')[1] : null;
        await handleCreatorDashboard(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // In-Dashboard Campaigns Navigation (dash_campaigns, dash_campaigns:<page>, dash_campaigns:<userId>:<page>)
      if (customId === CREATOR_COMPONENTS.DASH_CAMPAIGNS || customId.startsWith(`${CREATOR_COMPONENTS.DASH_CAMPAIGNS}:`)) {
        const parts = customId.split(':');
        let targetUserId = null;
        let page = 1;
        if (parts.length === 2) {
          if (parts[1].startsWith('usr_')) {
            targetUserId = parts[1];
          } else {
            page = parseInt(parts[1], 10) || 1;
          }
        } else if (parts.length >= 3) {
          targetUserId = parts[1];
          page = parseInt(parts[2], 10) || 1;
        }
        await handleDashboardCampaigns(interaction, targetUserId, page);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // In-Dashboard Submissions / My Clips Navigation
      // Supports both current (dash_my_clips) and legacy (dash_clips)
      // Formats: dash_my_clips, dash_my_clips:<page>, dash_my_clips:<userId>:<page>
      //          dash_clips, dash_clips:<page>, dash_clips:<userId>:<page>
      if (
        customId === CREATOR_COMPONENTS.DASH_MY_CLIPS ||
        customId.startsWith(`${CREATOR_COMPONENTS.DASH_MY_CLIPS}:`) ||
        customId === CREATOR_COMPONENTS.DASH_CLIPS ||
        customId.startsWith(`${CREATOR_COMPONENTS.DASH_CLIPS}:`)
      ) {
        const parts = customId.split(':');
        let targetUserId = null;
        let page = 1;
        if (parts.length === 2) {
          if (parts[1].startsWith('usr_')) {
            targetUserId = parts[1];
          } else {
            page = parseInt(parts[1], 10) || 1;
          }
        } else if (parts.length >= 3) {
          targetUserId = parts[1];
          page = parseInt(parts[2], 10) || 1;
        }
        await handleDashboardMyClips(interaction, targetUserId, page);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // Campaign Detail View (dash_campaign_view:<campaignId> or dash_campaign_view:<userId>:<campaignId>)
      if (customId.startsWith(`${CREATOR_COMPONENTS.DASH_CAMPAIGN_VIEW}:`)) {
        const parts = customId.split(':');
        let targetUserId = null;
        let campaignId = null;
        if (parts.length === 2) {
          campaignId = parts[1];
        } else if (parts.length >= 3) {
          targetUserId = parts[1];
          campaignId = parts[2];
        }
        await handleDashboardCampaignDetail(interaction, targetUserId, campaignId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // Clip Detail View (dash_clip_view:<submissionId> or dash_clip_view:<userId>:<submissionId>)
      if (customId.startsWith(`${CREATOR_COMPONENTS.DASH_CLIP_VIEW}:`)) {
        const parts = customId.split(':');
        let targetUserId = null;
        let submissionId = null;
        if (parts.length === 2) {
          submissionId = parts[1];
        } else if (parts.length >= 3) {
          targetUserId = parts[1];
          submissionId = parts[2];
        }
        await handleDashboardClipDetail(interaction, targetUserId, submissionId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // In-Dashboard Stats Overview (dash_stats or dash_stats:<userId>)
      if (customId === CREATOR_COMPONENTS.DASH_STATS || customId.startsWith(`${CREATOR_COMPONENTS.DASH_STATS}:`)) {
        const targetUserId = customId.includes(':') ? customId.split(':')[1] : null;
        await handleStatsOverview(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // In-Dashboard Earnings Overview (dash_earnings or dash_earnings:<userId>)
      if (customId === CREATOR_COMPONENTS.DASH_EARNINGS || customId.startsWith(`${CREATOR_COMPONENTS.DASH_EARNINGS}:`)) {
        const targetUserId = customId.includes(':') ? customId.split(':')[1] : null;
        await handleDashboardEarnings(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // In-Dashboard Payouts Hub (dash_payout or dash_payout:<userId>)
      if (customId === CREATOR_COMPONENTS.DASH_PAYOUT || customId.startsWith(`${CREATOR_COMPONENTS.DASH_PAYOUT}:`)) {
        const targetUserId = customId.includes(':') ? customId.split(':')[1] : null;
        await handleDashboardPayout(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // In-Dashboard Profile View (dash_profile or dash_profile:<userId>)
      if (customId === CREATOR_COMPONENTS.DASH_PROFILE || customId.startsWith(`${CREATOR_COMPONENTS.DASH_PROFILE}:`)) {
        const targetUserId = customId.includes(':') ? customId.split(':')[1] : null;
        await handleDashboardProfile(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // Payout Profile Setup (dash_profile_setup or dash_profile_setup:<userId>)
      if (customId === CREATOR_COMPONENTS.DASH_PROFILE_SETUP || customId.startsWith(`${CREATOR_COMPONENTS.DASH_PROFILE_SETUP}:`)) {
        const targetUserId = customId.includes(':') ? customId.split(':')[1] : null;
        await handlePayoutProfileSetup(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // Payout Profile View (dash_profile_view or dash_profile_view:<userId>)
      if (customId === CREATOR_COMPONENTS.DASH_PROFILE_VIEW || customId.startsWith(`${CREATOR_COMPONENTS.DASH_PROFILE_VIEW}:`)) {
        const targetUserId = customId.includes(':') ? customId.split(':')[1] : null;
        await handlePayoutProfileView(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // Payout Profile Edit (dash_profile_edit or dash_profile_edit:<userId>)
      if (customId === CREATOR_COMPONENTS.DASH_PROFILE_EDIT || customId.startsWith(`${CREATOR_COMPONENTS.DASH_PROFILE_EDIT}:`)) {
        const targetUserId = customId.includes(':') ? customId.split(':')[1] : null;
        await handlePayoutProfileButton(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // Payout Request Modal Opener (dash_payout_request or dash_payout_request:<userId>)
      if (customId === CREATOR_COMPONENTS.DASH_PAYOUT_REQUEST || customId.startsWith(`${CREATOR_COMPONENTS.DASH_PAYOUT_REQUEST}:`)) {
        const targetUserId = customId.includes(':') ? customId.split(':')[1] : null;
        await handlePayoutRequestButton(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // In-Dashboard Refresh (dash_refresh or dash_refresh:<userId>)
      if (customId === CREATOR_COMPONENTS.DASH_REFRESH || customId.startsWith(`${CREATOR_COMPONENTS.DASH_REFRESH}:`)) {
        const targetUserId = customId.includes(':') ? customId.split(':')[1] : null;
        await handleDashboardRefresh(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // In-Dashboard Back Navigation (dash_back:<targetView> or dash_back:<userId>:<targetView>)
      if (customId === CREATOR_COMPONENTS.DASH_BACK || customId.startsWith(`${CREATOR_COMPONENTS.DASH_BACK}:`)) {
        const parts = customId.split(':');
        let targetUserId = null;
        let targetView = 'dash_home';
        if (parts.length === 2) {
          targetView = parts[1];
        } else if (parts.length >= 3) {
          targetUserId = parts[1];
          targetView = parts.slice(2).join(':');
        }
        await handleDashboardBack(interaction, targetUserId, targetView);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // Payout Wizard step navigation (payout_wiz_step:<step> or payout_wiz_step:<userId>:<step>)
      if (customId.startsWith(`${CREATOR_COMPONENTS.PAYOUT_WIZ_STEP}:`)) {
        const parts = customId.split(':');
        let targetUserId = null;
        let step = 1;
        if (parts.length === 2) {
          step = parseInt(parts[1], 10) || 1;
        } else if (parts.length >= 3) {
          targetUserId = parts[1];
          step = parseInt(parts[2], 10) || 1;
        }
        await handlePayoutWizStep(interaction, targetUserId, step);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // Payout Wizard Confirm
      if (customId === CREATOR_COMPONENTS.PAYOUT_WIZ_CONFIRM || customId.startsWith(`${CREATOR_COMPONENTS.PAYOUT_WIZ_CONFIRM}:`)) {
        const targetUserId = customId.includes(':') ? customId.split(':')[1] : null;
        await handlePayoutWizConfirm(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // Payout Wizard Amount Modal
      if (customId === CREATOR_COMPONENTS.PAYOUT_WIZ_AMOUNT_MODAL || customId.startsWith(`${CREATOR_COMPONENTS.PAYOUT_WIZ_AMOUNT_MODAL}:`)) {
        const targetUserId = customId.includes(':') ? customId.split(':')[1] : null;
        await handlePayoutRequestButton(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // Campaign Join via Dashboard (camp_join:<campaignId>)
      if (customId.startsWith(`${CREATOR_COMPONENTS.CAMP_JOIN}:`)) {
        const campaignId = customId.split(':')[1];
        await handleDashboardCampaignJoin(interaction, campaignId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // Campaign detail Refresh (camp_refresh:<campaignId>)
      if (customId.startsWith(`${CREATOR_COMPONENTS.CAMP_REFRESH}:`)) {
        const campaignId = customId.split(':')[1];
        await handleDashboardCampaignDetail(interaction, interaction.user.id, campaignId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // Admin Control Center button navigation
      if (
        customId === STAFF_COMPONENTS.HOME ||
        customId === STAFF_COMPONENTS.REFRESH ||
        customId === STAFF_COMPONENTS.BACK ||
        customId === 'admin_dash_back'
      ) {
        await handleAdminControlCenter(interaction);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === STAFF_COMPONENTS.REVIEW_QUEUE || customId.startsWith(`${STAFF_COMPONENTS.REVIEW_QUEUE}:`)) {
        const page = customId.includes(':') ? parseInt(customId.split(':')[1], 10) || 1 : 1;
        await handleAdminReviewQueueNav(interaction, page);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === STAFF_COMPONENTS.PAYOUT_QUEUE || customId.startsWith(`${STAFF_COMPONENTS.PAYOUT_QUEUE}:`)) {
        const page = customId.includes(':') ? parseInt(customId.split(':')[1], 10) || 1 : 1;
        await handleAdminPayoutQueueNav(interaction, page);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === STAFF_COMPONENTS.SUSPICIOUS || customId.startsWith(`${STAFF_COMPONENTS.SUSPICIOUS}:`)) {
        const page = customId.includes(':') ? parseInt(customId.split(':')[1], 10) || 1 : 1;
        await handleAdminSuspiciousNav(interaction, page);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === STAFF_COMPONENTS.TRACKING || customId.startsWith(`${STAFF_COMPONENTS.TRACKING}:`)) {
        const page = customId.includes(':') ? parseInt(customId.split(':')[1], 10) || 1 : 1;
        await handleAdminTrackingNav(interaction, page);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === STAFF_COMPONENTS.DELETIONS || customId.startsWith(`${STAFF_COMPONENTS.DELETIONS}:`)) {
        const page = customId.includes(':') ? parseInt(customId.split(':')[1], 10) || 1 : 1;
        await handleAdminDeletionsNav(interaction, page);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === STAFF_COMPONENTS.MONITORING || customId.startsWith(`${STAFF_COMPONENTS.MONITORING}:`)) {
        const page = customId.includes(':') ? parseInt(customId.split(':')[1], 10) || 1 : 1;
        await handleAdminMonitoringNav(interaction, page);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === STAFF_COMPONENTS.CAMPAIGNS || customId.startsWith(`${STAFF_COMPONENTS.CAMPAIGNS}:`)) {
        const page = customId.includes(':') ? parseInt(customId.split(':')[1], 10) || 1 : 1;
        await handleAdminCampaignsNav(interaction, page);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === STAFF_COMPONENTS.CREATORS || customId.startsWith(`${STAFF_COMPONENTS.CREATORS}:`)) {
        const page = customId.includes(':') ? parseInt(customId.split(':')[1], 10) || 1 : 1;
        await handleAdminCreatorsNav(interaction, page);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === STAFF_COMPONENTS.REPORTS) {
        await handleAdminReportsNav(interaction);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // Universal Channel Reset
      if (customId === STAFF_COMPONENTS.CHANNEL_RESET) {
        await handleStaffChannelReset(interaction);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // Review Queue Workspace (#review-queue)
      if (customId === STAFF_COMPONENTS.RQ_HUB || customId === STAFF_COMPONENTS.RQ_REFRESH) {
        await handleStaffReviewQueueHub(interaction);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === STAFF_COMPONENTS.RQ_VIEW || customId.startsWith(`${STAFF_COMPONENTS.RQ_VIEW}:`)) {
        const page = customId.includes(':') ? parseInt(customId.split(':')[1], 10) || 1 : 1;
        await handleStaffReviewQueueView(interaction, page);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.SUB_VIEW}:`)) {
        const parts = customId.split(':');
        const submissionId = parts[1];
        const fromCreatorId = (parts[2] === 'cr' && parts[3]) ? parts[3] : null;
        await handleStaffSubmissionView(interaction, submissionId, fromCreatorId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.SUB_APPROVE}:`)) {
        const submissionId = customId.split(':')[1];
        await handleStaffSubmissionApprove(interaction, submissionId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.SUB_KEEP_REVIEW}:`)) {
        const submissionId = customId.split(':')[1];
        await handleStaffSubmissionKeepReview(interaction, submissionId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.SUB_REVERIFY}:`)) {
        const submissionId = customId.split(':')[1];
        await handleStaffSubmissionReverify(interaction, submissionId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.SUB_REJECT_BTN}:`)) {
        const submissionId = customId.split(':')[1];
        await handleStaffSubmissionRejectBtn(interaction, submissionId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.SUB_FLAG}:`)) {
        const submissionId = customId.split(':')[1];
        await handleStaffSubmissionFlag(interaction, submissionId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // Creator Management Workspace (#creators)
      if (customId === STAFF_COMPONENTS.CR_HUB || customId === STAFF_COMPONENTS.CR_REFRESH) {
        await handleStaffCreatorHub(interaction);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === STAFF_COMPONENTS.CR_LIST || customId.startsWith(`${STAFF_COMPONENTS.CR_LIST}:`)) {
        const page = customId.includes(':') ? parseInt(customId.split(':')[1], 10) || 1 : 1;
        await handleStaffCreatorList(interaction, page);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === STAFF_COMPONENTS.CR_SEARCH_BTN) {
        await handleStaffCreatorSearchBtn(interaction);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.CR_VIEW}:`)) {
        const userId = customId.split(':')[1];
        await handleStaffCreatorView(interaction, userId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.CR_STATUS}:`)) {
        const parts = customId.split(':');
        const userId = parts[1];
        const targetStatus = parts[2];
        await handleStaffCreatorStatus(interaction, userId, targetStatus);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.CR_SUBS}:`)) {
        const parts = customId.split(':');
        const userId = parts[1];
        const page = parts[2] ? parseInt(parts[2], 10) || 1 : 1;
        await handleStaffCreatorSubs(interaction, userId, page);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // Campaign Operations Workspace (#campaign-management)
      if (customId === STAFF_COMPONENTS.CMP_HUB || customId === STAFF_COMPONENTS.CMP_REFRESH) {
        await handleStaffCampaignHub(interaction);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === STAFF_COMPONENTS.CMP_LIST || customId.startsWith(`${STAFF_COMPONENTS.CMP_LIST}:`)) {
        const page = customId.includes(':') ? parseInt(customId.split(':')[1], 10) || 1 : 1;
        await handleStaffCampaignList(interaction, page);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === STAFF_COMPONENTS.CMP_CREATE_BTN) {
        await handleStaffCampaignCreateBtn(interaction);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.CMP_VIEW}:`)) {
        const campaignId = customId.split(':')[1];
        await handleStaffCampaignView(interaction, campaignId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.CMP_STATUS}:`)) {
        const parts = customId.split(':');
        const campaignId = parts[1];
        const targetStatus = parts[2];
        await handleStaffCampaignStatus(interaction, campaignId, targetStatus);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.CMP_REPORT}:`)) {
        const parts = customId.split(':');
        const campaignId = parts[1];
        await handleStaffCampaignReport(interaction, campaignId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // Payout Financial Operations Workspace (#payout-queue)
      if (customId === STAFF_COMPONENTS.PQ_HUB || customId === STAFF_COMPONENTS.PQ_REFRESH) {
        await handleStaffPayoutHub(interaction);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === STAFF_COMPONENTS.PQ_VIEW || customId.startsWith(`${STAFF_COMPONENTS.PQ_VIEW}:`)) {
        const page = customId.includes(':') ? parseInt(customId.split(':')[1], 10) || 1 : 1;
        await handleStaffPayoutQueueView(interaction, page);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === STAFF_COMPONENTS.PQ_HISTORY || customId.startsWith(`${STAFF_COMPONENTS.PQ_HISTORY}:`)) {
        const page = customId.includes(':') ? parseInt(customId.split(':')[1], 10) || 1 : 1;
        await handleStaffPayoutHistory(interaction, page);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.PQ_VIEW_REQ}:`)) {
        const payoutId = customId.split(':')[1];
        await handleStaffPayoutViewReq(interaction, payoutId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.PAYOUT_APPROVE}:`)) {
        const payoutId = customId.split(':')[1];
        await handleStaffPayoutApprove(interaction, payoutId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.PAYOUT_REJECT_BTN}:`)) {
        const payoutId = customId.split(':')[1];
        await handleStaffPayoutRejectBtn(interaction, payoutId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.PAYOUT_PROCESS}:`)) {
        const payoutId = customId.split(':')[1];
        await handleStaffPayoutProcess(interaction, payoutId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.EV_REVIEW}:`)) {
        const parts = customId.split(':');
        const payoutId = parts[1];
        const targetVersion = parts[2] ? parseInt(parts[2], 10) : null;
        await handleStaffEvidenceReview(interaction, payoutId, targetVersion);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.EV_ACCEPT}:`)) {
        const evidenceId = customId.split(':')[1];
        await handleStaffEvidenceAccept(interaction, evidenceId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.EV_REJECT_BTN}:`)) {
        const evidenceId = customId.split(':')[1];
        await handleStaffEvidenceRejectBtn(interaction, evidenceId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // Audit Log Workspace (#audit-log)
      if (customId === STAFF_COMPONENTS.AUDIT_HUB || customId === STAFF_COMPONENTS.AUDIT_REFRESH) {
        await handleStaffAuditHub(interaction);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === STAFF_COMPONENTS.AUDIT_LIST || customId.startsWith(`${STAFF_COMPONENTS.AUDIT_LIST}:`)) {
        const page = customId.includes(':') ? parseInt(customId.split(':')[1], 10) || 1 : 1;
        await handleStaffAuditList(interaction, page);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // System Workspaces (#bot-status & #bot-errors)
      if (customId === STAFF_COMPONENTS.SYS_STATUS_REFRESH) {
        await handleStaffSystemStatus(interaction);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === STAFF_COMPONENTS.SYS_ERRORS_REFRESH) {
        await handleStaffBotErrorsRefresh(interaction);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // Submission Registry Workspace (all-platform submission viewer)
      if (customId === STAFF_COMPONENTS.SUB_REG_LIST || customId.startsWith(`${STAFF_COMPONENTS.SUB_REG_LIST}:`)) {
        const parts = customId.split(':');
        const page = parts[1] ? parseInt(parts[1], 10) || 1 : 1;
        const platform = parts[2] || 'ALL';
        const status = parts[3] || 'ALL';
        await handleStaffSubmissionRegistryList(interaction, page, platform, status);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === STAFF_COMPONENTS.SUB_SEARCH_BTN) {
        await handleStaffSubmissionSearchBtn(interaction);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.SUB_REFRESH_METRICS}:`)) {
        const submissionId = customId.split(':')[1];
        await handleStaffSubmissionRefreshMetrics(interaction, submissionId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.SUB_MANUAL_METRICS}:`)) {
        const submissionId = customId.split(':')[1];
        await handleStaffSubmissionManualMetricsBtn(interaction, submissionId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.SUB_ANALYTICS}:`)) {
        const parts = customId.split(':');
        const submissionId = parts[1];
        const page = parts[2] ? parseInt(parts[2], 10) || 1 : 1;
        await handleStaffSubmissionAnalytics(interaction, submissionId, page);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('admin_')) {
        await handleAdminButtonInteraction(interaction);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }


      // Catch-all for genuinely unknown or expired button custom IDs
      logger.warn(
        {
          correlationId,
          interactionId: interaction.id,
          customId,
          userId: interaction.user?.id,
          guildId: interaction.guildId,
          channelId: interaction.channelId
        },
        'Unrecognized or expired button custom ID'
      );
      await safeReply({
        content: '⚠️ This button is no longer available. Please refresh the dashboard.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // 4. Modals
    if (interaction.isModalSubmit()) {
      const customId = interaction.customId;

      if (customId.startsWith('submit:modal:')) {
        const campaignId = customId.split(':')[2];
        await handleModalSubmitClip(interaction, campaignId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('payout_modal:')) {
        const targetUserId = customId.split(':')[1];
        await handlePayoutModalSubmit(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith('payout_profile_modal:')) {
        const targetUserId = customId.split(':')[1];
        await handlePayoutProfileModalSubmit(interaction, targetUserId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.SUB_REJECT_MODAL}:`)) {
        const submissionId = customId.split(':')[1];
        await handleStaffSubmissionRejectModalSubmit(interaction, submissionId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.SUB_MANUAL_MODAL}:`)) {
        const submissionId = customId.split(':')[1];
        await handleStaffSubmissionManualMetricsModalSubmit(interaction, submissionId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.PAYOUT_REJECT_MODAL}:`)) {
        const payoutId = customId.split(':')[1];
        await handleStaffPayoutRejectModalSubmit(interaction, payoutId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId.startsWith(`${STAFF_COMPONENTS.EV_REJECT_MODAL}:`)) {
        const evidenceId = customId.split(':')[1];
        await handleStaffEvidenceRejectModalSubmit(interaction, evidenceId);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === STAFF_COMPONENTS.CR_SEARCH_MODAL) {
        await handleStaffCreatorSearchModalSubmit(interaction);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === STAFF_COMPONENTS.CMP_CREATE_MODAL) {
        await handleStaffCampaignCreateModalSubmit(interaction);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      if (customId === STAFF_COMPONENTS.SUB_SEARCH_MODAL) {
        await handleStaffSubmissionSearchModalSubmit(interaction);
        logger.info({ correlationId, interactionId: interaction.id, status: 'completed' }, 'Interaction processed');
        return;
      }

      // Catch-all for unrecognized or tampered modal submissions

      logger.warn({ correlationId, customId }, 'Unrecognized or tampered modal submission');
      await safeReply({
        content: `⚠️ This modal submission is unrecognized, invalid, or expired. (Reference: ${correlationId})`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }
  } catch (error) {
    const formatted = formatError(error);

    // Domain errors: expected business logic violations — log as WARN, not ERROR
    const isDomainError = (
      error instanceof CampaignBudgetExhaustedError
      || error instanceof CampaignBudgetExhaustedSubmissionError
      || error instanceof CampaignNotFoundError
      || error instanceof CampaignNotActiveError
      || error instanceof CampaignNotJoinableError
      || error instanceof MembershipError
      || error instanceof NotCampaignMemberError
      || error instanceof PlatformNotAllowedError
      || error instanceof DuplicateSubmissionError
      || error instanceof ClipDurationOutOfRangeError
      || error instanceof InvalidSubmissionUrlError
      || error instanceof UnsupportedPlatformError
      || error instanceof UnauthorizedAdminActionError
      || error instanceof InsufficientPermissionError
      || error instanceof AlreadyReviewedError
      || error instanceof PayoutError
      || error instanceof InvalidPayoutStatusTransitionError
      || error instanceof PayoutProfileError
      || error instanceof EvidenceValidationError
    );

    if (isDomainError) {
      logger.warn(
        { correlationId, interactionId: interaction.id, errorCode: error.code || error.name, err: error.message },
        'Domain error in interaction handler'
      );
    } else {
      logger.error(
        {
          correlationId,
          interactionId: interaction.id,
          userId,
          guildId,
          target: identifier,
          err: formatted,
          stack: error.stack
        },
        'Unhandled interaction error'
      );

      // Dispatch alert to #bot-errors channel if available in guild
      if (interaction.client) {
        try {
          const botErrorsId = config?.discord?.channels?.botErrors;
          const errorsChannel = (botErrorsId ? interaction.client.channels?.cache?.get(botErrorsId) : null)
            || interaction.client.channels?.cache?.find(
              (c) => c.name === 'bot-errors' && (!guildId || c.guildId === guildId)
            );
          if (errorsChannel && typeof errorsChannel.send === 'function') {
            const errEmbed = new EmbedBuilder()
              .setTitle('🚨 Bot Error Alert')
              .setDescription(`**User**: <@${userId}> (\`${userId}\`)\n**Action**: \`${identifier}\`\n**Ref**: \`${correlationId}\`\n\`\`\`js\n${(error.stack || error.message || error).toString().substring(0, 1500)}\n\`\`\``)
              .setColor(0xe74c3c)
              .setTimestamp();
            errorsChannel.send({ embeds: [errEmbed] }).catch(() => {});
          }
        } catch {
          // Suppress error alert sending failures
        }
      }
    }

    // Produce safe, user-friendly messages for known domain errors
    let errorMessage;

    if (error instanceof CampaignBudgetExhaustedError || error instanceof CampaignBudgetExhaustedSubmissionError) {
      errorMessage = '⚠️ **Campaign Closed** — This campaign has reached its available budget and is no longer accepting new creators or submissions.';
    } else if (error instanceof CampaignNotFoundError) {
      errorMessage = '⚠️ Campaign not found. It may have been removed or the link is outdated.';
    } else if (error instanceof CampaignNotActiveError) {
      errorMessage = '⚠️ This campaign is no longer active and cannot be joined or submitted to.';
    } else if (error instanceof CampaignNotJoinableError) {
      errorMessage = '⚠️ This campaign cannot be joined right now. It may be paused, completed, or outside its active window.';
    } else if (error instanceof MembershipError) {
      errorMessage = `⚠️ ${error.message}`;
    } else if (error instanceof NotCampaignMemberError) {
      errorMessage = '⚠️ You must join this campaign before you can submit clips.';
    } else if (error instanceof DuplicateSubmissionError) {
      errorMessage = '⚠️ You have already submitted this clip to this campaign.';
    } else if (error instanceof PlatformNotAllowedError) {
      errorMessage = `⚠️ ${error.message}`;
    } else if (error instanceof ClipDurationOutOfRangeError) {
      errorMessage = `⚠️ ${error.message}`;
    } else if (error instanceof InvalidSubmissionUrlError || error instanceof UnsupportedPlatformError) {
      errorMessage = `⚠️ ${error.message}`;
    } else if (error instanceof UnauthorizedAdminActionError || error instanceof InsufficientPermissionError) {
      errorMessage = '🔒 You do not have permission to perform this action.';
    } else if (error instanceof AlreadyReviewedError) {
      errorMessage = '⚠️ This submission has already been reviewed.';
    } else if (error instanceof InvalidPayoutStatusTransitionError) {
      errorMessage = '⚠️ This payout request has already been processed or is not in a reviewable state.';
    } else if (error instanceof PayoutProfileError || error instanceof PayoutError || error instanceof EvidenceValidationError) {
      errorMessage = `⚠️ ${error.message}`;
    } else if (error instanceof AppError) {
      // Generic AppError — show message but keep error level
      errorMessage = `⚠️ ${error.message} (Reference: ${correlationId})`;
    } else {
      // Unknown error — never leak internals
      errorMessage = `❌ An unexpected error occurred while processing your request. Please try again later. (Reference: ${correlationId})`;
    }

    // If the interaction has already replied successfully (and is not awaiting loading feedback), do NOT send another Discord response
    if (interaction.replied && !interaction._loadingStateShown) {
      logger.warn(
        { correlationId, interactionId: interaction.id },
        'Interaction already replied; suppressing post-response error message to prevent duplicate response'
      );
      return;
    }

    try {
      await safeReply({ content: errorMessage, flags: MessageFlags.Ephemeral });
    } catch (replyError) {
      logger.error({ correlationId, replyError: replyError.message }, 'Failed to deliver error response to interaction');
    }
  }
}
