import { SlashCommandBuilder } from 'discord.js';
import { userService } from '../../modules/users/user.service.js';
import { payoutService } from '../../modules/payouts/payout.service.js';
import { payoutProfileService } from '../../modules/payout-profile/payout-profile.service.js';
import { buildUserPayoutEmbed } from '../embeds/payout.embeds.js';
import { buildPayoutActionRow } from '../components/payout.components.js';

export const data = new SlashCommandBuilder()
  .setName('payout')
  .setDescription('View available payout balance, history, and request a disbursement');

/**
 * Execute /payout slash command
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  // Creator-private: reply ephemerally
  await interaction.deferReply({ ephemeral: true });

  // 1. Sync creator identity
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  // 2. Fetch authoritative available balance, history, and payout profile
  const [balance, history, profile] = await Promise.all([
    payoutService.getAvailablePayoutBalance(user.id),
    payoutService.getUserPayoutHistory(user.id),
    payoutProfileService.getProfileByUserId(user.id).catch(() => null)
  ]);

  // 3. Determine eligibility & cancellable request
  const isEligible = balance.availableBalance.greaterThanOrEqualTo(balance.minimumPayout);
  const activeCancellablePayout = history.find((p) =>
    ['REQUESTED', 'UNDER_REVIEW', 'APPROVED'].includes(p.status)
  ) || null;

  // 4. Render embed and action buttons
  const embed = buildUserPayoutEmbed(balance, history, interaction.user, profile);
  const actionRow = buildPayoutActionRow(user.id, isEligible, activeCancellablePayout, Boolean(profile));

  await interaction.editReply({
    embeds: [embed],
    components: [actionRow]
  });
}
