import { MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { Prisma } from '@prisma/client';
import { userService } from '../../modules/users/user.service.js';
import { payoutService } from '../../modules/payouts/payout.service.js';
import { payoutProfileService, PayoutProfileError } from '../../modules/payout-profile/payout-profile.service.js';
import { payoutDraftManager } from '../../modules/payouts/payout-draft.manager.js';
import { payoutUploadSessionManager } from '../../modules/payouts/payout-upload-session.manager.js';
import { validateEvidenceFile, EvidenceValidationError } from '../../modules/evidence/evidence.validator.js';
import {
  InsufficientBalanceError,
  BelowMinimumPayoutError,
  PayoutEvidenceRequiredError
} from '../../modules/payouts/payout.errors.js';
import {
  buildUserPayoutEmbed,
  buildPayoutSuccessEmbed,
  buildPayoutProfileEmbed,
  buildPayoutEvidenceInstructionsEmbed,
  buildPayoutEvidenceWaitingEmbed,
  buildPayoutEvidenceReceivedEmbed,
  buildPayoutReviewEmbed,
  buildPayoutSubmittedEmbed
} from '../embeds/payout.embeds.js';
import {
  buildPayoutActionRow,
  buildPayoutModal,
  buildPayoutProfileModal,
  buildPayoutCancelConfirmActionRow,
  buildPayoutProfileSavedActionRow,
  buildPayoutEvidenceActionRow,
  buildPayoutEvidenceReceivedActionRow,
  buildPayoutReviewActionRow
} from '../components/payout.components.js';
import { enforcePayoutRateLimit } from '../../utils/rate-limiter.js';
import { logger } from '../../utils/logger.js';

/**
 * Handle "Request Payout" button click, opening the input modal
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} targetUserId
 */
export async function handlePayoutRequestButton(interaction, targetUserId) {
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.reply({
      content: '❌ You can only request payouts for your own account.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const profile = await payoutProfileService.getProfileByUserId(user.id).catch(() => null);
  if (!profile || !profile.walletAddress || !profile.network) {
    const modal = buildPayoutProfileModal(user.id, profile);
    await interaction.showModal(modal);
    return;
  }

  const balance = await payoutService.getAvailablePayoutBalance(user.id);
  const modal = buildPayoutModal(user.id, balance.availableBalance.toFixed(2), balance.currency);
  await interaction.showModal(modal);
}

/**
 * Handle payout modal submit
 * Validates amount, balance, and profile, then creates a guided draft and presents
 * Required Analytics Screen Recording instructions.
 * DOES NOT create PayoutRequest or reserve funds until evidence is uploaded & confirmed.
 *
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {string} targetUserId
 */
export async function handlePayoutModalSubmit(interaction, targetUserId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.editReply({
      content: '❌ You can only request payouts for your own account.'
    });
    return;
  }

  // Rate limiting protection
  enforcePayoutRateLimit(user.id);

  const rawAmount = interaction.fields.getTextInputValue('payout_amount_input').trim();
  const parsedNum = Number(rawAmount);
  if (isNaN(parsedNum) || parsedNum <= 0) {
    await interaction.editReply({
      content: '❌ Please enter a valid positive payout amount.'
    });
    return;
  }

  const requestedAmount = new Prisma.Decimal(parsedNum.toFixed(2));

  // Authoritatively derive current balance & minimum payout
  const balance = await payoutService.getAvailablePayoutBalance(user.id);

  if (requestedAmount.lessThan(balance.minimumPayout)) {
    throw new BelowMinimumPayoutError(
      requestedAmount.toFixed(2),
      balance.minimumPayout.toFixed(2),
      balance.currency
    );
  }

  if (requestedAmount.greaterThan(balance.availableBalance)) {
    throw new InsufficientBalanceError(
      requestedAmount.toFixed(2),
      balance.availableBalance.toFixed(2),
      balance.currency
    );
  }

  // Verify payout profile
  const profile = await payoutProfileService.getProfileByUserId(user.id).catch(() => null);
  if (!profile || !profile.walletAddress || !profile.network) {
    throw new PayoutProfileError('A payout profile must be configured before requesting a payout.', 'PROFILE_REQUIRED');
  }

  const profileSnapshot = {
    profileId: profile.id,
    walletAddress: profile.walletAddress,
    network: profile.network,
    walletName: profile.walletName,
    creatorHandle: profile.creatorHandle,
    platform: profile.platform,
    snapshottedAt: new Date().toISOString()
  };

  // Initialize draft session (DO NOT create PayoutRequest; DO NOT reserve funds)
  payoutDraftManager.createDraft(user.id, {
    amount: requestedAmount.toFixed(2),
    currency: balance.currency,
    profileSnapshot
  });

  // Activate authoritative upload session tied to Discord user, guild, and channel
  await payoutUploadSessionManager.createSession({
    discordUserId: interaction.user.id,
    userId: user.id,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    amount: requestedAmount.toFixed(2),
    currency: balance.currency,
    profileSnapshot
  });

  // Display Required Analytics Verification Screen
  const embed = buildPayoutEvidenceInstructionsEmbed({
    amount: requestedAmount.toFixed(2),
    currency: balance.currency,
    profile
  });
  const row = buildPayoutEvidenceActionRow(user.id);

  await interaction.editReply({
    embeds: [embed],
    components: [row]
  });
}

/**
 * Handle "Upload Recording" button click
 * Activates / refreshes the upload session and displays the upload prompt.
 * The messageCreate event handler authoritatively processes the attachment when sent.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} targetUserId
 */
export async function handlePayoutEvidenceUploadButton(interaction, targetUserId) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({ content: '❌ Unauthorized.', flags: MessageFlags.Ephemeral });
    return;
  }

  const draft = payoutDraftManager.getDraft(user.id);
  if (!draft) {
    await interaction.editReply({
      content: '⚠️ No active payout request in progress. Please start by clicking **Request Payout**.',
      embeds: [],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`payout_request_btn:${user.id}`)
            .setLabel('Request Payout')
            .setStyle(ButtonStyle.Primary)
        )
      ]
    });
    return;
  }

  // Activate / refresh authoritative upload session with fresh 2-minute TTL
  await payoutUploadSessionManager.createSession({
    discordUserId: interaction.user.id,
    userId: user.id,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    amount: draft.amount,
    currency: draft.currency,
    profileSnapshot: draft.profileSnapshot
  });

  const waitingEmbed = buildPayoutEvidenceWaitingEmbed();

  const cancelRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`payout_ev_cancel:${user.id}`)
      .setLabel('Cancel')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({
    embeds: [waitingEmbed],
    components: [cancelRow]
  });
}

/**
 * Handle "Continue to Review" button click
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} targetUserId
 */
export async function handlePayoutEvidenceReviewButton(interaction, targetUserId) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({ content: '❌ Unauthorized.', flags: MessageFlags.Ephemeral });
    return;
  }

  const draft = payoutDraftManager.getDraft(user.id);
  if (!draft || !draft.evidence) {
    await interaction.editReply({
      content: '⚠️ Please upload a valid analytics screen recording before proceeding to review.',
      embeds: [],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`payout_request_btn:${user.id}`)
            .setLabel('Request Payout')
            .setStyle(ButtonStyle.Primary)
        )
      ]
    });
    return;
  }

  const reviewEmbed = buildPayoutReviewEmbed({
    amount: draft.amount,
    currency: draft.currency,
    profile: draft.profileSnapshot,
    evidence: draft.evidence
  });
  const reviewRow = buildPayoutReviewActionRow(user.id);

  await interaction.editReply({
    content: '',
    embeds: [reviewEmbed],
    components: [reviewRow]
  });
}

/**
 * Handle "Submit Payout" confirmation button click
 * Transactionally creates PayoutRequest, attaches evidence, reserves funds, and records PayoutEvent.
 * ONLY this step creates the actual PayoutRequest.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} targetUserId
 */
export async function handlePayoutEvidenceSubmitButton(interaction, targetUserId) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({ content: '❌ Unauthorized.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Atomically consume draft to prevent concurrent double-clicks
  const draft = payoutDraftManager.consumeDraft(user.id);
  if (!draft || !draft.evidence) {
    await interaction.editReply({
      content: '⚠️ No valid payout request draft with attached evidence found. Please start by clicking **Request Payout**.',
      embeds: [],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`payout_request_btn:${user.id}`)
            .setLabel('Request Payout')
            .setStyle(ButtonStyle.Primary)
        )
      ]
    });
    return;
  }

  // Execute atomic payout creation with evidence attached
  const payout = await payoutService.createPayoutRequest(
    user.id,
    draft.amount,
    draft.currency,
    {
      evidence: draft.evidence,
      profileSnapshot: draft.profileSnapshot,
      enforceEvidence: true
    }
  );

  // Clear upload session now that payout request has been created
  await payoutUploadSessionManager.clearSession(interaction.user.id);

  const submittedEmbed = buildPayoutSubmittedEmbed(payout);
  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`dash_payout:${user.id}`)
      .setLabel('Payout Hub')
      .setEmoji('🏦')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`dash_home:${user.id}`)
      .setLabel('Dashboard')
      .setEmoji('🏠')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({
    content: '',
    embeds: [submittedEmbed],
    components: [navRow]
  });
}

/**
 * Handle "Cancel" button click during payout evidence flow
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} targetUserId
 */
export async function handlePayoutEvidenceCancelButton(interaction, targetUserId) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({ content: '❌ Unauthorized.', flags: MessageFlags.Ephemeral });
    return;
  }

  payoutDraftManager.clearDraft(user.id);
  await payoutUploadSessionManager.clearSession(interaction.user.id);

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`dash_payout:${user.id}`)
      .setLabel('Payout Hub')
      .setEmoji('🏦')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`dash_home:${user.id}`)
      .setLabel('Dashboard')
      .setEmoji('🏠')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({
    content: '❌ **Payout Request Cancelled**\nNo funds were reserved and no payout request was created.',
    embeds: [],
    components: [navRow]
  });
}

/**
 * Handle "Back" button click in payout review
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} targetUserId
 */
export async function handlePayoutEvidenceBackButton(interaction, targetUserId) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({ content: '❌ Unauthorized.', flags: MessageFlags.Ephemeral });
    return;
  }

  const draft = payoutDraftManager.getDraft(user.id);
  if (!draft) {
    await interaction.editReply({
      content: '⚠️ No active payout request in progress. Please start by clicking **Request Payout**.',
      embeds: [],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`payout_request_btn:${user.id}`)
            .setLabel('Request Payout')
            .setStyle(ButtonStyle.Primary)
        )
      ]
    });
    return;
  }

  const embed = buildPayoutEvidenceInstructionsEmbed({
    amount: draft.amount,
    currency: draft.currency,
    profile: draft.profileSnapshot
  });
  const row = buildPayoutEvidenceActionRow(user.id);

  await interaction.editReply({
    content: '',
    embeds: [embed],
    components: [row]
  });
}

/**
 * Handle "Payout Profile" button click, opening the profile configuration modal
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} targetUserId
 */
export async function handlePayoutProfileButton(interaction, targetUserId) {
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.reply({
      content: '❌ You can only manage payout profiles for your own account.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const profile = await payoutProfileService.getProfileByUserId(user.id).catch(() => null);
  const modal = buildPayoutProfileModal(user.id, profile);
  await interaction.showModal(modal);
}

/**
 * Handle payout profile modal submit
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {string} targetUserId
 */
export async function handlePayoutProfileModalSubmit(interaction, targetUserId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId !== user.id) {
    await interaction.editReply({
      content: '❌ You can only manage payout profiles for your own account.'
    });
    return;
  }

  const walletAddress = interaction.fields.getTextInputValue('profile_wallet_address').trim();
  const network = interaction.fields.getTextInputValue('profile_network').trim();
  let walletName = null;
  try {
    walletName = interaction.fields.getTextInputValue('profile_wallet_name')?.trim() || null;
  } catch {
    // optional field
  }

  // Identity is tied directly to creator's Discord account
  const discordHandle = interaction.user.tag || `@${interaction.user.username}` || interaction.user.username || 'Creator';

  const actor = {
    userId: user.id,
    discordId: interaction.user.id,
    username: interaction.user.username
  };

  const existing = await payoutProfileService.getProfileByUserId(user.id).catch(() => null);
  let saved;
  if (existing) {
    saved = await payoutProfileService.updateProfile(
      user.id,
      {
        walletAddress,
        network,
        walletName: walletName || 'Standard',
        creatorHandle: existing.creatorHandle || discordHandle
      },
      actor
    );
  } else {
    saved = await payoutProfileService.createProfile(
      user.id,
      {
        walletAddress,
        network,
        walletName: walletName || 'Standard',
        creatorHandle: discordHandle,
        platform: 'YOUTUBE'
      },
      actor
    );
  }

  const embed = buildPayoutProfileEmbed(saved, interaction.user);
  const actionRow = buildPayoutProfileSavedActionRow(user.id);
  await interaction.editReply({
    content: '✅ **Payout Profile Saved Successfully!**',
    embeds: [embed],
    components: [actionRow]
  });
}

/**
 * Handle refresh button on payout view
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} targetUserId
 */
export async function handlePayoutRefresh(interaction, targetUserId) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId && targetUserId !== user.id && targetUserId !== user.discordId) {
    await interaction.followUp({
      content: '❌ You can only refresh your own payout dashboard.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  logger.debug({ userId: user.id }, 'Refreshing payout dashboard from database');

  const [balance, history, profile] = await Promise.all([
    payoutService.getAvailablePayoutBalance(user.id),
    payoutService.getUserPayoutHistory(user.id),
    payoutProfileService.getProfileByUserId(user.id).catch(() => null)
  ]);

  const isEligible = balance.availableBalance.greaterThanOrEqualTo(balance.minimumPayout);
  const activeCancellablePayout = history.find((p) =>
    ['REQUESTED', 'UNDER_REVIEW', 'APPROVED'].includes(p.status)
  ) || null;
  const embed = buildUserPayoutEmbed(balance, history, interaction.user, profile);
  const row = buildPayoutActionRow(user.id, isEligible, activeCancellablePayout, Boolean(profile));

  await interaction.editReply({
    embeds: [embed],
    components: [row]
  });
}

/**
 * Handle "Cancel Payout" button click, showing confirmation modal/prompt
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} targetUserId
 * @param {string} payoutId
 */
export async function handlePayoutCancelButton(interaction, targetUserId, payoutId) {
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId !== user.id) {
    await interaction.reply({
      content: '❌ You can only cancel your own payout requests.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const payout = await payoutService.repo.getPayoutRequestById(payoutId);
  if (!payout) {
    await interaction.reply({
      content: '❌ Payout request not found.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!['REQUESTED', 'UNDER_REVIEW', 'APPROVED'].includes(payout.status)) {
    await interaction.reply({
      content: `❌ This payout cannot be cancelled because it is already in \`${payout.status}\` status.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const row = buildPayoutCancelConfirmActionRow(user.id, payout.id);

  await interaction.reply({
    content:
      `**Cancel this payout request?**\n\n` +
      `**$${Number(payout.amount).toFixed(2)}** will be released back to your available balance.\n\n` +
      `You can request a payout again later.`,
    components: [row],
    flags: MessageFlags.Ephemeral
  });
}

/**
 * Handle confirmation of payout cancellation
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} targetUserId
 * @param {string} payoutId
 */
export async function handlePayoutCancelConfirm(interaction, targetUserId, payoutId) {
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId !== user.id) {
    await interaction.reply({
      content: '❌ You can only cancel your own payout requests.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  try {
    const cancelled = await payoutService.cancelPayoutRequest(
      user.id,
      payoutId,
      'Cancelled by creator via Discord'
    );

    await interaction.update({
      content:
        `✅ **Payout cancelled.**\n\n` +
        `**$${Number(cancelled.amount).toFixed(2)}** has been released back to your available balance.\n\n` +
        `You can request it again whenever you're ready.`,
      components: []
    });
  } catch (err) {
    logger.error({ payoutId, err: err.message }, 'Failed to cancel payout request');
    await interaction.update({
      content: `❌ Could not cancel payout: ${err.message}`,
      components: []
    });
  }
}

/**
 * Handle keeping payout request (declining cancellation)
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} targetUserId
 * @param {string} payoutId
 */
export async function handlePayoutCancelKeep(interaction, targetUserId, payoutId) {
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  if (targetUserId !== user.id) {
    await interaction.reply({
      content: '❌ Unauthorized.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.update({
    content: 'ℹ️ **Payout request retained.** Your funds remain reserved for review and disbursement.',
    components: []
  });
}

