import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { config } from '../src/config/index.js';
import * as registerCommand from '../src/bot/commands/register.js';
import { userService } from '../src/modules/users/user.service.js';

describe('/register command unit tests', () => {
  let originalCreatorRoleId;
  let originalClientVerifiedRoleId;
  let originalUserRepo;

  beforeEach(() => {
    originalCreatorRoleId = config.discord.creatorRoleId;
    originalClientVerifiedRoleId = config.discord.clientVerifiedRoleId;
    originalUserRepo = userService.userRepo;

    userService.userRepo = {
      async upsertFromDiscord(discordUser) {
        return { id: 'usr_123', status: 'ACTIVE', discordId: discordUser.id, username: discordUser.username };
      },
      async findByDiscordId() {
        return null;
      },
      async create(data) {
        return { id: 'usr_123', status: 'ACTIVE', ...data };
      },
      async update() {
        return { id: 'usr_123', status: 'ACTIVE' };
      }
    };
  });

  afterEach(() => {
    config.discord.creatorRoleId = originalCreatorRoleId;
    config.discord.clientVerifiedRoleId = originalClientVerifiedRoleId;
    userService.userRepo = originalUserRepo;
  });

  function createMockInteraction({ roles = [], guildRoles = [], memberRolesAdd = null } = {}) {
    const replies = [];
    const memberRolesCache = new Collection(roles.map((id) => [id, { id }]));
    const guildRolesCache = new Collection(guildRoles.map((r) => [r.id, r]));

    return {
      replies,
      deferred: false,
      guild: {
        roles: { cache: guildRolesCache }
      },
      member: {
        roles: {
          cache: memberRolesCache,
          add: memberRolesAdd || (async () => {})
        }
      },
      user: { id: 'usr_discord_1', username: 'testuser', displayName: 'Test User' },
      async deferReply() {
        this.deferred = true;
      },
      async editReply(payload) {
        replies.push(payload);
        return payload;
      }
    };
  }

  test('blocks registration if CLIENT_VERIFIED_ROLE_ID is set and user lacks it', async () => {
    config.discord.clientVerifiedRoleId = 'role_verified_gate';
    config.discord.creatorRoleId = 'role_creator_123';

    const interaction = createMockInteraction({
      roles: ['other_role'],
      guildRoles: [{ id: 'role_creator_123', name: 'Creator' }]
    });

    await registerCommand.execute(interaction);

    assert.equal(interaction.replies.length, 1);
    assert.match(interaction.replies[0].content, /complete server verification first/i);
    assert.match(interaction.replies[0].content, /role_verified_gate/);
  });

  test('replies with clear error if DISCORD_CREATOR_ROLE_ID is unset', async () => {
    config.discord.clientVerifiedRoleId = null;
    config.discord.creatorRoleId = null;

    const interaction = createMockInteraction();
    await registerCommand.execute(interaction);

    assert.equal(interaction.replies.length, 1);
    assert.match(interaction.replies[0].content, /Creator role is not configured/i);
  });

  test('replies with clear error if DISCORD_CREATOR_ROLE_ID is not found in guild', async () => {
    config.discord.clientVerifiedRoleId = null;
    config.discord.creatorRoleId = 'role_creator_missing';

    const interaction = createMockInteraction({
      guildRoles: [{ id: 'some_other_role', name: 'Other' }]
    });

    await registerCommand.execute(interaction);

    assert.equal(interaction.replies.length, 1);
    assert.match(interaction.replies[0].content, /configured Creator role does not exist/i);
  });

  test('successfully assigns role and registers user when properly configured', async () => {
    config.discord.clientVerifiedRoleId = 'role_verified_gate';
    config.discord.creatorRoleId = 'role_creator_target';

    let assignedRoleId = null;
    const interaction = createMockInteraction({
      roles: ['role_verified_gate'], // has verified role
      guildRoles: [{ id: 'role_creator_target', name: 'Creator' }],
      memberRolesAdd: async (role) => {
        assignedRoleId = role.id;
      }
    });

    await registerCommand.execute(interaction);

    assert.equal(interaction.replies.length, 1);
    assert.ok(interaction.replies[0].embeds);
    assert.equal(assignedRoleId, 'role_creator_target');
  });
});
