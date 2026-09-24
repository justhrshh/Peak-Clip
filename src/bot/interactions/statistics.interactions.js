import { MessageFlags } from 'discord.js';
import { userService } from '../../modules/users/user.service.js';
import { statisticsService } from '../../modules/statistics/statistics.service.js';
import { statisticsRepository } from '../../modules/statistics/statistics.repository.js';
import { acknowledgeCreatorInteraction } from './dashboard.interactions.js';
import {
  buildUserOverviewEmbed,
  buildCreatorCampaignsEmbed,
  buildCreatorPlatformsEmbed,
  buildCreatorChannelsEmbed,
  buildCampaignOverviewEmbed,
  buildSubmissionStatisticsEmbed,
  buildStatsClipListEmbed
} from '../embeds/statistics.embeds.js';
import {
  buildUserOverviewActionRow,
  buildCampaignPaginationRow,
  buildPlatformBackRow,
  buildChannelBackRow,
  buildCampaignSelectorRow,
  buildCampaignSelectBackRow,
  buildCampaignOverviewActionRow,
  buildClipPickerRow,
  buildClipPaginationRow,
  buildClipDetailActionRow
} from '../components/statistics.components.js';
import { logger } from '../../utils/logger.js';

const PAGE_SIZE = 5;

/**
 * Handle user overview navigation
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} targetUserId
 */
export async function handleStatsOverview(interaction, targetUserId) {
  await acknowledgeCreatorInteraction(interaction);
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({
      content: '❌ You can only navigate your own statistics.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const overview = await statisticsService.getUserOverview(user.id);
  const embed = buildUserOverviewEmbed(overview, interaction.user);
  const row = buildUserOverviewActionRow(user.id);

  await interaction.editReply({
    embeds: [embed],
    components: [row]
  });
  return;
}

/**
 * Handle creator campaigns list view (paginated)
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} targetUserId
 * @param {number} [page=1]
 */
export async function handleStatsCampaignsList(interaction, targetUserId, page = 1) {
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

  const pageNum = parseInt(page, 10) || 1;
  const campaignsData = await statisticsService.getCreatorCampaigns(user.id, {
    page: pageNum,
    limit: PAGE_SIZE
  });

  const embed = buildCreatorCampaignsEmbed(campaignsData, interaction.user);
  const paginationRow = buildCampaignPaginationRow(user.id, campaignsData.page, campaignsData.totalPages);

  await interaction.editReply({
    embeds: [embed],
    components: [paginationRow]
  });
  return;
}

/**
 * Handle creator platform breakdown view
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} targetUserId
 */
export async function handleStatsPlatforms(interaction, targetUserId) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({
      content: '❌ You can only view your own platform statistics.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const platforms = await statisticsService.getCreatorPlatforms(user.id);
  const embed = buildCreatorPlatformsEmbed(platforms, interaction.user);
  const backRow = buildPlatformBackRow(user.id);

  await interaction.editReply({
    embeds: [embed],
    components: [backRow]
  });
  return;
}

/**
 * Handle creator channel / account breakdown view
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} targetUserId
 */
export async function handleStatsChannels(interaction, targetUserId) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({
      content: '❌ You can only view your own channel statistics.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const channels = await statisticsService.getCreatorChannels(user.id);
  const embed = buildCreatorChannelsEmbed(channels, interaction.user);
  const backRow = buildChannelBackRow(user.id);

  await interaction.editReply({
    embeds: [embed],
    components: [backRow]
  });
  return;
}

/**
 * Handle campaign selection dropdown
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 * @param {string} targetUserId
 */
export async function handleStatsCampaignSelect(interaction, targetUserId) {
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
  const campaignStats = await statisticsService.getCampaignOverview(user.id, campaignId);
  const embed = buildCampaignOverviewEmbed(campaignStats, interaction.user);
  const row = buildCampaignOverviewActionRow(user.id, campaignId);

  await interaction.editReply({
    embeds: [embed],
    components: [row]
  });
  return;
}

/**
 * Handle clips pagination list
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} targetUserId
 * @param {string} campaignId - 'all' or specific campaignId
 * @param {number} page
 */
export async function handleStatsClipsList(interaction, targetUserId, campaignId = 'all', page = 1) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({
      content: '❌ You can only view your own clips.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const pageNum = parseInt(page, 10) || 1;
  const result = await statisticsService.getCreatorVideos(user.id, {
    campaignId: campaignId === 'all' ? null : campaignId,
    page: pageNum,
    limit: PAGE_SIZE
  });

  let campaignName = null;
  if (campaignId && campaignId !== 'all' && result.items.length > 0) {
    campaignName = result.items[0].campaign?.name || null;
  }

  const embed = buildStatsClipListEmbed(result.items, result.page, result.totalPages, campaignName);
  const components = [];

  if (result.items.length > 0) {
    components.push(buildClipPickerRow(user.id, result.items));
  }
  components.push(buildClipPaginationRow(user.id, result.page, result.totalPages, campaignId));

  await interaction.editReply({
    embeds: [embed],
    components
  });
  return;
}

/**
 * Handle individual clip selection dropdown
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 * @param {string} targetUserId
 */
export async function handleStatsClipSelect(interaction, targetUserId) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({
      content: '❌ You can only view analytics for your own clips.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const submissionId = interaction.values[0];
  const stats = await statisticsService.getSubmissionStatistics(user.id, submissionId);
  const embed = buildSubmissionStatisticsEmbed(stats, interaction.user);
  const row = buildClipDetailActionRow(user.id, stats.campaign.id, submissionId);

  await interaction.editReply({
    embeds: [embed],
    components: [row]
  });
  return;
}

/**
 * Handle refresh button on statistics views (reads latest persisted database state)
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} targetUserId
 * @param {'overview'|'campaign'|'clip'|'platforms'|'channels'|'campaigns'} viewType
 * @param {string} [extraId]
 */
export async function handleStatsRefresh(interaction, targetUserId, viewType, extraId = null) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({
      content: '❌ You can only refresh your own statistics.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  logger.debug({ userId: user.id, viewType, extraId }, 'Refreshing statistics from database');

  if (viewType === 'overview') {
    const overview = await statisticsService.getUserOverview(user.id);
    const embed = buildUserOverviewEmbed(overview, interaction.user);
    const row = buildUserOverviewActionRow(user.id);
    await interaction.editReply({ embeds: [embed], components: [row] });
  } else if (viewType === 'platforms') {
    const platforms = await statisticsService.getCreatorPlatforms(user.id);
    const embed = buildCreatorPlatformsEmbed(platforms, interaction.user);
    const backRow = buildPlatformBackRow(user.id);
    await interaction.editReply({ embeds: [embed], components: [backRow] });
  } else if (viewType === 'channels') {
    const channels = await statisticsService.getCreatorChannels(user.id);
    const embed = buildCreatorChannelsEmbed(channels, interaction.user);
    const backRow = buildChannelBackRow(user.id);
    await interaction.editReply({ embeds: [embed], components: [backRow] });
  } else if (viewType === 'campaigns') {
    const campaignsData = await statisticsService.getCreatorCampaigns(user.id, { page: 1, limit: PAGE_SIZE });
    const embed = buildCreatorCampaignsEmbed(campaignsData, interaction.user);
    const paginationRow = buildCampaignPaginationRow(user.id, campaignsData.page, campaignsData.totalPages);
    await interaction.editReply({ embeds: [embed], components: [paginationRow] });
  } else if (viewType === 'campaign') {
    const campaignStats = await statisticsService.getCampaignOverview(user.id, extraId);
    const embed = buildCampaignOverviewEmbed(campaignStats, interaction.user);
    const row = buildCampaignOverviewActionRow(user.id, extraId);
    await interaction.editReply({ embeds: [embed], components: [row] });
  } else if (viewType === 'clip') {
    const stats = await statisticsService.getSubmissionStatistics(user.id, extraId);
    const embed = buildSubmissionStatisticsEmbed(stats, interaction.user);
    const row = buildClipDetailActionRow(user.id, stats.campaign.id, extraId);
    await interaction.editReply({ embeds: [embed], components: [row] });
  }
  return;
}
