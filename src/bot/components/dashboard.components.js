import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder
} from 'discord.js';
import { CREATOR_COMPONENTS, creatorIds } from './creatorComponentIds.js';
import { STAFF_COMPONENTS, staffIds } from './staffComponentIds.js';

/**
 * Build primary and secondary action rows for Creator Center Dashboard
 *
 * @param {string} userId - Internal user UUID
 * @returns {Array<ActionRowBuilder>}
 */
export function buildCreatorDashboardActionRows(userId) {
  // Row 1: Primary buttons (max 5 buttons per row)
  const primaryRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(creatorIds.campaigns(1, userId))
      .setLabel('🎯 Campaigns')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(creatorIds.clips(1, userId))
      .setLabel('🎬 Submissions')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(creatorIds.stats(userId))
      .setLabel('📊 Stats')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(creatorIds.earnings(userId))
      .setLabel('💰 Earnings')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(creatorIds.payout(userId))
      .setLabel('💸 Payouts')
      .setStyle(ButtonStyle.Success)
  );

  // Row 2: Secondary buttons
  const secondaryRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(creatorIds.profile(userId))
      .setLabel('👤 Profile')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(creatorIds.refresh(userId))
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Secondary)
  );

  return [primaryRow, secondaryRow];
}

/**
 * Build standard back/home navigation row
 *
 * @param {string} userId
 * @param {string} [backTarget='home']
 * @returns {ActionRowBuilder}
 */
export function buildNavigationBackRow(userId, backTarget = 'home') {
  const row = new ActionRowBuilder();

  if (backTarget && backTarget !== 'home') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`dash_back:${userId}:${backTarget}`)
        .setLabel('◀ Back')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`dash_home:${userId}`)
      .setLabel('🏠 Dashboard')
      .setStyle(ButtonStyle.Primary)
  );

  return row;
}

/**
 * Build pagination row for lists
 *
 * @param {string} prefix - Custom ID prefix (e.g. 'dash_campaigns' or 'dash_clips')
 * @param {string} userId
 * @param {number} page
 * @param {number} totalPages
 * @param {string} [homeTarget='dash_home']
 * @returns {ActionRowBuilder}
 */
export function buildDashboardPaginationRow(prefix, userId, page, totalPages, homeTarget = 'dash_home') {
  const row = new ActionRowBuilder();

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:${userId}:${page - 1}`)
      .setLabel('◀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`noop_page:${page}`)
      .setLabel(`Page ${page}/${totalPages || 1}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`${prefix}:${userId}:${page + 1}`)
      .setLabel('▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages),
    new ButtonBuilder()
      .setCustomId(`${homeTarget}:${userId}`)
      .setLabel(homeTarget === 'admin_dash_home' ? '🛡️ Control Center' : '🏠 Dashboard')
      .setStyle(ButtonStyle.Primary)
  );

  return row;
}

/**
 * Build action rows for Creator Payout Hub
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {boolean} params.hasProfile
 * @param {boolean} params.hasActivePayout
 * @param {string|null} [params.activePayoutId=null]
 * @param {boolean} [params.canCancel=false]
 * @returns {Array<ActionRowBuilder>}
 */
export function buildPayoutHubActionRows({ userId, hasProfile, hasActivePayout, activePayoutId = null, canCancel = false }) {
  const row1 = new ActionRowBuilder();

  if (!hasProfile) {
    row1.addComponents(
      new ButtonBuilder()
        .setCustomId(`dash_profile_setup:${userId}`)
        .setLabel('💳 Set Up Payout Profile')
        .setStyle(ButtonStyle.Success)
    );
  } else {
    row1.addComponents(
      new ButtonBuilder()
        .setCustomId(`dash_payout_request:${userId}`)
        .setLabel('💸 Request Payout')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`dash_profile_view:${userId}`)
        .setLabel('💳 View Profile')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`dash_profile_edit:${userId}`)
        .setLabel('✏️ Update Profile')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  const row2 = new ActionRowBuilder();

  // Cancel button only displayed for active cancellable payouts (Phase 10C intact)
  if (hasActivePayout && canCancel && activePayoutId) {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(`payout_cancel_btn:${userId}:${activePayoutId}`)
        .setLabel('🛑 Cancel Payout')
        .setStyle(ButtonStyle.Danger)
    );
  }

  row2.addComponents(
    new ButtonBuilder()
      .setCustomId(`dash_home:${userId}`)
      .setLabel('🏠 Dashboard')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`dash_payout:${userId}`)
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Secondary)
  );

  return [row1, row2];
}

/**
 * Build Payout Wizard Action Row
 *
 * @param {string} userId
 * @param {number} step
 * @param {object} [extra={}]
 * @returns {ActionRowBuilder}
 */
export function buildPayoutWizardActionRow(userId, step, extra = {}) {
  const row = new ActionRowBuilder();

  switch (step) {
    case 1:
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`payout_wiz_amount_modal:${userId}`)
          .setLabel('💵 Enter Amount')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`dash_payout:${userId}`)
          .setLabel('◀ Back')
          .setStyle(ButtonStyle.Secondary)
      );
      break;

    case 2:
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`payout_wiz_step:${userId}:3`)
          .setLabel('➡️ Continue to Evidence')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`dash_profile_edit:${userId}`)
          .setLabel('✏️ Update Profile')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`payout_wiz_step:${userId}:1`)
          .setLabel('◀ Back')
          .setStyle(ButtonStyle.Secondary)
      );
      break;

    case 3:
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`payout_wiz_step:${userId}:4`)
          .setLabel('📹 Evidence Ready')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`payout_wiz_step:${userId}:2`)
          .setLabel('◀ Back')
          .setStyle(ButtonStyle.Secondary)
      );
      break;

    case 4:
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`payout_wiz_confirm:${userId}`)
          .setLabel('✅ Submit Payout')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`payout_wiz_step:${userId}:3`)
          .setLabel('◀ Back')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`dash_payout:${userId}`)
          .setLabel('❌ Cancel')
          .setStyle(ButtonStyle.Danger)
      );
      break;
  }

  return row;
}

/**
 * Build Admin Control Center Action Rows
 *
 * @returns {Array<ActionRowBuilder>}
 */
export function buildAdminControlCenterRows() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.reviewQueue(1))
      .setLabel('📋 Review Queue')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(staffIds.suspicious(1))
      .setLabel('⚠️ Suspicious Clips')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(staffIds.payoutQueue(1))
      .setLabel('💸 Payout Queue')
      .setStyle(ButtonStyle.Success)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.tracking(1))
      .setLabel('📡 Active Tracking')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(staffIds.deletions(1))
      .setLabel('🚨 Deletion Alerts')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(staffIds.monitoring(1))
      .setLabel('🛡️ 30-Day Monitoring')
      .setStyle(ButtonStyle.Secondary)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.creators(1))
      .setLabel('👥 Creators')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(staffIds.campaigns(1))
      .setLabel('🎯 Campaigns')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(staffIds.reports())
      .setLabel('📊 Reports')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(staffIds.refresh())
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Secondary)
  );

  return [row1, row2, row3];
}

/**
 * Build Admin Subview Navigation Row
 *
 * @param {string} [backTarget=STAFF_COMPONENTS.HOME]
 * @returns {ActionRowBuilder}
 */
export function buildAdminNavRow(backTarget = STAFF_COMPONENTS.HOME) {
  const actualBack = (backTarget === STAFF_COMPONENTS.HOME) ? (STAFF_COMPONENTS.BACK || 'admin_dash_back') : backTarget;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(actualBack)
      .setLabel('◀ Back')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(STAFF_COMPONENTS.HOME)
      .setLabel('🛡️ Control Center')
      .setStyle(ButtonStyle.Primary)
  );
}

/**
 * Build persistent action row for #campaigns channel
 * @returns {ActionRowBuilder}
 */
export function buildCreatorCampaignsChannelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CREATOR_COMPONENTS.PUB_CAMPAIGNS)
      .setLabel('🎯 Browse Campaigns')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(CREATOR_COMPONENTS.OPEN_DASHBOARD)
      .setLabel('🏠 Dashboard')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(CREATOR_COMPONENTS.PUB_CAMPAIGNS_REFRESH)
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Build persistent action row for #submissions channel
 * @returns {ActionRowBuilder}
 */
export function buildCreatorSubmissionsChannelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CREATOR_COMPONENTS.PUB_SUBMIT)
      .setLabel('🎬 Submit Clip')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(CREATOR_COMPONENTS.PUB_CLIPS)
      .setLabel('📋 My Submissions')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(CREATOR_COMPONENTS.OPEN_DASHBOARD)
      .setLabel('🏠 Dashboard')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(CREATOR_COMPONENTS.PUB_SUBMISSIONS_REFRESH)
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Build persistent action row for #stats channel
 * @returns {ActionRowBuilder}
 */
export function buildCreatorStatsChannelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CREATOR_COMPONENTS.PUB_STATS)
      .setLabel('📊 View Stats')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(CREATOR_COMPONENTS.OPEN_DASHBOARD)
      .setLabel('🏠 Dashboard')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(CREATOR_COMPONENTS.PUB_STATS_REFRESH)
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Build persistent action row for #earnings channel
 * @returns {ActionRowBuilder}
 */
export function buildCreatorEarningsChannelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CREATOR_COMPONENTS.PUB_EARNINGS)
      .setLabel('💰 View Earnings')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(CREATOR_COMPONENTS.OPEN_DASHBOARD)
      .setLabel('🏠 Dashboard')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(CREATOR_COMPONENTS.PUB_EARNINGS_REFRESH)
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Build persistent action row for #payouts channel
 * @returns {ActionRowBuilder}
 */
export function buildCreatorPayoutsChannelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CREATOR_COMPONENTS.PUB_PAYOUT_REQUEST)
      .setLabel('💸 Request Payout')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(CREATOR_COMPONENTS.PUB_PROFILE)
      .setLabel('💳 Payout Profile')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(CREATOR_COMPONENTS.PUB_PAYOUT_HISTORY)
      .setLabel('📋 Payout History')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(CREATOR_COMPONENTS.OPEN_DASHBOARD)
      .setLabel('🏠 Dashboard')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(CREATOR_COMPONENTS.PUB_PAYOUTS_REFRESH)
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Secondary)
  );
}
