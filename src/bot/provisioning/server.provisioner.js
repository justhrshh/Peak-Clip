import { ChannelType, EmbedBuilder, PermissionsBitField, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { prisma } from '../../database/client.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { assertAdminPermission, AdminPermission, AdminRole } from '../../modules/admin/admin.auth.js';
import {
  buildAdminControlCenterRows,
  buildCreatorCampaignsChannelRow,
  buildCreatorSubmissionsChannelRow,
  buildCreatorStatsChannelRow,
  buildCreatorEarningsChannelRow,
  buildCreatorPayoutsChannelRow
} from '../components/dashboard.components.js';
import {
  buildCreatorDashboardChannelEmbed,
  buildCreatorCampaignsChannelEmbed,
  buildCreatorSubmissionsChannelEmbed,
  buildCreatorStatsChannelEmbed,
  buildCreatorEarningsChannelEmbed,
  buildCreatorPayoutsChannelEmbed
} from '../embeds/dashboard.embeds.js';
import {
  buildStaffReviewQueueHubEmbed,
  buildStaffCreatorHubEmbed,
  buildStaffCampaignHubEmbed,
  buildStaffPayoutHubEmbed,
  buildStaffAuditHubEmbed,
  buildStaffSystemStatusEmbed,
  buildStaffBotErrorsEmbed
} from '../embeds/staff.embeds.js';
import {
  buildStaffReviewQueueHubRow,
  buildStaffCreatorHubRow,
  buildStaffCampaignHubRow,
  buildStaffPayoutHubRow,
  buildStaffAuditHubRow,
  buildStaffSystemStatusRow,
  buildStaffSystemErrorsRow
} from '../components/staff.components.js';
import { ROLES_DEFINITION, SERVER_STRUCTURE, EXPECTED_COUNTS } from './server.structure.js';
import {
  BASE_ROLE_PERMISSIONS,
  filterDelegatablePermissions,
  getCategoryOverwrites,
  getChannelOverwrites
} from './server.permissions.js';
import {
  GuildMismatchError,
  UnauthorizedProvisioningError,
  ProvisioningConflictError,
  RoleHierarchyError,
  ProvisioningError
} from './server.provisioning.errors.js';

/**
 * Server Provisioner
 * Handles declarative, idempotent synchronization of Discord roles, categories,
 * channels, and permissions for the Peak Clip environment with precise diagnostic logging.
 */
export class ServerProvisioner {
  constructor(customConfig = config) {
    this.config = customConfig;
  }

  /**
   * Main entry point to provision or synchronize a guild
   *
   * @param {object} guild - Discord Guild instance
   * @param {object} actor - Discord Interaction or Member context
   * @returns {Promise<object>} Summary of provisioning outcome
   */
  async provisionServer(guild, actor) {
    const startTime = Date.now();
    const correlationId = `prov_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    logger.info(
      { correlationId, guildId: guild?.id, actorId: actor?.user?.id || actor?.id },
      'Discord server provisioning initiated'
    );

    if (this.config?.isProduction || config.isProduction) {
      logger.warn({ correlationId }, 'Server provisioning is disabled in production to protect client guild structure.');
      throw new ProvisioningError('Server provisioning is disabled in production. Client Discord server channels and roles must be configured manually via environment variables.');
    }

    try {
      // 1. Target Guild Verification
      this._verifyTargetGuild(guild);

      // 2. Administrative Authorization Check
      this._assertPeakAdminAuthorization(actor);

      // Ensure caches are populated with fresh authoritative state from REST
      if (typeof guild.fetch === 'function') {
        await guild.fetch().catch(() => {});
      }
      if (guild.roles && typeof guild.roles.fetch === 'function') {
        await guild.roles.fetch({ force: true }).catch(() => guild.roles.fetch().catch(() => {}));
      }
      if (guild.channels && typeof guild.channels.fetch === 'function') {
        await guild.channels.fetch({ force: true }).catch(() => guild.channels.fetch().catch(() => {}));
      }

      // 3. Preflight Diagnostic Verification: bot membership, permissions, and hierarchy
      const preflight = await this._verifyPreflight(guild, correlationId);
      const botMember = preflight.botMember;

      // 4. Provision / Synchronize Roles
      const roleResult = await this._provisionRoles(guild, botMember, correlationId);

      // 5. Validate Bot Role Hierarchy
      await this._verifyBotHierarchy(guild, roleResult.roleMap, botMember, correlationId);

      // 6. Provision / Synchronize Categories & Channels
      const channelResult = await this._provisionStructure(
        guild,
        roleResult.roleMap,
        botMember,
        correlationId
      );

      // 7. Post initial control center message in STAFF/#dashboard and channel messages in creator, staff, and system channels
      await this._initializeDashboardChannel(channelResult.staffDashboardChannel, botMember, correlationId);
      await this._initializeCreatorChannelMessages(channelResult.creatorChannels, botMember, correlationId);
      await this._initializeStaffChannelMessages(channelResult.staffChannels, botMember, correlationId);
      await this._initializeSystemChannelMessages(channelResult.systemChannels, botMember, correlationId);

      const durationMs = Date.now() - startTime;
      logger.info(
        {
          correlationId,
          guildId: guild.id,
          roles: roleResult.summary,
          categories: channelResult.categoriesSummary,
          channels: channelResult.channelsSummary,
          durationMs
        },
        'Discord server provisioning completed successfully'
      );

      return {
        success: true,
        correlationId,
        durationMs,
        roles: roleResult.summary,
        categories: channelResult.categoriesSummary,
        channels: channelResult.channelsSummary,
        permissionsSynchronized: true,
        status: 'Ready'
      };
    } catch (error) {
      logger.error(
        {
          correlationId,
          guildId: guild?.id,
          err: error.message,
          diagnostic: error.diagnostic,
          stack: error.stack
        },
        'Discord server provisioning failed'
      );
      throw error;
    }
  }

  /**
   * Precise diagnostic wrapper around every Discord REST API operation
   * @private
   */
  async _executeDiagnosticOp({
    operationName,
    targetName,
    targetType,
    permissionBits = null,
    targetRole = null,
    guild,
    botMember,
    correlationId,
    action
  }) {
    const botHighest = botMember?.roles?.highest
      ? {
          id: botMember.roles.highest.id,
          name: botMember.roles.highest.name,
          position: botMember.roles.highest.position
        }
      : null;

    let botEffectivePerms = [];
    try {
      if (botMember?.permissions && typeof botMember.permissions.toArray === 'function') {
        botEffectivePerms = botMember.permissions.toArray();
      } else if (botMember?.permissions) {
        botEffectivePerms = new PermissionsBitField(botMember.permissions).toArray();
      }
    } catch {
      botEffectivePerms = [];
    }

    let requestedPerms = null;
    try {
      if (permissionBits != null) {
        requestedPerms = new PermissionsBitField(permissionBits).toArray();
      }
    } catch {
      requestedPerms = null;
    }

    const targetRoleInfo = targetRole
      ? { id: targetRole.id, name: targetRole.name, position: targetRole.position }
      : null;

    logger.info(
      {
        correlationId,
        diagnosticOp: operationName,
        targetName,
        targetType,
        requestedPerms,
        botEffectivePermsCount: botEffectivePerms.length,
        botHighestRole: botHighest,
        targetRole: targetRoleInfo
      },
      `[DIAGNOSTIC] Executing Discord API: ${operationName} on '${targetName}'`
    );

    try {
      const result = await action();
      logger.info(
        {
          correlationId,
          diagnosticOp: operationName,
          targetName,
          status: 'SUCCESS'
        },
        `[DIAGNOSTIC] Succeeded Discord API: ${operationName} on '${targetName}'`
      );
      return result;
    } catch (error) {
      const discordCode = error.code || error.rawError?.code || null;
      const discordStatus = error.status || null;
      const discordMsg = error.message;

      logger.error(
        {
          correlationId,
          diagnosticOp: operationName,
          targetName,
          targetType,
          requestedPerms,
          botEffectivePerms,
          botHighestRole: botHighest,
          targetRole: targetRoleInfo,
          discordCode,
          discordStatus,
          discordMsg,
          rawError: error.rawError
        },
        `[DIAGNOSTIC_FAILURE] Discord API Rejected: ${operationName} on '${targetName}' - ${discordMsg} (code: ${discordCode})`
      );

      // Attach structured diagnostic metadata to the error
      error.diagnostic = {
        operation: operationName,
        target: targetName,
        targetType,
        discordCode,
        discordStatus,
        discordMsg,
        requestedPerms,
        botEffectivePerms,
        botHighestRole: botHighest,
        targetRole: targetRoleInfo
      };

      throw error;
    }
  }

  /**
   * Preflight Diagnostic Verification: bot membership, permissions, and hierarchy
   * @private
   */
  async _verifyPreflight(guild, correlationId) {
    let botMember = null;
    if (guild.members) {
      if (typeof guild.members.fetchMe === 'function') {
        botMember = await guild.members.fetchMe().catch(() => null);
      }
      if (!botMember && guild.client?.user?.id && typeof guild.members.fetch === 'function') {
        botMember = await guild.members.fetch({ user: guild.client.user.id, force: true }).catch(() => null);
      }
      if (!botMember) {
        botMember = guild.members.me;
      }
    }

    if (!botMember) {
      throw new ProvisioningError('Bot member could not be resolved in the target guild. Ensure the bot is present in the server.');
    }

    const botPermissions = new PermissionsBitField(botMember.permissions || 0n);
    const botPermNames = botPermissions.toArray();
    const hasManageRoles = botPermissions.has(PermissionFlagsBits.ManageRoles);
    const hasManageChannels = botPermissions.has(PermissionFlagsBits.ManageChannels);
    const hasAdministrator = botPermissions.has(PermissionFlagsBits.Administrator);

    const botHighestRole = botMember.roles.highest
      ? { id: botMember.roles.highest.id, name: botMember.roles.highest.name, position: botMember.roles.highest.position }
      : null;

    logger.info(
      {
        correlationId,
        guildId: guild.id,
        botId: botMember.id,
        botTag: botMember.user?.tag,
        botHighestRole,
        hasManageRoles,
        hasManageChannels,
        hasAdministrator,
        totalPermissions: botPermNames.length,
        effectivePermissions: botPermNames
      },
      '[DIAGNOSTIC] Preflight check: Bot guild membership and effective permissions verified'
    );

    if (!hasManageRoles) {
      logger.warn(
        { correlationId, guildId: guild.id },
        '[DIAGNOSTIC_WARNING] Bot lacks effective ManageRoles permission in target guild.'
      );
    }
    if (!hasManageChannels) {
      logger.warn(
        { correlationId, guildId: guild.id },
        '[DIAGNOSTIC_WARNING] Bot lacks effective ManageChannels permission in target guild.'
      );
    }

    return {
      botMember,
      botPermissions,
      botPermNames,
      hasManageRoles,
      hasManageChannels,
      botHighestRole
    };
  }

  /**
   * Verify guild matches the configured DISCORD_GUILD_ID
   * @private
   */
  _verifyTargetGuild(guild) {
    if (!guild || !guild.id) {
      throw new ProvisioningError('A valid Discord Guild must be provided for provisioning.');
    }

    const targetGuildId = this.config.discord?.guildId;
    if (targetGuildId && guild.id !== targetGuildId) {
      throw new GuildMismatchError(guild.id, targetGuildId);
    }
  }

  /**
   * Authenticate invoking user as Peak Admin
   * @private
   */
  _assertPeakAdminAuthorization(actor) {
    if (!actor) {
      throw new UnauthorizedProvisioningError('unknown', 'No actor context provided for provisioning.');
    }

    // Must satisfy CAMPAIGN_EDIT permission first
    const resolvedRoles = assertAdminPermission(
      actor,
      AdminPermission.CAMPAIGN_EDIT,
      this.config?.admin
    );

    // Provisioning is restricted to full ADMIN role
    if (!resolvedRoles.includes(AdminRole.ADMIN)) {
      throw new UnauthorizedProvisioningError(
        actor.user?.id || actor.id,
        'Server provisioning requires full Peak Admin role authority.'
      );
    }
  }

  /**
   * Dynamically resolve the Discord-managed bot integration role
   * @private
   */
  _resolveBotManagedRole(guild, botMember, correlationId) {
    const botUserId = guild.client?.user?.id || botMember?.user?.id || botMember?.id;

    // 1. Role tagged with bot user ID (Discord OAuth bot integration role)
    if (botUserId) {
      const taggedRole = guild.roles.cache.find((r) => r.tags?.botId === botUserId);
      if (taggedRole) {
        logger.info(
          { correlationId, roleId: taggedRole.id, roleName: taggedRole.name, botUserId },
          '[DIAGNOSTIC] Resolved bot managed role via role.tags.botId === client.user.id'
        );
        return taggedRole;
      }
    }

    // 2. Discord.js GuildMemberRoleManager botRole getter
    if (botMember?.roles?.botRole) {
      logger.info(
        { correlationId, roleId: botMember.roles.botRole.id, roleName: botMember.roles.botRole.name },
        '[DIAGNOSTIC] Resolved bot managed role via botMember.roles.botRole'
      );
      return botMember.roles.botRole;
    }

    // 3. Managed member role from botMember's cache
    if (botMember?.roles?.cache) {
      const managedRole = botMember.roles.cache.find((r) => r.managed);
      if (managedRole) {
        logger.info(
          { correlationId, roleId: managedRole.id, roleName: managedRole.name },
          '[DIAGNOSTIC] Resolved bot managed role via botMember.roles.cache (managed: true)'
        );
        return managedRole;
      }
    }

    // 4. Role named 'Peak Clip' or flagged as managed bot integration
    const namedRole = guild.roles.cache.find(
      (r) => (r.managed && r.tags?.botId) || r.name.toLowerCase() === 'peak clip'
    );
    if (namedRole) {
      logger.info(
        { correlationId, roleId: namedRole.id, roleName: namedRole.name },
        '[DIAGNOSTIC] Resolved bot managed role via name match (Peak Clip)'
      );
      return namedRole;
    }

    // 5. Fallback: highest role of botMember (excluding @everyone)
    if (botMember?.roles?.highest && botMember.roles.highest.id !== guild.roles.everyone?.id) {
      logger.info(
        { correlationId, roleId: botMember.roles.highest.id, roleName: botMember.roles.highest.name },
        '[DIAGNOSTIC] Resolved bot role via botMember.roles.highest fallback'
      );
      return botMember.roles.highest;
    }

    return null;
  }

  /**
   * Synchronize Peak Clip Roles
   * @private
   */
  async _provisionRoles(guild, botMember, correlationId) {
    let created = 0;
    let reused = 0;
    const roleMap = {};

    // 1. Dynamically resolve existing Discord-managed bot integration role (NEVER create duplicate)
    const managedBotRole = this._resolveBotManagedRole(guild, botMember, correlationId);
    if (!managedBotRole) {
      throw new ProvisioningError('Failed to resolve Discord-managed bot integration role for Peak Clip.');
    }
    roleMap.PEAK_CLIP_BOT = managedBotRole;
    reused++; // Bot role is an existing managed role
    logger.info(
      {
        correlationId,
        roleId: managedBotRole.id,
        roleName: managedBotRole.name,
        position: managedBotRole.position
      },
      '[DIAGNOSTIC] Successfully bound Discord-managed bot integration role'
    );

    // 2. Synchronize target server roles: Peak Admin, Campaign Manager, Creator
    for (const roleDef of ROLES_DEFINITION) {
      // Find existing role by name (case-insensitive)
      let role = guild.roles.cache.find(
        (r) => r.name.toLowerCase() === roleDef.name.toLowerCase()
      );

      if (role) {
        reused++;
        logger.debug(
          { correlationId, roleName: role.name, roleId: role.id },
          'Reusing existing Discord role'
        );
      } else {
        // Strip any permissions the bot does not possess to prevent 50013 Missing Permissions
        const rawBasePermissions = BASE_ROLE_PERMISSIONS[roleDef.key] || 0n;
        const basePermissions = filterDelegatablePermissions(rawBasePermissions, botMember.permissions);

        role = await this._executeDiagnosticOp({
          operationName: 'ROLE_CREATE',
          targetName: roleDef.name,
          targetType: 'Role',
          permissionBits: basePermissions,
          guild,
          botMember,
          correlationId,
          action: async () => {
            return await guild.roles.create({
              name: roleDef.name,
              color: roleDef.color,
              hoist: roleDef.hoist,
              mentionable: roleDef.mentionable,
              permissions: basePermissions,
              reason: 'Peak Clip DEV Provisioning'
            });
          }
        });

        created++;
        logger.info(
          { correlationId, roleName: role.name, roleId: role.id },
          'Created missing Discord role'
        );
      }

      roleMap[roleDef.key] = role;
    }

    return {
      roleMap,
      summary: {
        created,
        reused,
        total: EXPECTED_COUNTS.roles // 4
      }
    };
  }

  /**
   * Verify Bot Hierarchy relative to managed roles
   * @private
   */
  async _verifyBotHierarchy(guild, roleMap, botMember, correlationId) {
    if (!botMember) return;

    const botManagedRole = roleMap.PEAK_CLIP_BOT;
    const botPosition = botManagedRole ? botManagedRole.position : botMember.roles.highest.position;

    for (const [key, role] of Object.entries(roleMap)) {
      if (role.id === botManagedRole?.id) continue;

      const targetRoleInfo = { id: role.id, name: role.name, position: role.position };
      logger.info(
        {
          correlationId,
          diagnosticOp: 'ROLE_HIERARCHY_CHECK',
          targetRole: targetRoleInfo,
          botPosition,
          isManageable: botPosition > role.position
        },
        `[DIAGNOSTIC] Role hierarchy check: '${role.name}' (pos ${role.position}) vs Bot (pos ${botPosition})`
      );

      if (role.position >= botPosition) {
        throw new RoleHierarchyError(
          role.name,
          botPosition,
          role.position
        );
      }
    }
  }

  /**
   * Synchronize Categories, Channels, and Permission Overwrites
   * @private
   */
  async _provisionStructure(guild, roleMap, botMember, correlationId) {
    let categoriesCreated = 0;
    let categoriesReused = 0;
    let channelsCreated = 0;
    let channelsReused = 0;
    let staffDashboardChannel = null;
    const creatorChannels = {};
    const staffChannels = {};
    const systemChannels = {};

    const everyoneRole = guild.roles.everyone;

    for (const catDef of SERVER_STRUCTURE) {
      // 1. Locate or create Category
      let category = guild.channels.cache.find(
        (c) => c.name.toLowerCase() === catDef.category.toLowerCase()
      );

      if (category) {
        if (category.type !== ChannelType.GuildCategory) {
          throw new ProvisioningConflictError(
            catDef.category,
            'GuildCategory',
            category.type
          );
        }
        categoriesReused++;
        logger.debug(
          { correlationId, categoryName: category.name, categoryId: category.id },
          'Reusing existing category'
        );
      } else {
        const categoryOverwrites = getCategoryOverwrites(
          catDef.category,
          roleMap,
          everyoneRole
        );

        category = await this._executeDiagnosticOp({
          operationName: 'CATEGORY_CREATE',
          targetName: catDef.category,
          targetType: 'GuildCategory',
          guild,
          botMember,
          correlationId,
          action: async () => {
            return await guild.channels.create({
              name: catDef.category,
              type: ChannelType.GuildCategory,
              permissionOverwrites: categoryOverwrites,
              reason: 'Peak Clip DEV Provisioning'
            });
          }
        });

        categoriesCreated++;
        logger.info(
          { correlationId, categoryName: category.name, categoryId: category.id },
          'Created missing category'
        );
      }

      // Synchronize Category Permissions
      const expectedCategoryOverwrites = getCategoryOverwrites(
        catDef.category,
        roleMap,
        everyoneRole
      );
      if (category.permissionOverwrites && typeof category.permissionOverwrites.set === 'function') {
        await this._executeDiagnosticOp({
          operationName: 'CATEGORY_PERMISSION_OVERWRITE_SET',
          targetName: catDef.category,
          targetType: 'GuildCategory',
          guild,
          botMember,
          correlationId,
          action: async () => {
            await category.permissionOverwrites.set(expectedCategoryOverwrites);
          }
        });
      }

      // 2. Locate or create Channels inside Category
      for (const chDef of catDef.channels) {
        let channel = guild.channels.cache.find(
          (c) =>
            c.name.toLowerCase() === chDef.name.toLowerCase() &&
            c.parentId === category.id
        );

        // Special handling for CREATOR/#dashboard: migrate legacy #welcome if dashboard not found in CREATOR category
        if (!channel && catDef.category === 'CREATOR' && chDef.name === 'dashboard') {
          const legacyWelcome = guild.channels.cache.find(
            (c) => c.name.toLowerCase() === 'welcome'
          );
          if (legacyWelcome) {
            channel = legacyWelcome;
            if (typeof channel.setName === 'function') {
              await this._executeDiagnosticOp({
                operationName: 'CHANNEL_RENAME_WELCOME_TO_DASHBOARD',
                targetName: 'welcome -> dashboard',
                targetType: 'GuildText',
                guild,
                botMember,
                correlationId,
                action: async () => {
                  await channel.setName('dashboard', 'Migrate #welcome to creator #dashboard');
                }
              });
            }
            if (channel.parentId !== category.id && typeof channel.setParent === 'function') {
              await this._executeDiagnosticOp({
                operationName: 'CHANNEL_SET_PARENT',
                targetName: 'dashboard',
                targetType: 'GuildText',
                guild,
                botMember,
                correlationId,
                action: async () => {
                  await channel.setParent(category.id, { lockPermissions: false });
                }
              });
            }
            if (typeof channel.setTopic === 'function') {
              await this._executeDiagnosticOp({
                operationName: 'CHANNEL_SET_TOPIC',
                targetName: 'dashboard',
                targetType: 'GuildText',
                guild,
                botMember,
                correlationId,
                action: async () => {
                  await channel.setTopic(chDef.topic);
                }
              });
            }
          }
        }

        // Fallback: check if channel exists under another category or root (EXCEPT dashboard, which exists in both CREATOR and STAFF)
        if (!channel && chDef.name !== 'dashboard') {
          channel = guild.channels.cache.find(
            (c) => c.name.toLowerCase() === chDef.name.toLowerCase()
          );
          if (
            channel &&
            channel.type === chDef.type &&
            channel.parentId !== category.id &&
            typeof channel.setParent === 'function'
          ) {
            await this._executeDiagnosticOp({
              operationName: 'CHANNEL_SET_PARENT',
              targetName: chDef.name,
              targetType: 'GuildText',
              guild,
              botMember,
              correlationId,
              action: async () => {
                await channel.setParent(category.id, { lockPermissions: false });
              }
            });
          }
        }

        if (channel) {
          if (channel.type !== chDef.type) {
            throw new ProvisioningConflictError(
              chDef.name,
              'GuildText',
              channel.type
            );
          }
          channelsReused++;
          // Ensure topic is up-to-date
          if (channel.topic !== chDef.topic && typeof channel.setTopic === 'function') {
            await this._executeDiagnosticOp({
              operationName: 'CHANNEL_SET_TOPIC',
              targetName: `${catDef.category}/#${chDef.name}`,
              targetType: 'GuildText',
              guild,
              botMember,
              correlationId,
              action: async () => {
                await channel.setTopic(chDef.topic);
              }
            }).catch(() => {});
          }
          logger.debug(
            { correlationId, channelName: channel.name, channelId: channel.id },
            'Reusing existing channel'
          );
        } else {
          const specificOverwrites = getChannelOverwrites(
            catDef.category,
            chDef.name,
            roleMap,
            everyoneRole
          );

          channel = await this._executeDiagnosticOp({
            operationName: 'CHANNEL_CREATE',
            targetName: chDef.name,
            targetType: 'GuildText',
            guild,
            botMember,
            correlationId,
            action: async () => {
              return await guild.channels.create({
                name: chDef.name,
                type: chDef.type,
                parent: category.id,
                topic: chDef.topic,
                permissionOverwrites: specificOverwrites || undefined,
                reason: 'Peak Clip DEV Provisioning'
              });
            }
          });

          channelsCreated++;
          logger.info(
            { correlationId, channelName: channel.name, channelId: channel.id },
            'Created missing channel'
          );
        }

        // Apply channel-specific overwrites or lock to parent category
        const customOverwrites = getChannelOverwrites(
          catDef.category,
          chDef.name,
          roleMap,
          everyoneRole
        );

        if (customOverwrites) {
          if (channel.permissionOverwrites && typeof channel.permissionOverwrites.set === 'function') {
            await this._executeDiagnosticOp({
              operationName: 'CHANNEL_PERMISSION_OVERWRITE_SET',
              targetName: `${catDef.category}/#${chDef.name}`,
              targetType: 'GuildText',
              guild,
              botMember,
              correlationId,
              action: async () => {
                await channel.permissionOverwrites.set(customOverwrites);
              }
            });
          }
        } else if (typeof channel.lockPermissions === 'function') {
          await this._executeDiagnosticOp({
            operationName: 'CHANNEL_PERMISSION_LOCK',
            targetName: `${catDef.category}/#${chDef.name}`,
            targetType: 'GuildText',
            guild,
            botMember,
            correlationId,
            action: async () => {
              await channel.lockPermissions().catch(() => {});
            }
          });
        }

        if (catDef.category === 'STAFF') {
          staffChannels[chDef.name] = channel;
          if (chDef.name === 'dashboard') staffDashboardChannel = channel;
        }
        if (catDef.category === 'CREATOR') {
          creatorChannels[chDef.name] = channel;
        }
        if (catDef.category === 'SYSTEM') {
          systemChannels[chDef.name] = channel;
        }
      }
    }

    return {
      dashboardChannel: staffDashboardChannel,
      staffDashboardChannel,
      creatorDashboardChannel: creatorChannels['dashboard'] || null,
      welcomeChannel: creatorChannels['dashboard'] || null,
      creatorChannels,
      staffChannels,
      systemChannels,
      categoriesSummary: {
        created: categoriesCreated,
        reused: categoriesReused,
        total: EXPECTED_COUNTS.categories
      },
      channelsSummary: {
        created: channelsCreated,
        reused: channelsReused,
        total: EXPECTED_COUNTS.channels
      }
    };
  }

  /**
   * Post or reconcile (update) the Staff Control Center embed in #dashboard.
   * Detects any existing bot-authored message and EDITS it with current embed+buttons.
   * Idempotent: safe to call multiple times — no duplicate messages will be created.
   * @private
   */
  async _initializeDashboardChannel(channel, botMember, correlationId) {
    if (!channel || typeof channel.send !== 'function') return;

    const embed = new EmbedBuilder()
      .setTitle('PEAK CLIP — CONTROL CENTER')
      .setDescription(
        'Welcome to the Peak Clip Control Center.\n\n' +
        'This operational hub monitors campaigns, submissions, creator onboarding, and system health.\n\n' +
        '• **Campaigns**: View and configure active clipping campaigns in `#campaign-management`\n' +
        '• **Review Queue**: Verify flagged or pending clips in `#review-queue`\n' +
        '• **Creators**: Manage creator verification in `#creators`\n' +
        '• **Financials**: Review disbursement queues in `#payout-queue`\n' +
        '• **Audit**: Inspect system actions in `#audit-log`\n\n' +
        '*Staff controls are accessible to authorized roles according to zero-trust permissions.*'
      )
      .setColor(0xe74c3c)
      .setTimestamp();

    const rows = buildAdminControlCenterRows();

    try {
      // Fetch recent messages to detect any existing bot post
      // Discord message author.id matches user.id, not member.id
      const botUserId = botMember?.user?.id || botMember?.id;
      let existingBotMsg = null;
      if (channel.messages && typeof channel.messages.fetch === 'function') {
        const fetched = await channel.messages.fetch({ limit: 10 });
        const messageList = Array.isArray(fetched) ? fetched : (fetched?.values ? Array.from(fetched.values()) : []);
        existingBotMsg = messageList.find(
          (msg) => msg.author?.id === botUserId
        ) || null;
      }

      if (existingBotMsg) {
        // RECONCILE: edit the existing message with fresh embed + buttons
        await this._executeDiagnosticOp({
          operationName: 'DASHBOARD_MESSAGE_RECONCILE',
          targetName: '#dashboard',
          targetType: 'GuildText',
          guild: channel.guild,
          botMember,
          correlationId,
          action: async () => {
            await existingBotMsg.edit({ content: '', embeds: [embed], components: rows });
          }
        });
        logger.info({ correlationId, channelId: channel.id, msgId: existingBotMsg.id }, 'Reconciled #dashboard control center embed');
      } else {
        // CREATE: first-time provisioning
        await this._executeDiagnosticOp({
          operationName: 'DASHBOARD_MESSAGE_CREATE',
          targetName: '#dashboard',
          targetType: 'GuildText',
          guild: channel.guild,
          botMember,
          correlationId,
          action: async () => {
            await channel.send({ embeds: [embed], components: rows });
          }
        });
        logger.info({ correlationId, channelId: channel.id }, 'Created #dashboard control center embed');
      }
    } catch (err) {
      logger.warn(
        { correlationId, channelId: channel.id, err: err.message },
        'Could not provision/reconcile #dashboard message'
      );
    }
  }

  /**
   * Post or reconcile (update) the generic Creator Center entry point in #welcome.
   * The persistent message MUST NOT contain creator-specific data — it is shared by all creators.
   * When a creator clicks the button, an ephemeral personalized view is returned.
   * Idempotent: safe to call multiple times — no duplicate messages will be created.
   * In DEV, also cleans up stale generic interaction error messages sitting in #welcome.
   * @private
   */
  /**
   * Reset / reconcile a single channel to its canonical fresh hub interface.
   * Can be invoked on demand by staff via /admin reset-channel.
   */
  async reconcileSingleChannel(channel, botMember = null, correlationId = null) {
    if (!channel || !channel.name) return null;
    const cid = correlationId || `reset_${Date.now()}`;
    const name = channel.name;

    // Staff Channels
    if (name === 'creators') {
      const [total, active, suspended, banned] = prisma?.user ? await Promise.all([
        prisma.user.count().catch(() => 0),
        prisma.user.count({ where: { status: 'ACTIVE' } }).catch(() => 0),
        prisma.user.count({ where: { status: 'SUSPENDED' } }).catch(() => 0),
        prisma.user.count({ where: { status: 'BANNED' } }).catch(() => 0)
      ]) : [0, 0, 0, 0];

      return await this._reconcileCanonicalChannelMessage({
        channel,
        botMember,
        correlationId: cid,
        channelName: 'creators',
        embed: buildStaffCreatorHubEmbed({
          totalCount: total,
          activeCount: active,
          suspendedCount: suspended,
          bannedCount: banned
        }),
        components: [buildStaffCreatorHubRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => (e.title || '').includes('CREATOR MANAGEMENT') || (e.title || '').includes('REVIEW QUEUE'))
          || msg.components?.some((r) => r.components?.some((c) => (c.customId || '').includes('admin_cr_') || (c.customId || '').includes('admin_rq_')))
      });
    }

    if (name === 'review-queue') {
      const [pendingVerification, underReview, flagged, postApproval] = prisma?.submission ? await Promise.all([
        prisma.submission.count({ where: { status: 'PENDING_VERIFICATION' } }).catch(() => 0),
        prisma.submission.count({ where: { status: 'UNDER_REVIEW' } }).catch(() => 0),
        prisma.submission.count({ where: { status: 'FLAGGED' } }).catch(() => 0),
        prisma.submission.count({ where: { status: 'POST_APPROVAL_REVIEW' } }).catch(() => 0)
      ]) : [0, 0, 0, 0];

      return await this._reconcileCanonicalChannelMessage({
        channel,
        botMember,
        correlationId: cid,
        channelName: 'review-queue',
        embed: buildStaffReviewQueueHubEmbed({
          pendingVerificationCount: pendingVerification,
          underReviewCount: underReview,
          flaggedCount: flagged,
          postApprovalCount: postApproval
        }),
        components: [buildStaffReviewQueueHubRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => (e.title || '').includes('REVIEW QUEUE'))
          || msg.components?.some((r) => r.components?.some((c) => (c.customId || '').includes('admin_rq_')))
      });
    }

    if (name === 'campaign-management') {
      const [active, paused, draft, total] = prisma?.campaign ? await Promise.all([
        prisma.campaign.count({ where: { status: 'ACTIVE' } }).catch(() => 0),
        prisma.campaign.count({ where: { status: 'PAUSED' } }).catch(() => 0),
        prisma.campaign.count({ where: { status: 'DRAFT' } }).catch(() => 0),
        prisma.campaign.count().catch(() => 0)
      ]) : [0, 0, 0, 0];

      return await this._reconcileCanonicalChannelMessage({
        channel,
        botMember,
        correlationId: cid,
        channelName: 'campaign-management',
        embed: buildStaffCampaignHubEmbed({
          activeCampaignsCount: active,
          pausedCampaignsCount: paused,
          draftCampaignsCount: draft,
          totalCampaignsCount: total
        }),
        components: [buildStaffCampaignHubRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => (e.title || '').includes('CAMPAIGN OPERATIONS'))
          || msg.components?.some((r) => r.components?.some((c) => (c.customId || '').includes('admin_cmp_')))
      });
    }

    if (name === 'payout-queue') {
      const [requested, underReview, approved, processing] = prisma?.payoutRequest ? await Promise.all([
        prisma.payoutRequest.count({ where: { status: 'REQUESTED' } }).catch(() => 0),
        prisma.payoutRequest.count({ where: { status: 'UNDER_REVIEW' } }).catch(() => 0),
        prisma.payoutRequest.count({ where: { status: 'APPROVED' } }).catch(() => 0),
        prisma.payoutRequest.count({ where: { status: 'PROCESSING' } }).catch(() => 0)
      ]) : [0, 0, 0, 0];

      return await this._reconcileCanonicalChannelMessage({
        channel,
        botMember,
        correlationId: cid,
        channelName: 'payout-queue',
        embed: buildStaffPayoutHubEmbed({
          requestedCount: requested,
          underReviewCount: underReview,
          approvedCount: approved,
          processingCount: processing
        }),
        components: [buildStaffPayoutHubRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => (e.title || '').includes('PAYOUT FINANCIAL'))
          || msg.components?.some((r) => r.components?.some((c) => (c.customId || '').includes('admin_pq_')))
      });
    }

    if (name === 'audit-log') {
      const totalEvents = prisma?.auditLog ? await prisma.auditLog.count().catch(() => 0) : 0;
      return await this._reconcileCanonicalChannelMessage({
        channel,
        botMember,
        correlationId: cid,
        channelName: 'audit-log',
        embed: buildStaffAuditHubEmbed({ totalEventsCount: totalEvents }),
        components: [buildStaffAuditHubRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => (e.title || '').includes('AUDIT LOG'))
          || msg.components?.some((r) => r.components?.some((c) => (c.customId || '').includes('admin_audit_')))
      });
    }

    // System Channels
    if (name === 'bot-status') {
      return await this._reconcileCanonicalChannelMessage({
        channel,
        botMember,
        correlationId: cid,
        channelName: 'bot-status',
        embed: buildStaffSystemStatusEmbed(),
        components: [buildStaffSystemStatusRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => (e.title || '').includes('SYSTEM STATUS') || (e.title || '').includes('BOT STATUS') || (e.title || '').includes('HEALTH'))
          || msg.components?.some((r) => r.components?.some((c) => (c.customId || '').includes('sys_status_')))
      });
    }

    if (name === 'bot-errors') {
      return await this._reconcileCanonicalChannelMessage({
        channel,
        botMember,
        correlationId: cid,
        channelName: 'bot-errors',
        embed: buildStaffBotErrorsEmbed(),
        components: [buildStaffSystemErrorsRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => (e.title || '').includes('ERROR') || (e.title || '').includes('DIAGNOSTIC'))
          || msg.components?.some((r) => r.components?.some((c) => (c.customId || '').includes('sys_errors_')))
      });
    }

    // Creator Channels
    if (name === 'dashboard') {
      const dashboardEmbed = buildCreatorDashboardChannelEmbed();
      const dashboardRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('dash_open')
          .setLabel('🎬 Open Creator Dashboard')
          .setStyle(ButtonStyle.Primary)
      );
      return await this._reconcileCanonicalChannelMessage({
        channel,
        botMember,
        correlationId: cid,
        channelName: 'dashboard',
        embed: dashboardEmbed,
        components: [dashboardRow],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => (e.title || '').includes('CREATOR CENTER'))
          || msg.components?.some((r) => r.components?.some((c) => (c.customId || '') === 'dash_open'))
      });
    }

    if (name === 'campaigns') {
      return await this._reconcileCanonicalChannelMessage({
        channel,
        botMember,
        correlationId: cid,
        channelName: 'campaigns',
        embed: buildCreatorCampaignsChannelEmbed(),
        components: [buildCreatorCampaignsChannelRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => (e.title || '').includes('CAMPAIGNS'))
          || msg.components?.some((r) => r.components?.some((c) => (c.customId || '').includes('campaigns')))
      });
    }

    if (name === 'submissions') {
      return await this._reconcileCanonicalChannelMessage({
        channel,
        botMember,
        correlationId: cid,
        channelName: 'submissions',
        embed: buildCreatorSubmissionsChannelEmbed(),
        components: [buildCreatorSubmissionsChannelRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => (e.title || '').includes('SUBMISSIONS'))
          || msg.components?.some((r) => r.components?.some((c) => (c.customId || '').includes('submit') || (c.customId || '').includes('clips')))
      });
    }

    if (name === 'stats') {
      return await this._reconcileCanonicalChannelMessage({
        channel,
        botMember,
        correlationId: cid,
        channelName: 'stats',
        embed: buildCreatorStatsChannelEmbed(),
        components: [buildCreatorStatsChannelRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => (e.title || '').includes('STATS'))
          || msg.components?.some((r) => r.components?.some((c) => (c.customId || '').includes('stats')))
      });
    }

    if (name === 'earnings') {
      return await this._reconcileCanonicalChannelMessage({
        channel,
        botMember,
        correlationId: cid,
        channelName: 'earnings',
        embed: buildCreatorEarningsChannelEmbed(),
        components: [buildCreatorEarningsChannelRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => (e.title || '').includes('EARNINGS'))
          || msg.components?.some((r) => r.components?.some((c) => (c.customId || '').includes('earnings')))
      });
    }

    if (name === 'payouts') {
      return await this._reconcileCanonicalChannelMessage({
        channel,
        botMember,
        correlationId: cid,
        channelName: 'payouts',
        embed: buildCreatorPayoutsChannelEmbed(),
        components: [buildCreatorPayoutsChannelRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => (e.title || '').includes('PAYOUTS'))
          || msg.components?.some((r) => r.components?.some((c) => (c.customId || '').includes('payout')))
      });
    }

    return null;
  }

  /**
   * Reconcile or post a canonical navigation message in a channel.
   * @private
   */
  async _reconcileCanonicalChannelMessage({
    channel,
    botMember,
    correlationId,
    channelName,
    embed,
    components,
    identifyFn
  }) {
    if (!channel || typeof channel.send !== 'function') return null;

    try {
      const botUserId = typeof botMember?.user?.id === 'string'
        ? botMember.user.id
        : typeof botMember?.id === 'string'
          ? botMember.id
          : channel.guild?.client?.user?.id || null;
      let existingBotMsg = null;

      if (channel.messages && typeof channel.messages.fetch === 'function') {
        const fetched = await channel.messages.fetch({ limit: 50 });
        const messageList = Array.isArray(fetched) ? fetched : (fetched?.values ? Array.from(fetched.values()) : []);
        existingBotMsg = messageList.find((msg) => {
          if (botUserId && msg.author?.id && msg.author.id !== botUserId) return false;
          if (typeof identifyFn === 'function') {
            const matched = identifyFn(msg);
            if (matched) return true;
          }
          return msg.embeds?.length > 0 && !msg.content?.includes('❌ An unexpected error occurred');
        }) || null;
      }

      if (existingBotMsg) {
        await this._executeDiagnosticOp({
          operationName: `CHANNEL_MSG_RECONCILE_${channelName.toUpperCase()}`,
          targetName: `#${channelName}`,
          targetType: 'GuildText',
          guild: channel.guild,
          botMember,
          correlationId,
          action: async () => {
            await existingBotMsg.edit({ content: null, embeds: [embed], components });
          }
        });
        logger.info({ correlationId, channelId: channel.id, msgId: existingBotMsg.id }, `Reconciled #${channelName} canonical message`);
      } else {
        let createdMsg = null;
        await this._executeDiagnosticOp({
          operationName: `CHANNEL_MSG_CREATE_${channelName.toUpperCase()}`,
          targetName: `#${channelName}`,
          targetType: 'GuildText',
          guild: channel.guild,
          botMember,
          correlationId,
          action: async () => {
            createdMsg = await channel.send({ embeds: [embed], components });
          }
        });
        existingBotMsg = createdMsg;
        logger.info({ correlationId, channelId: channel.id, msgId: createdMsg?.id }, `Created #${channelName} canonical message`);
      }

      // DEV only: clean up any stale interaction error messages
      await this._cleanupStaleChannelErrors(channel, botUserId, existingBotMsg?.id, botMember, correlationId);
      return existingBotMsg;
    } catch (err) {
      logger.warn(
        { correlationId, channelId: channel.id, channelName, err: err.message },
        `Could not provision/reconcile #${channelName} message`
      );
      return null;
    }
  }

  /**
   * Post or reconcile canonical messages in all CREATOR channels
   * @private
   */
  async _initializeCreatorChannelMessages(creatorChannels, botMember, correlationId) {
    if (!creatorChannels) return;

    const getTitle = (e) => (e.title || e.data?.title || '');
    const getBtnId = (c) => (c.customId || c.data?.custom_id || c.data?.customId || '');

    // 1. CREATOR/#dashboard
    if (creatorChannels.dashboard) {
      const dashboardEmbed = buildCreatorDashboardChannelEmbed();
      const dashboardRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('dash_open')
          .setLabel('🎬 Open Creator Dashboard')
          .setStyle(ButtonStyle.Primary)
      );
      await this._reconcileCanonicalChannelMessage({
        channel: creatorChannels.dashboard,
        botMember,
        correlationId,
        channelName: 'dashboard',
        embed: dashboardEmbed,
        components: [dashboardRow],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => getTitle(e).includes('CREATOR CENTER'))
          || msg.components?.some((r) => r.components?.some((c) => getBtnId(c) === 'dash_open'))
          || (msg.embeds?.length > 0 && !msg.content?.includes('❌ An unexpected error occurred'))
      });
    }

    // 2. CREATOR/#campaigns
    if (creatorChannels.campaigns) {
      await this._reconcileCanonicalChannelMessage({
        channel: creatorChannels.campaigns,
        botMember,
        correlationId,
        channelName: 'campaigns',
        embed: buildCreatorCampaignsChannelEmbed(),
        components: [buildCreatorCampaignsChannelRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => getTitle(e).includes('CAMPAIGNS'))
          || msg.components?.some((r) => r.components?.some((c) => getBtnId(c).includes('campaigns')))
      });
    }

    // 3. CREATOR/#submissions
    if (creatorChannels.submissions) {
      await this._reconcileCanonicalChannelMessage({
        channel: creatorChannels.submissions,
        botMember,
        correlationId,
        channelName: 'submissions',
        embed: buildCreatorSubmissionsChannelEmbed(),
        components: [buildCreatorSubmissionsChannelRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => getTitle(e).includes('SUBMISSIONS'))
          || msg.components?.some((r) => r.components?.some((c) => getBtnId(c).includes('submit') || getBtnId(c).includes('clips')))
      });
    }

    // 4. CREATOR/#stats
    if (creatorChannels.stats) {
      await this._reconcileCanonicalChannelMessage({
        channel: creatorChannels.stats,
        botMember,
        correlationId,
        channelName: 'stats',
        embed: buildCreatorStatsChannelEmbed(),
        components: [buildCreatorStatsChannelRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => getTitle(e).includes('STATS'))
          || msg.components?.some((r) => r.components?.some((c) => getBtnId(c).includes('stats')))
      });
    }

    // 5. CREATOR/#earnings
    if (creatorChannels.earnings) {
      await this._reconcileCanonicalChannelMessage({
        channel: creatorChannels.earnings,
        botMember,
        correlationId,
        channelName: 'earnings',
        embed: buildCreatorEarningsChannelEmbed(),
        components: [buildCreatorEarningsChannelRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => getTitle(e).includes('EARNINGS'))
          || msg.components?.some((r) => r.components?.some((c) => getBtnId(c).includes('earnings')))
      });
    }

    // 6. CREATOR/#payouts
    if (creatorChannels.payouts) {
      await this._reconcileCanonicalChannelMessage({
        channel: creatorChannels.payouts,
        botMember,
        correlationId,
        channelName: 'payouts',
        embed: buildCreatorPayoutsChannelEmbed(),
        components: [buildCreatorPayoutsChannelRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => getTitle(e).includes('PAYOUTS'))
          || msg.components?.some((r) => r.components?.some((c) => getBtnId(c).includes('payout')))
      });
    }
  }

  /**
   * Post or reconcile canonical messages in all STAFF operational channels
   * @private
   */
  async _initializeStaffChannelMessages(staffChannels, botMember, correlationId) {
    if (!staffChannels) return;

    const getTitle = (e) => (e.title || e.data?.title || '');
    const getBtnId = (c) => (c.customId || c.data?.custom_id || c.data?.customId || '');

    // 1. STAFF/#review-queue
    if (staffChannels['review-queue']) {
      const [pendingVerification, underReview, flagged, postApproval] = prisma?.submission ? await Promise.all([
        prisma.submission.count({ where: { status: 'PENDING_VERIFICATION' } }).catch(() => 0),
        prisma.submission.count({ where: { status: 'UNDER_REVIEW' } }).catch(() => 0),
        prisma.submission.count({ where: { status: 'FLAGGED' } }).catch(() => 0),
        prisma.submission.count({ where: { status: 'POST_APPROVAL_REVIEW' } }).catch(() => 0)
      ]) : [0, 0, 0, 0];

      await this._reconcileCanonicalChannelMessage({
        channel: staffChannels['review-queue'],
        botMember,
        correlationId,
        channelName: 'review-queue',
        embed: buildStaffReviewQueueHubEmbed({
          pendingVerificationCount: pendingVerification,
          underReviewCount: underReview,
          flaggedCount: flagged,
          postApprovalCount: postApproval
        }),
        components: [buildStaffReviewQueueHubRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => getTitle(e).includes('REVIEW QUEUE'))
          || msg.components?.some((r) => r.components?.some((c) => getBtnId(c).includes('admin_rq_')))
      });
    }

    // 2. STAFF/#creators
    if (staffChannels['creators']) {
      const [total, active, suspended, banned] = prisma?.user ? await Promise.all([
        prisma.user.count().catch(() => 0),
        prisma.user.count({ where: { status: 'ACTIVE' } }).catch(() => 0),
        prisma.user.count({ where: { status: 'SUSPENDED' } }).catch(() => 0),
        prisma.user.count({ where: { status: 'BANNED' } }).catch(() => 0)
      ]) : [0, 0, 0, 0];

      await this._reconcileCanonicalChannelMessage({
        channel: staffChannels['creators'],
        botMember,
        correlationId,
        channelName: 'creators',
        embed: buildStaffCreatorHubEmbed({
          totalCount: total,
          activeCount: active,
          suspendedCount: suspended,
          bannedCount: banned
        }),
        components: [buildStaffCreatorHubRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => getTitle(e).includes('CREATOR MANAGEMENT'))
          || msg.components?.some((r) => r.components?.some((c) => getBtnId(c).includes('admin_cr_')))
      });
    }

    // 3. STAFF/#campaign-management
    if (staffChannels['campaign-management']) {
      const [activeCount, pausedCount, completedCount, budgetAgg] = prisma?.campaign ? await Promise.all([
        prisma.campaign.count({ where: { status: 'ACTIVE' } }).catch(() => 0),
        prisma.campaign.count({ where: { status: 'PAUSED' } }).catch(() => 0),
        prisma.campaign.count({ where: { status: 'COMPLETED' } }).catch(() => 0),
        prisma.campaign.aggregate({ _sum: { totalBudget: true, consumedBudget: true } }).catch(() => null)
      ]) : [0, 0, 0, null];

      const totalBudget = Number(budgetAgg?._sum?.totalBudget || 0);
      const consumedBudget = Number(budgetAgg?._sum?.consumedBudget || 0);

      await this._reconcileCanonicalChannelMessage({
        channel: staffChannels['campaign-management'],
        botMember,
        correlationId,
        channelName: 'campaign-management',
        embed: buildStaffCampaignHubEmbed({
          activeCount,
          pausedCount,
          completedCount,
          totalBudget,
          consumedBudget,
          remainingBudget: Math.max(0, totalBudget - consumedBudget)
        }),
        components: [buildStaffCampaignHubRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => getTitle(e).includes('CAMPAIGN'))
          || msg.components?.some((r) => r.components?.some((c) => getBtnId(c).includes('admin_cmp_')))
      });
    }

    // 4. STAFF/#payout-queue
    if (staffChannels['payout-queue']) {
      const [pendingReqs, approvedReqs] = prisma?.payoutRequest ? await Promise.all([
        prisma.payoutRequest.findMany({ where: { status: 'REQUESTED' } }).catch(() => []),
        prisma.payoutRequest.count({ where: { status: 'APPROVED' } }).catch(() => 0)
      ]) : [[], 0];

      let totalPending = 0;
      for (const r of pendingReqs) totalPending += Number(r.amount || 0);

      await this._reconcileCanonicalChannelMessage({
        channel: staffChannels['payout-queue'],
        botMember,
        correlationId,
        channelName: 'payout-queue',
        embed: buildStaffPayoutHubEmbed({
          pendingCount: pendingReqs.length,
          totalPendingAmount: totalPending,
          approvedCount: approvedReqs
        }),
        components: [buildStaffPayoutHubRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => getTitle(e).includes('PAYOUT'))
          || msg.components?.some((r) => r.components?.some((c) => getBtnId(c).includes('admin_pq_')))
      });
    }

    // 5. STAFF/#audit-log
    if (staffChannels['audit-log']) {
      await this._reconcileCanonicalChannelMessage({
        channel: staffChannels['audit-log'],
        botMember,
        correlationId,
        channelName: 'audit-log',
        embed: buildStaffAuditHubEmbed(),
        components: [buildStaffAuditHubRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => getTitle(e).includes('AUDIT'))
          || msg.components?.some((r) => r.components?.some((c) => getBtnId(c).includes('admin_audit_')))
      });
    }
  }

  /**
   * Post or reconcile canonical messages in all SYSTEM channels
   * @private
   */
  async _initializeSystemChannelMessages(systemChannels, botMember, correlationId) {
    if (!systemChannels) return;

    const getTitle = (e) => (e.title || e.data?.title || '');
    const getBtnId = (c) => (c.customId || c.data?.custom_id || c.data?.customId || '');

    // 1. SYSTEM/#bot-status
    if (systemChannels['bot-status']) {
      await this._reconcileCanonicalChannelMessage({
        channel: systemChannels['bot-status'],
        botMember,
        correlationId,
        channelName: 'bot-status',
        embed: buildStaffSystemStatusEmbed(),
        components: [buildStaffSystemStatusRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => getTitle(e).includes('SYSTEM STATUS') || getTitle(e).includes('BOT STATUS') || getTitle(e).includes('HEALTH'))
          || msg.components?.some((r) => r.components?.some((c) => getBtnId(c).includes('sys_status_')))
      });
    }

    // 2. SYSTEM/#bot-errors
    if (systemChannels['bot-errors']) {
      await this._reconcileCanonicalChannelMessage({
        channel: systemChannels['bot-errors'],
        botMember,
        correlationId,
        channelName: 'bot-errors',
        embed: buildStaffBotErrorsEmbed(),
        components: [buildStaffSystemErrorsRow()],
        identifyFn: (msg) =>
          msg.embeds?.some((e) => getTitle(e).includes('ERROR') || getTitle(e).includes('DIAGNOSTIC'))
          || msg.components?.some((r) => r.components?.some((c) => getBtnId(c).includes('sys_errors_')))
      });
    }
  }

  /**
   * Backward-compatible alias for existing tests
   */
  async _initializeWelcomeChannel(channel, botMember, correlationId) {
    if (!channel) return;
    await this._initializeCreatorChannelMessages({ dashboard: channel }, botMember, correlationId);
  }

  /**
   * Remove stale generic interaction error messages from a DEV channel.
   * Safety: DEV only, targets ONLY bot-authored messages matching the known generic error string.
   * Never deletes canonical navigation messages or legitimate operational posts.
   * @private
   */
  async _cleanupStaleChannelErrors(channel, botUserId, canonicalMsgId, botMember, correlationId) {
    const isDev = this.config
      ? (this.config.isDevelopment ?? (this.config.env === 'development'))
      : (process.env.NODE_ENV === 'development');

    if (!isDev) return 0;

    try {
      if (!channel?.messages || typeof channel.messages.fetch !== 'function') {
        return 0;
      }

      const fetched = await channel.messages.fetch({ limit: 50 });
      const messageList = Array.isArray(fetched) ? fetched : (fetched?.values ? Array.from(fetched.values()) : []);

      let removedCount = 0;
      for (const msg of messageList) {
        if (!msg) continue;
        if (canonicalMsgId && msg.id === canonicalMsgId) continue;

        const isBotAuthor = msg.author?.id === botUserId;
        const isGenericError = typeof msg.content === 'string'
          && msg.content.includes('❌ An unexpected error occurred while processing your request');

        if (isBotAuthor && isGenericError) {
          if (typeof msg.delete === 'function') {
            await this._executeDiagnosticOp({
              operationName: 'CHANNEL_STALE_ERROR_CLEANUP',
              targetName: `#${channel.name || 'channel'}`,
              targetType: 'GuildText',
              guild: channel.guild,
              botMember,
              correlationId,
              action: async () => {
                await msg.delete();
              }
            });
            removedCount++;
            logger.info({ correlationId, channelId: channel.id, msgId: msg.id }, `Deleted stale interaction error message from #${channel.name}`);
          }
        }
      }

      return removedCount;
    } catch (err) {
      logger.warn(
        { correlationId, channelId: channel?.id, err: err.message },
        'Failed during stale channel error message cleanup'
      );
      return 0;
    }
  }

  async _cleanupStaleWelcomeErrors(channel, botUserId, canonicalMsgId, botMember, correlationId) {
    return this._cleanupStaleChannelErrors(channel, botUserId, canonicalMsgId, botMember, correlationId);
  }
}

export const serverProvisioner = new ServerProvisioner();
export default serverProvisioner;
