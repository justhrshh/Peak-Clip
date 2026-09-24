import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { config } from '../src/config/index.js';
import {
  AdminRole,
  AdminPermission,
  assertAdminPermission
} from '../src/modules/admin/admin.auth.js';
import {
  UnauthorizedAdminActionError,
  InsufficientPermissionError
} from '../src/modules/admin/admin.errors.js';
import { handleAdminButtonInteraction } from '../src/bot/interactions/admin.interactions.js';
import {
  handleStatsOverview,
  handleStatsCampaignsList,
  handleStatsClipsList
} from '../src/bot/interactions/statistics.interactions.js';
import {
  handleEarningsOverview,
  handleEarningsCampaignsList
} from '../src/bot/interactions/earnings.interactions.js';
import {
  handlePayoutRequestButton,
  handlePayoutModalSubmit
} from '../src/bot/interactions/payout.interactions.js';
import { handleInteraction } from '../src/bot/interactions/router.js';
import { userService } from '../src/modules/users/user.service.js';
import { UserSuspendedError, UserBannedError } from '../src/modules/users/user.errors.js';

describe('Discord UX Security, Authorization & Isolation', () => {
  const ADMIN_ROLE_ID = 'dev_admin_role_snowflake';
  const CM_ROLE_ID = 'dev_cm_role_snowflake';

  let originalAdminRoleIds;
  let originalCmRoleIds;
  let originalGetOrCreate;

  beforeEach(() => {
    originalAdminRoleIds = config.admin.adminRoleIds;
    originalCmRoleIds = config.admin.campaignManagerRoleIds;
    config.admin.adminRoleIds = [ADMIN_ROLE_ID];
    config.admin.campaignManagerRoleIds = [CM_ROLE_ID];

    originalGetOrCreate = userService.getOrCreateFromDiscord;
    userService.getOrCreateFromDiscord = async (discordUser) => ({
      id: `usr_${discordUser.id}`,
      discordId: discordUser.id,
      username: discordUser.username || `user_${discordUser.id}`,
      status: 'ACTIVE'
    });
  });

  afterEach(() => {
    config.admin.adminRoleIds = originalAdminRoleIds;
    config.admin.campaignManagerRoleIds = originalCmRoleIds;
    userService.getOrCreateFromDiscord = originalGetOrCreate;
  });

  function createMockInteraction(options = {}) {
    const replies = [];
    const followUps = [];
    let modalShown = null;
    let deferred = false;
    let replied = false;

    return {
      id: `int_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      guildId: options.guildId || config.discord?.guildId || 'dev_guild_123',
      user: options.user || { id: 'discord_user_1', username: 'testcreator' },
      member: options.member || {
        roles: options.roles || [],
        permissions: options.permissions !== undefined ? options.permissions : 0n
      },
      customId: options.customId,
      commandName: options.commandName,
      replies,
      followUps,
      get deferred() {
        return deferred;
      },
      get replied() {
        return replied;
      },
      isChatInputCommand: () => !!options.commandName,
      isButton: () => options.isButton !== undefined ? options.isButton : !!options.customId && !options.isMenu && !options.isModal,
      isStringSelectMenu: () => !!options.isMenu,
      isModalSubmit: () => !!options.isModal,
      async reply(payload) {
        replied = true;
        replies.push(payload);
        return payload;
      },
      async followUp(payload) {
        followUps.push(payload);
        return payload;
      },
      async deferReply() {
        deferred = true;
      },
      async deferUpdate() {
        deferred = true;
      },
      async editReply(payload) {
        replies.push(payload);
        return payload;
      },
      async showModal(modal) {
        modalShown = modal;
      },
      fields: options.fields || {
        getTextInputValue: (fieldId) => options.fieldValues?.[fieldId] || '100.00'
      },
      getModalShown: () => modalShown
    };
  }

  // =========================================================================
  // 1. Creator attempting /admin action -> UnauthorizedAdminActionError
  // =========================================================================
  test('1. Creator attempting admin action is strictly rejected with UnauthorizedAdminActionError', async () => {
    const creatorInteraction = createMockInteraction({
      roles: ['creator_role_id'],
      permissions: 0n
    });

    assert.throws(
      () => assertAdminPermission(creatorInteraction, AdminPermission.CAMPAIGN_EDIT),
      (err) => {
        assert.ok(err instanceof UnauthorizedAdminActionError);
        assert.match(err.message, /Staff role required/);
        return true;
      }
    );
  });

  // =========================================================================
  // 2. Campaign Manager attempting payout approval -> InsufficientPermissionError
  // =========================================================================
  test('2. Campaign Manager attempting payout approval is rejected with InsufficientPermissionError', async () => {
    const cmInteraction = createMockInteraction({
      roles: [CM_ROLE_ID],
      permissions: 0n,
      customId: 'admin_payout_approve:payout_uuid_123'
    });

    assert.throws(
      () => assertAdminPermission(cmInteraction, AdminPermission.PAYOUT_APPROVE),
      (err) => {
        assert.ok(err instanceof InsufficientPermissionError);
        assert.equal(err.requiredPermission, AdminPermission.PAYOUT_APPROVE);
        assert.ok(err.userRoles.includes(AdminRole.CAMPAIGN_MANAGER));
        return true;
      }
    );
  });

  // =========================================================================
  // 3. Creator attempting payout administration quick button -> Denied
  // =========================================================================
  test('3. Creator attempting payout administration button is denied server-side', async () => {
    const creatorInteraction = createMockInteraction({
      roles: ['unprivileged_creator_role'],
      permissions: 0n,
      customId: 'admin_payout_approve:payout_uuid_123'
    });

    await handleAdminButtonInteraction(creatorInteraction);

    assert.equal(creatorInteraction.replies.length, 1);
    assert.match(creatorInteraction.replies[0].content, /Staff role required/i);
    // Accept either legacy ephemeral:true or modern flags:MessageFlags.Ephemeral (64)
    const reply = creatorInteraction.replies[0];
    const isEphemeral = reply.ephemeral === true || (reply.flags & 64) !== 0;
    assert.ok(isEphemeral, 'Reply must be ephemeral');
  });


  // =========================================================================
  // 4. User A attempting to inspect User B statistics -> Denied
  // =========================================================================
  test('4. User A attempting to view User B statistics or campaigns is rejected', async () => {
    const userA = { id: 'discord_user_a', username: 'usera' };
    const interaction = createMockInteraction({ user: userA });

    // Try viewing User B's overview
    await handleStatsOverview(interaction, 'user_b_internal_id');
    assert.equal(interaction.followUps.length, 1);
    assert.match(interaction.followUps[0].content, /You can only navigate your own statistics/);

    // Try viewing User B's campaigns
    const interaction2 = createMockInteraction({ user: userA });
    await handleStatsCampaignsList(interaction2, 'user_b_internal_id');
    assert.equal(interaction2.followUps.length, 1);
    assert.match(interaction2.followUps[0].content, /You can only view your own campaigns/);

    // Try viewing User B's earnings
    const interaction3 = createMockInteraction({ user: userA });
    await handleEarningsOverview(interaction3, 'user_b_internal_id');
    assert.equal(interaction3.followUps.length, 1);
    assert.match(interaction3.followUps[0].content, /You can only view your own earnings/);
  });

  // =========================================================================
  // 5. User A attempting to request payout for User B -> Denied
  // =========================================================================
  test('5. User A attempting to access or submit payout for User B is rejected', async () => {
    const userA = { id: 'discord_user_a', username: 'usera' };

    // Request button click
    const btnInteraction = createMockInteraction({ user: userA });
    await handlePayoutRequestButton(btnInteraction, 'user_b_internal_id');
    assert.equal(btnInteraction.replies.length, 1);
    assert.match(btnInteraction.replies[0].content, /You can only request payouts for your own account/);
    assert.equal(btnInteraction.getModalShown(), null);

    // Modal submit
    const modalInteraction = createMockInteraction({ user: userA, isModal: true });
    await handlePayoutModalSubmit(modalInteraction, 'user_b_internal_id');
    assert.equal(modalInteraction.replies.length, 1);
    assert.match(modalInteraction.replies[0].content, /You can only request payouts for your own account/);
  });

  // =========================================================================
  // 6. Suspended user attempting creator action -> UserSuspendedError
  // =========================================================================
  test('6. Suspended user is rejected from participation by domain guard', () => {
    const suspendedUser = {
      id: 'usr_suspended_1',
      status: 'SUSPENDED',
      username: 'badactor'
    };

    assert.throws(
      () => userService.assertUserCanParticipate(suspendedUser),
      (err) => {
        assert.ok(err instanceof UserSuspendedError);
        assert.match(err.message, /suspended/i);
        return true;
      }
    );
  });

  // =========================================================================
  // 7. Banned user attempting creator action -> UserBannedError
  // =========================================================================
  test('7. Banned user is rejected from participation by domain guard', () => {
    const bannedUser = {
      id: 'usr_banned_1',
      status: 'BANNED',
      username: 'bannedactor'
    };

    assert.throws(
      () => userService.assertUserCanParticipate(bannedUser),
      (err) => {
        assert.ok(err instanceof UserBannedError);
        assert.match(err.message, /banned/i);
        return true;
      }
    );
  });

  // =========================================================================
  // 8. Cross-guild interaction tampering -> Rejected by Router
  // =========================================================================
  test('8. Cross-guild interaction is rejected by router guild guard', async () => {
    const foreignInteraction = createMockInteraction({
      guildId: 'foreign_unauthorized_guild_999',
      commandName: 'ping'
    });

    await handleInteraction(foreignInteraction);

    assert.equal(foreignInteraction.replies.length, 1);
    assert.match(foreignInteraction.replies[0].content, /configured for a specific server/i);
    assert.match(foreignInteraction.replies[0].content, /Reference: int_/);
  });

  // =========================================================================
  // 9. Tampered/unrecognized custom ID -> Handled by fallback guard
  // =========================================================================
  test('9. Tampered or unrecognized button and select menu IDs are safely rejected', async () => {
    // Unrecognized button
    const tamperedBtn = createMockInteraction({
      customId: 'tampered:exploit:action',
      isButton: true
    });
    await handleInteraction(tamperedBtn);
    assert.equal(tamperedBtn.replies.length, 1);
    assert.match(tamperedBtn.replies[0].content, /This button is no longer available\. Please refresh the dashboard/);

    // Unrecognized select menu
    const tamperedMenu = createMockInteraction({
      customId: 'tampered:select:menu',
      isMenu: true
    });
    await handleInteraction(tamperedMenu);
    assert.equal(tamperedMenu.replies.length, 1);
    assert.match(tamperedMenu.replies[0].content, /This menu action is unrecognized, invalid, or expired/);

    // Unrecognized modal
    const tamperedModal = createMockInteraction({
      customId: 'tampered:modal:submit',
      isModal: true
    });
    await handleInteraction(tamperedModal);
    assert.equal(tamperedModal.replies.length, 1);
    assert.match(tamperedModal.replies[0].content, /This modal submission is unrecognized, invalid, or expired/);
  });

  // =========================================================================
  // 10. Malformed entity ID in interaction -> Handled cleanly without leak
  // =========================================================================
  test('10. Malformed or empty entity ID in admin interaction is handled cleanly without leaking internals', async () => {
    const malformedInteraction = createMockInteraction({
      roles: [ADMIN_ROLE_ID],
      customId: 'admin_payout_approve:' // Missing payout ID
    });

    await handleAdminButtonInteraction(malformedInteraction);

    assert.equal(malformedInteraction.replies.length, 1);
    assert.match(malformedInteraction.replies[0].content, /unexpected error occurred/i);
    // Ensure no stack trace or internal SQL was leaked
    assert.doesNotMatch(malformedInteraction.replies[0].content, /at /);
    assert.doesNotMatch(malformedInteraction.replies[0].content, /SELECT/i);
    assert.doesNotMatch(malformedInteraction.replies[0].content, /Prisma/i);
  });
});
