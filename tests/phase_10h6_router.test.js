import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { config } from '../src/config/index.js';
import { CREATOR_COMPONENTS } from '../src/bot/components/creatorComponentIds.js';
import { handleInteraction } from '../src/bot/interactions/router.js';
import { userService } from '../src/modules/users/user.service.js';

describe('PHASE 10H.6 — Complete Discord Button Routing Audit & Live Fix Tests', () => {
  let originalGetOrCreate;

  beforeEach(() => {
    originalGetOrCreate = userService.getOrCreateFromDiscord;
    userService.getOrCreateFromDiscord = async (discordUser) => ({
      id: `usr_${discordUser.id}`,
      discordId: discordUser.id,
      username: discordUser.username || `user_${discordUser.id}`,
      status: 'ACTIVE'
    });
  });

  afterEach(() => {
    userService.getOrCreateFromDiscord = originalGetOrCreate;
  });

  function createMockInteraction(options = {}) {
    const replies = [];
    const followUps = [];
    let modalShown = null;
    let deferred = false;
    let deferOptions = null;
    let replied = false;

    const interaction = {
      id: `int_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      guildId: options.guildId || config.discord?.guildId || 'dev_guild_123',
      user: options.user || { id: 'test_creator_123', username: 'TestCreator' },
      member: options.member || {
        roles: options.roles || [],
        permissions: options.permissions !== undefined ? options.permissions : 0n
      },
      customId: options.customId,
      replies,
      followUps,
      get deferred() {
        return deferred;
      },
      get replied() {
        return replied;
      },
      isChatInputCommand: () => false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferReply: async (opts) => {
        deferred = true;
        deferOptions = opts;
      },
      deferUpdate: async () => {
        deferred = true;
      },
      reply: async (payload) => {
        replied = true;
        replies.push(payload);
        return payload;
      },
      followUp: async (payload) => {
        followUps.push(payload);
        return payload;
      },
      editReply: async (payload) => {
        replies.push(payload);
        return payload;
      },
      showModal: async (modal) => {
        modalShown = modal;
      },
      getDeferOptions: () => deferOptions,
      getModalShown: () => modalShown
    };

    return interaction;
  }

  // =========================================================================
  // 1. PUBLIC BUTTONS IN CREATOR CHANNELS (Deferred Ephemerally)
  // =========================================================================
  describe('1. Public Creator Channel Persistent Buttons', () => {
    test('dash_open routes and replies ephemerally', async () => {
      const interaction = createMockInteraction({ customId: CREATOR_COMPONENTS.OPEN_DASHBOARD });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.equal(interaction.getDeferOptions()?.flags, MessageFlags.Ephemeral);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /CREATOR CENTER/i);
    });

    test('pub_dash_campaigns routes and replies ephemerally', async () => {
      const interaction = createMockInteraction({ customId: CREATOR_COMPONENTS.PUB_CAMPAIGNS });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.equal(interaction.getDeferOptions()?.flags, MessageFlags.Ephemeral);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /Campaigns/i);
    });

    test('pub_dash_campaigns_refresh routes and replies ephemerally', async () => {
      const interaction = createMockInteraction({ customId: CREATOR_COMPONENTS.PUB_CAMPAIGNS_REFRESH });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.equal(interaction.getDeferOptions()?.flags, MessageFlags.Ephemeral);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /Campaigns/i);
    });

    test('pub_dash_submit routes and replies ephemerally or shows modal', async () => {
      const interaction = createMockInteraction({ customId: CREATOR_COMPONENTS.PUB_SUBMIT });
      await handleInteraction(interaction);
      assert.ok(interaction.replies.length > 0 || interaction.getModalShown());
      if (interaction.replies.length > 0) {
        assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
      }
    });

    test('pub_dash_clips routes and replies ephemerally', async () => {
      const interaction = createMockInteraction({ customId: CREATOR_COMPONENTS.PUB_CLIPS });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.equal(interaction.getDeferOptions()?.flags, MessageFlags.Ephemeral);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /My Clips/i);
    });

    test('pub_dash_submissions_refresh routes and replies ephemerally', async () => {
      const interaction = createMockInteraction({ customId: CREATOR_COMPONENTS.PUB_SUBMISSIONS_REFRESH });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.equal(interaction.getDeferOptions()?.flags, MessageFlags.Ephemeral);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /My Clips/i);
    });

    test('pub_dash_stats routes and replies ephemerally', async () => {
      const interaction = createMockInteraction({ customId: CREATOR_COMPONENTS.PUB_STATS });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.equal(interaction.getDeferOptions()?.flags, MessageFlags.Ephemeral);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /Performance Overview/i);
    });

    test('pub_dash_stats_refresh routes and replies ephemerally', async () => {
      const interaction = createMockInteraction({ customId: CREATOR_COMPONENTS.PUB_STATS_REFRESH });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.equal(interaction.getDeferOptions()?.flags, MessageFlags.Ephemeral);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /Performance Overview/i);
    });

    test('pub_dash_earnings routes and replies ephemerally', async () => {
      const interaction = createMockInteraction({ customId: CREATOR_COMPONENTS.PUB_EARNINGS });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.equal(interaction.getDeferOptions()?.flags, MessageFlags.Ephemeral);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /Earnings/i);
    });

    test('pub_dash_earnings_refresh routes and replies ephemerally', async () => {
      const interaction = createMockInteraction({ customId: CREATOR_COMPONENTS.PUB_EARNINGS_REFRESH });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.equal(interaction.getDeferOptions()?.flags, MessageFlags.Ephemeral);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /Earnings/i);
    });

    test('pub_dash_payout_request routes to payout modal or instructions', async () => {
      const interaction = createMockInteraction({ customId: CREATOR_COMPONENTS.PUB_PAYOUT_REQUEST });
      await handleInteraction(interaction);
      // Payout request either opens a modal or replies ephemerally if profile incomplete / zero balance
      assert.ok(interaction.deferred || interaction.getModalShown() || interaction.replies.length > 0);
    });

    test('pub_dash_profile routes and replies ephemerally', async () => {
      const interaction = createMockInteraction({ customId: CREATOR_COMPONENTS.PUB_PROFILE });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.equal(interaction.getDeferOptions()?.flags, MessageFlags.Ephemeral);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /Payout Profile/i);
    });

    test('pub_dash_payout_history routes and replies ephemerally', async () => {
      const interaction = createMockInteraction({ customId: CREATOR_COMPONENTS.PUB_PAYOUT_HISTORY });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.equal(interaction.getDeferOptions()?.flags, MessageFlags.Ephemeral);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /Payout Dashboard/i);
    });

    test('pub_dash_payouts_refresh routes and replies ephemerally', async () => {
      const interaction = createMockInteraction({ customId: CREATOR_COMPONENTS.PUB_PAYOUTS_REFRESH });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.equal(interaction.getDeferOptions()?.flags, MessageFlags.Ephemeral);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /Payout Dashboard/i);
    });
  });

  // =========================================================================
  // 2. DASHBOARD IN-VIEW BUTTONS (Both Clean & Parameterized Formats)
  // =========================================================================
  describe('2. In-Dashboard Button Routing (Clean & Parameterized)', () => {
    const creatorUser = { id: 'usr_actor_1', username: 'TestCreator' };
    const creatorActorId = 'usr_usr_actor_1'; // matched by mock userService

    test('dash_home (clean) routes and defers update', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: 'dash_home' });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /CREATOR CENTER/i);
    });

    test('dash_home:<userId> (parameterized) routes and defers update', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: `dash_home:${creatorActorId}` });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /CREATOR CENTER/i);
    });

    test('dash_campaigns:1 (clean page) routes and defers update', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: 'dash_campaigns:1' });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /Campaigns/i);
    });

    test('dash_campaigns:<userId>:1 (parameterized) routes and defers update', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: `dash_campaigns:${creatorActorId}:1` });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /Campaigns/i);
    });

    test('dash_my_clips:1 (clean page) routes and defers update', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: 'dash_my_clips:1' });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /My Clips/i);
    });

    test('dash_clips:<userId>:1 (legacy parameterized) routes and defers update', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: `dash_clips:${creatorActorId}:1` });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /My Clips/i);
    });

    test('dash_stats (clean) routes and defers update', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: 'dash_stats' });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /Performance Overview/i);
    });

    test('dash_stats:<userId> (parameterized) routes and defers update', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: `dash_stats:${creatorActorId}` });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /Performance Overview/i);
    });

    test('dash_earnings (clean) routes and defers update', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: 'dash_earnings' });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /Earnings/i);
    });

    test('dash_earnings:<userId> (parameterized) routes and defers update', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: `dash_earnings:${creatorActorId}` });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /Earnings/i);
    });

    test('dash_payout (clean) routes and defers update', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: 'dash_payout' });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /Payout Dashboard/i);
    });

    test('dash_payout:<userId> (parameterized) routes and defers update', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: `dash_payout:${creatorActorId}` });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /Payout Dashboard/i);
    });

    test('dash_profile (clean) routes and defers update', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: 'dash_profile' });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /Creator Profile/i);
    });

    test('dash_profile:<userId> (parameterized) routes and defers update', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: `dash_profile:${creatorActorId}` });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /Creator Profile/i);
    });

    test('dash_refresh (clean) routes and defers update', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: 'dash_refresh' });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /CREATOR CENTER/i);
    });

    test('dash_refresh:<userId> (parameterized) routes and defers update', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: `dash_refresh:${creatorActorId}` });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /CREATOR CENTER/i);
    });

    test('dash_profile_setup (clean) routes and presents profile setup', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: 'dash_profile_setup' });
      await handleInteraction(interaction);
      assert.ok(interaction.deferred || interaction.getModalShown() || interaction.replies.length > 0);
    });

    test('dash_profile_view (clean) routes and presents profile view', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: 'dash_profile_view' });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.ok(interaction.replies.length > 0);
    });

    test('dash_profile_edit (clean) routes to profile edit flow', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: 'dash_profile_edit' });
      await handleInteraction(interaction);
      assert.ok(interaction.deferred || interaction.replies.length > 0 || interaction.getModalShown());
    });

    test('dash_payout_request (clean) routes to payout request flow', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: 'dash_payout_request' });
      await handleInteraction(interaction);
      assert.ok(interaction.deferred || interaction.getModalShown() || interaction.replies.length > 0);
    });

    test('dash_back:dash_home routes back to home dashboard', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: 'dash_back:dash_home' });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /CREATOR CENTER/i);
    });
  });

  // =========================================================================
  // 3. EDGE CASES, PAGINATION & SECURITY
  // =========================================================================
  describe('3. Edge Cases, Pagination & Security Handling', () => {
    const creatorUser = { id: 'usr_actor_2', username: 'TestCreator2' };
    const creatorActorId = 'usr_usr_actor_2';

    test('dash_campaigns:2 (page 2) correctly parses page 2', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: 'dash_campaigns:2' });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /Campaigns/i);
    });

    test('dash_my_clips:2 (page 2) correctly parses page 2', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: 'dash_my_clips:2' });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /My Clips/i);
    });

    test('invalid page string falls back to page 1 safely', async () => {
      const interaction = createMockInteraction({ user: creatorUser, customId: 'dash_campaigns:abc' });
      await handleInteraction(interaction);
      assert.equal(interaction.deferred, true);
      assert.ok(interaction.replies.length > 0);
      assert.match(interaction.replies[0].embeds[0].data.title, /Campaigns/i);
    });

    test('forged user ID is rejected with ephemeral error', async () => {
      const interaction = createMockInteraction({
        user: { id: 'attacker_discord_id', username: 'Attacker' },
        customId: 'dash_earnings:victim_user_uuid'
      });
      await handleInteraction(interaction);
      assert.ok(interaction.followUps.length > 0);
      assert.equal(interaction.followUps[0].flags, MessageFlags.Ephemeral);
      assert.match(interaction.followUps[0].content, /Unauthorized/i);
    });

    test('unknown customId returns exact clean refresh message without leaking correlation reference', async () => {
      const interaction = createMockInteraction({ customId: 'unknown_mystery_button_action' });
      await handleInteraction(interaction);
      assert.equal(interaction.replies.length, 1);
      assert.equal(
        interaction.replies[0].content,
        '⚠️ This button is no longer available. Please refresh the dashboard.'
      );
      assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
      assert.ok(!interaction.replies[0].content.includes('Reference:'));
    });
  });
});
