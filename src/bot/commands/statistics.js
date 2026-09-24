import { SlashCommandBuilder } from 'discord.js';
import { userService } from '../../modules/users/user.service.js';
import { statisticsService } from '../../modules/statistics/statistics.service.js';
import { buildUserOverviewEmbed } from '../embeds/statistics.embeds.js';
import { buildUserOverviewActionRow } from '../components/statistics.components.js';

export const data = new SlashCommandBuilder()
  .setName('statistics')
  .setDescription('View your clipping performance, campaign analytics, and clip growth');

/**
 * Execute /statistics slash command
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  // Statistics are creator-private: reply ephemerally to protect creator privacy
  await interaction.deferReply({ ephemeral: true });

  // 1. Sync creator identity
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  // 2. Fetch overview derived from latest valid persisted snapshots
  const overview = await statisticsService.getUserOverview(user.id);

  // 3. Render embed and interactive navigation buttons
  const embed = buildUserOverviewEmbed(overview, interaction.user);
  const actionRow = buildUserOverviewActionRow(user.id);

  await interaction.editReply({
    embeds: [embed],
    components: [actionRow]
  });
}
