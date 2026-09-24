import { EmbedBuilder } from 'discord.js';
import { Prisma } from '@prisma/client';

const BRAND_COLOR = 0x5865F2;      // Discord Blurple
const SUCCESS_COLOR = 0x57F287;    // Green
const DANGER_COLOR = 0xED4245;     // Red
const WARNING_COLOR = 0xFEE75C;    // Yellow
const COMPLETED_COLOR = 0xEB459E;  // Pink/Magenta — budget fulfilled

/**
 * Format a Decimal or number as a currency string (e.g. "$1,234.56")
 * @param {Prisma.Decimal|number|string|null} value
 * @returns {string}
 */
function formatMoney(value) {
  if (value == null) return '$0.00';
  return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Build a visual fulfillment bar for a campaign
 * @param {number} percent - 0 to 100
 * @returns {string} e.g. "▓▓▓▓▓░░░░░ 50%"
 */
export function buildFulfillmentBar(percent) {
  const total = 10;
  const filled = Math.round(Math.min(100, Math.max(0, percent)) / 10);
  const empty = total - filled;
  return `${'▓'.repeat(filled)}${'░'.repeat(empty)} ${Number(percent).toFixed(1)}%`;
}

/**
 * Get status display info for a campaign
 * @param {object} campaign
 * @returns {{ badge: string, color: number }}
 */
function getCampaignStatusDisplay(campaign) {
  switch (campaign.status) {
    case 'COMPLETED':
      return { badge: '🔴 Budget Fulfilled', color: COMPLETED_COLOR };
    case 'ACTIVE':
      return { badge: '🟢 Active', color: SUCCESS_COLOR };
    case 'PAUSED':
      return { badge: '⏸️ Paused', color: WARNING_COLOR };
    case 'ENDED':
      return { badge: '⛔ Ended', color: DANGER_COLOR };
    case 'DRAFT':
      return { badge: '📝 Draft', color: BRAND_COLOR };
    case 'ARCHIVED':
      return { badge: '📦 Archived', color: BRAND_COLOR };
    default:
      return { badge: campaign.status, color: BRAND_COLOR };
  }
}

/**
 * Build embed listing active campaigns (Phase 10A: includes budget, CPM, fulfillment)
 * @param {Array<object>} campaigns
 * @param {Array<object>} userMemberships
 * @returns {EmbedBuilder}
 */
export function buildCampaignListEmbed(campaigns, userMemberships = []) {
  const activeJoinedIds = new Set(
    userMemberships
      .filter((m) => m.status === 'ACTIVE')
      .map((m) => m.campaignId)
  );

  const embed = new EmbedBuilder()
    .setTitle('🎬 Active Clipping Campaigns')
    .setDescription(
      campaigns.length === 0
        ? 'No active campaigns are currently available. Check back soon!'
        : 'Browse active campaigns below. Select a campaign from the menu to view full guidelines and join.'
    )
    .setColor(BRAND_COLOR)
    .setTimestamp();

  if (campaigns.length > 0) {
    campaigns.slice(0, 10).forEach((camp, index) => {
      const isJoined = activeJoinedIds.has(camp.id);
      const membershipBadge = isJoined ? '🟢 **Joined**' : '⚪ Not Joined';

      const req = camp.requirements || {};
      const platforms = Array.isArray(req.allowedPlatforms) && req.allowedPlatforms.length > 0
        ? req.allowedPlatforms.map((p) => `\`${p.toUpperCase()}\``).join(', ')
        : 'Any';

      const fulfillment = camp.fulfillmentPercent != null
        ? `${Number(camp.fulfillmentPercent).toFixed(1)}%`
        : '—';

      const { badge: statusBadge } = getCampaignStatusDisplay(camp);

      embed.addFields({
        name: `${index + 1}. ${camp.name}`,
        value: [
          `**Client:** ${camp.clientName}`,
          `**CPM:** ${formatMoney(camp.payRate)} / 1k views`,
          `**Budget:** ${formatMoney(camp.remainingBudget)} remaining / ${formatMoney(camp.totalBudget)} total`,
          `**Fulfillment:** ${fulfillment}`,
          `**Platforms:** ${platforms}`,
          `**Status:** ${statusBadge} ${membershipBadge}`
        ].join('\n'),
        inline: false
      });
    });
  }

  return embed;
}

/**
 * Build detailed embed for a specific campaign (Phase 10A: full budget + policy display)
 * @param {object} campaign
 * @param {object|null} membership
 * @returns {EmbedBuilder}
 */
export function buildCampaignDetailEmbed(campaign, membership = null) {
  const isJoined = membership?.status === 'ACTIVE';
  const req = campaign.requirements || {};
  const { badge: statusBadge, color } = getCampaignStatusDisplay(campaign);

  const platforms = Array.isArray(req.allowedPlatforms) && req.allowedPlatforms.length > 0
    ? req.allowedPlatforms.map((p) => `\`${p.toUpperCase()}\``).join(', ')
    : 'All platforms';

  // Clip duration — use first-class columns (Phase 10A), fall back to requirements JSON for legacy
  const minDur = campaign.minClipDurationSeconds ?? req.minClipDuration ?? 7;
  const maxDur = campaign.maxClipDurationSeconds ?? req.maxClipDuration ?? 120;
  const clipDuration = `${minDur}s – ${maxDur}s`;

  // Retention
  const retentionText = campaign.retentionRequired
    ? `${campaign.retentionDays ?? '?'} days required`
    : 'Not required';

  // Budget
  const totalBudget = campaign.totalBudget != null ? new Prisma.Decimal(campaign.totalBudget.toString()) : null;
  const remainingBudget = campaign.remainingBudget != null ? new Prisma.Decimal(campaign.remainingBudget.toString()) : null;
  const fulfillmentPct = campaign.fulfillmentPercent != null ? Number(campaign.fulfillmentPercent) : 0;
  const fulfillmentBar = totalBudget ? buildFulfillmentBar(fulfillmentPct) : '—';

  const rulesText = Array.isArray(req.rules)
    ? req.rules.map((r) => `• ${r}`).join('\n')
    : req.rules || 'Standard agency guidelines apply.';

  // Completed warning
  const completedWarning = campaign.status === 'COMPLETED'
    ? '\n\n🔴 **This campaign has reached its total budget and is now closed to new submissions.**'
    : '';

  const embed = new EmbedBuilder()
    .setTitle(`📢 ${campaign.name}`)
    .setDescription(`${campaign.description}${completedWarning}`)
    .setColor(isJoined ? SUCCESS_COLOR : color)
    .addFields(
      { name: '🏢 Client', value: campaign.clientName, inline: true },
      { name: '💰 CPM', value: `${formatMoney(campaign.payRate)} / 1k eligible views`, inline: true },
      { name: '🏆 Status', value: statusBadge, inline: true },
      {
        name: '💵 Campaign Budget',
        value: [
          `**Total:** ${totalBudget ? formatMoney(totalBudget) : '—'}`,
          `**Remaining:** ${remainingBudget ? formatMoney(remainingBudget) : '—'}`,
          fulfillmentBar
        ].join('\n'),
        inline: false
      },
      { name: '👤 Creator Earning Cap', value: formatMoney(campaign.creatorEarningCap), inline: true },
      { name: '💵 Min Payout', value: formatMoney(campaign.minimumPayout), inline: true },
      {
        name: '📅 Active Window',
        value: `<t:${Math.floor(new Date(campaign.startsAt).getTime() / 1000)}:D> to <t:${Math.floor(new Date(campaign.endsAt).getTime() / 1000)}:D>`,
        inline: false
      },
      { name: '📱 Allowed Platforms', value: platforms, inline: true },
      { name: '⏱️ Clip Duration', value: clipDuration, inline: true },
      { name: '📌 Retention', value: retentionText, inline: true },
      { name: '👤 Your Membership', value: isJoined ? '✅ **Active Member**' : '❌ Not Joined', inline: true },
      { name: '📜 Campaign Rules', value: rulesText.slice(0, 1024), inline: false }
    )
    .setTimestamp();

  if (req.contentGuidelines) {
    embed.addFields({ name: '🎯 Content Guidelines', value: req.contentGuidelines.slice(0, 1024), inline: false });
  }

  return embed;
}

/**
 * Build embed confirming joining a campaign
 * @param {object} campaign
 * @returns {EmbedBuilder}
 */
export function buildJoinSuccessEmbed(campaign) {
  return new EmbedBuilder()
    .setTitle('🎉 Campaign Joined!')
    .setDescription(`You are now actively participating in **${campaign.name}**!`)
    .setColor(SUCCESS_COLOR)
    .addFields(
      { name: 'Client', value: campaign.clientName, inline: true },
      { name: 'CPM', value: `${formatMoney(campaign.payRate)} / 1k views`, inline: true },
      { name: 'Creator Cap', value: formatMoney(campaign.creatorEarningCap), inline: true }
    )
    .setFooter({ text: 'You can view active campaigns anytime via /campaigns' })
    .setTimestamp();
}

/**
 * Build embed confirming leaving a campaign
 * @param {object} campaign
 * @returns {EmbedBuilder}
 */
export function buildLeaveSuccessEmbed(campaign) {
  return new EmbedBuilder()
    .setTitle('👋 Left Campaign')
    .setDescription(`You have left **${campaign.name}**. Historical clip submissions and records are preserved.`)
    .setColor(DANGER_COLOR)
    .setTimestamp();
}
