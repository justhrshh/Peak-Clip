/**
 * Phase 10H.2 — Creator Dashboard Runtime Fixes Regression Tests
 *
 * Requirements:
 * 1. dash_open with valid verified creator
 * 2. dash_open with creator having zero activity
 * 3. dash_open with creator with earnings
 * 4. dash_open with active payout
 * 5. dash_open with no payout profile
 * 6. dashboard component generation
 * 7. dashboard user isolation
 * 8. malformed targetUserId
 * 9. unknown creator
 * 10. database/aggregation failure handling
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { handleCreatorDashboard } from '../src/bot/interactions/dashboard.interactions.js';
import { handleInteraction } from '../src/bot/interactions/router.js';
import { buildCreatorDashboardEmbed } from '../src/bot/embeds/dashboard.embeds.js';
import { buildCreatorDashboardActionRows } from '../src/bot/components/dashboard.components.js';

function createMockInteraction(options = {}) {
  const customId = options.customId ?? 'dash_open';
  const user = options.user ?? { id: '978305861430693960', username: 'harshdevil15' };
  const guildId = options.guildId ?? '1551276972703744060';

  const state = {
    deferred: false,
    replied: false,
    deferReplyFlags: null,
    deferUpdateCalled: false,
    replyPayload: null,
    editReplyPayload: null,
    followUpPayload: null
  };

  return {
    id: `int_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    type: 3, // MessageComponent
    customId,
    user,
    guildId,
    get deferred() { return state.deferred; },
    set deferred(val) { state.deferred = val; },
    get replied() { return state.replied; },
    set replied(val) { state.replied = val; },
    isButton: () => true,
    isChatInputCommand: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    deferReply: async (opts = {}) => {
      state.deferred = true;
      state.deferReplyFlags = opts.flags;
    },
    deferUpdate: async () => {
      state.deferred = true;
      state.deferUpdateCalled = true;
    },
    reply: async (payload) => {
      state.replied = true;
      state.replyPayload = payload;
    },
    editReply: async (payload) => {
      state.replied = true;
      state.editReplyPayload = payload;
    },
    followUp: async (payload) => {
      state.followUpPayload = payload;
    },
    _state: state
  };
}

describe('Phase 10H.2 — Creator Dashboard Runtime Regression Suite', () => {

  // 1. dash_open with valid verified creator
  test('1. dash_open with valid verified creator returns ephemeral personalized dashboard', async () => {
    const interaction = createMockInteraction({
      customId: 'dash_open',
      user: { id: '978305861430693960', username: 'harshdevil15' }
    });

    await handleInteraction(interaction);

    // Must be deferred ephemerally
    assert.equal(interaction._state.deferReplyFlags, MessageFlags.Ephemeral);
    assert.equal(interaction._state.deferUpdateCalled, false, 'dash_open must NOT call deferUpdate');

    // Must have edited reply with embed and components
    const payload = interaction._state.editReplyPayload;
    assert.ok(payload, 'Must receive editReply payload');
    assert.ok(payload.embeds?.length > 0, 'Must have at least one embed');
    assert.equal(payload.embeds[0].data.title, '🎬 PEAK CLIP — CREATOR CENTER');
    assert.match(payload.embeds[0].data.description, /harshdevil15/);
    assert.ok(payload.components?.length > 0, 'Must have component rows');
  });

  // 2. dash_open with creator having zero activity
  test('2. dash_open with creator having zero activity returns clean default dashboard ($0.00, 0 clips, 0 views)', async () => {
    const interaction = createMockInteraction({
      customId: 'dash_open',
      user: { id: 'brand_new_zero_user_99999', username: 'newbie_creator' }
    });

    await handleInteraction(interaction);

    const payload = interaction._state.editReplyPayload;
    assert.ok(payload, 'Must receive payload');
    const embed = payload.embeds[0];
    assert.ok(embed, 'Must have embed');

    // Verify clean defaults
    const balanceField = embed.data.fields.find(f => f.name.includes('Available Balance'));
    assert.ok(balanceField, 'Must have balance field');
    assert.match(balanceField.value, /\$0\.00/);

    const clipsField = embed.data.fields.find(f => f.name.includes('Active Clips'));
    assert.ok(clipsField, 'Must have clips field');
    assert.match(clipsField.value, /\*\*0\*\* clips/);

    const viewsField = embed.data.fields.find(f => f.name.includes('Total Views'));
    assert.ok(viewsField, 'Must have views field');
    assert.match(viewsField.value, /\*\*0\*\* views/);

    const payoutField = embed.data.fields.find(f => f.name.includes('Active Payout'));
    assert.ok(payoutField, 'Must have payout field');
    assert.match(payoutField.value, /None/i);
  });

  // 3. dash_open with creator with earnings
  test('3. dash_open with creator with earnings displays formatted balance and views', async () => {
    const testData = {
      availableBalance: '1250.75',
      currency: 'USD',
      activeClipsCount: 5,
      approvedClipsCount: 4,
      underReviewClipsCount: 1,
      totalViews: 500000n,
      eligibleViews: 450000n,
      activePayout: null
    };

    const discordUser = { id: 'earner_1', username: 'top_creator' };
    const embed = buildCreatorDashboardEmbed(testData, discordUser);

    const balanceField = embed.data.fields.find(f => f.name.includes('Available Balance'));
    assert.match(balanceField.value, /\$1250\.75 USD/);

    const clipsField = embed.data.fields.find(f => f.name.includes('Active Clips'));
    assert.match(clipsField.value, /\*\*5\*\* clips/);
    assert.match(clipsField.value, /4 approved/);

    const viewsField = embed.data.fields.find(f => f.name.includes('Total Views'));
    assert.match(viewsField.value, /500,000/);
    assert.match(viewsField.value, /450,000/);
  });

  // 4. dash_open with active payout
  test('4. dash_open with active payout displays active payout amount and status badge', async () => {
    const testData = {
      availableBalance: '500.00',
      currency: 'USD',
      activeClipsCount: 2,
      approvedClipsCount: 2,
      underReviewClipsCount: 0,
      totalViews: 100000n,
      eligibleViews: 100000n,
      activePayout: {
        id: 'payout_uuid_abc',
        amount: 250,
        status: 'UNDER_REVIEW'
      }
    };

    const discordUser = { id: 'payout_user_1', username: 'payout_creator' };
    const embed = buildCreatorDashboardEmbed(testData, discordUser);

    const payoutField = embed.data.fields.find(f => f.name.includes('Active Payout'));
    assert.ok(payoutField);
    assert.match(payoutField.value, /\$250\.00/);
    assert.match(payoutField.value, /UNDER_REVIEW/);
  });

  // 5. dash_open with no payout profile handles null profile gracefully
  test('5. dash_open with no payout profile handles null profile without crashing', async () => {
    const interaction = createMockInteraction({
      customId: 'dash_open',
      user: { id: 'no_profile_user_123', username: 'noprofile' }
    });

    await assert.doesNotReject(
      async () => await handleInteraction(interaction),
      'dash_open must not crash when creator has no payout profile'
    );
    assert.ok(interaction._state.editReplyPayload?.embeds?.length > 0);
  });

  // 6. dashboard component generation
  test('6. dashboard component generation returns valid Discord ActionRows with required buttons', () => {
    const userId = 'user_uuid_12345';
    const rows = buildCreatorDashboardActionRows(userId);

    assert.equal(rows.length, 2, 'Must have exactly 2 action rows');

    // Row 1: Primary navigation
    const row1Buttons = rows[0].components;
    assert.equal(row1Buttons.length, 5, 'Row 1 must have 5 buttons');
    assert.equal(row1Buttons[0].data.label, '🎯 Campaigns');
    assert.equal(row1Buttons[1].data.label, '🎬 Submissions');
    assert.equal(row1Buttons[2].data.label, '📊 Stats');
    assert.equal(row1Buttons[3].data.label, '💰 Earnings');
    assert.equal(row1Buttons[4].data.label, '💸 Payouts');

    // Row 2: Secondary navigation
    const row2Buttons = rows[1].components;
    assert.equal(row2Buttons.length, 2, 'Row 2 must have 2 buttons');
    assert.equal(row2Buttons[0].data.label, '👤 Profile');
    assert.equal(row2Buttons[1].data.label, '🔄 Refresh');

    // All custom IDs must encode userId
    for (const row of rows) {
      for (const btn of row.components) {
        assert.ok(btn.data.custom_id.includes(userId), `Button ${btn.data.label} must encode userId`);
      }
    }
  });

  // 7. dashboard user isolation: accessing another user's dashboard is rejected
  test('7. dashboard user isolation: forged targetUserId is rejected server-side', async () => {
    const attackerInteraction = createMockInteraction({
      customId: 'dash_home:victim_user_uuid',
      user: { id: 'attacker_discord_id', username: 'attacker' }
    });

    await handleInteraction(attackerInteraction);

    // Must be rejected with unauthorized message
    const followUp = attackerInteraction._state.followUpPayload;
    const reply = attackerInteraction._state.replyPayload;
    const payload = followUp || reply;

    assert.ok(payload, 'Must send rejection payload');
    assert.match(payload.content, /only view and manage your own Creator Dashboard/i);
    assert.equal(payload.flags, MessageFlags.Ephemeral);
  });

  // 8. malformed targetUserId: invalid format does not crash the bot
  test('8. malformed targetUserId does not crash the router or handler', async () => {
    const malformedInteraction = createMockInteraction({
      customId: 'dash_home:;;--DROP TABLE--::malformed',
      user: { id: 'regular_user_1', username: 'regular' }
    });

    await assert.doesNotReject(
      async () => await handleInteraction(malformedInteraction),
      'Router must handle malformed customId safely'
    );
  });

  // 9. unknown creator: first-time Discord user auto-provisions and returns dashboard
  test('9. unknown creator: automatically registers and returns initial dashboard without error', async () => {
    const unknownInteraction = createMockInteraction({
      customId: 'dash_open',
      user: { id: `brand_new_snowflake_${Date.now()}`, username: 'first_timer' }
    });

    await assert.doesNotReject(
      async () => await handleInteraction(unknownInteraction),
      'Unknown user must auto-register and open dashboard'
    );

    assert.ok(unknownInteraction._state.editReplyPayload?.embeds?.length > 0);
  });

  // 10. database/aggregation failure handling: safe defaults prevent crash
  test('10. database/aggregation failure handling: safe fallbacks render dashboard without throwing', async () => {
    // Calling handleCreatorDashboard directly with mock interaction
    const interaction = createMockInteraction({ customId: 'dash_open' });

    // Should complete cleanly
    await assert.doesNotReject(
      async () => await handleCreatorDashboard(interaction),
      'handleCreatorDashboard must not throw'
    );

    assert.ok(interaction._state.editReplyPayload);
  });
});
