import { SlashCommandBuilder } from 'discord.js';
import { userService } from '../../modules/users/user.service.js';
import { submissionService } from '../../modules/submissions/submission.service.js';
import { buildUserSubmissionsEmbed } from '../embeds/submission.embeds.js';
import { buildSubmissionsPaginationRow } from '../components/submission.components.js';

export const data = new SlashCommandBuilder()
  .setName('submissions')
  .setDescription('View the status of your submitted video clips and verification progress');

/**
 * Execute /submissions command
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const user = await userService.getOrCreateFromDiscord(interaction.user);
  const result = await submissionService.getUserSubmissions(user.id, { page: 1, limit: 5 });

  const embed = buildUserSubmissionsEmbed(result);
  const components =
    result.totalPages > 1 ? [buildSubmissionsPaginationRow(result.page, result.totalPages)] : [];

  await interaction.editReply({
    embeds: [embed],
    components
  });
}
