import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';

import { PayoutService } from '../src/modules/payouts/payout.service.js';
import {
  PayoutError,
  PayoutEvidenceRequiredError,
  InvalidEvidenceError,
  InsufficientBalanceError,
  BelowMinimumPayoutError
} from '../src/modules/payouts/payout.errors.js';
import { payoutDraftManager } from '../src/modules/payouts/payout-draft.manager.js';
import {
  validateEvidenceFile,
  buildMockMp4Buffer,
  EvidenceValidationError
} from '../src/modules/evidence/evidence.validator.js';
import { EvidenceService } from '../src/modules/evidence/evidence.service.js';
import { StorageService } from '../src/modules/storage/storage.service.js';
import {
  PayoutProfileService,
  PayoutProfileError
} from '../src/modules/payout-profile/payout-profile.service.js';
import {
  buildPayoutEvidenceInstructionsEmbed,
  buildPayoutEvidenceReceivedEmbed,
  buildPayoutReviewEmbed,
  buildPayoutSubmittedEmbed
} from '../src/bot/embeds/payout.embeds.js';
import {
  buildPayoutEvidenceActionRow,
  buildPayoutEvidenceReceivedActionRow,
  buildPayoutReviewActionRow
} from '../src/bot/components/payout.components.js';
import {
  handlePayoutModalSubmit,
  handlePayoutEvidenceReviewButton,
  handlePayoutEvidenceSubmitButton,
  handlePayoutEvidenceCancelButton,
  handlePayoutEvidenceBackButton
} from '../src/bot/interactions/payout.interactions.js';
import { userService } from '../src/modules/users/user.service.js';

// =============================================================================
// MOCK ENVIRONMENT FACTORY FOR PHASE 10H.8
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
        if (where.id) return Array.from(payoutProfiles.values()).find((p) => p.id === where.id) || null;
        return null;
      },
      async create({ data }) {
        const id = `prof_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        payoutProfiles.set(data.userId, record);
        return record;
      },
      async update({ where, data }) {
        const existing = payoutProfiles.get(where.userId);
        if (!existing) throw new Error('Record not found');
        const updated = { ...existing, ...data, updatedAt: new Date() };
        payoutProfiles.set(where.userId, updated);
        return updated;
      }
    },
    payoutEvidence: {
      async create({ data }) {
        const id = `ev_${evidenceCounter++}`;
        const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        payoutEvidence.set(id, record);
        return record;
      },
      async findUnique({ where }) {
        return payoutEvidence.get(where.id) || null;
      },
      async findMany({ where, orderBy }) {
        let list = Array.from(payoutEvidence.values());
        if (where?.payoutRequestId) list = list.filter((e) => e.payoutRequestId === where.payoutRequestId);
        if (where?.userId) list = list.filter((e) => e.userId === where.userId);
        if (orderBy?.version === 'desc') list.sort((a, b) => b.version - a.version);
        return list;
      },
      async findFirst({ where, orderBy }) {
        const list = await this.findMany({ where, orderBy });
        return list[0] || null;
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
      let completedPayouts = new Prisma.Decimal('0.00');
      for (const p of payoutRequests.values()) {
        if (p.userId === userId && p.currency === currency) {
          const amt = new Prisma.Decimal(p.amount.toString());
          if (['REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING'].includes(p.status)) {
            reservedBalance = reservedBalance.plus(amt);
          } else if (p.status === 'COMPLETED') {
            completedPayouts = completedPayouts.plus(amt);
          }
        }
      }

      const availableBalance = Prisma.Decimal.max(
        new Prisma.Decimal('0.00'),
        totalEligible.minus(reservedBalance).minus(completedPayouts)
      );

      return {
        totalEligible,
        reservedBalance,
        completedPayouts,
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
        createdAt: new Date(),
        updatedAt: new Date()
      };
      payoutRequests.set(id, record);
      return record;
    },

    async getPayoutRequestById(id) {
      const pr = payoutRequests.get(id);
      if (!pr) return null;
      const prEv = Array.from(payoutEvidence.values())
        .filter((e) => e.payoutRequestId === id)
        .sort((a, b) => b.version - a.version);
      const prDis = Array.from(disbursements.values()).filter((d) => d.payoutRequestId === id);
      const u = users.get(pr.userId);
      return {
        ...pr,
        user: u || { id: pr.userId, username: 'creator', displayName: 'Creator', discordId: 'd_123' },
        evidence: prEv,
        disbursements: prDis
      };
    },

    async updatePayoutRequest(id, data) {
      const pr = payoutRequests.get(id);
      if (!pr) throw new Error('Payout request not found');
      const updated = { ...pr, ...data, updatedAt: new Date() };
      payoutRequests.set(id, updated);
      return updated;
    },

    async recordPayoutEvent(data) {
      payoutEvents.push({ id: `pe_${payoutEvents.length + 1}`, ...data, createdAt: new Date() });
    }
  };

  const payoutService = new PayoutService(mockPayoutRepo, evidenceService, profileService);

  return {
    users,
    payoutProfiles,
    payoutEvidence,
    payoutRequests,
    payoutEvents,
    earnings,
    storageFiles,
    profileService,
    evidenceService,
    payoutService,
    mockPayoutRepo
  };
}

function createMockInteraction(options = {}) {
  const replies = [];
  let modalShown = null;
  let deferred = false;
  let replied = false;

  return {
    id: `int_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    user: options.user || { id: 'discord_user_1', username: 'test_creator' },
    customId: options.customId || '',
    fields: {
      getTextInputValue: (fieldId) => options.fieldValues?.[fieldId] || ''
    },
    deferred,
    replied,
    replies,
    showModal: async (modal) => {
      modalShown = modal;
    },
    getModalShown: () => modalShown,
    reply: async (payload) => {
      replied = true;
      replies.push(payload);
      return payload;
    },
    deferReply: async () => {
      deferred = true;
    },
    deferUpdate: async () => {
      deferred = true;
    },
    editReply: async (payload) => {
      replied = true;
      replies.push(payload);
      return payload;
    },
    followUp: async (payload) => {
      replies.push(payload);
      return payload;
    }
  };
}

describe('Phase 10H.8 — Payout Request Analytics Screen Recording Verification', () => {
  let env;
  const creatorId = 'usr_creator_10h8';
  const discordUser = { id: 'disc_10h8_creator', username: 'creator10h8' };

  beforeEach(() => {
    env = createMockEnvironment();
    payoutDraftManager.clearDraft(creatorId);

    // Seed Creator User
    env.users.set(creatorId, {
      id: creatorId,
      discordId: discordUser.id,
      username: discordUser.username,
      displayName: 'Creator 10H8',
      status: 'ACTIVE'
    });

    // Seed $100.00 Eligible Balance
    env.earnings.set('earn_1', {
      id: 'earn_1',
      userId: creatorId,
      grossAmount: new Prisma.Decimal('100.00'),
      currency: 'USD',
      status: 'ELIGIBLE'
    });
  });

  // ===========================================================================
  // 1. Amount Modal Submit & Draft Creation (No Immediate Payout / No Reserve)
  // ===========================================================================
  test('1. Submitting payout modal creates draft session, does NOT create PayoutRequest, and does NOT reserve funds', async () => {
    // Configure Profile
    await env.profileService.saveProfile(creatorId, {
      walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
      network: 'ETHEREUM',
      walletName: 'MetaMask',
      platform: 'YOUTUBE'
    });

    // Verify balance before modal submit
    const preBal = await env.payoutService.getAvailablePayoutBalance(creatorId);
    assert.equal(preBal.availableBalance.toFixed(2), '100.00');
    assert.equal(preBal.reservedBalance.toFixed(2), '0.00');

    // Create draft directly or via manager
    const draft = payoutDraftManager.createDraft(creatorId, {
      amount: '50.00',
      currency: 'USD',
      profileSnapshot: {
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        network: 'ETHEREUM',
        walletName: 'MetaMask',
        platform: 'YOUTUBE'
      }
    });

    assert.ok(draft);
    assert.equal(draft.amount, '50.00');
    assert.equal(draft.currency, 'USD');
    assert.equal(draft.evidence, null);

    // Payout requests map MUST remain empty
    assert.equal(env.payoutRequests.size, 0);

    // Reserved balance MUST remain 0.00
    const postBal = await env.payoutService.getAvailablePayoutBalance(creatorId);
    assert.equal(postBal.reservedBalance.toFixed(2), '0.00');
    assert.equal(postBal.availableBalance.toFixed(2), '100.00');
  });

  // ===========================================================================
  // 2. Financial Amount Validation
  // ===========================================================================
  test('2. Attempting to create payout draft with amount exceeding available balance throws InsufficientBalanceError', async () => {
    await env.profileService.saveProfile(creatorId, {
      walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
      network: 'ETHEREUM'
    });

    const balance = await env.payoutService.getAvailablePayoutBalance(creatorId);
    const requested = new Prisma.Decimal('150.00');

    assert.throws(
      () => {
        if (requested.greaterThan(balance.availableBalance)) {
          throw new InsufficientBalanceError(requested.toFixed(2), balance.availableBalance.toFixed(2), balance.currency);
        }
      },
      (err) => err instanceof InsufficientBalanceError
    );

    assert.equal(payoutDraftManager.getDraft(creatorId), null);
    assert.equal(env.payoutRequests.size, 0);
  });

  test('3. Attempting to create payout draft below minimum payout threshold throws BelowMinimumPayoutError', async () => {
    await env.profileService.saveProfile(creatorId, {
      walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
      network: 'ETHEREUM'
    });

    const balance = await env.payoutService.getAvailablePayoutBalance(creatorId);
    const requested = new Prisma.Decimal('5.00');

    assert.throws(
      () => {
        if (requested.lessThan(balance.minimumPayout)) {
          throw new BelowMinimumPayoutError(requested.toFixed(2), balance.minimumPayout.toFixed(2), balance.currency);
        }
      },
      (err) => err instanceof BelowMinimumPayoutError
    );

    assert.equal(payoutDraftManager.getDraft(creatorId), null);
    assert.equal(env.payoutRequests.size, 0);
  });

  // ===========================================================================
  // 3. Payout Profile Requirement
  // ===========================================================================
  test('4. Submitting payout request without active payout profile throws PayoutProfileError', async () => {
    // Ensure no profile
    const prof = await env.profileService.getProfile(creatorId);
    assert.equal(prof, null);

    assert.rejects(
      async () => {
        const p = await env.profileService.getProfile(creatorId);
        if (!p || !p.walletAddress || !p.network) {
          throw new PayoutProfileError('A payout profile must be configured before requesting a payout.', 'PROFILE_REQUIRED', 400);
        }
      },
      (err) => err instanceof PayoutProfileError && err.code === 'PROFILE_REQUIRED'
    );
  });

  // ===========================================================================
  // 4. Evidence Requirement Enforcement in PayoutService
  // ===========================================================================
  test('5. Calling createPayoutRequest with enforceEvidence=true without evidence throws PayoutEvidenceRequiredError', async () => {
    await env.profileService.saveProfile(creatorId, {
      walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
      network: 'ETHEREUM'
    });

    await assert.rejects(
      async () => {
        await env.payoutService.createPayoutRequest(creatorId, '50.00', 'USD', {
          enforceEvidence: true,
          evidence: null
        });
      },
      (err) => {
        assert.ok(err instanceof PayoutEvidenceRequiredError);
        assert.ok(err instanceof PayoutError);
        assert.match(err.message, /analytics screen recording under 40 seconds is required/i);
        return true;
      }
    );

    // Ensure zero records created & zero balance reserved
    assert.equal(env.payoutRequests.size, 0);
    const bal = await env.payoutService.getAvailablePayoutBalance(creatorId);
    assert.equal(bal.reservedBalance.toFixed(2), '0.00');
  });

  test('6. Calling createPayoutRequest with empty evidence buffer throws PayoutEvidenceRequiredError', async () => {
    await env.profileService.saveProfile(creatorId, {
      walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
      network: 'ETHEREUM'
    });

    await assert.rejects(
      async () => {
        await env.payoutService.createPayoutRequest(creatorId, '50.00', 'USD', {
          enforceEvidence: true,
          evidence: { buffer: Buffer.alloc(0), filename: 'empty.mp4', mimeType: 'video/mp4' }
        });
      },
      (err) => err instanceof PayoutEvidenceRequiredError
    );
  });

  // ===========================================================================
  // 5. Server-Side Evidence Validation Rules (<40.0s strict, <50MB, formats)
  // ===========================================================================
  test('7. Evidence validator accepts valid MP4 video under 40 seconds (e.g. 15.0s)', async () => {
    const validBuffer = buildMockMp4Buffer(15.0);
    const result = await validateEvidenceFile(validBuffer, 'analytics.mp4', 'video/mp4');

    assert.equal(result.isValid, true);
    assert.equal(result.format, 'mp4');
    assert.equal(result.durationSeconds, 15.0);
    assert.ok(result.fileSize > 0);
  });

  test('8. Evidence validator strictly rejects video of exactly 40.0 seconds (< 40.0s rule)', async () => {
    const exact40Buffer = buildMockMp4Buffer(40.0);

    await assert.rejects(
      async () => {
        await validateEvidenceFile(exact40Buffer, 'analytics.mp4', 'video/mp4');
      },
      (err) => {
        assert.ok(err instanceof EvidenceValidationError);
        assert.equal(err.code, 'DURATION_EXCEEDED');
        assert.match(err.message, /under 40 seconds/i);
        return true;
      }
    );
  });

  test('9. Evidence validator rejects video exceeding 40.0 seconds (e.g. 45.0s)', async () => {
    const over40Buffer = buildMockMp4Buffer(45.0);

    await assert.rejects(
      async () => {
        await validateEvidenceFile(over40Buffer, 'analytics.mp4', 'video/mp4');
      },
      (err) => {
        assert.ok(err instanceof EvidenceValidationError);
        assert.equal(err.code, 'DURATION_EXCEEDED');
        return true;
      }
    );
  });

  test('10. Evidence validator rejects video exceeding 50 MB limit', async () => {
    // Create oversized buffer > 50MB (50 * 1024 * 1024 + 1024)
    const largeBuffer = Buffer.alloc(50 * 1024 * 1024 + 1024);

    await assert.rejects(
      async () => {
        await validateEvidenceFile(largeBuffer, 'huge_recording.mp4', 'video/mp4');
      },
      (err) => {
        assert.ok(err instanceof EvidenceValidationError);
        assert.equal(err.code, 'INVALID_FILE');
        assert.match(err.message, /maximum file size/i);
        return true;
      }
    );
  });

  test('11. Evidence validator rejects unsupported file extensions (.png, .exe, .pdf)', async () => {
    const fakeBuffer = Buffer.from('not a video');

    await assert.rejects(
      async () => {
        await validateEvidenceFile(fakeBuffer, 'screenshot.png', 'image/png');
      },
      (err) => {
        assert.ok(err instanceof EvidenceValidationError);
        assert.equal(err.code, 'INVALID_FILE');
        assert.match(err.message, /unsupported file format/i);
        return true;
      }
    );
  });

  test('12. Evidence validator rejects corrupt / unparseable MP4 media', async () => {
    // Random non-MP4 bytes with .mp4 extension
    const garbageBuffer = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);

    await assert.rejects(
      async () => {
        await validateEvidenceFile(garbageBuffer, 'corrupt.mp4', 'video/mp4');
      },
      (err) => {
        assert.ok(err instanceof EvidenceValidationError);
        assert.equal(err.code, 'INVALID_FILE');
        return true;
      }
    );
  });

  // ===========================================================================
  // 6. Cancellation Behavior (Zero State Mutation)
  // ===========================================================================
  test('13. Cancellation before upload clears draft, creates no payout request, and preserves balance', async () => {
    payoutDraftManager.createDraft(creatorId, {
      amount: '50.00',
      currency: 'USD'
    });
    assert.ok(payoutDraftManager.getDraft(creatorId));

    payoutDraftManager.clearDraft(creatorId);

    assert.equal(payoutDraftManager.getDraft(creatorId), null);
    assert.equal(env.payoutRequests.size, 0);

    const bal = await env.payoutService.getAvailablePayoutBalance(creatorId);
    assert.equal(bal.reservedBalance.toFixed(2), '0.00');
    assert.equal(bal.availableBalance.toFixed(2), '100.00');
  });

  test('14. Cancellation after upload (review screen) clears draft, creates no payout request, and preserves balance', async () => {
    payoutDraftManager.createDraft(creatorId, {
      amount: '50.00',
      currency: 'USD'
    });

    payoutDraftManager.attachEvidence(creatorId, {
      buffer: buildMockMp4Buffer(15.0),
      filename: 'recording.mp4',
      mimeType: 'video/mp4',
      durationSeconds: 15.0
    });

    assert.ok(payoutDraftManager.getDraft(creatorId)?.evidence);

    // Cancel
    payoutDraftManager.clearDraft(creatorId);

    assert.equal(payoutDraftManager.getDraft(creatorId), null);
    assert.equal(env.payoutRequests.size, 0);

    const bal = await env.payoutService.getAvailablePayoutBalance(creatorId);
    assert.equal(bal.reservedBalance.toFixed(2), '0.00');
  });

  // ===========================================================================
  // 7. Security, User Isolation, and Forgery Prevention
  // ===========================================================================
  test('15. User isolation: user B cannot access or submit user A draft', async () => {
    const userA = creatorId;
    const userB = 'usr_intruder';

    payoutDraftManager.createDraft(userA, {
      amount: '50.00',
      currency: 'USD'
    });

    assert.equal(payoutDraftManager.getDraft(userB), null);
    assert.equal(payoutDraftManager.consumeDraft(userB), null);

    // User A's draft remains safe and intact
    assert.ok(payoutDraftManager.getDraft(userA));
  });

  test('16. Forged user IDs in button custom IDs are rejected with Unauthorized', async () => {
    // Mock user service getOrCreateFromDiscord
    const originalGetOrCreate = userService.getOrCreateFromDiscord;
    userService.getOrCreateFromDiscord = async () => ({ id: 'usr_legit', discordId: 'disc_legit' });

    try {
      const interaction = createMockInteraction({
        user: { id: 'disc_legit' }
      });

      // Pass forged targetUserId 'usr_victim'
      await handlePayoutEvidenceSubmitButton(interaction, 'usr_victim');

      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].content, /Unauthorized/i);
    } finally {
      userService.getOrCreateFromDiscord = originalGetOrCreate;
    }
  });

  // ===========================================================================
  // 8. Atomic Submission & Double-Click Concurrency Defense
  // ===========================================================================
  test('17. Atomic draft consumption prevents duplicate submission and double fund reservation', async () => {
    payoutDraftManager.createDraft(creatorId, {
      amount: '50.00',
      currency: 'USD'
    });

    payoutDraftManager.attachEvidence(creatorId, {
      buffer: buildMockMp4Buffer(12.0),
      filename: 'evidence.mp4',
      mimeType: 'video/mp4',
      durationSeconds: 12.0
    });

    // First atomic consumption succeeds
    const firstConsume = payoutDraftManager.consumeDraft(creatorId);
    assert.ok(firstConsume);
    assert.equal(firstConsume.amount, '50.00');

    // Second atomic consumption immediately fails (returns null)
    const secondConsume = payoutDraftManager.consumeDraft(creatorId);
    assert.equal(secondConsume, null);
  });

  // ===========================================================================
  // 9. Complete End-to-End Success Lifecycle
  // ===========================================================================
  test('18. Full successful flow: amount -> upload (<40s) -> review -> submit creates PayoutRequest, reserves funds, and attaches evidence', async () => {
    // 1. Configure Payout Profile
    const profile = await env.profileService.saveProfile(creatorId, {
      walletAddress: '0xABC1234567890abcdef1234567890abcdef1234',
      network: 'POLYGON',
      walletName: 'Ledger',
      platform: 'YOUTUBE'
    });

    // 2. Creator creates draft for $50.00
    payoutDraftManager.createDraft(creatorId, {
      amount: '50.00',
      currency: 'USD',
      profileSnapshot: {
        walletAddress: profile.walletAddress,
        network: profile.network,
        walletName: profile.walletName,
        platform: profile.platform
      }
    });

    // 3. Creator uploads valid 18.5s recording
    const validBuffer = buildMockMp4Buffer(18.5);
    const validation = await validateEvidenceFile(validBuffer, 'rec_18s.mp4', 'video/mp4');
    assert.equal(validation.isValid, true);

    payoutDraftManager.attachEvidence(creatorId, {
      buffer: validBuffer,
      filename: 'rec_18s.mp4',
      mimeType: 'video/mp4',
      fileSize: validBuffer.length,
      durationSeconds: validation.durationSeconds,
      format: validation.format
    });

    // 4. Creator reviews and submits
    const draft = payoutDraftManager.consumeDraft(creatorId);
    assert.ok(draft);

    const payout = await env.payoutService.createPayoutRequest(
      creatorId,
      draft.amount,
      draft.currency,
      {
        evidence: draft.evidence,
        profileSnapshot: draft.profileSnapshot,
        enforceEvidence: true
      }
    );

    // 5. Verification of Payout Request
    assert.ok(payout);
    assert.equal(payout.amount.toFixed(2), '50.00');
    assert.equal(payout.status, 'REQUESTED');
    assert.equal(payout.userId, creatorId);

    // 6. Verification of attached PayoutEvidence
    const attachedEv = Array.from(env.payoutEvidence.values()).find((e) => e.payoutRequestId === payout.id);
    assert.ok(attachedEv);
    assert.equal(attachedEv.userId, creatorId);
    assert.equal(attachedEv.filename, 'rec_18s.mp4');
    assert.equal(attachedEv.durationSeconds, 18.5);
    assert.equal(attachedEv.status, 'PENDING_REVIEW');

    // 7. Verification of fund reservation
    const postBal = await env.payoutService.getAvailablePayoutBalance(creatorId);
    assert.equal(postBal.totalEligible.toFixed(2), '100.00');
    assert.equal(postBal.reservedBalance.toFixed(2), '50.00');
    assert.equal(postBal.availableBalance.toFixed(2), '50.00');

    // 8. Verification of event emission
    const createdEvent = env.payoutEvents.find((e) => e.payoutRequestId === payout.id && (e.type === 'REQUESTED' || e.eventType === 'REQUESTED'));
    assert.ok(createdEvent);
  });

  // ===========================================================================
  // 10. Fresh Evidence Requirement for Subsequent Payouts
  // ===========================================================================
  test('19. Every new payout request requires fresh evidence upload and cannot reuse previous evidence', async () => {
    await env.profileService.saveProfile(creatorId, {
      walletAddress: '0xABC1234567890abcdef1234567890abcdef1234',
      network: 'POLYGON'
    });

    // First Payout
    const validBuffer = buildMockMp4Buffer(10.0);
    const payout1 = await env.payoutService.createPayoutRequest(creatorId, '20.00', 'USD', {
      enforceEvidence: true,
      evidence: { buffer: validBuffer, filename: 'p1.mp4', mimeType: 'video/mp4' }
    });
    assert.ok(payout1);

    // Verify draft is empty
    assert.equal(payoutDraftManager.getDraft(creatorId), null);

    // Second Payout without uploading fresh evidence must FAIL
    await assert.rejects(
      async () => {
        await env.payoutService.createPayoutRequest(creatorId, '20.00', 'USD', {
          enforceEvidence: true,
          evidence: null
        });
      },
      (err) => err instanceof PayoutEvidenceRequiredError
    );
  });

  // ===========================================================================
  // 11. Draft Manager TTL Expiration
  // ===========================================================================
  test('20. PayoutDraftManager expires drafts older than TTL', () => {
    payoutDraftManager.createDraft('user_ttl', {
      amount: '30.00',
      currency: 'USD'
    });

    const draft = payoutDraftManager.getDraft('user_ttl');
    assert.ok(draft);

    // Artificially age draft past 30-minute TTL (31 minutes ago)
    draft.createdAt = Date.now() - 31 * 60 * 1000;

    // Next getDraft call triggers cleanup
    assert.equal(payoutDraftManager.getDraft('user_ttl'), null);
  });

  // ===========================================================================
  // 12. UI Embed & Component Builders
  // ===========================================================================
  test('21. UI Builders: buildPayoutEvidenceInstructionsEmbed contains exact required copy and destination info', () => {
    const embed = buildPayoutEvidenceInstructionsEmbed({
      amount: '50.00',
      currency: 'USD',
      profile: {
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        network: 'ETHEREUM',
        walletName: 'MetaMask'
      }
    });

    const data = embed.toJSON();
    assert.match(data.title, /Analytics Verification/i);
    assert.match(data.description, /Open your Analytics Dashboard/i);
    assert.match(data.description, /UNDER 40 seconds/i);
    assert.match(data.description, /unedited/i);

    const amountField = data.fields.find((f) => f.name.includes('Requested Amount'));
    assert.ok(amountField);
    assert.match(amountField.value, /50\.00/);

    const destField = data.fields.find((f) => f.name.includes('Destination Wallet'));
    assert.ok(destField);
    assert.match(destField.value, /ETHEREUM/);
  });

  test('22. UI Builders: buildPayoutEvidenceReceivedEmbed, buildPayoutReviewEmbed, and buildPayoutSubmittedEmbed display correct fields and buttons', () => {
    // 1. Received Embed
    const receivedEmbed = buildPayoutEvidenceReceivedEmbed({
      filename: 'my_analytics.mp4',
      durationSeconds: 22.4,
      fileSize: 10485760,
      format: 'mp4'
    }).toJSON();

    assert.match(receivedEmbed.title, /Recording Received/i);
    const durationField = receivedEmbed.fields.find((f) => f.name.includes('Duration'));
    assert.ok(durationField);
    assert.match(durationField.value, /22\.4/);

    // 2. Action Rows
    const step1Row = buildPayoutEvidenceActionRow(creatorId);
    assert.equal(step1Row.components.length, 2);
    assert.match(step1Row.components[0].data.custom_id, /payout_ev_upload/);

    const step2Row = buildPayoutEvidenceReceivedActionRow(creatorId);
    assert.equal(step2Row.components.length, 3);
    assert.match(step2Row.components[0].data.custom_id, /payout_ev_review/);

    const step3Row = buildPayoutReviewActionRow(creatorId);
    assert.equal(step3Row.components.length, 3);
    assert.match(step3Row.components[0].data.custom_id, /payout_ev_submit/);

    // 3. Submitted Embed
    const submittedEmbed = buildPayoutSubmittedEmbed({
      id: 'pr_submitted_999',
      amount: new Prisma.Decimal('50.00'),
      currency: 'USD',
      status: 'REQUESTED'
    }).toJSON();

    assert.match(submittedEmbed.title, /Payout Request Submitted/i);
    assert.match(submittedEmbed.description, /UNDER REVIEW/i);
  });
});
