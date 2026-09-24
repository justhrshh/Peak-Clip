import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VerificationService } from '../src/modules/verification/verification.service.js';
import { assessVerificationRisk } from '../src/modules/verification/risk.assessor.js';
import { defaultApprovalPolicy, ApprovalPolicy } from '../src/modules/verification/approval.policy.js';
import { DEFAULT_VERIFICATION_POLICY } from '../src/modules/verification/policy.js';
import { evaluatePollingEligibility } from '../src/modules/verification/polling.policy.js';
import {
  notifyStaffSuspiciousClip,
  notifyStaffManualReviewRequired,
  notifyStaffEarlyDeletion,
  notifyStaffPayoutRequested
} from '../src/bot/notifications/staff.notifications.js';
import {
  buildStaffSubmissionDetailRow
} from '../src/bot/components/staff.components.js';
import {
  buildAdminControlCenterRows
} from '../src/bot/components/dashboard.components.js';
import {
  buildCreatorDashboardEmbed,
  buildAdminControlCenterEmbed
} from '../src/bot/embeds/dashboard.embeds.js';
import { STAFF_COMPONENTS, staffIds } from '../src/bot/components/staffComponentIds.js';
import { RetentionService } from '../src/modules/retention/retention.service.js';

describe('PEAK CLIP — FINAL CLIP OPERATIONS HARDENING TEST SUITE', () => {

  describe('1. Submission Window Validation (1-Hour Boundary & UTC Safety)', () => {
    function createMockService(submission, fakeProvider) {
      let updatedSubmission = null;
      const mockSubmissionRepo = {
        getSubmissionById: async () => submission,
        updateSubmission: async (id, data) => {
          updatedSubmission = { ...submission, ...data };
          return updatedSubmission;
        },
        updateSubmissionStatus: async (id, status, data) => {
          updatedSubmission = { ...submission, status, ...data };
          return updatedSubmission;
        }
      };
      const mockVerificationRepo = {
        getVerificationBySubmissionId: async () => null,
        upsertVerification: async (data) => ({ id: 'ver_1', ...data }),
        addVerificationSignals: async () => {},
        getHistoricalSnapshots: async () => [],
        createMetricSnapshot: async () => ({ id: 'snap_1' })
      };
      const mockModerationRepo = {
        createHistoryEntry: async (entry) => ({ id: 'hist_1', ...entry }),
        getHistoryBySubmissionId: async () => []
      };
      const mockProviderResolver = () => fakeProvider;

      const service = new VerificationService(
        mockVerificationRepo,
        mockSubmissionRepo,
        mockProviderResolver,
        defaultApprovalPolicy,
        DEFAULT_VERIFICATION_POLICY,
        mockModerationRepo
      );

      return { service, getUpdated: () => updatedSubmission };
    }

    test('10 minutes old submission passes cleanly (submissionAgeSeconds = 600)', async () => {
      const now = new Date('2026-09-23T12:00:00.000Z');
      const publishedAt = new Date('2026-09-23T11:50:00.000Z'); // 10 mins ago

      const submission = {
        id: 's1',
        platform: 'YOUTUBE',
        url: 'https://youtube.com/shorts/dQw4w9WgXcQ',
        submittedAt: now,
        campaign: { minClipDurationSeconds: 10, maxClipDurationSeconds: 60 }
      };

      const fakeProvider = {
        getCurrentMetrics: async () => ({
          available: true,
          status: 'SUCCESS',
          publishedAt: publishedAt.toISOString(),
          durationSeconds: 30,
          views: 500,
          likes: 50,
          comments: 5
        })
      };

      const { service } = createMockService(submission, fakeProvider);
      const result = await service.runVerification('s1');

      assert.equal(result.publishedAt, publishedAt.toISOString());
      assert.equal(result.submissionAgeSeconds, 600);
      assert.equal(result.submissionStatus, 'APPROVED');
    });

    test('Exactly 1 hour old submission passes cleanly (boundary inclusive: 3600s)', async () => {
      const now = new Date('2026-09-23T12:00:00.000Z');
      const publishedAt = new Date('2026-09-23T11:00:00.000Z'); // exactly 3600s ago

      const submission = {
        id: 's2',
        platform: 'YOUTUBE',
        url: 'https://youtube.com/shorts/abcdefghijk',
        submittedAt: now,
        campaign: { minClipDurationSeconds: 10, maxClipDurationSeconds: 60 }
      };

      const fakeProvider = {
        getCurrentMetrics: async () => ({
          available: true,
          status: 'SUCCESS',
          publishedAt: publishedAt.toISOString(),
          durationSeconds: 30,
          views: 100,
          likes: 10,
          comments: 2
        })
      };

      const { service } = createMockService(submission, fakeProvider);
      const result = await service.runVerification('s2');

      assert.equal(result.submissionAgeSeconds, 3600);
      assert.equal(result.submissionStatus, 'APPROVED');
    });

    test('Older than 1 hour submission is rejected (boundary > 3600s)', async () => {
      const now = new Date('2026-09-23T12:00:00.000Z');
      const publishedAt = new Date('2026-09-23T10:59:58.000Z'); // 3602s ago (> 3600s)

      const submission = {
        id: 's3',
        platform: 'YOUTUBE',
        url: 'https://youtube.com/shorts/1234567890a',
        submittedAt: now,
        campaign: { minClipDurationSeconds: 10, maxClipDurationSeconds: 60 }
      };

      const fakeProvider = {
        getCurrentMetrics: async () => ({
          available: true,
          status: 'SUCCESS',
          publishedAt: publishedAt.toISOString(),
          durationSeconds: 30,
          views: 100
        })
      };

      const { service, getUpdated } = createMockService(submission, fakeProvider);
      const result = await service.runVerification('s3');

      assert.equal(result.submissionStatus, 'REJECTED');
      assert.match(result.reason, /1 hour of publication/);
      assert.equal(result.submissionAgeSeconds, 3602);
      assert.equal(getUpdated().status, 'REJECTED');
    });

    test('Future publication timestamp (> 60s ahead) is rejected', async () => {
      const now = new Date('2026-09-23T12:00:00.000Z');
      const publishedAt = new Date('2026-09-23T12:05:00.000Z'); // 5 mins in future

      const submission = {
        id: 's4',
        platform: 'YOUTUBE',
        url: 'https://youtube.com/shorts/0987654321b',
        submittedAt: now,
        campaign: { minClipDurationSeconds: 10, maxClipDurationSeconds: 60 }
      };

      const fakeProvider = {
        getCurrentMetrics: async () => ({
          available: true,
          status: 'SUCCESS',
          publishedAt: publishedAt.toISOString(),
          durationSeconds: 30,
          views: 100
        })
      };

      const { service, getUpdated } = createMockService(submission, fakeProvider);
      const result = await service.runVerification('s4');

      assert.equal(result.submissionStatus, 'REJECTED');
      assert.match(result.reason, /in the future/i);
      assert.equal(getUpdated().status, 'REJECTED');
    });

    test('Missing / unavailable provider timestamp does not fabricate or falsely reject', async () => {
      const now = new Date('2026-09-23T12:00:00.000Z');

      const submission = {
        id: 's5',
        platform: 'TIKTOK',
        url: 'https://www.tiktok.com/@user/video/7123456789012345678',
        submittedAt: now,
        campaign: { minClipDurationSeconds: 10, maxClipDurationSeconds: 60 }
      };

      const fakeProvider = {
        getCurrentMetrics: async () => ({
          available: true,
          status: 'DATA_UNAVAILABLE',
          reason: 'Manual verification platform',
          publishedAt: null,
          durationSeconds: null,
          views: null
        })
      };

      const { service } = createMockService(submission, fakeProvider);
      const result = await service.runVerification('s5');

      assert.equal(result.publishedAt, null);
      assert.equal(result.submissionAgeSeconds, null);
      // Clean fallback: moves to UNDER_REVIEW, not rejected due to timestamp
      assert.equal(result.submissionStatus, 'UNDER_REVIEW');
    });
  });

  describe('2. Automatic vs Manual Review Routing & 5 Staff Actions', () => {
    test('LOW_RISK verification routes to auto-approved outcome', () => {
      const policy = new ApprovalPolicy();
      const decision = policy.evaluateApprovalDecision({
        riskLevel: 'LOW_RISK',
        primaryReasons: []
      });
      assert.equal(decision.status, 'APPROVED');
    });

    test('REVIEW_REQUIRED routes to UNDER_REVIEW', () => {
      const policy = new ApprovalPolicy();
      const decision = policy.evaluateApprovalDecision({
        riskLevel: 'REVIEW_REQUIRED',
        primaryReasons: ['Manual check requested']
      });
      assert.equal(decision.status, 'UNDER_REVIEW');
    });

    test('HIGH_RISK routes to FLAGGED', () => {
      const policy = new ApprovalPolicy();
      const decision = policy.evaluateApprovalDecision({
        riskLevel: 'HIGH_RISK',
        primaryReasons: ['Excessive velocity spike detected']
      });
      assert.equal(decision.status, 'FLAGGED');
    });

    test('buildStaffSubmissionDetailRow renders all 5 required actions within Discord button limits', () => {
      const sub = { id: 'sub_test_123', status: 'FLAGGED', url: 'https://youtube.com/shorts/dQw4w9WgXcQ', platform: 'YOUTUBE' };
      const rows = buildStaffSubmissionDetailRow(sub);
      assert.ok(Array.isArray(rows));
      assert.ok(rows.length >= 1);

      // Verify each row complies with Discord 5-button max
      for (const row of rows) {
        assert.ok(row.components.length <= 5, 'Row exceeds Discord 5-button maximum');
      }

      // Collect all custom IDs / URLs across rows
      const allButtons = rows.flatMap(r => r.components.map(c => c.data.custom_id || c.data.url));

      // Verify the 5 staff review actions exist:
      assert.ok(allButtons.some(id => id.startsWith('admin_sub_approve:')), 'Approve button missing');
      assert.ok(allButtons.some(id => id.startsWith('admin_sub_keep_review:')), 'Keep Review button missing');
      assert.ok(allButtons.some(id => id.startsWith('admin_sub_reject_btn:')), 'Reject button missing');
      assert.ok(allButtons.some(id => id.startsWith('admin_sub_analytics:')), 'Analytics button missing');
      assert.ok(allButtons.some(id => id === 'https://youtube.com/shorts/dQw4w9WgXcQ'), 'Open Video link missing');
    });
  });

  describe('3. Polling Eligibility Guards & Continuous Suspicion Detection', () => {
    const activeCampaign = { id: 'camp_1', status: 'ACTIVE' };
    const activeUser = { id: 'u_1', status: 'ACTIVE' };

    test('YouTube and Instagram are eligible for automated polling when approved', () => {
      const ytSub = { platform: 'YOUTUBE', status: 'APPROVED', campaign: activeCampaign, user: activeUser };
      const igSub = { platform: 'INSTAGRAM', status: 'APPROVED', campaign: activeCampaign, user: activeUser };
      assert.equal(evaluatePollingEligibility(ytSub).eligible, true);
      assert.equal(evaluatePollingEligibility(igSub).eligible, true);
    });

    test('Facebook and TikTok are eligible for automated polling when approved', () => {
      const fbSub = { platform: 'FACEBOOK', status: 'APPROVED', campaign: activeCampaign, user: activeUser };
      const ttSub = { platform: 'TIKTOK', status: 'APPROVED', campaign: activeCampaign, user: activeUser };
      assert.equal(evaluatePollingEligibility(fbSub).eligible, true);
      assert.equal(evaluatePollingEligibility(ttSub).eligible, true);
    });

    test('Under review and flagged clips are barred from polling', () => {
      const underReview = { platform: 'YOUTUBE', status: 'UNDER_REVIEW', campaign: activeCampaign, user: activeUser };
      const flagged = { platform: 'YOUTUBE', status: 'FLAGGED', campaign: activeCampaign, user: activeUser };
      const postApproval = { platform: 'YOUTUBE', status: 'POST_APPROVAL_REVIEW', campaign: activeCampaign, user: activeUser };
      assert.equal(evaluatePollingEligibility(underReview).eligible, false);
      assert.equal(evaluatePollingEligibility(flagged).eligible, false);
      assert.equal(evaluatePollingEligibility(postApproval).eligible, false);
    });
  });

  describe('4. Daily Retention Monitoring & Error Distinction', () => {
    test('Distinguishes permanent deletion (NOT_FOUND) from transient/rate-limiting/data unavailable', async () => {
      const mockDb = {
        submission: {
          findUnique: async () => ({
            id: 'sub_deleted_1',
            status: 'APPROVED',
            retentionStatus: 'ACTIVE',
            retentionRequired: true,
            retentionDeadline: new Date(Date.now() + 86400000),
            platform: 'YOUTUBE',
            url: 'https://youtube.com/shorts/dQw4w9WgXcQ',
            campaign: { id: 'c1', name: 'Test Campaign' },
            user: { id: 'u1', discordId: '123456789' }
          }),
          update: async ({ data }) => ({ id: 'sub_deleted_1', ...data })
        },
        user: { update: async () => ({}) }
      };

      const mockAdjustmentService = {
        recordFinancialAdjustment: async () => ({ id: 'adj_1' }),
        createRetentionViolationAdjustments: async () => []
      };

      const mockAuditRepo = {
        createAuditLog: async () => ({ id: 'audit_1' }),
        recordEvent: async () => ({ id: 'audit_1' })
      };

      const mockProviderResolver = () => ({
        getAvailability: async () => ({
          isAvailable: false,
          status: 'UNAVAILABLE',
          reason: 'Video removed from YouTube (404 Not Found)'
        })
      });

      const retentionService = new RetentionService(mockDb, mockAdjustmentService, mockAuditRepo, mockProviderResolver);
      const result = await retentionService.checkSubmissionRetention('sub_deleted_1');

      assert.equal(result.status, 'VIOLATED');
      assert.match(result.reason, /404 Not Found/);
    });

    test('Transient error (DATA_UNAVAILABLE) keeps retention ACTIVE without penalty', async () => {
      let updatedData = null;
      const mockDb = {
        submission: {
          findUnique: async () => ({
            id: 'sub_transient_1',
            status: 'APPROVED',
            retentionStatus: 'ACTIVE',
            retentionRequired: true,
            retentionDeadline: new Date(Date.now() + 86400000),
            platform: 'TIKTOK',
            url: 'https://www.tiktok.com/@user/video/7123456789012345678',
            campaign: { id: 'c1', name: 'Test Campaign' },
            user: { id: 'u1', discordId: '123456789' }
          }),
          update: async ({ data }) => {
            updatedData = data;
            return { id: 'sub_transient_1', ...data };
          }
        }
      };

      const mockAdjustmentService = {};
      const mockAuditRepo = {};

      const mockProviderResolver = () => ({
        getAvailability: async () => ({
          status: 'DATA_UNAVAILABLE',
          reason: 'Manual verification platform'
        })
      });

      const retentionService = new RetentionService(mockDb, mockAdjustmentService, mockAuditRepo, mockProviderResolver);
      const result = await retentionService.checkSubmissionRetention('sub_transient_1');

      assert.equal(result.status, 'ACTIVE');
      assert.equal(result.availability, 'DATA_UNAVAILABLE');
      assert.equal(updatedData.lastAvailabilityStatus, 'DATA_UNAVAILABLE');
    });
  });

  describe('5. Creator & Staff Dashboard Hardening & Warning Persistence', () => {
    test('Creator dashboard displays persistent 30-day early deletion warning when violated', () => {
      const user = { username: 'PeakCreator', discordId: '123456789' };
      const dashboardData = {
        availableBalance: '50.00',
        activeClipsCount: 2,
        approvedClipsCount: 1,
        underReviewClipsCount: 1,
        totalViews: 1000,
        eligibleViews: 1000,
        currency: 'USD',
        earlyDeletionAlert: true,
        hasRetentionViolation: true
      };

      const embed = buildCreatorDashboardEmbed(dashboardData, user);
      assert.ok(embed.data.description.includes('⚠️ **WARNING: Video Removed Before 30 Days**'));
    });

    test('Admin Control Center Embed displays all 5 clip operational queues with accurate live counts', () => {
      const metrics = {
        pendingReviewCount: 3,
        suspiciousClipsCount: 2,
        trackingCount: 15,
        deletionAlertsCount: 1,
        retentionMonitoringCount: 10,
        payoutQueueCount: 4,
        creatorsRequiringAttention: 1,
        totalCreatorsCount: 50,
        activeCampaignsCount: 3,
        systemStatus: 'OPERATIONAL'
      };

      const embed = buildAdminControlCenterEmbed(metrics, { id: '999' });
      const opsField = embed.data.fields.find(f => f.name === '🎬 CLIP OPERATIONS');
      assert.ok(opsField);
      assert.ok(opsField.value.includes('**3** clips'));
      assert.ok(opsField.value.includes('**2** clips'));
      assert.ok(opsField.value.includes('**15** clips'));
      assert.ok(opsField.value.includes('**1** alerts'));
      assert.ok(opsField.value.includes('**10** active'));
    });

    test('Admin Control Center action rows include 1-click buttons for all queues', () => {
      const rows = buildAdminControlCenterRows();
      assert.equal(rows.length, 3);

      const allButtonIds = rows.flatMap(r => r.components.map(b => b.data.custom_id));
      assert.ok(allButtonIds.includes(staffIds.reviewQueue(1)));
      assert.ok(allButtonIds.includes(staffIds.suspicious(1)));
      assert.ok(allButtonIds.includes(staffIds.payoutQueue(1)));
      assert.ok(allButtonIds.includes(staffIds.tracking(1)));
      assert.ok(allButtonIds.includes(staffIds.deletions(1)));
      assert.ok(allButtonIds.includes(staffIds.monitoring(1)));
    });
  });

  describe('6. Actionable Staff Notifications with Direct Interactive Buttons', () => {
    test('notifyStaffSuspiciousClip sends embed with [🔎 Review Now] button to #review-queue', async () => {
      let sentMessage = null;
      const fakeChannel = {
        name: 'review-queue',
        send: async (payload) => {
          sentMessage = payload;
          return { id: 'msg_suspicious_1' };
        }
      };
      const fakeClient = {
        guilds: {
          cache: new Map([
            ['g1', {
              channels: {
                cache: new Map([['c1', fakeChannel]])
              }
            }]
          ])
        }
      };

      const submission = {
        id: 'sub_sus_456',
        platform: 'YOUTUBE',
        url: 'https://youtube.com/shorts/dQw4w9WgXcQ',
        user: { discordId: 'creator_123', username: 'TestCreator' },
        campaign: { name: 'Growth Campaign' }
      };

      await notifyStaffSuspiciousClip({
        submission,
        reason: 'EXCESSIVE_VELOCITY_SPIKE',
        snapshot: { views: 50000 },
        client: fakeClient
      });

      assert.ok(sentMessage);
      assert.ok(sentMessage.embeds);
      assert.ok(sentMessage.components);
      const button = sentMessage.components[0].components[0];
      assert.equal(button.data.custom_id, staffIds.subView('sub_sus_456'));
      assert.equal(button.data.label, '🔎 Review Now');
    });

    test('notifyStaffEarlyDeletion sends embed with [⚠️ Inspect Submission] button', async () => {
      let sentMessage = null;
      const fakeChannel = {
        name: 'review-queue',
        send: async (payload) => {
          sentMessage = payload;
          return { id: 'msg_deletion_1' };
        }
      };
      const fakeClient = {
        guilds: {
          cache: new Map([
            ['g1', {
              channels: {
                cache: new Map([['c1', fakeChannel]])
              }
            }]
          ])
        }
      };

      const submission = {
        id: 'sub_del_789',
        platform: 'YOUTUBE',
        url: 'https://youtube.com/shorts/dQw4w9WgXcQ',
        user: { discordId: 'creator_123', username: 'TestCreator' },
        campaign: { name: 'Awesome Campaign' }
      };

      await notifyStaffEarlyDeletion({
        submission,
        reason: 'NOT_FOUND: Video removed by author',
        client: fakeClient
      });

      assert.ok(sentMessage);
      const button = sentMessage.components[0].components[0];
      assert.equal(button.data.custom_id, staffIds.subView('sub_del_789'));
      assert.equal(button.data.label, '⚠️ Inspect Submission');
    });

    test('notifyStaffPayoutRequested sends embed with [💸 Review Payout] button to #payout-queue', async () => {
      let sentMessage = null;
      const fakeChannel = {
        name: 'payout-queue',
        send: async (payload) => {
          sentMessage = payload;
          return { id: 'msg_payout_1' };
        }
      };
      const fakeClient = {
        guilds: {
          cache: new Map([
            ['g1', {
              channels: {
                cache: new Map([['c1', fakeChannel]])
              }
            }]
          ])
        }
      };

      const payoutRequest = {
        id: 'payout_999',
        userId: 'u_123',
        amount: 75.50,
        currency: 'USD'
      };

      await notifyStaffPayoutRequested({
        payoutRequest,
        user: { discordId: 'creator_456', username: 'CoolCreator' },
        client: fakeClient
      });

      assert.ok(sentMessage);
      const button = sentMessage.components[0].components[0];
      assert.equal(button.data.custom_id, staffIds.pqViewReq('payout_999'));
      assert.equal(button.data.label, '💸 Review Payout');
    });
  });
});
