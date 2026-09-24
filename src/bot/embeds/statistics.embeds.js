import { EmbedBuilder } from 'discord.js';
import { toCreatorSafeStatus } from '../../modules/statistics/statistics.service.js';

const BRAND_COLOR = 0x5865F2; // Discord Blurple
const SUCCESS_COLOR = 0x57F287; // Green
const WARNING_COLOR = 0xFEE75C; // Yellow
const DANGER_COLOR = 0xED4245; // Red

/**
 * Format metric aggregation with availability indicator
 * @param {object} metricObj
 * @returns {string}
 */
export function formatMetricCount(metricObj) {
  if (!metricObj || metricObj.availability === 'UNAVAILABLE' || metricObj.knownSum === null) {
    return '*Unavailable*';
  }

  const formattedSum = Number(metricObj.knownSum).toLocaleString();
  if (metricObj.availability === 'PARTIAL') {
    return `${formattedSum} *(Partial: ${metricObj.countWithMetric}/${metricObj.totalSubmissions} clips)*`;
  }

  return `**${formattedSum}**`;
}

/**
 * Format growth display with delta, percentage, and regression indicators
 * @param {object} growthObj
 * @returns {string}
 */
export function formatGrowthDisplay(growthObj) {
  if (!growthObj || growthObj.delta === null) {
    return growthObj?.notice || '*N/A (insufficient snapshots)*';
  }

  const deltaNum = Number(growthObj.delta);
  const sign = deltaNum > 0 ? '+' : '';
  const percentText = growthObj.growthPercent !== null ? ` (${growthObj.growthPercent > 0 ? '+' : ''}${growthObj.growthPercent}%)` : '';
  const regressionWarning = growthObj.isRegression ? ' ⚠️ *Metric Regression*' : '';

  return `${sign}${deltaNum.toLocaleString()}${percentText}${regressionWarning}`;
}

/**
 * Build embed for User Overview statistics
 * @param {object} overview
 * @param {import('discord.js').User} discordUser
 * @returns {EmbedBuilder}
 */
export function buildUserOverviewEmbed(overview, discordUser) {
  const embed = new EmbedBuilder()
    .setTitle('📊 My Clipping Performance Overview')
    .setDescription(`Aggregated performance and financial ledger overview for <@${discordUser.id}> across all joined campaigns.`)
    .setColor(BRAND_COLOR)
    .setTimestamp();

  // Authoritative Financials
  const fin = overview.financials || {};
  embed.addFields({
    name: '💵 Financial Ledger (Authoritative)',
    value:
      `💰 **Total Earned:** \`$${fin.totalEarned || '0.00'} ${fin.currency || 'USD'}\`\n` +
      `💳 **Available Balance:** \`$${fin.availableBalance || '0.00'} ${fin.currency || 'USD'}\`\n` +
      `🔒 **Reserved in Payouts:** \`$${fin.reservedBalance || '0.00'} ${fin.currency || 'USD'}\`\n` +
      `✅ **Completed Disbursements:** \`$${fin.completedPayouts || '0.00'} ${fin.currency || 'USD'}\``,
    inline: false
  });

  // Status breakdown
  embed.addFields({
    name: '🎬 Submissions Overview',
    value:
      `Total Clips: **${overview.totalSubmissions}**\n` +
      `✅ Approved: **${overview.approvedSubmissions}**\n` +
      `⏳ Under Review: **${(overview.underReviewSubmissions || 0) + (overview.pendingSubmissions || 0)}**\n` +
      `❌ Rejected: **${overview.rejectedSubmissions}**` +
      (overview.flaggedSubmissions > 0 ? `\n⚠️ Flagged: **${overview.flaggedSubmissions}**` : ''),
    inline: true
  });

  // Metric breakdown
  const eligibleViewsStr = overview.totalEligibleViews !== undefined && overview.totalEligibleViews !== null
    ? Number(overview.totalEligibleViews).toLocaleString()
    : '0';

  embed.addFields({
    name: '📈 Reach & Engagement Totals',
    value:
      `👁️ Observed Views: ${formatMetricCount(overview.totalViews)}\n` +
      `🎯 Eligible Views: **${eligibleViewsStr}**\n` +
      `❤️ Likes: ${formatMetricCount(overview.totalLikes)}\n` +
      `💬 Comments: ${formatMetricCount(overview.totalComments)}`,
    inline: true
  });

  // Campaigns breakdown
  embed.addFields({
    name: '🎯 Campaign Participation',
    value:
      `Active Campaigns: **${overview.activeCampaignsJoined}**\n` +
      `Total Joined: **${overview.totalCampaignsJoined}**`,
    inline: false
  });

  // Timestamp
  if (overview.lastUpdatedAt) {
    const unix = Math.floor(new Date(overview.lastUpdatedAt).getTime() / 1000);
    embed.addFields({
      name: '⏱️ Last Activity / Metric Update',
      value: `<t:${unix}:f> (<t:${unix}:R>)`,
      inline: false
    });
  } else {
    embed.addFields({
      name: '⏱️ Last Activity',
      value: '*No clips or metrics recorded yet.*',
      inline: false
    });
  }

  embed.setFooter({
    text: 'Note: Refresh re-reads database state. It does not fetch live social media metrics.'
  });

  return embed;
}

/**
 * Build embed for Creator Campaigns Breakdown
 * @param {object} campaignsData - { items, total, page, totalPages }
 * @param {import('discord.js').User} discordUser
 * @returns {EmbedBuilder}
 */
export function buildCreatorCampaignsEmbed(campaignsData, discordUser) {
  const { items, total, page, totalPages } = campaignsData;

  const embed = new EmbedBuilder()
    .setTitle('🎯 My Campaign Participation & Earnings')
    .setDescription(
      items.length === 0
        ? `You have not joined any campaigns yet, <@${discordUser.id}>. Use \`/campaigns\` to explore!`
        : `Showing campaigns joined by <@${discordUser.id}> (Page **${page}** of **${totalPages}**).`
    )
    .setColor(BRAND_COLOR)
    .setTimestamp();

  items.forEach((c) => {
    const statusEmoji = c.campaignStatus === 'ACTIVE' ? '🟢' : '⚪';
    embed.addFields({
      name: `${statusEmoji} ${c.campaignName} (\`${c.campaignStatus}\`)`,
      value:
        `• **Client:** ${c.clientName} | **CPM:** \`$${c.cpm}\`\n` +
        `• **Clips:** Total: \`${c.clips.total}\` | Approved: \`${c.clips.approved}\` | Review: \`${c.clips.underReview}\` | Rejected: \`${c.clips.rejected}\`\n` +
        `• **Views:** Observed: \`${Number(c.totalObservedViews).toLocaleString()}\` | Eligible: \`${Number(c.totalEligibleViews).toLocaleString()}\`\n` +
        `• **Earned:** \`$${c.totalEarned} ${c.currency}\` / Cap \`$${c.creatorEarningCap}\` (**${c.capConsumedPercent}%** used)\n` +
        `• **Joined:** <t:${Math.floor(new Date(c.joinedAt).getTime() / 1000)}:R>`,
      inline: false
    });
  });

  embed.setFooter({ text: `Page ${page} of ${totalPages} • Total Campaigns: ${total}` });
  return embed;
}

/**
 * Build embed for Creator Platform Breakdown
 * @param {Array<object>} platforms
 * @param {import('discord.js').User} discordUser
 * @returns {EmbedBuilder}
 */
export function buildCreatorPlatformsEmbed(platforms, discordUser) {
  const embed = new EmbedBuilder()
    .setTitle('📱 My Performance by Platform')
    .setDescription(`Clips, views, and ledgered earnings for <@${discordUser.id}> grouped by social platform.`)
    .setColor(BRAND_COLOR)
    .setTimestamp();

  platforms.forEach((p) => {
    let viewsDisplay = '*Unavailable*';
    if (p.observedViews?.sum !== null && p.observedViews?.sum !== undefined) {
      viewsDisplay = `**${Number(p.observedViews.sum).toLocaleString()}**`;
    } else if (p.clips.total === 0) {
      viewsDisplay = '`0` *(no clips)*';
    }

    embed.addFields({
      name: `🌐 ${p.platform}`,
      value:
        `• Clips: Total: **${p.clips.total}** | Approved: **${p.clips.approved}**\n` +
        `• Observed Views: ${viewsDisplay}\n` +
        `• Eligible Views: **${Number(p.eligibleViews).toLocaleString()}**\n` +
        `• Credited Earnings: \`$${p.totalEarnings}\``,
      inline: true
    });
  });

  return embed;
}

/**
 * Build embed for Creator Channel / Account Breakdown
 * @param {Array<object>} channels
 * @param {import('discord.js').User} discordUser
 * @returns {EmbedBuilder}
 */
export function buildCreatorChannelsEmbed(channels, discordUser) {
  const embed = new EmbedBuilder()
    .setTitle('📺 My Channels & Accounts')
    .setDescription(
      channels.length === 0
        ? `No channel or account data recorded yet for <@${discordUser.id}>.`
        : `Performance breakdown across observed channels and handles for <@${discordUser.id}>.`
    )
    .setColor(BRAND_COLOR)
    .setTimestamp();

  channels.forEach((ch) => {
    const viewsDisplay =
      ch.observedViews !== null && ch.observedViews !== undefined
        ? `**${Number(ch.observedViews).toLocaleString()}**`
        : '*Unavailable*';

    embed.addFields({
      name: `📡 ${ch.channelName} (${ch.platform})`,
      value:
        `• Clips: Total: **${ch.clips.total}** | Approved: **${ch.clips.approved}**\n` +
        `• Observed Views: ${viewsDisplay} | Eligible: **${Number(ch.eligibleViews).toLocaleString()}**\n` +
        `• Credited Earnings: \`$${ch.totalEarnings}\``,
      inline: false
    });
  });

  return embed;
}

/**
 * Build embed for Campaign Overview statistics (single campaign)
 * @param {object} campaignOverview
 * @param {import('discord.js').User} discordUser
 * @returns {EmbedBuilder}
 */
export function buildCampaignOverviewEmbed(campaignOverview, discordUser) {
  const embed = new EmbedBuilder()
    .setTitle(`📊 Campaign Statistics: ${campaignOverview.campaign.name}`)
    .setDescription(
      `Creator statistics for <@${discordUser.id}> in **${campaignOverview.campaign.name}** (${campaignOverview.campaign.clientName}).`
    )
    .setColor(BRAND_COLOR)
    .setTimestamp();

  // Status & Membership
  embed.addFields({
    name: '📋 Status & Membership',
    value:
      `Campaign Status: \`${campaignOverview.campaign.status}\`\n` +
      `Your Membership: \`${campaignOverview.membership.status}\` ` +
      (campaignOverview.membership.joinedAt
        ? `(Joined <t:${Math.floor(new Date(campaignOverview.membership.joinedAt).getTime() / 1000)}:R>)`
        : ''),
    inline: false
  });

  // Submissions breakdown
  embed.addFields({
    name: '🎬 Submissions',
    value:
      `Total: **${campaignOverview.totalSubmissions}**\n` +
      `✅ Approved: **${campaignOverview.approvedSubmissions}**\n` +
      `⏳ Pending: **${campaignOverview.pendingSubmissions}**\n` +
      `🔍 Under Review: **${campaignOverview.underReviewSubmissions}**\n` +
      `❌ Rejected: **${campaignOverview.rejectedSubmissions}**`,
    inline: true
  });

  // Engagement totals
  embed.addFields({
    name: '📈 Engagement Totals',
    value:
      `👁️ Views: ${formatMetricCount(campaignOverview.currentTotalViews)}\n` +
      `❤️ Likes: ${formatMetricCount(campaignOverview.currentTotalLikes)}\n` +
      `💬 Comments: ${formatMetricCount(campaignOverview.currentTotalComments)}\n` +
      `🔄 Shares: ${formatMetricCount(campaignOverview.currentTotalShares)}`,
    inline: true
  });

  // Best-performing submission
  const best = campaignOverview.bestPerformingSubmission;
  if (best) {
    embed.addFields({
      name: '🏆 Top Recorded Clip',
      value:
        `**${best.platform}** — [View Clip](${best.url})\n` +
        `Views: **${Number(best.views).toLocaleString()}** | Status: \`${toCreatorSafeStatus(best.status)}\``,
      inline: false
    });
  } else {
    embed.addFields({
      name: '🏆 Top Recorded Clip',
      value: '*No clip views recorded yet.*',
      inline: false
    });
  }

  // Timestamps
  if (campaignOverview.lastMetricUpdate) {
    const unix = Math.floor(new Date(campaignOverview.lastMetricUpdate).getTime() / 1000);
    embed.addFields({
      name: '⏱️ Last Metric Capture',
      value: `<t:${unix}:f> (<t:${unix}:R>)`,
      inline: false
    });
  }

  embed.setFooter({
    text: 'Note: Refresh re-reads database state. It does not fetch live social media metrics.'
  });

  return embed;
}

/**
 * Build embed for Individual Submission statistics
 * @param {object} stats
 * @param {import('discord.js').User} discordUser
 * @returns {EmbedBuilder}
 */
export function buildSubmissionStatisticsEmbed(stats, discordUser) {
  const safeStatus = toCreatorSafeStatus(stats.submission.status);
  let statusColor = BRAND_COLOR;
  if (safeStatus === 'APPROVED') statusColor = SUCCESS_COLOR;
  else if (safeStatus === 'UNDER REVIEW') statusColor = WARNING_COLOR;
  else if (safeStatus === 'REJECTED') statusColor = DANGER_COLOR;

  const retentionBadge = stats.submission.retentionRequired
    ? `\n**Retention:** \`${stats.submission.retentionStatus}\`` +
      (stats.submission.retentionDeadline ? ` (Deadline: <t:${Math.floor(new Date(stats.submission.retentionDeadline).getTime() / 1000)}:R>)` : '')
    : '';

  const embed = new EmbedBuilder()
    .setTitle(`🎬 Clip Analytics: ${stats.submission.platform}`)
    .setDescription(
      `[Original Video URL](${stats.submission.url})\n` +
      `**Campaign:** ${stats.campaign.name} (${stats.campaign.status})\n` +
      `**Status:** \`${safeStatus}\`` +
      retentionBadge +
      (stats.submission.rejectionReason ? `\n*Reason: ${stats.submission.rejectionReason}*` : '')
    )
    .setColor(statusColor)
    .setTimestamp();

  // Current metrics
  const m = stats.currentMetrics;
  embed.addFields({
    name: '📊 Current Metrics',
    value:
      `👁️ Views: ${m.views !== null ? `**${Number(m.views).toLocaleString()}**` : '*Unavailable*'}\n` +
      `❤️ Likes: ${m.likes !== null ? `**${Number(m.likes).toLocaleString()}**` : '*Unavailable*'}\n` +
      `💬 Comments: ${m.comments !== null ? `**${Number(m.comments).toLocaleString()}**` : '*Unavailable*'}\n` +
      `🔄 Shares: ${m.shares !== null ? `**${Number(m.shares).toLocaleString()}**` : '*Unavailable*'}`,
    inline: true
  });

  // Growth metrics
  const g = stats.growth;
  embed.addFields({
    name: '📈 Historical Growth',
    value:
      `Views: ${formatGrowthDisplay(g.views)}\n` +
      `Likes: ${formatGrowthDisplay(g.likes)}\n` +
      `Comments: ${formatGrowthDisplay(g.comments)}\n` +
      `Shares: ${formatGrowthDisplay(g.shares)}`,
    inline: true
  });

  // Authoritative financial earnings for this clip
  if (stats.financials) {
    embed.addFields({
      name: '💰 Credited Earnings',
      value:
        `Eligible Views: **${Number(stats.financials.eligibleViews || 0).toLocaleString()}**\n` +
        `Gross Credited: **$${stats.financials.grossEarnings || '0.00'}**`,
      inline: false
    });
  }

  // Engagement rates
  const eng = stats.engagement;
  let engText = '';
  if (eng.knownEngagementRate !== null) {
    engText += `Known Engagement Rate: **${eng.knownEngagementRate}%**\n`;
  }
  if (eng.engagementRate !== null) {
    engText += `Complete Engagement Rate: **${eng.engagementRate}%**`;
  } else {
    engText += `Complete Engagement: *Unavailable (partial metrics)*`;
  }

  embed.addFields({
    name: '⚡ Engagement Ratio',
    value: engText,
    inline: false
  });

  // Observation timeframe
  let timeText = '';
  if (stats.firstObservedAt) {
    const unixFirst = Math.floor(new Date(stats.firstObservedAt).getTime() / 1000);
    timeText += `First Observed: <t:${unixFirst}:f>\n`;
  }
  if (stats.lastObservedAt) {
    const unixLast = Math.floor(new Date(stats.lastObservedAt).getTime() / 1000);
    timeText += `Last Observed: <t:${unixLast}:f> (<t:${unixLast}:R>)\n`;
  }
  timeText += `Total Snapshots: **${stats.snapshotsCount || 0}**`;

  embed.addFields({
    name: '⏱️ Snapshot Timeline',
    value: timeText,
    inline: false
  });

  return embed;
}

/**
 * Build embed for paginated clips list in statistics flow
 * @param {Array<object>} submissions
 * @param {number} page
 * @param {number} totalPages
 * @param {string|null} campaignName
 * @returns {EmbedBuilder}
 */
export function buildStatsClipListEmbed(submissions, page, totalPages, campaignName = null) {
  const embed = new EmbedBuilder()
    .setTitle(campaignName ? `🎬 Clips for ${campaignName}` : '🎬 My Submitted Clips')
    .setDescription(
      submissions.length === 0
        ? 'No clips found. Submit a clip to a campaign first!'
        : `Showing page **${page}** of **${totalPages}**. Select a clip below to view detailed analytics.`
    )
    .setColor(BRAND_COLOR)
    .setTimestamp();

  submissions.forEach((sub, index) => {
    const snap = sub.snapshots?.[0];
    const viewsVal = sub.latestViews ?? snap?.views;
    const viewsText =
      viewsVal !== null && viewsVal !== undefined
        ? `**${Number(viewsVal).toLocaleString()}** views`
        : '*Views unavailable*';

    const retentionText = sub.retentionRequired
      ? ` | Retention: \`${sub.retentionStatus || 'ACTIVE'}\``
      : '';

    const earningsText = sub.totalEarned
      ? ` | Earned: \`$${sub.totalEarned}\``
      : '';

    const titleText = sub.title ? `"${sub.title}"\n` : '';

    embed.addFields({
      name: `${index + 1}. ${sub.platform} — ${viewsText}`,
      value:
        `${titleText}` +
        `Status: \`${toCreatorSafeStatus(sub.status)}\`${retentionText}${earningsText}\n` +
        `Campaign: **${sub.campaign?.name || 'N/A'}** • [Watch Video](${sub.url})\n` +
        `Submitted <t:${Math.floor(new Date(sub.submittedAt).getTime() / 1000)}:R>`,
      inline: false
    });
  });

  return embed;
}

/**
 * Build embed for Admin Campaign Performance & Operational Reporting
 * @param {object} report
 * @param {'overview'|'creators'|'platforms'|'channels'|'financial'} [view='overview']
 * @returns {EmbedBuilder}
 */
export function buildAdminCampaignReportEmbed(report, view = 'overview') {
  const c = report.campaign;
  const isCompleted = c.status === 'COMPLETED' || c.status === 'ENDED';
  const embedColor = isCompleted ? 0xEB459E : BRAND_COLOR;

  const embed = new EmbedBuilder()
    .setTitle(`🛡️ Admin Campaign Report: ${c.name}`)
    .setColor(embedColor)
    .setTimestamp();

  if (view === 'overview') {
    embed.setDescription(`Operational report and verified reach for **${c.name}** (${c.clientName}).`);

    // Budget & Fulfillment
    embed.addFields({
      name: '💵 Budget & Fulfillment',
      value:
        `• **Total Budget:** \`$${report.financial.totalBudget} ${c.currency}\`\n` +
        `• **Consumed Budget:** \`$${report.financial.consumedBudget} ${c.currency}\`\n` +
        `• **Remaining Budget:** \`$${report.financial.remainingBudget} ${c.currency}\`\n` +
        `• **Fulfillment Rate:** \`${report.financial.fulfillmentPercent}%\`\n` +
        `• **CPM Rate:** \`$${c.cpm} / 1k views\` | **Creator Cap:** \`$${c.creatorEarningCap}\``,
      inline: false
    });

    // Submissions Status Breakdown
    const s = report.overview.statusBreakdown;
    embed.addFields({
      name: '🎬 Submissions Overview',
      value:
        `Total: **${report.overview.totalSubmissions}**\n` +
        `✅ Approved: **${s.APPROVED}**\n` +
        `⏳ Pending: **${s.PENDING_VERIFICATION}**\n` +
        `🔍 Under Review: **${s.UNDER_REVIEW + (s.POST_APPROVAL_REVIEW || 0)}**\n` +
        `❌ Rejected: **${s.REJECTED}**` +
        (s.FLAGGED > 0 ? `\n⚠️ Flagged: **${s.FLAGGED}**` : ''),
      inline: true
    });

    // Verified Reach & Creators
    embed.addFields({
      name: '📈 Reach & Creators',
      value:
        `• **Eligible Views:** \`${Number(report.reach.totalEligibleViews).toLocaleString()}\`\n` +
        `• **Observed Views:** \`${Number(report.reach.totalObservedViews).toLocaleString()}\`\n` +
        `• **Active Members:** \`${report.overview.activeMembers}\` / \`${report.overview.totalMembers}\`\n` +
        `• **Credited Creators:** \`${report.financial.totalCreators}\`\n` +
        `• **Avg Credited / Creator:** \`$${report.financial.avgCreditedEarning}\``,
      inline: true
    });

    // Retention policy
    embed.addFields({
      name: '⏱️ Window & Retention',
      value:
        `• **Dates:** ${new Date(c.startsAt).toLocaleDateString()} — ${new Date(c.endsAt).toLocaleDateString()}\n` +
        `• **Retention Policy:** ${c.retentionRequired ? `\`${c.retentionDays} days required\`` : '`Not required`'}`,
      inline: false
    });
  } else if (view === 'creators') {
    embed.setDescription(`Operational creator performance table for **${c.name}** (Neutral reporting; no subjective rankings).`);

    const { items, total, page, totalPages, sortBy, sortOrder } = report.creators;
    embed.setFooter({ text: `Page ${page} of ${totalPages} • Total Creators: ${total} • Sorted by: ${sortBy} (${sortOrder})` });

    if (items.length === 0) {
      embed.addFields({ name: 'Creators', value: '*No creator activity recorded yet.*' });
    } else {
      items.forEach((cr, idx) => {
        const rankNum = (page - 1) * 10 + idx + 1;
        const lastActUnix = Math.floor(new Date(cr.lastActivity).getTime() / 1000);
        embed.addFields({
          name: `${rankNum}. ${cr.displayName || cr.username} (<@${cr.discordId}>)`,
          value:
            `• Clips: Total: \`${cr.totalClips}\` | Approved: \`${cr.approvedClips}\`\n` +
            `• Views: Eligible: \`${Number(cr.eligibleViews).toLocaleString()}\` | Observed: \`${Number(cr.observedViews).toLocaleString()}\`\n` +
            `• Credited: \`$${cr.creditedEarnings} ${c.currency}\` (**${cr.capUsedPercent}%** of cap)\n` +
            `• Last Active: <t:${lastActUnix}:R>`,
          inline: false
        });
      });
    }
  } else if (view === 'platforms') {
    embed.setDescription(`Platform distribution and metrics for **${c.name}**.`);

    report.platforms.forEach((p) => {
      embed.addFields({
        name: `🌐 ${p.platform}`,
        value:
          `• Clips: Total: \`${p.totalSubmissions}\` | Approved: \`${p.approvedSubmissions}\`\n` +
          `• Eligible Views: \`${Number(p.eligibleViews).toLocaleString()}\`\n` +
          `• Observed Views: \`${Number(p.observedViews).toLocaleString()}\`\n` +
          `• Credited Earnings: \`$${p.creditedEarnings}\``,
        inline: true
      });
    });
  } else if (view === 'channels') {
    embed.setDescription(`Observed channel and account activity in **${c.name}**.`);

    if (report.channels.length === 0) {
      embed.addFields({ name: 'Channels', value: '*No channel data recorded yet.*' });
    } else {
      report.channels.slice(0, 15).forEach((ch) => {
        embed.addFields({
          name: `📡 ${ch.channelName} (${ch.platform})`,
          value:
            `• Clips: \`${ch.totalClips}\`\n` +
            `• Observed Views: \`${Number(ch.observedViews).toLocaleString()}\`\n` +
            `• Credited Earnings: \`$${ch.creditedEarnings}\``,
          inline: true
        });
      });
    }
  } else if (view === 'financial') {
    const rec = report.financialReconciliation;
    const isReconciled = rec.isReconciled;
    const recEmoji = isReconciled ? '✅' : '⚠️';

    embed.setDescription(`Complete financial ledger reconciliation for **${c.name}**.`);

    embed.addFields({
      name: `${recEmoji} Financial Reconciliation Status: ${isReconciled ? 'RECONCILED' : 'DISCREPANCY DETECTED'}`,
      value:
        `• **Campaign Total Budget:** \`$${rec.totalBudget} ${c.currency}\`\n` +
        `• **Campaign Consumed Budget:** \`$${rec.consumedBudget} ${c.currency}\`\n` +
        `• **Reconciled Gross Earnings:** \`$${rec.reconciledGrossEarnings} ${c.currency}\`\n` +
        `• **Reconciled Net Adjustments:** \`$${rec.reconciledNetAdjustments} ${c.currency}\`\n` +
        `• **Total Financial Load (Earnings + Adjustments):** \`$${rec.reconciledTotalLoad} ${c.currency}\`\n` +
        `• **Budget Discrepancy:** \`$${rec.budgetDiscrepancy} ${c.currency}\`\n` +
        `• **Remaining Unspent Budget:** \`$${rec.remainingBudget} ${c.currency}\`\n` +
        `• **Fulfillment Rate:** \`${rec.fulfillmentPercent}%\``,
      inline: false
    });

    embed.setFooter({
      text: isReconciled
        ? 'Ledger Invariant Satisfied: Consumed Budget equals sum of actual credited earnings and adjustments.'
        : 'Warning: Consumed budget does not equal total financial load.'
    });
  }

  return embed;
}
