import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ActionRowBuilder
} from 'discord.js';
import { STAFF_COMPONENTS } from './staffComponentIds.js';

/**
 * Build Submission Rejection Modal
 */
export function buildSubmissionRejectModal(submissionId) {
  const modal = new ModalBuilder()
    .setCustomId(`${STAFF_COMPONENTS.SUB_REJECT_MODAL}:${submissionId}`)
    .setTitle('Reject Submission');

  const reasonInput = new TextInputBuilder()
    .setCustomId('reason')
    .setLabel('Rejection Reason')
    .setPlaceholder('e.g. SUSPICIOUS_ENGAGEMENT, CAMPAIGN_REQUIREMENT_VIOLATION, OTHER')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  const notesInput = new TextInputBuilder()
    .setCustomId('notes')
    .setLabel('Staff / Creator Notes')
    .setPlaceholder('Detailed explanation for creator and audit log')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(500);

  modal.addComponents(
    new ActionRowBuilder().addComponents(reasonInput),
    new ActionRowBuilder().addComponents(notesInput)
  );

  return modal;
}

/**
 * Build Payout Rejection Modal
 */
export function buildPayoutRejectModal(payoutId) {
  const modal = new ModalBuilder()
    .setCustomId(`${STAFF_COMPONENTS.PAYOUT_REJECT_MODAL}:${payoutId}`)
    .setTitle('Reject Payout Request');

  const reasonInput = new TextInputBuilder()
    .setCustomId('reason')
    .setLabel('Rejection Reason')
    .setPlaceholder('e.g. Telemetry mismatch, invalid wallet, suspicious views')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(300);

  modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
  return modal;
}

/**
 * Build Evidence Rejection Modal
 */
export function buildEvidenceRejectModal(evidenceId) {
  const modal = new ModalBuilder()
    .setCustomId(`${STAFF_COMPONENTS.EV_REJECT_MODAL}:${evidenceId}`)
    .setTitle('Reject Analytics Recording');

  const reasonInput = new TextInputBuilder()
    .setCustomId('reason')
    .setLabel('Structured Reason')
    .setPlaceholder('DURATION_EXCEEDED, TELEMETRY_MISMATCH, WRONG_ACCOUNT, OTHER')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  const notesInput = new TextInputBuilder()
    .setCustomId('notes')
    .setLabel('Creator Guidance')
    .setPlaceholder('Explain why recording was rejected and what to re-record')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(500);

  modal.addComponents(
    new ActionRowBuilder().addComponents(reasonInput),
    new ActionRowBuilder().addComponents(notesInput)
  );

  return modal;
}

/**
 * Build Creator Search Modal
 */
export function buildCreatorSearchModal() {
  const modal = new ModalBuilder()
    .setCustomId(STAFF_COMPONENTS.CR_SEARCH_MODAL)
    .setTitle('Search Creator');

  const queryInput = new TextInputBuilder()
    .setCustomId('query')
    .setLabel('Discord ID, Username, or Display Name')
    .setPlaceholder('e.g. 978305861430693960 or harshdevil15')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  modal.addComponents(new ActionRowBuilder().addComponents(queryInput));
  return modal;
}

/**
 * Build Quick Campaign Provisioning Modal
 */
export function buildCampaignCreateModal() {
  const modal = new ModalBuilder()
    .setCustomId(STAFF_COMPONENTS.CMP_CREATE_MODAL)
    .setTitle('Create New Campaign');

  const nameInput = new TextInputBuilder()
    .setCustomId('name')
    .setLabel('Campaign Name')
    .setPlaceholder('e.g. Apex Legends Clips Sprint')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  const clientInput = new TextInputBuilder()
    .setCustomId('client')
    .setLabel('Client / Sponsor Name')
    .setPlaceholder('e.g. Electronic Arts')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  const ratesInput = new TextInputBuilder()
    .setCustomId('cpm_budget')
    .setLabel('CPM Rate & Total Budget (USD)')
    .setPlaceholder('e.g. 1.20 / 3000 (Pay Rate / Budget)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  const platformSelect = new StringSelectMenuBuilder()
    .setCustomId('platforms')
    .setPlaceholder('Select allowed platforms (YouTube, TikTok, Instagram, Facebook)')
    .setMinValues(1)
    .setMaxValues(4)
    .addOptions([
      new StringSelectMenuOptionBuilder()
        .setLabel('YouTube')
        .setValue('youtube')
        .setDescription('YouTube Shorts & Videos')
        .setEmoji('▶️')
        .setDefault(true),
      new StringSelectMenuOptionBuilder()
        .setLabel('TikTok')
        .setValue('tiktok')
        .setDescription('TikTok Video Clips')
        .setEmoji('🎵')
        .setDefault(true),
      new StringSelectMenuOptionBuilder()
        .setLabel('Instagram')
        .setValue('instagram')
        .setDescription('Instagram Reels')
        .setEmoji('📸')
        .setDefault(true),
      new StringSelectMenuOptionBuilder()
        .setLabel('Facebook')
        .setValue('facebook')
        .setDescription('Facebook Reels & Videos')
        .setEmoji('📘')
        .setDefault(true)
    ]);

  const descInput = new TextInputBuilder()
    .setCustomId('description')
    .setLabel('Campaign Description & Guidelines')
    .setPlaceholder('Campaign overview, clipping guidelines, hashtags, rules...')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(2000);

  modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(clientInput),
    new ActionRowBuilder().addComponents(ratesInput),
    new ActionRowBuilder().addComponents(platformSelect),
    new ActionRowBuilder().addComponents(descInput)
  );

  return modal;
}

/**
 * Build Submission Search Modal
 */
export function buildSubmissionSearchModal() {
  const modal = new ModalBuilder()
    .setCustomId(STAFF_COMPONENTS.SUB_SEARCH_MODAL)
    .setTitle('Search Submissions');

  const queryInput = new TextInputBuilder()
    .setCustomId('query')
    .setLabel('Submission ID, URL, or Creator Handle')
    .setPlaceholder('e.g. sub_123, harshdevil15, or https://...')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(200);

  modal.addComponents(new ActionRowBuilder().addComponents(queryInput));
  return modal;
}

/**
 * Build Manual Metrics Input Modal
 * Used for platforms requiring manual verification (e.g. Facebook) or staff overrides.
 *
 * @param {string} submissionId
 * @returns {ModalBuilder}
 */
export function buildStaffManualMetricsModal(submissionId) {
  const modal = new ModalBuilder()
    .setCustomId(`${STAFF_COMPONENTS.SUB_MANUAL_MODAL}:${submissionId}`)
    .setTitle('Enter Verified Metrics');

  const viewsInput = new TextInputBuilder()
    .setCustomId('views')
    .setLabel('Views Count (Required)')
    .setPlaceholder('e.g. 15000')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(20);

  const likesInput = new TextInputBuilder()
    .setCustomId('likes')
    .setLabel('Likes Count (Optional)')
    .setPlaceholder('e.g. 850')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(20);

  const commentsInput = new TextInputBuilder()
    .setCustomId('comments')
    .setLabel('Comments Count (Optional)')
    .setPlaceholder('e.g. 42')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(20);

  const sharesInput = new TextInputBuilder()
    .setCustomId('shares')
    .setLabel('Shares Count (Optional)')
    .setPlaceholder('e.g. 15')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(20);

  const notesInput = new TextInputBuilder()
    .setCustomId('notes')
    .setLabel('Verification Notes (Optional)')
    .setPlaceholder('e.g. Verified via official Facebook reel inspection')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(500);

  modal.addComponents(
    new ActionRowBuilder().addComponents(viewsInput),
    new ActionRowBuilder().addComponents(likesInput),
    new ActionRowBuilder().addComponents(commentsInput),
    new ActionRowBuilder().addComponents(sharesInput),
    new ActionRowBuilder().addComponents(notesInput)
  );

  return modal;
}

