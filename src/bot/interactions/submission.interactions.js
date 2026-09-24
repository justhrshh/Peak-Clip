import { MessageFlags } from 'discord.js';
import { userService } from '../../modules/users/user.service.js';
import { campaignService } from '../../modules/campaigns/campaign.service.js';
import { submissionService } from '../../modules/submissions/submission.service.js';
import { buildSubmitModal, buildSubmissionsPaginationRow, buildCampaignPickerForSubmit } from '../components/submission.components.js';
import { buildSubmissionSuccessEmbed, buildUserSubmissionsEmbed } from '../embeds/submission.embeds.js';
import { enforceSubmissionRateLimit } from '../../utils/rate-limiter.js';

/**
 * Handle campaign selection dropdown in /submit flow, triggering the URL input modal
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
export async function handleCampaignSelectForSubmit(interaction) {
  const campaignId = interaction.values[0];
  const campaign = await campaignService.getCampaignById(campaignId);

  const modal = buildSubmitModal(campaign.id, campaign.name, campaign);
  await interaction.showModal(modal);

  // Clean up the campaign picker message so it does not stay behind
  if (interaction.message && typeof interaction.message.delete === 'function') {
    interaction.message.delete().catch(() => {});
  }
}

/**
 * Handle modal submission for video clip URL
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {string} campaignId
 */
export async function handleModalSubmitClip(interaction, campaignId) {
  // Non-ephemeral reply allows Discord to delete it programmatically
  await interaction.deferReply();

  const rawUrl = interaction.fields.getTextInputValue('submit:url_input');
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  // Rate limiting protection
  enforceSubmissionRateLimit(user.id);

  const submission = await submissionService.createSubmission({
    userId: user.id,
    campaignId,
    rawUrl
  });

  const campaign = await campaignService.getCampaignById(campaignId);
  const successEmbed = buildSubmissionSuccessEmbed(submission, campaign);

  await interaction.editReply({
    content: `✅ <@${interaction.user.id}> **Video submitted successfully!** *(Auto-dismissing in 10s)*`,
    embeds: [successEmbed]
  });

  // Automatically delete / dismiss after 10 seconds
  setTimeout(() => {
    if (typeof interaction.deleteReply === 'function') {
      interaction.deleteReply().catch(() => {});
    }
  }, 10000);
}

/**
 * Handle pagination buttons in /submissions view
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {number} targetPage
 */
export async function handleSubmissionsPagination(interaction, targetPage) {
  await interaction.deferUpdate();

  const user = await userService.getOrCreateFromDiscord(interaction.user);
  const result = await submissionService.getUserSubmissions(user.id, {
    page: targetPage,
    limit: 5
  });

  const embed = buildUserSubmissionsEmbed(result);
  const components =
    result.totalPages > 1 ? [buildSubmissionsPaginationRow(result.page, result.totalPages)] : [];

  await interaction.editReply({
    embeds: [embed],
    components
  });
}

/**
 * Handle persistent [ 🎬 Submit Clip ] button click in #submissions channel
 * @param {import('discord.js').ButtonInteraction} interaction
 */
export async function handlePublicSubmitClip(interaction) {
  const user = await userService.getOrCreateFromDiscord(interaction.user);
  userService.assertUserCanParticipate(user);

  const memberships = await campaignService.getUserCampaigns(user.id);
  const activeMemberships = memberships.filter(
    (m) => m.status === 'ACTIVE' && m.campaign && m.campaign.status === 'ACTIVE'
  );

  if (activeMemberships.length === 0) {
    await interaction.reply({
      content: `⚠️ <@${interaction.user.id}> You have not joined any active campaigns yet.\nBrowse **#campaigns** to review requirements and click **Join Campaign** first.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (activeMemberships.length === 1) {
    const single = activeMemberships[0];
    const modal = buildSubmitModal(single.campaign.id, single.campaign.name, single.campaign);
    await interaction.showModal(modal);
    return;
  }

  const pickerRow = buildCampaignPickerForSubmit(activeMemberships);
  await interaction.reply({
    content: `🎯 <@${interaction.user.id}> **Select the campaign** you are submitting this clip for: *(Auto-dismissing in 30s)*`,
    components: [pickerRow]
  });

  setTimeout(() => {
    if (typeof interaction.deleteReply === 'function') {
      interaction.deleteReply().catch(() => {});
    }
  }, 30000);
}
