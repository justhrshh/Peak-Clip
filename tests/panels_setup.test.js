import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  Collection,
  PermissionsBitField,
  PermissionFlagsBits
} from 'discord.js';
import { PanelService, PANEL_DEFINITIONS } from '../src/bot/panels/panel.service.js';
import * as adminCommand from '../src/bot/commands/admin.js';
import { AdminRole, AdminPermission } from '../src/modules/admin/admin.auth.js';
import { UnauthorizedAdminActionError } from '../src/modules/admin/admin.errors.js';
import { config } from '../src/config/index.js';

function createMockTextChannel(id, name, botUserId = 'bot_user_123', missingPermissions = []) {
  const sentMessages = [];
  let snowflake = 3000;

  const effectivePerms = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks
  ]);
  for (const perm of missingPermissions) {
    effectivePerms.remove(perm);
  }

  const channel = {
    id,
    name,
    isTextBased: () => true,
    guild: {
      id: 'guild_test_1',
      client: { user: { id: botUserId } }
    },
    permissionsFor: (member) => effectivePerms,
    messages: {
      fetch: async (query) => {
        if (typeof query === 'string') {
          const msg = sentMessages.find((m) => m.id === query);
          if (!msg) throw new Error('Unknown Message');
          return msg;
        }
        return new Collection(sentMessages.map((m) => [m.id, m]));
      }
    },
    send: async (payload) => {
      const msg = {
        id: `msg_${snowflake++}`,
        channelId: id,
        author: { id: botUserId },
        content: payload.content || null,
        embeds: payload.embeds || [],
        components: payload.components || [],
        edit: async (editPayload) => {
          if (editPayload.content !== undefined) msg.content = editPayload.content;
          if (editPayload.embeds) msg.embeds = editPayload.embeds;
          if (editPayload.components) msg.components = editPayload.components;
          return msg;
        }
      };
      sentMessages.push(msg);
      return msg;
    },
    _sentMessages: sentMessages
  };

  return channel;
}

describe('Operational Panels Subsystem (Zero Provisioning)', () => {
  const botUserId = 'bot_user_123';
  let channelsCache;
  let mockGuild;
  let mockClient;
  let mockDb;

  beforeEach(() => {
    channelsCache = new Collection();
    mockDb = {
      systemSetting: {
        _store: new Map(),
        findUnique: async ({ where }) => {
          const val = mockDb.systemSetting._store.get(where.key);
          return val ? { key: where.key, value: val } : null;
        },
        upsert: async ({ where, create, update }) => {
          const val = update?.value || create?.value;
          mockDb.systemSetting._store.set(where.key, val);
          return { key: where.key, value: val };
        },
        delete: async ({ where }) => {
          mockDb.systemSetting._store.delete(where.key);
          return {};
        }
      },
      submission: { count: async () => 0 },
      user: { count: async () => 0 },
      campaign: { count: async () => 0 },
      payoutRequest: { count: async () => 0 },
      auditLog: { count: async () => 0 }
    };

    mockGuild = {
      id: 'guild_test_1',
      channels: {
        cache: channelsCache,
        fetch: async (id) => channelsCache.get(id) || null
      },
      members: {
        me: {
          id: botUserId,
          user: { id: botUserId }
        },
        fetchMe: async () => mockGuild.members.me
      }
    };

    mockClient = {
      user: { id: botUserId },
      guilds: {
        cache: new Collection([['guild_test_1', mockGuild]])
      },
      channels: {
        fetch: async (id) => channelsCache.get(id) || null
      }
    };
  });

  test('creates panels when none exist and stores message IDs', async () => {
    const subChannel = createMockTextChannel('ch_sub_1', 'submissions', botUserId);
    channelsCache.set(subChannel.id, subChannel);

    const testConfig = {
      discord: {
        guildId: 'guild_test_1',
        channels: {
          submissions: 'ch_sub_1'
        }
      }
    };

    const panelService = new PanelService(mockDb, testConfig);
    const results = await panelService.deployAllPanels(mockClient, mockGuild, testConfig);

    assert.equal(results.created.length, 1);
    assert.equal(results.created[0].panelKey, 'submissions');
    assert.equal(subChannel._sentMessages.length, 1);

    // Stored in systemSetting
    const stored = await panelService.getStoredPanel('submissions');
    assert.ok(stored);
    assert.equal(stored.channelId, 'ch_sub_1');
    assert.equal(stored.messageId, subChannel._sentMessages[0].id);
  });

  test('edits existing panels on subsequent runs without creating duplicates (idempotency)', async () => {
    const subChannel = createMockTextChannel('ch_sub_1', 'submissions', botUserId);
    channelsCache.set(subChannel.id, subChannel);

    const testConfig = {
      discord: {
        guildId: 'guild_test_1',
        channels: {
          submissions: 'ch_sub_1'
        }
      }
    };

    const panelService = new PanelService(mockDb, testConfig);

    // Run 1: CREATES panel
    const res1 = await panelService.deployAllPanels(mockClient, mockGuild, testConfig);
    assert.equal(res1.created.length, 1);
    assert.equal(subChannel._sentMessages.length, 1);
    const firstMsgId = subChannel._sentMessages[0].id;

    // Run 2: UPDATES existing panel (zero new messages sent)
    const res2 = await panelService.deployAllPanels(mockClient, mockGuild, testConfig);
    assert.equal(res2.created.length, 0);
    assert.equal(res2.updated.length, 1);
    assert.equal(res2.updated[0].panelKey, 'submissions');
    assert.equal(res2.updated[0].messageId, firstMsgId);
    assert.equal(subChannel._sentMessages.length, 1); // No new message created
  });

  test('skips unset channel IDs cleanly with informative reason', async () => {
    const testConfig = {
      discord: {
        guildId: 'guild_test_1',
        channels: {
          // All channels unset
        }
      }
    };

    const panelService = new PanelService(mockDb, testConfig);
    const results = await panelService.deployAllPanels(mockClient, mockGuild, testConfig);

    assert.equal(results.created.length, 0);
    assert.equal(results.updated.length, 0);
    assert.equal(results.skipped.length, Object.keys(PANEL_DEFINITIONS).length);
    assert.ok(results.skipped.every((s) => s.reason.includes('unset in environment')));
  });

  test('skips channels where bot lacks SendMessages or EmbedLinks permission', async () => {
    const restrictedChannel = createMockTextChannel(
      'ch_restricted_1',
      'submissions',
      botUserId,
      [PermissionFlagsBits.SendMessages] // Missing SendMessages
    );
    channelsCache.set(restrictedChannel.id, restrictedChannel);

    const testConfig = {
      discord: {
        guildId: 'guild_test_1',
        channels: {
          submissions: 'ch_restricted_1'
        }
      }
    };

    const panelService = new PanelService(mockDb, testConfig);
    const results = await panelService.deployAllPanels(mockClient, mockGuild, testConfig);

    assert.equal(results.created.length, 0);
    const skipped = results.skipped.find((s) => s.panelKey === 'submissions');
    assert.ok(skipped);
    assert.match(skipped.reason, /Missing permissions.*SendMessages/i);
    assert.equal(restrictedChannel._sentMessages.length, 0);
  });

  test('never touches or overwrites messages authored by other users', async () => {
    const channel = createMockTextChannel('ch_user_msg', 'submissions', botUserId);
    // Put another user's message in the channel first
    channel._sentMessages.push({
      id: 'msg_other_user_999',
      channelId: channel.id,
      author: { id: 'other_user_888' },
      content: 'Hello everyone!',
      embeds: [{ title: 'SUBMISSIONS HUB' }],
      edit: async () => {
        throw new Error('SHOULD NEVER EDIT OTHER USERS MESSAGE');
      }
    });
    channelsCache.set(channel.id, channel);

    const testConfig = {
      discord: {
        guildId: 'guild_test_1',
        channels: {
          submissions: 'ch_user_msg'
        }
      }
    };

    const panelService = new PanelService(mockDb, testConfig);
    const results = await panelService.deployAllPanels(mockClient, mockGuild, testConfig);

    assert.equal(results.created.length, 1);
    // Verified: sent a new bot message instead of touching other_user's message
    assert.equal(channel._sentMessages.length, 2);
    assert.equal(channel._sentMessages[1].author.id, botUserId);
  });

  test('/admin setup panels slash command is gated by DISCORD_ADMIN_ROLE_IDS and returns ephemeral summary', async () => {
    const channel = createMockTextChannel('ch_camp_1', 'campaigns', botUserId);
    channelsCache.set(channel.id, channel);

    const prevAdminRoleIds = config.admin.adminRoleIds;
    config.admin.adminRoleIds = ['admin_role_999'];

    try {
      let replyPayload = null;
      let deferred = false;

      const mockAdminInteraction = {
        commandName: 'admin',
        user: { id: 'admin_user_1' },
        member: {
          id: 'admin_user_1',
          roles: { cache: new Collection([['admin_role_999', { id: 'admin_role_999', name: 'Admin' }]]) },
          permissions: new PermissionsBitField(0n)
        },
        client: mockClient,
        guild: mockGuild,
        options: {
          getSubcommandGroup: () => 'setup',
          getSubcommand: () => 'panels'
        },
        deferReply: async ({ ephemeral }) => {
          deferred = true;
        },
        editReply: async (payload) => {
          replyPayload = payload;
        },
        reply: async (payload) => {
          replyPayload = payload;
        },
        followUp: async (payload) => {
          replyPayload = payload;
        }
      };

      // Non-admin attempt -> caught in admin.js error handler and replies with error
      let nonAdminReplied = false;
      const mockNonAdminInteraction = {
        ...mockAdminInteraction,
        member: {
          id: 'creator_1',
          roles: { cache: new Collection() },
          permissions: new PermissionsBitField(0n)
        },
        reply: async (payload) => {
          nonAdminReplied = true;
          assert.match(payload.content, /not authorized/i);
        }
      };

      await adminCommand.execute(mockNonAdminInteraction);
      assert.ok(nonAdminReplied);

      // Execute with admin
      await adminCommand.execute(mockAdminInteraction);
      assert.ok(deferred);
      assert.ok(replyPayload);
      assert.match(replyPayload.content, /Operational Panels Setup Complete/i);
      assert.match(replyPayload.content, /Skipped/i);
    } finally {
      config.admin.adminRoleIds = prevAdminRoleIds;
    }
  });
});
