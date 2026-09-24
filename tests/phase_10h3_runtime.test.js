/**
 * Phase 10H.3 — Interaction Lifecycle & Double-Response Prevention Tests
 *
 * Required Test Coverage:
 * 1. dash_open produces exactly one response.
 * 2. dash_open does not fall through router.
 * 3. dash_open after deferReply performs exactly one editReply.
 * 4. Post-response exception does not trigger second reply/followUp.
 * 5. Already-deferred interaction does not call reply().
 * 6. Already-replied interaction does not call reply() or followUp().
 * 7. dash_campaigns does not double-acknowledge.
 * 8. dash_clips does not double-acknowledge.
 * 9. dash_stats does not double-acknowledge.
 * 10. dash_earnings does not double-acknowledge.
 * 11. dash_payout does not double-acknowledge.
 * 12. dash_profile does not double-acknowledge.
 * 13. dash_refresh does not double-acknowledge.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { handleInteraction } from '../src/bot/interactions/router.js';
import { userService } from '../src/modules/users/user.service.js';

function createInstrumentedMockInteraction(options = {}) {
  const customId = options.customId ?? 'dash_open';
  const user = options.user ?? { id: '978305861430693960', username: 'harshdevil15' };
  const guildId = options.guildId ?? '1551276972703744060';

  const state = {
    deferred: options.initialDeferred ?? false,
    replied: options.initialReplied ?? false,
    calls: {
      deferReply: 0,
      deferUpdate: 0,
      reply: 0,
      editReply: 0,
      followUp: 0
    },
    flags: {
      deferReplyFlags: null
    },
    payloads: {
      reply: [],
      editReply: [],
      followUp: []
    }
  };

  const mock = {
    id: `int_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    type: 3, // MessageComponent
    customId,
    user,
    guildId,
    get deferred() { return state.deferred; },
    set deferred(v) { state.deferred = v; },
    get replied() { return state.replied; },
    set replied(v) { state.replied = v; },
    isButton: () => true,
    isChatInputCommand: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    deferReply: async (opts = {}) => {
      if (state.deferred || state.replied) {
        throw new Error('InteractionAlreadyReplied');
      }
      state.calls.deferReply++;
      state.deferred = true;
      state.flags.deferReplyFlags = opts.flags;
    },
    deferUpdate: async () => {
      if (state.deferred || state.replied) {
        throw new Error('InteractionAlreadyReplied');
      }
      state.calls.deferUpdate++;
      state.deferred = true;
    },
    reply: async (payload) => {
      if (state.deferred || state.replied) {
        throw new Error('InteractionAlreadyReplied');
      }
      state.calls.reply++;
      state.replied = true;
      state.payloads.reply.push(payload);
    },
    editReply: async (payload) => {
      if (!state.deferred && !state.replied) {
        throw new Error('InteractionNotDeferredOrReplied');
      }
      state.calls.editReply++;
      state.replied = true;
      state.payloads.editReply.push(payload);
    },
    followUp: async (payload) => {
      state.calls.followUp++;
      state.payloads.followUp.push(payload);
    },
    _state: state
  };

  return mock;
}

describe('Phase 10H.3 — Interaction Lifecycle & Double-Response Prevention', () => {

  // 1. dash_open produces exactly one response
  test('1. dash_open produces exactly one response', async () => {
    const interaction = createInstrumentedMockInteraction({
      customId: 'dash_open',
      user: { id: '978305861430693960', username: 'harshdevil15' }
    });

    await handleInteraction(interaction);

    const calls = interaction._state.calls;
    assert.equal(calls.deferReply, 1, 'Must call deferReply exactly once');
    assert.equal(calls.deferUpdate, 0, 'Must NOT call deferUpdate for dash_open');
    assert.equal(calls.reply, 0, 'Must NOT call reply for dash_open');
    assert.equal(calls.editReply, 1, 'Must call editReply exactly once');
    assert.equal(calls.followUp, 0, 'Must NOT call followUp (no secondary error message)');
  });

  // 2. dash_open does not fall through router
  test('2. dash_open does not fall through router to unexpected error handler', async () => {
    const interaction = createInstrumentedMockInteraction({
      customId: 'dash_open',
      user: { id: '978305861430693960', username: 'harshdevil15' }
    });

    await handleInteraction(interaction);

    assert.equal(interaction._state.calls.followUp, 0, 'No router fallthrough followUp should occur');
    const editPayload = interaction._state.payloads.editReply[0];
    assert.ok(editPayload, 'Must have editReply payload');
    assert.ok(editPayload.embeds?.length > 0, 'Must contain dashboard embed');
    assert.equal(editPayload.embeds[0].data.title, '🎬 PEAK CLIP — CREATOR CENTER');
  });

  // 3. dash_open after deferReply performs exactly one editReply
  test('3. dash_open after deferReply performs exactly one editReply', async () => {
    const interaction = createInstrumentedMockInteraction({
      customId: 'dash_open',
      user: { id: '978305861430693960', username: 'harshdevil15' }
    });

    await handleInteraction(interaction);

    assert.equal(interaction._state.calls.editReply, 1, 'Must call editReply exactly once');
    assert.equal(interaction._state.replied, true, 'Interaction must be in replied state');
  });

  // 4. Post-response exception does not trigger second reply/followUp
  test('4. Post-response exception does not trigger second reply/followUp', async () => {
    const dbUser = await userService.getOrCreateFromDiscord({ id: '978305861430693960', username: 'harshdevil15' });
    const interaction = createInstrumentedMockInteraction({
      customId: `dash_campaigns:${dbUser.id}:1`,
      user: { id: '978305861430693960', username: 'harshdevil15' }
    });

    // Simulate editReply succeeding and setting replied = true, then an exception occurs post-response
    const originalEditReply = interaction.editReply;
    interaction.editReply = async (payload) => {
      await originalEditReply(payload);
      throw new Error('Simulated post-response runtime exception');
    };

    await handleInteraction(interaction);

    assert.equal(interaction._state.calls.editReply, 1, 'editReply should have been called once');
    assert.equal(interaction._state.replied, true, 'Interaction is replied');
    assert.equal(interaction._state.calls.followUp, 0, 'Must NOT call followUp or send duplicate error message after replied');
    assert.equal(interaction._state.calls.reply, 0, 'Must NOT call reply after replied');
  });

  // 5. Already-deferred interaction does not call reply()
  test('5. Already-deferred interaction does not call reply()', async () => {
    const interaction = createInstrumentedMockInteraction({
      customId: 'unknown_button_custom_id',
      initialDeferred: true
    });

    await handleInteraction(interaction);

    assert.equal(interaction._state.calls.reply, 0, 'Must NOT call reply when already deferred');
    assert.equal(interaction._state.calls.editReply, 1, 'Should call editReply for error response when deferred');
  });

  // 6. Already-replied interaction does not call reply() or followUp()
  test('6. Already-replied interaction does not call reply() or followUp()', async () => {
    const interaction = createInstrumentedMockInteraction({
      customId: 'unknown_button_custom_id',
      initialDeferred: true,
      initialReplied: true
    });

    await handleInteraction(interaction);

    assert.equal(interaction._state.calls.reply, 0, 'Must NOT call reply when already replied');
    assert.equal(interaction._state.calls.followUp, 0, 'Must NOT call followUp when already replied');
  });

  // 7. dash_campaigns does not double-acknowledge
  test('7. dash_campaigns does not double-acknowledge', async () => {
    const dbUser = await userService.getOrCreateFromDiscord({ id: '978305861430693960', username: 'harshdevil15' });
    const interaction = createInstrumentedMockInteraction({
      customId: `dash_campaigns:${dbUser.id}:1`,
      user: { id: '978305861430693960', username: 'harshdevil15' }
    });

    await handleInteraction(interaction);

    const calls = interaction._state.calls;
    assert.equal(calls.deferUpdate, 1, 'Must call deferUpdate exactly once');
    assert.equal(calls.editReply, 1, 'Must call editReply exactly once');
    assert.equal(calls.followUp, 0, 'Must not produce error followUp');
  });

  // 8. dash_clips does not double-acknowledge
  test('8. dash_clips does not double-acknowledge', async () => {
    const dbUser = await userService.getOrCreateFromDiscord({ id: '978305861430693960', username: 'harshdevil15' });
    const interaction = createInstrumentedMockInteraction({
      customId: `dash_clips:${dbUser.id}:1`,
      user: { id: '978305861430693960', username: 'harshdevil15' }
    });

    await handleInteraction(interaction);

    const calls = interaction._state.calls;
    assert.equal(calls.deferUpdate, 1, 'Must call deferUpdate exactly once');
    assert.equal(calls.editReply, 1, 'Must call editReply exactly once');
    assert.equal(calls.followUp, 0, 'Must not produce error followUp');
  });

  // 9. dash_stats does not double-acknowledge
  test('9. dash_stats does not double-acknowledge', async () => {
    const dbUser = await userService.getOrCreateFromDiscord({ id: '978305861430693960', username: 'harshdevil15' });
    const interaction = createInstrumentedMockInteraction({
      customId: `dash_stats:${dbUser.id}`,
      user: { id: '978305861430693960', username: 'harshdevil15' }
    });

    await handleInteraction(interaction);

    const calls = interaction._state.calls;
    assert.equal(calls.deferUpdate, 1, 'Must call deferUpdate exactly once');
    assert.equal(calls.editReply, 1, 'Must call editReply exactly once');
    assert.equal(calls.followUp, 0, 'Must not produce error followUp');
  });

  // 10. dash_earnings does not double-acknowledge
  test('10. dash_earnings does not double-acknowledge', async () => {
    const dbUser = await userService.getOrCreateFromDiscord({ id: '978305861430693960', username: 'harshdevil15' });
    const interaction = createInstrumentedMockInteraction({
      customId: `dash_earnings:${dbUser.id}`,
      user: { id: '978305861430693960', username: 'harshdevil15' }
    });

    await handleInteraction(interaction);

    const calls = interaction._state.calls;
    assert.equal(calls.deferUpdate, 1, 'Must call deferUpdate exactly once');
    assert.equal(calls.editReply, 1, 'Must call editReply exactly once');
    assert.equal(calls.followUp, 0, 'Must not produce error followUp');
  });

  // 11. dash_payout does not double-acknowledge
  test('11. dash_payout does not double-acknowledge', async () => {
    const dbUser = await userService.getOrCreateFromDiscord({ id: '978305861430693960', username: 'harshdevil15' });
    const interaction = createInstrumentedMockInteraction({
      customId: `dash_payout:${dbUser.id}`,
      user: { id: '978305861430693960', username: 'harshdevil15' }
    });

    await handleInteraction(interaction);

    const calls = interaction._state.calls;
    assert.equal(calls.deferUpdate, 1, 'Must call deferUpdate exactly once');
    assert.equal(calls.editReply, 1, 'Must call editReply exactly once');
    assert.equal(calls.followUp, 0, 'Must not produce error followUp');
  });

  // 12. dash_profile does not double-acknowledge
  test('12. dash_profile does not double-acknowledge', async () => {
    const dbUser = await userService.getOrCreateFromDiscord({ id: '978305861430693960', username: 'harshdevil15' });
    const interaction = createInstrumentedMockInteraction({
      customId: `dash_profile:${dbUser.id}`,
      user: { id: '978305861430693960', username: 'harshdevil15' }
    });

    await handleInteraction(interaction);

    const calls = interaction._state.calls;
    assert.equal(calls.deferUpdate, 1, 'Must call deferUpdate exactly once');
    assert.equal(calls.editReply, 1, 'Must call editReply exactly once');
    assert.equal(calls.followUp, 0, 'Must not produce error followUp');
  });

  // 13. dash_refresh does not double-acknowledge
  test('13. dash_refresh does not double-acknowledge', async () => {
    const dbUser = await userService.getOrCreateFromDiscord({ id: '978305861430693960', username: 'harshdevil15' });
    const interaction = createInstrumentedMockInteraction({
      customId: `dash_refresh:${dbUser.id}`,
      user: { id: '978305861430693960', username: 'harshdevil15' }
    });

    await handleInteraction(interaction);

    const calls = interaction._state.calls;
    assert.equal(calls.deferUpdate, 1, 'Must call deferUpdate exactly once');
    assert.equal(calls.editReply, 1, 'Must call editReply exactly once');
    assert.equal(calls.followUp, 0, 'Must not produce error followUp');
  });

});
