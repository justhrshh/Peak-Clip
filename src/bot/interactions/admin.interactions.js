import { MessageFlags } from 'discord.js';
import {
  assertAdminPermission,
  AdminPermission
} from '../../modules/admin/admin.auth.js';
import { adminSubmissionService } from '../../modules/admin/admin.submission.service.js';
import { adminPayoutService } from '../../modules/admin/admin.payout.service.js';
import { formatError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

/**
 * Handle untrusted admin button interactions
 *
 * Security Invariants:
 * 1. Authenticates caller interaction user server-side.
 * 2. Authorizes required permission based on actual action.
 * 3. Validates entity identifier format.
 * 4. Loads entity from database; verifies current state.
 * 5. Executes domain operation transactionally and logs audit event.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 */
export async function handleAdminButtonInteraction(interaction) {
  const customId = interaction.customId;
  const actor = {
    discordId: interaction.user.id,
    userId: null
  };

  try {
    // 1. Submission Quick Approval
    if (customId.startsWith('admin_sub_approve:')) {
      assertAdminPermission(interaction, AdminPermission.SUBMISSION_APPROVE);
      const submissionId = customId.split(':')[1];
      if (!submissionId) throw new Error('Malformed submission ID in interaction');

      const updated = await adminSubmissionService.approveSubmission(submissionId, actor, 'Approved via staff quick-action');
      await interaction.reply({
        content: `✅ Submission \`${updated.id}\` **APPROVED**.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // 2. Payout Quick Approval (ADMIN only)
    if (customId.startsWith('admin_payout_approve:')) {
      assertAdminPermission(interaction, AdminPermission.PAYOUT_APPROVE);
      const payoutId = customId.split(':')[1];
      if (!payoutId) throw new Error('Malformed payout ID in interaction');

      const updated = await adminPayoutService.approvePayout(payoutId, actor);
      await interaction.reply({
        content: `✅ Payout request \`${updated.id}\` **APPROVED** for disbursement.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // 3. Payout Quick Disbursement Processing (ADMIN only)
    if (customId.startsWith('admin_payout_process:')) {
      assertAdminPermission(interaction, AdminPermission.PAYOUT_PROCESS);
      const payoutId = customId.split(':')[1];
      if (!payoutId) throw new Error('Malformed payout ID in interaction');

      const result = await adminPayoutService.processDisbursement(payoutId, actor, 'MANUAL');
      await interaction.reply({
        content: `💸 Disbursement processed for payout \`${payoutId}\` (Ref: \`${result.disbursement.providerReference}\`).`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }
  } catch (error) {
    logger.error({ err: error, customId, actorDiscordId: interaction.user.id }, 'Error handling admin button interaction');
    const { userMessage } = formatError(error);

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: userMessage, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: userMessage, flags: MessageFlags.Ephemeral });
    }
  }
}
