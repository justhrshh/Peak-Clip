import { EmbedBuilder } from 'discord.js';
import { maskWalletAddress } from '../../modules/payout-profile/payout-profile.service.js';
import { toCreatorSafeStatus } from '../../modules/statistics/statistics.service.js';
import { buildFulfillmentBar } from './campaign.embeds.js';

const BRAND_COLOR = 0x5865F2; // Discord Blurple
const SUCCESS_COLOR = 0x57F287; // Green
const WARNING_COLOR = 0xFEE75C; // Yellow
const DANGER_COLOR = 0xED4245; // Red

/**
 * Build primary Creator Center Dashboard Embed
 *
 * @param {object} data
 * @param {string} data.availableBalance
 * @param {number} data.activeClipsCount
 * @param {number} data.approvedClipsCount
 * @param {number} data.underReviewClipsCount
 * @param {bigint|number} data.totalViews
 * @param {bigint|number} data.eligibleViews
 * @param {object|null} data.activePayout - { amount, status, id }
 * @param {string} [data.currency='USD']
 * @param {import('discord.js').User} discordUser
 * @returns {EmbedBuilder}
 */
export function buildCreatorDashboardEmbed(data, discordUser) {
  const username = discordUser?.username || 'Creator';
  const balance = Number(data.availableBalance || 0).toFixed(2);
  const currency = data.currency || 'USD';

  const activePayoutText = data.activePayout
    ? `**$${Number(data.activePayout.amount).toFixed(2)}** (\`${data.activePayout.status}\`)`
    : '*None*';

  const warningBanner = (data.earlyDeletionAlert || data.hasRetentionViolation)
    ? `\n\n⚠️ **WARNING: Video Removed Before 30 Days**\nA submitted video was removed or made private before completing the required 30-day retention period. A penalty adjustment has been recorded.`
    : '';

  const embed = new EmbedBuilder()
    .setTitle('🎬 PEAK CLIP — CREATOR CENTER')
    .setDescription(
      `Welcome, **@${username}**!\n` +
      `Manage your campaigns, track clip performance, and request verified payouts below.${warningBanner}`
    )
    .setColor((data.earlyDeletionAlert || data.hasRetentionViolation) ? DANGER_COLOR : BRAND_COLOR)
    .addFields(
      {
        name: '💰 Available Balance',
        value: `**$${balance} ${currency}**`,
        inline: true
      },
      {
        name: '🎬 Active Clips',
        value: `**${data.activeClipsCount || 0}** clips\n*(✅ ${data.approvedClipsCount || 0} approved | 🔍 ${data.underReviewClipsCount || 0} review)*`,
        inline: true
      },
      {
        name: '👁️ Total Views',
        value: `**${Number(data.totalViews || 0).toLocaleString('en-US')}** views\n*(Eligible: **${Number(data.eligibleViews || 0).toLocaleString('en-US')}**)*`,
        inline: true
      },
      {
        name: '📋 Active Payout',
        value: activePayoutText,
        inline: true
      }
    );

  if (Array.isArray(data.campaigns) && data.campaigns.length > 0) {
    const campaignLines = data.campaigns.map((c) => {
      const bar = buildFulfillmentBar(c.fulfillmentPercent);
      const isJoinedBadge = c.isMember ? ' *(Joined)*' : '';
      return (
        `• **${c.name}**${isJoinedBadge}\n` +
        `  Consumed: **$${Number(c.consumedBudget || 0).toFixed(2)}** / $${Number(c.totalBudget || 0).toFixed(2)} (**${Number(c.fulfillmentPercent || 0).toFixed(2)}%**)\n` +
        `  \`${bar}\` • Remaining: **$${Number(c.remainingBudget || 0).toFixed(2)}**`
      );
    }).join('\n\n');

    embed.addFields({
      name: '🎯 Campaign Consumed Budget (Live)',
      value: campaignLines.slice(0, 1024),
      inline: false
    });
  } else if (data.campaigns !== undefined) {
    embed.addFields({
      name: '🎯 Campaign Consumed Budget',
      value: '*No active campaigns joined yet. Use [ 🎯 Campaigns ] below to join!*',
      inline: false
    });
  }

  const footerText = data.isRefresh
    ? `Peak Clip Creator Center • Live Refreshed (${new Date().toLocaleTimeString('en-US', { hour12: false })})`
    : 'Peak Clip Creator Center • Button Navigation';

  embed
    .setFooter({ text: footerText })
    .setTimestamp();

  return embed;
}

/**
 * Build Creator Profile Embed
 *
 * @param {object} user - Domain user object
 * @param {object|null} profile - PayoutProfile object
 * @param {object} stats - User stats summary
 * @param {import('discord.js').User} discordUser
 * @returns {EmbedBuilder}
 */
export function buildCreatorProfileEmbed(user, profile, stats, discordUser) {
  const username = discordUser?.username || user.username || 'Creator';
  const joinedDate = user.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'N/A';

  const profileStatus = profile
    ? `✅ Configured\n` +
      `**Network:** \`${profile.network}\`\n` +
      `**Wallet:** \`${maskWalletAddress(profile.walletAddress)}\`\n` +
      `**Handle:** \`${profile.creatorHandle || 'N/A'}\`\n` +
      `**Platform:** \`${profile.platform || 'YOUTUBE'}\``
    : '⚠️ *Not configured. Use [ Set Up Payout Profile ] below.*';

  const embed = new EmbedBuilder()
    .setTitle(`👤 Creator Profile — @${username}`)
    .setDescription('Review your account credentials and payment destination settings.')
    .setColor(BRAND_COLOR)
    .addFields(
      {
        name: '📋 Account Status',
        value: `Status: **${user.status || 'ACTIVE'}**\nMember Since: **${joinedDate}**`,
        inline: true
      },
      {
        name: '🎯 Active Campaigns',
        value: `**${stats?.activeCampaignsCount || 0}** joined`,
        inline: true
      },
      {
        name: '💳 Payout Destination',
        value: profileStatus,
        inline: false
      }
    )
    .setFooter({ text: 'Peak Clip Security • Public Wallet Only' })
    .setTimestamp();

  return embed;
}

/**
 * Build Staff Control Center Dashboard Embed
 *
 * @param {object} metrics
 * @param {import('discord.js').User} discordUser
 * @returns {EmbedBuilder}
 */
export function buildAdminControlCenterEmbed(metrics, discordUser) {
  const embed = new EmbedBuilder()
    .setTitle('🛡️ PEAK CLIP — CONTROL CENTER')
    .setDescription(
      `Operational command plane for staff and campaign administrators.\n` +
      `Staff Actor: <@${discordUser?.id || 'STAFF'}>`
    )
    .setColor(0xe74c3c)
    .addFields(
      {
        name: '🎬 CLIP OPERATIONS',
        value:
          `• 📋 **Pending Review:** **${metrics.pendingReviewCount ?? metrics.reviewQueueCount ?? 0}** clips\n` +
          `• ⚠️ **Suspicious Clips:** **${metrics.suspiciousClipsCount ?? 0}** clips\n` +
          `• 📡 **Active Tracking:** **${metrics.trackingCount ?? 0}** clips\n` +
          `• 🚨 **Deletion Alerts:** **${metrics.deletionAlertsCount ?? 0}** alerts\n` +
          `• 🛡️ **30-Day Monitoring:** **${metrics.retentionMonitoringCount ?? 0}** active`,
        inline: false
      },
      {
        name: '💰 PAYOUTS',
        value: `• 💸 **Pending Payouts:** **${metrics.payoutQueueCount || 0}** requests pending review`,
        inline: true
      },
      {
        name: '👥 CREATOR ISSUES',
        value: `• ⚠️ **Attention Required:** **${metrics.creatorsRequiringAttention ?? 0}** creators\n*(Total: **${metrics.totalCreatorsCount || 0}** creators)*`,
        inline: true
      },
      {
        name: '⚙️ CAMPAIGNS & HEALTH',
        value: `• 🎯 **Active Campaigns:** **${metrics.activeCampaignsCount || 0}** live\n• ⚙️ **Health:** \`${metrics.systemStatus || 'OPERATIONAL'}\``,
        inline: false
      }
    )
    .setFooter({ text: 'Peak Clip Staff Operations • Zero-Trust Role Enforced' })
    .setTimestamp();

  return embed;
}

/**
 * Build Payout Request Wizard Embed
 *
 * @param {number} step - Step number (1 to 4)
 * @param {object} data
 * @returns {EmbedBuilder}
 */
export function buildPayoutWizardEmbed(step, data) {
  const embed = new EmbedBuilder().setColor(BRAND_COLOR).setTimestamp();

  switch (step) {
    case 1:
      embed
        .setTitle('💸 Payout Wizard — Step 1: Amount')
        .setDescription(
          `Your Available Balance: **$${Number(data.availableBalance || 0).toFixed(2)} ${data.currency || 'USD'}**\n` +
          `Minimum Payout: **$${Number(data.minimumPayout || 10).toFixed(2)} ${data.currency || 'USD'}**\n\n` +
          `Click **[ 💵 Enter Amount ]** below to specify how much you would like to withdraw.`
        );
      break;

    case 2:
      embed
        .setTitle('💸 Payout Wizard — Step 2: Confirm Payout Destination')
        .setDescription(
          `Requested Amount: **$${Number(data.amount).toFixed(2)} ${data.currency || 'USD'}**\n\n` +
          `**Payment Destination:**\n` +
          `• **Network:** \`${data.profile?.network || 'N/A'}\`\n` +
          `• **Wallet Address:** \`${maskWalletAddress(data.profile?.walletAddress)}\`\n` +
          `• **Creator Handle:** \`${data.profile?.creatorHandle || 'N/A'}\`\n\n` +
          `*Please confirm this destination matches your current wallet before continuing.*`
        );
      break;

    case 3:
      embed
        .setTitle('💸 Payout Wizard — Step 3: Verification Evidence')
        .setDescription(
          `To protect against fraud, payouts require a short screen recording of your creator analytics.\n\n` +
          `**Requirements:**\n` +
          `• Format: **MP4**, **WebM**, or **MOV**\n` +
          `• Duration: **Must be strictly under 40 seconds (< 40.0s)**\n` +
          `• Content: Must clearly show video URL and analytics dashboard\n\n` +
          `*Upload your recording or confirm evidence readiness below.*`
        );
      break;

    case 4:
      embed
        .setTitle('💸 CONFIRM PAYOUT REQUEST')
        .setDescription(
          `Please review the details below before submitting your payout request:\n\n` +
          `• **Amount:** **$${Number(data.amount).toFixed(2)} ${data.currency || 'USD'}**\n` +
          `• **Network:** \`${data.profile?.network || 'N/A'}\`\n` +
          `• **Wallet:** \`${maskWalletAddress(data.profile?.walletAddress)}\`\n` +
          `• **Evidence:** \`Ready / Attached\`\n\n` +
          `*Once submitted, this amount will be actively reserved from your available balance while staff reviews the request.*`
        )
        .setColor(SUCCESS_COLOR);
      break;

    default:
      embed.setTitle('💸 Payout Wizard').setDescription('Processing payout request...');
  }

  return embed;
}

/**
 * Build Paginated Creator Clips List Embed
 *
 * @param {Array<object>} clips
 * @param {number} page
 * @param {number} totalPages
 * @param {import('discord.js').User} discordUser
 * @returns {EmbedBuilder}
 */
export function buildCreatorClipsListEmbed(clips, page, totalPages, discordUser) {
  const username = discordUser?.username || 'Creator';
  const embed = new EmbedBuilder()
    .setTitle(`🎬 My Clips — Page ${page}/${totalPages || 1}`)
    .setDescription(`All clips submitted by **@${username}**. Select a clip to inspect details.`)
    .setColor(BRAND_COLOR)
    .setFooter({ text: `Page ${page} of ${totalPages || 1} • Safe Status View` })
    .setTimestamp();

  if (!clips || clips.length === 0) {
    embed.addFields({
      name: 'No Clips Found',
      value: 'You have not submitted any clips yet. Join a campaign and submit your first clip!'
    });
    return embed;
  }

  for (const clip of clips) {
    const safeStatus = toCreatorSafeStatus(clip.status);
    let statusEmoji = '⏳';
    if (safeStatus === 'APPROVED') statusEmoji = '✅';
    else if (safeStatus === 'UNDER REVIEW') statusEmoji = '🔍';
    else if (safeStatus === 'REJECTED') statusEmoji = '❌';

    const retentionText = clip.retentionRequired
      ? ` | Retention: \`${clip.retentionStatus || 'PENDING'}\``
      : '';

    const campaignName = clip.campaignName || clip.campaign?.name || 'Campaign';
    const displayUrl = clip.normalizedUrl || clip.url || '';
    const viewsVal = clip.views !== undefined && clip.views !== null
      ? clip.views
      : (clip.latestViews !== undefined && clip.latestViews !== null ? clip.latestViews : 0);
    const eligibleVal = clip.eligibleViews !== undefined && clip.eligibleViews !== null ? clip.eligibleViews : 0;
    const earnedVal = clip.grossEarnings !== undefined && clip.grossEarnings !== null
      ? clip.grossEarnings
      : (clip.totalEarned || '0.00');

    embed.addFields({
      name: `${statusEmoji} ${clip.platform || 'Clip'} • ${campaignName}`,
      value:
        `URL: [${displayUrl.slice(0, 45)}...](${displayUrl})\n` +
        `Status: **\`${safeStatus}\`**${retentionText}\n` +
        `Views: **${Number(viewsVal).toLocaleString()}** (Eligible: **${Number(eligibleVal).toLocaleString()}**) | Earned: **$${Number(earnedVal).toFixed(2)}**`,
      inline: false
    });
  }

  return embed;
}

/**
 * Build Safe Creator Clip Detail Embed
 *
 * @param {object} clip
 * @param {import('discord.js').User} discordUser
 * @returns {EmbedBuilder}
 */
export function buildCreatorClipDetailEmbed(clip, discordUser) {
  const safeStatus = toCreatorSafeStatus(clip.status);
  let statusColor = BRAND_COLOR;
  let statusEmoji = '⏳';
  if (safeStatus === 'APPROVED') {
    statusColor = SUCCESS_COLOR;
    statusEmoji = '✅';
  } else if (safeStatus === 'UNDER REVIEW') {
    statusColor = WARNING_COLOR;
    statusEmoji = '🔍';
  } else if (safeStatus === 'REJECTED') {
    statusColor = DANGER_COLOR;
    statusEmoji = '❌';
  }

  const retentionDeadlineText = clip.retentionDeadline
    ? `\nDeadline: <t:${Math.floor(new Date(clip.retentionDeadline).getTime() / 1000)}:R>`
    : '';

  const retentionSection = clip.retentionRequired
    ? `Status: \`${clip.retentionStatus || 'ACTIVE'}\`${retentionDeadlineText}`
    : 'Not required for this campaign';

  const embed = new EmbedBuilder()
    .setTitle(`${statusEmoji} Clip Details — ${clip.platform || 'Clip'}`)
    .setDescription(`[View Original Video](${clip.url})\n**Campaign:** ${clip.campaignName || 'N/A'}`)
    .setColor(statusColor)
    .addFields(
      {
        name: '📋 Submission Status',
        value: `Safe Status: **\`${safeStatus}\`**\nSubmitted: <t:${Math.floor(new Date(clip.createdAt).getTime() / 1000)}:D>`,
        inline: true
      },
      {
        name: '🛡️ Retention Status',
        value: retentionSection,
        inline: true
      },
      {
        name: '📊 Performance & Financials',
        value:
          `Observed Views: **${Number(clip.views || 0).toLocaleString()}**\n` +
          `Eligible Views: **${Number(clip.eligibleViews || 0).toLocaleString()}**\n` +
          `Credited Earnings: **$${Number(clip.grossEarnings || 0).toFixed(2)}**`,
        inline: false
      }
    )
    .setFooter({ text: 'Peak Clip Creator View • Redacted Privacy Protection' })
    .setTimestamp();

  if (safeStatus === 'REJECTED' && clip.rejectionReason) {
    embed.addFields({
      name: '⚠️ Rejection Notice',
      value: `Reason: **${clip.rejectionReason}**` + (clip.adminNote ? `\nNote: *${clip.adminNote}*` : ''),
      inline: false
    });
  }

  return embed;
}

/**
 * Build persistent entry embed for CREATOR #dashboard channel
 * @returns {EmbedBuilder}
 */
export function buildCreatorDashboardChannelEmbed() {
  return new EmbedBuilder()
    .setTitle('🎬 PEAK CLIP — CREATOR CENTER')
    .setDescription(
      'Welcome to **Peak Clip**!\n\n' +
      'Use the buttons below to access your creator workspace. All views are private — only you can see your personal data.\n\n' +
      '**Getting Started:**\n' +
      '• Browse active campaigns and join one to start earning\n' +
      '• Submit your clip links after joining a campaign\n' +
      '• Track your views and earnings in real-time\n' +
      '• Request payouts when your balance is ready'
    )
    .setColor(BRAND_COLOR)
    .setTimestamp()
    .setFooter({ text: 'Peak Clip — Creator Platform • Personal dashboard data is private' });
}

/**
 * Build persistent entry embed for #campaigns channel
 * @returns {EmbedBuilder}
 */
export function buildCreatorCampaignsChannelEmbed() {
  return new EmbedBuilder()
    .setTitle('🎯 PEAK CLIP — CAMPAIGNS')
    .setDescription(
      'Browse active campaigns, review their requirements, and join campaigns that are currently accepting creators.'
    )
    .setColor(0x3498db)
    .setTimestamp()
    .setFooter({ text: 'Peak Clip — Campaigns • Public channel views are private' });
}

/**
 * Build persistent entry embed for #submissions channel
 * @returns {EmbedBuilder}
 */
export function buildCreatorSubmissionsChannelEmbed() {
  return new EmbedBuilder()
    .setTitle('🎬 PEAK CLIP — SUBMISSIONS')
    .setDescription(
      'Submit clips and review the status of your submitted content.'
    )
    .setColor(BRAND_COLOR)
    .setTimestamp()
    .setFooter({ text: 'Peak Clip — Submissions • Content is reviewed and verified' });
}

/**
 * Build persistent entry embed for #stats channel
 * @returns {EmbedBuilder}
 */
export function buildCreatorStatsChannelEmbed() {
  return new EmbedBuilder()
    .setTitle('📊 PEAK CLIP — STATS')
    .setDescription(
      'View your verified views, clip performance, campaigns, platforms, and channel breakdowns.'
    )
    .setColor(0x9b59b6)
    .setTimestamp()
    .setFooter({ text: 'Peak Clip — Analytics • Verification engine metrics' });
}

/**
 * Build persistent entry embed for #earnings channel
 * @returns {EmbedBuilder}
 */
export function buildCreatorEarningsChannelEmbed() {
  return new EmbedBuilder()
    .setTitle('💰 PEAK CLIP — EARNINGS')
    .setDescription(
      'Review your verified earnings, available balance, and campaign earnings history.'
    )
    .setColor(SUCCESS_COLOR)
    .setTimestamp()
    .setFooter({ text: 'Peak Clip — Financials • Double-entry ledger calculations' });
}

/**
 * Build persistent entry embed for #payouts channel
 * @returns {EmbedBuilder}
 */
export function buildCreatorPayoutsChannelEmbed() {
  return new EmbedBuilder()
    .setTitle('💸 PEAK CLIP — PAYOUTS')
    .setDescription(
      'Manage your payout profile, request payouts, and review payout history.'
    )
    .setColor(0x2ecc71)
    .setTimestamp()
    .setFooter({ text: 'Peak Clip — Payouts • Non-custodial secure disbursements' });
}
