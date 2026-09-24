/**
 * PHASE 10H.7 — Staff Button Routing Audit & Live Fix Test Suite
 *
 * Validates:
 * 1.  STAFF_COMPONENTS constants & staffIds generator helpers
 * 2.  buildAdminControlCenterRows & buildAdminNavRow customId consistency
 * 3.  Zero-trust server-side authorization enforcement before deferUpdate
 * 4.  Unauthorized button interactions receive immediate ephemeral 🔒 rejection
 * 5.  Authorized button interactions defer update in-place and render proper embeds:
 *     - Review Queue (admin_dash_reviews:1)
 *     - Payout Queue (admin_dash_payouts:1)
 *     - Active Campaigns (admin_dash_campaigns:1)
 *     - Creator Directory (admin_dash_creators:1)
 *     - Operational Reports (admin_dash_reports)
 *     - Dashboard Refresh (admin_dash_refresh)
 *     - Control Center Home / Back (admin_dash_home)
 * 6.  Unknown or expired button fallback
 * 7.  Error isolation: non-ephemeral message button errors use followUp rather than overwriting channel message
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, PermissionsBitField } from 'discord.js';
import { config } from '../src/config/index.js';
import { STAFF_COMPONENTS, staffIds } from '../src/bot/components/staffComponentIds.js';
import {
  buildAdminControlCenterRows,
  buildAdminNavRow
} from '../src/bot/components/dashboard.components.js';
import { handleInteraction } from '../src/bot/interactions/router.js';
import { adminSubmissionService } from '../src/modules/admin/admin.submission.service.js';
import { adminPayoutService } from '../src/modules/admin/admin.payout.service.js';
import { adminCreatorService } from '../src/modules/admin/admin.creator.service.js';
import { campaignService } from '../src/modules/campaigns/campaign.service.js';

describe('PHASE 10H.7 — Staff Button Routing Audit & Live Fix Tests', () => {
  // Mocks tracking
  let origListReviewQueue;
  let origListPayoutRequests;
  let origSearchCreators;
  let origListActiveCampaigns;

  beforeEach(() => {
    origListReviewQueue = adminSubmissionService.listReviewQueue;
    origListPayoutRequests = adminPayoutService.listPayoutRequests;
    origSearchCreators = adminCreatorService.searchCreators;
    origListActiveCampaigns = campaignService.listActiveCampaigns;

    adminSubmissionService.listReviewQueue = async () => [];
    adminPayoutService.listPayoutRequests = async () => [];
    adminCreatorService.searchCreators = async () => [];
    campaignService.listActiveCampaigns = async () => [];
  });

  afterEach(() => {
    adminSubmissionService.listReviewQueue = origListReviewQueue;
    adminPayoutService.listPayoutRequests = origListPayoutRequests;
    adminCreatorService.searchCreators = origSearchCreators;
    campaignService.listActiveCampaigns = origListActiveCampaigns;
  });

  function createMockInteraction(options = {}) {
    const replies = [];
    const followUps = [];
    let deferred = false;
    let replied = false;

    return {
      id: `int_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      guildId: options.guildId || config.discord?.guildId || 'dev_guild_123',
      user: options.user || { id: 'staff_user_1', username: 'StaffMember' },
      member: options.member || {
        roles: options.roles || [],
        permissions: options.permissions !== undefined ? options.permissions : PermissionsBitField.Flags.Administrator
      },
      message: options.message || {
        id: 'msg_dashboard_persistent',
        flags: {
          has: (flag) => (options.isEphemeralMessage ? flag === MessageFlags.Ephemeral : false)
        }
      },
      customId: options.customId,
      replies,
      followUps,
      get deferred() {
        return deferred;
      },
      get replied() {
        return replied;
      },
      isChatInputCommand: () => false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferReply: async () => {
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
      }
    };
  }

  // =========================================================================
  // 1. CONSTANTS AND GENERATORS
  // =========================================================================
  describe('1. STAFF_COMPONENTS & staffIds Generators', () => {
    test('STAFF_COMPONENTS matches expected single source of truth IDs', () => {
      assert.equal(STAFF_COMPONENTS.HOME, 'admin_dash_home');
      assert.equal(STAFF_COMPONENTS.REFRESH, 'admin_dash_refresh');
      assert.equal(STAFF_COMPONENTS.REVIEW_QUEUE, 'admin_dash_reviews');
      assert.equal(STAFF_COMPONENTS.PAYOUT_QUEUE, 'admin_dash_payouts');
      assert.equal(STAFF_COMPONENTS.CAMPAIGNS, 'admin_dash_campaigns');
      assert.equal(STAFF_COMPONENTS.CREATORS, 'admin_dash_creators');
      assert.equal(STAFF_COMPONENTS.REPORTS, 'admin_dash_reports');
      assert.equal(STAFF_COMPONENTS.SUB_APPROVE, 'admin_sub_approve');
      assert.equal(STAFF_COMPONENTS.PAYOUT_APPROVE, 'admin_payout_approve');
      assert.equal(STAFF_COMPONENTS.PAYOUT_PROCESS, 'admin_payout_process');
    });

    test('staffIds helper methods generate exact formatted IDs', () => {
      assert.equal(staffIds.home(), 'admin_dash_home');
      assert.equal(staffIds.refresh(), 'admin_dash_refresh');
      assert.equal(staffIds.reviewQueue(1), 'admin_dash_reviews:1');
      assert.equal(staffIds.reviewQueue(3), 'admin_dash_reviews:3');
      assert.equal(staffIds.payoutQueue(1), 'admin_dash_payouts:1');
      assert.equal(staffIds.campaigns(1), 'admin_dash_campaigns:1');
      assert.equal(staffIds.creators(2), 'admin_dash_creators:2');
      assert.equal(staffIds.reports(), 'admin_dash_reports');
      assert.equal(staffIds.back(), 'admin_dash_home');
      assert.equal(staffIds.back('custom_back'), 'custom_back');
    });
  });

  // =========================================================================
  // 2. COMPONENT BUILDERS CONSISTENCY
  // =========================================================================
  describe('2. Component Builders Consistency', () => {
    test('buildAdminControlCenterRows generates rows with all required staff buttons', () => {
      const rows = buildAdminControlCenterRows();
      assert.equal(rows.length, 3);

      const allIds = rows.flatMap(r => r.components.map(c => c.data.custom_id));
      assert.ok(allIds.includes('admin_dash_reviews:1'));
      assert.ok(allIds.includes('admin_dash_suspicious:1'));
      assert.ok(allIds.includes('admin_dash_payouts:1'));
      assert.ok(allIds.includes('admin_dash_tracking:1'));
      assert.ok(allIds.includes('admin_dash_deletions:1'));
      assert.ok(allIds.includes('admin_dash_monitoring:1'));
      assert.ok(allIds.includes('admin_dash_creators:1'));
      assert.ok(allIds.includes('admin_dash_campaigns:1'));
      assert.ok(allIds.includes('admin_dash_reports'));
      assert.ok(allIds.includes('admin_dash_refresh'));
    });

    test('buildAdminNavRow generates back and control center buttons', () => {
      const row = buildAdminNavRow();
      assert.equal(row.components.length, 2);
      assert.equal(row.components[0].data.custom_id, 'admin_dash_back');
      assert.equal(row.components[1].data.custom_id, 'admin_dash_home');
    });
  });

  // =========================================================================
  // 3. ZERO-TRUST AUTHORIZATION BEFORE ACKNOWLEDGEMENT
  // =========================================================================
  describe('3. Zero-Trust Server-Side Authorization Enforcement', () => {
    const unauthOptions = {
      user: { id: 'unauth_user_999', username: 'RegularCreator' },
      roles: ['creator_role_id'],
      permissions: 0n // No Admin permissions
    };

    test('unauthorized user clicking Review Queue is rejected ephemerally and does NOT deferUpdate', async () => {
      const interaction = createMockInteraction({ ...unauthOptions, customId: 'admin_dash_reviews:1' });
      await handleInteraction(interaction);

      // Invariant: assertAdminPermission threw BEFORE deferUpdate()
      assert.equal(interaction.deferred, false, 'Unauthorized click must NOT defer the interaction');
      assert.equal(interaction.replied, true, 'Unauthorized click must reply directly');
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].content, /do not have permission/i);
      assert.ok(
        interaction.replies[0].flags === MessageFlags.Ephemeral || (interaction.replies[0].flags & 64) !== 0,
        'Must reply ephemerally'
      );
    });

    test('unauthorized user clicking Payout Queue is rejected ephemerally', async () => {
      const interaction = createMockInteraction({ ...unauthOptions, customId: 'admin_dash_payouts:1' });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, false);
      assert.equal(interaction.replied, true);
      assert.match(interaction.replies[0].content, /do not have permission/i);
    });

    test('unauthorized user clicking Campaigns is rejected ephemerally', async () => {
      const interaction = createMockInteraction({ ...unauthOptions, customId: 'admin_dash_campaigns:1' });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, false);
      assert.equal(interaction.replied, true);
      assert.match(interaction.replies[0].content, /do not have permission/i);
    });

    test('unauthorized user clicking Creators is rejected ephemerally', async () => {
      const interaction = createMockInteraction({ ...unauthOptions, customId: 'admin_dash_creators:1' });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, false);
      assert.equal(interaction.replied, true);
      assert.match(interaction.replies[0].content, /do not have permission/i);
    });

    test('unauthorized user clicking Reports is rejected ephemerally', async () => {
      const interaction = createMockInteraction({ ...unauthOptions, customId: 'admin_dash_reports' });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, false);
      assert.equal(interaction.replied, true);
      assert.match(interaction.replies[0].content, /do not have permission/i);
    });

    test('unauthorized user clicking Control Center Refresh is rejected ephemerally', async () => {
      const interaction = createMockInteraction({ ...unauthOptions, customId: 'admin_dash_refresh' });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, false);
      assert.equal(interaction.replied, true);
      assert.match(interaction.replies[0].content, /do not have permission/i);
    });
  });

  // =========================================================================
  // 4. AUTHORIZED STAFF NAVIGATION
  // =========================================================================
  describe('4. Authorized Staff Navigation & Dashboard Updates', () => {
    test('authorized admin clicking Review Queue defers update and renders review queue embed', async () => {
      const interaction = createMockInteraction({ customId: 'admin_dash_reviews:1' });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true, 'Authorized staff interaction must defer update');
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /Staff Review Queue/i);
    });

    test('authorized admin clicking Payout Queue defers update and renders payout queue embed', async () => {
      const interaction = createMockInteraction({ customId: 'admin_dash_payouts:1' });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /Staff Payout Review Queue/i);
    });

    test('authorized admin clicking Campaigns defers update and renders campaigns embed', async () => {
      const interaction = createMockInteraction({ customId: 'admin_dash_campaigns:1' });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /Active Campaign Management/i);
    });

    test('authorized admin clicking Creators defers update and renders creators embed', async () => {
      const interaction = createMockInteraction({ customId: 'admin_dash_creators:1' });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /Staff Creator Management/i);
    });

    test('authorized admin clicking Reports defers update and renders reports embed', async () => {
      const interaction = createMockInteraction({ customId: 'admin_dash_reports' });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /Administrative System & Performance Reports/i);
    });

    test('authorized admin clicking Refresh defers update and renders Control Center embed', async () => {
      const interaction = createMockInteraction({ customId: 'admin_dash_refresh' });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /CONTROL CENTER/i);
    });

    test('authorized admin clicking Back (admin_dash_home) returns to Control Center embed', async () => {
      const interaction = createMockInteraction({ customId: 'admin_dash_home' });
      await handleInteraction(interaction);

      assert.equal(interaction.deferred, true);
      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].embeds[0].data.title, /CONTROL CENTER/i);
    });
  });

  // =========================================================================
  // 5. ERROR ISOLATION & UNKNOWN BUTTON HANDLING
  // =========================================================================
  describe('5. Error Isolation & Unknown Button Handling', () => {
    test('genuinely unknown button returns graceful unavailable reply', async () => {
      const interaction = createMockInteraction({ customId: 'non_existent_staff_btn_xyz' });
      await handleInteraction(interaction);

      assert.equal(interaction.replies.length, 1);
      assert.match(interaction.replies[0].content, /This button is no longer available/i);
    });

    test('database error after deferUpdate on persistent channel message sends ephemeral followUp', async () => {
      // Force database query to throw
      adminSubmissionService.listReviewQueue = async () => {
        throw new Error('Database connection timeout');
      };

      const interaction = createMockInteraction({
        customId: 'admin_dash_reviews:1',
        isEphemeralMessage: false // Button attached to persistent message in channel
      });

      await handleInteraction(interaction);

      // Invariant: The persistent channel message must NOT be overwritten via editReply
      // Instead, followUp must be called with an ephemeral message to the user!
      assert.equal(interaction.followUps.length, 1, 'Error must be delivered via followUp');
      assert.match(interaction.followUps[0].content, /unexpected error occurred/i);
      assert.ok(
        interaction.followUps[0].flags === MessageFlags.Ephemeral || (interaction.followUps[0].flags & 64) !== 0,
        'followUp error must be ephemeral'
      );
      assert.equal(interaction.replies.length, 0, 'editReply must not be called to overwrite channel message');
    });
  });
});
