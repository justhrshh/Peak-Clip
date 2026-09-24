import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { userService } from '../../modules/users/user.service.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

export const data = new SlashCommandBuilder()
  .setName('register')
  .setDescription('Register as a creator and activate your clipping dashboard');

/**
 * Execute /register command
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  // Always acknowledge ephemerally to protect creator privacy
  await interaction.deferReply({ ephemeral: true });

  const correlationId = `reg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  logger.info(
    { correlationId, discordId: interaction.user?.id, username: interaction.user?.username },
    'Creator onboarding /register initiated'
  );

  // 1. Optional external verification gate (CLIENT_VERIFIED_ROLE_ID)
  const clientVerifiedRoleId = config.discord?.clientVerifiedRoleId;
  if (clientVerifiedRoleId && interaction.member?.roles) {
    const hasVerifiedRole = Array.isArray(interaction.member.roles)
      ? interaction.member.roles.includes(clientVerifiedRoleId)
      : Boolean(interaction.member.roles.cache?.has(clientVerifiedRoleId));

    if (!hasVerifiedRole) {
      logger.info(
        { correlationId, userId: interaction.user?.id, requiredRole: clientVerifiedRoleId },
        'User registration blocked: missing CLIENT_VERIFIED_ROLE_ID'
      );
      await interaction.editReply({
        content: `⚠️ You must complete server verification first to receive the <@&${clientVerifiedRoleId}> role before registering as a creator.`
      });
      return;
    }
  }

  // 2. Validate creator role configuration
  const creatorRoleId = config.discord?.creatorRoleId;
  if (!creatorRoleId) {
    logger.warn({ correlationId }, 'DISCORD_CREATOR_ROLE_ID is not configured in environment.');
    await interaction.editReply({
      content: '⚠️ Creator registration is temporarily unavailable: the Creator role is not configured by server administrators. Please contact staff.'
    });
    return;
  }

  let creatorRole = null;
  if (interaction.guild?.roles) {
    creatorRole = interaction.guild.roles.cache.get(creatorRoleId);
    if (!creatorRole && typeof interaction.guild.roles.fetch === 'function') {
      try {
        creatorRole = await interaction.guild.roles.fetch(creatorRoleId);
      } catch {}
    }
  }

  if (!creatorRole) {
    logger.warn(
      { correlationId, creatorRoleId },
      'Configured DISCORD_CREATOR_ROLE_ID was not found in guild.'
    );
    await interaction.editReply({
      content: '⚠️ Creator registration is temporarily unavailable: the configured Creator role does not exist in this server. Please contact an administrator.'
    });
    return;
  }

  // 3. Idempotently resolve or create application user
  const user = await userService.getOrCreateFromDiscord(interaction.user);

  // 4. Assert user status (rejects SUSPENDED and BANNED users)
  userService.assertUserCanParticipate(user);

  // 5. Assign configured Creator role
  let roleAssigned = false;
  if (interaction.member?.roles) {
    const hasRole = Array.isArray(interaction.member.roles)
      ? interaction.member.roles.includes(creatorRole.id)
      : Boolean(interaction.member.roles.cache?.has(creatorRole.id));

    if (!hasRole && typeof interaction.member.roles.add === 'function') {
      try {
        await interaction.member.roles.add(creatorRole, 'Peak Clip creator registration onboarding');
        roleAssigned = true;
        logger.info(
          { correlationId, userId: user.id, roleId: creatorRole.id },
          'Assigned Creator role to registered user'
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

  // 6. Build onboarding welcome embed
  const name = user.displayName || user.username;
  const agencyName = config.agencyName || 'Peak Clip';
  const embed = new EmbedBuilder()
    .setTitle(`✅ Welcome to ${agencyName}, ${name}!`)
    .setDescription(
      'Your creator profile is registered and active.\n\n' +
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
    .setFooter({ text: `${agencyName} Creator Platform` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
