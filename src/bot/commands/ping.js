import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Health check: replies with gateway latency and platform status');

/**
 * Execute ping command
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  const sent = await interaction.reply({
    content: 'Pinging platform services...',
    fetchReply: true
  });

  const latency = sent.createdTimestamp - interaction.createdTimestamp;
  const wsPing = interaction.client.ws.ping;

  await interaction.editReply({
    content: `🏓 **Pong!**\n• Roundtrip Latency: \`${latency}ms\`\n• Gateway Ping: \`${wsPing}ms\`\n• Status: \`Online & Operational\``
  });
}
