import { SlashCommandBuilder } from 'discord.js';
import { userService } from '../../modules/users/user.service.js';
import { campaignService } from '../../modules/campaigns/campaign.service.js';
import { buildCampaignPickerForSubmit, buildSubmitModal } from '../components/submission.components.js';

export const data = new SlashCommandBuilder()
  .setName('submit')
  .setDescription('Submit a video/clip URL for an active campaign you have joined');

/**
 * Execute /submit command
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  const user = await userService.getOrCreateFromDiscord(interaction.user);
  userService.assertUserCanParticipate(user);

  const memberships = await campaignService.getUserCampaigns(user.id);
  const activeMemberships = memberships.filter(
    (m) => m.status === 'ACTIVE' && m.campaign && m.campaign.status === 'ACTIVE'
  );

  if (activeMemberships.length === 0) {
    await interaction.reply({
      content: `⚠️ <@${interaction.user.id}> You have not joined any active campaigns yet.\nUse \`/campaigns\` to browse available campaigns and click **Join Campaign** first. *(Auto-dismissing in 15s)*`
    });
    setTimeout(() => {
      interaction.deleteReply().catch(() => {});
    }, 15000);
    return;
  }

  // If user is enrolled in exactly one active campaign, show modal immediately
  if (activeMemberships.length === 1) {
    const single = activeMemberships[0];
    const modal = buildSubmitModal(single.campaign.id, single.campaign.name, single.campaign);
    await interaction.showModal(modal);
    return;
  }

  // If user is enrolled in multiple active campaigns, present selection menu
  const pickerRow = buildCampaignPickerForSubmit(activeMemberships);
  await interaction.reply({
    content: `🎯 <@${interaction.user.id}> **Select the campaign** you are submitting this clip for: *(Auto-dismissing in 30s)*`,
    components: [pickerRow]
  });

  setTimeout(() => {
    interaction.deleteReply().catch(() => {});
  }, 30000);
}
