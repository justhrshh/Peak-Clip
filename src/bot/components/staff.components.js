import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { staffIds } from './staffComponentIds.js';

/**
 * Review Queue Canonical Hub Row (#review-queue)
 *
 * @param {string|null} [channelName=null]
 * @returns {ActionRowBuilder}
 */
export function buildStaffReviewQueueHubRow(channelName = null) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.rqView(1))
      .setLabel('📋 Open Review Queue')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(staffIds.rqRefresh())
      .setLabel('🔄 Refresh Queue')
      .setStyle(ButtonStyle.Secondary)
  );

  if (channelName === 'creators') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.crHub())
        .setLabel('◀ Back to Creators')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  return row;
}

/**
 * Review Queue List Navigation Row
 *
 * @param {number} [page=1]
 * @param {number} [totalPages=1]
 * @param {Array<object>} [items=[]]
 * @param {string|null} [channelName=null]
 * @returns {Array<ActionRowBuilder>}
 */
export function buildStaffReviewQueueNavRow(page = 1, totalPages = 1, items = [], channelName = null) {
  const list = Array.isArray(items) ? items : (items?.items || []);
  const row1 = new ActionRowBuilder();

  // Add individual review inspect buttons if items exist
  if (list.length > 0) {
    list.slice(0, 5).forEach((sub, i) => {
      const idx = (page - 1) * 5 + i + 1;
      row1.addComponents(
        new ButtonBuilder()
          .setCustomId(staffIds.subView(sub.id))
          .setLabel(`🔎 #${idx}`)
          .setStyle(ButtonStyle.Secondary)
      );
    });
  }

  const row2 = new ActionRowBuilder();
  if (page > 1) {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.rqView(page - 1))
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  row2.addComponents(
    new ButtonBuilder()
      .setCustomId(channelName === 'creators' ? staffIds.crHub() : staffIds.rqHub())
      .setLabel(channelName === 'creators' ? '🏠 Creator Hub' : '🏠 Hub')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(staffIds.rqView(page))
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Secondary)
  );

  if (channelName === 'creators') {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.crHub())
        .setLabel('◀ Back to Creators')
        .setStyle(ButtonStyle.Primary)
    );
  }

  if (page < totalPages) {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.rqView(page + 1))
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  return items.length > 0 ? [row1, row2] : [row2];
}

/**
 * Submission Detail Action Rows
 * Returns an array of rows:
 *   Row 0: [🎬 Open Video] | 📊 Analytics | 🔄 Refresh Metrics | 📂 Registry
 *   Row 1: 🔍 Reverify | [🚩 Flag | ✅ Approve | ❌ Reject] (if actionable)
 */
export function buildStaffSubmissionDetailRow(submissionOrId, currentStatus, videoUrl, platformParam, fromCreatorId = null) {
  let submissionId = submissionOrId;
  let status = currentStatus;
  let url = videoUrl;
  let platform = platformParam || null;

  if (typeof submissionOrId === 'object' && submissionOrId !== null) {
    submissionId = submissionOrId.id;
    status = submissionOrId.status;
    url = submissionOrId.url;
    platform = submissionOrId.platform;
  }

  if (!platform && url && typeof url === 'string') {
    if (url.includes('facebook.com') || url.includes('fb.watch') || url.includes('fb.me')) {
      platform = 'FACEBOOK';
    }
  }

  const rows = [];
  const row1 = new ActionRowBuilder();

  if (url && (typeof url === 'string') && (url.startsWith('http://') || url.startsWith('https://'))) {
    row1.addComponents(
      new ButtonBuilder()
        .setLabel('🎬 Open Video')
        .setStyle(ButtonStyle.Link)
        .setURL(url)
    );
  }

  row1.addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.subAnalytics(submissionId, 1))
      .setLabel('📊 Analytics')
      .setStyle(ButtonStyle.Secondary)
  );

  if (platform === 'FACEBOOK') {
    row1.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.subManualMetrics(submissionId))
        .setLabel('📝 Enter Metrics')
        .setStyle(ButtonStyle.Primary)
    );
  }

  row1.addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.subRefreshMetrics(submissionId))
      .setLabel('🔄 Refresh Metrics')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(staffIds.subRegistry(1, 'ALL', 'ALL'))
      .setLabel('📂 Registry')
      .setStyle(ButtonStyle.Secondary)
  );
  rows.push(row1);

  // Row 2: Moderation actions
  const actionable = !['APPROVED', 'REJECTED'].includes(status);
  const row2 = new ActionRowBuilder();

  row2.addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.subReverify(submissionId))
      .setLabel('🔍 Reverify')
      .setStyle(ButtonStyle.Primary)
  );

  if (actionable) {
    if (status === 'FLAGGED') {
      row2.addComponents(
        new ButtonBuilder()
          .setCustomId(staffIds.subKeepReview(submissionId))
          .setLabel('⏸️ Keep Review')
          .setStyle(ButtonStyle.Secondary)
      );
    } else {
      row2.addComponents(
        new ButtonBuilder()
          .setCustomId(staffIds.subFlag(submissionId))
          .setLabel('🚩 Flag')
          .setStyle(ButtonStyle.Secondary)
      );
    }

    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.subApprove(submissionId))
        .setLabel('✅ Approve')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(staffIds.subRejectBtn(submissionId))
        .setLabel('❌ Reject')
        .setStyle(ButtonStyle.Danger)
    );
  }

  if (fromCreatorId) {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.crSubs(fromCreatorId, 1))
        .setLabel('◀ Back to Submissions')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(staffIds.crHub())
        .setLabel('🏠 Creator Hub')
        .setStyle(ButtonStyle.Secondary)
    );
  } else {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.rqView(1))
        .setLabel(actionable ? '◀ Back' : '◀ Back to Queue')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  rows.push(row2);
  return rows;
}

/**
 * Temporary In-Progress Metric Refresh Action Row
 * Renders disabled loading buttons during in-flight metric refresh.
 *
 * @param {string} submissionId
 * @returns {Array<ActionRowBuilder>}
 */
export function buildStaffSubmissionRefreshingRow(submissionId) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`refreshing_indicator_${submissionId}`)
      .setLabel('🔄 Refreshing metrics...')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );
  return [row];
}

/**
 * Generic Staff Temporary Loading Action Row
 *
 * @param {string} label
 * @returns {Array<ActionRowBuilder>}
 */
export function buildStaffLoadingRow(label = '⏳ Loading...') {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('staff_loading_indicator')
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );
  return [row];
}


/**
 * Creator Hub Canonical Row (#creators)
 */
export function buildStaffCreatorHubRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.crList(1))
      .setLabel('👥 Creator Directory')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(staffIds.crSearchBtn())
      .setLabel('🔍 Search Creator')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(staffIds.crRefresh())
      .setLabel('🔄 Refresh Directory')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Creator List Navigation Row
 */
export function buildStaffCreatorNavRow(page = 1, totalPages = 1, creators = []) {
  const row1 = new ActionRowBuilder();
  if (creators.length > 0) {
    creators.slice(0, 5).forEach((c, i) => {
      const idx = (page - 1) * 5 + i + 1;
      row1.addComponents(
        new ButtonBuilder()
          .setCustomId(staffIds.crView(c.id))
          .setLabel(`👤 #${idx}`)
          .setStyle(ButtonStyle.Secondary)
      );
    });
  }

  const row2 = new ActionRowBuilder();
  if (page > 1) {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.crList(page - 1))
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  row2.addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.crHub())
      .setLabel('🏠 Hub')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(staffIds.crSearchBtn())
      .setLabel('🔍 Search')
      .setStyle(ButtonStyle.Secondary)
  );

  if (page < totalPages) {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.crList(page + 1))
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  return creators.length > 0 ? [row1, row2] : [row2];
}

/**
 * Creator Detail Action Row
 */
export function buildStaffCreatorDetailRow(userId, currentStatus) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.crSubs(userId, 1))
      .setLabel('🎬 Submissions')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(staffIds.crEarnings(userId))
      .setLabel('💰 Earnings')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(staffIds.crPayouts(userId, 1))
      .setLabel('💸 Payouts')
      .setStyle(ButtonStyle.Primary)
  );

  const row2 = new ActionRowBuilder();
  if (currentStatus !== 'ACTIVE') {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.crStatus(userId, 'ACTIVE'))
        .setLabel('🟢 Set Active')
        .setStyle(ButtonStyle.Success)
    );
  }
  if (currentStatus !== 'SUSPENDED') {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.crStatus(userId, 'SUSPENDED'))
        .setLabel('🟡 Suspend')
        .setStyle(ButtonStyle.Danger)
    );
  }
  if (currentStatus !== 'BANNED') {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.crStatus(userId, 'BANNED'))
        .setLabel('🔴 Ban Account')
        .setStyle(ButtonStyle.Danger)
    );
  }

  row2.addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.crList(1))
      .setLabel('◀ Back to Directory')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(staffIds.crHub())
      .setLabel('🏠 Creator Hub')
      .setStyle(ButtonStyle.Secondary)
  );

  return [row1, row2];
}

/**
 * Creator Submissions List Navigation Row (stays in #creators workspace)
 *
 * @param {string} userId
 * @param {number} [page=1]
 * @param {number} [totalPages=1]
 * @param {Array<object>} [items=[]]
 * @returns {Array<ActionRowBuilder>}
 */
export function buildStaffCreatorSubsNavRow(userId, page = 1, totalPages = 1, items = []) {
  const list = Array.isArray(items) ? items : (items?.items || []);
  const row1 = new ActionRowBuilder();

  if (list.length > 0) {
    list.slice(0, 5).forEach((sub, i) => {
      const idx = (page - 1) * 5 + i + 1;
      row1.addComponents(
        new ButtonBuilder()
          .setCustomId(`${staffIds.subView(sub.id)}:cr:${userId}`)
          .setLabel(`🔎 #${idx}`)
          .setStyle(ButtonStyle.Secondary)
      );
    });
  }

  const row2 = new ActionRowBuilder();
  if (page > 1) {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.crSubs(userId, page - 1))
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  row2.addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.crView(userId))
      .setLabel('◀ Back to Creator')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(staffIds.crHub())
      .setLabel('🏠 Creator Hub')
      .setStyle(ButtonStyle.Secondary)
  );

  if (page < totalPages) {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.crSubs(userId, page + 1))
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  return list.length > 0 ? [row1, row2] : [row2];
}

/**
 * Campaign Hub Canonical Row (#campaign-management)
 */
export function buildStaffCampaignHubRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.cmpList(1))
      .setLabel('🎯 View Campaigns')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(staffIds.cmpCreateBtn())
      .setLabel('➕ Create Campaign')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(staffIds.cmpRefresh())
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Campaign List Navigation Row
 */
export function buildStaffCampaignNavRow(page = 1, totalPages = 1, campaigns = []) {
  const row1 = new ActionRowBuilder();
  if (campaigns.length > 0) {
    campaigns.slice(0, 5).forEach((c, i) => {
      const idx = (page - 1) * 5 + i + 1;
      row1.addComponents(
        new ButtonBuilder()
          .setCustomId(staffIds.cmpView(c.id))
          .setLabel(`🎯 #${idx}`)
          .setStyle(ButtonStyle.Secondary)
      );
    });
  }

  const row2 = new ActionRowBuilder();
  if (page > 1) {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.cmpList(page - 1))
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  row2.addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.cmpHub())
      .setLabel('🏠 Hub')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(staffIds.cmpCreateBtn())
      .setLabel('➕ Create')
      .setStyle(ButtonStyle.Success)
  );

  if (page < totalPages) {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.cmpList(page + 1))
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  return campaigns.length > 0 ? [row1, row2] : [row2];
}

/**
 * Campaign Detail Action Row
 */
export function buildStaffCampaignDetailRow(campaignId, currentStatus) {
  const row = new ActionRowBuilder();

  if (currentStatus !== 'ACTIVE' && currentStatus !== 'COMPLETED') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.cmpStatus(campaignId, 'ACTIVE'))
        .setLabel('▶️ Activate')
        .setStyle(ButtonStyle.Success)
    );
  }
  if (currentStatus === 'ACTIVE') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.cmpStatus(campaignId, 'PAUSED'))
        .setLabel('⏸️ Pause')
        .setStyle(ButtonStyle.Danger)
    );
  }
  if (currentStatus !== 'ENDED' && currentStatus !== 'ARCHIVED') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.cmpStatus(campaignId, 'ENDED'))
        .setLabel('⏹️ End')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.cmpReport(campaignId, 'overview'))
      .setLabel('📊 Report')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(staffIds.cmpList(1))
      .setLabel('◀ Back')
      .setStyle(ButtonStyle.Secondary)
  );

  return row;
}

/**
 * Payout Queue Canonical Hub Row (#payout-queue)
 */
export function buildStaffPayoutHubRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.pqView(1))
      .setLabel('💸 Open Payout Queue')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(staffIds.pqHistory(1))
      .setLabel('📜 Payout History')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(staffIds.pqRefresh())
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Payout List Navigation Row
 */
export function buildStaffPayoutNavRow(page = 1, totalPages = 1, requests = [], isHistory = false) {
  const row1 = new ActionRowBuilder();
  if (requests.length > 0) {
    requests.slice(0, 5).forEach((req, i) => {
      const idx = (page - 1) * 5 + i + 1;
      row1.addComponents(
        new ButtonBuilder()
          .setCustomId(staffIds.pqViewReq(req.id))
          .setLabel(`💸 #${idx}`)
          .setStyle(ButtonStyle.Secondary)
      );
    });
  }

  const row2 = new ActionRowBuilder();
  const targetId = isHistory ? staffIds.pqHistory : staffIds.pqView;

  if (page > 1) {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(targetId(page - 1))
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  row2.addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.pqHub())
      .setLabel('🏠 Hub')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(targetId(page))
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Secondary)
  );

  if (page < totalPages) {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(targetId(page + 1))
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  return requests.length > 0 ? [row1, row2] : [row2];
}

/**
 * Payout Detail Action Row
 */
export function buildStaffPayoutDetailRow(payoutId, status, hasEvidence = false) {
  const row = new ActionRowBuilder();

  if (hasEvidence) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.evReview(payoutId))
        .setLabel('📹 Review Evidence')
        .setStyle(ButtonStyle.Primary)
    );
  }

  if (status === 'REQUESTED' || status === 'UNDER_REVIEW') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.payoutApprove(payoutId))
        .setLabel('✅ Approve')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(staffIds.payoutRejectBtn(payoutId))
        .setLabel('❌ Reject')
        .setStyle(ButtonStyle.Danger)
    );
  } else if (status === 'APPROVED') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.payoutProcess(payoutId))
        .setLabel('💸 Process Disbursement')
        .setStyle(ButtonStyle.Success)
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.pqView(1))
      .setLabel('◀ Back to Queue')
      .setStyle(ButtonStyle.Secondary)
  );

  return row;
}

/**
 * Evidence Telemetry Review Row
 *
 * @param {string} payoutId
 * @param {string|null} evidenceId
 * @param {string|null} status
 * @returns {ActionRowBuilder}
 */
export function buildStaffEvidenceReviewRow(payoutId, evidenceId, status) {
  const row = new ActionRowBuilder();

  if (evidenceId && status !== 'ACCEPTED') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.evAccept(evidenceId))
        .setLabel('✅ Accept Recording')
        .setStyle(ButtonStyle.Success)
    );
  }

  if (evidenceId && status !== 'REJECTED') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.evRejectBtn(evidenceId))
        .setLabel('❌ Reject Recording')
        .setStyle(ButtonStyle.Danger)
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.pqViewReq(payoutId))
      .setLabel('◀ Back to Payout')
      .setStyle(ButtonStyle.Secondary)
  );

  return row;
}

/**
 * Evidence Version Selector Row (for payouts with multiple evidence submissions)
 *
 * @param {string} payoutId
 * @param {Array<object>} evidenceList
 * @param {number|null} currentVersion
 * @returns {ActionRowBuilder|null}
 */
export function buildStaffEvidenceVersionsRow(payoutId, evidenceList = [], currentVersion = null) {
  if (!Array.isArray(evidenceList) || evidenceList.length <= 1) return null;

  const row = new ActionRowBuilder();
  // Sort ascending by version for chronological tabs (up to 5 buttons per ActionRow)
  const sorted = [...evidenceList].sort((a, b) => (a.version || 0) - (b.version || 0)).slice(0, 5);

  for (const ev of sorted) {
    const isCurrent = (ev.version === currentVersion);
    const statusIcon = ev.status === 'ACCEPTED' ? '✅' : ev.status === 'REJECTED' ? '❌' : '⏳';
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${staffIds.evReview(payoutId)}:${ev.version}`)
        .setLabel(`${statusIcon} v${ev.version}`)
        .setStyle(isCurrent ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(isCurrent)
    );
  }

  return row;
}

/**
 * Audit Log Canonical Hub Row (#audit-log)
 */
export function buildStaffAuditHubRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.auditList(1))
      .setLabel('📜 Browse Audit Trail')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(staffIds.auditRefresh())
      .setLabel('🔄 Refresh Audit Log')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Audit Navigation Row
 */
export function buildStaffAuditNavRow(page = 1, totalPages = 1) {
  const row = new ActionRowBuilder();

  if (page > 1) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.auditList(page - 1))
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.auditHub())
      .setLabel('🏠 Hub')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(staffIds.auditList(page))
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Secondary)
  );

  if (page < totalPages) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.auditList(page + 1))
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  return row;
}

/**
 * System Status Canonical Row (#bot-status)
 */
export function buildStaffSystemStatusRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.sysStatusRefresh())
      .setLabel('🔄 Refresh Health Check')
      .setStyle(ButtonStyle.Primary)
  );
}

/**
 * System Errors Canonical Row (#bot-errors)
 */
export function buildStaffSystemErrorsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.sysErrorsRefresh())
      .setLabel('🔄 Refresh Diagnostic Log')
      .setStyle(ButtonStyle.Secondary)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBMISSION DETAIL ROW (used by review-queue inspector + registry detail)
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────

// SUBMISSION REGISTRY NAV ROW
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build Submission Registry Navigation Row
 */
export function buildStaffSubmissionRegistryNavRow(page = 1, totalPages = 1, platform = 'ALL', status = 'ALL') {
  const row = new ActionRowBuilder();

  if (page > 1) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.subRegistry(page - 1, platform, status))
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.subSearchBtn())
      .setLabel('🔍 Search')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(staffIds.subRegistry(page, platform, status))
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Secondary)
  );

  if (page < totalPages) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.subRegistry(page + 1, platform, status))
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBMISSION ANALYTICS NAV ROW
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build Submission Analytics Navigation Row
 */
export function buildStaffAnalyticsNavRow(submissionId, page = 1, totalPages = 1) {
  const row = new ActionRowBuilder();

  if (page > 1) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.subAnalytics(submissionId, page - 1))
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.subView(submissionId))
      .setLabel('🔙 Back to Detail')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(staffIds.subAnalytics(submissionId, page))
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Secondary)
  );

  if (page < totalPages) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(staffIds.subAnalytics(submissionId, page + 1))
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  return row;
}

