/**
 * PHASE 10H — Staff Control Plane Complete Implementation Test Suite
 *
 * Verifies end-to-end functionality across all 6 Staff channels and 2 System channels:
 * 1. #review-queue (Hub, list, inspection, approve, reject modal, flag)
 * 2. #creators (Hub, list, search modal, detail, status toggle, submission history)
 * 3. #campaign-management (Hub, list, create modal, detail, status toggle)
 * 4. #payout-queue (Hub, queue, history, detail, evidence review/accept/reject, payout approve/reject/disburse)
 * 5. #audit-log (Hub, paginated audit trail)
 * 6. #bot-status & #bot-errors (System telemetry, latency, errors refresh)
 * 7. Zero-trust authorization enforcement & role boundaries
 * 8. Error handling, domain error mapping & channel alert dispatching
 * 9. Server Provisioner staff & system channel reconciliation
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, PermissionsBitField } from 'discord.js';
import { config } from '../src/config/index.js';
import { prisma } from '../src/database/client.js';
import { STAFF_COMPONENTS, staffIds } from '../src/bot/components/staffComponentIds.js';
import { handleInteraction } from '../src/bot/interactions/router.js';
import { adminSubmissionService } from '../src/modules/admin/admin.submission.service.js';
import { adminPayoutService } from '../src/modules/admin/admin.payout.service.js';
import { adminCreatorService } from '../src/modules/admin/admin.creator.service.js';
import { adminCampaignService } from '../src/modules/admin/admin.campaign.service.js';
import { adminAuditService } from '../src/modules/admin/audit.service.js';
import { serverProvisioner } from '../src/bot/provisioning/server.provisioner.js';

describe('PEAK CLIP — Staff Control Plane Test Suite', () => {
  function createMockStaffInteraction(options = {}) {
    const replies = [];
    const followUps = [];
    let deferred = false;
    let replied = false;
    let shownModal = null;

    return {
      id: `int_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      guildId: options.guildId || config.discord?.guildId || 'dev_guild_123',
      user: options.user || { id: 'staff_user_1', username: 'StaffAdmin' },
      member: options.member || {
        roles: options.roles || [],
        permissions: options.permissions !== undefined ? options.permissions : PermissionsBitField.Flags.Administrator
      },
      message: options.message || {
        id: 'msg_channel_persistent',
        flags: {
          has: (flag) => (options.isEphemeralMessage ? flag === MessageFlags.Ephemeral : false)
        }
      },
      customId: options.customId,
      fields: {
        getTextInputValue: (fieldId) => options.fields?.[fieldId] || ''
      },
      client: options.client || {
        ws: { ping: 42 },
        channels: {
          cache: {
            find: () => null
          }
        }
      },
      replies,
      followUps,
      get shownModal() {
        return shownModal;
      },
      get deferred() {
        return deferred;
      },
      get replied() {
        return replied;
      },
      isChatInputCommand: () => false,
      isButton: () => options.isButton !== undefined ? options.isButton : !options.isModal,
      isStringSelectMenu: () => false,
      isModalSubmit: () => !!options.isModal,
      deferReply: async (opts) => {
        deferred = true;
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
        shownModal = modal;
      }
    };
  }

  // =========================================================================
  // 1. REVIEW QUEUE WORKSPACE (#review-queue)
  // =========================================================================
  describe('1. Review Queue Workspace (#review-queue)', () => {
    let origListReviewQueue;
    let origGetSubmissionDetails;
    let origApproveSubmission;
    let origRejectSubmission;
    let origFlagSubmission;

    beforeEach(() => {
      origListReviewQueue = adminSubmissionService.listReviewQueue;
      origGetSubmissionDetails = adminSubmissionService.getSubmissionDetails;
      origApproveSubmission = adminSubmissionService.approveSubmission;
      origRejectSubmission = adminSubmissionService.rejectSubmission;
      origFlagSubmission = adminSubmissionService.flagSubmission;

      adminSubmissionService.listReviewQueue = async () => [
        {
          id: 'sub_test_1',
          platform: 'TIKTOK',
          status: 'UNDER_REVIEW',
          url: 'https://tiktok.com/@clip/video/1',
          durationSeconds: 30,
          user: { discordId: 'creator_1', username: 'TestCreator' },
          campaign: { name: 'Summer Campaign' }
        }
      ];
      adminSubmissionService.getSubmissionDetails = async (id) => ({
        id,
        platform: 'TIKTOK',
        status: 'UNDER_REVIEW',
        url: 'https://tiktok.com/@clip/video/1',
        durationSeconds: 30,
        userId: 'usr_1',
        user: { discordId: 'creator_1', username: 'TestCreator' },
        campaign: { name: 'Summer Campaign' },
        campaignId: 'cmp_1',
        verifications: [{ score: 10, riskLevel: 'LOW_RISK' }],
        moderationHistory: []
      });
      adminSubmissionService.approveSubmission = async (id) => ({
        id,
        status: 'APPROVED',
        platform: 'TIKTOK',
        url: 'https://tiktok.com/@clip/video/1',
        user: { discordId: 'creator_1', username: 'TestCreator' },
        campaign: { name: 'Summer Campaign' },
        verifications: [],
        moderationHistory: []
      });
      adminSubmissionService.rejectSubmission = async (id, actor, details) => ({
        id,
        status: 'REJECTED'
      });
      adminSubmissionService.flagSubmission = async (id) => ({
        id,
        status: 'FLAGGED',
        platform: 'TIKTOK',
        url: 'https://tiktok.com/@clip/video/1',
        user: { discordId: 'creator_1', username: 'TestCreator' },
        campaign: { name: 'Summer Campaign' },
        verifications: [],
        moderationHistory: []
      });
    });

    afterEach(() => {
      adminSubmissionService.listReviewQueue = origListReviewQueue;
      adminSubmissionService.getSubmissionDetails = origGetSubmissionDetails;
      adminSubmissionService.approveSubmission = origApproveSubmission;
      adminSubmissionService.rejectSubmission = origRejectSubmission;
      adminSubmissionService.flagSubmission = origFlagSubmission;
    });

    test('admin_rq_hub displays review queue hub overview embed', async () => {
      const interaction = createMockStaffInteraction({ customId: STAFF_COMPONENTS.RQ_HUB });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /REVIEW QUEUE/i);
    });

    test('admin_rq_view:1 displays paginated review queue list and inspect buttons', async () => {
      const interaction = createMockStaffInteraction({ customId: staffIds.rqView(1) });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /Staff Review Queue — Page 1/i);
      // Navigation row contains inspect button for sub_test_1
      const navRows = interaction.replies[0].components;
      assert.ok(navRows.length > 0);
    });

    test('admin_sub_view:sub_test_1 displays submission telemetry card', async () => {
      const interaction = createMockStaffInteraction({ customId: staffIds.subView('sub_test_1') });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /Submission Telemetry — TIKTOK/i);
    });

    test('admin_sub_approve:sub_test_1 approves submission and returns updated card', async () => {
      const interaction = createMockStaffInteraction({ customId: staffIds.subApprove('sub_test_1') });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /Submission Telemetry/i);
    });

    test('admin_sub_reject_btn:sub_test_1 launches structured rejection modal', async () => {
      const interaction = createMockStaffInteraction({ customId: staffIds.subRejectBtn('sub_test_1') });
      await handleInteraction(interaction);

      assert.ok(interaction.shownModal, 'Rejection modal must be shown');
      assert.equal(interaction.shownModal.data.custom_id, staffIds.subRejectModal('sub_test_1'));
    });

    test('admin_sub_reject_modal:sub_test_1 processes structured modal rejection', async () => {
      const interaction = createMockStaffInteraction({
        isModal: true,
        customId: staffIds.subRejectModal('sub_test_1'),
        fields: { reason: 'SUSPICIOUS_ENGAGEMENT', notes: 'Spike in non-genuine likes' }
      });
      await handleInteraction(interaction);

      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].content, /REJECTED/i);
    });

    test('admin_sub_flag:sub_test_1 flags submission for second-tier review', async () => {
      const interaction = createMockStaffInteraction({ customId: staffIds.subFlag('sub_test_1') });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /Submission Telemetry/i);
    });
  });

  // =========================================================================
  // 2. CREATOR MANAGEMENT WORKSPACE (#creators)
  // =========================================================================
  describe('2. Creator Management Workspace (#creators)', () => {
    let origSearchCreators;
    let origGetCreatorDetails;
    let origUpdateCreatorStatus;

    beforeEach(() => {
      origSearchCreators = adminCreatorService.searchCreators;
      origGetCreatorDetails = adminCreatorService.getCreatorDetails;
      origUpdateCreatorStatus = adminCreatorService.updateCreatorStatus;

      adminCreatorService.searchCreators = async (query) => [
        {
          id: 'usr_c1',
          discordId: 'discord_c1',
          username: 'StarClipper',
          displayName: 'Star Clipper',
          status: 'ACTIVE',
          createdAt: new Date().toISOString()
        }
      ];
      adminCreatorService.getCreatorDetails = async (id) => ({
        id,
        discordId: 'discord_c1',
        username: 'StarClipper',
        displayName: 'Star Clipper',
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
        verifiedBalance: 150.0,
        pendingBalance: 50.0,
        activeCampaignsJoined: 3,
        totalSubmissions: 12
      });
      adminCreatorService.updateCreatorStatus = async (id, status) => ({
        id,
        status
      });
    });

    afterEach(() => {
      adminCreatorService.searchCreators = origSearchCreators;
      adminCreatorService.getCreatorDetails = origGetCreatorDetails;
      adminCreatorService.updateCreatorStatus = origUpdateCreatorStatus;
    });

    test('admin_cr_hub displays creator management hub embed', async () => {
      const interaction = createMockStaffInteraction({ customId: STAFF_COMPONENTS.CR_HUB });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /CREATOR MANAGEMENT/i);
    });

    test('admin_cr_list:1 displays paginated creator directory', async () => {
      const interaction = createMockStaffInteraction({ customId: staffIds.crList(1) });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /Creator Directory/i);
    });

    test('admin_cr_search_btn opens creator search modal', async () => {
      const interaction = createMockStaffInteraction({ customId: STAFF_COMPONENTS.CR_SEARCH_BTN });
      await handleInteraction(interaction);

      assert.ok(interaction.shownModal);
      assert.equal(interaction.shownModal.data.custom_id, STAFF_COMPONENTS.CR_SEARCH_MODAL);
    });

    test('admin_cr_search_modal executes search query and returns results', async () => {
      const interaction = createMockStaffInteraction({
        isModal: true,
        customId: STAFF_COMPONENTS.CR_SEARCH_MODAL,
        fields: { query: 'StarClipper' }
      });
      await handleInteraction(interaction);

      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /Creator Directory/i);
    });

    test('admin_cr_view:usr_c1 displays creator profile details', async () => {
      const interaction = createMockStaffInteraction({ customId: staffIds.crView('usr_c1') });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /Creator Profile/i);
    });

    test('admin_cr_status:usr_c1:SUSPENDED suspends creator and renders updated profile', async () => {
      const interaction = createMockStaffInteraction({ customId: staffIds.crStatus('usr_c1', 'SUSPENDED') });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /Creator Profile/i);
    });
  });

  // =========================================================================
  // 3. CAMPAIGN OPERATIONS WORKSPACE (#campaign-management)
  // =========================================================================
  describe('3. Campaign Operations Workspace (#campaign-management)', () => {
    let origGetCampaignDetails;
    let origCreateCampaign;
    let origUpdateStatus;

    beforeEach(() => {
      origGetCampaignDetails = adminCampaignService.getCampaignDetails;
      origCreateCampaign = adminCampaignService.createCampaign;
      origUpdateStatus = adminCampaignService.updateStatus;

      adminCampaignService.getCampaignDetails = async (id) => ({
        id,
        name: 'Brand Launch 2026',
        clientName: 'Acme Corp',
        status: 'ACTIVE',
        payRate: 15.0,
        totalBudget: 5000.0,
        consumedBudget: 1200.0,
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 86400000).toISOString(),
        submissionCount: 45
      });
      adminCampaignService.createCampaign = async (input) => ({
        id: 'cmp_new_1',
        name: input.name,
        status: 'DRAFT'
      });
      adminCampaignService.updateStatus = async (id, status) => ({
        id,
        status
      });
    });

    afterEach(() => {
      adminCampaignService.getCampaignDetails = origGetCampaignDetails;
      adminCampaignService.createCampaign = origCreateCampaign;
      adminCampaignService.updateStatus = origUpdateStatus;
    });

    test('admin_cmp_hub displays campaign operations hub embed', async () => {
      const interaction = createMockStaffInteraction({ customId: STAFF_COMPONENTS.CMP_HUB });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /CAMPAIGN MANAGEMENT HUB/i);
    });

    test('admin_cmp_list:1 displays campaign directory', async () => {
      const interaction = createMockStaffInteraction({ customId: staffIds.cmpList(1) });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /Campaign Directory/i);
    });

    test('admin_cmp_create_btn opens campaign creation modal', async () => {
      const interaction = createMockStaffInteraction({ customId: STAFF_COMPONENTS.CMP_CREATE_BTN });
      await handleInteraction(interaction);

      assert.ok(interaction.shownModal);
      assert.equal(interaction.shownModal.data.custom_id, STAFF_COMPONENTS.CMP_CREATE_MODAL);
    });

    test('admin_cmp_create_modal creates campaign and replies successfully', async () => {
      const interaction = createMockStaffInteraction({
        isModal: true,
        customId: STAFF_COMPONENTS.CMP_CREATE_MODAL,
        fields: {
          name: 'Viral Clips 2026',
          client: 'Apex Brands',
          cpm: '12.50',
          budget: '2500'
        }
      });
      await handleInteraction(interaction);

      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].content, /created successfully/i);
    });

    test('admin_cmp_view:cmp_test_1 displays campaign operational card', async () => {
      const interaction = createMockStaffInteraction({ customId: staffIds.cmpView('cmp_test_1') });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /Campaign Details/i);
    });

    test('admin_cmp_status:cmp_test_1:PAUSED pauses campaign and renders updated embed', async () => {
      const interaction = createMockStaffInteraction({ customId: staffIds.cmpStatus('cmp_test_1', 'PAUSED') });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /Campaign Details/i);
    });
  });

  // =========================================================================
  // 4. PAYOUT FINANCIAL OPERATIONS WORKSPACE (#payout-queue)
  // =========================================================================
  describe('4. Payout Financial Operations Workspace (#payout-queue)', () => {
    let origListPayoutRequests;
    let origGetPayoutDetails;
    let origApprovePayout;
    let origRejectPayout;
    let origProcessDisbursement;
    let origAcceptEvidence;
    let origRejectEvidence;

    beforeEach(() => {
      origListPayoutRequests = adminPayoutService.listPayoutRequests;
      origGetPayoutDetails = adminPayoutService.getPayoutDetails;
      origApprovePayout = adminPayoutService.approvePayout;
      origRejectPayout = adminPayoutService.rejectPayout;
      origProcessDisbursement = adminPayoutService.processDisbursement;
      origAcceptEvidence = adminPayoutService.acceptEvidence;
      origRejectEvidence = adminPayoutService.rejectEvidence;

      adminPayoutService.listPayoutRequests = async () => [
        {
          id: 'pay_req_1',
          amount: 250.0,
          status: 'REQUESTED',
          createdAt: new Date().toISOString(),
          userId: 'usr_c1',
          user: { discordId: 'creator_1', username: 'TopCreator' }
        }
      ];
      adminPayoutService.getPayoutDetails = async (id) => ({
        id,
        amount: 250.0,
        status: 'REQUESTED',
        createdAt: new Date().toISOString(),
        userId: 'usr_c1',
        user: { discordId: 'creator_1', username: 'TopCreator' },
        evidence: [
          {
            id: 'ev_123',
            status: 'ACCEPTED',
            mediaUrl: 'https://cdn.discordapp.com/attachments/evidence.mp4',
            fileSize: 1048576,
            durationSeconds: 25,
            telemetry: {
              deviceModel: 'iPhone 15 Pro',
              clientTimestamp: new Date().toISOString()
            }
          }
        ]
      });
      adminPayoutService.approvePayout = async (id) => ({
        id,
        status: 'APPROVED'
      });
      adminPayoutService.rejectPayout = async (id) => ({
        id,
        status: 'REJECTED'
      });
      adminPayoutService.processDisbursement = async (id) => ({
        payout: { id, status: 'PAID' },
        disbursement: { providerReference: 'TX_DEV_9999' }
      });
      adminPayoutService.acceptEvidence = async (id) => ({
        id,
        status: 'ACCEPTED'
      });
      adminPayoutService.rejectEvidence = async (id) => ({
        id,
        status: 'REJECTED'
      });
    });

    afterEach(() => {
      adminPayoutService.listPayoutRequests = origListPayoutRequests;
      adminPayoutService.getPayoutDetails = origGetPayoutDetails;
      adminPayoutService.approvePayout = origApprovePayout;
      adminPayoutService.rejectPayout = origRejectPayout;
      adminPayoutService.processDisbursement = origProcessDisbursement;
      adminPayoutService.acceptEvidence = origAcceptEvidence;
      adminPayoutService.rejectEvidence = origRejectEvidence;
    });

    test('admin_pq_hub displays payout hub overview embed', async () => {
      const interaction = createMockStaffInteraction({ customId: STAFF_COMPONENTS.PQ_HUB });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /PAYOUT & FINANCIAL QUEUE/i);
    });

    test('admin_pq_view:1 displays pending payout requests', async () => {
      const interaction = createMockStaffInteraction({ customId: staffIds.pqView(1) });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /Payout Review Queue/i);
    });

    test('admin_pq_history:1 displays financial ledger history', async () => {
      const interaction = createMockStaffInteraction({ customId: staffIds.pqHistory(1) });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /Payout History/i);
    });

    test('admin_pq_view_req:pay_req_1 displays detailed payout card', async () => {
      const interaction = createMockStaffInteraction({ customId: staffIds.pqViewReq('pay_req_1') });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /Payout Request Details/i);
    });

    test('admin_pq_ev_review:pay_req_1 displays analytics screen recording inspection card', async () => {
      const interaction = createMockStaffInteraction({ customId: staffIds.evReview('pay_req_1') });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /ANALYTICS SCREEN RECORDING/i);
    });

    test('admin_pq_ev_accept:ev_123 accepts evidence and updates review view', async () => {
      const interaction = createMockStaffInteraction({ customId: staffIds.evAccept('ev_123') });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].content, /ACCEPTED/i);
    });

    test('admin_pq_ev_reject_btn:ev_123 opens evidence rejection modal', async () => {
      const interaction = createMockStaffInteraction({ customId: staffIds.evRejectBtn('ev_123') });
      await handleInteraction(interaction);

      assert.ok(interaction.shownModal);
      assert.equal(interaction.shownModal.data.custom_id, staffIds.evRejectModal('ev_123'));
    });

    test('admin_pq_ev_reject_modal:ev_123 submits evidence rejection', async () => {
      const interaction = createMockStaffInteraction({
        isModal: true,
        customId: staffIds.evRejectModal('ev_123'),
        fields: { reason: 'UNSUPPORTED_DURATION', notes: 'Recording is 48 seconds, must be under 40s' }
      });
      await handleInteraction(interaction);

      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].content, /REJECTED/i);
    });

    test('admin_payout_approve:pay_req_1 approves payout request', async () => {
      const interaction = createMockStaffInteraction({ customId: staffIds.payoutApprove('pay_req_1') });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /Payout Request Details/i);
    });

    test('admin_payout_reject_btn:pay_req_1 opens payout rejection modal', async () => {
      const interaction = createMockStaffInteraction({ customId: staffIds.payoutRejectBtn('pay_req_1') });
      await handleInteraction(interaction);

      assert.ok(interaction.shownModal);
      assert.equal(interaction.shownModal.data.custom_id, staffIds.payoutRejectModal('pay_req_1'));
    });

    test('admin_payout_reject_modal:pay_req_1 executes payout rejection', async () => {
      const interaction = createMockStaffInteraction({
        isModal: true,
        customId: staffIds.payoutRejectModal('pay_req_1'),
        fields: { reason: 'Failed verification of analytics evidence' }
      });
      await handleInteraction(interaction);

      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].content, /REJECTED/i);
    });

    test('admin_payout_process:pay_req_1 executes disbursement and displays reference', async () => {
      const interaction = createMockStaffInteraction({ customId: staffIds.payoutProcess('pay_req_1') });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].content, /Disbursement processed/i);
      assert.match(interaction.replies[0].content, /TX_DEV_9999/);
    });
  });

  // =========================================================================
  // 5. AUDIT LOG WORKSPACE (#audit-log)
  // =========================================================================
  describe('5. Audit Log Workspace (#audit-log)', () => {
    let origGetAuditTrail;

    beforeEach(() => {
      origGetAuditTrail = adminAuditService.getAuditTrail;
      adminAuditService.getAuditTrail = async () => ({
        items: [
          {
            id: 'audit_1',
            action: 'SUBMISSION_APPROVE',
            actorType: 'STAFF',
            actorDiscordId: 'staff_1',
            targetType: 'SUBMISSION',
            targetId: 'sub_123',
            reason: 'Clean analytics verified',
            createdAt: new Date().toISOString()
          }
        ],
        total: 1,
        page: 1,
        totalPages: 1
      });
    });

    afterEach(() => {
      adminAuditService.getAuditTrail = origGetAuditTrail;
    });

    test('admin_audit_hub displays audit log overview embed', async () => {
      const interaction = createMockStaffInteraction({ customId: STAFF_COMPONENTS.AUDIT_HUB });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /AUDIT TRAIL/i);
    });

    test('admin_audit_list:1 displays paginated audit events trail', async () => {
      const interaction = createMockStaffInteraction({ customId: staffIds.auditList(1) });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /Audit Log/i);
    });
  });

  // =========================================================================
  // 6. SYSTEM STATUS & ERRORS (#bot-status & #bot-errors)
  // =========================================================================
  describe('6. System Status & Errors (#bot-status & #bot-errors)', () => {
    test('sys_status_refresh updates system telemetry metrics', async () => {
      const interaction = createMockStaffInteraction({ customId: STAFF_COMPONENTS.SYS_STATUS_REFRESH });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /SYSTEM STATUS & TELEMETRY/i);
    });

    test('sys_errors_refresh updates bot error diagnostic overview', async () => {
      const interaction = createMockStaffInteraction({ customId: STAFF_COMPONENTS.SYS_ERRORS_REFRESH });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /ERROR & DIAGNOSTIC/i);
    });
  });

  // =========================================================================
  // 7. ZERO-TRUST PERMISSIONS & ROLE BOUNDARIES
  // =========================================================================
  describe('7. Zero-Trust Permissions & Role Boundaries', () => {
    test('unauthorized user without staff permissions receives immediate 🔒 rejection without deferUpdate', async () => {
      const interaction = createMockStaffInteraction({
        user: { id: 'regular_user_1', username: 'RegularCreator' },
        permissions: 0n,
        roles: ['creator_role'],
        customId: staffIds.rqView(1)
      });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, false, 'Unauthorized click must NOT defer the interaction');
      assert.equal(interaction.replied, true);
      assert.match(interaction.replies[0].content, /do not have permission/i);
    });

    test('campaign manager without Peak Admin cannot approve payouts or process disbursements', async () => {
      // Role with CAMPAIGN_MANAGER permissions but NOT PEAK_ADMIN
      const interaction = createMockStaffInteraction({
        user: { id: 'cm_user_1', username: 'CampaignManager' },
        permissions: 0n,
        roles: ['role_campaign_manager'], // Only CAMPAIGN_MANAGER
        customId: staffIds.payoutApprove('pay_req_1')
      });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, false);
      assert.equal(interaction.replied, true);
      assert.match(interaction.replies[0].content, /do not have permission/i);
    });
  });

  // =========================================================================
  // 8. SERVER PROVISIONER STAFF & SYSTEM CHANNELS RECONCILIATION
  // =========================================================================
  describe('8. Server Provisioner Staff & System Channel Reconciliation', () => {
    test('_initializeStaffChannelMessages reconciles all 5 staff operational channels without error', async () => {
      const sentMessages = {};
      const mockChannel = (name) => ({
        id: `ch_${name}`,
        name,
        messages: {
          fetch: async () => []
        },
        send: async (payload) => {
          sentMessages[name] = payload;
          return { id: `msg_${name}`, ...payload };
        }
      });

      const staffChannels = {
        'review-queue': mockChannel('review-queue'),
        creators: mockChannel('creators'),
        'campaign-management': mockChannel('campaign-management'),
        'payout-queue': mockChannel('payout-queue'),
        'audit-log': mockChannel('audit-log')
      };

      const botMember = { user: { id: 'bot_id_1' } };
      await serverProvisioner._initializeStaffChannelMessages(staffChannels, botMember, 'prov_test_1');

      assert.ok(sentMessages['review-queue'], 'Review queue canonical message posted');
      assert.ok(sentMessages['creators'], 'Creators canonical message posted');
      assert.ok(sentMessages['campaign-management'], 'Campaign management canonical message posted');
      assert.ok(sentMessages['payout-queue'], 'Payout queue canonical message posted');
      assert.ok(sentMessages['audit-log'], 'Audit log canonical message posted');
    });

    test('_initializeSystemChannelMessages reconciles both system channels', async () => {
      const sentMessages = {};
      const mockChannel = (name) => ({
        id: `ch_${name}`,
        name,
        messages: {
          fetch: async () => []
        },
        send: async (payload) => {
          sentMessages[name] = payload;
          return { id: `msg_${name}`, ...payload };
        }
      });

      const systemChannels = {
        'bot-status': mockChannel('bot-status'),
        'bot-errors': mockChannel('bot-errors')
      };

      const botMember = { user: { id: 'bot_id_1' } };
      await serverProvisioner._initializeSystemChannelMessages(systemChannels, botMember, 'prov_test_2');

      assert.ok(sentMessages['bot-status'], 'Bot status canonical message posted');
      assert.ok(sentMessages['bot-errors'], 'Bot errors canonical message posted');
    });
  });
});
