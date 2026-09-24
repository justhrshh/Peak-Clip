import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';

import {
  handleMessageCreate
} from '../src/bot/events/messageCreate.handler.js';
import {
  PayoutUploadSessionManager,
  UPLOAD_SESSION_STATUS
} from '../src/modules/payouts/payout-upload-session.manager.js';
import { payoutDraftManager } from '../src/modules/payouts/payout-draft.manager.js';
import {
  validateEvidenceFile,
  buildMockMp4Buffer,
  EvidenceValidationError
} from '../src/modules/evidence/evidence.validator.js';
import { StorageService } from '../src/modules/storage/storage.service.js';
import { PayoutService } from '../src/modules/payouts/payout.service.js';
import { EvidenceService } from '../src/modules/evidence/evidence.service.js';
import { PayoutProfileService } from '../src/modules/payout-profile/payout-profile.service.js';

// =============================================================================
// MOCK ENVIRONMENT FOR PHASE 10H.9
// =============================================================================
function createMockEnvironment() {
  const users = new Map();
  const payoutProfiles = new Map();
  const payoutEvidence = new Map();
  const payoutRequests = new Map();
  const disbursements = new Map();
  const payoutEvents = [];
  const earnings = new Map();
  const storageFiles = new Map();

  let evidenceCounter = 1;
  let payoutCounter = 1;

  const mockStorageAdapter = {
    async saveFile({ buffer, filename, mimeType }) {
      const storageKey = `evidence/${Date.now()}_${filename}`;
      storageFiles.set(storageKey, Buffer.from(buffer));
      return { storageKey, filename, mimeType, fileSize: buffer.length };
    },
    async getFileBuffer(storageKey) {
      const buf = storageFiles.get(storageKey);
      if (!buf) throw new Error('File not found');
      return buf;
    },
    async getFileMetadata(storageKey) {
      const exists = storageFiles.has(storageKey);
      return { exists, size: exists ? storageFiles.get(storageKey).length : 0, mtime: new Date() };
    },
    async deleteFile(storageKey) {
      return storageFiles.delete(storageKey);
    }
  };

  const storageService = new StorageService(mockStorageAdapter);

  const mockPrisma = {
    payoutProfile: {
      async findUnique({ where }) {
        if (where.userId) return payoutProfiles.get(where.userId) || null;
        return null;
      },
      async create({ data }) {
        const id = `prof_${Date.now()}`;
        const record = { id, ...data };
        payoutProfiles.set(data.userId, record);
        return record;
      }
    },
    payoutEvidence: {
      async create({ data }) {
        const id = `ev_${evidenceCounter++}`;
        const record = { id, ...data, createdAt: new Date() };
        payoutEvidence.set(id, record);
        return record;
      },
      async findMany({ where }) {
        let list = Array.from(payoutEvidence.values());
        if (where?.payoutRequestId) list = list.filter((e) => e.payoutRequestId === where.payoutRequestId);
        return list;
      }
    }
  };

  const profileService = new PayoutProfileService(mockPrisma);
  const evidenceService = new EvidenceService(mockPrisma, storageService);

  const mockPayoutRepo = {
    users,
    payoutRequests,
    disbursements,
    payoutEvents,
    payoutProfile: mockPrisma.payoutProfile,
    payoutEvidence: mockPrisma.payoutEvidence,

    async transaction(callback) {
      return callback(mockPayoutRepo);
    },
    async acquireUserPayoutLock() {},
    async acquirePayoutRequestLock() {},

    async getUserById(userId) {
      return users.get(userId) || null;
    },

    async getPayoutBalanceBreakdown(userId, currency = 'USD') {
      let totalEligible = new Prisma.Decimal('0.00');
      for (const e of earnings.values()) {
        if (e.userId === userId && e.currency === currency && e.status === 'ELIGIBLE') {
          totalEligible = totalEligible.plus(new Prisma.Decimal(e.grossAmount.toString()));
        }
      }

      let reservedBalance = new Prisma.Decimal('0.00');
      for (const p of payoutRequests.values()) {
        if (p.userId === userId && p.currency === currency && ['REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING'].includes(p.status)) {
          reservedBalance = reservedBalance.plus(new Prisma.Decimal(p.amount.toString()));
        }
      }

      const availableBalance = Prisma.Decimal.max(new Prisma.Decimal('0.00'), totalEligible.minus(reservedBalance));

      return {
        totalEligible,
        reservedBalance,
        completedPayouts: new Prisma.Decimal('0.00'),
        availableBalance,
        minimumPayout: new Prisma.Decimal('10.00'),
        currency
      };
    },

    async createPayoutRequest(data) {
      const id = `pr_${payoutCounter++}`;
      const record = {
        id,
        ...data,
        amount: new Prisma.Decimal(data.amount.toString()),
        requestedAt: new Date(),
        status: data.status || 'REQUESTED',
        createdAt: new Date(),
        updatedAt: new Date()
      };
      payoutRequests.set(id, record);
      return record;
    },

    async recordPayoutEvent(data) {
      payoutEvents.push({ id: `pe_${payoutEvents.length + 1}`, ...data, createdAt: new Date() });
    }
  };

  const payoutService = new PayoutService(mockPayoutRepo, evidenceService, profileService);
  const sessionManager = new PayoutUploadSessionManager(null); // in-memory mode for tests

  return {
    users,
    payoutProfiles,
    payoutEvidence,
    payoutRequests,
    payoutEvents,
    earnings,
    storageFiles,
    storageService,
    evidenceService,
    payoutService,
    sessionManager
  };
}

function createMockDiscordMessage({
  authorId = 'disc_creator_1',
  guildId = 'guild_100',
  channelId = 'channel_payouts',
  isBot = false,
  attachments = []
}) {
  const replies = [];
  let deleted = false;

  const attachmentsMap = new Map();
  attachments.forEach((att, idx) => {
    attachmentsMap.set(att.id || `att_${idx}`, {
      id: att.id || `att_${idx}`,
      name: att.name || 'recording.mp4',
      contentType: att.contentType || 'video/mp4',
      size: att.size || (att.buffer ? att.buffer.length : 1024),
      url: att.url || `https://cdn.discordapp.com/attachments/${channelId}/${att.id || idx}/${att.name || 'recording.mp4'}`,
      _buffer: att.buffer || null
    });
  });

  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    author: {
      id: authorId,
      bot: isBot,
      username: 'test_creator'
    },
    guildId,
    channelId,
    attachments: attachmentsMap,
    delete: async () => {
      deleted = true;
      return true;
    },
    isDeleted: () => deleted,
    channel: {
      id: channelId,
      send: async (payload) => {
        replies.push(payload);
        return { ...payload, id: `bot_msg_${Date.now()}` };
      }
    },
    replies
  };
}

function createMockFetch(urlToBufferMap) {
  return async (url) => {
    const matched = urlToBufferMap.get(url);
    if (!matched) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found'
      };
    }
    if (matched.failNetwork) {
      throw new Error('Network connection failed (simulated CDN failure)');
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => matched.buffer.buffer.slice(
        matched.buffer.byteOffset,
        matched.buffer.byteOffset + matched.buffer.byteLength
      )
    };
  };
}

describe('Phase 10H.9 — Payout Evidence Upload Listener & Attachment Processor', () => {
  let env;
  const discordUserId = 'disc_creator_123';
  const userId = 'usr_creator_123';
  const guildId = 'guild_dev_1';
  const channelId = 'channel_payouts_1';

  beforeEach(() => {
    env = createMockEnvironment();
    payoutDraftManager.clearDraft(userId);

    // Seed active user
    env.users.set(userId, {
      id: userId,
      discordId: discordUserId,
      username: 'creator123',
      status: 'ACTIVE'
    });

    // Seed $200.00 eligible balance
    env.earnings.set('earn_init', {
      id: 'earn_init',
      userId,
      grossAmount: new Prisma.Decimal('200.00'),
      currency: 'USD',
      status: 'ELIGIBLE'
    });
  });

  // 1. messageCreate with active payout upload session
  test('1. messageCreate with active payout upload session is intercepted and processed', async () => {
    await env.sessionManager.createSession({
      discordUserId,
      userId,
      guildId,
      channelId,
      amount: '50.00',
      currency: 'USD'
    });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const mp4Buf = buildMockMp4Buffer(15.0);
    const mockUrl = 'https://cdn.discordapp.com/attachments/test/video.mp4';
    const fetchMap = new Map([[mockUrl, { buffer: mp4Buf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [{ name: 'video.mp4', contentType: 'video/mp4', url: mockUrl, buffer: mp4Buf }]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService,
      fetch: createMockFetch(fetchMap)
    });

    assert.equal(msg.isDeleted(), true);
    assert.equal(msg.replies.length, 1);
    const reply = msg.replies[0];
    assert.match(reply.embeds[0].data.title, /Recording Received/i);

    const session = await env.sessionManager.getSession(discordUserId);
    assert.equal(session.status, UPLOAD_SESSION_STATUS.EVIDENCE_READY);
    assert.ok(session.evidence);
  });

  // 2. valid MP4 attachment
  test('2. valid MP4 attachment is downloaded, validated, stored, and marked ready', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const mp4Buf = buildMockMp4Buffer(25.0);
    const mockUrl = 'https://cdn.discordapp.com/video.mp4';
    const fetchMap = new Map([[mockUrl, { buffer: mp4Buf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [{ name: 'analytics.mp4', contentType: 'video/mp4', url: mockUrl, buffer: mp4Buf }]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService,
      fetch: createMockFetch(fetchMap)
    });

    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].embeds[0].data.title, /Recording Received/i);
    assert.match(msg.replies[0].embeds[0].data.fields.find(f => f.name.includes('Duration')).value, /25\.00 seconds/);
  });

  // 3. valid WebM attachment
  test('3. valid WebM attachment is accepted and processed', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    // Synthetic webm buffer
    const webmBuf = Buffer.from('RIFF....WEBMfakevalidcontent');
    const mockUrl = 'https://cdn.discordapp.com/video.webm';
    const fetchMap = new Map([[mockUrl, { buffer: webmBuf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [{ name: 'analytics.webm', contentType: 'video/webm', url: mockUrl, buffer: webmBuf }]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService,
      validateEvidenceFile: async () => ({ isValid: true, durationSeconds: 20.0, format: 'webm' }),
      fetch: createMockFetch(fetchMap)
    });

    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].embeds[0].data.title, /Recording Received/i);
  });

  // 4. valid MOV attachment
  test('4. valid MOV attachment is accepted and processed', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const movBuf = buildMockMp4Buffer(18.0);
    const mockUrl = 'https://cdn.discordapp.com/video.mov';
    const fetchMap = new Map([[mockUrl, { buffer: movBuf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [{ name: 'analytics.mov', contentType: 'video/quicktime', url: mockUrl, buffer: movBuf }]
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

  // 5. valid MKV attachment
  test('5. valid MKV attachment is accepted and processed', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const mkvBuf = Buffer.from('EBML....MKVfakecontent');
    const mockUrl = 'https://cdn.discordapp.com/video.mkv';
    const fetchMap = new Map([[mockUrl, { buffer: mkvBuf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [{ name: 'analytics.mkv', contentType: 'video/x-matroska', url: mockUrl, buffer: mkvBuf }]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService,
      validateEvidenceFile: async () => ({ isValid: true, durationSeconds: 30.0, format: 'mkv' }),
      fetch: createMockFetch(fetchMap)
    });

    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].embeds[0].data.title, /Recording Received/i);
  });

  // 6. no attachment
  test('6. message received with NO attachment prompts creator to upload recording', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [] // Empty
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService
    });

    assert.equal(msg.isDeleted(), true);
    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].content, /Please upload your analytics screen recording/i);

    // Session remains in waiting state
    const session = await env.sessionManager.getSession(discordUserId);
    assert.equal(session.status, UPLOAD_SESSION_STATUS.WAITING_FOR_UPLOAD);
  });

  // 7. unsupported format
  test('7. unsupported format (e.g. .png, .exe, .pdf) is rejected and deletes message', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const fakeBuf = Buffer.from('fake png file');
    const mockUrl = 'https://cdn.discordapp.com/screenshot.png';
    const fetchMap = new Map([[mockUrl, { buffer: fakeBuf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [{ name: 'screenshot.png', contentType: 'image/png', url: mockUrl, buffer: fakeBuf }]
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
    assert.match(msg.replies[0].content, /Unsupported recording format/i);

    // Session is reset to WAITING_FOR_UPLOAD so creator can retry
    const session = await env.sessionManager.getSession(discordUserId);
    assert.equal(session.status, UPLOAD_SESSION_STATUS.WAITING_FOR_UPLOAD);
    assert.equal(env.payoutRequests.size, 0);
  });

  // 8. > 50MB
  test('8. file exceeding 50 MB is rejected with 50 MB limit notice', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const hugeBuf = Buffer.alloc(51 * 1024 * 1024);
    const mockUrl = 'https://cdn.discordapp.com/huge.mp4';
    const fetchMap = new Map([[mockUrl, { buffer: hugeBuf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [{ name: 'huge.mp4', contentType: 'video/mp4', url: mockUrl, buffer: hugeBuf }]
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
    assert.match(msg.replies[0].content, /20 MB|50 MB|file size/i);
  });

  // 9. exactly 40 seconds
  test('9. recording of exactly 40.00 seconds is strictly REJECTED (< 40.0s requirement)', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const exact40Buf = buildMockMp4Buffer(40.0);
    const mockUrl = 'https://cdn.discordapp.com/exact40.mp4';
    const fetchMap = new Map([[mockUrl, { buffer: exact40Buf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [{ name: 'exact40.mp4', contentType: 'video/mp4', url: mockUrl, buffer: exact40Buf }]
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

    assert.equal(env.payoutRequests.size, 0);
  });

  // 10. 39.99 seconds
  test('10. recording of 39.99 seconds is PASS (< 40.0s)', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const buf39 = buildMockMp4Buffer(39.99);
    const mockUrl = 'https://cdn.discordapp.com/pass39.mp4';
    const fetchMap = new Map([[mockUrl, { buffer: buf39 }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [{ name: 'pass39.mp4', contentType: 'video/mp4', url: mockUrl, buffer: buf39 }]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService,
      fetch: createMockFetch(fetchMap)
    });

    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].embeds[0].data.title, /Recording Received/i);
    assert.match(msg.replies[0].embeds[0].data.fields.find(f => f.name.includes('Duration')).value, /39\.99/);
  });

  // 11. > 40 seconds
  test('11. recording exceeding 40 seconds (40.01s) is strictly REJECTED', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const over40Buf = buildMockMp4Buffer(40.01);
    const mockUrl = 'https://cdn.discordapp.com/over40.mp4';
    const fetchMap = new Map([[mockUrl, { buffer: over40Buf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [{ name: 'over40.mp4', contentType: 'video/mp4', url: mockUrl, buffer: over40Buf }]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService,
      fetch: createMockFetch(fetchMap)
    });

    assert.equal(msg.isDeleted(), true);
    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].content, /under 40 seconds/i);
  });

  // 12. corrupt media
  test('12. corrupt media with invalid header is rejected without crashing', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const corruptBuf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    const mockUrl = 'https://cdn.discordapp.com/corrupt.mp4';
    const fetchMap = new Map([[mockUrl, { buffer: corruptBuf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [{ name: 'corrupt.mp4', contentType: 'video/mp4', url: mockUrl, buffer: corruptBuf }]
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
  });

  // 13. expired upload session
  test('13. attachment arriving after upload session has expired is rejected safely', async () => {
    // Create session that expired 1 second ago
    await env.sessionManager.createSession({
      discordUserId,
      userId,
      guildId,
      channelId,
      amount: '50.00',
      customTtlMs: -1000 // Already expired
    });

    const mp4Buf = buildMockMp4Buffer(15.0);
    const mockUrl = 'https://cdn.discordapp.com/late.mp4';
    const fetchMap = new Map([[mockUrl, { buffer: mp4Buf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [{ name: 'late.mp4', contentType: 'video/mp4', url: mockUrl, buffer: mp4Buf }]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService,
      fetch: createMockFetch(fetchMap)
    });

    assert.equal(msg.isDeleted(), true);
    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].content, /session has expired/i);

    // Verify session is cleared
    assert.equal(await env.sessionManager.getSession(discordUserId), null);
  });

  // 14. wrong user
  test('14. wrong user uploading into channel does not trigger or affect another creator session', async () => {
    // User A has an active session
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });

    // User B sends an attachment in the channel
    const userB = 'disc_intruder_999';
    const msg = createMockDiscordMessage({
      authorId: userB,
      guildId,
      channelId,
      attachments: [{ name: 'random.mp4', contentType: 'video/mp4', url: 'https://cdn.discordapp.com/random.mp4' }]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService
    });

    // Message is ignored normally
    assert.equal(msg.isDeleted(), false);
    assert.equal(msg.replies.length, 0);

    // User A's session remains untouched
    const sessionA = await env.sessionManager.getSession(discordUserId);
    assert.equal(sessionA.status, UPLOAD_SESSION_STATUS.WAITING_FOR_UPLOAD);
  });

  // 15. wrong guild
  test('15. attachment uploaded in wrong guild is ignored', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId: 'different_guild_999', // Wrong guild
      channelId,
      attachments: [{ name: 'video.mp4', contentType: 'video/mp4', url: 'https://cdn.discordapp.com/video.mp4' }]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService
    });

    assert.equal(msg.isDeleted(), false);
    assert.equal(msg.replies.length, 0);
  });

  // 16. wrong channel
  test('16. attachment uploaded in wrong channel is ignored', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId: 'general_chat_channel', // Wrong channel
      attachments: [{ name: 'video.mp4', contentType: 'video/mp4', url: 'https://cdn.discordapp.com/video.mp4' }]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService
    });

    assert.equal(msg.isDeleted(), false);
    assert.equal(msg.replies.length, 0);
  });

  // 17. multiple attachments
  test('17. multiple attachments uploaded in one message rejected with single recording notice', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [
        { name: 'rec1.mp4', contentType: 'video/mp4' },
        { name: 'rec2.mp4', contentType: 'video/mp4' }
      ]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService
    });

    assert.equal(msg.isDeleted(), true);
    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].content, /one analytics recording at a time/i);
  });

  // 18. duplicate upload
  test('18. duplicate upload after evidence is already ready is rejected with already received notice', async () => {
    const session = await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    await env.sessionManager.attachEvidence(discordUserId, { storageKey: 'ev/1.mp4' });

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [{ name: 'second.mp4', contentType: 'video/mp4' }]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService
    });

    assert.equal(msg.isDeleted(), true);
    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].content, /already been received/i);
  });

  // 19. concurrent uploads
  test('19. concurrent uploads: second message arriving while first is PROCESSING is rejected with already processing notice', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    // Transition to PROCESSING
    await env.sessionManager.transitionToProcessing(discordUserId, { guildId, channelId });

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [{ name: 'race.mp4', contentType: 'video/mp4' }]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService
    });

    assert.equal(msg.isDeleted(), true);
    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].content, /already being processed/i);
  });

  // 20. Discord CDN download failure
  test('20. Discord CDN download failure is handled cleanly without crashing or creating payout', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const mockUrl = 'https://cdn.discordapp.com/fail.mp4';
    const fetchMap = new Map([[mockUrl, { failNetwork: true }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [{ name: 'fail.mp4', contentType: 'video/mp4', url: mockUrl }]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService,
      fetch: createMockFetch(fetchMap)
    });

    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].content, /couldn't process that recording/i);

    // Session status reset to WAITING_FOR_UPLOAD
    const session = await env.sessionManager.getSession(discordUserId);
    assert.equal(session.status, UPLOAD_SESSION_STATUS.WAITING_FOR_UPLOAD);
    assert.equal(env.payoutRequests.size, 0);
  });

  // 21. evidence storage failure
  test('21. evidence storage failure logs error and presents clean retry message without exposing internals', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const mp4Buf = buildMockMp4Buffer(12.0);
    const mockUrl = 'https://cdn.discordapp.com/storage_fail.mp4';
    const fetchMap = new Map([[mockUrl, { buffer: mp4Buf }]]);

    const failingStorage = {
      saveFile: async () => {
        throw new Error('EACCES: permission denied writing storage disk');
      }
    };

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [{ name: 'storage_fail.mp4', contentType: 'video/mp4', url: mockUrl, buffer: mp4Buf }]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: failingStorage,
      fetch: createMockFetch(fetchMap)
    });

    assert.equal(msg.replies.length, 1);
    assert.match(msg.replies[0].content, /couldn't process that recording/i);
    assert.doesNotMatch(msg.replies[0].content, /EACCES/); // Never leak stack or internal details

    assert.equal(env.payoutRequests.size, 0);
  });

  // 22. evidence correctly linked to payout flow
  test('22. evidence is correctly linked to draft session and upload session', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const mp4Buf = buildMockMp4Buffer(20.0);
    const mockUrl = 'https://cdn.discordapp.com/linked.mp4';
    const fetchMap = new Map([[mockUrl, { buffer: mp4Buf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [{ name: 'linked.mp4', contentType: 'video/mp4', url: mockUrl, buffer: mp4Buf }]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService,
      fetch: createMockFetch(fetchMap)
    });

    const draft = payoutDraftManager.getDraft(userId);
    assert.ok(draft);
    assert.ok(draft.evidence);
    assert.equal(draft.evidence.filename, 'linked.mp4');
    assert.equal(draft.evidence.durationSeconds, 20.0);

    const session = await env.sessionManager.getSession(discordUserId);
    assert.equal(session.status, UPLOAD_SESSION_STATUS.EVIDENCE_READY);
    assert.equal(session.evidence.filename, 'linked.mp4');
  });

  // 23. payout NOT created after upload
  test('23. successful upload does NOT create PayoutRequest and does NOT reserve funds', async () => {
    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, { amount: '50.00', currency: 'USD' });

    const mp4Buf = buildMockMp4Buffer(15.0);
    const mockUrl = 'https://cdn.discordapp.com/no_payout_yet.mp4';
    const fetchMap = new Map([[mockUrl, { buffer: mp4Buf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [{ name: 'no_payout_yet.mp4', contentType: 'video/mp4', url: mockUrl, buffer: mp4Buf }]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService,
      fetch: createMockFetch(fetchMap)
    });

    // Zero payout requests
    assert.equal(env.payoutRequests.size, 0);

    // Balance remains 0.00 reserved, 200.00 available
    const bal = await env.payoutService.getAvailablePayoutBalance(userId);
    assert.equal(bal.reservedBalance.toFixed(2), '0.00');
    assert.equal(bal.availableBalance.toFixed(2), '200.00');
  });

  // 24. explicit Submit Payout creates exactly one payout
  test('24. explicit Submit Payout creates exactly one payout with evidence attached', async () => {
    await env.payoutProfiles.set(userId, {
      id: 'prof_1',
      userId,
      walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
      network: 'ETHEREUM',
      walletName: 'MetaMask',
      platform: 'YOUTUBE'
    });

    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '50.00' });
    payoutDraftManager.createDraft(userId, {
      amount: '50.00',
      currency: 'USD',
      profileSnapshot: {
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        network: 'ETHEREUM',
        walletName: 'MetaMask',
        platform: 'YOUTUBE'
      }
    });

    const mp4Buf = buildMockMp4Buffer(15.0);
    const mockUrl = 'https://cdn.discordapp.com/ready.mp4';
    const fetchMap = new Map([[mockUrl, { buffer: mp4Buf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [{ name: 'ready.mp4', contentType: 'video/mp4', url: mockUrl, buffer: mp4Buf }]
    });

    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService,
      fetch: createMockFetch(fetchMap)
    });

    // User explicitly clicks Submit Payout
    const draft = payoutDraftManager.consumeDraft(userId);
    assert.ok(draft);

    const payout = await env.payoutService.createPayoutRequest(userId, draft.amount, draft.currency, {
      evidence: draft.evidence,
      profileSnapshot: draft.profileSnapshot,
      enforceEvidence: true
    });

    assert.ok(payout);
    assert.equal(env.payoutRequests.size, 1);
    assert.equal(payout.amount.toFixed(2), '50.00');
    assert.equal(payout.status, 'REQUESTED');

    // Evidence record created in DB
    assert.equal(env.payoutEvidence.size, 1);
    const attachedEv = Array.from(env.payoutEvidence.values())[0];
    assert.equal(attachedEv.payoutRequestId, payout.id);
  });

  // 25. reservation happens only after final confirmation
  test('25. reservation happens only after final confirmation, not at upload', async () => {
    await env.payoutProfiles.set(userId, {
      id: 'prof_1',
      userId,
      walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
      network: 'ETHEREUM',
      walletName: 'MetaMask',
      platform: 'YOUTUBE'
    });

    await env.sessionManager.createSession({ discordUserId, userId, guildId, channelId, amount: '75.00' });
    payoutDraftManager.createDraft(userId, {
      amount: '75.00',
      currency: 'USD',
      profileSnapshot: {
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        network: 'ETHEREUM'
      }
    });

    const mp4Buf = buildMockMp4Buffer(14.0);
    const mockUrl = 'https://cdn.discordapp.com/res.mp4';
    const fetchMap = new Map([[mockUrl, { buffer: mp4Buf }]]);

    const msg = createMockDiscordMessage({
      authorId: discordUserId,
      guildId,
      channelId,
      attachments: [{ name: 'res.mp4', contentType: 'video/mp4', url: mockUrl, buffer: mp4Buf }]
    });

    // 1. Upload happens
    await handleMessageCreate(msg, {
      sessionManager: env.sessionManager,
      draftManager: payoutDraftManager,
      storageService: env.storageService,
      fetch: createMockFetch(fetchMap)
    });

    // Check balance: ZERO reserved
    const balPostUpload = await env.payoutService.getAvailablePayoutBalance(userId);
    assert.equal(balPostUpload.reservedBalance.toFixed(2), '0.00');
    assert.equal(balPostUpload.availableBalance.toFixed(2), '200.00');

    // 2. Final confirmation / Submit
    const draft = payoutDraftManager.consumeDraft(userId);
    await env.payoutService.createPayoutRequest(userId, draft.amount, draft.currency, {
      evidence: draft.evidence,
      profileSnapshot: draft.profileSnapshot,
      enforceEvidence: true
    });

    // Check balance: Exactly 75.00 reserved, 125.00 available
    const balPostSubmit = await env.payoutService.getAvailablePayoutBalance(userId);
    assert.equal(balPostSubmit.reservedBalance.toFixed(2), '75.00');
    assert.equal(balPostSubmit.availableBalance.toFixed(2), '125.00');
  });
});
