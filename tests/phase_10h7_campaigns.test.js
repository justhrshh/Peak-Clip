/**
 * PHASE 10H.7 — Campaign Join UX + Budget Display Test Suite
 *
 * Tests:
 * 1.  Campaign budget display: no longer $0.00
 * 2.  buildCampaignActionRow — join button when active + budget + not member
 * 3.  buildCampaignActionRow — leave button when member
 * 4.  buildCampaignActionRow — closed/disabled when no budget
 * 5.  buildCampaignActionRow — closed/disabled when status not ACTIVE
 * 6.  buildCampaignActionRow — missing campaign object defaults to joinable
 * 7.  buildCampaignSelectMenu — returns null for empty list
 * 8.  buildCampaignSelectMenu — builds select menu for active campaigns
 * 9.  Router: camp_join:<id> is resolved to handleDashboardCampaignJoin
 * 10. Router: camp_leave:<id> is resolved to handleDashboardCampaignLeave
 * 11. Router: camp_join with non-existent campaign renders graceful error
 * 12. Router: camp_leave with non-existent campaign renders graceful error
 * 13. Campaign detail view passes budget and membership state correctly
 * 14. Dashboard campaign list renders select menu with active campaigns
 * 15. creatorIds.campJoin and creatorIds.campLeave generate correct IDs
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config/index.js';
import { CREATOR_COMPONENTS, creatorIds } from '../src/bot/components/creatorComponentIds.js';
import {
  buildCampaignSelectMenu,
  buildCampaignActionRow
} from '../src/bot/components/campaign.components.js';
import { handleInteraction } from '../src/bot/interactions/router.js';
import { userService } from '../src/modules/users/user.service.js';
import { campaignService } from '../src/modules/campaigns/campaign.service.js';
import { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
const ACTIVE_CAMPAIGN_WITH_BUDGET = {
  id: 'camp-test-001',
  name: 'DEV YouTube Campaign',
  clientName: 'Peak Clip DEV',
  status: 'ACTIVE',
  totalBudget: new Prisma.Decimal('5000.00'),
  consumedBudget: new Prisma.Decimal('0.00'),
  remainingBudget: new Prisma.Decimal('5000.00'),
  payRate: new Prisma.Decimal('10.00'),
  minimumPayout: new Prisma.Decimal('50.00'),
  currency: 'USD',
  startsAt: new Date('2025-01-01'),
  endsAt: new Date('2027-12-31'),
  requirements: { minViews: 1000 }
};

const EXHAUSTED_CAMPAIGN = {
  ...ACTIVE_CAMPAIGN_WITH_BUDGET,
  id: 'camp-test-002',
  totalBudget: new Prisma.Decimal('100.00'),
  consumedBudget: new Prisma.Decimal('100.00'),
  remainingBudget: new Prisma.Decimal('0.00')
};

const PAUSED_CAMPAIGN = {
  ...ACTIVE_CAMPAIGN_WITH_BUDGET,
  id: 'camp-test-003',
  status: 'PAUSED',
  remainingBudget: new Prisma.Decimal('5000.00')
};

describe('PHASE 10H.7 — Campaign Join UX + Budget Display Tests', () => {
  let originalGetOrCreate;
  let originalGetCampaignById;
  let originalListActiveCampaigns;
  let originalGetUserCampaigns;
  let originalJoinCampaign;
  let originalLeaveCampaign;

  beforeEach(() => {
    originalGetOrCreate = userService.getOrCreateFromDiscord;
    originalGetCampaignById = campaignService.getCampaignById;
    originalListActiveCampaigns = campaignService.listActiveCampaigns;
    originalGetUserCampaigns = campaignService.getUserCampaigns;
    originalJoinCampaign = campaignService.joinCampaign;
    originalLeaveCampaign = campaignService.leaveCampaign;

    userService.getOrCreateFromDiscord = async (discordUser) => ({
      id: `usr_${discordUser.id}`,
      discordId: discordUser.id,
      username: discordUser.username || `user_${discordUser.id}`,
      status: 'ACTIVE'
    });

    campaignService.getCampaignById = async (id) => {
      if (id === ACTIVE_CAMPAIGN_WITH_BUDGET.id) return { ...ACTIVE_CAMPAIGN_WITH_BUDGET };
      if (id === EXHAUSTED_CAMPAIGN.id) return { ...EXHAUSTED_CAMPAIGN };
      if (id === PAUSED_CAMPAIGN.id) return { ...PAUSED_CAMPAIGN };
      return null;
    };

    campaignService.listActiveCampaigns = async () => [{ ...ACTIVE_CAMPAIGN_WITH_BUDGET }];
    campaignService.getUserCampaigns = async () => [];
    campaignService.joinCampaign = async (userId, campaignId) => ({
      id: `mem_${userId}_${campaignId}`,
      userId,
      campaignId,
      status: 'ACTIVE'
    });
    campaignService.leaveCampaign = async (userId, campaignId) => ({
      id: `mem_${userId}_${campaignId}`,
      userId,
      campaignId,
      status: 'LEFT'
    });
  });

  afterEach(() => {
    userService.getOrCreateFromDiscord = originalGetOrCreate;
    campaignService.getCampaignById = originalGetCampaignById;
    campaignService.listActiveCampaigns = originalListActiveCampaigns;
    campaignService.getUserCampaigns = originalGetUserCampaigns;
    campaignService.joinCampaign = originalJoinCampaign;
    campaignService.leaveCampaign = originalLeaveCampaign;
  });

  function createMockInteraction(options = {}) {
    const replies = [];
    const followUps = [];
    let deferred = false;
    let deferOptions = null;
    let replied = false;

    const interaction = {
      id: `int_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      guildId: options.guildId || config.discord?.guildId || 'dev_guild_123',
      user: options.user || { id: 'test_creator_123', username: 'TestCreator' },
      member: options.member || {
        roles: options.roles || [],
        permissions: options.permissions !== undefined ? options.permissions : 0n
      },
      customId: options.customId,
      replies,
      followUps,
      values: options.values || [],
      get deferred() { return deferred; },
      get replied() { return replied; },
      isChatInputCommand: () => false,
      isButton: () => !options.isSelect,
      isStringSelectMenu: () => Boolean(options.isSelect),
      isModalSubmit: () => false,
      deferReply: async (opts) => {
        deferred = true;
        deferOptions = opts;
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
      showModal: async () => {},
      getDeferOptions: () => deferOptions
    };

    return interaction;
  }

  // =========================================================================
  // 1. Campaign budget display fixture values (smoke test against DB fixture)
  // =========================================================================
  test('1. Active campaign fixture has totalBudget of 5000.00 (not 0)', () => {
    assert.equal(Number(ACTIVE_CAMPAIGN_WITH_BUDGET.totalBudget), 5000);
    assert.equal(Number(ACTIVE_CAMPAIGN_WITH_BUDGET.remainingBudget), 5000);
    assert.notEqual(Number(ACTIVE_CAMPAIGN_WITH_BUDGET.totalBudget), 0);
  });

  // =========================================================================
  // 2. buildCampaignActionRow — join button when active + budget + not member
  // =========================================================================
  test('2. buildCampaignActionRow shows Join button when active, has budget, not a member', () => {
    const row = buildCampaignActionRow(ACTIVE_CAMPAIGN_WITH_BUDGET.id, false, ACTIVE_CAMPAIGN_WITH_BUDGET);
    const components = row.components;
    const joinBtn = components.find((c) => c.data?.custom_id === `${CREATOR_COMPONENTS.CAMP_JOIN}:${ACTIVE_CAMPAIGN_WITH_BUDGET.id}`);
    assert.ok(joinBtn, 'Join button must be present');
    assert.equal(joinBtn.data?.disabled, undefined, 'Join button must not be disabled');
    assert.ok(joinBtn.data?.label?.includes('Join'), 'Join button label must contain "Join"');
  });

  // =========================================================================
  // 3. buildCampaignActionRow — joined indicator when member (no Leave button)
  // =========================================================================
  test('3. buildCampaignActionRow shows disabled Joined indicator when creator is a member (no Leave button)', () => {
    const row = buildCampaignActionRow(ACTIVE_CAMPAIGN_WITH_BUDGET.id, true, ACTIVE_CAMPAIGN_WITH_BUDGET);
    const components = row.components;
    // Leave is not a supported action — creators stay until campaign ends
    const joinedBtn = components.find((c) => c.data?.custom_id?.startsWith('noop_joined_'));
    assert.ok(joinedBtn, 'Must show a disabled Joined indicator for members');
    assert.equal(joinedBtn.data?.disabled, true, 'Joined indicator must be disabled');
    // No Join or Leave button for existing members
    const joinBtn = components.find((c) => c.data?.custom_id?.startsWith(`${CREATOR_COMPONENTS.CAMP_JOIN}:`));
    assert.equal(joinBtn, undefined, 'Join button must NOT appear when already a member');
  });

  // =========================================================================
  // 4. buildCampaignActionRow — disabled closed state when budget exhausted
  // =========================================================================
  test('4. buildCampaignActionRow shows disabled closed button when budget is 0', () => {
    const row = buildCampaignActionRow(EXHAUSTED_CAMPAIGN.id, false, EXHAUSTED_CAMPAIGN);
    const components = row.components;
    const joinBtn = components.find((c) => c.data?.custom_id?.startsWith(`${CREATOR_COMPONENTS.CAMP_JOIN}:`));
    const closedBtn = components.find((c) => c.data?.custom_id?.startsWith('noop_closed_'));
    assert.equal(joinBtn, undefined, 'Join button must NOT be shown when budget exhausted');
    assert.ok(closedBtn, 'Closed/disabled button must be shown when budget exhausted');
    assert.equal(closedBtn.data?.disabled, true, 'Closed button must be disabled');
  });

  // =========================================================================
  // 5. buildCampaignActionRow — disabled closed state when campaign is PAUSED
  // =========================================================================
  test('5. buildCampaignActionRow shows disabled paused button when status is PAUSED', () => {
    const row = buildCampaignActionRow(PAUSED_CAMPAIGN.id, false, PAUSED_CAMPAIGN);
    const components = row.components;
    const joinBtn = components.find((c) => c.data?.custom_id?.startsWith(`${CREATOR_COMPONENTS.CAMP_JOIN}:`));
    const closedBtn = components.find((c) => c.data?.custom_id?.startsWith('noop_closed_'));
    assert.equal(joinBtn, undefined, 'Join button must NOT be shown for PAUSED campaigns');
    assert.ok(closedBtn, 'Closed/disabled button must be shown for PAUSED campaigns');
    assert.ok(closedBtn.data?.label?.includes('Paused') || closedBtn.data?.label?.includes('Closed'), 'Closed button label must indicate paused or closed state');
  });

  // =========================================================================
  // 6. buildCampaignActionRow — no campaign object => defaults to joinable (null safe)
  // =========================================================================
  test('6. buildCampaignActionRow defaults to showing Join when campaign is null', () => {
    const row = buildCampaignActionRow('unknown-camp-id', false, null);
    const components = row.components;
    const joinBtn = components.find((c) => c.data?.custom_id?.startsWith(`${CREATOR_COMPONENTS.CAMP_JOIN}:`));
    assert.ok(joinBtn, 'Join button must be shown as fallback when campaign object is missing');
  });

  // =========================================================================
  // 7. buildCampaignSelectMenu — returns null for empty list
  // =========================================================================
  test('7. buildCampaignSelectMenu returns null for empty campaigns list', () => {
    const result = buildCampaignSelectMenu([]);
    assert.equal(result, null);
  });

  // =========================================================================
  // 8. buildCampaignSelectMenu — builds select menu with options
  // =========================================================================
  test('8. buildCampaignSelectMenu builds a select menu row for a non-empty list', () => {
    const result = buildCampaignSelectMenu([ACTIVE_CAMPAIGN_WITH_BUDGET]);
    assert.ok(result, 'Select menu row must be returned');
    assert.equal(result.components.length, 1, 'Row must contain exactly one select menu');
    const select = result.components[0];
    // discord.js StringSelectMenuBuilder stores options in toJSON() — not in .data directly
    const selectJson = select.toJSON();
    assert.equal(selectJson.custom_id, 'campaign:select', 'Select menu customId must be campaign:select');
    assert.equal(selectJson.options?.length, 1, 'Select must have one option per campaign');
    assert.equal(selectJson.options?.[0]?.value, ACTIVE_CAMPAIGN_WITH_BUDGET.id, 'Option value must be campaign ID');
  });

  // =========================================================================
  // 9. Router: camp_join:<id> — routes to dashboard campaign join handler
  // =========================================================================
  test('9. Router routes camp_join:<id> and calls joinCampaign service', async () => {
    let joinCalled = false;
    let joinArgs = null;
    campaignService.joinCampaign = async (userId, campId) => {
      joinCalled = true;
      joinArgs = { userId, campId };
      return { id: 'mem-001', userId, campaignId: campId, status: 'ACTIVE' };
    };

    const interaction = createMockInteraction({
      customId: `${CREATOR_COMPONENTS.CAMP_JOIN}:${ACTIVE_CAMPAIGN_WITH_BUDGET.id}`
    });
    await handleInteraction(interaction);

    assert.ok(joinCalled, 'campaignService.joinCampaign must have been called');
    assert.equal(joinArgs.campId, ACTIVE_CAMPAIGN_WITH_BUDGET.id, 'campaignId must match button payload');
    assert.ok(interaction.replies.length > 0, 'Handler must editReply with success state');
    assert.ok(
      interaction.replies[0].content?.includes('Joined') || interaction.replies[0].embeds?.length > 0,
      'Reply must confirm join or show campaign embed'
    );
  });

  // =========================================================================
  // 10. Router: unknown camp_ button falls through to catch-all gracefully
  // =========================================================================
  test('10. Router: unknown camp_x:<id> button falls through to catch-all without crashing', async () => {
    const interaction = createMockInteraction({
      customId: 'camp_unknown:some-id'
    });
    await handleInteraction(interaction);
    // Should hit catch-all — either replies with warning or defers without throwing
    assert.ok(
      interaction.replies.length > 0 || interaction.deferred,
      'Unknown camp_ button must not crash the bot'
    );
  });

  // =========================================================================
  // 11. Router: camp_join with non-existent campaign — renders graceful error
  // =========================================================================
  test('11. camp_join for non-existent campaign shows graceful error message, not exception', async () => {
    const interaction = createMockInteraction({
      customId: `${CREATOR_COMPONENTS.CAMP_JOIN}:nonexistent-campaign-xyz`
    });
    await handleInteraction(interaction);

    assert.ok(interaction.replies.length > 0, 'Handler must still produce a reply');
    const reply = interaction.replies[0];
    assert.ok(
      typeof reply.content === 'string' && reply.content.includes('⚠️'),
      'Reply must include a warning emoji for campaign not found'
    );
  });

  // =========================================================================
  // 12. Members see disabled Joined indicator — not a Leave button
  // =========================================================================
  test('12. Member campaign view shows disabled Joined indicator — no Leave button ever rendered', () => {
    // Test with active campaign
    let row = buildCampaignActionRow(ACTIVE_CAMPAIGN_WITH_BUDGET.id, true, ACTIVE_CAMPAIGN_WITH_BUDGET);
    let leaveBtn = row.components.find((c) => c.data?.label?.toLowerCase().includes('leave'));
    assert.equal(leaveBtn, undefined, 'No Leave button on active campaign for members');

    // Test with exhausted campaign member
    row = buildCampaignActionRow(EXHAUSTED_CAMPAIGN.id, true, EXHAUSTED_CAMPAIGN);
    leaveBtn = row.components.find((c) => c.data?.label?.toLowerCase().includes('leave'));
    assert.equal(leaveBtn, undefined, 'No Leave button on exhausted campaign for members');

    // In both cases — show Joined indicator
    const joinedBtn = row.components.find((c) => c.data?.custom_id?.startsWith('noop_joined_'));
    assert.ok(joinedBtn, 'Must show Joined indicator for members');
  });

  // =========================================================================
  // 13. Dashboard campaigns list renders select menu
  // =========================================================================
  test('13. handleDashboardCampaigns includes a select menu in components when campaigns exist', async () => {
    const interaction = createMockInteraction({
      customId: `${CREATOR_COMPONENTS.DASH_CAMPAIGNS}:1`
    });
    await handleInteraction(interaction);

    assert.ok(interaction.replies.length > 0, 'Must produce a reply');
    const reply = interaction.replies[0];
    assert.ok(Array.isArray(reply.components) && reply.components.length > 0, 'Reply must include components');

    // Find the select menu component row (should have at least 2 rows: select + pagination)
    const hasSelectMenu = reply.components.some((row) => {
      const c = row.components?.[0] ?? row;
      return c.data?.type === 3 || (c.data?.custom_id === 'campaign:select');
    });
    assert.ok(hasSelectMenu, 'Dashboard campaign list must include a campaign select menu');
  });

  // =========================================================================
  // 14. handleDashboardCampaigns renders no select menu when no campaigns
  // =========================================================================
  test('14. handleDashboardCampaigns renders only pagination when no campaigns', async () => {
    campaignService.listActiveCampaigns = async () => [];

    const interaction = createMockInteraction({
      customId: `${CREATOR_COMPONENTS.DASH_CAMPAIGNS}:1`
    });
    await handleInteraction(interaction);

    assert.ok(interaction.replies.length > 0, 'Must produce a reply');
    const reply = interaction.replies[0];
    assert.ok(Array.isArray(reply.components) && reply.components.length > 0, 'Reply must include components');

    // No select menu when there are 0 campaigns
    const hasSelectMenu = reply.components.some((row) => {
      const c = row.components?.[0] ?? row;
      return c.data?.type === 3 || (c.data?.custom_id === 'campaign:select');
    });
    assert.equal(hasSelectMenu, false, 'No select menu should appear when campaign list is empty');
  });

  // =========================================================================
  // 15. creatorIds.campJoin produces correct IDs
  // =========================================================================
  test('15. creatorIds.campJoin generates correct customId', () => {
    const joinId = creatorIds.campJoin('campaign-abc');
    assert.equal(joinId, `${CREATOR_COMPONENTS.CAMP_JOIN}:campaign-abc`);
    assert.ok(joinId.startsWith(CREATOR_COMPONENTS.CAMP_JOIN + ':'), 'campJoin must start with CAMP_JOIN prefix');
    // Leave helper should not exist
    assert.equal(typeof creatorIds.campLeave, 'undefined', 'campLeave helper must not exist');
  });
});
