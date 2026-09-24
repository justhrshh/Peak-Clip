import { MessageFlags } from 'discord.js';
import { userService } from '../../modules/users/user.service.js';
import { campaignService } from '../../modules/campaigns/campaign.service.js';
import {
  buildCampaignListEmbed,
  buildCampaignDetailEmbed,
  buildJoinSuccessEmbed,
  buildLeaveSuccessEmbed
} from '../embeds/campaign.embeds.js';
import {
  buildCampaignSelectMenu,
  buildCampaignActionRow
} from '../components/campaign.components.js';

/**
 * Handle campaign dropdown selection
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
export async function handleCampaignSelect(interaction) {
  await interaction.deferUpdate();

  const campaignId = interaction.values[0];
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  const [campaign, memberships] = await Promise.all([
    campaignService.getCampaignById(campaignId),
    campaignService.getUserCampaigns(user.id)
  ]);

  const membership = memberships.find((m) => m.campaignId === campaign.id && m.status === 'ACTIVE');
  const embed = buildCampaignDetailEmbed(campaign, membership);
  const actionRow = buildCampaignActionRow(campaign.id, Boolean(membership), campaign);

  await interaction.editReply({
    embeds: [embed],
    components: [actionRow]
  });
}

/**
 * Handle joining a campaign via button
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} campaignId
 */
export async function handleCampaignJoin(interaction, campaignId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user = await userService.getOrCreateFromDiscord(interaction.user);
  await campaignService.joinCampaign(user.id, campaignId);
  const campaign = await campaignService.getCampaignById(campaignId);

  const successEmbed = buildJoinSuccessEmbed(campaign);
  await interaction.editReply({ embeds: [successEmbed] });

  // Update the original message view to reflect new membership status
  if (interaction.message?.editable) {
    const updatedEmbed = buildCampaignDetailEmbed(campaign, { status: 'ACTIVE' });
    const actionRow = buildCampaignActionRow(campaign.id, true, campaign);
    await interaction.message.edit({
      embeds: [updatedEmbed],
      components: [actionRow]
    });
  }
}

/**
 * Handle leaving a campaign via button
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} campaignId
 */
export async function handleCampaignLeave(interaction, campaignId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user = await userService.getOrCreateFromDiscord(interaction.user);
  await campaignService.leaveCampaign(user.id, campaignId);
  const campaign = await campaignService.getCampaignById(campaignId);

  const leaveEmbed = buildLeaveSuccessEmbed(campaign);
  await interaction.editReply({ embeds: [leaveEmbed] });

  // Update original message view to reflect inactive status
  if (interaction.message?.editable) {
    const updatedEmbed = buildCampaignDetailEmbed(campaign, { status: 'LEFT' });
    const actionRow = buildCampaignActionRow(campaign.id, false, campaign);
    await interaction.message.edit({
      embeds: [updatedEmbed],
      components: [actionRow]
    });
  }
}

/**
 * Return to active campaign list
 * @param {import('discord.js').ButtonInteraction} interaction
 */
export async function handleCampaignList(interaction) {
  await interaction.deferUpdate();

  const user = await userService.getOrCreateFromDiscord(interaction.user);
  const [activeCampaigns, userMemberships] = await Promise.all([
    campaignService.listActiveCampaigns(),
    campaignService.getUserCampaigns(user.id)
  ]);

  const embed = buildCampaignListEmbed(activeCampaigns, userMemberships);
  const selectMenuRow = buildCampaignSelectMenu(activeCampaigns);

  await interaction.editReply({
    embeds: [embed],
    components: selectMenuRow ? [selectMenuRow] : []
  });
}

