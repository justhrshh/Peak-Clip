import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { config } from '../../config/index.js';
import { serverProvisioner } from '../provisioning/server.provisioner.js';
import { logger } from '../../utils/logger.js';
import {
  assertAdminPermission,
  AdminPermission,
  AdminRole
} from '../../modules/admin/admin.auth.js';
import {
  GuildMismatchError,
  UnauthorizedProvisioningError,
  ProvisioningConflictError,
  RoleHierarchyError
} from '../provisioning/server.provisioning.errors.js';
import {
  UnauthorizedAdminActionError,
  InsufficientPermissionError
} from '../../modules/admin/admin.errors.js';

export const data = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Provision and configure Peak Clip DEV server structure, roles, and permissions')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

/**
 * Execute /setup command
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {ServerProvisioner} [provisionerInstance=serverProvisioner]
 */
export async function execute(interaction, provisionerInstance = serverProvisioner) {
  const correlationId = `setup_cmd_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  // Safe response dispatcher: strictly prevents double-reply and always respects deferred/replied state
  const deliverResponse = async (payload) => {
    if (interaction.deferred && !interaction.replied) {
      if (typeof interaction.editReply === 'function') {
        return await interaction.editReply(payload);
      }
    } else if (interaction.replied) {
      if (typeof interaction.followUp === 'function') {
        return await interaction.followUp({ ...payload, ephemeral: true });
      }
    } else if (typeof interaction.reply === 'function') {
      return await interaction.reply({ ...payload, ephemeral: true });
    } else if (typeof interaction.editReply === 'function') {
      return await interaction.editReply(payload);
    }
  };

  // 1. Fast, synchronous in-memory Target Guild check (<0.1ms)
  const activeConfig = provisionerInstance.config || config;
  const configuredGuildId = activeConfig.discord?.guildId;
  if (configuredGuildId && interaction.guildId && interaction.guildId !== configuredGuildId) {
    logger.warn(
      { correlationId, guildId: interaction.guildId, configuredGuildId },
      '/setup rejected: Guild mismatch'
    );
    const mismatchEmbed = new EmbedBuilder()
      .setTitle('❌ Guild Mismatch')
      .setDescription('This server is not configured as the target Peak Clip environment.')
      .setColor(0xe74c3c)
      .setTimestamp();

    await deliverResponse({ embeds: [mismatchEmbed] });
    return;
  }

  // 2. Fast, synchronous in-memory Peak Admin Authorization check (<0.1ms)
  let isAuthorized = false;
  try {
    const resolvedRoles = assertAdminPermission(
      interaction,
      AdminPermission.CAMPAIGN_EDIT,
      activeConfig.admin
    );
    isAuthorized = resolvedRoles.includes(AdminRole.ADMIN);
  } catch {
    isAuthorized = false;
  }

  if (!isAuthorized) {
    logger.warn(
      { correlationId, guildId: interaction.guildId, userId: interaction.user?.id },
      '/setup rejected: Unauthorized actor'
    );
    const unauthorizedEmbed = new EmbedBuilder()
      .setTitle('❌ Unauthorized Action')
      .setDescription('You do not possess the required Peak Admin administrative privileges to execute server provisioning.')
      .setColor(0xe74c3c)
      .setTimestamp();

    await deliverResponse({ embeds: [unauthorizedEmbed] });
    return;
  }

  // 3. Immediately acknowledge the interaction BEFORE any slow provisioning work begins
  if (!interaction.deferred && !interaction.replied) {
    try {
      if (typeof interaction.deferReply === 'function') {
        await interaction.deferReply({ ephemeral: true });
      }
    } catch (deferError) {
      logger.error(
        { correlationId, err: deferError.message, code: deferError.code },
        'Failed acknowledging /setup interaction via deferReply'
      );
      throw deferError;
    }
  }

  const actorRoles = interaction.member?.roles?.cache
    ? Array.from(interaction.member.roles.cache.values()).map((r) => ({ id: r.id, name: r.name, position: r.position }))
    : (Array.isArray(interaction.member?.roles) ? interaction.member.roles : []);

  logger.info(
    {
      correlationId,
      guildId: interaction.guildId,
      guildName: interaction.guild?.name,
      userId: interaction.user?.id,
      userTag: interaction.user?.tag,
      actorRoles
    },
    'Executing /setup slash command provisioning'
  );

  // 4. Run ServerProvisioner and update reply
  try {
    const result = await provisionerInstance.provisionServer(
      interaction.guild,
      interaction
    );

    const embed = new EmbedBuilder()
      .setTitle('Peak Clip Server Setup')
      .setDescription(
        `✓ **Roles**: ${result.roles.total}/${result.roles.total} (${result.roles.created} created, ${result.roles.reused} reused)\n` +
        `✓ **Categories**: ${result.categories.total}/${result.categories.total} (${result.categories.created} created, ${result.categories.reused} reused)\n` +
        `✓ **Channels**: ${result.channels.total}/${result.channels.total} (${result.channels.created} created, ${result.channels.reused} reused)\n` +
        `✓ **Permissions**: Synchronized (Zero Administrator Flags)\n\n` +
        `**Status**: \`${result.status}\` • Duration: \`${result.durationMs}ms\``
      )
      .setColor(0x2ecc71)
      .setTimestamp();

    await deliverResponse({ embeds: [embed] });
  } catch (error) {
    logger.error(
      {
        correlationId,
        err: error.message,
        code: error.code,
        status: error.status,
        rawError: error.rawError,
        diagnostic: error.diagnostic,
        guildId: interaction.guildId,
        userId: interaction.user?.id,
        stack: error.stack
      },
      'Failed executing /setup command'
    );

    let errorTitle = 'Setup Failed';
    let errorMessage = error.message;

    if (error.diagnostic) {
      const diag = error.diagnostic;
      errorTitle = `Setup Failed: ${diag.operation}`;
      const missing = diag.requestedPerms && diag.botEffectivePerms
        ? diag.requestedPerms.filter((p) => !diag.botEffectivePerms.includes(p))
        : [];

      errorMessage =
        `• **Failing Operation**: \`${diag.operation}\` on \`${diag.target}\` (${diag.targetType})\n` +
        `• **Discord API Error**: \`${diag.discordCode || 'N/A'}\` — \`${diag.discordMsg}\` (HTTP ${diag.discordStatus || 'N/A'})\n` +
        `• **Bot Highest Role**: \`${diag.botHighestRole?.name || 'Unknown'}\` (position: \`${diag.botHighestRole?.position}\`)\n` +
        (diag.targetRole ? `• **Target Role**: \`${diag.targetRole.name}\` (position: \`${diag.targetRole.position}\`)\n` : '') +
        (diag.requestedPerms && diag.requestedPerms.length > 0 ? `• **Requested Permissions**: \`${diag.requestedPerms.join(', ')}\`\n` : '') +
        (missing.length > 0 ? `• **Permissions Missing from Bot**: \`${missing.join(', ')}\`\n` : '') +
        `\n*Full diagnostic context recorded in server logs.*`;
    } else if (error instanceof GuildMismatchError) {
      errorTitle = 'Guild Mismatch';
      errorMessage = 'This server is not configured as the target Peak Clip environment.';
    } else if (
      error instanceof UnauthorizedProvisioningError ||
      error instanceof UnauthorizedAdminActionError ||
      error instanceof InsufficientPermissionError
    ) {
      errorTitle = 'Unauthorized Action';
      errorMessage = 'You do not possess the required Peak Admin administrative privileges to execute server provisioning.';
    } else if (error instanceof ProvisioningConflictError) {
      errorTitle = 'Resource Conflict';
      errorMessage = `A conflicting resource exists: ${error.message}`;
    } else if (error instanceof RoleHierarchyError) {
      errorTitle = 'Role Hierarchy Conflict';
      errorMessage = error.message;
    }

    const errorEmbed = new EmbedBuilder()
      .setTitle(`❌ ${errorTitle}`)
      .setDescription(errorMessage)
      .setColor(0xe74c3c)
      .setTimestamp();

    await deliverResponse({ embeds: [errorEmbed] });
  }
}
