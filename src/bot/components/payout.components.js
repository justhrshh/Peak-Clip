import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';

/**
 * Build action row for Payout dashboard: [Request Payout] [Profile] [Cancel Payout (if cancellable)] [Refresh]
 * @param {string} userId
 * @param {boolean} isEligible - Whether available balance >= minimum payout
 * @param {object|null} [activeCancellablePayout=null] - Active payout eligible for cancellation
 * @param {boolean} [hasProfile=false]
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildPayoutActionRow(userId, isEligible, activeCancellablePayout = null, hasProfile = false) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`payout_request_btn:${userId}`)
      .setLabel('Request Payout')
      .setEmoji('💸')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!isEligible),
    new ButtonBuilder()
      .setCustomId(`payout_profile_btn:${userId}`)
      .setLabel(hasProfile ? 'Payout Profile' : 'Set Up Profile')
      .setEmoji('💳')
      .setStyle(ButtonStyle.Primary)
  );

  if (activeCancellablePayout) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`payout_cancel_btn:${userId}:${activeCancellablePayout.id}`)
        .setLabel('Cancel Payout')
        .setEmoji('🛑')
        .setStyle(ButtonStyle.Danger)
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`payout_refresh:${userId}`)
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary)
  );

  return row;
}

/**
 * Build action row for payout cancellation confirmation
 * @param {string} userId
 * @param {string} payoutId
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildPayoutCancelConfirmActionRow(userId, payoutId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`payout_cancel_confirm:${userId}:${payoutId}`)
      .setLabel('Confirm Cancellation')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`payout_cancel_keep:${userId}:${payoutId}`)
      .setLabel('Keep Payout')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Build modal to input requested payout amount
 * @param {string} userId
 * @param {string} maxAvailable
 * @param {string} currency
 * @returns {ModalBuilder}
 */
export function buildPayoutModal(userId, maxAvailable, currency) {
  const modal = new ModalBuilder()
    .setCustomId(`payout_modal:${userId}`)
    .setTitle(`Request Payout (${currency})`);

  const amountInput = new TextInputBuilder()
    .setCustomId('payout_amount_input')
    .setLabel(`Amount to Payout (Max: ${maxAvailable})`)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(`e.g. ${maxAvailable}`)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(12);

  const row = new ActionRowBuilder().addComponents(amountInput);
  modal.addComponents(row);

  return modal;
}

/**
 * Build modal to configure or update creator payout profile
 * @param {string} userId
 * @param {object|null} [existingProfile=null]
 * @returns {ModalBuilder}
 */
export function buildPayoutProfileModal(userId, existingProfile = null) {
  const modal = new ModalBuilder()
    .setCustomId(`payout_profile_modal:${userId}`)
    .setTitle(existingProfile ? 'Update Payout Profile' : 'Set Up Payout Profile');

  const walletInput = new TextInputBuilder()
    .setCustomId('profile_wallet_address')
    .setLabel('Public Wallet Address')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 0x71C... or solana address (public only)')
    .setRequired(true)
    .setMaxLength(100);

  if (existingProfile?.walletAddress) {
    walletInput.setValue(existingProfile.walletAddress);
  }

  const networkInput = new TextInputBuilder()
    .setCustomId('profile_network')
    .setLabel('Network / Blockchain')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. Ethereum, Polygon, Solana, Bitcoin, Arbitrum')
    .setRequired(true)
    .setMaxLength(50);

  if (existingProfile?.network) {
    networkInput.setValue(existingProfile.network);
  }

  const walletNameInput = new TextInputBuilder()
    .setCustomId('profile_wallet_name')
    .setLabel('Wallet App / Name (Optional)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. MetaMask, Phantom, Ledger, Coinbase')
    .setRequired(false)
    .setMaxLength(50);

  if (existingProfile?.walletName) {
    walletNameInput.setValue(existingProfile.walletName);
  }

  modal.addComponents(
    new ActionRowBuilder().addComponents(walletInput),
    new ActionRowBuilder().addComponents(networkInput),
    new ActionRowBuilder().addComponents(walletNameInput)
  );

  return modal;
}

/**
 * Build progression action row displayed after saving a payout profile
 * Eliminates dead-end screens so creator can proceed immediately to request payouts or view dashboard.
 *
 * @param {string} userId
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildPayoutProfileSavedActionRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`payout_request_btn:${userId}`)
      .setLabel('Request Payout')
      .setEmoji('💸')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`dash_payout:${userId}`)
      .setLabel('Payout Hub')
      .setEmoji('🏦')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`dash_home:${userId}`)
      .setLabel('Dashboard')
      .setEmoji('🏠')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`payout_profile_btn:${userId}`)
      .setLabel('Edit Profile')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Build action row for required screen recording instructions screen
 * @param {string} userId
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildPayoutEvidenceActionRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`payout_ev_upload:${userId}`)
      .setLabel('Upload Recording')
      .setEmoji('📹')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`payout_ev_cancel:${userId}`)
      .setLabel('Cancel')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Build action row after evidence is successfully uploaded & validated
 * @param {string} userId
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildPayoutEvidenceReceivedActionRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`payout_ev_review:${userId}`)
      .setLabel('Continue to Review')
      .setEmoji('➡️')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`payout_ev_upload:${userId}`)
      .setLabel('Replace Recording')
      .setEmoji('📹')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`payout_ev_cancel:${userId}`)
      .setLabel('Cancel')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Build action row for final payout review screen
 * ONLY the Submit Payout button creates the actual PayoutRequest and reserves funds.
 * @param {string} userId
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildPayoutReviewActionRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`payout_ev_submit:${userId}`)
      .setLabel('Submit Payout')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`payout_ev_back:${userId}`)
      .setLabel('Back')
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`payout_ev_cancel:${userId}`)
      .setLabel('Cancel')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Secondary)
  );
}
