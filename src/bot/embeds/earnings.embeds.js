import { EmbedBuilder } from 'discord.js';

const SUCCESS_COLOR = 0x57F287; // Green
const BRAND_COLOR = 0x5865F2; // Discord Blurple
const WARNING_COLOR = 0xFEE75C; // Yellow

/**
 * Build embed for User Earnings overview
 * @param {object} earnings
 * @param {import('discord.js').User} discordUser
 * @returns {EmbedBuilder}
 */
export function buildUserEarningsEmbed(earnings, discordUser) {
  const symbol = earnings.currency === 'USD' ? '$' : `${earnings.currency} `;
  const eligibleStr = `${symbol}${Number(earnings.eligibleEarnings).toFixed(2)}`;
  const pendingStr = `${symbol}${Number(earnings.pendingEarnings).toFixed(2)}`;
  const totalStr = `${symbol}${Number(earnings.totalGrossEarnings).toFixed(2)}`;
  const minPayoutStr = `${symbol}${Number(earnings.minimumPayout).toFixed(2)}`;

  const embed = new EmbedBuilder()
    .setTitle('💰 My Clipping Earnings')
    .setDescription(`Authoritative earnings ledger summary for <@${discordUser.id}>.`)
    .setColor(earnings.isPayoutThresholdReached ? SUCCESS_COLOR : BRAND_COLOR)
    .setTimestamp();

  // Primary balances
  embed.addFields({
    name: '💵 Balance Summary',
    value:
      `✅ **Eligible Balance:** ${eligibleStr}\n` +
      `⏳ **Pending Balance:** ${pendingStr}\n` +
      `📈 **Total Earned:** ${totalStr}`,
    inline: true
  });

  // Views & Participation
  embed.addFields({
    name: '📊 Activity & Views',
    value:
      `👁️ **Eligible Views:** ${Number(earnings.totalEligibleViews).toLocaleString()}\n` +
      `🎯 **Campaigns Joined:** ${earnings.campaignCount}\n` +
      `🎬 **Earning Clips:** ${earnings.submissionCount}`,
    inline: true
  });

  // Payout threshold status (Informational only: no payout buttons)
  let thresholdText = '';
  if (earnings.isPayoutThresholdReached) {
    thresholdText = `🟢 **Threshold Reached** (${eligibleStr} / ${minPayoutStr})\n*You're eligible to request a payout once payouts open.*`;
  } else {
    thresholdText = `⚪ **Not Reached** (${eligibleStr} / ${minPayoutStr})\n*Keep clipping to reach the minimum payout.*`;
  }

  embed.addFields({
    name: '🏦 Minimum Payout Status',
    value: thresholdText,
    inline: false
  });

  if (earnings.latestEarningAt) {
    const unix = Math.floor(new Date(earnings.latestEarningAt).getTime() / 1000);
    embed.addFields({
      name: '⏱️ Last Earning Event',
      value: `<t:${unix}:f> (<t:${unix}:R>)`,
      inline: false
    });
  }

  embed.setFooter({
    text: 'Immutable Ledger: Balances are derived from verified credit events. Refresh re-reads database.'
  });

  return embed;
}

/**
 * Build embed for Campaign-specific earnings
 * @param {object} campEarnings
 * @param {import('discord.js').User} discordUser
 * @returns {EmbedBuilder}
 */
export function buildCampaignEarningsEmbed(campEarnings, discordUser) {
  const symbol = campEarnings.currency === 'USD' ? '$' : `${campEarnings.currency} `;
  const grossStr = `${symbol}${Number(campEarnings.grossEarnings).toFixed(2)}`;
  const eligibleStr = `${symbol}${Number(campEarnings.eligibleEarnings).toFixed(2)}`;
  const pendingStr = `${symbol}${Number(campEarnings.pendingEarnings).toFixed(2)}`;
  const rateStr = `${symbol}${Number(campEarnings.currentRatePerThousand).toFixed(2)}`;
  const minPayoutStr = `${symbol}${Number(campEarnings.minimumPayout).toFixed(2)}`;

  const embed = new EmbedBuilder()
    .setTitle(`💰 Campaign Earnings: ${campEarnings.campaign.name}`)
    .setDescription(`Earnings breakdown for <@${discordUser.id}> in **${campEarnings.campaign.name}**.`)
    .setColor(campEarnings.isPayoutThresholdReached ? SUCCESS_COLOR : BRAND_COLOR)
    .setTimestamp();

  embed.addFields({
    name: '💵 Financial Overview',
    value:
      `📈 **Gross Earned:** ${grossStr}\n` +
      `✅ **Eligible:** ${eligibleStr}\n` +
      `⏳ **Pending:** ${pendingStr}\n` +
      `🏷️ **Pay Rate:** ${rateStr} / 1k views`,
    inline: true
  });

  embed.addFields({
    name: '🎬 Activity & Metrics',
    value:
      `👁️ **Eligible Views:** ${Number(campEarnings.eligibleViews).toLocaleString()}\n` +
      `✅ **Approved Clips:** ${campEarnings.approvedSubmissionsCount}\n` +
      `🏦 **Min Payout:** ${minPayoutStr}`,
    inline: true
  });

  const thresholdText = campEarnings.isPayoutThresholdReached
    ? `🟢 **Threshold Reached** (${eligibleStr} / ${minPayoutStr})`
    : `⚪ **Not Reached** (${eligibleStr} / ${minPayoutStr})`;

  embed.addFields({
    name: '🏦 Campaign Payout Threshold',
    value: thresholdText,
    inline: false
  });

  embed.setFooter({
    text: 'Historical earnings are locked to the rate at time of credit. Refresh re-reads database.'
  });

  return embed;
}

/**
 * Build embed for Submission-specific earnings audit trail
 * @param {object} subEarnings
 * @param {import('discord.js').User} discordUser
 * @returns {EmbedBuilder}
 */
export function buildSubmissionEarningsEmbed(subEarnings, discordUser) {
  const symbol = subEarnings.currency === 'USD' ? '$' : `${subEarnings.currency} `;
  const grossStr = `${symbol}${Number(subEarnings.grossEarnings).toFixed(2)}`;
  const rateStr = `${symbol}${Number(subEarnings.currentRatePerThousand).toFixed(2)}`;

  const embed = new EmbedBuilder()
    .setTitle(`🎬 Clip Earnings: ${subEarnings.submission.platform}`)
    .setDescription(
      `[Original Video URL](${subEarnings.submission.url})\n` +
      `**Campaign:** ${subEarnings.campaign.name}\n` +
      `**Status:** \`${subEarnings.submission.status}\``
    )
    .setColor(BRAND_COLOR)
    .setTimestamp();

  embed.addFields({
    name: '💵 Clip Earnings Summary',
    value:
      `💰 **Gross Earned:** ${grossStr}\n` +
      `👁️ **Credited Views:** ${Number(subEarnings.creditedViews).toLocaleString()}\n` +
      `⏳ **Uncredited Views:** ${Number(subEarnings.uncreditedViews).toLocaleString()}\n` +
      `🏷️ **Current Campaign Rate:** ${rateStr} / 1k views`,
    inline: false
  });

  let ledgerText = '';
  if (subEarnings.ledgerEntries.length > 0) {
    ledgerText = subEarnings.ledgerEntries
      .slice(0, 5)
      .map((entry, idx) => {
        const amtStr = `${symbol}${Number(entry.grossAmount).toFixed(2)}`;
        const views = Number(entry.eligibleViews).toLocaleString();
        const unix = Math.floor(new Date(entry.createdAt).getTime() / 1000);
        return `• **+${views} views** → **${amtStr}** (@ ${symbol}${Number(entry.ratePerThousand).toFixed(2)}/1k) • <t:${unix}:R>`;
      })
      .join('\n');
  } else {
    ledgerText = '*No earnings credited yet. Clips must be approved with verified views.*';
  }

  embed.addFields({
    name: '📜 Earning Event Ledger (Recent)',
    value: ledgerText,
    inline: false
  });

  return embed;
}
