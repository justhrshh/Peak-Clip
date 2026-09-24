import { getDiscordClient } from '../client.js';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { staffIds } from '../components/staffComponentIds.js';
import { logger } from '../../utils/logger.js';

const STAFF_REVIEW_CHANNEL = 'review-queue';
const STAFF_PAYOUT_CHANNEL = 'payout-queue';
const STAFF_AUDIT_CHANNEL = 'audit-log';

/**
 * Helper to find a staff channel across guild cache
 * @param {string} channelName
 * @param {object} [overrideClient=null]
 * @returns {Promise<import('discord.js').TextChannel|null>}
 */
async function getStaffChannel(channelName, overrideClient = null) {
  try {
    const client = overrideClient || getDiscordClient();
    if (!client || !client.guilds) return null;

    for (const guild of client.guilds.cache.values()) {
      const channels = guild.channels?.cache;
      if (!channels) continue;
      const channel = typeof channels.find === 'function'
        ? channels.find((c) => c.name === channelName && typeof c.send === 'function')
        : Array.from(channels.values()).find((c) => c.name === channelName && typeof c.send === 'function');
      if (channel) return channel;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 1. Suspicious clip requiring staff review
 * @param {object} params
 * @param {object} params.submission
 * @param {string} params.reason
 * @param {object} [params.snapshot]
 * @param {Array<object>} [params.signals]
 * @param {object} [params.client]
 * @returns {Promise<boolean>}
 */
export async function notifyStaffSuspiciousClip({ submission, reason, snapshot, signals = [], client = null }) {
  try {
    const channel = await getStaffChannel(STAFF_REVIEW_CHANNEL, client);
    if (!channel) return false;

    const creatorName = submission.user?.username || submission.user?.discordId || 'Creator';
    const campaignName = submission.campaign?.name || 'Campaign';
    const views = snapshot?.views != null ? snapshot.views.toString() : 'N/A';

    const embed = new EmbedBuilder()
      .setTitle('🚨 Suspicious Clip Flagged')
      .setColor(0xe74c3c)
      .setDescription(
        `Automated hourly polling detected anomalous engagement signals on this clip.\n\n` +
        `• **Creator:** ${creatorName} (<@${submission.user?.discordId || submission.userId}>)\n` +
        `• **Platform:** \`${submission.platform}\`\n` +
        `• **Campaign:** ${campaignName}\n` +
        `• **Flag Reason:** \`${reason}\`\n` +
        `• **Current Views:** \`${views}\`\n` +
        `• **Submission ID:** \`${submission.id}\``
      )
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.subView(submission.id))
        .setLabel('🔎 Review Now')
        .setStyle(ButtonStyle.Primary)
    );

    if (submission.url && (submission.url.startsWith('http://') || submission.url.startsWith('https://'))) {
      row.addComponents(
        new ButtonBuilder()
          .setLabel('🎬 Open Video')
          .setStyle(ButtonStyle.Link)
          .setURL(submission.url)
      );
    }

    await channel.send({ embeds: [embed], components: [row] });
    logger.info({ submissionId: submission.id }, 'Staff suspicious clip notification dispatched');
    return true;
  } catch (err) {
    logger.warn({ submissionId: submission?.id, err: err.message }, 'Failed to dispatch staff suspicious clip notification');
    return false;
  }
}

/**
 * 2. New submission requiring manual review
 * @param {object} params
 * @param {object} params.submission
 * @param {string} params.reason
 * @param {object} [params.client]
 * @returns {Promise<boolean>}
 */
export async function notifyStaffManualReviewRequired({ submission, reason, client = null }) {
  try {
    const channel = await getStaffChannel(STAFF_REVIEW_CHANNEL, client);
    if (!channel) return false;

    const creatorName = submission.user?.username || submission.user?.discordId || 'Creator';
    const campaignName = submission.campaign?.name || 'Campaign';

    const embed = new EmbedBuilder()
      .setTitle('🔎 New Submission Requires Manual Review')
      .setColor(0xf39c12)
      .setDescription(
        `A clip submission requires staff review before verification approval.\n\n` +
        `• **Creator:** ${creatorName} (<@${submission.user?.discordId || submission.userId}>)\n` +
        `• **Platform:** \`${submission.platform}\`\n` +
        `• **Campaign:** ${campaignName}\n` +
        `• **Review Reason:** \`${reason || 'Platform requires manual review'}\`\n` +
        `• **Submission ID:** \`${submission.id}\``
      )
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.subView(submission.id))
        .setLabel('🔎 Inspect')
        .setStyle(ButtonStyle.Primary)
    );

    if (submission.url && (submission.url.startsWith('http://') || submission.url.startsWith('https://'))) {
      row.addComponents(
        new ButtonBuilder()
          .setLabel('🎬 Open Video')
          .setStyle(ButtonStyle.Link)
          .setURL(submission.url)
      );
    }

    await channel.send({ embeds: [embed], components: [row] });
    logger.info({ submissionId: submission.id }, 'Staff manual review notification dispatched');
    return true;
  } catch (err) {
    logger.warn({ submissionId: submission?.id, err: err.message }, 'Failed to dispatch staff manual review notification');
    return false;
  }
}

/**
 * 3. Confirmed video deletion before 30 days
 * @param {object} params
 * @param {object} params.submission
 * @param {string} params.reason
 * @param {object} [params.client]
 * @returns {Promise<boolean>}
 */
export async function notifyStaffEarlyDeletion({ submission, reason, client = null }) {
  try {
    const channel = await getStaffChannel(STAFF_REVIEW_CHANNEL, client) || await getStaffChannel(STAFF_AUDIT_CHANNEL, client);
    if (!channel) return false;

    const creatorName = submission.user?.username || submission.user?.discordId || 'Creator';
    const campaignName = submission.campaign?.name || 'Campaign';

    const embed = new EmbedBuilder()
      .setTitle('⚠️ Early Video Deletion Detected (<30 Days)')
      .setColor(0xe74c3c)
      .setDescription(
        `A verified video was confirmed unavailable/deleted before completing its required retention period.\n\n` +
        `• **Creator:** ${creatorName} (<@${submission.user?.discordId || submission.userId}>)\n` +
        `• **Platform:** \`${submission.platform}\`\n` +
        `• **Campaign:** ${campaignName}\n` +
        `• **Deletion Reason:** \`${reason || 'Video removed from platform'}\`\n` +
        `• **Submission ID:** \`${submission.id}\``
      )
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.subView(submission.id))
        .setLabel('⚠️ Inspect Submission')
        .setStyle(ButtonStyle.Danger)
    );

    await channel.send({ embeds: [embed], components: [row] });
    logger.info({ submissionId: submission.id }, 'Staff early deletion notification dispatched');
    return true;
  } catch (err) {
    logger.warn({ submissionId: submission?.id, err: err.message }, 'Failed to dispatch staff early deletion notification');
    return false;
  }
}

/**
 * 4. Payout request submitted
 * @param {object} params
 * @param {object} params.payoutRequest
 * @param {object} [params.user]
 * @param {object} [params.client]
 * @returns {Promise<boolean>}
 */
export async function notifyStaffPayoutRequested({ payoutRequest, user, client = null }) {
  try {
    const channel = await getStaffChannel(STAFF_PAYOUT_CHANNEL, client);
    if (!channel) return false;

    const creatorName = user?.username || payoutRequest.userId;
    const amount = Number(payoutRequest.amount || 0).toFixed(2);
    const currency = payoutRequest.currency || 'USD';

    const embed = new EmbedBuilder()
      .setTitle('💸 New Payout Request Submitted')
      .setColor(0x2ecc71)
      .setDescription(
        `A creator has submitted a payout disbursement request.\n\n` +
        `• **Creator:** ${creatorName} (<@${user?.discordId || payoutRequest.userId}>)\n` +
        `• **Amount:** \`$${amount} ${currency}\`\n` +
        `• **Payout ID:** \`${payoutRequest.id}\``
      )
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.pqViewReq(payoutRequest.id))
        .setLabel('💸 Review Payout')
        .setStyle(ButtonStyle.Success)
    );

    await channel.send({ embeds: [embed], components: [row] });
    logger.info({ payoutId: payoutRequest.id }, 'Staff payout notification dispatched');
    return true;
  } catch (err) {
    logger.warn({ payoutId: payoutRequest?.id, err: err.message }, 'Failed to dispatch staff payout notification');
    return false;
  }
}
