import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildStaffEvidenceReviewEmbed } from '../src/bot/embeds/staff.embeds.js';
import {
  buildStaffEvidenceReviewRow,
  buildStaffEvidenceVersionsRow
} from '../src/bot/components/staff.components.js';
import {
  handleStaffEvidenceReview,
  handleStaffEvidenceAccept,
  handleStaffEvidenceRejectModalSubmit
} from '../src/bot/interactions/staff.interactions.js';
import { adminPayoutService } from '../src/modules/admin/admin.payout.service.js';
import { storageService } from '../src/modules/storage/storage.service.js';
import { AttachmentBuilder } from 'discord.js';

describe('Staff Evidence Review & Video Playback', () => {
  describe('buildStaffEvidenceReviewEmbed', () => {
    it('renders clean missing-evidence notice when evidence is null', () => {
      const payoutReq = { id: 'payout-123', amount: '50.00' };
      const embed = buildStaffEvidenceReviewEmbed(payoutReq, null);

      const json = embed.toJSON();
      assert.equal(json.title, '📹 ANALYTICS SCREEN RECORDING TELEMETRY REVIEW');
      assert.ok(json.description.includes('No screen recording evidence was submitted'));
      assert.ok(json.description.includes('payout-123'));
      assert.ok(json.description.includes('$50.00'));

      const fields = json.fields;
      assert.equal(fields.find((f) => f.name === '🎬 Evidence ID')?.value, '`None`');
      assert.equal(fields.find((f) => f.name === '⏱️ Duration Check')?.value, '`N/A`');
      assert.equal(fields.find((f) => f.name === '📦 File Status')?.value, '`No Recording Attached`');
      assert.equal(fields.find((f) => f.name === '📌 Evidence Status')?.value, '`NOT_SUBMITTED`');
    });

    it('renders full telemetry and attachment notice when evidence is attached', () => {
      const payoutReq = { id: 'payout-456', amount: '120.00' };
      const evidence = {
        id: 'ev-789',
        version: 1,
        filename: 'screen_recording.mp4',
        durationSeconds: 24.5,
        fileSize: 1024 * 1024 * 5, // 5 MB
        mimeType: 'video/mp4',
        storageKey: 'evidence/123456_test.mp4',
        status: 'PENDING_REVIEW'
      };

      const embed = buildStaffEvidenceReviewEmbed(payoutReq, evidence, {
        hasAttachment: true,
        totalVersions: 2
      });

      const json = embed.toJSON();
      assert.ok(json.description.includes('Screen recording video is attached below for direct playback in Discord'));
      const fields = json.fields;
      assert.ok(fields.find((f) => f.name === '🎬 Evidence ID')?.value.includes('Version **1** of 2'));
      assert.ok(fields.find((f) => f.name === '⏱️ Duration Check')?.value.includes('PASSED'));
      assert.ok(fields.find((f) => f.name === '⏱️ Duration Check')?.value.includes('24.50s'));
      assert.ok(fields.find((f) => f.name === '📦 File Size & Type')?.value.includes('5.00 MB'));
      assert.equal(fields.find((f) => f.name === '📁 Filename')?.value, '`screen_recording.mp4`');
      assert.equal(fields.find((f) => f.name === '💾 Storage Key')?.value, '`evidence/123456_test.mp4`');
      assert.equal(fields.find((f) => f.name === '📌 Evidence Status')?.value, '`PENDING_REVIEW`');
    });

    it('renders file warning if reading video fails', () => {
      const payoutReq = { id: 'payout-789', amount: '35.00' };
      const evidence = {
        id: 'ev-999',
        version: 1,
        durationSeconds: 15.0,
        fileSize: 2048,
        mimeType: 'video/mp4',
        storageKey: 'evidence/missing.mp4',
        status: 'PENDING_REVIEW'
      };

      const embed = buildStaffEvidenceReviewEmbed(payoutReq, evidence, {
        fileError: 'File not found on disk'
      });

      const json = embed.toJSON();
      assert.ok(json.description.includes('File Warning:'));
      assert.ok(json.description.includes('File not found on disk'));
    });
  });

  describe('buildStaffEvidenceReviewRow', () => {
    it('renders only Back button when evidenceId is null', () => {
      const row = buildStaffEvidenceReviewRow('payout-123', null, null);
      const json = row.toJSON();
      assert.equal(json.components.length, 1);
      assert.equal(json.components[0].label, '◀ Back to Payout');
    });

    it('renders Accept, Reject, and Back buttons when evidence is PENDING_REVIEW', () => {
      const row = buildStaffEvidenceReviewRow('payout-123', 'ev-456', 'PENDING_REVIEW');
      const json = row.toJSON();
      assert.equal(json.components.length, 3);
      assert.ok(json.components[0].label.includes('Accept Recording'));
      assert.ok(json.components[1].label.includes('Reject Recording'));
      assert.ok(json.components[2].label.includes('Back to Payout'));
    });

    it('omits Accept button when already ACCEPTED', () => {
      const row = buildStaffEvidenceReviewRow('payout-123', 'ev-456', 'ACCEPTED');
      const json = row.toJSON();
      assert.equal(json.components.length, 2);
      assert.ok(json.components[0].label.includes('Reject Recording'));
      assert.ok(json.components[1].label.includes('Back to Payout'));
    });

    it('omits Reject button when already REJECTED', () => {
      const row = buildStaffEvidenceReviewRow('payout-123', 'ev-456', 'REJECTED');
      const json = row.toJSON();
      assert.equal(json.components.length, 2);
      assert.ok(json.components[0].label.includes('Accept Recording'));
      assert.ok(json.components[1].label.includes('Back to Payout'));
    });
  });

  describe('buildStaffEvidenceVersionsRow', () => {
    it('returns null for single or empty evidence list', () => {
      assert.equal(buildStaffEvidenceVersionsRow('payout-123', []), null);
      assert.equal(buildStaffEvidenceVersionsRow('payout-123', [{ version: 1 }]), null);
    });

    it('creates version navigation buttons for multiple evidence submissions', () => {
      const list = [
        { version: 1, status: 'REJECTED' },
        { version: 2, status: 'PENDING_REVIEW' }
      ];
      const row = buildStaffEvidenceVersionsRow('payout-123', list, 2);
      assert.ok(row);
      const json = row.toJSON();
      assert.equal(json.components.length, 2);
      assert.ok(json.components[0].label.includes('v1'));
      assert.equal(json.components[0].disabled, false);
      assert.ok(json.components[1].label.includes('v2'));
      assert.equal(json.components[1].disabled, true); // active version is disabled
    });
  });

  describe('handleStaffEvidenceReview interaction handler', () => {
    it('reads video file from storage and attaches AttachmentBuilder to reply', async () => {
      const origGetPayout = adminPayoutService.getPayoutDetails;
      const origGetBuffer = storageService.getFileBuffer;

      const dummyBuffer = Buffer.from('fake-video-content-stream');
      let loadedStorageKey = null;

      storageService.getFileBuffer = async (key) => {
        loadedStorageKey = key;
        return dummyBuffer;
      };

      adminPayoutService.getPayoutDetails = async (id) => ({
        id,
        amount: '75.00',
        evidence: [
          {
            id: 'ev-test-1',
            version: 1,
            filename: 'proof.mp4',
            fileSize: dummyBuffer.length,
            durationSeconds: 18.2,
            storageKey: 'evidence/stored_proof.mp4',
            status: 'PENDING_REVIEW'
          }
        ]
      });

      let editReplyPayload = null;
      const mockInteraction = {
        member: { permissions: { has: () => true } },
        user: { id: 'admin-user-1' },
        isButton: () => true,
        deferUpdate: async () => {},
        editReply: async (payload) => {
          editReplyPayload = payload;
        }
      };

      try {
        await handleStaffEvidenceReview(mockInteraction, 'payout-test-1');

        assert.equal(loadedStorageKey, 'evidence/stored_proof.mp4');
        assert.ok(editReplyPayload);
        assert.equal(editReplyPayload.files.length, 1);
        assert.ok(editReplyPayload.files[0] instanceof AttachmentBuilder);
        assert.equal(editReplyPayload.files[0].name, 'evidence_payout-t_v1.mp4');
      } finally {
        adminPayoutService.getPayoutDetails = origGetPayout;
        storageService.getFileBuffer = origGetBuffer;
      }
    });

    it('gracefully handles missing video file on disk without throwing', async () => {
      const origGetPayout = adminPayoutService.getPayoutDetails;
      const origGetBuffer = storageService.getFileBuffer;

      storageService.getFileBuffer = async () => {
        throw new Error('ENOENT: no such file or directory');
      };

      adminPayoutService.getPayoutDetails = async (id) => ({
        id,
        amount: '100.00',
        evidence: [
          {
            id: 'ev-test-missing',
            version: 1,
            filename: 'lost.mp4',
            fileSize: 5000,
            durationSeconds: 20.0,
            storageKey: 'evidence/lost.mp4',
            status: 'PENDING_REVIEW'
          }
        ]
      });

      let editReplyPayload = null;
      const mockInteraction = {
        member: { permissions: { has: () => true } },
        user: { id: 'admin-user-1' },
        isButton: () => true,
        deferUpdate: async () => {},
        editReply: async (payload) => {
          editReplyPayload = payload;
        }
      };

      try {
        await handleStaffEvidenceReview(mockInteraction, 'payout-test-2');

        assert.ok(editReplyPayload);
        assert.equal(editReplyPayload.files.length, 0); // No attachment
        assert.ok(editReplyPayload.embeds[0].data.description.includes('Could not load video'));
      } finally {
        adminPayoutService.getPayoutDetails = origGetPayout;
        storageService.getFileBuffer = origGetBuffer;
      }
    });

    it('navigates to specific evidence version when targetVersion is requested', async () => {
      const origGetPayout = adminPayoutService.getPayoutDetails;
      const origGetBuffer = storageService.getFileBuffer;

      const v1Buffer = Buffer.from('v1-data');
      const v2Buffer = Buffer.from('v2-data');
      let requestedKey = null;

      storageService.getFileBuffer = async (key) => {
        requestedKey = key;
        return key.includes('v1') ? v1Buffer : v2Buffer;
      };

      adminPayoutService.getPayoutDetails = async (id) => ({
        id,
        amount: '150.00',
        evidence: [
          {
            id: 'ev-v2',
            version: 2,
            filename: 'clip_v2.mp4',
            fileSize: v2Buffer.length,
            durationSeconds: 22.0,
            storageKey: 'evidence/stored_v2.mp4',
            status: 'PENDING_REVIEW'
          },
          {
            id: 'ev-v1',
            version: 1,
            filename: 'clip_v1.mp4',
            fileSize: v1Buffer.length,
            durationSeconds: 15.0,
            storageKey: 'evidence/stored_v1.mp4',
            status: 'REJECTED'
          }
        ]
      });

      let editReplyPayload = null;
      const mockInteraction = {
        member: { permissions: { has: () => true } },
        user: { id: 'admin-user-1' },
        isButton: () => true,
        deferUpdate: async () => {},
        editReply: async (payload) => {
          editReplyPayload = payload;
        }
      };

      try {
        // Request v1 specifically
        await handleStaffEvidenceReview(mockInteraction, 'payout-test-3', 1);

        assert.equal(requestedKey, 'evidence/stored_v1.mp4');
        assert.ok(editReplyPayload);
        assert.equal(editReplyPayload.files.length, 1);
        assert.equal(editReplyPayload.files[0].name, 'evidence_payout-t_v1.mp4');
        assert.equal(editReplyPayload.components.length, 2); // Review row + Version tabs row
      } finally {
        adminPayoutService.getPayoutDetails = origGetPayout;
        storageService.getFileBuffer = origGetBuffer;
      }
    });
  });
});
