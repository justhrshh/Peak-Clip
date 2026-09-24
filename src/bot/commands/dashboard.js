import { SlashCommandBuilder } from 'discord.js';
import { handleCreatorDashboard } from '../interactions/dashboard.interactions.js';

export const data = new SlashCommandBuilder()
  .setName('dashboard')
  .setDescription('Open the interactive Peak Clip Creator Center dashboard');

/**
 * Execute /dashboard command
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  await handleCreatorDashboard(interaction);
}

export default {
  data,
  execute
};

