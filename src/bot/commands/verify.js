import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { userService } from '../../modules/users/user.service.js';
import { logger } from '../../utils/logger.js';
import { ROLE_NAMES } from '../provisioning/server.structure.js';

export const data = new SlashCommandBuilder()
  .setName('verify')
  .setDescription('Verify your creator profile and activate your Peak Clip account');

/**
 * Execute /verify command
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  // Always acknowledge ephemerally to protect creator privacy
  await interaction.deferReply({ ephemeral: true });

  const correlationId = `ver_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  logger.info(
    { correlationId, discordId: interaction.user?.id, username: interaction.user?.username },
    'Creator onboarding /verify initiated'
  );

  // 1. Idempotently resolve or create application user
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  // 2. Assert user status (rejects SUSPENDED and BANNED users according to Phase 1 rules)
  userService.assertUserCanParticipate(user);

  // 3. Assign provisioned Creator role if present in guild
  let roleAssigned = false;
  if (interaction.guild && interaction.member?.roles) {
    const creatorRole = interaction.guild.roles.cache.find(
      (r) => r.name.toLowerCase() === ROLE_NAMES.CREATOR.toLowerCase()
    );

    if (creatorRole) {
      const hasRole = Array.isArray(interaction.member.roles)
        ? interaction.member.roles.includes(creatorRole.id)
        : interaction.member.roles.cache?.has(creatorRole.id);

      if (!hasRole && typeof interaction.member.roles.add === 'function') {
        try {
          await interaction.member.roles.add(creatorRole, 'Peak Clip creator onboarding');
          roleAssigned = true;
          logger.info(
            { correlationId, userId: user.id, roleId: creatorRole.id },
            'Assigned Creator role to onboarded user'
          );
        } catch (err) {
          logger.warn(
            { correlationId, err: err.message },
            'Could not automatically assign Creator role to member'
          );
        }
      } else if (hasRole) {
        roleAssigned = true;
      }
    }
  }

  // 4. Build onboarding welcome embed
  const name = user.displayName || user.username;
  const embed = new EmbedBuilder()
    .setTitle(`✅ Welcome to Peak Clip, ${name}!`)
    .setDescription(
      'Your creator profile is verified and active.\n\n' +
      `• **Status**: \`${user.status}\`\n` +
      `• **Creator Role**: ${roleAssigned ? '`Assigned`' : '`Active`'}\n\n` +
      '**Getting Started:**\n' +
      '1. **Explore Campaigns**: Browse active campaigns using `/campaigns`\n' +
      '2. **Submit Content**: Submit your published clip URLs using `/submit`\n' +
      '3. **Track Analytics**: Review performance and views using `/statistics`\n' +
      '4. **Track Earnings**: Inspect verified earnings using `/earnings`\n' +
      '5. **Request Payouts**: Withdraw eligible balances with `/payout`'
    )
    .setColor(0x2ecc71)
    .setFooter({ text: 'Peak Clip Creator Platform' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
