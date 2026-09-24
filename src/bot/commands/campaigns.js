import { SlashCommandBuilder } from 'discord.js';
import { userService } from '../../modules/users/user.service.js';
import { campaignService } from '../../modules/campaigns/campaign.service.js';
import { buildCampaignListEmbed } from '../embeds/campaign.embeds.js';
import { buildCampaignSelectMenu } from '../components/campaign.components.js';

export const data = new SlashCommandBuilder()
  .setName('campaigns')
  .setDescription('Browse active clipping campaigns and manage your memberships');

/**
 * Execute /campaigns command
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  await interaction.deferReply();

  // 1. Sync user identity
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  // 2. Query campaigns and user's current memberships
  const [activeCampaigns, userMemberships] = await Promise.all([
    campaignService.listActiveCampaigns(),
    campaignService.getUserCampaigns(user.id)
  ]);

  // 3. Build UI
  const embed = buildCampaignListEmbed(activeCampaigns, userMemberships);
  const selectMenuRow = buildCampaignSelectMenu(activeCampaigns);

  const components = selectMenuRow ? [selectMenuRow] : [];

  await interaction.editReply({
    embeds: [embed],
    components
  });
}
