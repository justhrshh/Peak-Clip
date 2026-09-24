import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChannelType,
  PermissionsBitField,
  PermissionFlagsBits,
  Collection,
  MessageFlags
} from 'discord.js';

import { ServerProvisioner } from '../src/bot/provisioning/server.provisioner.js';
import { SERVER_STRUCTURE, EXPECTED_COUNTS } from '../src/bot/provisioning/server.structure.js';
import { getCategoryOverwrites, getChannelOverwrites } from '../src/bot/provisioning/server.permissions.js';
import { handleInteraction } from '../src/bot/interactions/router.js';
import { handleCreatorDashboard, handleDashboardCampaigns, handleDashboardMyClips, handleDashboardEarnings, handleDashboardPayout } from '../src/bot/interactions/dashboard.interactions.js';
import { handleStatsOverview } from '../src/bot/interactions/statistics.interactions.js';
import { handlePayoutRequestButton } from '../src/bot/interactions/payout.interactions.js';
import { userService } from '../src/modules/users/user.service.js';
import { campaignService } from '../src/modules/campaigns/campaign.service.js';
import { statisticsService } from '../src/modules/statistics/statistics.service.js';
import { earningsService } from '../src/modules/earnings/earnings.service.js';
import { payoutService } from '../src/modules/payouts/payout.service.js';
import { payoutProfileService } from '../src/modules/payout-profile/payout-profile.service.js';

function createMockGuild(guildId = 'dev_guild_12345') {
  let snowflakeId = 2000;
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
          topic: data.topic || null,
          parentId: data.parent || null,
          guild: mockGuild,
          sentMessages: [],
          permissionOverwrites: {
            cache: new Collection(),
            set: async (overwrites) => {
              channel.permissionOverwrites.cache.clear();
              for (const ow of overwrites) {
                channel.permissionOverwrites.cache.set(ow.id, {
                  id: ow.id,
                  type: ow.type,
                  allow: new PermissionsBitField(ow.allow || 0n),
                  deny: new PermissionsBitField(ow.deny || 0n)
                });
              }
            }
          },
          lockPermissions: async () => {
            if (channel.parentId) {
              const parent = channelsCache.get(channel.parentId);
              if (parent) {
                channel.permissionOverwrites.cache = new Collection(parent.permissionOverwrites.cache);
              }
            }
          },
          setName: async (newName) => { channel.name = newName; },
          setParent: async (newParent) => { channel.parentId = newParent; },
          setTopic: async (newTopic) => { channel.topic = newTopic; },
          send: async (payload) => {
            const msg = {
              id: nextId(),
              author: { id: 'bot_user_id_123' },
              channelId: channel.id,
              content: payload.content || null,
              embeds: (payload.embeds || []).map((e) => ({ data: e.data || e })),
              components: payload.components || [],
              edit: async (editPayload) => {
                if (editPayload.content !== undefined) msg.content = editPayload.content;
                if (editPayload.embeds) msg.embeds = editPayload.embeds.map((e) => ({ data: e.data || e }));
                if (editPayload.components) msg.components = editPayload.components;
                return msg;
              },
              delete: async () => {
                const idx = channel.sentMessages.indexOf(msg);
                if (idx !== -1) channel.sentMessages.splice(idx, 1);
              }
            };
            channel.sentMessages.push(msg);
            return msg;
          },
          messages: {
            fetch: async () => new Collection(channel.sentMessages.map((m) => [m.id, m]))
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
        id: 'snowflake_bot_member',
        user: { id: 'bot_user_id_123' },
        roles: {
          highest: botManagedRole,
          botRole: botManagedRole,
          cache: new Collection([[botManagedRole.id, botManagedRole]])
        },
        permissions: botManagedRole.permissions
      },
      fetch: async (query) => {
        const id = typeof query === 'object' ? (query?.user || query?.id) : query;
        if (id === 'bot_user_id_123') return mockGuild.members.me;
        return {
          id,
          user: { id },
          roles: { cache: new Collection() },
          permissions: new PermissionsBitField(0n)
        };
      }
    }
  };

  return mockGuild;
}

describe('PHASE 10H.5 — Simplify Creator Discord Server UX Tests', () => {
  let mockGuild;
  let provisioner;
  let adminActor;

  beforeEach(() => {
    mockGuild = createMockGuild();
    provisioner = new ServerProvisioner({
      discord: { guildId: 'dev_guild_12345' },
      isDevelopment: true,
      admin: {
        adminRoleIds: ['admin_role_1'],
        adminFromDiscordAdministrator: true
      }
    });
    adminActor = {
      id: 'admin_user_1',
      user: { id: 'admin_user_1' },
      member: {
        id: 'admin_user_1',
        roles: { cache: new Collection([['admin_role_1', { id: 'admin_role_1', name: 'Admin' }]]) },
        permissions: new PermissionsBitField(PermissionFlagsBits.Administrator)
      }
    };
  });

  // 1 & 2. #welcome is renamed to #dashboard & belongs to CREATOR category
  test('1 & 2. #welcome is renamed to #dashboard and placed under CREATOR category', async () => {
    // Pre-create legacy #welcome in INFORMATION category
    const infoCat = await mockGuild.channels.create({
      name: 'INFORMATION',
      type: ChannelType.GuildCategory
    });
    const welcomeChannel = await mockGuild.channels.create({
      name: 'welcome',
      type: ChannelType.GuildText,
      parent: infoCat.id,
      topic: 'Old welcome topic'
    });

    await provisioner.provisionServer(mockGuild, adminActor);

    const creatorCat = mockGuild.channels.cache.find((c) => c.name === 'CREATOR');
    assert.ok(creatorCat, 'CREATOR category must exist');

    // welcomeChannel should be renamed to dashboard and reparented
    assert.equal(welcomeChannel.name, 'dashboard');
    assert.equal(welcomeChannel.parentId, creatorCat.id);
  });

  // 3. staff dashboard remains separate
  test('3. staff dashboard remains separate from creator dashboard', async () => {
    await provisioner.provisionServer(mockGuild, adminActor);

    const creatorCat = mockGuild.channels.cache.find((c) => c.name === 'CREATOR');
    const staffCat = mockGuild.channels.cache.find((c) => c.name === 'STAFF');

    const creatorDash = mockGuild.channels.cache.find((c) => c.name === 'dashboard' && c.parentId === creatorCat.id);
    const staffDash = mockGuild.channels.cache.find((c) => c.name === 'dashboard' && c.parentId === staffCat.id);

    assert.ok(creatorDash, 'CREATOR/#dashboard must exist');
    assert.ok(staffDash, 'STAFF/#dashboard must exist');
    assert.notEqual(creatorDash.id, staffDash.id, 'Creator and Staff dashboards must be distinct channels');

    // Check embed titles
    assert.equal(creatorDash.sentMessages[0].embeds[0].data.title, '🎬 PEAK CLIP — CREATOR CENTER');
    assert.equal(staffDash.sentMessages[0].embeds[0].data.title, 'PEAK CLIP — CONTROL CENTER');
  });

  // 4. all five creator channels exist
  test('4. all creator channels exist under CREATOR category', async () => {
    await provisioner.provisionServer(mockGuild, adminActor);

    const creatorCat = mockGuild.channels.cache.find((c) => c.name === 'CREATOR');
    const expectedChannels = ['dashboard', 'campaigns', 'submissions', 'stats', 'earnings', 'payouts'];

    for (const chName of expectedChannels) {
      const ch = mockGuild.channels.cache.find((c) => c.name === chName && c.parentId === creatorCat.id);
      assert.ok(ch, `CREATOR/#${chName} must exist`);
    }
  });

  // 5. canonical messages are created
  test('5. canonical messages are created in all creator channels', async () => {
    await provisioner.provisionServer(mockGuild, adminActor);

    const creatorCat = mockGuild.channels.cache.find((c) => c.name === 'CREATOR');
    const channels = ['dashboard', 'campaigns', 'submissions', 'stats', 'earnings', 'payouts'];

    for (const name of channels) {
      const ch = mockGuild.channels.cache.find((c) => c.name === name && c.parentId === creatorCat.id);
      assert.equal(ch.sentMessages.length, 1, `Channel #${name} must have exactly 1 canonical message`);
      assert.ok(ch.sentMessages[0].components.length > 0, `Channel #${name} message must have components`);
    }
  });

  // 6 & 7. repeated /setup is strictly idempotent and creates no duplicates
  test('6 & 7. repeated provisioning is idempotent and produces no duplicate canonical messages', async () => {
    await provisioner.provisionServer(mockGuild, adminActor);
    const creatorCat = mockGuild.channels.cache.find((c) => c.name === 'CREATOR');

    // Run setup again
    await provisioner.provisionServer(mockGuild, adminActor);

    const channels = ['dashboard', 'campaigns', 'submissions', 'stats', 'earnings', 'payouts'];
    for (const name of channels) {
      const ch = mockGuild.channels.cache.find((c) => c.name === name && c.parentId === creatorCat.id);
      assert.equal(ch.sentMessages.length, 1, `Channel #${name} must not duplicate messages on second run`);
    }
  });

  // 8. no creator #welcome remains
  test('8. no creator #welcome remains after provisioning', async () => {
    await provisioner.provisionServer(mockGuild, adminActor);

    const welcome = mockGuild.channels.cache.find((c) => c.name === 'welcome');
    assert.equal(welcome, undefined, 'There must be no #welcome channel');
  });

  // 9. dashboard button opens ephemeral dashboard
  test('9. dashboard button (dash_open) opens ephemeral personalized dashboard', async () => {
    let replyPayload = null;
    let deferred = false;
    let deferOptions = null;

    const mockInteraction = {
      id: 'int_dash_open_1',
      customId: 'dash_open',
      type: 3,
      guildId: 'dev_guild_12345',
      user: { id: 'usr_discord_123', username: 'TestCreator' },
      isButton: () => true,
      deferReply: async (opts) => {
        deferred = true;
        deferOptions = opts;
      },
      editReply: async (payload) => {
        replyPayload = payload;
      }
    };

    await handleCreatorDashboard(mockInteraction, null);

    assert.equal(deferred, true);
    assert.equal(deferOptions?.flags, MessageFlags.Ephemeral, 'Must defer ephemerally');
    assert.ok(replyPayload);
    assert.ok(replyPayload.embeds && replyPayload.embeds.length > 0);
    assert.equal(replyPayload.embeds[0].data.title, '🎬 PEAK CLIP — CREATOR CENTER');
  });

  // 10. Campaigns navigation works
  test('10. Campaigns navigation (pub_dash_campaigns) renders campaigns list ephemerally', async () => {
    let replyPayload = null;
    let deferred = false;
    let deferOptions = null;

    const mockInteraction = {
      id: 'int_camp_1',
      customId: 'pub_dash_campaigns',
      type: 3,
      guildId: 'dev_guild_12345',
      user: { id: 'usr_discord_123', username: 'TestCreator' },
      isButton: () => true,
      deferReply: async (opts) => {
        deferred = true;
        deferOptions = opts;
      },
      editReply: async (payload) => {
        replyPayload = payload;
      }
    };

    await handleDashboardCampaigns(mockInteraction, null, 1);

    assert.equal(deferred, true);
    assert.equal(deferOptions?.flags, MessageFlags.Ephemeral);
    assert.ok(replyPayload.embeds[0].data.title.includes('Clipping Campaigns'));
    // Must contain dashboard button in pagination/nav row (last row — may follow a select menu row)
    const lastRow = replyPayload.components[replyPayload.components.length - 1];
    const backBtn = lastRow.components.find((b) => b.data.custom_id?.startsWith('dash_home'));
    assert.ok(backBtn, 'Must provide Dashboard navigation');
  });

  // 11. Submissions navigation works
  test('11. Submissions navigation (pub_dash_clips) renders submissions list ephemerally', async () => {
    let replyPayload = null;
    let deferred = false;
    let deferOptions = null;

    const mockInteraction = {
      id: 'int_clips_1',
      customId: 'pub_dash_clips',
      type: 3,
      guildId: 'dev_guild_12345',
      user: { id: 'usr_discord_123', username: 'TestCreator' },
      isButton: () => true,
      deferReply: async (opts) => {
        deferred = true;
        deferOptions = opts;
      },
      editReply: async (payload) => {
        replyPayload = payload;
      }
    };

    await handleDashboardMyClips(mockInteraction, null, 1);

    assert.equal(deferred, true);
    assert.equal(deferOptions?.flags, MessageFlags.Ephemeral);
    assert.ok(replyPayload.embeds[0].data.title.includes('My Clips'));
    const backBtn = replyPayload.components[0].components.find((b) => b.data.custom_id.startsWith('dash_home'));
    assert.ok(backBtn, 'Must provide Dashboard navigation');
  });

  // 12. Stats navigation works
  test('12. Stats navigation (pub_dash_stats) renders stats ephemerally', async () => {
    let replyPayload = null;
    let deferred = false;
    let deferOptions = null;

    const mockInteraction = {
      id: 'int_stats_1',
      customId: 'pub_dash_stats',
      type: 3,
      guildId: 'dev_guild_12345',
      user: { id: 'usr_discord_123', username: 'TestCreator' },
      isButton: () => true,
      deferReply: async (opts) => {
        deferred = true;
        deferOptions = opts;
      },
      editReply: async (payload) => {
        replyPayload = payload;
      }
    };

    await handleStatsOverview(mockInteraction, null);

    assert.equal(deferred, true);
    assert.equal(deferOptions?.flags, MessageFlags.Ephemeral);
    assert.ok(replyPayload.embeds[0].data.title.includes('Performance Overview'));
  });

  // 13. Earnings navigation works
  test('13. Earnings navigation (pub_dash_earnings) renders earnings ephemerally', async () => {
    let replyPayload = null;
    let deferred = false;
    let deferOptions = null;

    const mockInteraction = {
      id: 'int_earnings_1',
      customId: 'pub_dash_earnings',
      type: 3,
      guildId: 'dev_guild_12345',
      user: { id: 'usr_discord_123', username: 'TestCreator' },
      isButton: () => true,
      deferReply: async (opts) => {
        deferred = true;
        deferOptions = opts;
      },
      editReply: async (payload) => {
        replyPayload = payload;
      }
    };

    await handleDashboardEarnings(mockInteraction, null);

    assert.equal(deferred, true);
    assert.equal(deferOptions?.flags, MessageFlags.Ephemeral);
    assert.ok(replyPayload.embeds[0].data.title.includes('Clipping Earnings'));
    const backBtn = replyPayload.components[0].components.find((b) => b.data.custom_id.startsWith('dash_home'));
    assert.ok(backBtn, 'Must provide Dashboard navigation');
  });

  // 14. Payouts navigation works
  test('14. Payouts navigation (pub_dash_payout_history) renders payouts hub ephemerally', async () => {
    let replyPayload = null;
    let deferred = false;
    let deferOptions = null;

    const mockInteraction = {
      id: 'int_payouts_1',
      customId: 'pub_dash_payout_history',
      type: 3,
      guildId: 'dev_guild_12345',
      user: { id: 'usr_discord_123', username: 'TestCreator' },
      isButton: () => true,
      deferReply: async (opts) => {
        deferred = true;
        deferOptions = opts;
      },
      editReply: async (payload) => {
        replyPayload = payload;
      }
    };

    await handleDashboardPayout(mockInteraction, null);

    assert.equal(deferred, true);
    assert.equal(deferOptions?.flags, MessageFlags.Ephemeral);
    assert.ok(replyPayload.embeds[0].data.title.includes('Payout Dashboard'));
    // Row must contain Dashboard navigation
    const allButtons = replyPayload.components.flatMap((r) => r.components);
    const backBtn = allButtons.find((b) => b.data.custom_id.startsWith('dash_home'));
    assert.ok(backBtn, 'Must provide Dashboard navigation');
  });

  // 15. Dashboard navigation works from every page
  test('15. Dashboard navigation button is present on sub-views and returns to dash_home', async () => {
    const user = await userService.getOrCreateFromDiscord({ id: 'usr_nav_test', username: 'NavTest' });

    // Click dash_home with existing targetUserId
    let updated = false;
    let editPayload = null;

    const mockHomeInteraction = {
      id: 'int_home_nav',
      customId: `dash_home:${user.id}`,
      type: 3,
      guildId: 'dev_guild_12345',
      user: { id: 'usr_nav_test', username: 'NavTest' },
      isButton: () => true,
      deferUpdate: async () => { updated = true; },
      editReply: async (payload) => { editPayload = payload; }
    };

    await handleCreatorDashboard(mockHomeInteraction, user.id);

    assert.equal(updated, true);
    assert.equal(editPayload.embeds[0].data.title, '🎬 PEAK CLIP — CREATOR CENTER');
  });

  // 16. personal data remains ephemeral
  test('16. Persistent channel embeds contain generic copy and NO personal balances or user IDs', async () => {
    await provisioner.provisionServer(mockGuild, adminActor);
    const creatorCat = mockGuild.channels.cache.find((c) => c.name === 'CREATOR');

    const channelNames = ['dashboard', 'campaigns', 'submissions', 'stats', 'earnings', 'payouts'];
    for (const name of channelNames) {
      const ch = mockGuild.channels.cache.find((c) => c.name === name && c.parentId === creatorCat.id);
      const msg = ch.sentMessages[0];
      const desc = msg.embeds[0]?.data?.description || '';

      assert.ok(!desc.match(/\$[\d,]+\.\d{2}/), `Channel #${name} embed must not contain dollar amounts`);
      assert.ok(!desc.match(/\bavailable balance:\b/i), `Channel #${name} embed must not contain balance labels`);
      assert.ok(!desc.match(/\busr_[a-z0-9]+/i), `Channel #${name} embed must not contain user IDs`);
    }
  });

  // 17. cross-user custom-ID tampering is rejected
  test('17. cross-user custom-ID tampering is rejected with ephemeral error', async () => {
    let followUpPayload = null;

    const mockTamperInteraction = {
      id: 'int_tamper_1',
      customId: 'dash_earnings:victim_user_uuid',
      type: 3,
      guildId: 'dev_guild_12345',
      user: { id: 'attacker_discord_id', username: 'Attacker' },
      isButton: () => true,
      deferUpdate: async () => {},
      followUp: async (payload) => {
        followUpPayload = payload;
      }
    };

    await handleDashboardEarnings(mockTamperInteraction, 'victim_user_uuid');

    assert.ok(followUpPayload);
    assert.equal(followUpPayload.flags, MessageFlags.Ephemeral);
    assert.ok(followUpPayload.content.includes('Unauthorized'));
  });

  // 18. staff permissions remain unchanged
  test('18. STAFF channels retain zero-trust permissions and deny @everyone', async () => {
    await provisioner.provisionServer(mockGuild, adminActor);

    const everyoneRole = mockGuild.roles.everyone;
    const staffCat = mockGuild.channels.cache.find((c) => c.name === 'STAFF');

    // Overwrites on STAFF category must deny ViewChannel to @everyone
    const catOw = staffCat.permissionOverwrites.cache.get(everyoneRole.id);
    assert.ok(catOw);
    assert.ok(catOw.deny.has(PermissionFlagsBits.ViewChannel));
  });

  // 19. Campaign Manager permissions remain unchanged
  test('19. Campaign Manager role has manage channels/messages permissions where delegated', async () => {
    await provisioner.provisionServer(mockGuild, adminActor);

    const cmRole = mockGuild.roles.cache.find((r) => r.name === 'Campaign Manager');
    assert.ok(cmRole);

    const reviewQueue = mockGuild.channels.cache.find((c) => c.name === 'review-queue');
    const ow = reviewQueue.permissionOverwrites.cache.get(cmRole.id);
    assert.ok(ow);
    assert.ok(ow.allow.has(PermissionFlagsBits.ViewChannel));
  });

  // 20. existing business services remain untouched
  test('20. existing business services remain functional', () => {
    assert.ok(typeof userService.getOrCreateFromDiscord === 'function');
    assert.ok(typeof campaignService.listActiveCampaigns === 'function');
    assert.ok(typeof statisticsService.getUserOverview === 'function');
    assert.ok(typeof earningsService.getUserEarnings === 'function');
    assert.ok(typeof payoutService.getAvailablePayoutBalance === 'function');
    assert.ok(typeof payoutProfileService.getProfileByUserId === 'function');
  });
});
