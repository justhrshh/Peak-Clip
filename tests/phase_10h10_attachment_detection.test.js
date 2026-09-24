import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { handleMessageCreate } from '../src/bot/events/messageCreate.handler.js';
import {
  payoutUploadSessionManager,
  UPLOAD_SESSION_STATUS
} from '../src/modules/payouts/payout-upload-session.manager.js';
import { payoutDraftManager } from '../src/modules/payouts/payout-draft.manager.js';
import {
  buildMockMp4Buffer,
  validateEvidenceFile,
  isSupportedVideoAttachment,
  MAX_EVIDENCE_FILE_SIZE_BYTES
} from '../src/modules/evidence/evidence.validator.js';
import { EvidenceService } from '../src/modules/evidence/evidence.service.js';
import { PayoutService } from '../src/modules/payouts/payout.service.js';

// --- Test Harness Helpers ---

function createMockDiscordAttachment({
  id = 'att_1',
  name = 'recording.mp4',
  size = 1024,
  contentType = 'video/mp4',
  url = 'https://cdn.discordapp.com/attachments/1/recording.mp4',
  proxyURL = 'https://media.discordapp.net/attachments/1/recording.mp4'
} = {}) {
  return {
    id,
    name,
    size,
    contentType,
    url,
    proxyURL
  };
}

function createMockDiscordMessage({
  id = 'msg_test_1',
  authorId = 'disc_creator_123',
  guildId = 'guild_dev_1',
  channelId = 'channel_payouts_1',
  attachments = []
} = {}) {
  let deleted = false;
  const replies = [];

  // Implement discord.js Collection-like attachments map
  const attMap = new Map();
  attachments.forEach((att, idx) => {
    const key = att.id || `att_${idx}`;
    attMap.set(key, att);
  });

  const attachmentsCollection = {
    size: attMap.size,
    get: (k) => attMap.get(k),
    values: () => attMap.values(),
    first: () => (attMap.size > 0 ? Array.from(attMap.values())[0] : undefined),
    map: (fn) => Array.from(attMap.values()).map(fn),
    [Symbol.iterator]: () => attMap.values()
  };

  return {
    id,
    author: { id: authorId, bot: false, tag: 'Creator#0001' },
    guildId,
    guild: { id: guildId },
    channelId,
    channel: {
      id: channelId,
      send: async (payload) => {
        replies.push(payload);
        return { id: `reply_${replies.length}`, ...payload };
      }
    },
    attachments: attachmentsCollection,
    delete: async () => {
      deleted = true;
      return true;
    },
    isDeleted: () => deleted,
    replies
  };
}

function createMockEnvironment() {
  const users = new Map();
  const earnings = new Map();
  const payoutRequests = new Map();
  const disbursements = new Map();
  const payoutEvents = new Map();
  const systemSettings = new Map();
  const storageFiles = new Map();

  let payoutCounter = 1;
  let evidenceCounter = 1;

  const mockPrisma = {
    user: {
      findUnique: async ({ where }) => users.get(where.id) || null,
      findFirst: async ({ where }) => {
        for (const u of users.values()) {
          if (where.discordId && u.discordId === where.discordId) return u;
        }
        return null;
      }
    },
    systemSetting: {
      findUnique: async ({ where }) => systemSettings.get(where.key) || null,
      upsert: async ({ where, create, update }) => {
        const existing = systemSettings.get(where.key);
        const val = existing ? { ...existing, ...update } : { ...create, key: where.key };
        systemSettings.set(where.key, val);
        return val;
      },
      delete: async ({ where }) => {
        systemSettings.delete(where.key);
      }
    },
    payoutEvidence: {
      create: async ({ data }) => {
        const id = `ev_${evidenceCounter++}`;
        const record = { id, ...data, createdAt: new Date() };
        return record;
      }
    },
    $queryRaw: async () => [{}]
  };

  const storageService = {
    saveFile: async ({ buffer, filename, mimeType }) => {
      const storageKey = `evidence/${Date.now()}_${filename}`;
      storageFiles.set(storageKey, { buffer, filename, mimeType });
      return { storageKey, url: `https://storage.local/${storageKey}` };
    },
    getFile: async (key) => storageFiles.get(key)?.buffer || null
  };

  return {
    mockPrisma,
    sessionManager: payoutUploadSessionManager,
    storageService,
    storageFiles
  };
}

function createMockFetch(urlBufferMap = new Map()) {
  return async (url) => {
    const entry = urlBufferMap.get(url);
    if (!entry) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found'
      };
    }
    if (entry.fail) {
      throw new Error(entry.errorMessage || 'Network error');
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => entry.buffer.buffer.slice(
        entry.buffer.byteOffset,
        entry.buffer.byteOffset + entry.buffer.byteLength
      )
    };
  };
}

// --- Test Suite ---

describe('Phase 10H.10 — Payout Attachment Detection & Qualification', () => {
  const discordUserId = 'disc_creator_10h10';
  const userId = 'usr_creator_10h10';
  const guildId = 'guild_dev_1';
  const channelId = 'channel_payouts_1';
  let env;

  beforeEach(() => {
    env = createMockEnvironment();
    payoutDraftManager.clearDraft(userId);
    payoutUploadSessionManager.clearSession(discordUserId);
  });

  // A. message with 0 attachments -> upload prompt
  test('A. message with 0 attachments -> upload prompt', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: []
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService
    });

    assert.equal(msg.isDeleted(), true);
    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].content, /Please upload your analytics screen recording as a video attachment/i);

    const session = await env.sessionManager.getSession(discordUserId);
    assert.equal(session.status, UPLOAD_SESSION_STATUS.WAITING_FOR_UPLOAD);
  });

  // B. message with 1 MP4 attachment -> processing
  test('B. message with 1 MP4 attachment -> processing & accepted', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const mp4Buf = buildMockMp4Buffer(12.0);
    const mockUrl = 'https://cdn.discordapp.com/recording.mp4';
    const fetchMap = new Map([[mockUrl, { buffer: mp4Buf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [createMockDiscordAttachment({ name: 'recording.mp4', contentType: 'video/mp4', url: mockUrl })]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService,
      fetch: createMockFetch(fetchMap)
    });

    assert.equal(msg.isDeleted(), true);
    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].embeds[0].data.title, /Recording Received/i);
    assert.match(msg.replies[0].embeds[0].data.description, /Your analytics recording passed the technical checks/i);

    const session = await env.sessionManager.getSession(discordUserId);
    assert.equal(session.status, UPLOAD_SESSION_STATUS.EVIDENCE_READY);
  });

  // C. message with 1 WebM attachment -> processing
  test('C. message with 1 WebM attachment -> processing', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const webmBuf = Buffer.from('webm-content-header-test');
    const mockUrl = 'https://cdn.discordapp.com/recording.webm';
    const fetchMap = new Map([[mockUrl, { buffer: webmBuf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [createMockDiscordAttachment({ name: 'recording.webm', contentType: 'video/webm', url: mockUrl })]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService,
      fetch: createMockFetch(fetchMap),
      validateEvidenceFile: async () => ({ isValid: true, durationSeconds: 20.0, format: 'webm' })
    });

    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].embeds[0].data.title, /Recording Received/i);
  });

  // D. message with 1 MOV attachment -> processing
  test('D. message with 1 MOV attachment -> processing', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const movBuf = buildMockMp4Buffer(18.0);
    const mockUrl = 'https://cdn.discordapp.com/recording.mov';
    const fetchMap = new Map([[mockUrl, { buffer: movBuf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [createMockDiscordAttachment({ name: 'recording.mov', contentType: 'video/quicktime', url: mockUrl })]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService,
      fetch: createMockFetch(fetchMap)
    });

    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].embeds[0].data.title, /Recording Received/i);
  });

  // E. message with 1 MKV attachment -> processing
  test('E. message with 1 MKV attachment -> processing', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const mkvBuf = Buffer.from('mkv-data');
    const mockUrl = 'https://cdn.discordapp.com/recording.mkv';
    const fetchMap = new Map([[mockUrl, { buffer: mkvBuf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [createMockDiscordAttachment({ name: 'recording.mkv', contentType: 'video/x-matroska', url: mockUrl })]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService,
      fetch: createMockFetch(fetchMap),
      validateEvidenceFile: async () => ({ isValid: true, durationSeconds: 25.0, format: 'mkv' })
    });

    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].embeds[0].data.title, /Recording Received/i);
  });

  // F. attachment with undefined contentType but .mp4 filename -> processing
  test('F. attachment with undefined contentType but .mp4 filename -> passes preliminary check and proceeds to validation', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const att = createMockDiscordAttachment({ name: 'screen_recording.mp4', contentType: undefined });
    assert.equal(isSupportedVideoAttachment(att), true);

    const mp4Buf = buildMockMp4Buffer(15.0);
    const mockUrl = att.url;
    const fetchMap = new Map([[mockUrl, { buffer: mp4Buf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [att]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService,
      fetch: createMockFetch(fetchMap)
    });

    assert.equal(msg.isDeleted(), true);
    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].embeds[0].data.title, /Recording Received/i);
  });

  // G. attachment with application/octet-stream but .mp4 filename -> processing
  test('G. attachment with application/octet-stream but .mp4 filename -> passes preliminary check and proceeds to validation', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const att = createMockDiscordAttachment({ name: 'analytics.mp4', contentType: 'application/octet-stream' });
    assert.equal(isSupportedVideoAttachment(att), true);

    const mp4Buf = buildMockMp4Buffer(22.0);
    const mockUrl = att.url;
    const fetchMap = new Map([[mockUrl, { buffer: mp4Buf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [att]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService,
      fetch: createMockFetch(fetchMap)
    });

    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].embeds[0].data.title, /Recording Received/i);
  });

  // H. unsupported .txt -> reject
  test('H. unsupported .txt -> reject', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const att = createMockDiscordAttachment({ name: 'notes.txt', contentType: 'text/plain' });
    assert.equal(isSupportedVideoAttachment(att), false);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [att]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService
    });

    assert.equal(msg.isDeleted(), true);
    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].content, /Recording Rejected/i);
    assert.match(msg.replies[0].content, /Unsupported recording format/i);
  });

  // I. multiple attachments -> reject
  test('I. multiple attachments -> reject', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [
        createMockDiscordAttachment({ id: 'att_1', name: 'rec1.mp4' }),
        createMockDiscordAttachment({ id: 'att_2', name: 'rec2.mp4' })
      ]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService
    });

    assert.equal(msg.isDeleted(), true);
    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].content, /Please upload one analytics recording at a time/i);
  });

  // J. >20 MB -> reject according to current configured Discord-compatible limit
  test('J. >20 MB -> reject according to current configured Discord-compatible limit', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    // 21 MB buffer exceeding 20 MB limit
    const bigBuf = Buffer.alloc(21 * 1024 * 1024, 0);
    const mockUrl = 'https://cdn.discordapp.com/large.mp4';
    const fetchMap = new Map([[mockUrl, { buffer: bigBuf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [createMockDiscordAttachment({ name: 'large.mp4', size: bigBuf.length, url: mockUrl })]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService,
      fetch: createMockFetch(fetchMap)
    });

    assert.equal(msg.isDeleted(), true);
    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].content, /Recording Rejected/i);
    assert.match(msg.replies[0].content, /20 MB/i);
  });

  // K. exactly 40 seconds -> reject
  test('K. exactly 40.00 seconds -> reject (< 40.0s strict requirement)', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const mp4Buf = buildMockMp4Buffer(40.0);
    const mockUrl = 'https://cdn.discordapp.com/exact40.mp4';
    const fetchMap = new Map([[mockUrl, { buffer: mp4Buf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [createMockDiscordAttachment({ name: 'exact40.mp4', url: mockUrl })]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService,
      fetch: createMockFetch(fetchMap)
    });

    assert.equal(msg.isDeleted(), true);
    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].content, /Recording Rejected/i);
    assert.match(msg.replies[0].content, /under 40 seconds/i);
  });

  // L. <40 seconds -> continue
  test('L. <40 seconds (39.99s) -> continue', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const mp4Buf = buildMockMp4Buffer(39.99);
    const mockUrl = 'https://cdn.discordapp.com/39_99.mp4';
    const fetchMap = new Map([[mockUrl, { buffer: mp4Buf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [createMockDiscordAttachment({ name: '39_99.mp4', url: mockUrl })]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService,
      fetch: createMockFetch(fetchMap)
    });

    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].embeds[0].data.title, /Recording Received/i);
  });

  // M. corrupt video -> reject cleanly
  test('M. corrupt video -> reject cleanly without crashing', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const badBuf = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x66, 0x72, 0x65, 0x65]);
    const mockUrl = 'https://cdn.discordapp.com/corrupt.mp4';
    const fetchMap = new Map([[mockUrl, { buffer: badBuf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [createMockDiscordAttachment({ name: 'corrupt.mp4', url: mockUrl })]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService,
      fetch: createMockFetch(fetchMap)
    });

    assert.equal(msg.isDeleted(), true);
    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].content, /Recording Rejected/i);
    assert.match(msg.replies[0].content, /Unable to parse video stream header/i);
  });

  // N. expired upload session -> reject
  test('N. expired upload session -> reject', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });

    // Manually expire session
    const session = await env.sessionManager.getSession(discordUserId);
    session.expiresAt = Date.now() - 1000;

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [createMockDiscordAttachment({ name: 'late.mp4' })]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService
    });

    assert.equal(msg.isDeleted(), true);
    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].content, /session has expired/i);
  });

  // O. wrong user/channel/guild -> reject
  test('O. wrong user/channel/guild -> ignored/rejected without mutating session', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });

    // Different user
    const wrongUserMsg = createMockDiscordMessage({
      authorId: 'intruder_456',
      guildId,
      channelId,
      attachments: [createMockDiscordAttachment({ name: 'intruder.mp4' })]
    });

    await handleMessageCreate(wrongUserMsg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService
    });

    assert.equal(wrongUserMsg.isDeleted(), false);
    assert.equal(wrongUserMsg.replies.length, 0);

    // Wrong channel
    const wrongChanMsg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId: 'channel_general_99',
      attachments: [createMockDiscordAttachment({ name: 'wrong_chan.mp4' })]
    });

    await handleMessageCreate(wrongChanMsg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService
    });

    assert.equal(wrongChanMsg.isDeleted(), false);
    assert.equal(wrongChanMsg.replies.length, 0);

    // Session remains intact
    const session = await env.sessionManager.getSession(discordUserId);
    assert.equal(session.status, UPLOAD_SESSION_STATUS.WAITING_FOR_UPLOAD);
  });
});
