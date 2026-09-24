import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChannelType,
  PermissionsBitField,
  PermissionFlagsBits,
  Collection
} from 'discord.js';

import { ServerProvisioner } from '../src/bot/provisioning/server.provisioner.js';
import {
  ROLE_NAMES,
  ROLES_DEFINITION,
  SERVER_STRUCTURE,
  EXPECTED_COUNTS
} from '../src/bot/provisioning/server.structure.js';
import {
  GuildMismatchError,
  UnauthorizedProvisioningError,
  ProvisioningConflictError,
  RoleHierarchyError
} from '../src/bot/provisioning/server.provisioning.errors.js';
import {
  BASE_ROLE_PERMISSIONS,
  filterDelegatablePermissions
} from '../src/bot/provisioning/server.permissions.js';
import {
  AdminRole,
  AdminPermission
} from '../src/modules/admin/admin.auth.js';
import * as setupCommand from '../src/bot/commands/setup.js';

/**
 * In-memory Mock Discord Guild with realistic bot managed role and permissions
 */
function createMockGuild(guildId = 'dev_guild_12345') {
  let snowflakeId = 1000;
  const nextId = () => `snowflake_${snowflakeId++}`;

  const rolesCache = new Collection();
  const channelsCache = new Collection();

  const everyoneRole = {
    id: guildId,
    name: '@everyone',
    position: 0,
    permissions: new PermissionsBitField(0n)
  };
  rolesCache.set(everyoneRole.id, everyoneRole);

  const botManagedRole = {
    id: 'snowflake_bot_managed',
    name: 'Peak Clip',
    position: 999,
    managed: true,
    tags: { botId: 'bot_user_id_123' },
    permissions: new PermissionsBitField([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.SendMessagesInThreads,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.ReadMessageHistory
    ])
  };
  rolesCache.set(botManagedRole.id, botManagedRole);

  const mockGuild = {
    id: guildId,
    name: 'Peak Clip — DEV',
    client: {
      user: { id: 'bot_user_id_123' }
    },
    roles: {
      everyone: everyoneRole,
      cache: rolesCache,
      fetch: async () => rolesCache,
      create: async (data) => {
        const id = nextId();
        const role = {
          id,
          name: data.name,
          color: data.color || 0,
          hoist: Boolean(data.hoist),
          mentionable: Boolean(data.mentionable),
          permissions: new PermissionsBitField(data.permissions || 0n),
          position: data.position !== undefined ? data.position : rolesCache.size
        };
        rolesCache.set(id, role);
        return role;
      }
    },
    channels: {
      cache: channelsCache,
      fetch: async () => channelsCache,
      create: async (data) => {
        const id = nextId();
        const channel = {
          id,
          name: data.name,
          type: data.type,
          parentId: data.parent || null,
          topic: data.topic || null,
          messages: {
            fetch: async () => new Collection()
          },
          sentMessages: [],
          send: async (msg) => {
            channel.sentMessages.push(msg);
            return { id: nextId(), ...msg };
          },
          permissionOverwrites: {
            cache: new Collection(),
            set: async (overwrites) => {
              channel.permissionOverwrites.cache.clear();
              for (const ow of overwrites) {
                channel.permissionOverwrites.cache.set(ow.id, {
                  id: ow.id,
                  allow: new PermissionsBitField(ow.allow || 0n),
                  deny: new PermissionsBitField(ow.deny || 0n)
                });
              }
            }
          },
          lockPermissions: async () => {
            if (channel.parentId) {
              const parentCat = channelsCache.get(channel.parentId);
              if (parentCat) {
                channel.permissionOverwrites.cache = new Collection(
                  parentCat.permissionOverwrites.cache
                );
              }
            }
          },
          setParent: async (parentId) => {
            channel.parentId = parentId;
          }
        };

        if (data.permissionOverwrites) {
          await channel.permissionOverwrites.set(data.permissionOverwrites);
        }

        channelsCache.set(id, channel);
        return channel;
      }
    },
    members: {
      me: {
        id: 'bot_user_id_123',
        user: { id: 'bot_user_id_123', tag: 'Peak Clip#1234' },
        permissions: botManagedRole.permissions,
        roles: {
          botRole: botManagedRole,
          highest: botManagedRole,
          cache: new Collection([[botManagedRole.id, botManagedRole]])
        }
      },
      fetchMe: async () => mockGuild.members.me
    }
  };

  return mockGuild;
}

describe('Discord Server Provisioning Subsystem (Phase 9A)', () => {
  const TARGET_GUILD_ID = 'dev_guild_12345';
  const testConfig = {
    discord: {
      guildId: TARGET_GUILD_ID,
      clientId: 'bot_user_id_123',
      token: 'mock_token'
    },
    admin: {
      adminRoleIds: ['admin_role_999'],
      campaignManagerRoleIds: ['cm_role_888'],
      adminFromDiscordAdministrator: true
    }
  };

  let provisioner;
  let mockGuild;
  let adminActor;

  beforeEach(() => {
    provisioner = new ServerProvisioner(testConfig);
    mockGuild = createMockGuild(TARGET_GUILD_ID);
    adminActor = {
      user: { id: 'admin_user_1', tag: 'PeakAdmin#0001' },
      member: {
        roles: ['admin_role_999'],
        permissions: 0n
      }
    };
  });

  describe('Authorization & Target Guild Verification', () => {
    test('rejects provisioning on mismatched guild ID with GuildMismatchError', async () => {
      const foreignGuild = createMockGuild('unauthorized_server_999');

      await assert.rejects(
        () => provisioner.provisionServer(foreignGuild, adminActor),
        (err) => {
          assert.ok(err instanceof GuildMismatchError);
          assert.equal(err.context.attemptedGuildId, 'unauthorized_server_999');
          assert.equal(err.context.expectedGuildId, TARGET_GUILD_ID);
          return true;
        }
      );
    });

    test('rejects provisioning by non-admin actor with UnauthorizedProvisioningError', async () => {
      const regularCreator = {
        user: { id: 'creator_user_1' },
        member: {
          roles: ['creator_role_777'],
          permissions: 0n
        }
      };

      await assert.rejects(
        () => provisioner.provisionServer(mockGuild, regularCreator),
        (err) => err.name === 'UnauthorizedAdminActionError' || err instanceof UnauthorizedProvisioningError
      );
    });

    test('rejects provisioning by Campaign Manager (requires full Peak Admin authority)', async () => {
      const campaignManagerActor = {
        user: { id: 'cm_user_1' },
        member: {
          roles: ['cm_role_888'],
          permissions: 0n
        }
      };

      await assert.rejects(
        () => provisioner.provisionServer(mockGuild, campaignManagerActor),
        (err) => {
          assert.ok(err instanceof UnauthorizedProvisioningError);
          return true;
        }
      );
    });

    test('allows provisioning by actor with guild Administrator permission', async () => {
      const guildOwnerActor = {
        user: { id: 'owner_user_1' },
        member: {
          roles: [],
          permissions: PermissionsBitField.Flags.Administrator
        }
      };

      const result = await provisioner.provisionServer(mockGuild, guildOwnerActor);
      assert.equal(result.success, true);
      assert.equal(result.status, 'Ready');
    });
  });

  describe('Managed Bot Role Resolution & Hierarchy', () => {
    test('dynamically resolves managed bot role via tags.botId without creating duplicate custom bot role', async () => {
      const initialRolesCount = mockGuild.roles.cache.size; // @everyone + Peak Clip = 2

      const result = await provisioner.provisionServer(mockGuild, adminActor);

      // Verify no duplicate role named "Peak Clip Bot" was created
      const duplicateBotRole = mockGuild.roles.cache.find((r) => r.name.toLowerCase() === 'peak clip bot');
      assert.equal(duplicateBotRole, undefined, 'Must NOT create duplicate "Peak Clip Bot" role');

      // Bot role was reused from the managed integration role
      assert.equal(result.roles.created, 3); // Peak Admin, Campaign Manager, Creator
      assert.equal(result.roles.reused, 1);  // Peak Clip bot role
      assert.equal(result.roles.total, 4);

      // Verify total roles in cache: @everyone + Peak Clip + 3 created = 5
      assert.equal(mockGuild.roles.cache.size, initialRolesCount + 3);
    });

    test('throws RoleHierarchyError if target role is positioned at or above bot managed role', async () => {
      // Pre-create 'Peak Admin' with position >= bot position
      await mockGuild.roles.create({
        name: 'Peak Admin',
        position: 1000 // Above bot's 999
      });

      await assert.rejects(
        () => provisioner.provisionServer(mockGuild, adminActor),
        (err) => {
          assert.ok(err instanceof RoleHierarchyError);
          assert.equal(err.context.roleName, 'Peak Admin');
          assert.equal(err.context.botHighestPosition, 999);
          return true;
        }
      );
    });
  });

  describe('Declarative Resource Creation & Idempotency', () => {
    test('creates 3 missing server roles, 4 categories, and 16 channels on fresh server', async () => {
      const result = await provisioner.provisionServer(mockGuild, adminActor);

      assert.equal(result.success, true);
      assert.equal(result.roles.created, 3);
      assert.equal(result.roles.reused, 1);
      assert.equal(result.roles.total, 4);

      assert.equal(result.categories.created, 4);
      assert.equal(result.categories.reused, 0);
      assert.equal(result.categories.total, 4);

      assert.equal(result.channels.created, 16);
      assert.equal(result.channels.reused, 0);
      assert.equal(result.channels.total, 16);

      // Verify roles exist
      for (const def of ROLES_DEFINITION) {
        const found = mockGuild.roles.cache.find((r) => r.name.toLowerCase() === def.name.toLowerCase());
        assert.ok(found, `Role ${def.name} should exist`);
      }

      // Verify categories and channels exist
      for (const catDef of SERVER_STRUCTURE) {
        const cat = mockGuild.channels.cache.find(
          (c) => c.name.toLowerCase() === catDef.category.toLowerCase() && c.type === ChannelType.GuildCategory
        );
        assert.ok(cat, `Category ${catDef.category} should exist`);

        for (const chDef of catDef.channels) {
          const ch = mockGuild.channels.cache.find(
            (c) => c.name.toLowerCase() === chDef.name.toLowerCase() && c.parentId === cat.id
          );
          assert.ok(ch, `Channel ${chDef.name} should exist under ${catDef.category}`);
        }
      }
    });

    test('is strictly idempotent on subsequent runs without duplicating resources', async () => {
      // First run
      const firstRun = await provisioner.provisionServer(mockGuild, adminActor);
      assert.equal(firstRun.roles.created, 3);
      assert.equal(firstRun.roles.reused, 1);
      assert.equal(firstRun.categories.created, 4);
      assert.equal(firstRun.channels.created, 16);

      const totalChannelsAfterFirst = mockGuild.channels.cache.size;
      const totalRolesAfterFirst = mockGuild.roles.cache.size;

      // Second run (idempotent)
      const secondRun = await provisioner.provisionServer(mockGuild, adminActor);
      assert.equal(secondRun.success, true);
      assert.equal(secondRun.roles.created, 0);
      assert.equal(secondRun.roles.reused, 4);
      assert.equal(secondRun.categories.created, 0);
      assert.equal(secondRun.categories.reused, 4);
      assert.equal(secondRun.channels.created, 0);
      assert.equal(secondRun.channels.reused, 16);

      // Cache sizes must remain identical
      assert.equal(mockGuild.channels.cache.size, totalChannelsAfterFirst);
      assert.equal(mockGuild.roles.cache.size, totalRolesAfterFirst);

      // Third run
      const thirdRun = await provisioner.provisionServer(mockGuild, adminActor);
      assert.equal(thirdRun.channels.created, 0);
      assert.equal(thirdRun.channels.reused, 16);
    });

    test('preserves existing unrelated channels like #general and #random', async () => {
      const generalChannel = await mockGuild.channels.create({
        name: 'general',
        type: ChannelType.GuildText,
        topic: 'Original general channel'
      });
      const randomChannel = await mockGuild.channels.create({
        name: 'random-chat',
        type: ChannelType.GuildText
      });

      await provisioner.provisionServer(mockGuild, adminActor);

      assert.ok(mockGuild.channels.cache.has(generalChannel.id));
      assert.ok(mockGuild.channels.cache.has(randomChannel.id));
      assert.equal(mockGuild.channels.cache.get(generalChannel.id).topic, 'Original general channel');
    });

    test('initializes #dashboard welcome embed once and does not duplicate on second run', async () => {
      await provisioner.provisionServer(mockGuild, adminActor);

      const staffCat = mockGuild.channels.cache.find((c) => c.name === 'STAFF');
      const dashboard = mockGuild.channels.cache.find((c) => c.name === 'dashboard' && c.parentId === staffCat.id);
      assert.ok(dashboard);
      assert.equal(dashboard.sentMessages.length, 1);
      assert.equal(dashboard.sentMessages[0].embeds[0].data.title, 'PEAK CLIP — CONTROL CENTER');

      // On second run: simulate the bot's existing message being present.
      // The mock must have author.id === bot user id and at least one embed
      // so that the reconciler detects it and calls edit() instead of send().
      const botMsg = {
        id: 'msg_1',
        author: { id: 'bot_user_id_123' },
        embeds: [{ data: { title: 'PEAK CLIP — CONTROL CENTER' } }],
        edit: async () => {}
      };
      dashboard.messages.fetch = async () => new Collection([['msg_1', botMsg]]);

      await provisioner.provisionServer(mockGuild, adminActor);
      // sentMessages.length must still be 1 — reconcile edits, does not send a duplicate
      assert.equal(dashboard.sentMessages.length, 1);
    });
  });

  describe('Security & Permission Model Invariants', () => {
    test('created roles strictly use delegatable permissions and NEVER contain Administrator, ManageMessages, AddReactions, or UseApplicationCommands', async () => {
      await provisioner.provisionServer(mockGuild, adminActor);

      for (const roleDef of ROLES_DEFINITION) {
        const role = mockGuild.roles.cache.find((r) => r.name.toLowerCase() === roleDef.name.toLowerCase());
        assert.ok(role, `Role ${roleDef.name} must exist`);

        // Forbidden flags
        assert.equal(role.permissions.has(PermissionFlagsBits.Administrator), false);
        assert.equal(role.permissions.has(PermissionFlagsBits.ManageMessages), false);
        assert.equal(role.permissions.has(PermissionFlagsBits.AddReactions), false);
        assert.equal(role.permissions.has(PermissionFlagsBits.UseApplicationCommands), false);

        // Allowed delegatable flags
        assert.equal(role.permissions.has(PermissionFlagsBits.ViewChannel), true);
        assert.equal(role.permissions.has(PermissionFlagsBits.SendMessages), true);
      }
    });

    test('filterDelegatablePermissions strips any permission not possessed by bot', () => {
      const botPerms = new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages
      ]);

      const requested =
        PermissionFlagsBits.ViewChannel |
        PermissionFlagsBits.SendMessages |
        PermissionFlagsBits.ManageMessages; // Not in botPerms

      const delegatable = filterDelegatablePermissions(requested, botPerms);
      const delegatableBits = new PermissionsBitField(delegatable);

      assert.equal(delegatableBits.has(PermissionFlagsBits.ViewChannel), true);
      assert.equal(delegatableBits.has(PermissionFlagsBits.SendMessages), true);
      assert.equal(delegatableBits.has(PermissionFlagsBits.ManageMessages), false);
    });

    test('permission overwrites strictly hide STAFF and SYSTEM from @everyone and Creators', async () => {
      await provisioner.provisionServer(mockGuild, adminActor);

      const everyoneRole = mockGuild.roles.everyone;
      const creatorRole = mockGuild.roles.cache.find((r) => r.name === ROLE_NAMES.CREATOR);
      const staffCat = mockGuild.channels.cache.find(
        (c) => c.name === 'STAFF' && c.type === ChannelType.GuildCategory
      );
      const systemCat = mockGuild.channels.cache.find(
        (c) => c.name === 'SYSTEM' && c.type === ChannelType.GuildCategory
      );

      // Check STAFF category overwrites
      const staffEveryoneOw = staffCat.permissionOverwrites.cache.get(everyoneRole.id);
      assert.ok(staffEveryoneOw);
      assert.ok(staffEveryoneOw.deny.has(PermissionFlagsBits.ViewChannel));

      const staffCreatorOw = staffCat.permissionOverwrites.cache.get(creatorRole.id);
      assert.ok(staffCreatorOw);
      assert.ok(staffCreatorOw.deny.has(PermissionFlagsBits.ViewChannel));

      // Check SYSTEM category overwrites
      const systemEveryoneOw = systemCat.permissionOverwrites.cache.get(everyoneRole.id);
      assert.ok(systemEveryoneOw.deny.has(PermissionFlagsBits.ViewChannel));

      const systemCreatorOw = systemCat.permissionOverwrites.cache.get(creatorRole.id);
      assert.ok(systemCreatorOw.deny.has(PermissionFlagsBits.ViewChannel));
    });

    test('Campaign Manager is denied financial authority on #payout-queue', async () => {
      await provisioner.provisionServer(mockGuild, adminActor);

      const cmRole = mockGuild.roles.cache.find((r) => r.name === ROLE_NAMES.CAMPAIGN_MANAGER);
      const payoutQueue = mockGuild.channels.cache.find((c) => c.name === 'payout-queue');

      assert.ok(payoutQueue);
      const cmOw = payoutQueue.permissionOverwrites.cache.get(cmRole.id);
      assert.ok(cmOw, 'Campaign Manager must have explicit overwrite on #payout-queue');
      assert.ok(
        cmOw.deny.has(PermissionFlagsBits.ViewChannel),
        'Campaign Manager must be explicitly denied ViewChannel on #payout-queue'
      );
    });

    test('Campaign Manager has read-only access to #audit-log', async () => {
      await provisioner.provisionServer(mockGuild, adminActor);

      const cmRole = mockGuild.roles.cache.find((r) => r.name === ROLE_NAMES.CAMPAIGN_MANAGER);
      const auditLog = mockGuild.channels.cache.find((c) => c.name === 'audit-log');

      assert.ok(auditLog);
      const cmOw = auditLog.permissionOverwrites.cache.get(cmRole.id);
      assert.ok(cmOw);
      assert.ok(cmOw.allow.has(PermissionFlagsBits.ViewChannel));
      assert.ok(cmOw.deny.has(PermissionFlagsBits.SendMessages));
    });

    test('CREATOR/#dashboard allows @everyone to view channel and read history, but not send text', async () => {
      await provisioner.provisionServer(mockGuild, adminActor);

      const everyoneRole = mockGuild.roles.everyone;
      const creatorCat = mockGuild.channels.cache.find((c) => c.name === 'CREATOR');
      const dashChannel = mockGuild.channels.cache.find((c) => c.name === 'dashboard' && c.parentId === creatorCat.id);

      assert.ok(dashChannel);
      const ow = dashChannel.permissionOverwrites.cache.get(everyoneRole.id);
      assert.ok(ow);
      assert.ok(ow.allow.has(PermissionFlagsBits.ViewChannel));
      assert.ok(ow.allow.has(PermissionFlagsBits.ReadMessageHistory));
      assert.ok(ow.deny.has(PermissionFlagsBits.SendMessages));
    });
  });

  describe('Conflict & Error Handling', () => {
    test('throws ProvisioningConflictError if a channel exists with conflicting incompatible type', async () => {
      await mockGuild.channels.create({
        name: 'rules',
        type: ChannelType.GuildVoice
      });

      await assert.rejects(
        () => provisioner.provisionServer(mockGuild, adminActor),
        (err) => {
          assert.ok(err instanceof ProvisioningConflictError);
          assert.equal(err.context.resourceName, 'rules');
          assert.equal(err.context.expectedType, 'GuildText');
          return true;
        }
      );
    });

    test('throws ProvisioningConflictError if a category exists with conflicting non-category type', async () => {
      await mockGuild.channels.create({
        name: 'INFORMATION',
        type: ChannelType.GuildText
      });

      await assert.rejects(
        () => provisioner.provisionServer(mockGuild, adminActor),
        (err) => {
          assert.ok(err instanceof ProvisioningConflictError);
          assert.equal(err.context.resourceName, 'INFORMATION');
          assert.equal(err.context.expectedType, 'GuildCategory');
          return true;
        }
      );
    });
  });

  describe('/setup Slash Command Interaction', () => {
    test('executes /setup slash command successfully for authorized admin and replies ephemerally', async () => {
      let deferred = false;
      let replyPayload = null;

      const mockInteraction = {
        guildId: TARGET_GUILD_ID,
        guild: mockGuild,
        user: adminActor.user,
        member: adminActor.member,
        deferReply: async (opts) => {
          deferred = Boolean(opts?.ephemeral);
        },
        editReply: async (payload) => {
          replyPayload = payload;
        }
      };

      await setupCommand.execute(mockInteraction, provisioner);

      assert.equal(deferred, true);
      assert.ok(replyPayload);
      assert.ok(replyPayload.embeds && replyPayload.embeds.length > 0);

      const embed = replyPayload.embeds[0].data;
      assert.equal(embed.title, 'Peak Clip Server Setup');
      assert.ok(embed.description.includes('✓ **Roles**: 4/4'));
      assert.ok(embed.description.includes('✓ **Categories**: 4/4'));
      assert.ok(embed.description.includes('✓ **Channels**: 16/16'));
      assert.ok(embed.description.includes('`Ready`'));
    });

    test('/setup handles errors gracefully and renders clear error embed', async () => {
      let replyPayload = null;

      const mockInteraction = {
        guildId: 'wrong_guild_id',
        guild: createMockGuild('wrong_guild_id'),
        user: adminActor.user,
        member: adminActor.member,
        deferReply: async () => {},
        editReply: async (payload) => {
          replyPayload = payload;
        }
      };

      await setupCommand.execute(mockInteraction, provisioner);

      assert.ok(replyPayload);
      const embed = replyPayload.embeds[0].data;
      assert.ok(embed.title.includes('Guild Mismatch'));
      assert.ok(embed.description.includes('not configured as the target Peak Clip environment'));
    });

    test('acknowledges via deferReply before provisioning begins', async () => {
      const callSequence = [];

      const trackingProvisioner = {
        config: testConfig,
        provisionServer: async (guild, actor) => {
          callSequence.push('provisionServer');
          return await provisioner.provisionServer(guild, actor);
        }
      };

      const mockInteraction = {
        guildId: TARGET_GUILD_ID,
        guild: mockGuild,
        user: adminActor.user,
        member: adminActor.member,
        deferred: false,
        replied: false,
        deferReply: async (opts) => {
          callSequence.push('deferReply');
          mockInteraction.deferred = true;
        },
        editReply: async (payload) => {
          callSequence.push('editReply');
        }
      };

      await setupCommand.execute(mockInteraction, trackingProvisioner);

      assert.deepEqual(callSequence, ['deferReply', 'provisionServer', 'editReply']);
    });

    test('slow provisioning (simulated 30s+) still results in a successful editReply', async () => {
      let finalEmbed = null;

      const slowProvisioner = {
        config: testConfig,
        provisionServer: async () => {
          // Simulate latency
          await new Promise((r) => setTimeout(r, 20));
          return {
            roles: { total: 4, created: 0, reused: 4 },
            categories: { total: 4, created: 0, reused: 4 },
            channels: { total: 17, created: 0, reused: 17 },
            status: 'Ready',
            durationMs: 32500
          };
        }
      };

      const mockInteraction = {
        guildId: TARGET_GUILD_ID,
        guild: mockGuild,
        user: adminActor.user,
        member: adminActor.member,
        deferred: false,
        replied: false,
        deferReply: async () => {
          mockInteraction.deferred = true;
        },
        editReply: async (payload) => {
          finalEmbed = payload.embeds[0].data;
        }
      };

      await setupCommand.execute(mockInteraction, slowProvisioner);

      assert.ok(finalEmbed);
      assert.equal(finalEmbed.title, 'Peak Clip Server Setup');
      assert.ok(finalEmbed.description.includes('32500ms'));
      assert.ok(finalEmbed.description.includes('`Ready`'));
    });

    test('provisioning failure after deferReply produces an error editReply and prevents double-reply', async () => {
      let replyCalled = false;
      let editReplyPayload = null;

      const failingProvisioner = {
        config: testConfig,
        provisionServer: async () => {
          throw new RoleHierarchyError('Peak Admin', 2, 5);
        }
      };

      const mockInteraction = {
        guildId: TARGET_GUILD_ID,
        guild: mockGuild,
        user: adminActor.user,
        member: adminActor.member,
        deferred: false,
        replied: false,
        deferReply: async () => {
          mockInteraction.deferred = true;
        },
        reply: async () => {
          replyCalled = true;
        },
        editReply: async (payload) => {
          editReplyPayload = payload;
        }
      };

      await setupCommand.execute(mockInteraction, failingProvisioner);

      assert.equal(replyCalled, false, 'reply() must NEVER be called after deferReply()');
      assert.ok(editReplyPayload);
      const embed = editReplyPayload.embeds[0].data;
      assert.ok(embed.title.includes('Role Hierarchy Conflict'));
    });

    test('prevents double-reply/InteractionAlreadyReplied when interaction is already deferred', async () => {
      let deferReplyCallCount = 0;
      let editReplyCalled = false;

      const mockInteraction = {
        guildId: TARGET_GUILD_ID,
        guild: mockGuild,
        user: adminActor.user,
        member: adminActor.member,
        deferred: true, // Already deferred by external wrapper or middleware
        replied: false,
        deferReply: async () => {
          deferReplyCallCount++;
        },
        editReply: async () => {
          editReplyCalled = true;
        }
      };

      await setupCommand.execute(mockInteraction, provisioner);

      assert.equal(deferReplyCallCount, 0, 'deferReply must not be called again if already deferred');
      assert.equal(editReplyCalled, true);
    });

    test('authorization failure before deferReply is handled with immediate reply and skips provisioning', async () => {
      let provisionerInvoked = false;
      let deferred = false;
      let replyPayload = null;

      const trackingProvisioner = {
        config: testConfig,
        provisionServer: async () => {
          provisionerInvoked = true;
        }
      };

      const unauthorizedInteraction = {
        guildId: TARGET_GUILD_ID,
        guild: mockGuild,
        user: { id: 'regular_user_999' },
        member: {
          roles: ['creator_role_777'],
          permissions: 0n
        },
        deferred: false,
        replied: false,
        deferReply: async () => {
          deferred = true;
        },
        reply: async (payload) => {
          replyPayload = payload;
          unauthorizedInteraction.replied = true;
        }
      };

      await setupCommand.execute(unauthorizedInteraction, trackingProvisioner);

      assert.equal(provisionerInvoked, false, 'provisionServer must NOT be invoked for unauthorized user');
      assert.equal(deferred, false, 'deferReply must NOT be called for unauthorized user');
      assert.ok(replyPayload);
      const embed = replyPayload.embeds[0].data;
      assert.ok(embed.title.includes('Unauthorized Action'));
    });
  });
});
