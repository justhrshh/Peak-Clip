/**
 * STAFF INTERACTION RESPONSIVENESS & LIFECYCLE REGRESSION TEST SUITE
 *
 * Covers:
 * 1. Staff submission view acknowledges correctly with immediate loading feedback.
 * 2. Staff analytics acknowledges correctly with immediate loading feedback.
 * 3. Refresh metrics acknowledges correctly with immediate loading feedback and disabled button state.
 * 4. Slow database operations get immediate acknowledgement before DB query finishes.
 * 5. Slow provider/API calls get immediate acknowledgement before API query finishes.
 * 6. editReply is only used after defer/reply/update, never throwing InteractionNotReplied.
 * 7. Duplicate clicks don't cause duplicate operations (in-flight deduplication guard).
 * 8. Existing error handling remains intact and surfaces gracefully.
 * 9. Existing audit logging (SUBMISSION_REFRESH_METRICS) remains intact.
 * 10. Existing embed content and interactive button rows remain intact.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import {
  handleStaffSubmissionView,
  handleStaffSubmissionAnalytics,
  handleStaffSubmissionRefreshMetrics,
  showLoadingFeedback,
  safeEditReply,
  inFlightRefreshes
} from '../src/bot/interactions/staff.interactions.js';
import { handleInteraction } from '../src/bot/interactions/router.js';
import { adminSubmissionService } from '../src/modules/admin/admin.submission.service.js';
import { adminAuditService } from '../src/modules/admin/audit.service.js';
import { STAFF_COMPONENTS } from '../src/bot/components/staffComponentIds.js';
import { buildStaffSubmissionDetailEmbed, buildStaffSubmissionAnalyticsEmbed } from '../src/bot/embeds/staff.embeds.js';

describe('Staff Interaction Responsiveness & Lifecycle Tests', () => {
  let origGetSubmissionDetails;
  let origGetSubmissionAnalytics;
  let origRefreshSubmissionMetrics;
  let origAuditLogAction;

  const mockSubmission = {
    id: 'sub_test_resp_123',
    platform: 'YOUTUBE',
    url: 'https://youtube.com/shorts/test12345',
    status: 'UNDER_REVIEW',
    submittedAt: new Date('2026-09-20T10:00:00Z'),
    user: {
      id: 'usr_1',
      discordId: 'discord_creator_1',
      username: 'TestCreator',
      displayName: 'Test Creator',
      status: 'ACTIVE'
    },
    campaign: {
      id: 'cmp_1',
      name: 'Test Campaign',
      currency: 'USD',
      payRate: 2.5
    },
    verifications: [
      {
        id: 'ver_1',
        status: 'PENDING',
        riskLevel: 'LOW_RISK',
        score: 95,
        completedAt: new Date()
      }
    ],
    snapshots: [
      {
        id: 'snap_1',
        views: 15000n,
        likes: 1200n,
        comments: 80n,
        shares: 45n,
        capturedAt: new Date()
      }
    ],
    earnings: [],
    moderationHistory: []
  };

  const mockAnalytics = {
    submission: mockSubmission,
    totalSnapshots: 2,
    page: 1,
    totalPages: 1,
    items: [
      {
        id: 'snap_1',
        capturedAt: new Date(),
        views: 15000,
        likes: 1200,
        comments: 80,
        shares: 45,
        viewsGained: 5000,
        likesGained: 200,
        commentsGained: 10,
        sharesGained: 5,
        engagementRate: '8.83%',
        status: 'AVAILABLE'
      }
    ],
    summary: {
      initialViews: 10000,
      currentViews: 15000,
      totalViewsGained: 5000,
      successfulChecks: 2,
      unavailableChecks: 0,
      trackingDurationHours: 24,
      firstSnapshotAt: new Date(Date.now() - 86400000),
      latestSnapshotAt: new Date()
    }
  };

  beforeEach(() => {
    inFlightRefreshes.clear();

    origGetSubmissionDetails = adminSubmissionService.getSubmissionDetails;
    origGetSubmissionAnalytics = adminSubmissionService.getSubmissionAnalytics;
    origRefreshSubmissionMetrics = adminSubmissionService.refreshSubmissionMetrics;
    origAuditLogAction = adminAuditService.logAction;

    adminSubmissionService.getSubmissionDetails = async () => mockSubmission;
    adminSubmissionService.getSubmissionAnalytics = async () => mockAnalytics;
    adminSubmissionService.refreshSubmissionMetrics = async (subId, actor) => {
      await adminAuditService.logAction({
        actorUserId: null,
        actorDiscordId: actor.discordId,
        action: 'SUBMISSION_REFRESH_METRICS',
        entityType: 'SUBMISSION',
        entityId: subId,
        newState: { lastAvailabilityStatus: 'AVAILABLE' }
      });
      return {
        submission: mockSubmission,
        snapshot: { id: 'snap_new', views: 20000n },
        metrics: { status: 'AVAILABLE', views: 20000n },
        lastAvailabilityStatus: 'AVAILABLE'
      };
    };
  });

  afterEach(() => {
    inFlightRefreshes.clear();
    adminSubmissionService.getSubmissionDetails = origGetSubmissionDetails;
    adminSubmissionService.getSubmissionAnalytics = origGetSubmissionAnalytics;
    adminSubmissionService.refreshSubmissionMetrics = origRefreshSubmissionMetrics;
    adminAuditService.logAction = origAuditLogAction;
  });

  function createMockInteraction(customId = 'admin_sub_view:sub_test_resp_123', options = {}) {
    const events = [];
    let deferred = false;
    let replied = false;

    return {
      id: `int_${Date.now()}`,
      customId,
      user: { id: 'staff_user_1', username: 'Moderator' },
      member: {
        permissions: PermissionsBitField.Flags.Administrator,
        roles: []
      },
      message: {
        id: 'msg_100',
        content: 'Original Content',
        embeds: [{ title: 'Original Embed' }]
      },
      events,
      get deferred() { return deferred; },
      get replied() { return replied; },
      isButton: () => true,
      isChatInputCommand: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      update: async (payload) => {
        events.push({ type: 'update', payload, timestamp: Date.now() });
        replied = true;
        return payload;
      },
      deferUpdate: async () => {
        events.push({ type: 'deferUpdate', timestamp: Date.now() });
        deferred = true;
      },
      deferReply: async (opts) => {
        events.push({ type: 'deferReply', opts, timestamp: Date.now() });
        deferred = true;
      },
      editReply: async (payload) => {
        if (!deferred && !replied) {
          throw new Error('DiscordjsError [InteractionNotReplied]: The reply to this interaction has not been sent or deferred.');
        }
        events.push({ type: 'editReply', payload, timestamp: Date.now() });
        return payload;
      },
      reply: async (payload) => {
        events.push({ type: 'reply', payload, timestamp: Date.now() });
        replied = true;
        return payload;
      }
    };
  }

  // 1. Staff submission view acknowledges correctly
  test('1. Staff submission view acknowledges immediately with loading feedback before editing', async () => {
    const interaction = createMockInteraction('admin_sub_view:sub_test_resp_123');
    await handleStaffSubmissionView(interaction, 'sub_test_resp_123');

    assert.equal(interaction.replied, true);
    assert.ok(interaction.events.length >= 2, 'Should have at least update and editReply events');

    const updateEvent = interaction.events.find((e) => e.type === 'update');
    assert.ok(updateEvent, 'interaction.update must be called for immediate loading state');
    assert.match(updateEvent.payload.content, /Loading submission/i);

    const editEvent = interaction.events.find((e) => e.type === 'editReply');
    assert.ok(editEvent, 'editReply must be called with the final submission embed');
    assert.ok(editEvent.payload.embeds?.length > 0);
  });

  // 2. Staff analytics acknowledges correctly
  test('2. Staff analytics acknowledges immediately with loading feedback', async () => {
    const interaction = createMockInteraction('admin_sub_analytics:sub_test_resp_123:1');
    await handleStaffSubmissionAnalytics(interaction, 'sub_test_resp_123', 1);

    assert.equal(interaction.replied, true);
    const updateEvent = interaction.events.find((e) => e.type === 'update');
    assert.ok(updateEvent, 'interaction.update must be called for analytics loading state');
    assert.match(updateEvent.payload.content, /Loading analytics/i);

    const editEvent = interaction.events.find((e) => e.type === 'editReply');
    assert.ok(editEvent, 'editReply must be called with analytics embed');
    assert.ok(editEvent.payload.embeds?.length > 0);
  });

  // 3. Refresh metrics acknowledges correctly
  test('3. Refresh metrics acknowledges immediately with disabled loading row', async () => {
    const interaction = createMockInteraction('admin_sub_refresh_metrics:sub_test_resp_123');
    await handleStaffSubmissionRefreshMetrics(interaction, 'sub_test_resp_123');

    assert.equal(interaction.replied, true);
    const updateEvent = interaction.events.find((e) => e.type === 'update');
    assert.ok(updateEvent, 'interaction.update must be called for refreshing metrics');
    assert.match(updateEvent.payload.content, /Refreshing metrics/i);
    assert.ok(updateEvent.payload.components?.length > 0, 'Must include disabled refreshing button row');

    const editEvent = interaction.events.find((e) => e.type === 'editReply');
    assert.ok(editEvent, 'editReply must deliver the final refreshed view');
    assert.match(editEvent.payload.content, /Metrics refreshed/i);
  });

  // 4. Slow database operation still gets an immediate acknowledgement
  test('4. Slow database operation still gets immediate acknowledgement', async () => {
    const ackTimes = [];
    adminSubmissionService.getSubmissionDetails = async () => {
      // Simulate slow database delay of 50ms
      await new Promise((resolve) => setTimeout(resolve, 50));
      return mockSubmission;
    };

    const interaction = createMockInteraction('admin_sub_view:sub_test_resp_123');
    const start = Date.now();
    const promise = handleStaffSubmissionView(interaction, 'sub_test_resp_123');

    // Yield execution to allow microtasks and the first await in handleStaffSubmissionView to run
    await new Promise((resolve) => setImmediate(resolve));

    // Interaction should ALREADY be acknowledged before getSubmissionDetails completes
    assert.equal(interaction.replied, true, 'Interaction must be acknowledged before slow DB call completes');
    assert.equal(interaction.events[0].type, 'update');
    assert.ok(Date.now() - start < 45, 'Initial acknowledgement occurred well before 50ms DB delay');

    await promise;
    assert.equal(interaction.events.length, 2);
  });

  // 5. Slow provider/API call still gets an immediate acknowledgement
  test('5. Slow provider/API call still gets immediate acknowledgement', async () => {
    adminSubmissionService.refreshSubmissionMetrics = async () => {
      // Simulate slow external scraper taking 60ms
      await new Promise((resolve) => setTimeout(resolve, 60));
      return {
        submission: mockSubmission,
        snapshot: null,
        metrics: { status: 'AVAILABLE' }
      };
    };

    const interaction = createMockInteraction('admin_sub_refresh_metrics:sub_test_resp_123');
    const start = Date.now();
    const promise = handleStaffSubmissionRefreshMetrics(interaction, 'sub_test_resp_123');

    await new Promise((resolve) => setImmediate(resolve));

    // Must be acknowledged with loading feedback immediately
    assert.equal(interaction.replied, true);
    assert.equal(interaction.events[0].type, 'update');
    assert.match(interaction.events[0].payload.content, /Refreshing metrics/i);
    assert.ok(Date.now() - start < 50, 'Acknowledgement registered before provider finished');

    await promise;
  });

  // 6. editReply is only used after defer/reply (never throws InteractionNotReplied)
  test('6. safeEditReply ensures editReply is only called when deferred or replied', async () => {
    const unacknowledgedInteraction = createMockInteraction('test');
    // deferred=false, replied=false
    assert.equal(unacknowledgedInteraction.deferred, false);
    assert.equal(unacknowledgedInteraction.replied, false);

    // Calling safeEditReply directly on an unacknowledged interaction falls back to update or reply without throwing
    await safeEditReply(unacknowledgedInteraction, { content: 'Fallback content' });
    assert.equal(unacknowledgedInteraction.events[0].type, 'update');
  });

  // 7. Duplicate clicks don't cause duplicate operations
  test('7. Duplicate clicks on Refresh Metrics do not cause duplicate provider runs', async () => {
    let providerRunCount = 0;
    adminSubmissionService.refreshSubmissionMetrics = async () => {
      providerRunCount++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        submission: mockSubmission,
        snapshot: null,
        metrics: { status: 'AVAILABLE' }
      };
    };

    const int1 = createMockInteraction('admin_sub_refresh_metrics:sub_test_resp_123');
    const int2 = createMockInteraction('admin_sub_refresh_metrics:sub_test_resp_123');

    // Fire first click
    const p1 = handleStaffSubmissionRefreshMetrics(int1, 'sub_test_resp_123');
    // Fire second duplicate click immediately
    const p2 = handleStaffSubmissionRefreshMetrics(int2, 'sub_test_resp_123');

    await Promise.all([p1, p2]);

    assert.equal(providerRunCount, 1, 'Provider refresh should only execute once');
    assert.ok(int2.events.some((e) => e.payload?.content?.includes('already in progress')), 'Second click should notify in-progress');
    assert.equal(inFlightRefreshes.has('sub_test_resp_123'), false, 'In-flight set must be cleared after completion');
  });

  // 8. Existing error handling remains intact
  test('8. Existing domain errors and permissions are handled gracefully by router', async () => {
    const unauthInteraction = createMockInteraction('admin_sub_view:sub_test_resp_123');
    unauthInteraction.member.permissions = 0n; // No admin permissions

    await handleInteraction(unauthInteraction);

    assert.ok(
      unauthInteraction.events.some((e) => e.payload?.content?.includes('do not have permission')),
      'Unauthorized interaction should receive permission error'
    );
  });

  // 9. Existing audit logging remains intact
  test('9. Refresh metrics logs SUBMISSION_REFRESH_METRICS audit action', async () => {
    let auditActionLogged = null;
    origAuditLogAction = adminAuditService.logAction;
    adminAuditService.logAction = async (auditData) => {
      auditActionLogged = auditData;
    };

    const interaction = createMockInteraction('admin_sub_refresh_metrics:sub_test_resp_123');
    await handleStaffSubmissionRefreshMetrics(interaction, 'sub_test_resp_123');

    assert.ok(auditActionLogged, 'Audit action must be logged');
    assert.equal(auditActionLogged.action, 'SUBMISSION_REFRESH_METRICS');
    assert.equal(auditActionLogged.entityId, 'sub_test_resp_123');
  });

  // 10. Existing embed content remains intact
  test('10. Existing embed content maintains all metric fields, platform, and author info', () => {
    const detailEmbed = buildStaffSubmissionDetailEmbed(mockSubmission);
    assert.ok(detailEmbed.data.title.toLowerCase().includes('youtube'));
    assert.ok(detailEmbed.data.fields.some((f) => f.name.includes('Metrics') || f.name.includes('Views')));

    const analyticsEmbed = buildStaffSubmissionAnalyticsEmbed(mockAnalytics);
    assert.ok(analyticsEmbed.data.title.includes('Analytics'));
    assert.ok(analyticsEmbed.data.fields.some((f) => f.name.includes('Views Gained') || f.value.includes('5,000')));
  });
});
