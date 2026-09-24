import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits
} from 'discord.js';
import { prisma } from '../../database/client.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import {
  buildAdminControlCenterRows,
  buildCreatorCampaignsChannelRow,
  buildCreatorSubmissionsChannelRow,
  buildCreatorStatsChannelRow,
  buildCreatorEarningsChannelRow,
  buildCreatorPayoutsChannelRow
} from '../components/dashboard.components.js';
import {
  buildCreatorDashboardChannelEmbed,
  buildCreatorCampaignsChannelEmbed,
  buildCreatorSubmissionsChannelEmbed,
  buildCreatorStatsChannelEmbed,
  buildCreatorEarningsChannelEmbed,
  buildCreatorPayoutsChannelEmbed
} from '../embeds/dashboard.embeds.js';
import {
  buildStaffReviewQueueHubEmbed,
  buildStaffCreatorHubEmbed,
  buildStaffCampaignHubEmbed,
  buildStaffPayoutHubEmbed,
  buildStaffAuditHubEmbed,
  buildStaffSystemStatusEmbed,
  buildStaffBotErrorsEmbed
} from '../embeds/staff.embeds.js';
import {
  buildStaffReviewQueueHubRow,
  buildStaffCreatorHubRow,
  buildStaffCampaignHubRow,
  buildStaffPayoutHubRow,
  buildStaffAuditHubRow,
  buildStaffSystemStatusRow,
  buildStaffSystemErrorsRow
} from '../components/staff.components.js';

export const PANEL_DEFINITIONS = Object.freeze({
  campaigns: {
    key: 'campaigns',
    name: 'Campaigns Hub',
    channelEnvVar: 'DISCORD_CHANNEL_CAMPAIGNS_ID',
    getConfigChannelId: (cfg) => cfg?.discord?.channels?.campaigns,
    isStaff: false,
    buildPayload: async () => ({
      embed: buildCreatorCampaignsChannelEmbed(),
      components: [buildCreatorCampaignsChannelRow()]
    }),
    identifyFn: (msg) =>
      msg.embeds?.some((e) => (e.title || e.data?.title || '').includes('CAMPAIGNS')) ||
      msg.components?.some((r) => r.components?.some((c) => (c.customId || c.data?.custom_id || '').includes('campaigns')))
  },
  submissions: {
    key: 'submissions',
    name: 'Submissions Hub',
    channelEnvVar: 'DISCORD_CHANNEL_SUBMISSIONS_ID',
    getConfigChannelId: (cfg) => cfg?.discord?.channels?.submissions,
    isStaff: false,
    buildPayload: async () => ({
      embed: buildCreatorSubmissionsChannelEmbed(),
      components: [buildCreatorSubmissionsChannelRow()]
    }),
    identifyFn: (msg) =>
      msg.embeds?.some((e) => (e.title || e.data?.title || '').includes('SUBMISSIONS')) ||
      msg.components?.some((r) => r.components?.some((c) => (c.customId || c.data?.custom_id || '').includes('submit') || (c.customId || c.data?.custom_id || '').includes('clips')))
  },
  creatorDashboard: {
    key: 'creatorDashboard',
    name: 'Creator Dashboard Hub',
    channelEnvVar: 'DISCORD_CHANNEL_CREATOR_DASHBOARD_ID',
    getConfigChannelId: (cfg) => cfg?.discord?.channels?.creatorDashboard,
    isStaff: false,
    buildPayload: async () => ({
      embed: buildCreatorDashboardChannelEmbed(),
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('dash_open')
            .setLabel('🎬 Open Creator Dashboard')
            .setStyle(ButtonStyle.Primary)
        )
      ]
    }),
    identifyFn: (msg) =>
      msg.embeds?.some((e) => (e.title || e.data?.title || '').includes('CREATOR CENTER')) ||
      msg.components?.some((r) => r.components?.some((c) => (c.customId || c.data?.custom_id || '') === 'dash_open'))
  },
  stats: {
    key: 'stats',
    name: 'Stats & Analytics Hub',
    channelEnvVar: 'DISCORD_CHANNEL_STATS_ID',
    getConfigChannelId: (cfg) => cfg?.discord?.channels?.stats,
    isStaff: false,
    buildPayload: async () => ({
      embed: buildCreatorStatsChannelEmbed(),
      components: [buildCreatorStatsChannelRow()]
    }),
    identifyFn: (msg) =>
      msg.embeds?.some((e) => (e.title || e.data?.title || '').includes('STATS')) ||
      msg.components?.some((r) => r.components?.some((c) => (c.customId || c.data?.custom_id || '').includes('stats')))
  },
  earnings: {
    key: 'earnings',
    name: 'Earnings Ledger Hub',
    channelEnvVar: 'DISCORD_CHANNEL_EARNINGS_ID',
    getConfigChannelId: (cfg) => cfg?.discord?.channels?.earnings,
    isStaff: false,
    buildPayload: async () => ({
      embed: buildCreatorEarningsChannelEmbed(),
      components: [buildCreatorEarningsChannelRow()]
    }),
    identifyFn: (msg) =>
      msg.embeds?.some((e) => (e.title || e.data?.title || '').includes('EARNINGS')) ||
      msg.components?.some((r) => r.components?.some((c) => (c.customId || c.data?.custom_id || '').includes('earnings')))
  },
  payouts: {
    key: 'payouts',
    name: 'Payouts Hub',
    channelEnvVar: 'DISCORD_CHANNEL_PAYOUTS_ID',
    getConfigChannelId: (cfg) => cfg?.discord?.channels?.payouts,
    isStaff: false,
    buildPayload: async () => ({
      embed: buildCreatorPayoutsChannelEmbed(),
      components: [buildCreatorPayoutsChannelRow()]
    }),
    identifyFn: (msg) =>
      msg.embeds?.some((e) => (e.title || e.data?.title || '').includes('PAYOUTS')) ||
      msg.components?.some((r) => r.components?.some((c) => (c.customId || c.data?.custom_id || '').includes('payout')))
  },
  reviewQueue: {
    key: 'reviewQueue',
    name: 'Staff Review Queue',
    channelEnvVar: 'DISCORD_CHANNEL_REVIEW_QUEUE_ID',
    getConfigChannelId: (cfg) => cfg?.discord?.channels?.reviewQueue,
    isStaff: true,
    buildPayload: async (db) => {
      const [pendingVerification, underReview, flagged, postApproval] = db?.submission ? await Promise.all([
        db.submission.count({ where: { status: 'PENDING_VERIFICATION' } }).catch(() => 0),
        db.submission.count({ where: { status: 'UNDER_REVIEW' } }).catch(() => 0),
        db.submission.count({ where: { status: 'FLAGGED' } }).catch(() => 0),
        db.submission.count({ where: { status: 'POST_APPROVAL_REVIEW' } }).catch(() => 0)
      ]) : [0, 0, 0, 0];

      return {
        embed: buildStaffReviewQueueHubEmbed({
          pendingVerificationCount: pendingVerification,
          underReviewCount: underReview,
          flaggedCount: flagged,
          postApprovalCount: postApproval
        }),
        components: [buildStaffReviewQueueHubRow()]
      };
    },
    identifyFn: (msg) =>
      msg.embeds?.some((e) => (e.title || e.data?.title || '').includes('REVIEW QUEUE')) ||
      msg.components?.some((r) => r.components?.some((c) => (c.customId || c.data?.custom_id || '').includes('admin_rq_')))
  },
  payoutQueue: {
    key: 'payoutQueue',
    name: 'Staff Payout Queue',
    channelEnvVar: 'DISCORD_CHANNEL_PAYOUT_QUEUE_ID',
    getConfigChannelId: (cfg) => cfg?.discord?.channels?.payoutQueue,
    isStaff: true,
    buildPayload: async (db) => {
      const [requested, underReview, approved, processing] = db?.payoutRequest ? await Promise.all([
        db.payoutRequest.count({ where: { status: 'REQUESTED' } }).catch(() => 0),
        db.payoutRequest.count({ where: { status: 'UNDER_REVIEW' } }).catch(() => 0),
        db.payoutRequest.count({ where: { status: 'APPROVED' } }).catch(() => 0),
        db.payoutRequest.count({ where: { status: 'PROCESSING' } }).catch(() => 0)
      ]) : [0, 0, 0, 0];

      return {
        embed: buildStaffPayoutHubEmbed({
          requestedCount: requested,
          underReviewCount: underReview,
          approvedCount: approved,
          processingCount: processing
        }),
        components: [buildStaffPayoutHubRow()]
      };
    },
    identifyFn: (msg) =>
      msg.embeds?.some((e) => (e.title || e.data?.title || '').includes('PAYOUT FINANCIAL')) ||
      msg.components?.some((r) => r.components?.some((c) => (c.customId || c.data?.custom_id || '').includes('admin_pq_')))
  },
  auditLog: {
    key: 'auditLog',
    name: 'Staff Audit Log Hub',
    channelEnvVar: 'DISCORD_CHANNEL_AUDIT_LOG_ID',
    getConfigChannelId: (cfg) => cfg?.discord?.channels?.auditLog,
    isStaff: true,
    buildPayload: async (db) => {
      const totalEvents = db?.auditLog ? await db.auditLog.count().catch(() => 0) : 0;
      return {
        embed: buildStaffAuditHubEmbed({ totalEventsCount: totalEvents }),
        components: [buildStaffAuditHubRow()]
      };
    },
    identifyFn: (msg) =>
      msg.embeds?.some((e) => (e.title || e.data?.title || '').includes('AUDIT LOG')) ||
      msg.components?.some((r) => r.components?.some((c) => (c.customId || c.data?.custom_id || '').includes('admin_audit_')))
  },
  creators: {
    key: 'creators',
    name: 'Staff Creator Management',
    channelEnvVar: 'DISCORD_CHANNEL_CREATORS_ID',
    getConfigChannelId: (cfg) => cfg?.discord?.channels?.creators,
    isStaff: true,
    buildPayload: async (db) => {
      const [total, active, suspended, banned] = db?.user ? await Promise.all([
        db.user.count().catch(() => 0),
        db.user.count({ where: { status: 'ACTIVE' } }).catch(() => 0),
        db.user.count({ where: { status: 'SUSPENDED' } }).catch(() => 0),
        db.user.count({ where: { status: 'BANNED' } }).catch(() => 0)
      ]) : [0, 0, 0, 0];

      return {
        embed: buildStaffCreatorHubEmbed({
          totalCount: total,
          activeCount: active,
          suspendedCount: suspended,
          bannedCount: banned
        }),
        components: [buildStaffCreatorHubRow()]
      };
    },
    identifyFn: (msg) =>
      msg.embeds?.some((e) => (e.title || e.data?.title || '').includes('CREATOR MANAGEMENT')) ||
      msg.components?.some((r) => r.components?.some((c) => (c.customId || c.data?.custom_id || '').includes('admin_cr_')))
  },
  campaignManagement: {
    key: 'campaignManagement',
    name: 'Staff Campaign Management',
    channelEnvVar: 'DISCORD_CHANNEL_CAMPAIGN_MANAGEMENT_ID',
    getConfigChannelId: (cfg) => cfg?.discord?.channels?.campaignManagement,
    isStaff: true,
    buildPayload: async (db) => {
      const [active, paused, draft, total] = db?.campaign ? await Promise.all([
        db.campaign.count({ where: { status: 'ACTIVE' } }).catch(() => 0),
        db.campaign.count({ where: { status: 'PAUSED' } }).catch(() => 0),
        db.campaign.count({ where: { status: 'DRAFT' } }).catch(() => 0),
        db.campaign.count().catch(() => 0)
      ]) : [0, 0, 0, 0];

      return {
        embed: buildStaffCampaignHubEmbed({
          activeCampaignsCount: active,
          pausedCampaignsCount: paused,
          draftCampaignsCount: draft,
          totalCampaignsCount: total
        }),
        components: [buildStaffCampaignHubRow()]
      };
    },
    identifyFn: (msg) =>
      msg.embeds?.some((e) => (e.title || e.data?.title || '').includes('CAMPAIGN OPERATIONS')) ||
      msg.components?.some((r) => r.components?.some((c) => (c.customId || c.data?.custom_id || '').includes('admin_cmp_')))
  },
  staffDashboard: {
    key: 'staffDashboard',
    name: 'Staff Control Center',
    channelEnvVar: 'DISCORD_CHANNEL_STAFF_DASHBOARD_ID',
    getConfigChannelId: (cfg) => cfg?.discord?.channels?.staffDashboard,
    isStaff: true,
    buildPayload: async () => ({
      embed: new EmbedBuilder()
        .setTitle('PEAK CLIP — CONTROL CENTER')
        .setDescription(
          'Welcome to the Peak Clip Control Center.\n\n' +
          'This operational hub monitors campaigns, submissions, creator onboarding, and system health.\n\n' +
          '• **Campaigns**: View and configure active clipping campaigns in `#campaign-management`\n' +
          '• **Review Queue**: Verify flagged or pending clips in `#review-queue`\n' +
          '• **Creators**: Manage creator verification in `#creators`\n' +
          '• **Financials**: Review disbursement queues in `#payout-queue`\n' +
          '• **Audit**: Inspect system actions in `#audit-log`\n\n' +
          '*Staff controls are accessible to authorized roles according to zero-trust permissions.*'
        )
        .setColor(0xe74c3c)
        .setTimestamp(),
      components: buildAdminControlCenterRows()
    }),
    identifyFn: (msg) =>
      msg.embeds?.some((e) => (e.title || e.data?.title || '').includes('CONTROL CENTER')) ||
      msg.components?.some((r) => r.components?.some((c) => (c.customId || c.data?.custom_id || '').startsWith('admin_dash_')))
  },
  botStatus: {
    key: 'botStatus',
    name: 'Bot System Status',
    channelEnvVar: 'DISCORD_CHANNEL_BOT_STATUS_ID',
    getConfigChannelId: (cfg) => cfg?.discord?.channels?.botStatus,
    isStaff: true,
    buildPayload: async () => ({
      embed: buildStaffSystemStatusEmbed(),
      components: [buildStaffSystemStatusRow()]
    }),
    identifyFn: (msg) =>
      msg.embeds?.some((e) => (e.title || e.data?.title || '').includes('SYSTEM STATUS') || (e.title || e.data?.title || '').includes('HEALTH')) ||
      msg.components?.some((r) => r.components?.some((c) => (c.customId || c.data?.custom_id || '').includes('sys_status_')))
  },
  botErrors: {
    key: 'botErrors',
    name: 'Bot Error Alerts',
    channelEnvVar: 'DISCORD_CHANNEL_BOT_ERRORS_ID',
    getConfigChannelId: (cfg) => cfg?.discord?.channels?.botErrors,
    isStaff: true,
    buildPayload: async () => ({
      embed: buildStaffBotErrorsEmbed(),
      components: [buildStaffSystemErrorsRow()]
    }),
    identifyFn: (msg) =>
      msg.embeds?.some((e) => (e.title || e.data?.title || '').includes('ERROR') || (e.title || e.data?.title || '').includes('DIAGNOSTIC')) ||
      msg.components?.some((r) => r.components?.some((c) => (c.customId || c.data?.custom_id || '').includes('sys_errors_')))
  }
});

export class PanelService {
  constructor(dbClient = prisma, currentConfig = config) {
    this.prisma = dbClient;
    this.config = currentConfig;
    this._inMemoryPanelMessages = new Map();
  }

  /**
   * Get stored panel message metadata { channelId, messageId }
   * @param {string} panelKey
   * @returns {Promise<{ channelId: string, messageId: string }|null>}
   */
  async getStoredPanel(panelKey) {
    if (this.prisma?.systemSetting?.findUnique) {
      try {
        const row = await this.prisma.systemSetting.findUnique({
          where: { key: `panel_msg:${panelKey}` }
        });
        if (row?.value) {
          return JSON.parse(row.value);
        }
      } catch (err) {
        logger.warn({ panelKey, err: err.message }, 'Failed to read panel metadata from systemSetting');
      }
    }
    return this._inMemoryPanelMessages.get(panelKey) || null;
  }

  /**
   * Persist panel message metadata { channelId, messageId }
   * @param {string} panelKey
   * @param {string} channelId
   * @param {string} messageId
   */
  async saveStoredPanel(panelKey, channelId, messageId) {
    this._inMemoryPanelMessages.set(panelKey, { channelId, messageId });
    if (this.prisma?.systemSetting?.upsert) {
      try {
        const value = JSON.stringify({ channelId, messageId });
        await this.prisma.systemSetting.upsert({
          where: { key: `panel_msg:${panelKey}` },
          create: { key: `panel_msg:${panelKey}`, value },
          update: { value }
        });
      } catch (err) {
        logger.warn({ panelKey, err: err.message }, 'Failed to persist panel metadata to systemSetting');
      }
    }
  }

  /**
   * Deploy or update a single canonical panel in the provided existing channel
   * Strictly touches only bot-authored messages. Never touches other messages.
   *
   * @param {import('discord.js').TextChannel} channel
   * @param {string} panelKey
   * @param {object} [botMember=null]
   * @returns {Promise<{ status: 'CREATED'|'UPDATED'|'SKIPPED'|'FAILED', panelKey: string, messageId?: string, reason?: string }>}
   */
  async deployPanelToChannel(channel, panelKey, botMember = null) {
    const def = PANEL_DEFINITIONS[panelKey];
    if (!def) {
      return { status: 'SKIPPED', panelKey, reason: `Unknown panel key '${panelKey}'` };
    }

    if (!channel || typeof channel.send !== 'function') {
      return { status: 'SKIPPED', panelKey, reason: 'Invalid or non-text channel' };
    }

    // Permission validation: ViewChannel, SendMessages, EmbedLinks
    const botUser = channel.client?.user || botMember?.user || botMember;
    const botUserId = botUser?.id;

    if (botMember && typeof channel.permissionsFor === 'function') {
      const perms = channel.permissionsFor(botMember);
      if (perms) {
        const missing = [];
        if (!perms.has(PermissionFlagsBits.ViewChannel)) missing.push('ViewChannel');
        if (!perms.has(PermissionFlagsBits.SendMessages)) missing.push('SendMessages');
        if (!perms.has(PermissionFlagsBits.EmbedLinks)) missing.push('EmbedLinks');

        if (missing.length > 0) {
          logger.warn({ panelKey, channelId: channel.id, missing }, 'Bot lacks required channel permissions');
          return {
            status: 'SKIPPED',
            panelKey,
            channelId: channel.id,
            reason: `Missing permissions: ${missing.join(', ')}`
          };
        }
      }
    }

    try {
      const { embed, components } = await def.buildPayload(this.prisma);

      // 1. Check database-stored message ID
      let existingMsg = null;
      const stored = await this.getStoredPanel(panelKey);

      if (stored?.channelId === channel.id && stored?.messageId && channel.messages?.fetch) {
        try {
          const fetched = await channel.messages.fetch(stored.messageId);
          // Strictly verify message was authored by bot
          if (fetched && (!botUserId || fetched.author?.id === botUserId)) {
            existingMsg = fetched;
          }
        } catch {
          // Message may have been deleted; will search recent or recreate
        }
      }

      // 2. If no valid stored message found, search recent channel messages for bot's own post
      if (!existingMsg && channel.messages?.fetch) {
        try {
          const recent = await channel.messages.fetch({ limit: 25 });
          const list = Array.isArray(recent) ? recent : (recent?.values ? Array.from(recent.values()) : []);
          existingMsg = list.find((m) => {
            if (botUserId && m.author?.id !== botUserId) return false;
            if (typeof def.identifyFn === 'function') {
              return def.identifyFn(m);
            }
            return m.embeds?.length > 0;
          }) || null;
        } catch (fetchErr) {
          logger.debug({ panelKey, err: fetchErr.message }, 'Could not search recent channel messages');
        }
      }

      // 3. Edit existing message OR send fresh message
      if (existingMsg) {
        await existingMsg.edit({ content: null, embeds: [embed], components });
        await this.saveStoredPanel(panelKey, channel.id, existingMsg.id);
        logger.info({ panelKey, channelId: channel.id, msgId: existingMsg.id }, 'Updated existing canonical panel');
        return {
          status: 'UPDATED',
          panelKey,
          channelId: channel.id,
          messageId: existingMsg.id
        };
      } else {
        const created = await channel.send({ embeds: [embed], components });
        await this.saveStoredPanel(panelKey, channel.id, created.id);
        logger.info({ panelKey, channelId: channel.id, msgId: created.id }, 'Created fresh canonical panel');
        return {
          status: 'CREATED',
          panelKey,
          channelId: channel.id,
          messageId: created.id
        };
      }
    } catch (err) {
      logger.error({ panelKey, channelId: channel.id, err: err.message }, 'Failed to deploy panel to channel');
      return {
        status: 'FAILED',
        panelKey,
        channelId: channel.id,
        reason: err.message
      };
    }
  }

  /**
   * Deploy all configured canonical panels across guild channels.
   * Does NOT create, rename, or delete any roles or channels.
   *
   * @param {import('discord.js').Client} client
   * @param {import('discord.js').Guild} [guild=null]
   * @param {object} [customConfig=null]
   * @returns {Promise<{ created: Array<object>, updated: Array<object>, skipped: Array<object>, failed: Array<object> }>}
   */
  async deployAllPanels(client, guild = null, customConfig = null) {
    const activeConfig = customConfig || this.config;
    const targetGuild = guild || (activeConfig.discord?.guildId ? client.guilds?.cache?.get(activeConfig.discord.guildId) : null) || client.guilds?.cache?.first();
    const botMember = targetGuild?.members?.me || (targetGuild?.members?.fetchMe ? await targetGuild.members.fetchMe().catch(() => null) : null);

    const results = {
      created: [],
      updated: [],
      skipped: [],
      failed: []
    };

    for (const [key, def] of Object.entries(PANEL_DEFINITIONS)) {
      const channelId = def.getConfigChannelId(activeConfig);

      if (!channelId) {
        results.skipped.push({
          panelKey: key,
          name: def.name,
          envVar: def.channelEnvVar,
          reason: 'Channel ID unset in environment'
        });
        continue;
      }

      // Fetch channel
      let channel = targetGuild?.channels?.cache?.get(channelId) || null;
      if (!channel && client.channels?.fetch) {
        channel = await client.channels.fetch(channelId).catch(() => null);
      }

      if (!channel) {
        logger.warn({ panelKey: key, channelId }, 'Channel configured in env was not found in guild');
        results.skipped.push({
          panelKey: key,
          name: def.name,
          channelId,
          envVar: def.channelEnvVar,
          reason: `Channel <#${channelId}> not found in guild`
        });
        continue;
      }

      const res = await this.deployPanelToChannel(channel, key, botMember);

      if (res.status === 'CREATED') {
        results.created.push({ ...res, name: def.name, envVar: def.channelEnvVar });
      } else if (res.status === 'UPDATED') {
        results.updated.push({ ...res, name: def.name, envVar: def.channelEnvVar });
      } else if (res.status === 'SKIPPED') {
        results.skipped.push({ ...res, name: def.name, envVar: def.channelEnvVar });
      } else {
        results.failed.push({ ...res, name: def.name, envVar: def.channelEnvVar });
      }
    }

    return results;
  }
}

export const panelService = new PanelService();
