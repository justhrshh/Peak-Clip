/**
 * Phase 10H.4 — DEV Dashboard Message Cleanup Regression Tests
 *
 * Requirements:
 * 1. Target ONLY known error messages matching '❌ An unexpected error occurred while processing your request'
 * 2. Never delete canonical Creator Center welcome message
 * 3. Never delete normal announcements or legitimate operational messages
 * 4. Never delete messages from non-bot authors
 * 5. Reconcile /setup in DEV leaving 1 canonical welcome message and 0 stale error messages
 * 6. Idempotent: repeated runs do not duplicate or delete canonical message
 * 7. Safety: skipped when not in development environment
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ServerProvisioner } from '../src/bot/provisioning/server.provisioner.js';

function createMockWelcomeChannel(options = {}) {
  const messages = options.initialMessages ? [...options.initialMessages] : [];
  const deletedMessageIds = [];

  const channel = {
    id: 'chan_welcome_123',
    name: 'welcome',
    guild: { id: 'guild_dev_1551276972703744060' },
    messages: {
      fetch: async () => {
        // Return a Map-like collection matching discord.js Collection
        const map = new Map();
        for (const m of messages) {
          map.set(m.id, m);
        }
        return map;
      }
    },
    send: async (payload) => {
      const newMsg = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        author: { id: options.botUserId || 'bot_user_999' },
        content: payload.content || '',
        embeds: payload.embeds || [],
        components: payload.components || [],
        edit: async (editPayload) => {
          newMsg.embeds = editPayload.embeds || newMsg.embeds;
          newMsg.components = editPayload.components || newMsg.components;
          return newMsg;
        },
        delete: async () => {
          deletedMessageIds.push(newMsg.id);
          const idx = messages.findIndex((m) => m.id === newMsg.id);
          if (idx !== -1) messages.splice(idx, 1);
        }
      };
      messages.push(newMsg);
      return newMsg;
    },
    _getMessages: () => messages,
    _getDeletedIds: () => deletedMessageIds
  };

  return channel;
}

function createMockBotMember(botUserId = 'bot_user_999') {
  return {
    id: botUserId,
    user: { id: botUserId, username: 'PeakClipBot' },
    permissions: 8n, // Administrator
    roles: { highest: { id: 'role_bot', name: 'Peak Clip Bot', position: 10 } }
  };
}

describe('Phase 10H.4 — DEV Dashboard Message Cleanup', () => {

  test('1. Removes stale generic interaction-error messages authored by bot in DEV', async () => {
    const botUserId = 'bot_user_999';
    const canonicalMsg = {
      id: 'msg_canonical_welcome',
      author: { id: botUserId },
      content: '',
      embeds: [{ title: '🎬 PEAK CLIP — CREATOR CENTER', data: { title: '🎬 PEAK CLIP — CREATOR CENTER' } }],
      components: [{ components: [{ customId: 'dash_open' }] }],
      edit: async function(payload) {
        this.embeds = payload.embeds;
        this.components = payload.components;
      },
      delete: async function() {
        assert.fail('Canonical message must NOT be deleted');
      }
    };

    const staleErrorMsg1 = {
      id: 'msg_stale_err_1',
      author: { id: botUserId },
      content: '❌ An unexpected error occurred while processing your request. Please try again later. (Reference: int_1790015379681_f9ed61)',
      embeds: [],
      components: [],
      delete: async function() {
        this._deleted = true;
      }
    };

    const staleErrorMsg2 = {
      id: 'msg_stale_err_2',
      author: { id: botUserId },
      content: '❌ An unexpected error occurred while processing your request.',
      embeds: [],
      components: [],
      delete: async function() {
        this._deleted = true;
      }
    };

    const channel = createMockWelcomeChannel({
      botUserId,
      initialMessages: [canonicalMsg, staleErrorMsg1, staleErrorMsg2]
    });
    const botMember = createMockBotMember(botUserId);

    const devProvisioner = new ServerProvisioner({
      env: 'development',
      isDevelopment: true,
      isProduction: false
    });

    await devProvisioner._initializeWelcomeChannel(channel, botMember, 'test_corr_1');

    assert.equal(staleErrorMsg1._deleted, true, 'staleErrorMsg1 must be deleted');
    assert.equal(staleErrorMsg2._deleted, true, 'staleErrorMsg2 must be deleted');
  });

  test('2. Preserves legitimate messages, announcements, and other authors', async () => {
    const botUserId = 'bot_user_999';
    const canonicalMsg = {
      id: 'msg_canonical_welcome',
      author: { id: botUserId },
      content: '',
      embeds: [{ title: '🎬 PEAK CLIP — CREATOR CENTER' }],
      components: [{ components: [{ customId: 'dash_open' }] }],
      edit: async () => {},
      delete: async () => { assert.fail('Canonical message must NOT be deleted'); }
    };

    const normalAnnouncement = {
      id: 'msg_announcement',
      author: { id: botUserId },
      content: '📢 Welcome new creators! Please read the rules in #rules before clipping.',
      embeds: [],
      components: [],
      delete: async () => { assert.fail('Normal announcement must NOT be deleted'); }
    };

    const userMessage = {
      id: 'msg_user_chat',
      author: { id: 'regular_user_123' },
      content: '❌ An unexpected error occurred while processing your request.', // User typed text
      embeds: [],
      components: [],
      delete: async () => { assert.fail('User message must NOT be deleted'); }
    };

    const channel = createMockWelcomeChannel({
      botUserId,
      initialMessages: [canonicalMsg, normalAnnouncement, userMessage]
    });
    const botMember = createMockBotMember(botUserId);

    const devProvisioner = new ServerProvisioner({
      env: 'development',
      isDevelopment: true,
      isProduction: false
    });

    await devProvisioner._initializeWelcomeChannel(channel, botMember, 'test_corr_2');

    const remaining = channel._getMessages();
    assert.ok(remaining.find(m => m.id === canonicalMsg.id), 'Canonical message preserved');
    assert.ok(remaining.find(m => m.id === normalAnnouncement.id), 'Announcement preserved');
    assert.ok(remaining.find(m => m.id === userMessage.id), 'User message preserved');
  });

  test('3. Safety: Cleanup is completely bypassed in production environment', async () => {
    const botUserId = 'bot_user_999';
    const staleErrorMsg = {
      id: 'msg_stale_err_prod',
      author: { id: botUserId },
      content: '❌ An unexpected error occurred while processing your request. (Reference: int_123)',
      embeds: [],
      components: [],
      delete: async () => {
        assert.fail('Error deletion must NOT execute in production');
      }
    };

    const canonicalMsg = {
      id: 'msg_canonical_prod',
      author: { id: botUserId },
      content: '',
      embeds: [{ title: '🎬 PEAK CLIP — CREATOR CENTER' }],
      components: [{ components: [{ customId: 'dash_open' }] }],
      edit: async () => {}
    };

    const channel = createMockWelcomeChannel({
      botUserId,
      initialMessages: [canonicalMsg, staleErrorMsg]
    });
    const botMember = createMockBotMember(botUserId);

    const prodProvisioner = new ServerProvisioner({
      env: 'production',
      isDevelopment: false,
      isProduction: true
    });

    await prodProvisioner._initializeWelcomeChannel(channel, botMember, 'test_corr_prod');

    // Neither message deleted
    assert.equal(channel._getDeletedIds().length, 0, 'No deletions in production');
  });

  test('4. Idempotency: Repeated runs leave exactly 1 canonical welcome message and 0 stale errors', async () => {
    const botUserId = 'bot_user_999';
    const channel = createMockWelcomeChannel({ botUserId });
    const botMember = createMockBotMember(botUserId);

    const devProvisioner = new ServerProvisioner({
      env: 'development',
      isDevelopment: true,
      isProduction: false
    });

    // Run 1: First-time provisioning
    await devProvisioner._initializeWelcomeChannel(channel, botMember, 'run_1');
    assert.equal(channel._getMessages().length, 1, 'Run 1 should create exactly 1 welcome message');
    const firstMsgId = channel._getMessages()[0].id;

    // Simulate an error message being posted afterward
    channel._getMessages().push({
      id: 'msg_stale_interim',
      author: { id: botUserId },
      content: '❌ An unexpected error occurred while processing your request. (Reference: int_xyz)',
      embeds: [],
      components: [],
      delete: async function() {
        const idx = channel._getMessages().findIndex(m => m.id === 'msg_stale_interim');
        if (idx !== -1) channel._getMessages().splice(idx, 1);
      }
    });
    assert.equal(channel._getMessages().length, 2, 'Channel now has 1 welcome and 1 error message');

    // Run 2: Reconciles welcome, cleans error
    await devProvisioner._initializeWelcomeChannel(channel, botMember, 'run_2');
    assert.equal(channel._getMessages().length, 1, 'Run 2 should leave exactly 1 message');
    assert.equal(channel._getMessages()[0].id, firstMsgId, 'Run 2 must preserve the same canonical message');

    // Run 3: Idempotent no-op
    await devProvisioner._initializeWelcomeChannel(channel, botMember, 'run_3');
    assert.equal(channel._getMessages().length, 1, 'Run 3 must still have exactly 1 message');
    assert.equal(channel._getMessages()[0].id, firstMsgId, 'Same canonical message preserved across all runs');
  });

});
