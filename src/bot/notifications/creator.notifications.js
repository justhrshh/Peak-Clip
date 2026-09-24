import { getDiscordClient } from '../client.js';
import { EmbedBuilder } from 'discord.js';
import { logger } from '../../utils/logger.js';

const WARNING_COLOR = 0xFEE75C; // Yellow / Warning

/**
 * Send clear retention violation notice to the creator via Discord DM
 *
 * @param {object} params
 * @param {string} params.discordId - Discord snowflake ID of the creator
 * @param {string} params.campaignName - Name of the campaign
 * @param {number} params.retentionDays - Required retention period in days
 * @param {string} [params.violationReason] - Description of the violation
 * @returns {Promise<boolean>} True if DM sent successfully, false otherwise
 */
export async function notifyRetentionViolation({ discordId, campaignName, retentionDays, violationReason }) {
  try {
    const client = getDiscordClient();
    if (!client || !client.isReady?.() || !client.users) {
      logger.info({ discordId, campaignName }, 'Discord client not active; skipping DM dispatch');
      return false;
    }

    const user = await client.users.fetch(discordId).catch(() => null);
    if (!user) {
      logger.warn({ discordId }, 'Could not resolve Discord user for retention violation DM');
      return false;
    }

    const embed = new EmbedBuilder()
      .setTitle('⚠️ Retention requirement violated')
      .setColor(WARNING_COLOR)
      .setDescription(
        `Your clip for **${campaignName || 'Campaign'}** is no longer available before the required retention period ended.\n\n` +
        `**Your retention requirement:**\n${retentionDays} days\n\n` +
        `**Violation:**\n${violationReason || 'Video unavailable/deleted'}\n\n` +
        `This may affect your future available balance according to campaign policy.`
      )
      .setTimestamp();

    await user.send({ embeds: [embed] });
    logger.info({ discordId, campaignName }, 'Retention violation DM successfully delivered to creator');
    return true;
  } catch (err) {
    logger.warn({ discordId, err: err.message }, 'Failed to deliver retention violation notification DM (user may have DMs disabled)');
    return false;
  }
}

/**
 * Notify creator when submission requires manual review
 * Strictly non-sensitive: does NOT expose risk score, weights, or anomaly signals.
 *
 * @param {object} params
 * @param {string} params.discordId
 * @param {string} params.campaignName
 * @param {string} params.videoUrl
 * @returns {Promise<boolean>}
 */
export async function notifySubmissionUnderReview({ discordId, campaignName, videoUrl }) {
  try {
    const client = getDiscordClient();
    if (!client || !client.isReady?.() || !client.users) {
      logger.info({ discordId, campaignName }, 'Discord client not active; skipping DM dispatch');
      return false;
    }

    const user = await client.users.fetch(discordId).catch(() => null);
    if (!user) {
      logger.warn({ discordId }, 'Could not resolve Discord user for under review DM');
      return false;
    }

    const embed = new EmbedBuilder()
      .setTitle('🔎 Your clip is being reviewed')
      .setColor(WARNING_COLOR)
      .setDescription(
        `Our automated verification system needs an additional review of this submission.\n\n` +
        `**Submission:**\n${videoUrl}\n\n` +
        `**Campaign:**\n${campaignName || 'Campaign'}\n\n` +
        `**Status:**\n\`Under Review\`\n\n` +
        `No action is required from you right now. An admin will review the submission and you'll be notified when a decision is made.`
      )
      .setTimestamp();

    await user.send({ embeds: [embed] });
    logger.info({ discordId, campaignName }, 'Submission under review DM delivered to creator');
    return true;
  } catch (err) {
    logger.warn({ discordId, err: err.message }, 'Failed to deliver under review notification DM');
    return false;
  }
}

/**
 * Notify creator when submission is rejected
 * Displays creator-safe human-readable reason and optional admin note.
 * Strictly non-sensitive: does NOT expose risk scores or detection thresholds.
 *
 * @param {object} params
 * @param {string} params.discordId
 * @param {string} params.campaignName
 * @param {string} params.safeReason - Human readable reason
 * @param {string|null} [params.adminNote]
 * @returns {Promise<boolean>}
 */
export async function notifySubmissionRejection({ discordId, campaignName, safeReason, adminNote = null }) {
  try {
    const client = getDiscordClient();
    if (!client || !client.isReady?.() || !client.users) {
      logger.info({ discordId, campaignName }, 'Discord client not active; skipping DM dispatch');
      return false;
    }

    const user = await client.users.fetch(discordId).catch(() => null);
    if (!user) {
      logger.warn({ discordId }, 'Could not resolve Discord user for rejection DM');
      return false;
    }

    let description =
      `Your submission for **${campaignName || 'Campaign'}** was rejected.\n\n` +
      `**Reason:**\n${safeReason || 'Campaign Requirement Violation'}\n\n`;

    if (adminNote) {
      description += `**Admin note:**\n${adminNote}\n\n`;
    }

    description += `If you believe this was a mistake, please contact support.`;

    const embed = new EmbedBuilder()
      .setTitle('❌ Clip rejected')
      .setColor(0xED4245) // Danger / Red
      .setDescription(description)
      .setTimestamp();

    await user.send({ embeds: [embed] });
    logger.info({ discordId, campaignName }, 'Submission rejection DM delivered to creator');
    return true;
  } catch (err) {
    logger.warn({ discordId, err: err.message }, 'Failed to deliver rejection notification DM');
    return false;
  }
}
