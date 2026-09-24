import { MessageFlags } from 'discord.js';
import { userService } from '../../modules/users/user.service.js';
import { earningsService } from '../../modules/earnings/earnings.service.js';
import { statisticsRepository } from '../../modules/statistics/statistics.repository.js';
import {
  buildUserEarningsEmbed,
  buildCampaignEarningsEmbed
} from '../embeds/earnings.embeds.js';
import {
  buildUserEarningsActionRow,
  buildEarningsCampaignSelectRow,
  buildEarningsCampaignBackRow,
  buildCampaignEarningsActionRow
} from '../components/earnings.components.js';
import { logger } from '../../utils/logger.js';

/**
 * Handle user earnings overview navigation
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} targetUserId
 */
export async function handleEarningsOverview(interaction, targetUserId) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({
      content: '❌ You can only view your own earnings.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const earnings = await earningsService.getUserEarnings(user.id);
  const embed = buildUserEarningsEmbed(earnings, interaction.user);
  const row = buildUserEarningsActionRow(user.id);

  await interaction.editReply({
    embeds: [embed],
    components: [row]
  });
  return;
}

/**
 * Handle campaign selector for earnings
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} targetUserId
 */
export async function handleEarningsCampaignsList(interaction, targetUserId) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({
      content: '❌ You can only view your own campaigns.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const memberships = await statisticsRepository.getUserCampaignMemberships(user.id);
  if (memberships.length === 0) {
    await interaction.followUp({
      content: 'ℹ️ You have not joined any campaigns yet. Use `/campaigns` to explore and join!',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const selectRow = buildEarningsCampaignSelectRow(user.id, memberships);
  const backRow = buildEarningsCampaignBackRow(user.id);

  await interaction.editReply({
    components: [selectRow, backRow]
  });
  return;
}

/**
 * Handle campaign selection dropdown in earnings flow
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 * @param {string} targetUserId
 */
export async function handleEarningsCampaignSelect(interaction, targetUserId) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({
      content: '❌ You can only select campaigns for your own account.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const campaignId = interaction.values[0];
  const campEarnings = await earningsService.getCampaignEarnings(user.id, campaignId);
  const embed = buildCampaignEarningsEmbed(campEarnings, interaction.user);
  const row = buildCampaignEarningsActionRow(user.id, campaignId);

  await interaction.editReply({
    embeds: [embed],
    components: [row]
  });
  return;
}

/**
 * Handle refresh button on earnings views (re-reads database ledger)
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} targetUserId
 * @param {'overview'|'campaign'} viewType
 * @param {string} [extraId]
 */
export async function handleEarningsRefresh(interaction, targetUserId, viewType, extraId = null) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({
      content: '❌ You can only refresh your own earnings.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  logger.debug({ userId: user.id, viewType, extraId }, 'Refreshing earnings from database');

  if (viewType === 'overview') {
    const earnings = await earningsService.getUserEarnings(user.id);
    const embed = buildUserEarningsEmbed(earnings, interaction.user);
    const row = buildUserEarningsActionRow(user.id);
    await interaction.editReply({ embeds: [embed], components: [row] });
  } else if (viewType === 'campaign') {
    const campEarnings = await earningsService.getCampaignEarnings(user.id, extraId);
    const embed = buildCampaignEarningsEmbed(campEarnings, interaction.user);
    const row = buildCampaignEarningsActionRow(user.id, extraId);
    await interaction.editReply({ embeds: [embed], components: [row] });
  }
  return;
}
