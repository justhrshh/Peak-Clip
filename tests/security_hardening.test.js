import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import {
  AdminRole,
  AdminPermission,
  resolveAdminRoles,
  hasPermission,
  assertAdminPermission
} from '../src/modules/admin/admin.auth.js';
import {
  UnauthorizedAdminActionError,
  InsufficientPermissionError
} from '../src/modules/admin/admin.errors.js';
import {
  validateEvidenceFile,
  extractMp4Duration,
  buildMockMp4Buffer,
  EvidenceValidationError
} from '../src/modules/evidence/evidence.validator.js';
import { LocalStorageAdapter } from '../src/modules/storage/storage.service.js';
import {
  maskWalletAddress,
  PayoutProfileService,
  PayoutProfileError
} from '../src/modules/payout-profile/payout-profile.service.js';
import {
  handlePayoutCancelConfirm,
  handlePayoutCancelKeep
} from '../src/bot/interactions/payout.interactions.js';
import { handleStatsOverview } from '../src/bot/interactions/statistics.interactions.js';
import {
  buildUserOverviewEmbed,
  buildSubmissionStatisticsEmbed,
  buildStatsClipListEmbed
} from '../src/bot/embeds/statistics.embeds.js';
import { toCreatorSafeStatus } from '../src/modules/statistics/statistics.service.js';

describe('Phase 10G Security Hardening — Attack & Verification Suite', () => {

  // =========================================================================
  // SECTION 1 & 2: Administrative Role Enforcement & Privilege Isolation
  // =========================================================================
  describe('Admin Role Authorization & Privilege Boundaries', () => {
    const customConfig = {
      adminRoleIds: ['role_admin_guild'],
      campaignManagerRoleIds: ['role_cm_guild']
    };

    test('CampaignManager is granted CAMPAIGN_CREATE, CAMPAIGN_EDIT, SUBMISSION_VIEW, SUBMISSION_REVIEW', () => {
      const cmInteraction = {
        member: {
          permissions: 0n,
          roles: ['role_cm_guild']
        }
      };

      const roles = resolveAdminRoles(cmInteraction, customConfig);
      assert.deepEqual(roles, [AdminRole.CAMPAIGN_MANAGER]);

      assert.doesNotThrow(() => assertAdminPermission(cmInteraction, AdminPermission.CAMPAIGN_CREATE, customConfig));
      assert.doesNotThrow(() => assertAdminPermission(cmInteraction, AdminPermission.CAMPAIGN_EDIT, customConfig));
      assert.doesNotThrow(() => assertAdminPermission(cmInteraction, AdminPermission.SUBMISSION_VIEW, customConfig));
      assert.doesNotThrow(() => assertAdminPermission(cmInteraction, AdminPermission.SUBMISSION_REVIEW, customConfig));
      assert.doesNotThrow(() => assertAdminPermission(cmInteraction, AdminPermission.CREATOR_VIEW, customConfig));
    });

    test('CampaignManager is STRICTLY PROHIBITED from financial actions (PAYOUT_APPROVE, PAYOUT_REJECT, PAYOUT_PROCESS)', () => {
      const cmInteraction = {
        member: {
          permissions: 0n,
          roles: ['role_cm_guild']
        }
      };

      assert.throws(
        () => assertAdminPermission(cmInteraction, AdminPermission.PAYOUT_APPROVE, customConfig),
        (err) => {
          assert.ok(err instanceof InsufficientPermissionError);
          assert.equal(err.name, 'InsufficientPermissionError');
          return true;
        }
      );

      assert.throws(
        () => assertAdminPermission(cmInteraction, AdminPermission.PAYOUT_REJECT, customConfig),
        (err) => {
          assert.ok(err instanceof InsufficientPermissionError);
          assert.equal(err.name, 'InsufficientPermissionError');
          return true;
        }
      );

      assert.throws(
        () => assertAdminPermission(cmInteraction, AdminPermission.PAYOUT_PROCESS, customConfig),
        (err) => {
          assert.ok(err instanceof InsufficientPermissionError);
          assert.equal(err.name, 'InsufficientPermissionError');
          return true;
        }
      );
    });

    test('Regular creator without staff roles is denied all administrative actions', () => {
      const creatorInteraction = {
        member: {
          permissions: 0n,
          roles: ['role_creator_guild']
        }
      };

      assert.throws(
        () => assertAdminPermission(creatorInteraction, AdminPermission.CAMPAIGN_CREATE, customConfig),
        (err) => {
          assert.ok(err instanceof UnauthorizedAdminActionError);
          assert.equal(err.name, 'UnauthorizedAdminActionError');
          return true;
        }
      );

      assert.throws(
        () => assertAdminPermission(creatorInteraction, AdminPermission.SUBMISSION_REVIEW, customConfig),
        (err) => {
          assert.ok(err instanceof UnauthorizedAdminActionError);
          assert.equal(err.name, 'UnauthorizedAdminActionError');
          return true;
        }
      );
    });
  });

  // =========================================================================
  // SECTION 6: Discord Component Custom ID Tampering Attacks
  // =========================================================================
  describe('Discord Custom ID Tampering Attacks', () => {
    test('payout_cancel_confirm: rejects when caller is not the target user', async () => {
      let replyCalledWith = null;
      const fakeInteraction = {
        user: { id: 'attacker_discord_id', username: 'Attacker' },
        reply: async (payload) => {
          replyCalledWith = payload;
        },
        update: async () => {
          throw new Error('Should not update');
        }
      };

      // Target is victim_user_id, but interaction user resolves to attacker_user_id
      const victimUserId = 'victim_user_uuid';
      const payoutId = 'payout_123';

      await handlePayoutCancelConfirm(fakeInteraction, victimUserId, payoutId);

      assert.ok(replyCalledWith, 'Expected interaction.reply to be called');
      // Accept either legacy ephemeral:true or modern flags:MessageFlags.Ephemeral (64)
      const isEphemeral = replyCalledWith.ephemeral === true || (replyCalledWith.flags & 64) !== 0;
      assert.ok(isEphemeral, 'Reply must be ephemeral');
      assert.match(replyCalledWith.content, /only cancel your own payout requests/i);
    });

    test('payout_cancel_keep: rejects when caller is not the target user', async () => {
      let replyCalledWith = null;
      const fakeInteraction = {
        user: { id: 'attacker_discord_id', username: 'Attacker' },
        reply: async (payload) => {
          replyCalledWith = payload;
        },
        update: async () => {
          throw new Error('Should not update');
        }
      };

      const victimUserId = 'victim_user_uuid';
      const payoutId = 'payout_123';

      await handlePayoutCancelKeep(fakeInteraction, victimUserId, payoutId);

      assert.ok(replyCalledWith, 'Expected interaction.reply to be called');
      const isEphemeral = replyCalledWith.ephemeral === true || (replyCalledWith.flags & 64) !== 0;
      assert.ok(isEphemeral, 'Reply must be ephemeral');
      assert.match(replyCalledWith.content, /Unauthorized/i);
    });

    test('stats_overview: rejects navigation when caller is not the target user', async () => {
      let followUpCalledWith = null;
      const fakeInteraction = {
        user: { id: 'attacker_discord_id', username: 'Attacker' },
        deferUpdate: async () => {},
        followUp: async (payload) => {
          followUpCalledWith = payload;
        },
        editReply: async () => {
          throw new Error('Should not edit reply');
        }
      };

      const victimUserId = 'victim_user_uuid';
      await handleStatsOverview(fakeInteraction, victimUserId);

      assert.ok(followUpCalledWith, 'Expected interaction.followUp to be called');
      const isEphemeral = followUpCalledWith.ephemeral === true || (followUpCalledWith.flags & 64) !== 0;
      assert.ok(isEphemeral, 'Follow-up must be ephemeral');
      assert.match(followUpCalledWith.content, /only navigate your own statistics/i);
    });
  });


  // =========================================================================
  // SECTION 7: Payout Evidence Security & Boundary Validation
  // =========================================================================
  describe('Evidence Security & 40-Second Boundary Checks', () => {
    test('duration of EXACTLY 40.00 seconds MUST FAIL with DURATION_EXCEEDED', () => {
      const buffer40s = buildMockMp4Buffer(1000, 40000); // 40.000s
      assert.throws(
        () => validateEvidenceFile({
          buffer: buffer40s,
          filename: 'evidence.mp4',
          mimeType: 'video/mp4'
        }),
        (err) => {
          assert.ok(err instanceof EvidenceValidationError);
          assert.equal(err.code, 'DURATION_EXCEEDED');
          assert.match(err.message, /under 40 seconds/i);
          return true;
        }
      );
    });

    test('duration of 40.01 seconds MUST FAIL with DURATION_EXCEEDED', () => {
      const buffer40_01s = buildMockMp4Buffer(1000, 40010); // 40.01s
      assert.throws(
        () => validateEvidenceFile({
          buffer: buffer40_01s,
          filename: 'evidence.mp4',
          mimeType: 'video/mp4'
        }),
        (err) => {
          assert.ok(err instanceof EvidenceValidationError);
          assert.equal(err.code, 'DURATION_EXCEEDED');
          return true;
        }
      );
    });

    test('duration of 39.99 seconds MUST PASS verification', () => {
      const buffer39_99s = buildMockMp4Buffer(1000, 39990); // 39.99s
      const result = validateEvidenceFile({
        buffer: buffer39_99s,
        filename: 'evidence.mp4',
        mimeType: 'video/mp4'
      });
      assert.equal(result.isValid, true);
      assert.equal(result.durationSeconds, 39.99);
      assert.equal(result.requiresStaffDurationCheck, false);
    });

    test('0-byte empty file MUST FAIL with INVALID_FILE', () => {
      assert.throws(
        () => validateEvidenceFile({
          buffer: Buffer.alloc(0),
          filename: 'empty.mp4',
          mimeType: 'video/mp4'
        }),
        (err) => {
          assert.ok(err instanceof EvidenceValidationError);
          assert.equal(err.code, 'INVALID_FILE');
          return true;
        }
      );
    });

    test('non-video files (e.g. .exe, .sh, .pdf) MUST FAIL with INVALID_FILE', () => {
      const textBuffer = Buffer.from('malicious payload or text document');
      assert.throws(
        () => validateEvidenceFile({
          buffer: textBuffer,
          filename: 'malware.exe',
          mimeType: 'application/x-msdownload'
        }),
        (err) => {
          assert.ok(err instanceof EvidenceValidationError);
          assert.equal(err.code, 'INVALID_FILE');
          return true;
        }
      );
    });

    test('storage adapter sanitizes path traversal filenames safely without escaping directory', async () => {
      const storage = new LocalStorageAdapter();
      const validBuffer = buildMockMp4Buffer(1000, 15000);
      const traversalFilename = '../../../../windows/system32/cmd.mp4';

      const saved = await storage.saveFile({
        buffer: validBuffer,
        filename: traversalFilename,
        mimeType: 'video/mp4',
        subfolder: 'evidence'
      });

      assert.ok(saved.storageKey);
      assert.equal(saved.filename, 'cmd.mp4'); // Traversal stripped to safe basename
      assert.ok(!saved.storageKey.includes('..'), 'Storage key must not contain relative traversal dots');
    });
  });

  // =========================================================================
  // SECTION 20 & 24: Creator Privacy & Data Leakage Audit
  // =========================================================================
  describe('Creator Privacy & Information Leakage Audit', () => {
    test('toCreatorSafeStatus maps all internal review and risk states to safe creator labels', () => {
      assert.equal(toCreatorSafeStatus('APPROVED'), 'APPROVED');
      assert.equal(toCreatorSafeStatus('REJECTED'), 'REJECTED');
      assert.equal(toCreatorSafeStatus('PENDING_VERIFICATION'), 'UNDER REVIEW');
      assert.equal(toCreatorSafeStatus('UNDER_REVIEW'), 'UNDER REVIEW');
      assert.equal(toCreatorSafeStatus('POST_APPROVAL_REVIEW'), 'UNDER REVIEW');
      assert.equal(toCreatorSafeStatus('FLAGGED'), 'UNDER REVIEW');
      assert.equal(toCreatorSafeStatus('UNKNOWN_STATUS'), 'UNDER REVIEW');
    });

    test('buildSubmissionStatisticsEmbed NEVER leaks internal risk scores or fraud signals', () => {
      const statsWithInternalData = {
        submission: {
          id: 'sub_test_123',
          status: 'UNDER_REVIEW',
          url: 'https://youtube.com/shorts/sample123',
          platform: 'YOUTUBE',
          createdAt: new Date('2026-03-01T12:00:00Z'),
          retentionRequired: false
        },
        campaign: {
          name: 'Alpha Campaign',
          status: 'ACTIVE'
        },
        currentMetrics: {
          views: 12000,
          likes: 500,
          comments: 20,
          shares: null
        },
        growth: {
          views: { absolute: 1000, percent: 10 },
          likes: { absolute: 50, percent: 5 },
          comments: { absolute: 2, percent: 1 },
          shares: { absolute: 0, percent: 0 }
        },
        financials: {
          eligibleViews: 10000,
          grossEarnings: '15.00'
        },
        engagement: {
          knownEngagementRate: 4.5,
          likesPer1k: 41.6,
          commentsPer1k: 1.6,
          sharesPer1k: null
        },
        // Simulated internal leaked fields that must NOT appear in the creator embed
        riskScore: 85,
        riskLevel: 'HIGH_RISK',
        verificationSignalsSummary: 'Suspicious bot traffic detected',
        anomalyEvidence: { velocity: 9999 }
      };

      const embed = buildSubmissionStatisticsEmbed(statsWithInternalData, {
        id: 'creator_discord_1',
        username: 'CreatorOne'
      });

      const serialized = JSON.stringify(embed);

      assert.ok(!serialized.includes('HIGH_RISK'), 'Embed must not contain HIGH_RISK');
      assert.ok(!serialized.includes('Suspicious bot traffic'), 'Embed must not contain signal details');
      assert.ok(!serialized.includes('riskScore'), 'Embed must not contain riskScore');
      assert.ok(!serialized.includes('Verification & Integrity'), 'Embed must not contain Verification & Integrity field');
      assert.match(serialized, /UNDER REVIEW/i, 'Must display creator-safe UNDER REVIEW status');
    });

    test('maskWalletAddress masks raw address and preserves only safe prefix/suffix', () => {
      const solanaAddress = '4Nd1m1ndxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx9ZqX';
      const maskedSol = maskWalletAddress(solanaAddress);
      assert.equal(maskedSol, '4Nd1••••••••••9ZqX');
      assert.ok(!maskedSol.includes('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'));

      const ethAddress = '0x1234567890abcdef1234567890abcdef12347890';
      const maskedEth = maskWalletAddress(ethAddress);
      assert.equal(maskedEth, '0x1234••••••••••7890');
      assert.ok(!maskedEth.includes('abcdef1234567890abcdef'));
    });
  });

  // =========================================================================
  // SECTION 11 & 12: Fuzzing & Malformed Input Resilience
  // =========================================================================
  describe('Input Validation & Malformed Input Resilience', () => {
    test('PayoutProfileService rejects malformed or malicious wallet input', () => {
      const service = new PayoutProfileService();

      // Too short wallet
      assert.throws(
        () => service.validateProfileData({ walletAddress: 'abc', network: 'SOLANA', creatorHandle: '@user' }),
        (err) => {
          assert.ok(err instanceof PayoutProfileError);
          assert.equal(err.code, 'INVALID_WALLET');
          return true;
        }
      );

      // Empty network
      assert.throws(
        () => service.validateProfileData({ walletAddress: '0x1234567890abcdef', network: '', creatorHandle: '@user' }),
        (err) => {
          assert.ok(err instanceof PayoutProfileError);
          assert.equal(err.code, 'INVALID_NETWORK');
          return true;
        }
      );

      // Unsupported platform
      assert.throws(
        () => service.validateProfileData({
          walletAddress: '0x1234567890abcdef',
          network: 'SOLANA',
          creatorHandle: '@user',
          platform: 'UNSUPPORTED_PLATFORM'
        }),
        (err) => {
          assert.ok(err instanceof PayoutProfileError);
          assert.equal(err.code, 'INVALID_PLATFORM');
          return true;
        }
      );
    });
  });
});
