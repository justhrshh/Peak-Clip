import path from 'node:path';
import { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { Prisma } from '@prisma/client';
import {
  assertAdminPermission,
  AdminPermission,
  AdminRole
} from '../../modules/admin/admin.auth.js';
import { UnauthorizedAdminActionError } from '../../modules/admin/admin.errors.js';
import { panelService } from '../panels/panel.service.js';
import { adminCampaignService } from '../../modules/admin/admin.campaign.service.js';
import { adminSubmissionService } from '../../modules/admin/admin.submission.service.js';
import { adminCreatorService } from '../../modules/admin/admin.creator.service.js';
import { adminPayoutService } from '../../modules/admin/admin.payout.service.js';
import { payoutService } from '../../modules/payouts/payout.service.js';
import { adjustmentService } from '../../modules/adjustments/adjustment.service.js';
import { formatPayoutStatusBadge } from '../embeds/payout.embeds.js';
import { buildAdminCampaignReportEmbed } from '../embeds/statistics.embeds.js';
import { buildStaffEvidenceReviewEmbed } from '../embeds/staff.embeds.js';
import { storageService } from '../../modules/storage/storage.service.js';
import { adminAuditService } from '../../modules/admin/audit.service.js';
import { serverProvisioner } from '../provisioning/server.provisioner.js';
import { logger } from '../../utils/logger.js';
import { formatError } from '../../utils/errors.js';

export const data = new SlashCommandBuilder()
  .setName('admin')
  .setDescription('Staff and administrative operational control plane')
  // ==================== CAMPAIGN SUBCOMMANDS ====================
  .addSubcommandGroup((group) =>
    group
      .setName('campaign')
      .setDescription('Manage campaigns and members')
      .addSubcommand((sub) =>
        sub
          .setName('list')
          .setDescription('List all campaigns with operational summaries')
          .addStringOption((opt) =>
            opt
              .setName('status')
              .setDescription('Filter by campaign status')
              .addChoices(
                { name: 'DRAFT', value: 'DRAFT' },
                { name: 'ACTIVE', value: 'ACTIVE' },
                { name: 'PAUSED', value: 'PAUSED' },
                { name: 'COMPLETED', value: 'COMPLETED' },
                { name: 'ENDED', value: 'ENDED' },
                { name: 'ARCHIVED', value: 'ARCHIVED' }
              )
          )
          .addStringOption((opt) => opt.setName('search').setDescription('Search by name, slug, or client'))
          .addIntegerOption((opt) => opt.setName('page').setDescription('Page number').setMinValue(1))
      )
      .addSubcommand((sub) =>
        sub
          .setName('view')
          .setDescription('View detailed aggregated statistics for a campaign')
          .addStringOption((opt) => opt.setName('campaign_id').setDescription('Campaign UUID').setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName('report')
          .setDescription('View comprehensive operational and reach analytics for a campaign')
          .addStringOption((opt) => opt.setName('campaign_id').setDescription('Campaign UUID').setRequired(true))
          .addStringOption((opt) =>
            opt
              .setName('view')
              .setDescription('Report view section')
              .addChoices(
                { name: 'Overview & Reach', value: 'overview' },
                { name: 'Creator Performance Table', value: 'creators' },
                { name: 'Platform Breakdown', value: 'platforms' },
                { name: 'Channel Breakdown', value: 'channels' },
                { name: 'Financial Reconciliation', value: 'financial' }
              )
          )
          .addStringOption((opt) =>
            opt
              .setName('sort')
              .setDescription('Sort order for creator performance table')
              .addChoices(
                { name: 'Eligible Views', value: 'views' },
                { name: 'Credited Earnings', value: 'earnings' },
                { name: 'Total Clips', value: 'clips' },
                { name: 'Last Activity', value: 'activity' }
              )
          )
          .addIntegerOption((opt) => opt.setName('page').setDescription('Page number for creator table').setMinValue(1))
      )
      .addSubcommand((sub) =>
        sub
          .setName('set-status')
          .setDescription('Transition campaign lifecycle status (COMPLETED is system-only)')
          .addStringOption((opt) => opt.setName('campaign_id').setDescription('Campaign UUID').setRequired(true))
          .addStringOption((opt) =>
            opt
              .setName('status')
              .setDescription('Target status (COMPLETED is auto-set by budget exhaustion)')
              .setRequired(true)
              .addChoices(
                { name: 'ACTIVE', value: 'ACTIVE' },
                { name: 'PAUSED', value: 'PAUSED' },
                { name: 'ENDED', value: 'ENDED' },
                { name: 'ARCHIVED', value: 'ARCHIVED' }
              )
          )
          .addStringOption((opt) => opt.setName('reason').setDescription('Operational note/reason'))
      )
      .addSubcommand((sub) =>
        sub
          .setName('create')
          .setDescription('Create a new campaign (Phase 10A: budget + cap + duration + retention)')
          .addStringOption((opt) => opt.setName('name').setDescription('Campaign name').setRequired(true))
          .addStringOption((opt) => opt.setName('slug').setDescription('Unique slug (lowercase-hyphenated)').setRequired(true))
          .addStringOption((opt) => opt.setName('client').setDescription('Client name').setRequired(true))
          .addStringOption((opt) => opt.setName('description').setDescription('Campaign description').setRequired(true))
          .addNumberOption((opt) => opt.setName('cpm').setDescription('Pay rate per 1,000 views (CPM) in USD').setRequired(true).setMinValue(0.01))
          .addNumberOption((opt) => opt.setName('total_budget').setDescription('Total campaign budget in USD').setRequired(true).setMinValue(1))
          .addStringOption((opt) => opt.setName('starts_at').setDescription('Campaign start date (YYYY-MM-DD)').setRequired(true))
          .addStringOption((opt) => opt.setName('ends_at').setDescription('Campaign end date (YYYY-MM-DD)').setRequired(true))
          .addNumberOption((opt) => opt.setName('creator_cap').setDescription('Max earnings per creator per campaign (default: $600)').setMinValue(1))
          .addIntegerOption((opt) => opt.setName('min_clip_duration').setDescription('Minimum clip length in seconds (default: 7)').setMinValue(1))
          .addIntegerOption((opt) => opt.setName('max_clip_duration').setDescription('Maximum clip length in seconds (default: 120)').setMinValue(1))
          .addBooleanOption((opt) => opt.setName('retention_required').setDescription('Require clips to stay live for a retention period?'))
          .addIntegerOption((opt) => opt.setName('retention_days').setDescription('Retention period in days (required if retention_required = true)').setMinValue(1))
          .addStringOption((opt) =>
            opt.setName('platforms').setDescription('Allowed platforms (comma-separated: youtube,tiktok,instagram,facebook)').setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('members')
          .setDescription('List members of a campaign')
          .addStringOption((opt) => opt.setName('campaign_id').setDescription('Campaign UUID').setRequired(true))
          .addIntegerOption((opt) => opt.setName('page').setDescription('Page number').setMinValue(1))
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove-member')
          .setDescription('Remove a member from a campaign (preserves historical earnings)')
          .addStringOption((opt) => opt.setName('campaign_id').setDescription('Campaign UUID').setRequired(true))
          .addStringOption((opt) => opt.setName('user_id').setDescription('Creator internal UUID').setRequired(true))
          .addStringOption((opt) => opt.setName('reason').setDescription('Reason for removal'))
      )
  )
  // ==================== SUBMISSIONS SUBCOMMANDS ====================
  .addSubcommandGroup((group) =>
    group
      .setName('submissions')
      .setDescription('Review and moderate submissions')
      .addSubcommand((sub) =>
        sub
          .setName('list')
          .setDescription('List submissions by status or risk tier')
          .addStringOption((opt) =>
            opt
              .setName('status')
              .setDescription('Submission status filter')
              .addChoices(
                { name: 'PENDING_VERIFICATION', value: 'PENDING_VERIFICATION' },
                { name: 'UNDER_REVIEW', value: 'UNDER_REVIEW' },
                { name: 'APPROVED', value: 'APPROVED' },
                { name: 'FLAGGED', value: 'FLAGGED' },
                { name: 'POST_APPROVAL_REVIEW', value: 'POST_APPROVAL_REVIEW' },
                { name: 'REJECTED', value: 'REJECTED' }
              )
          )
          .addStringOption((opt) =>
            opt
              .setName('risk_level')
              .setDescription('Filter by assessed verification risk tier')
              .addChoices(
                { name: 'LOW_RISK', value: 'LOW_RISK' },
                { name: 'REVIEW_REQUIRED', value: 'REVIEW_REQUIRED' },
                { name: 'HIGH_RISK', value: 'HIGH_RISK' }
              )
          )
          .addStringOption((opt) => opt.setName('campaign_id').setDescription('Filter by campaign UUID'))
          .addIntegerOption((opt) => opt.setName('page').setDescription('Page number').setMinValue(1))
      )
      .addSubcommand((sub) =>
        sub
          .setName('queue')
          .setDescription('List submissions currently requiring review (UNDER_REVIEW, POST_APPROVAL_REVIEW, FLAGGED)')
          .addStringOption((opt) => opt.setName('campaign_id').setDescription('Filter by campaign UUID'))
          .addIntegerOption((opt) => opt.setName('page').setDescription('Page number').setMinValue(1))
      )
      .addSubcommand((sub) =>
        sub
          .setName('view')
          .setDescription('Inspect operational submission details, risk scores, signals, and audit history')
          .addStringOption((opt) => opt.setName('submission_id').setDescription('Submission UUID').setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName('approve')
          .setDescription('Manually approve or restore a submission')
          .addStringOption((opt) => opt.setName('submission_id').setDescription('Submission UUID').setRequired(true))
          .addStringOption((opt) => opt.setName('notes').setDescription('Optional staff approval notes'))
      )
      .addSubcommand((sub) =>
        sub
          .setName('reject')
          .setDescription('Manually reject a submission')
          .addStringOption((opt) => opt.setName('submission_id').setDescription('Submission UUID').setRequired(true))
          .addStringOption((opt) =>
            opt
              .setName('reason')
              .setDescription('Structured rejection reason')
              .setRequired(true)
              .addChoices(
                { name: 'Suspicious Engagement', value: 'SUSPICIOUS_ENGAGEMENT' },
                { name: 'Invalid / Manipulated Metrics', value: 'INVALID_MANIPULATED_METRICS' },
                { name: 'Campaign Requirement Violation', value: 'CAMPAIGN_REQUIREMENT_VIOLATION' },
                { name: 'Content Violation', value: 'CONTENT_VIOLATION' },
                { name: 'Duplicate or Reused Content', value: 'DUPLICATE_REUSED_CONTENT' },
                { name: 'Video Deleted or Unavailable', value: 'VIDEO_DELETED_UNAVAILABLE' },
                { name: 'Insufficient Analytics Evidence', value: 'INSUFFICIENT_ANALYTICS_EVIDENCE' },
                { name: 'Platform Violation', value: 'PLATFORM_VIOLATION' },
                { name: 'Retention Requirement Violation', value: 'RETENTION_REQUIREMENT_VIOLATION' },
                { name: 'Other', value: 'OTHER' }
              )
          )
          .addStringOption((opt) => opt.setName('notes').setDescription('Optional notes explaining rejection'))
      )
      .addSubcommand((sub) =>
        sub
          .setName('flag')
          .setDescription('Flag submission for priority investigation')
          .addStringOption((opt) => opt.setName('submission_id').setDescription('Submission UUID').setRequired(true))
          .addStringOption((opt) => opt.setName('reason').setDescription('Reason for flagging').setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName('post-approval-review')
          .setDescription('Move an approved submission into post-approval review')
          .addStringOption((opt) => opt.setName('submission_id').setDescription('Submission UUID').setRequired(true))
          .addStringOption((opt) => opt.setName('reason').setDescription('Reason for investigation'))
          .addStringOption((opt) => opt.setName('notes').setDescription('Investigation notes'))
      )
      .addSubcommand((sub) =>
        sub
          .setName('reject-post-approval')
          .setDescription('Reject an approved submission and generate negative financial adjustment')
          .addStringOption((opt) => opt.setName('submission_id').setDescription('Submission UUID').setRequired(true))
          .addStringOption((opt) =>
            opt
              .setName('reason')
              .setDescription('Structured rejection reason')
              .setRequired(true)
              .addChoices(
                { name: 'Suspicious Engagement', value: 'SUSPICIOUS_ENGAGEMENT' },
                { name: 'Invalid / Manipulated Metrics', value: 'INVALID_MANIPULATED_METRICS' },
                { name: 'Campaign Requirement Violation', value: 'CAMPAIGN_REQUIREMENT_VIOLATION' },
                { name: 'Content Violation', value: 'CONTENT_VIOLATION' },
                { name: 'Duplicate or Reused Content', value: 'DUPLICATE_REUSED_CONTENT' },
                { name: 'Video Deleted or Unavailable', value: 'VIDEO_DELETED_UNAVAILABLE' },
                { name: 'Insufficient Analytics Evidence', value: 'INSUFFICIENT_ANALYTICS_EVIDENCE' },
                { name: 'Platform Violation', value: 'PLATFORM_VIOLATION' },
                { name: 'Retention Requirement Violation', value: 'RETENTION_REQUIREMENT_VIOLATION' },
                { name: 'Other', value: 'OTHER' }
              )
          )
          .addStringOption((opt) => opt.setName('notes').setDescription('Notes explaining the rejection'))
      )
  )
  // ==================== CREATOR SUBCOMMANDS ====================
  .addSubcommandGroup((group) =>
    group
      .setName('creator')
      .setDescription('Creator operational management')
      .addSubcommand((sub) =>
        sub
          .setName('search')
          .setDescription('Search creators by Discord ID or username')
          .addStringOption((opt) => opt.setName('query').setDescription('Discord ID, username, or display name').setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName('view')
          .setDescription('View creator profile, memberships, and operational breakdown')
          .addStringOption((opt) => opt.setName('user_id').setDescription('Internal UUID or Discord snowflake').setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName('set-status')
          .setDescription('Update creator status (ACTIVE, SUSPENDED, BANNED)')
          .addStringOption((opt) => opt.setName('user_id').setDescription('Internal UUID or Discord snowflake').setRequired(true))
          .addStringOption((opt) =>
            opt
              .setName('status')
              .setDescription('Target account status')
              .setRequired(true)
              .addChoices(
                { name: 'ACTIVE', value: 'ACTIVE' },
                { name: 'SUSPENDED', value: 'SUSPENDED' },
                { name: 'BANNED', value: 'BANNED' }
              )
          )
          .addStringOption((opt) => opt.setName('reason').setDescription('Operational audit reason'))
      )
  )
  // ==================== PAYOUTS SUBCOMMANDS ====================
  .addSubcommandGroup((group) =>
    group
      .setName('payouts')
      .setDescription('Review and disburse creator payouts (Financial permissions required)')
      .addSubcommand((sub) =>
        sub
          .setName('list')
          .setDescription('List creator payout requests')
          .addStringOption((opt) =>
            opt
              .setName('status')
              .setDescription('Payout status filter')
              .addChoices(
                { name: 'REQUESTED', value: 'REQUESTED' },
                { name: 'UNDER_REVIEW', value: 'UNDER_REVIEW' },
                { name: 'APPROVED', value: 'APPROVED' },
                { name: 'PROCESSING', value: 'PROCESSING' },
                { name: 'COMPLETED', value: 'COMPLETED' },
                { name: 'FAILED', value: 'FAILED' },
                { name: 'REJECTED', value: 'REJECTED' }
              )
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('view')
          .setDescription('View payout request details and disbursement breakdown')
          .addStringOption((opt) => opt.setName('payout_id').setDescription('Payout request UUID').setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName('approve')
          .setDescription('Approve payout request (ADMIN role strictly required)')
          .addStringOption((opt) => opt.setName('payout_id').setDescription('Payout request UUID').setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName('reject')
          .setDescription('Reject payout request and release balance reservation (ADMIN strictly required)')
          .addStringOption((opt) => opt.setName('payout_id').setDescription('Payout request UUID').setRequired(true))
          .addStringOption((opt) => opt.setName('reason').setDescription('Mandatory rejection reason').setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName('process')
          .setDescription('Initiate disbursement processing (ADMIN strictly required)')
          .addStringOption((opt) => opt.setName('payout_id').setDescription('Payout request UUID').setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName('accept-evidence')
          .setDescription('Accept analytics telemetry screen recording evidence for a payout (ADMIN required)')
          .addStringOption((opt) => opt.setName('payout_id').setDescription('Payout request UUID').setRequired(true))
          .addStringOption((opt) => opt.setName('notes').setDescription('Optional approval notes'))
      )
      .addSubcommand((sub) =>
        sub
          .setName('reject-evidence')
          .setDescription('Reject analytics evidence with structured reason (ADMIN required)')
          .addStringOption((opt) => opt.setName('payout_id').setDescription('Payout request UUID').setRequired(true))
          .addStringOption((opt) =>
            opt
              .setName('reason')
              .setDescription('Structured rejection reason')
              .setRequired(true)
              .addChoices(
                { name: 'Telemetry Mismatch', value: 'TELEMETRY_MISMATCH' },
                { name: 'Duration Exceeded (>40s)', value: 'DURATION_EXCEEDED' },
                { name: 'Corrupted / Invalid File', value: 'CORRUPTED_FILE' },
                { name: 'Insufficient Telemetry Elements', value: 'INSUFFICIENT_TELEMETRY' },
                { name: 'Suspicious Editing / Tampering', value: 'SUSPICIOUS_EDITING' },
                { name: 'Wrong Account / Identity Mismatch', value: 'WRONG_ACCOUNT' },
                { name: 'Other', value: 'OTHER' }
              )
          )
          .addStringOption((opt) => opt.setName('notes').setDescription('Optional notes explaining rejection'))
      )
      .addSubcommand((sub) =>
        sub
          .setName('view-evidence')
          .setDescription('View and inspect stored analytics screen recording evidence for a payout')
          .addStringOption((opt) => opt.setName('payout_id').setDescription('Payout request UUID').setRequired(true))
          .addIntegerOption((opt) => opt.setName('version').setDescription('Optional specific evidence version (defaults to latest)'))
      )
  )
  // ==================== SUBMISSION SUBCOMMANDS ====================
  .addSubcommandGroup((group) =>
    group
      .setName('submission')
      .setDescription('Inspect clip submissions, duration verification, and retention status')
      .addSubcommand((sub) =>
        sub
          .setName('view')
          .setDescription('View detailed submission evidence, duration, requirements, and retention status')
          .addStringOption((opt) => opt.setName('submission_id').setDescription('Submission UUID').setRequired(true))
      )
  )
  // ==================== AUDIT SUBCOMMAND ====================
  .addSubcommandGroup((group) =>
    group
      .setName('audit')
      .setDescription('Inspect administrative audit trail')
      .addSubcommand((sub) =>
        sub
          .setName('list')
          .setDescription('List recent administrative audit events')
          .addStringOption((opt) =>
            opt
              .setName('entity_type')
              .setDescription('Filter by entity type')
              .addChoices(
                { name: 'CAMPAIGN', value: 'CAMPAIGN' },
                { name: 'CREATOR', value: 'CREATOR' },
                { name: 'SUBMISSION', value: 'SUBMISSION' },
                { name: 'PAYOUT', value: 'PAYOUT' },
                { name: 'MEMBERSHIP', value: 'MEMBERSHIP' }
              )
          )
          .addStringOption((opt) => opt.setName('entity_id').setDescription('Filter by entity identifier'))
          .addIntegerOption((opt) => opt.setName('page').setDescription('Page number').setMinValue(1))
      )
  )
  // ==================== OPERATIONAL PANELS SETUP ====================
  .addSubcommandGroup((group) =>
    group
      .setName('setup')
      .setDescription('Deploy and configure operational panels without server provisioning')
      .addSubcommand((sub) =>
        sub
          .setName('panels')
          .setDescription('Deploy or update canonical operational panels in configured channels')
      )
  )
  // ==================== CHANNEL RESET SUBCOMMAND ====================
  .addSubcommand((sub) =>
    sub
      .setName('reset-channel')
      .setDescription('Reset the current operational channel to its default canonical hub message')
  );

/**
 * Slash command execution entry point
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  const group = interaction.options.getSubcommandGroup();
  const subcommand = interaction.options.getSubcommand();
  const actor = {
    discordId: interaction.user.id,
    userId: null // Internal user ID will be resolved if exists
  };

  try {
    // 0A. OPERATIONAL PANELS SETUP (ZERO PROVISIONING)
    if (group === 'setup' && subcommand === 'panels') {
      const roles = assertAdminPermission(interaction, AdminPermission.CAMPAIGN_EDIT);
      if (!roles.includes(AdminRole.ADMIN)) {
        throw new UnauthorizedAdminActionError('Panel setup requires full Admin role authority.');
      }
      await interaction.deferReply({ ephemeral: true });

      const results = await panelService.deployAllPanels(interaction.client, interaction.guild);

      const lines = ['🛡️ **Operational Panels Setup Complete**\n'];

      if (results.created.length > 0) {
        lines.push(`**✅ Created (${results.created.length}):**`);
        for (const item of results.created) {
          lines.push(`• **${item.name}** in <#${item.channelId}> (\`${item.messageId}\`)`);
        }
        lines.push('');
      }

      if (results.updated.length > 0) {
        lines.push(`**🔄 Updated (${results.updated.length}):**`);
        for (const item of results.updated) {
          lines.push(`• **${item.name}** in <#${item.channelId}> (\`${item.messageId}\`)`);
        }
        lines.push('');
      }

      if (results.skipped.length > 0) {
        lines.push(`**⚠️ Skipped (${results.skipped.length}):**`);
        for (const item of results.skipped) {
          lines.push(`• **${item.name}** (\`${item.envVar}\`): ${item.reason}`);
        }
        lines.push('');
      }

      if (results.failed.length > 0) {
        lines.push(`**❌ Failed (${results.failed.length}):**`);
        for (const item of results.failed) {
          lines.push(`• **${item.name}**: ${item.reason}`);
        }
        lines.push('');
      }

      await interaction.editReply({
        content: lines.join('\n').trim()
      });
      return;
    }

    // 0B. CHANNEL RESET
    if (!group && subcommand === 'reset-channel') {
      assertAdminPermission(interaction, AdminPermission.SUBMISSION_VIEW);
      await interaction.deferReply({ ephemeral: true });

      const channel = interaction.channel;
      const botMember = interaction.guild?.members?.me || null;
      const correlationId = `reset_${Date.now()}`;

      const res = await serverProvisioner.reconcileSingleChannel(channel, botMember, correlationId);
      if (res) {
        await interaction.editReply({
          content: `✅ Successfully reset **#${channel?.name || 'channel'}** to its original fresh hub state.`
        });
      } else {
        await interaction.editReply({
          content: `⚠️ Could not find a canonical hub configuration for **#${channel?.name || 'this channel'}**.`
        });
      }
      return;
    }

    // 1. CAMPAIGN COMMANDS
    if (group === 'campaign') {
      if (subcommand === 'list') {
        assertAdminPermission(interaction, AdminPermission.CAMPAIGN_EDIT);
        const status = interaction.options.getString('status') || undefined;
        const search = interaction.options.getString('search') || undefined;
        const page = interaction.options.getInteger('page') || 1;

        const result = await adminCampaignService.listCampaigns({ status, search, page });

        const embed = new EmbedBuilder()
          .setTitle('🛡️ Admin — Campaigns Overview')
          .setColor(0x5865f2)
          .setDescription(
            result.items.length === 0
              ? 'No campaigns found matching criteria.'
              : result.items
                  .map(
                    (c) =>
                      `• **${c.name}** (\`${c.slug}\`)\n  Status: \`${c.status}\` | Rate: \`$${Number(c.payRate).toFixed(2)}\` | Members: \`${c._count.members}\` | Submissions: \`${c._count.submissions}\`\n  ID: \`${c.id}\``
                  )
                  .join('\n\n')
          )
          .setFooter({ text: `Page ${result.page} of ${result.totalPages} • Total: ${result.total}` });

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (subcommand === 'view') {
        assertAdminPermission(interaction, AdminPermission.CAMPAIGN_EDIT);
        const campaignId = interaction.options.getString('campaign_id');
        const campaign = await adminCampaignService.getCampaignDetails(campaignId);

        const embed = new EmbedBuilder()
          .setTitle(`🛡️ Campaign: ${campaign.name}`)
          .setColor(campaign.status === 'COMPLETED' ? 0xEB459E : 0x5865f2)
          .addFields(
            { name: 'Status', value: `\`${campaign.status}\``, inline: true },
            { name: 'Client', value: campaign.clientName, inline: true },
            { name: 'CPM', value: `\`$${Number(campaign.payRate).toFixed(2)} / 1k views\``, inline: true },
            {
              name: '💵 Budget',
              value: [
                `**Total:** \`$${Number(campaign.totalBudget ?? 0).toFixed(2)}\``,
                `**Consumed:** \`$${Number(campaign.consumedBudget ?? 0).toFixed(2)}\``,
                `**Remaining:** \`$${Math.max(0, Number(campaign.totalBudget ?? 0) - Number(campaign.consumedBudget ?? 0)).toFixed(2)}\``,
                `**Fulfillment:** \`${campaign.totalBudget && Number(campaign.totalBudget) > 0 ? (Number(campaign.consumedBudget ?? 0) / Number(campaign.totalBudget) * 100).toFixed(1) : '0.0'}%\``
              ].join('\n'),
              inline: false
            },
            { name: 'Creator Cap', value: `\`$${Number(campaign.creatorEarningCap ?? 600).toFixed(2)}\``, inline: true },
            { name: 'Clip Duration', value: `\`${campaign.minClipDurationSeconds ?? 7}s – ${campaign.maxClipDurationSeconds ?? 120}s\``, inline: true },
            { name: 'Retention', value: campaign.retentionRequired ? `\`${campaign.retentionDays} days\`` : '`Not required`', inline: true },
            { name: 'Window', value: `${new Date(campaign.startsAt).toLocaleDateString()} — ${new Date(campaign.endsAt).toLocaleDateString()}`, inline: false },
            { name: 'Active Members', value: `\`${campaign.metrics.activeMembers}\``, inline: true },
            { name: 'Total Submissions', value: `\`${campaign.metrics.totalSubmissions}\``, inline: true },
            {
              name: 'Submission Breakdown',
              value: `Approved: \`${campaign.metrics.statusBreakdown.APPROVED}\` | Review: \`${campaign.metrics.statusBreakdown.UNDER_REVIEW}\` | Flagged: \`${campaign.metrics.statusBreakdown.FLAGGED}\` | Rejected: \`${campaign.metrics.statusBreakdown.REJECTED}\``,
              inline: false
            },
            { name: 'Ledgered Earnings', value: `\`$${Number(campaign.metrics.totalEligibleEarnings).toFixed(2)} ${campaign.currency}\``, inline: true },
            { name: 'Credited Views', value: `\`${Number(campaign.metrics.totalCreditedViews).toLocaleString()}\``, inline: true }
          )
          .setFooter({ text: `Campaign ID: ${campaign.id}` });

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (subcommand === 'report') {
        assertAdminPermission(interaction, AdminPermission.CAMPAIGN_EDIT);
        const campaignId = interaction.options.getString('campaign_id');
        const view = interaction.options.getString('view') || 'overview';
        const sort = interaction.options.getString('sort') || 'views';
        const page = interaction.options.getInteger('page') || 1;

        const report = await adminCampaignService.getCampaignAnalyticsReport(campaignId, actor, {
          page,
          sortBy: sort,
          sortOrder: 'desc'
        });

        const embed = buildAdminCampaignReportEmbed(report, view);
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (subcommand === 'create') {
        assertAdminPermission(interaction, AdminPermission.CAMPAIGN_EDIT);

        const name = interaction.options.getString('name');
        const slug = interaction.options.getString('slug');
        const clientName = interaction.options.getString('client');
        const description = interaction.options.getString('description');
        const payRate = interaction.options.getNumber('cpm');
        const totalBudget = interaction.options.getNumber('total_budget');
        const startsAt = interaction.options.getString('starts_at');
        const endsAt = interaction.options.getString('ends_at');
        const creatorCap = interaction.options.getNumber('creator_cap') ?? 600;
        const minClip = interaction.options.getInteger('min_clip_duration') ?? 7;
        const maxClip = interaction.options.getInteger('max_clip_duration') ?? 120;
        const retentionRequired = interaction.options.getBoolean('retention_required') ?? false;
        const retentionDays = interaction.options.getInteger('retention_days') ?? null;

        const platformsRaw = interaction.options.getString('platforms') || 'youtube,tiktok,instagram';
        const allowedPlatforms = platformsRaw.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);

        const campaign = await adminCampaignService.createCampaign(
          {
            name,
            slug,
            clientName,
            description,
            payRate,
            totalBudget,
            minimumPayout: 10,
            creatorEarningCap: creatorCap,
            minClipDurationSeconds: minClip,
            maxClipDurationSeconds: maxClip,
            retentionRequired,
            retentionDays,
            startsAt: new Date(startsAt),
            endsAt: new Date(endsAt),
            requirements: { allowedPlatforms }
          },
          actor
        );

        const embed = new EmbedBuilder()
          .setTitle('✅ Campaign Created')
          .setColor(0x57F287)
          .addFields(
            { name: 'Name', value: campaign.name, inline: true },
            { name: 'Slug', value: campaign.slug, inline: true },
            { name: 'Status', value: `\`${campaign.status}\``, inline: true },
            { name: 'CPM', value: `\`$${Number(campaign.payRate).toFixed(2)}\``, inline: true },
            { name: 'Total Budget', value: `\`$${Number(campaign.totalBudget).toFixed(2)}\``, inline: true },
            { name: 'Creator Cap', value: `\`$${Number(campaign.creatorEarningCap).toFixed(2)}\``, inline: true },
            { name: 'Clip Duration', value: `\`${campaign.minClipDurationSeconds}s – ${campaign.maxClipDurationSeconds}s\``, inline: true },
            { name: 'Retention', value: campaign.retentionRequired ? `\`${campaign.retentionDays} days\`` : '`Not required`', inline: true }
          )
          .setFooter({ text: `Campaign ID: ${campaign.id} • Status: DRAFT — use /admin campaign set-status to activate` });

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (subcommand === 'set-status') {
        assertAdminPermission(interaction, AdminPermission.CAMPAIGN_ACTIVATE);
        const campaignId = interaction.options.getString('campaign_id');
        const targetStatus = interaction.options.getString('status');
        const reason = interaction.options.getString('reason');

        const updated = await adminCampaignService.setCampaignStatus(campaignId, targetStatus, actor, reason);

        await interaction.reply({
          content: `✅ Campaign **${updated.name}** transitioned to \`${updated.status}\`.`,
          ephemeral: true
        });
        return;
      }

      if (subcommand === 'members') {
        assertAdminPermission(interaction, AdminPermission.MEMBER_VIEW);
        const campaignId = interaction.options.getString('campaign_id');
        const page = interaction.options.getInteger('page') || 1;

        const result = await adminCampaignService.listMembers(campaignId, { page });

        const embed = new EmbedBuilder()
          .setTitle('🛡️ Campaign Members')
          .setColor(0x5865f2)
          .setDescription(
            result.items.length === 0
              ? 'No members found.'
              : result.items
                  .map(
                    (m) =>
                      `• **${m.user.displayName || m.user.username}** (\`${m.user.discordId}\`)\n  Status: \`${m.status}\` | User Status: \`${m.user.status}\` | Joined: <t:${Math.floor(new Date(m.joinedAt).getTime() / 1000)}:R>\n  User ID: \`${m.user.id}\``
                  )
                  .join('\n\n')
          )
          .setFooter({ text: `Page ${result.page} of ${result.totalPages} • Total: ${result.total}` });

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (subcommand === 'remove-member') {
        assertAdminPermission(interaction, AdminPermission.MEMBER_REMOVE);
        const campaignId = interaction.options.getString('campaign_id');
        const userId = interaction.options.getString('user_id');
        const reason = interaction.options.getString('reason');

        await adminCampaignService.removeMember(campaignId, userId, actor, reason);

        await interaction.reply({
          content: `✅ Member \`${userId}\` removed from campaign \`${campaignId}\`. Historical submissions and earnings preserved.`,
          ephemeral: true
        });
        return;
      }
    }

    // 2. SUBMISSIONS COMMANDS
    if (group === 'submissions') {
      if (subcommand === 'list') {
        assertAdminPermission(interaction, AdminPermission.SUBMISSION_VIEW);
        const status = interaction.options.getString('status') || undefined;
        const riskLevel = interaction.options.getString('risk_level') || undefined;
        const campaignId = interaction.options.getString('campaign_id') || undefined;
        const page = interaction.options.getInteger('page') || 1;

        const result = await adminSubmissionService.listSubmissions({ status, riskLevel, campaignId, page });

        const embed = new EmbedBuilder()
          .setTitle('🛡️ Admin — Submissions Review Queue')
          .setColor(0x5865f2)
          .setDescription(
            result.items.length === 0
              ? 'No submissions found matching criteria.'
              : result.items
                  .map((s) => {
                    const latestVer = s.verifications[0];
                    const latestSnap = s.snapshots[0];
                    const riskStr = latestVer ? `[${latestVer.riskLevel} - score ${latestVer.score ?? 'N/A'}]` : '[Unverified]';
                    const viewsStr = latestSnap?.views !== null && latestSnap?.views !== undefined ? `${Number(latestSnap.views).toLocaleString()} views` : 'N/A';
                    return `• **${s.campaign.name}** — \`${s.platform}\`\n  Status: \`${s.status}\` | Risk: \`${riskStr}\` | Metrics: \`${viewsStr}\`\n  Creator: **${s.user.displayName || s.user.username}** (\`${s.user.discordId}\`)\n  ID: \`${s.id}\``;
                  })
                  .join('\n\n')
          )
          .setFooter({ text: `Page ${result.page} of ${result.totalPages} • Total: ${result.total}` });

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (subcommand === 'queue') {
        assertAdminPermission(interaction, AdminPermission.SUBMISSION_REVIEW);
        const campaignId = interaction.options.getString('campaign_id') || undefined;
        const page = interaction.options.getInteger('page') || 1;

        const result = await adminSubmissionService.listReviewQueue({ campaignId, page });

        const embed = new EmbedBuilder()
          .setTitle('🛡️ Admin — Pending Moderation Review Queue')
          .setColor(0xfee75c)
          .setDescription(
            result.items.length === 0
              ? 'No submissions currently require review.'
              : result.items
                  .map((s) => {
                    const latestVer = s.verifications[0];
                    const latestSnap = s.snapshots[0];
                    const riskStr = latestVer ? `[${latestVer.riskLevel} - score ${latestVer.score ?? 'N/A'}]` : '[Unverified]';
                    const viewsStr = latestSnap?.views !== null && latestSnap?.views !== undefined ? `${Number(latestSnap.views).toLocaleString()} views` : 'N/A';
                    return `• **${s.campaign.name}** — \`${s.platform}\`\n  Status: \`${s.status}\` | Risk: \`${riskStr}\` | Metrics: \`${viewsStr}\`\n  Creator: **${s.user.displayName || s.user.username}** (\`${s.user.discordId}\`)\n  ID: \`${s.id}\``;
                  })
                  .join('\n\n')
          )
          .setFooter({ text: `Page ${result.page} of ${result.totalPages} • Total: ${result.total}` });

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (subcommand === 'view') {
        assertAdminPermission(interaction, AdminPermission.SUBMISSION_REVIEW);
        const submissionId = interaction.options.getString('submission_id');
        const sub = await adminSubmissionService.getSubmissionDetails(submissionId, { isStaff: true });

        const latestVer = sub.verifications[0];
        const latestSnap = sub.snapshots[0];

        const embed = new EmbedBuilder()
          .setTitle(`🛡️ Submission Review: ${sub.id}`)
          .setColor(sub.status === 'APPROVED' ? 0x57f287 : sub.status === 'REJECTED' ? 0xed4245 : 0xfee75c)
          .addFields(
            { name: 'Status', value: `\`${sub.status}\``, inline: true },
            { name: 'Platform', value: `\`${sub.platform}\``, inline: true },
            { name: 'Campaign', value: sub.campaign.name, inline: true },
            { name: 'Creator', value: `**${sub.user.displayName || sub.user.username}** (\`${sub.user.discordId}\`)`, inline: false },
            { name: 'URL', value: sub.url, inline: false },
            {
              name: 'Internal Risk Tier (Staff Only)',
              value: latestVer ? `\`${latestVer.riskLevel}\` (Score: \`${latestVer.score ?? 'N/A'}\`)` : '`No verification recorded`',
              inline: true
            },
            {
              name: 'Latest Verified Metrics',
              value: latestSnap ? `Views: \`${Number(latestSnap.views ?? 0).toLocaleString()}\` | Likes: \`${latestSnap.likes !== null ? Number(latestSnap.likes).toLocaleString() : 'Hidden'}\` | Comments: \`${latestSnap.comments !== null ? Number(latestSnap.comments).toLocaleString() : 'Disabled'}\`` : '`No snapshots`',
              inline: false
            }
          );

        if (latestVer?.signals?.length > 0) {
          const signalsFormatted = latestVer.signals
            .map((sig) => `• [${sig.severity}] **${sig.type}**: ${sig.explanation}`)
            .join('\n');
          embed.addFields({ name: 'Integrity Signals (Staff Only)', value: signalsFormatted.slice(0, 1024), inline: false });
        }

        if (sub.moderationHistory?.length > 0) {
          const historyFormatted = sub.moderationHistory
            .map((h) => `• <t:${Math.floor(new Date(h.createdAt).getTime() / 1000)}:R> **${h.action}** by \`${h.actorDiscordId}\`${h.reason ? ` (${h.reason})` : ''}`)
            .join('\n');
          embed.addFields({ name: 'Moderation History (Staff Only)', value: historyFormatted.slice(0, 1024), inline: false });
        }

        if (sub.financialAdjustments?.length > 0) {
          const adjFormatted = sub.financialAdjustments
            .map((a) => `• ${a.type}: **$${a.amount}** (${a.reason})`)
            .join('\n');
          embed.addFields({ name: 'Financial Adjustments', value: adjFormatted.slice(0, 1024), inline: false });
        }

        if (sub.rejectionReason) {
          embed.addFields({ name: 'Rejection Reason', value: sub.rejectionReason, inline: false });
        }

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (subcommand === 'approve') {
        assertAdminPermission(interaction, AdminPermission.SUBMISSION_APPROVE);
        const submissionId = interaction.options.getString('submission_id');
        const notes = interaction.options.getString('notes');

        const updated = await adminSubmissionService.approveSubmission(submissionId, actor, notes);

        await interaction.reply({
          content: `✅ Submission \`${updated.id}\` has been **APPROVED / RESTORED**. Eligible views will be credited according to earnings policy.`,
          ephemeral: true
        });
        return;
      }

      if (subcommand === 'reject') {
        assertAdminPermission(interaction, AdminPermission.SUBMISSION_REJECT);
        const submissionId = interaction.options.getString('submission_id');
        const structuredReason = interaction.options.getString('reason');
        const notes = interaction.options.getString('notes');

        const updated = await adminSubmissionService.rejectSubmission(submissionId, actor, { structuredReason, notes });

        await interaction.reply({
          content: `🚫 Submission \`${updated.id}\` has been **REJECTED**.\nReason: *${updated.rejectionReason}*`,
          ephemeral: true
        });
        return;
      }

      if (subcommand === 'flag') {
        assertAdminPermission(interaction, AdminPermission.SUBMISSION_FLAG);
        const submissionId = interaction.options.getString('submission_id');
        const reason = interaction.options.getString('reason');

        const updated = await adminSubmissionService.flagOrReviewSubmission(submissionId, 'FLAGGED', actor, reason);

        await interaction.reply({
          content: `🚩 Submission \`${updated.id}\` has been **FLAGGED** for priority investigation.`,
          ephemeral: true
        });
        return;
      }

      if (subcommand === 'post-approval-review') {
        assertAdminPermission(interaction, AdminPermission.SUBMISSION_REVIEW);
        const submissionId = interaction.options.getString('submission_id');
        const reason = interaction.options.getString('reason') || 'Initiated post-approval fraud investigation';
        const notes = interaction.options.getString('notes');

        const updated = await adminSubmissionService.startPostApprovalReview(submissionId, actor, { reason, notes });

        await interaction.reply({
          content: `🔍 Submission \`${updated.id}\` has been moved to **POST_APPROVAL_REVIEW**.`,
          ephemeral: true
        });
        return;
      }

      if (subcommand === 'reject-post-approval') {
        assertAdminPermission(interaction, AdminPermission.SUBMISSION_REJECT);
        const submissionId = interaction.options.getString('submission_id');
        const structuredReason = interaction.options.getString('reason');
        const notes = interaction.options.getString('notes');

        const result = await adminSubmissionService.rejectPostApproval(submissionId, actor, { structuredReason, notes });

        await interaction.reply({
          content: `🚫 Approved submission \`${result.submission.id}\` has been **REJECTED POST-APPROVAL**.\nCreated ${result.adjustments.length} negative financial adjustment(s). Historical earnings preserved intact.`,
          ephemeral: true
        });
        return;
      }
    }

    // 3. CREATOR COMMANDS
    if (group === 'creator') {
      if (subcommand === 'search') {
        assertAdminPermission(interaction, AdminPermission.CREATOR_VIEW);
        const query = interaction.options.getString('query');
        const creators = await adminCreatorService.searchCreators(query);

        const embed = new EmbedBuilder()
          .setTitle(`🛡️ Creator Search: "${query}"`)
          .setColor(0x5865f2)
          .setDescription(
            creators.length === 0
              ? 'No creators found matching search query.'
              : creators
                  .map(
                    (u) =>
                      `• **${u.displayName || u.username}** (\`${u.discordId}\`)\n  Status: \`${u.status}\` | ID: \`${u.id}\` | Joined: <t:${Math.floor(new Date(u.createdAt).getTime() / 1000)}:d>`
                  )
                  .join('\n\n')
          );

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (subcommand === 'view') {
        assertAdminPermission(interaction, AdminPermission.CREATOR_VIEW);
        const userId = interaction.options.getString('user_id');
        const creator = await adminCreatorService.getCreatorDetails(userId);

        const embed = new EmbedBuilder()
          .setTitle(`🛡️ Creator Profile: ${creator.displayName || creator.username}`)
          .setColor(creator.status === 'ACTIVE' ? 0x57f287 : 0xed4245)
          .addFields(
            { name: 'Discord ID', value: `\`${creator.discordId}\``, inline: true },
            { name: 'Account Status', value: `\`${creator.status}\``, inline: true },
            { name: 'Total Submissions', value: `\`${creator.totalSubmissions}\``, inline: true },
            {
              name: 'Submissions Breakdown',
              value: `Approved: \`${creator.submissionStatusBreakdown.APPROVED}\` | Review: \`${creator.submissionStatusBreakdown.UNDER_REVIEW}\` | Flagged: \`${creator.submissionStatusBreakdown.FLAGGED}\` | Rejected: \`${creator.submissionStatusBreakdown.REJECTED}\``,
              inline: false
            },
            {
              name: 'Campaign Memberships',
              value: creator.memberships.length === 0
                ? 'None'
                : creator.memberships.map((m) => `• ${m.campaign.name} (\`${m.status}\`)`).join('\n').slice(0, 1024),
              inline: false
            }
          )
          .setFooter({ text: `Internal User UUID: ${creator.id}` });

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (subcommand === 'set-status') {
        assertAdminPermission(interaction, AdminPermission.CREATOR_STATUS_MANAGE);
        const userId = interaction.options.getString('user_id');
        const targetStatus = interaction.options.getString('status');
        const reason = interaction.options.getString('reason');

        const updated = await adminCreatorService.updateCreatorStatus(userId, targetStatus, actor, reason);

        await interaction.reply({
          content: `✅ Creator **${updated.displayName || updated.username}** status set to \`${updated.status}\`.`,
          ephemeral: true
        });
        return;
      }
    }

    // 4. PAYOUT COMMANDS (Strict Financial Permissions)
    if (group === 'payouts') {
      if (subcommand === 'list') {
        assertAdminPermission(interaction, AdminPermission.PAYOUT_VIEW);
        const status = interaction.options.getString('status') || undefined;
        const payouts = await adminPayoutService.listPayoutRequests(status ? { status } : {});

        const embed = new EmbedBuilder()
          .setTitle('🛡️ Admin — Payout Requests Queue')
          .setColor(0x5865f2)
          .setDescription(
            payouts.length === 0
              ? 'No payout requests found.'
              : payouts
                  .map(
                    (p) =>
                      `• **$${Number(p.amount).toFixed(2)} ${p.currency}** — \`${p.status}\`\n  Creator: **${p.user?.displayName || p.user?.username || 'Unknown'}** (\`${p.user?.discordId || p.userId}\`)\n  Requested: <t:${Math.floor(new Date(p.requestedAt).getTime() / 1000)}:R> | ID: \`${p.id}\``
                  )
                  .join('\n\n')
          );

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (subcommand === 'view') {
        assertAdminPermission(interaction, AdminPermission.PAYOUT_VIEW);
        const payoutId = interaction.options.getString('payout_id');
        const payout = await adminPayoutService.getPayoutDetails(payoutId);

        if (!payout) {
          await interaction.reply({ content: '⚠️ Payout request not found.', ephemeral: true });
          return;
        }

        // Fetch creator's authoritative balance breakdown and adjustments
        const [balance, adjustments] = await Promise.all([
          payoutService.getAvailablePayoutBalance(payout.userId, payout.currency),
          adjustmentService.getUserAdjustments(payout.userId, payout.currency)
        ]);

        const statusBadge = formatPayoutStatusBadge(payout.status);
        const symbol = payout.currency === 'USD' ? '$' : `${payout.currency} `;

        // Determine funds reservation state
        let reservationStatus = '⚪ RELEASED (Available to Creator)';
        if (['REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING'].includes(payout.status)) {
          reservationStatus = `🔒 ACTIVE RESERVATION (${symbol}${Number(payout.amount).toFixed(2)} held)`;
        } else if (payout.status === 'COMPLETED') {
          reservationStatus = `🟢 CONSUMED (${symbol}${Number(payout.amount).toFixed(2)} permanently disbursed)`;
        }

        const embed = new EmbedBuilder()
          .setTitle(`🛡️ Payout Request Review: ${payout.id}`)
          .setColor(
            payout.status === 'COMPLETED'
              ? 0x57f287
              : payout.status === 'CANCELLED'
              ? 0x95a5a6
              : payout.status === 'REJECTED'
              ? 0xed4245
              : 0xfee75c
          )
          .addFields(
            {
              name: 'Creator',
              value: `**${payout.user?.displayName || payout.user?.username || 'Unknown'}**\n<@${payout.user?.discordId}>\nUUID: \`${payout.userId}\``,
              inline: true
            },
            {
              name: 'Payout Amount & Status',
              value: `💵 **${symbol}${Number(payout.amount).toFixed(2)}**\n${statusBadge}\nReservation: ${reservationStatus}`,
              inline: true
            },
            {
              name: '⏱️ Lifecycle Timestamps',
              value:
                `• **Requested:** <t:${Math.floor(new Date(payout.requestedAt).getTime() / 1000)}:F>\n` +
                `• **Approved:** ${payout.reviewedAt && payout.status !== 'REJECTED' ? `<t:${Math.floor(new Date(payout.reviewedAt).getTime() / 1000)}:R>` : '—'}\n` +
                `• **Processing:** ${payout.processingAt ? `<t:${Math.floor(new Date(payout.processingAt).getTime() / 1000)}:R>` : '—'}\n` +
                `• **Completed:** ${payout.completedAt ? `<t:${Math.floor(new Date(payout.completedAt).getTime() / 1000)}:R>` : '—'}\n` +
                `• **Cancelled:** ${payout.cancelledAt ? `<t:${Math.floor(new Date(payout.cancelledAt).getTime() / 1000)}:R>` : '—'}`,
              inline: false
            }
          );

        if (payout.cancelledAt) {
          embed.addFields({
            name: '🛑 Cancellation Details',
            value: `**Reason:** ${payout.cancellationReason || 'Cancelled by creator'}\n**Actor:** \`${payout.cancelledBy || 'Creator'}\``,
            inline: false
          });
        }

        if (payout.rejectionReason) {
          embed.addFields({
            name: '🚫 Rejection Reason',
            value: payout.rejectionReason,
            inline: false
          });
        }

        // Creator Financial Ledger Accounting (Explicit breakdown)
        embed.addFields({
          name: '📊 Creator Ledger & Balance Accounting',
          value:
            `• **Original Earnings (Eligible):** +${symbol}${Number(balance.eligibleEarnings).toFixed(2)}\n` +
            `• **Retention Adjustments:** ${Number(balance.netAdjustments) < 0 ? '-' : '+'}${symbol}${Math.abs(Number(balance.netAdjustments)).toFixed(2)}\n` +
            `• **Active Reservations:** -${symbol}${Number(balance.reservedBalance).toFixed(2)}\n` +
            `• **Completed Payouts:** -${symbol}${Number(balance.completedPayouts).toFixed(2)}\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `💰 **Net Future Available Balance:** **${symbol}${Number(balance.availableBalance).toFixed(2)}**`,
          inline: false
        });

        // Retention Adjustments Details
        let adjText = '*No retention adjustments on record for this creator.*';
        if (adjustments && adjustments.length > 0) {
          adjText = adjustments
            .slice(0, 5)
            .map((adj) => {
              const unix = Math.floor(new Date(adj.createdAt).getTime() / 1000);
              return `• **-${symbol}${Math.abs(Number(adj.amount)).toFixed(2)}** — \`${adj.type}\` (<t:${unix}:R>)\n  Reason: *${adj.reason}*`;
            })
            .join('\n');
        }
        embed.addFields({
          name: '🛡️ Retention Adjustments Affecting Creator',
          value: adjText,
          inline: false
        });

        // Profile Snapshot
        if (payout.profileSnapshot) {
          const snap = payout.profileSnapshot;
          const rawWallet = snap.walletAddress || '';
          const maskedWallet = rawWallet.length > 10
            ? `${rawWallet.slice(0, 6)}••••••••••${rawWallet.slice(-4)}`
            : rawWallet || '—';
          embed.addFields({
            name: '💳 Payout Profile Snapshot (At Request Time)',
            value:
              `• **Wallet Address:** \`${maskedWallet}\`\n` +
              `• **Network:** ${snap.network || '—'} (${snap.walletName || 'Default'})\n` +
              `• **Handle / Platform:** \`${snap.creatorHandle || '—'}\` (${snap.platform || '—'})\n` +
              `• **Snapshotted At:** ${snap.snapshottedAt ? `<t:${Math.floor(new Date(snap.snapshottedAt).getTime() / 1000)}:R>` : '—'}`,
            inline: false
          });
        } else {
          embed.addFields({
            name: '💳 Payout Profile Snapshot',
            value: '⚠️ *No profile snapshot recorded for this payout request.*',
            inline: false
          });
        }

        // Evidence Telemetry
        if (payout.evidence && payout.evidence.length > 0) {
          const evidenceLines = payout.evidence.map((ev) => {
            const sizeMb = (ev.fileSize / (1024 * 1024)).toFixed(2);
            const statusEmoji = ev.status === 'ACCEPTED' ? '✅' : ev.status === 'REJECTED' ? '❌' : '⏳';
            let line = `${statusEmoji} **v${ev.version}** — \`${ev.filename}\` (${ev.durationSeconds || '?'}s, ${sizeMb} MB) • \`${ev.status}\``;
            if (ev.status === 'REJECTED' && ev.rejectionReason) {
              line += `\n  Reason: *${ev.rejectionReason}*`;
            }
            if (ev.reviewedBy) {
              line += ` (Reviewed by: \`${ev.reviewedBy}\`)`;
            }
            return line;
          }).join('\n');
          embed.addFields({
            name: '📹 Screen Recording Analytics Evidence',
            value: evidenceLines,
            inline: false
          });
        } else {
          embed.addFields({
            name: '📹 Screen Recording Analytics Evidence',
            value: '⚠️ *No analytics telemetry screen recording attached to this payout.*',
            inline: false
          });
        }

        if (payout.disbursements?.length > 0) {
          const disDetails = payout.disbursements
            .map((d) => `• [${d.status}] Provider: \`${d.provider}\` | Ref: \`${d.providerReference || 'None'}\``)
            .join('\n');
          embed.addFields({ name: 'Disbursement Records', value: disDetails, inline: false });
        }

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (subcommand === 'approve') {
        // Strictly requires PAYOUT_APPROVE (ADMIN role only)
        assertAdminPermission(interaction, AdminPermission.PAYOUT_APPROVE);
        const payoutId = interaction.options.getString('payout_id');

        const updated = await adminPayoutService.approvePayout(payoutId, actor);

        await interaction.reply({
          content: `✅ Payout request \`${updated.id}\` has been **APPROVED** and is ready for disbursement.`,
          ephemeral: true
        });
        return;
      }

      if (subcommand === 'reject') {
        // Strictly requires PAYOUT_REJECT (ADMIN role only)
        assertAdminPermission(interaction, AdminPermission.PAYOUT_REJECT);
        const payoutId = interaction.options.getString('payout_id');
        const reason = interaction.options.getString('reason');

        const updated = await adminPayoutService.rejectPayout(payoutId, actor, reason);

        await interaction.reply({
          content: `🚫 Payout request \`${updated.id}\` has been **REJECTED** and reserved funds have been released back to creator balance.`,
          ephemeral: true
        });
        return;
      }

      if (subcommand === 'process') {
        // Strictly requires PAYOUT_PROCESS (ADMIN role only)
        assertAdminPermission(interaction, AdminPermission.PAYOUT_PROCESS);
        const payoutId = interaction.options.getString('payout_id');

        const result = await adminPayoutService.processDisbursement(payoutId, actor, 'MANUAL');

        await interaction.reply({
          content: `💸 Disbursement initiated for payout \`${payoutId}\`.\nProvider Reference: \`${result.disbursement.providerReference}\`\nStatus: \`${result.payoutRequest.status}\``,
          ephemeral: true
        });
        return;
      }

      if (subcommand === 'accept-evidence') {
        assertAdminPermission(interaction, AdminPermission.PAYOUT_APPROVE);
        const payoutId = interaction.options.getString('payout_id');
        const payout = await adminPayoutService.getPayoutDetails(payoutId);
        if (!payout) {
          await interaction.reply({ content: '⚠️ Payout request not found.', ephemeral: true });
          return;
        }

        const latestEvidence = payout.evidence?.[0];
        if (!latestEvidence) {
          await interaction.reply({ content: '⚠️ No evidence attached to this payout request.', ephemeral: true });
          return;
        }

        const updated = await adminPayoutService.acceptEvidence(latestEvidence.id, actor);
        await interaction.reply({
          content: `✅ Evidence **v${updated.version}** for payout \`${payoutId}\` has been **ACCEPTED** by <@${interaction.user.id}>. Payout can now proceed to approval/disbursement.`,
          ephemeral: true
        });
        return;
      }

      if (subcommand === 'reject-evidence') {
        assertAdminPermission(interaction, AdminPermission.PAYOUT_REJECT);
        const payoutId = interaction.options.getString('payout_id');
        const reason = interaction.options.getString('reason');
        const notes = interaction.options.getString('notes') || null;

        const payout = await adminPayoutService.getPayoutDetails(payoutId);
        if (!payout) {
          await interaction.reply({ content: '⚠️ Payout request not found.', ephemeral: true });
          return;
        }

        const latestEvidence = payout.evidence?.[0];
        if (!latestEvidence) {
          await interaction.reply({ content: '⚠️ No evidence attached to this payout request.', ephemeral: true });
          return;
        }

        const updated = await adminPayoutService.rejectEvidence(latestEvidence.id, actor, {
          structuredReason: reason,
          notes
        });
        await interaction.reply({
          content: `🚫 Evidence **v${updated.version}** for payout \`${payoutId}\` has been **REJECTED**.\n**Reason:** \`${updated.rejectionReason}\`${notes ? `\n**Notes:** ${notes}` : ''}`,
          ephemeral: true
        });
        return;
      }

      if (subcommand === 'view-evidence') {
        assertAdminPermission(interaction, AdminPermission.PAYOUT_VIEW);
        const payoutId = interaction.options.getString('payout_id');
        const reqVersion = interaction.options.getInteger('version');

        const payout = await adminPayoutService.getPayoutDetails(payoutId);
        if (!payout) {
          await interaction.reply({ content: '⚠️ Payout request not found.', ephemeral: true });
          return;
        }

        const evidenceList = [...(payout.evidence || [])].sort((a, b) => (b.version || 0) - (a.version || 0));
        if (evidenceList.length === 0) {
          await interaction.reply({ content: '⚠️ No evidence attached to this payout request.', ephemeral: true });
          return;
        }

        const targetEv = reqVersion != null
          ? evidenceList.find((e) => e.version === reqVersion) || null
          : evidenceList[0];

        if (!targetEv) {
          await interaction.reply({ content: `⚠️ Evidence version \`v${reqVersion}\` not found for this payout request.`, ephemeral: true });
          return;
        }

        await interaction.deferReply({ ephemeral: true });

        const files = [];
        let fileError = null;
        if (targetEv.storageKey) {
          try {
            const buffer = await storageService.getFileBuffer(targetEv.storageKey);
            if (buffer && buffer.length > 0) {
              if (buffer.length <= 25 * 1024 * 1024) {
                const ext = path.extname(targetEv.filename || '') || '.mp4';
                const safeName = `evidence_${payout.id.substring(0, 8)}_v${targetEv.version || 1}${ext}`;
                files.push(new AttachmentBuilder(buffer, { name: safeName }));
              } else {
                fileError = 'Video file exceeds Discord 25MB attachment limit';
              }
            } else {
              fileError = 'Video file buffer is empty on disk';
            }
          } catch (err) {
            fileError = `Storage read error: ${err.message}`;
          }
        }

        const embed = buildStaffEvidenceReviewEmbed(payout, targetEv, {
          fileError,
          hasAttachment: files.length > 0,
          totalVersions: evidenceList.length
        });

        await interaction.editReply({ embeds: [embed], files });
        return;
      }
    }

    // 5. SUBMISSION COMMANDS (Phase 10B)
    if (group === 'submission') {
      if (subcommand === 'view') {
        assertAdminPermission(interaction, AdminPermission.SUBMISSION_VIEW);
        const submissionId = interaction.options.getString('submission_id');
        const sub = await adminSubmissionService.getSubmissionDetails(submissionId, { isStaff: true });

        const emoji = { YOUTUBE: '▶️', TIKTOK: '🎵', INSTAGRAM: '📸', FACEBOOK: '📘' }[sub.platform] || '🎬';
        const req = sub.requirementsSnapshot || {};
        const minDur = req.minClipDurationSeconds ?? sub.campaign?.minClipDurationSeconds ?? 7;
        const maxDur = req.maxClipDurationSeconds ?? sub.campaign?.maxClipDurationSeconds ?? 120;
        const allowed = (req.allowedPlatforms || ['YouTube']).join(', ');

        const latestVer = sub.verifications?.[0];
        const earningsTotal = (sub.earnings || []).reduce(
          (acc, e) => acc.plus(new Prisma.Decimal(e.grossAmount?.toString() || '0')),
          new Prisma.Decimal('0.00')
        );

        let durStr = 'Pending Check';
        if (sub.durationSeconds != null) {
          durStr = `${sub.durationSeconds}s (${sub.durationStatus || 'AVAILABLE'})`;
        } else if (sub.durationStatus) {
          durStr = `${sub.durationStatus}`;
        }

        let retStr = 'Not Required';
        if (sub.retentionRequired) {
          retStr = `Status: **${sub.retentionStatus}** (${sub.retentionDays || req.retentionDays || 0} days)`;
          if (sub.retentionDeadline) {
            retStr += `\nDeadline: <t:${Math.floor(new Date(sub.retentionDeadline).getTime() / 1000)}:f>`;
          }
          if (sub.retentionViolatedAt) {
            retStr += `\nViolated: <t:${Math.floor(new Date(sub.retentionViolatedAt).getTime() / 1000)}:R>`;
            if (sub.retentionViolationReason) retStr += ` (${sub.retentionViolationReason})`;
          }
        }

        const embed = new EmbedBuilder()
          .setTitle(`🎬 Submission Details: ${sub.id.slice(0, 8)}`)
          .setColor(0x5865f2)
          .addFields(
            { name: '👤 Creator', value: `${sub.user?.username || 'Unknown'} (\`${sub.user?.discordId || sub.userId}\`)`, inline: true },
            { name: '📢 Campaign', value: `${sub.campaign?.name || 'Campaign'} (\`${sub.campaignId.slice(0, 8)}\`)`, inline: true },
            { name: '📱 Platform', value: `${emoji} **${sub.platform}**`, inline: true },
            { name: '🔗 Video URL', value: `[Link](${sub.url})`, inline: false },
            { name: '⏱️ Duration State', value: durStr, inline: true },
            { name: '📋 Campaign Rules', value: `Platforms: ${allowed}\nDuration: ${minDur}s–${maxDur}s\nCPM: $${Number(req.payRate ?? sub.campaign?.payRate ?? 0).toFixed(2)}`, inline: true },
            { name: '🛡️ Retention State', value: retStr, inline: false },
            {
              name: '🔍 Verification & Risk',
              value: latestVer
                ? `Status: **${latestVer.status}**\nRisk Level: **${latestVer.riskLevel || 'N/A'}** (Score: ${latestVer.score ?? 'N/A'})\nSignals: ${latestVer.signals?.length || 0}`
                : 'No verifications recorded',
              inline: true
            },
            {
              name: '💰 Earnings Linkage',
              value: `Ledger Rows: ${(sub.earnings || []).length}\nTotal Credited: **$${earningsTotal.toFixed(2)}**`,
              inline: true
            }
          )
          .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }
    }

    // 6. AUDIT COMMAND
    if (group === 'audit') {
      if (subcommand === 'list') {
        assertAdminPermission(interaction, AdminPermission.AUDIT_VIEW);
        const entityType = interaction.options.getString('entity_type') || undefined;
        const entityId = interaction.options.getString('entity_id') || undefined;
        const page = interaction.options.getInteger('page') || 1;

        const result = await adminAuditService.getAuditTrail({ entityType, entityId, page });

        const embed = new EmbedBuilder()
          .setTitle('🛡️ Administrative Audit Trail (Append-Only)')
          .setColor(0x5865f2)
          .setDescription(
            result.items.length === 0
              ? 'No audit events found.'
              : result.items
                  .map(
                    (ev) =>
                      `• **${ev.action}** on \`${ev.entityType}:${ev.entityId}\`\n  Actor: \`${ev.actorDiscordId}\` | Time: <t:${Math.floor(new Date(ev.createdAt).getTime() / 1000)}:R>${ev.reason ? `\n  Reason: *${ev.reason}*` : ''}`
                  )
                  .join('\n\n')
          )
          .setFooter({ text: `Page ${result.page} of ${result.totalPages} • Total: ${result.total}` });

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }
    }
  } catch (error) {
    logger.error({ err: error, group, subcommand, actorDiscordId: interaction.user.id }, 'Error executing admin command');
    let userMessage;
    if (error.name === 'ZodError' || Array.isArray(error.issues)) {
      const issues = error.issues || [];
      const details = issues.length > 0
        ? issues.map((issue) => {
            const field = issue.path && issue.path.length > 0 ? issue.path.join('.') : 'argument';
            return `• **${field}**: ${issue.message}`;
          }).join('\n')
        : error.message;
      userMessage = `⚠️ **Validation Error:**\n${details}`;
    } else {
      userMessage = formatError(error).userMessage;
    }

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: userMessage, ephemeral: true });
    } else {
      await interaction.reply({ content: userMessage, ephemeral: true });
    }
  }
}
