import { SlashCommandBuilder } from 'discord.js';
import { userService } from '../../modules/users/user.service.js';
import { earningsService } from '../../modules/earnings/earnings.service.js';
import { buildUserEarningsEmbed } from '../embeds/earnings.embeds.js';
import { buildUserEarningsActionRow } from '../components/earnings.components.js';

export const data = new SlashCommandBuilder()
  .setName('earnings')
  .setDescription('View your clipping earnings, balance summary, and payout eligibility');

/**
 * Execute /earnings slash command
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  // Creator-private: reply ephemerally
  await interaction.deferReply({ ephemeral: true });

  // 1. Sync creator identity
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  // 2. Fetch authoritative ledgered balance
  const earnings = await earningsService.getUserEarnings(user.id);

  // 3. Render embed and action buttons
  const embed = buildUserEarningsEmbed(earnings, interaction.user);
  const actionRow = buildUserEarningsActionRow(user.id);

  await interaction.editReply({
    embeds: [embed],
    components: [actionRow]
  });
}
