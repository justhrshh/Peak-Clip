import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  PayoutProfileService,
  PayoutProfileError,
  maskWalletAddress
} from '../src/modules/payout-profile/payout-profile.service.js';
import { LocalStorageAdapter, StorageService } from '../src/modules/storage/storage.service.js';
import {
  validateEvidenceFile,
  extractMp4Duration,
  buildMockMp4Buffer
} from '../src/modules/evidence/evidence.validator.js';
import { EvidenceService } from '../src/modules/evidence/evidence.service.js';
import {
  STRUCTURED_EVIDENCE_REJECTION_REASONS,
  CREATOR_SAFE_EVIDENCE_LABELS,
  EVIDENCE_STATUS,
  PLATFORM_EVIDENCE_REQUIREMENTS
} from '../src/modules/evidence/evidence.constants.js';
import { PayoutService } from '../src/modules/payouts/payout.service.js';
import { AdminPayoutService } from '../src/modules/admin/admin.payout.service.js';
import {
  buildUserPayoutEmbed,
  buildPayoutProfileEmbed,
  buildEvidenceInstructionsEmbed
} from '../src/bot/embeds/payout.embeds.js';
import {
  buildPayoutActionRow,
  buildPayoutProfileModal,
  buildPayoutProfileSavedActionRow
} from '../src/bot/components/payout.components.js';

// =============================================================================
// MOCK ENVIRONMENT FACTORY FOR PHASE 10E
// =============================================================================
function createMockPhase10EEnvironment() {
  const users = new Map();
  const payoutProfiles = new Map();
  const payoutProfileAudits = [];
  const payoutEvidence = new Map();
  const payoutRequests = new Map();
  const disbursements = new Map();
  const payoutEvents = [];
  const adminAudits = [];
  const earnings = new Map();
  const storageFiles = new Map();

  let evidenceCounter = 1;
  let payoutCounter = 1;
  let disCounter = 1;

  // Mock Storage Adapter (In-Memory)
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

  const mockStorageService = new StorageService(mockStorageAdapter);

  // Mock Prisma client for PayoutProfile
  const mockPrisma = {
    payoutProfile: {
      async findUnique({ where }) {
        if (where.userId) {
          return payoutProfiles.get(where.userId) || null;
        }
        if (where.id) {
          return Array.from(payoutProfiles.values()).find((p) => p.id === where.id) || null;
        }
        return null;
      },
      async create({ data }) {
        const id = `prof_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const record = {
          id,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        payoutProfiles.set(data.userId, record);
        return record;
      },
      async update({ where, data }) {
        const existing = payoutProfiles.get(where.userId);
        if (!existing) throw new Error('Record not found');
        const updated = {
          ...existing,
          ...data,
          updatedAt: new Date()
        };
        payoutProfiles.set(where.userId, updated);
        return updated;
      }
    },
    payoutProfileAudit: {
      async create({ data }) {
        const record = { id: `audit_${payoutProfileAudits.length + 1}`, ...data, createdAt: new Date() };
        payoutProfileAudits.push(record);
        return record;
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
        if (where?.payoutRequestId) {
          list = list.filter((e) => e.payoutRequestId === where.payoutRequestId);
        }
        if (where?.userId) {
          list = list.filter((e) => e.userId === where.userId);
        }
        if (orderBy?.version === 'desc') {
          list.sort((a, b) => b.version - a.version);
        } else if (orderBy?.version === 'asc') {
          list.sort((a, b) => a.version - b.version);
        }
        return list;
      },
      async findFirst({ where, orderBy }) {
        const list = await this.findMany({ where, orderBy });
        return list[0] || null;
      },
      async update({ where, data }) {
        const ev = payoutEvidence.get(where.id);
        if (!ev) throw new Error('Evidence not found');
        const updated = { ...ev, ...data, updatedAt: new Date() };
        payoutEvidence.set(where.id, updated);
        return updated;
      }
    }
  };

  const profileService = new PayoutProfileService(mockPrisma);
  const evidenceService = new EvidenceService(mockPrisma, mockStorageService);

  // Mock Payout Repository
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
      const prDis = Array.from(disbursements.values())
        .filter((d) => d.payoutRequestId === id);
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
    },

    async createDisbursement(data) {
      const id = `dis_${disCounter++}`;
      const record = { id, ...data, createdAt: new Date() };
      disbursements.set(id, record);
      return record;
    },

    async updateDisbursement(id, data) {
      const dis = disbursements.get(id);
      if (!dis) throw new Error('Disbursement not found');
      const updated = { ...dis, ...data, updatedAt: new Date() };
      disbursements.set(id, updated);
      return updated;
    }
  };

  const payoutService = new PayoutService(mockPayoutRepo, undefined, null, profileService, evidenceService);

  const mockAdminAuditService = {
    async logAction(data) {
      adminAudits.push({ id: `adm_${adminAudits.length + 1}`, ...data, createdAt: new Date() });
    }
  };

  const adminPayoutService = new AdminPayoutService(payoutService, mockAdminAuditService, evidenceService);

  return {
    users,
    earnings,
    payoutProfiles,
    payoutProfileAudits,
    payoutEvidence,
    payoutRequests,
    disbursements,
    payoutEvents,
    adminAudits,
    storageFiles,
    mockStorageService,
    profileService,
    evidenceService,
    payoutService,
    adminPayoutService
  };
}

// =============================================================================
// TEST SUITES
// =============================================================================
describe('Phase 10E — Payout Profile System', () => {
  test('creates a valid creator payout profile and masks wallet address for display', async () => {
    const env = createMockPhase10EEnvironment();
    const actor = { userId: 'u_creator_1', discordId: 'discord_c1' };

    const profile = await env.profileService.createProfile(
      'u_creator_1',
      {
        walletAddress: '0x71C834567890abcdef1234567890abcdef123456',
        network: 'Polygon',
        walletName: 'MetaMask',
        creatorHandle: '@peakclips',
        platform: 'YOUTUBE'
      },
      actor
    );

    assert.equal(profile.userId, 'u_creator_1');
    assert.equal(profile.network, 'POLYGON');
    assert.equal(profile.walletName, 'MetaMask');
    assert.equal(profile.platform, 'YOUTUBE');

    // Verify masking helper produces expected format
    const masked = maskWalletAddress(profile.walletAddress);
    assert.equal(masked, '0x71C8••••••••••3456');
    assert.equal(masked.includes('7890abcdef'), false); // Raw middle digits masked

    // Verify audit record was created without storing raw full wallet address
    assert.equal(env.payoutProfileAudits.length, 1);
    const audit = env.payoutProfileAudits[0];
    assert.equal(audit.action, 'CREATE');
    assert.equal(audit.actorDiscordId, 'discord_c1');
    assert.equal(audit.walletAddressChanged, true);
    assert.equal(audit.metadata.maskedAddress, '0x71C8••••••••••3456');
    assert.equal(JSON.stringify(audit).includes('7890abcdef'), false); // Zero raw address leakage in audit
  });

  test('prevents creating duplicate profile for the same creator', async () => {
    const env = createMockPhase10EEnvironment();
    const actor = { userId: 'u_creator_2', discordId: 'discord_c2' };

    await env.profileService.createProfile(
      'u_creator_2',
      {
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        network: 'Ethereum',
        creatorHandle: '@streamer',
        platform: 'TIKTOK'
      },
      actor
    );

    await assert.rejects(
      () =>
        env.profileService.createProfile(
          'u_creator_2',
          {
            walletAddress: '0x9999999990abcdef1234567890abcdef12345678',
            network: 'Solana',
            creatorHandle: '@streamer',
            platform: 'TIKTOK'
          },
          actor
        ),
      (err) => {
        assert.ok(err instanceof PayoutProfileError);
        assert.equal(err.code, 'PROFILE_ALREADY_EXISTS');
        return true;
      }
    );
  });

  test('updates an existing payout profile and records audit trail', async () => {
    const env = createMockPhase10EEnvironment();
    const actor = { userId: 'u_creator_3', discordId: 'discord_c3' };

    await env.profileService.createProfile(
      'u_creator_3',
      {
        walletAddress: '0x1111111111111111111111111111111111111111',
        network: 'Ethereum',
        creatorHandle: '@original',
        platform: 'INSTAGRAM'
      },
      actor
    );

    const updated = await env.profileService.updateProfile(
      'u_creator_3',
      {
        walletAddress: '0x2222222222222222222222222222222222222222',
        network: 'Polygon',
        walletName: 'Ledger',
        creatorHandle: '@updated',
        platform: 'INSTAGRAM'
      },
      actor
    );

    assert.equal(updated.network, 'POLYGON');
    assert.equal(updated.walletName, 'Ledger');
    assert.equal(updated.creatorHandle, '@updated');

    assert.equal(env.payoutProfileAudits.length, 2);
    const updateAudit = env.payoutProfileAudits[1];
    assert.equal(updateAudit.action, 'UPDATE');
    assert.equal(updateAudit.walletAddressChanged, true);
    assert.equal(updateAudit.newNetwork, 'POLYGON');
    assert.equal(updateAudit.metadata.maskedAddress, '0x2222••••••••••2222');
  });

  test('validates required fields and platform constraints', () => {
    const env = createMockPhase10EEnvironment();

    // Missing wallet address
    assert.throws(
      () =>
        env.profileService.validateProfileData({
          walletAddress: '',
          network: 'Ethereum',
          creatorHandle: '@test',
          platform: 'YOUTUBE'
        }),
      (err) => err.code === 'INVALID_WALLET'
    );

    // Unsupported platform
    assert.throws(
      () =>
        env.profileService.validateProfileData({
          walletAddress: '0x1234567890abcdef',
          network: 'Ethereum',
          creatorHandle: '@test',
          platform: 'TWITCH'
        }),
      (err) => err.code === 'INVALID_PLATFORM'
    );
  });
});

describe('Phase 10E — Storage Abstraction & File Validation', () => {
  test('LocalStorageAdapter stores, verifies, and retrieves files securely', async () => {
    const testDir = path.resolve('storage/test_evidence_' + Date.now());
    const adapter = new LocalStorageAdapter(testDir);
    const storageService = new StorageService(adapter);

    const testContent = Buffer.from('mock video content payload');
    const filename = 'test_clip_1.mp4';

    const saved = await storageService.saveFile({
      buffer: testContent,
      filename,
      mimeType: 'video/mp4'
    });

    const meta = await storageService.getFileMetadata(saved.storageKey);
    assert.equal(meta.exists, true);

    const retrieved = await storageService.getFileBuffer(saved.storageKey);
    assert.equal(retrieved.toString(), testContent.toString());

    // Clean up test directory
    await storageService.deleteFile(saved.storageKey);
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  test('LocalStorageAdapter rejects path traversal attacks', () => {
    const adapter = new LocalStorageAdapter('storage/evidence');
    assert.throws(
      () => adapter._resolvePath('../../../etc/passwd'),
      /Security Violation/
    );
  });

  test('file validator enforces MIME types, size limits, and non-empty content', () => {
    // Empty buffer
    assert.throws(
      () => validateEvidenceFile({ buffer: Buffer.alloc(0), mimeType: 'video/mp4' }),
      (err) => err.code === 'INVALID_FILE'
    );

    // Non-video MIME type
    assert.throws(
      () => validateEvidenceFile({ buffer: Buffer.from('dummy data'), mimeType: 'image/png' }),
      (err) => err.code === 'INVALID_FILE'
    );

    // Size limit exceeded (>50MB)
    const largeBuffer = Buffer.alloc(51 * 1024 * 1024); // 51MB
    assert.throws(
      () => validateEvidenceFile({ buffer: largeBuffer, mimeType: 'video/mp4' }),
      (err) => err.code === 'INVALID_FILE'
    );
  });

  test('file validator enforces strict <40.0s duration limit from MP4 box telemetry', () => {
    // 1. Valid MP4 with 25.5s duration
    const validMp4 = buildMockMp4Buffer(1000, 25500); // 25.5s
    const resValid = validateEvidenceFile({ buffer: validMp4, mimeType: 'video/mp4' });
    assert.equal(resValid.isValid, true);
    assert.equal(resValid.durationSeconds, 25.5);

    // 2. Exactly 40.0s (violates strictly < 40.0s requirement)
    const exactMp4 = buildMockMp4Buffer(1000, 40000); // 40.0s
    assert.throws(
      () => validateEvidenceFile({ buffer: exactMp4, mimeType: 'video/mp4' }),
      (err) => {
        assert.equal(err.code, 'DURATION_EXCEEDED');
        assert.ok(err.message.includes('40 seconds'));
        return true;
      }
    );

    // 3. 42.5s (exceeds duration)
    const longMp4 = buildMockMp4Buffer(1000, 42500); // 42.5s
    assert.throws(
      () => validateEvidenceFile({ buffer: longMp4, mimeType: 'video/mp4' }),
      (err) => err.code === 'DURATION_EXCEEDED'
    );
  });

  test('structured rejection reasons have complete creator-safe labels', () => {
    for (const reason of Object.values(STRUCTURED_EVIDENCE_REJECTION_REASONS)) {
      assert.ok(CREATOR_SAFE_EVIDENCE_LABELS[reason], `Missing safe label for ${reason}`);
    }
  });
});

describe('Phase 10E — Evidence Service & Versioned Immutability', () => {
  test('attaching evidence creates version 1; replacing increments version and preserves previous version', async () => {
    const env = createMockPhase10EEnvironment();
    const mp4_v1 = buildMockMp4Buffer(1000, 15000); // 15s

    // Attach v1
    const ev1 = await env.evidenceService.attachEvidence({
      payoutRequestId: 'pr_test_1',
      userId: 'u_creator_4',
      platform: 'YOUTUBE',
      buffer: mp4_v1,
      filename: 'evidence_screen_rec_v1.mp4',
      mimeType: 'video/mp4'
    });

    assert.equal(ev1.version, 1);
    assert.equal(ev1.status, EVIDENCE_STATUS.PENDING_REVIEW);
    assert.equal(ev1.durationSeconds, 15);

    // Replace with v2
    const mp4_v2 = buildMockMp4Buffer(1000, 22000); // 22s
    const ev2 = await env.evidenceService.replaceEvidence('pr_test_1', {
      userId: 'u_creator_4',
      platform: 'YOUTUBE',
      buffer: mp4_v2,
      filename: 'evidence_screen_rec_v2.mp4',
      mimeType: 'video/mp4'
    });

    assert.equal(ev2.version, 2);
    assert.equal(ev2.status, EVIDENCE_STATUS.PENDING_REVIEW);
    assert.equal(ev2.durationSeconds, 22);

    // Verify both versions are preserved and latest returns v2
    const allEvidence = await env.evidenceService.getEvidenceForPayout('pr_test_1');
    assert.equal(allEvidence.length, 2);
    assert.equal(allEvidence[0].version, 1);
    assert.equal(allEvidence[1].version, 2);

    const latest = await env.evidenceService.getLatestEvidence('pr_test_1');
    assert.equal(latest.id, ev2.id);
    assert.equal(latest.version, 2);
  });
});

describe('Phase 10E — Payout Profile Snapshotting & Approval Gate', () => {
  test('creating payout snapshots active profile; modifying profile afterward does not affect snapshot', async () => {
    const env = createMockPhase10EEnvironment();
    const actor = { userId: 'u_snap_creator', discordId: 'd_snap' };

    env.users.set('u_snap_creator', { id: 'u_snap_creator', status: 'ACTIVE' });
    env.earnings.set('earn_1', {
      id: 'earn_1',
      userId: 'u_snap_creator',
      grossAmount: new Prisma.Decimal('100.00'),
      currency: 'USD',
      status: 'ELIGIBLE'
    });

    // 1. Create profile
    await env.profileService.createProfile(
      'u_snap_creator',
      {
        walletAddress: '0xORIGINAL_WALLET_ADDRESS_1234567890',
        network: 'Ethereum',
        walletName: 'MetaMask',
        creatorHandle: '@original_handle',
        platform: 'YOUTUBE'
      },
      actor
    );

    // 2. Request Payout
    const mp4 = buildMockMp4Buffer(1000, 18000); // 18s
    const payout = await env.payoutService.createPayoutRequest(
      'u_snap_creator',
      '50.00',
      'USD',
      {
        enforceProfile: true,
        evidence: {
          buffer: mp4,
          filename: 'analytics_rec.mp4',
          mimeType: 'video/mp4'
        }
      }
    );

    assert.ok(payout.profileSnapshot);
    assert.equal(payout.profileSnapshot.walletAddress, '0xORIGINAL_WALLET_ADDRESS_1234567890');
    assert.equal(payout.profileSnapshot.network, 'ETHEREUM');
    assert.equal(payout.profileSnapshot.creatorHandle, '@original_handle');

    // 3. Creator updates profile afterward (e.g. changes to Polygon / new wallet)
    await env.profileService.updateProfile(
      'u_snap_creator',
      {
        walletAddress: '0xNEW_POLYGON_ADDRESS_999999999999',
        network: 'Polygon',
        walletName: 'Phantom',
        creatorHandle: '@new_handle',
        platform: 'TIKTOK'
      },
      actor
    );

    // 4. Verify existing payout request still retains exact original snapshot
    const fetchedPayout = await env.payoutService.repo.getPayoutRequestById(payout.id);
    assert.equal(fetchedPayout.profileSnapshot.walletAddress, '0xORIGINAL_WALLET_ADDRESS_1234567890');
    assert.equal(fetchedPayout.profileSnapshot.network, 'ETHEREUM');
    assert.equal(fetchedPayout.profileSnapshot.creatorHandle, '@original_handle');
  });

  test('Approval Gate: blocks disbursement processing if evidence is missing, unreviewed, or rejected', async () => {
    const env = createMockPhase10EEnvironment();
    const actor = { userId: 'u_gate_creator', discordId: 'd_gate' };

    env.users.set('u_gate_creator', { id: 'u_gate_creator', status: 'ACTIVE' });
    env.earnings.set('earn_gate', {
      id: 'earn_gate',
      userId: 'u_gate_creator',
      grossAmount: new Prisma.Decimal('150.00'),
      currency: 'USD',
      status: 'ELIGIBLE'
    });

    await env.profileService.createProfile(
      'u_gate_creator',
      {
        walletAddress: '0xGATE_WALLET_1234567890abcdef',
        network: 'Solana',
        creatorHandle: '@gate_creator',
        platform: 'YOUTUBE'
      },
      actor
    );

    const mp4 = buildMockMp4Buffer(1000, 20000);
    const payout = await env.payoutService.createPayoutRequest(
      'u_gate_creator',
      '60.00',
      'USD',
      {
        enforceProfile: true,
        evidence: {
          buffer: mp4,
          filename: 'gate_analytics.mp4',
          mimeType: 'video/mp4'
        }
      }
    );

    const evidenceList = await env.evidenceService.getEvidenceForPayout(payout.id);
    const evidence = evidenceList[0];
    assert.equal(evidence.status, 'PENDING_REVIEW');

    // Transition payout to APPROVED so status transition to PROCESSING is valid
    await env.payoutService.reviewPayoutRequest(payout.id, 'admin_1');
    await env.payoutService.approvePayoutRequest(payout.id, 'admin_1');

    // 1. Attempt disbursement while evidence is PENDING_REVIEW -> MUST FAIL
    await assert.rejects(
      () => env.payoutService.processDisbursement(payout.id, 'MANUAL', { enforceGate: true }),
      /Staff must accept evidence before disbursement/
    );

    // 2. Staff rejects evidence -> MUST FAIL
    await env.adminPayoutService.rejectEvidence(evidence.id, { discordId: 'staff_1', userId: 'staff_1' }, {
      structuredReason: 'TELEMETRY_MISMATCH',
      notes: 'Views on screen do not match reported views'
    });

    await assert.rejects(
      () => env.payoutService.processDisbursement(payout.id, 'MANUAL', { enforceGate: true }),
      /attached evidence is in 'REJECTED' status/
    );

    // 3. Creator uploads replacement evidence v2
    const mp4_v2 = buildMockMp4Buffer(1000, 24000);
    const ev2 = await env.evidenceService.replaceEvidence(payout.id, {
      userId: 'u_gate_creator',
      platform: 'YOUTUBE',
      buffer: mp4_v2,
      filename: 'gate_analytics_v2.mp4',
      mimeType: 'video/mp4'
    });

    // 4. Staff accepts evidence v2
    await env.adminPayoutService.acceptEvidence(ev2.id, { discordId: 'staff_1', userId: 'staff_1' });

    // 5. Disbursement processing now proceeds successfully through the gate!
    const disburseResult = await env.payoutService.processDisbursement(payout.id, 'MANUAL', { enforceGate: true });
    assert.equal(disburseResult.payoutRequest.status, 'PROCESSING');
    assert.ok(disburseResult.disbursement.id);
  });
});

describe('Phase 10E — Phase 10C Cancellation Compatibility & Ledger Invariants', () => {
  test('cancelling a payout with evidence and profile snapshot releases reservation and preserves records', async () => {
    const env = createMockPhase10EEnvironment();
    const actor = { userId: 'u_cancel_test', discordId: 'd_cancel' };

    env.users.set('u_cancel_test', { id: 'u_cancel_test', status: 'ACTIVE' });
    env.earnings.set('e_c1', {
      id: 'e_c1',
      userId: 'u_cancel_test',
      grossAmount: new Prisma.Decimal('100.00'),
      currency: 'USD',
      status: 'ELIGIBLE'
    });

    await env.profileService.createProfile(
      'u_cancel_test',
      {
        walletAddress: '0xCANCEL_TEST_WALLET_12345678',
        network: 'Polygon',
        creatorHandle: '@canceller',
        platform: 'YOUTUBE'
      },
      actor
    );

    const mp4 = buildMockMp4Buffer(1000, 12000);
    const payout = await env.payoutService.createPayoutRequest(
      'u_cancel_test',
      '40.00',
      'USD',
      {
        enforceProfile: true,
        evidence: {
          buffer: mp4,
          filename: 'screen_rec.mp4',
          mimeType: 'video/mp4'
        }
      }
    );

    // Initial check: $40 is reserved, $60 available
    let bal = await env.payoutService.getAvailablePayoutBalance('u_cancel_test');
    assert.equal(bal.reservedBalance.toFixed(2), '40.00');
    assert.equal(bal.availableBalance.toFixed(2), '60.00');

    // Creator cancels payout
    const cancelled = await env.payoutService.cancelPayoutRequest(
      'u_cancel_test',
      payout.id,
      'Changed mind, want to earn more before cashing out'
    );

    assert.equal(cancelled.status, 'CANCELLED');

    // Reservation released: $0 reserved, $100 available again!
    bal = await env.payoutService.getAvailablePayoutBalance('u_cancel_test');
    assert.equal(bal.reservedBalance.toFixed(2), '0.00');
    assert.equal(bal.availableBalance.toFixed(2), '100.00');

    // Profile snapshot and evidence records remain intact and immutable
    const postCancelPayout = await env.payoutService.repo.getPayoutRequestById(payout.id);
    assert.ok(postCancelPayout.profileSnapshot);
    assert.equal(postCancelPayout.profileSnapshot.walletAddress, '0xCANCEL_TEST_WALLET_12345678');
    assert.equal(postCancelPayout.evidence.length, 1);
    assert.equal(postCancelPayout.evidence[0].filename, 'screen_rec.mp4');
  });
});

describe('Phase 10E — Discord UI & Embed Formatting', () => {
  test('renders user dashboard embed with masked profile and evidence requirement notice', () => {
    const balance = {
      availableBalance: new Prisma.Decimal('120.00'),
      reservedBalance: new Prisma.Decimal('0.00'),
      completedPayouts: new Prisma.Decimal('50.00'),
      minimumPayout: new Prisma.Decimal('10.00'),
      currency: 'USD'
    };
    const profile = {
      walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
      network: 'Polygon',
      walletName: 'MetaMask',
      creatorHandle: '@coolclips',
      platform: 'YOUTUBE'
    };

    const embed = buildUserPayoutEmbed(balance, [], { id: 'd_creator' }, profile);
    assert.ok(embed.data.title.includes('Payout Dashboard'));

    const profField = embed.data.fields.find((f) => f.name.includes('Payout Profile'));
    assert.ok(profField);
    assert.ok(profField.value.includes('0x1234••••••••••5678')); // Masked
    assert.ok(profField.value.includes('Polygon'));
    assert.ok(profField.value.includes('@coolclips'));

    const evNotice = embed.data.fields.find((f) => f.name.includes('Evidence Requirement'));
    assert.ok(evNotice);
    assert.ok(evNotice.value.includes('<40s'));
  });

  test('renders payout profile embed with masked address and metadata', () => {
    const profile = {
      walletAddress: '0x99887766554433221100aabbccddeeff00112233',
      network: 'Solana',
      walletName: 'Phantom',
      creatorHandle: '@solanacreator',
      platform: 'TIKTOK',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const embed = buildPayoutProfileEmbed(profile, { id: 'd_solana' });
    assert.ok(embed.data.title.includes('Creator Payout Profile'));

    const walletField = embed.data.fields.find((f) => f.name.includes('Public Wallet Address'));
    assert.ok(walletField.value.includes('0x9988••••••••••2233'));
  });

  test('renders platform evidence instructions embed', () => {
    const embed = buildEvidenceInstructionsEmbed('YOUTUBE');
    assert.ok(embed.data.title.includes('Screen Recording Guidance — YOUTUBE'));
    const durField = embed.data.fields.find((f) => f.name.includes('Duration Limit'));
    assert.ok(durField.value.includes('40 seconds'));
  });

  test('buildPayoutActionRow includes Payout Profile button and handles profile state', () => {
    const rowWithoutProfile = buildPayoutActionRow('u1', true, null, false);
    const profBtn1 = rowWithoutProfile.components.find((c) => c.data.custom_id.startsWith('payout_profile_btn'));
    assert.ok(profBtn1);
    assert.equal(profBtn1.data.label, 'Set Up Profile');

    const rowWithProfile = buildPayoutActionRow('u1', true, null, true);
    const profBtn2 = rowWithProfile.components.find((c) => c.data.custom_id.startsWith('payout_profile_btn'));
    assert.ok(profBtn2);
    assert.equal(profBtn2.data.label, 'Payout Profile');
  });

  test('buildPayoutProfileModal builds modal with 3 wallet input fields', () => {
    const modal = buildPayoutProfileModal('u1');
    assert.equal(modal.data.custom_id, 'payout_profile_modal:u1');
    assert.equal(modal.components.length, 3);
  });

  test('buildPayoutProfileSavedActionRow builds progression buttons (Request Payout, Payout Hub, Dashboard, Edit Profile)', () => {
    const row = buildPayoutProfileSavedActionRow('u1');
    assert.equal(row.components.length, 4);
    const customIds = row.components.map((c) => c.data.custom_id);
    assert.ok(customIds.includes('payout_request_btn:u1'), 'Includes Request Payout button');
    assert.ok(customIds.includes('dash_payout:u1'), 'Includes Payout Hub button');
    assert.ok(customIds.includes('dash_home:u1'), 'Includes Dashboard button');
    assert.ok(customIds.includes('payout_profile_btn:u1'), 'Includes Edit Profile button');
  });
});

