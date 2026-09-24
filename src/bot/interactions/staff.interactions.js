import path from 'node:path';
import { MessageFlags, PermissionsBitField, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { prisma } from '../../database/client.js';
import { assertAdminPermission, AdminPermission } from '../../modules/admin/admin.auth.js';
import { adminSubmissionService } from '../../modules/admin/admin.submission.service.js';
import { adminCreatorService } from '../../modules/admin/admin.creator.service.js';
import { adminCampaignService } from '../../modules/admin/admin.campaign.service.js';
import { adminPayoutService } from '../../modules/admin/admin.payout.service.js';
import { adminAuditService } from '../../modules/admin/audit.service.js';
import { campaignService } from '../../modules/campaigns/campaign.service.js';
import { evidenceService } from '../../modules/evidence/evidence.service.js';
import { verificationService } from '../../modules/verification/verification.service.js';
import { payoutService } from '../../modules/payouts/payout.service.js';
import { payoutProfileService } from '../../modules/payout-profile/payout-profile.service.js';
import { storageService } from '../../modules/storage/storage.service.js';
import { staffIds } from '../components/staffComponentIds.js';
import { logger } from '../../utils/logger.js';
import {
  buildStaffReviewQueueHubEmbed,
  buildStaffReviewQueueListEmbed,
  buildStaffSubmissionDetailEmbed,
  buildStaffSubmissionRegistryEmbed,
  buildStaffSubmissionAnalyticsEmbed,
  buildStaffCreatorHubEmbed,
  buildStaffCreatorListEmbed,
  buildStaffCreatorSubsListEmbed,
  buildStaffCreatorDetailEmbed,
  buildStaffCampaignHubEmbed,
  buildStaffCampaignListEmbed,
  buildStaffCampaignDetailEmbed,
  buildStaffPayoutHubEmbed,
  buildStaffPayoutListEmbed,
  buildStaffPayoutDetailEmbed,
  buildStaffEvidenceReviewEmbed,
  buildStaffAuditHubEmbed,
  buildStaffAuditListEmbed,
  buildStaffSystemStatusEmbed,
  buildStaffBotErrorsEmbed
} from '../embeds/staff.embeds.js';

import {
  buildStaffReviewQueueHubRow,
  buildStaffReviewQueueNavRow,
  buildStaffSubmissionDetailRow,
  buildStaffSubmissionRegistryNavRow,
  buildStaffAnalyticsNavRow,
  buildStaffCreatorHubRow,
  buildStaffCreatorNavRow,
  buildStaffCreatorDetailRow,
  buildStaffCreatorSubsNavRow,
  buildStaffCampaignHubRow,
  buildStaffCampaignNavRow,
  buildStaffCampaignDetailRow,
  buildStaffPayoutHubRow,
  buildStaffPayoutNavRow,
  buildStaffPayoutDetailRow,
  buildStaffEvidenceReviewRow,
  buildStaffEvidenceVersionsRow,
  buildStaffAuditHubRow,
  buildStaffAuditNavRow,
  buildStaffSystemStatusRow,
  buildStaffSystemErrorsRow,
  buildStaffSubmissionRefreshingRow,
  buildStaffLoadingRow
} from '../components/staff.components.js';

import {
  buildSubmissionRejectModal,
  buildPayoutRejectModal,
  buildEvidenceRejectModal,
  buildCreatorSearchModal,
  buildCampaignCreateModal,
  buildSubmissionSearchModal,
  buildStaffManualMetricsModal
} from '../components/staff.modals.js';


const PAGE_SIZE = 5;

// In-flight refresh tracking to prevent duplicate provider scrapes and race conditions
export const inFlightRefreshes = new Set();

/**
 * Display immediate loading feedback to staff (<300ms)
 * Uses interaction.update where available so the component visibly updates immediately,
 * falling back gracefully to deferUpdate or deferReply.
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {string} loadingText
 * @param {Array<object>|null} [customComponents=null]
 */
export async function showLoadingFeedback(interaction, loadingText = '⏳ Loading...', customComponents = null) {
  if (interaction.replied || interaction.deferred) return;

  if (typeof interaction.isButton === 'function' && interaction.isButton() && typeof interaction.update === 'function') {
    try {
      const components = customComponents || buildStaffLoadingRow(loadingText);
      const embeds = interaction.message?.embeds || [];
      await interaction.update({
        content: loadingText,
        embeds,
        components
      });
      interaction._loadingStateShown = true;
      return;
    } catch (err) {
      logger.debug({ err: err.message }, 'interaction.update in showLoadingFeedback failed, falling back to deferUpdate');
    }
  }

  if (typeof interaction.deferUpdate === 'function' && (!interaction.deferred && !interaction.replied)) {
    try {
      await interaction.deferUpdate();
      return;
    } catch (err) {
      logger.debug({ err: err.message }, 'interaction.deferUpdate failed in showLoadingFeedback');
    }
  }

  if (typeof interaction.deferReply === 'function' && (!interaction.deferred && !interaction.replied)) {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (err) {
      logger.debug({ err: err.message }, 'interaction.deferReply failed in showLoadingFeedback');
    }
  }
}

/**
 * Authoritative response delivery that guarantees interaction.editReply()
 * is never called unless the interaction was deferred or replied to.
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {object} payload
 */
export async function safeEditReply(interaction, payload) {
  try {
    interaction._loadingStateShown = false;
    if (interaction.deferred || interaction.replied) {
      if (typeof interaction.editReply === 'function') {
        return await interaction.editReply(payload);
      }
    }
    if (typeof interaction.update === 'function') {
      return await interaction.update(payload);
    }
    if (typeof interaction.editReply === 'function') {
      return await interaction.editReply(payload);
    }
    if (typeof interaction.reply === 'function') {
      return await interaction.reply(payload);
    }
  } catch (err) {
    logger.warn({ err: err.message, interactionId: interaction?.id }, 'safeEditReply failed to deliver message');
  }
}

// Helper to acknowledge interaction safely
async function ack(interaction) {
  if (interaction.deferred || interaction.replied) return;

  if (typeof interaction.isButton === 'function' && interaction.isButton()) {
    if (typeof interaction.deferUpdate === 'function') {
      try {
        await interaction.deferUpdate();
      } catch (err) {
        logger.debug({ err: err.message }, 'ack: deferUpdate failed');
      }
    }
  } else if (typeof interaction.deferReply === 'function') {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (err) {
      logger.debug({ err: err.message }, 'ack: deferReply failed');
    }
  }
}

// =========================================================================
// 1. REVIEW QUEUE WORKSPACE (#review-queue)
// =========================================================================

export async function handleStaffReviewQueueHub(interaction) {
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_VIEW);
  await ack(interaction);

  // If this interaction occurred inside #creators, restore Creator Hub fresh state!
  if (interaction.channel?.name === 'creators') {
    await handleStaffCreatorHub(interaction);
    return;
  }

  const [underReview, flagged, postApproval, pending] = await Promise.all([
    prisma.submission.count({ where: { status: 'UNDER_REVIEW' } }).catch(() => 0),
    prisma.submission.count({ where: { status: 'FLAGGED' } }).catch(() => 0),
    prisma.submission.count({ where: { status: 'POST_APPROVAL_REVIEW' } }).catch(() => 0),
    prisma.submission.count({ where: { status: 'PENDING_VERIFICATION' } }).catch(() => 0)
  ]);

  const embed = buildStaffReviewQueueHubEmbed({
    underReviewCount: underReview,
    flaggedCount: flagged,
    postApprovalCount: postApproval,
    pendingVerificationCount: pending
  });
  const row = buildStaffReviewQueueHubRow(interaction.channel?.name);

  await safeEditReply(interaction, { embeds: [embed], components: [row] });
}

export async function handleStaffReviewQueueView(interaction, page = 1) {
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_REVIEW);
  await ack(interaction);

  const p = Math.max(1, parseInt(page, 10) || 1);
  const queueResult = await adminSubmissionService.listReviewQueue({ page: p, limit: PAGE_SIZE, includePending: true }).catch(() => []);
  const queue = Array.isArray(queueResult) ? queueResult : (queueResult?.items || []);
  const totalItems = queueResult?.total ?? (await prisma.submission.count({
    where: { status: { in: ['PENDING_VERIFICATION', 'UNDER_REVIEW', 'POST_APPROVAL_REVIEW', 'FLAGGED'] } }
  }).catch(() => queue.length));
  const totalPages = queueResult?.totalPages ?? (Math.ceil(totalItems / PAGE_SIZE) || 1);

  const embed = buildStaffReviewQueueListEmbed(queue, p, totalPages);
  const rows = buildStaffReviewQueueNavRow(p, totalPages, queue, interaction.channel?.name);

  await safeEditReply(interaction, { embeds: [embed], components: rows });
}

export async function handleStaffSubmissionReverify(interaction, submissionId) {
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_REVIEW);
  await ack(interaction);

  await verificationService.runVerification(submissionId, { forceRefresh: true });
  const submission = await adminSubmissionService.getSubmissionDetails(submissionId, { isStaff: true });
  const embed = buildStaffSubmissionDetailEmbed(submission);
  const rows = buildStaffSubmissionDetailRow(submission.id, submission.status, submission.url);

  await safeEditReply(interaction, { embeds: [embed], components: rows });
}

export async function handleStaffSubmissionView(interaction, submissionId, fromCreatorId = null) {
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_VIEW);
  await showLoadingFeedback(interaction, '⏳ Loading submission...');

  const submission = await adminSubmissionService.getSubmissionDetails(submissionId, { isStaff: true });
  const embed = buildStaffSubmissionDetailEmbed(submission);
  const rows = buildStaffSubmissionDetailRow(submission.id, submission.status, submission.url, submission.platform, fromCreatorId);

  await safeEditReply(interaction, { content: null, embeds: [embed], components: rows });
}

export async function handleStaffSubmissionApprove(interaction, submissionId) {
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_APPROVE);
  await ack(interaction);

  const actor = { discordId: interaction.user.id, userId: null };
  const updated = await adminSubmissionService.approveSubmission(submissionId, actor, 'Approved via staff action');

  const embed = buildStaffSubmissionDetailEmbed(updated);
  const rows = buildStaffSubmissionDetailRow(updated.id, updated.status, updated.url);

  await safeEditReply(interaction, { embeds: [embed], components: rows });
}

export async function handleStaffSubmissionRejectBtn(interaction, submissionId) {
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_REJECT);
  const modal = buildSubmissionRejectModal(submissionId);
  await interaction.showModal(modal);
}

export async function handleStaffSubmissionRejectModalSubmit(interaction, submissionId) {
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_REJECT);
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const structuredReason = interaction.fields.getTextInputValue('reason')?.trim();
  const notes = interaction.fields.getTextInputValue('notes')?.trim() || null;
  const actor = { discordId: interaction.user.id, userId: null };

  const updated = await adminSubmissionService.rejectSubmission(submissionId, actor, { structuredReason, notes });
  await safeEditReply(interaction, {
    content: `✅ Submission \`${submissionId}\` has been **REJECTED** (${structuredReason}). Creator notified.`
  });
}

export async function handleStaffSubmissionFlag(interaction, submissionId) {
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_FLAG);
  await ack(interaction);

  const actor = { discordId: interaction.user.id, userId: null };
  const updated = await adminSubmissionService.flagSubmission(submissionId, actor, 'Flagged by staff inspection');

  const embed = buildStaffSubmissionDetailEmbed(updated);
  const rows = buildStaffSubmissionDetailRow(updated.id, updated.status, updated.url);

  await safeEditReply(interaction, { embeds: [embed], components: rows });
}

export async function handleStaffSubmissionKeepReview(interaction, submissionId) {
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_REVIEW);
  await ack(interaction);

  const actor = { discordId: interaction.user.id, userId: null };
  const updated = await adminSubmissionService.repo.updateSubmission(submissionId, {
    status: 'UNDER_REVIEW',
    moderatedAt: new Date(),
    moderatedBy: actor.discordId,
    moderationNotes: 'Kept under staff observation'
  });

  const full = await adminSubmissionService.repo.getSubmissionWithFullDetails(submissionId);
  const embed = buildStaffSubmissionDetailEmbed(full || updated);
  const rows = buildStaffSubmissionDetailRow(updated.id, updated.status, updated.url);

  await safeEditReply(interaction, { embeds: [embed], components: rows });
}



// =========================================================================
// 2. CREATOR MANAGEMENT WORKSPACE (#creators)
// =========================================================================

export async function handleStaffCreatorHub(interaction) {
  assertAdminPermission(interaction, AdminPermission.CREATOR_VIEW);
  await ack(interaction);

  const [total, active, suspended, banned] = await Promise.all([
    prisma.user.count().catch(() => 0),
    prisma.user.count({ where: { status: 'ACTIVE' } }).catch(() => 0),
    prisma.user.count({ where: { status: 'SUSPENDED' } }).catch(() => 0),
    prisma.user.count({ where: { status: 'BANNED' } }).catch(() => 0)
  ]);

  const embed = buildStaffCreatorHubEmbed({
    totalCount: total,
    activeCount: active,
    suspendedCount: suspended,
    bannedCount: banned
  });
  const row = buildStaffCreatorHubRow();

  await safeEditReply(interaction, { embeds: [embed], components: [row] });
}

export async function handleStaffCreatorList(interaction, page = 1) {
  assertAdminPermission(interaction, AdminPermission.CREATOR_VIEW);
  await ack(interaction);

  const p = Math.max(1, parseInt(page, 10) || 1);
  const total = await prisma.user.count().catch(() => 0);
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;

  const creators = await prisma.user.findMany({
    skip: (p - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    orderBy: { createdAt: 'desc' },
    select: { id: true, discordId: true, username: true, displayName: true, status: true, createdAt: true }
  }).catch(() => []);

  const embed = buildStaffCreatorListEmbed(creators, p, totalPages);
  const rows = buildStaffCreatorNavRow(p, totalPages, creators);

  await safeEditReply(interaction, { embeds: [embed], components: rows });
}

export async function handleStaffCreatorSearchBtn(interaction) {
  assertAdminPermission(interaction, AdminPermission.CREATOR_VIEW);
  const modal = buildCreatorSearchModal();
  await interaction.showModal(modal);
}

export async function handleStaffCreatorSearchModalSubmit(interaction) {
  assertAdminPermission(interaction, AdminPermission.CREATOR_VIEW);
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const query = interaction.fields.getTextInputValue('query')?.trim();
  const creators = await adminCreatorService.searchCreators(query, { limit: 5 });

  const embed = buildStaffCreatorListEmbed(creators, 1, 1);
  const rows = buildStaffCreatorNavRow(1, 1, creators);

  await safeEditReply(interaction, { embeds: [embed], components: rows });
}

async function enrichCreatorDetails(details) {
  if (!details || !details.id) return details;
  const [balance, profile] = await Promise.all([
    payoutService.getAvailablePayoutBalance(details.id).catch(() => null),
    payoutProfileService.getProfile(details.id).catch(() => null)
  ]);
  if (balance) details.financials = balance;
  if (profile) details.payoutProfile = profile;
  return details;
}

export async function handleStaffCreatorView(interaction, userId) {
  assertAdminPermission(interaction, AdminPermission.CREATOR_VIEW);
  await ack(interaction);

  const details = await adminCreatorService.getCreatorDetails(userId);
  await enrichCreatorDetails(details);
  const embed = buildStaffCreatorDetailEmbed(details);
  const rows = buildStaffCreatorDetailRow(details.id, details.status);

  await safeEditReply(interaction, { embeds: [embed], components: rows });
}

export async function handleStaffCreatorStatus(interaction, userId, targetStatus) {
  assertAdminPermission(interaction, AdminPermission.CREATOR_STATUS_MANAGE);
  await ack(interaction);

  const actor = { discordId: interaction.user.id, userId: null };
  const updated = await adminCreatorService.updateCreatorStatus(userId, targetStatus, actor, `Status set to ${targetStatus}`);

  const details = await adminCreatorService.getCreatorDetails(updated.id);
  await enrichCreatorDetails(details);
  const embed = buildStaffCreatorDetailEmbed(details);
  const rows = buildStaffCreatorDetailRow(details.id, details.status);

  await safeEditReply(interaction, { embeds: [embed], components: rows });
}

export async function handleStaffCreatorSubs(interaction, userId, page = 1) {
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_VIEW);
  await ack(interaction);

  const p = Math.max(1, parseInt(page, 10) || 1);
  const [subs, user] = await Promise.all([
    prisma.submission.findMany({
      where: { userId },
      skip: (p - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { campaign: true, user: true },
      orderBy: { submittedAt: 'desc' }
    }).catch(() => []),
    prisma.user.findUnique({ where: { id: userId } }).catch(() => null)
  ]);

  const total = await prisma.submission.count({ where: { userId } }).catch(() => 0);
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;

  const embed = buildStaffCreatorSubsListEmbed(user, subs, p, totalPages);
  const rows = buildStaffCreatorSubsNavRow(userId, p, totalPages, subs);

  await safeEditReply(interaction, { embeds: [embed], components: rows });
}

export async function handleStaffChannelReset(interaction) {
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_VIEW);
  await ack(interaction);

  const chName = interaction.channel?.name;

  if (chName === 'creators') {
    await handleStaffCreatorHub(interaction);
  } else if (chName === 'review-queue') {
    await handleStaffReviewQueueHub(interaction);
  } else if (chName === 'campaign-management') {
    await handleStaffCampaignHub(interaction);
  } else if (chName === 'payout-queue') {
    await handleStaffPayoutHub(interaction);
  } else if (chName === 'audit-log') {
    await handleStaffAuditHub(interaction);
  } else if (chName === 'dashboard') {
    const { handleAdminControlCenter } = await import('./dashboard.interactions.js');
    await handleAdminControlCenter(interaction);
  } else {
    await handleStaffCreatorHub(interaction);
  }
}

// =========================================================================
// 3. CAMPAIGN OPERATIONS WORKSPACE (#campaign-management)
// =========================================================================

export async function handleStaffCampaignHub(interaction) {
  assertAdminPermission(interaction, AdminPermission.CAMPAIGN_EDIT);
  await ack(interaction);

  const all = await prisma.campaign.findMany().catch(() => []);
  const active = all.filter((c) => c.status === 'ACTIVE').length;
  const paused = all.filter((c) => c.status === 'PAUSED').length;
  const completed = all.filter((c) => c.status === 'COMPLETED').length;

  let totalBudget = 0;
  let consumedBudget = 0;
  for (const c of all) {
    totalBudget += Number(c.totalBudget || 0);
    consumedBudget += Number(c.consumedBudget || 0);
  }

  const embed = buildStaffCampaignHubEmbed({
    activeCount: active,
    pausedCount: paused,
    completedCount: completed,
    totalBudget,
    consumedBudget,
    remainingBudget: Math.max(0, totalBudget - consumedBudget)
  });
  const row = buildStaffCampaignHubRow();

  await safeEditReply(interaction, { embeds: [embed], components: [row] });
}

export async function handleStaffCampaignList(interaction, page = 1) {
  assertAdminPermission(interaction, AdminPermission.CAMPAIGN_EDIT);
  await ack(interaction);

  const p = Math.max(1, parseInt(page, 10) || 1);
  const total = await prisma.campaign.count().catch(() => 0);
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;

  const campaigns = await prisma.campaign.findMany({
    skip: (p - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    orderBy: { createdAt: 'desc' }
  }).catch(() => []);

  const embed = buildStaffCampaignListEmbed(campaigns, p, totalPages);
  const rows = buildStaffCampaignNavRow(p, totalPages, campaigns);

  await safeEditReply(interaction, { embeds: [embed], components: rows });
}

export async function handleStaffCampaignCreateBtn(interaction) {
  assertAdminPermission(interaction, AdminPermission.CAMPAIGN_CREATE);
  const modal = buildCampaignCreateModal();
  await interaction.showModal(modal);
}

export async function handleStaffCampaignCreateModalSubmit(interaction) {
  assertAdminPermission(interaction, AdminPermission.CAMPAIGN_CREATE);
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const name = interaction.fields.getTextInputValue('name')?.trim();
  const clientName = interaction.fields.getTextInputValue('client')?.trim();
  const rawRateBudget = interaction.fields.getTextInputValue('cpm_budget')?.trim();
  const rawCpm = interaction.fields.getTextInputValue('cpm')?.trim();
  const rawBudget = interaction.fields.getTextInputValue('budget')?.trim();
  const descriptionRaw = interaction.fields.getTextInputValue('description')?.trim();

  let cpm = 10.0;
  let totalBudget = 1000.0;

  if (rawRateBudget) {
    const parts = rawRateBudget.split(/[\/,|]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      cpm = parseFloat(parts[0]) || 10.0;
      totalBudget = parseFloat(parts[1]) || 1000.0;
    } else {
      const nums = rawRateBudget.match(/\d+(?:\.\d+)?/g);
      if (nums && nums.length >= 2) {
        cpm = parseFloat(nums[0]) || 10.0;
        totalBudget = parseFloat(nums[1]) || 1000.0;
      } else if (nums && nums.length === 1) {
        cpm = parseFloat(nums[0]) || 10.0;
      }
    }
  } else {
    if (rawCpm) cpm = parseFloat(rawCpm) || 10.0;
    if (rawBudget) totalBudget = parseFloat(rawBudget) || 1000.0;
  }

  // Parse allowed platforms (supports StringSelectMenu checkboxes OR fallback text input)
  const VALID_PLATFORMS = ['youtube', 'tiktok', 'instagram', 'facebook'];
  let allowedPlatforms = [];

  // 1. Try reading from StringSelectMenu component
  try {
    if (typeof interaction.fields.getStringSelectValues === 'function') {
      const selected = interaction.fields.getStringSelectValues('platforms');
      if (Array.isArray(selected) && selected.length > 0) {
        allowedPlatforms = selected
          .map((p) => String(p).trim().toLowerCase())
          .filter((p) => VALID_PLATFORMS.includes(p));
      }
    }
  } catch {
    // If not a StringSelectMenu component, fall through to text input fallback
  }

  // 2. Fallback to TextInput component if provided as text
  if (allowedPlatforms.length === 0) {
    try {
      const platformsRaw = interaction.fields.getTextInputValue('platforms')?.trim();
      if (platformsRaw) {
        if (platformsRaw.toUpperCase() === 'ALL') {
          allowedPlatforms = [...VALID_PLATFORMS];
        } else {
          allowedPlatforms = platformsRaw
            .split(',')
            .map((p) => p.trim().toLowerCase())
            .filter((p) => VALID_PLATFORMS.includes(p));
        }
      }
    } catch {
      // ignore
    }
  }

  // Default to all 4 supported platforms if nothing specified
  if (allowedPlatforms.length === 0) {
    allowedPlatforms = [...VALID_PLATFORMS];
  }

  // Ensure description is at least 10 chars for schema validation
  const description = (descriptionRaw && descriptionRaw.length >= 10)
    ? descriptionRaw
    : `Official clipping campaign for ${clientName}. Submit approved vertical clips to earn payouts.`;

  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`;

  const actor = { discordId: interaction.user.id, userId: null };
  const campaign = await adminCampaignService.createCampaign({
    name,
    slug,
    clientName,
    description,
    payRate: cpm,
    totalBudget,
    requirements: { allowedPlatforms },
    startsAt: new Date().toISOString().split('T')[0],
    endsAt: new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]
  }, actor);

  await safeEditReply(interaction, {
    content:
      `✅ Campaign **${campaign.name}** created successfully!\n` +
      `📋 **ID:** \`${campaign.id}\`\n` +
      `🎮 **Allowed Platforms:** \`${allowedPlatforms.map((p) => p.toUpperCase()).join(', ')}\`\n` +
      `💰 **Budget:** \`$${totalBudget.toFixed(2)}\` at \`$${cpm.toFixed(2)}/1k views\`\n` +
      `📝 **Description:** ${description.slice(0, 100)}${description.length > 100 ? '...' : ''}\n\n` +
      `Status: \`DRAFT\` — activate it from Campaign Management.`
  });
}

export async function handleStaffCampaignView(interaction, campaignId) {
  assertAdminPermission(interaction, AdminPermission.CAMPAIGN_EDIT);
  await ack(interaction);

  const campaign = await adminCampaignService.getCampaignDetails(campaignId);
  const embed = buildStaffCampaignDetailEmbed(campaign);
  const row = buildStaffCampaignDetailRow(campaign.id, campaign.status);

  await safeEditReply(interaction, { embeds: [embed], components: [row] });
}

export async function handleStaffCampaignStatus(interaction, campaignId, targetStatus) {
  assertAdminPermission(interaction, AdminPermission.CAMPAIGN_EDIT);
  await ack(interaction);

  const actor = { discordId: interaction.user.id, userId: null };
  const updated = await adminCampaignService.updateStatus(campaignId, targetStatus, actor, `Status set to ${targetStatus}`);

  const campaign = await adminCampaignService.getCampaignDetails(updated.id);
  const embed = buildStaffCampaignDetailEmbed(campaign);
  const row = buildStaffCampaignDetailRow(campaign.id, campaign.status);

  await safeEditReply(interaction, { embeds: [embed], components: [row] });
}

export async function handleStaffCampaignReport(interaction, campaignId) {
  assertAdminPermission(interaction, AdminPermission.CAMPAIGN_EDIT);
  await ack(interaction);

  const [
    campaign,
    members,
    submissions,
    earningsAgg
  ] = await Promise.all([
    adminCampaignService.getCampaignDetails(campaignId),
    prisma.campaignMember.findMany({
      where: { campaignId },
      include: { user: true },
      orderBy: { joinedAt: 'asc' }
    }).catch(() => []),
    prisma.submission.findMany({
      where: { campaignId },
      include: {
        user: true,
        snapshots: {
          orderBy: { capturedAt: 'desc' },
          take: 1
        }
      },
      orderBy: { submittedAt: 'asc' }
    }).catch(() => []),
    prisma.earning.aggregate({
      where: { campaignId, status: 'ELIGIBLE' },
      _sum: { grossAmount: true, eligibleViews: true }
    }).catch(() => null)
  ]);

  if (!campaign) {
    await safeEditReply(interaction, {
      content: `⚠️ Campaign \`${campaignId}\` was not found.`,
      embeds: [],
      components: []
    });
    return;
  }

  const activeMembers = members.filter((m) => m.status === 'ACTIVE');
  const totalClips = submissions.length;
  const approvedClips = submissions.filter((s) => s.status === 'APPROVED');
  const pendingClips = submissions.filter((s) => s.status === 'PENDING_VERIFICATION').length;
  const underReviewClips = submissions.filter((s) => s.status === 'UNDER_REVIEW' || s.status === 'POST_APPROVAL_REVIEW').length;
  const rejectedClips = submissions.filter((s) => s.status === 'REJECTED').length;
  const flaggedClips = submissions.filter((s) => s.status === 'FLAGGED').length;

  let approvedViewsSum = 0n;
  for (const s of approvedClips) {
    const snapViews = s.snapshots?.[0]?.views;
    const rawViews = snapViews != null ? snapViews : s.views;
    if (rawViews != null && rawViews !== '') {
      try {
        approvedViewsSum += BigInt(rawViews);
      } catch {
        // ignore parsing error
      }
    }
  }

  const payRateNum = Number(campaign.payRate || 0);
  const viewsBasedConsumed = (Number(approvedViewsSum) / 1000) * payRateNum;
  const recordedConsumed = Number(campaign.consumedBudget || 0);
  const earningsConsumed = Number(earningsAgg?._sum?.grossAmount || 0);
  const liveConsumed = Math.max(recordedConsumed, earningsConsumed, viewsBasedConsumed);

  const totalBudget = Number(campaign.totalBudget || 0);
  const remainingBudget = Math.max(0, totalBudget - liveConsumed);
  const fulfillmentPct = totalBudget > 0 ? ((liveConsumed / totalBudget) * 100).toFixed(1) : '0.0';

  const rawPlatforms = campaign.requirements?.allowedPlatforms;
  const platformsStr = Array.isArray(rawPlatforms) && rawPlatforms.length > 0
    ? rawPlatforms.map((p) => String(p).toUpperCase()).join(', ')
    : 'ALL';

  // 1. Build Clippers Joined Section
  let clippersListText = '';
  if (members.length === 0) {
    clippersListText = '*No clippers have joined this campaign yet.*';
  } else {
    clippersListText = members.slice(0, 10).map((m, i) => {
      const creatorSubs = submissions.filter((s) => s.userId === m.userId);
      const appCount = creatorSubs.filter((s) => s.status === 'APPROVED').length;
      let cViews = 0n;
      for (const s of creatorSubs) {
        if (s.status === 'APPROVED') {
          const snapViews = s.snapshots?.[0]?.views;
          const rawViews = snapViews != null ? snapViews : s.views;
          if (rawViews != null && rawViews !== '') {
            try { cViews += BigInt(rawViews); } catch {}
          }
        }
      }
      const cEarned = (Number(cViews) / 1000) * payRateNum;
      const mention = m.user?.discordId ? `<@${m.user.discordId}>` : `@${m.user?.username || 'creator'}`;
      return `**${i + 1}.** ${mention} (\`${m.user?.username || 'user'}\`)\n   └ **${creatorSubs.length}** clips (${appCount} approved) • **${Number(cViews).toLocaleString()}** views • **$${cEarned.toFixed(2)}**`;
    }).join('\n');

    if (members.length > 10) {
      clippersListText += `\n*...and ${members.length - 10} more clippers.*`;
    }
  }

  // 2. Build Uploaded Clips Section
  let clipsListText = '';
  if (submissions.length === 0) {
    clipsListText = '*No clips have been uploaded to this campaign yet.*';
  } else {
    clipsListText = submissions.slice(0, 8).map((s, i) => {
      const snapViews = s.snapshots?.[0]?.views;
      const rawViews = snapViews != null ? snapViews : s.views;
      const viewsNum = (rawViews != null && rawViews !== '') ? Number(rawViews) : 0;
      const earnedVal = (viewsNum / 1000) * payRateNum;
      const statusIcon = s.status === 'APPROVED' ? '✅' : s.status === 'REJECTED' ? '❌' : s.status === 'FLAGGED' ? '⚠️' : '⏳';

      let viewsDesc = '';
      if (s.status === 'APPROVED') {
        if (viewsNum > 0) {
          viewsDesc = `**${viewsNum.toLocaleString()}** views (~$${earnedVal.toFixed(2)})`;
        } else {
          viewsDesc = `**0 views** *(Click review to fetch)*`;
        }
      } else if (s.status === 'REJECTED') {
        const reason = s.structuredReason || s.rejectionReason?.slice(0, 35) || 'Rejected';
        viewsDesc = `*Rejected (${reason})*`;
      } else {
        viewsDesc = `*Under verification*`;
      }

      const shortId = s.id.substring(0, 8);
      const creatorName = s.user?.username ? `@${s.user.username}` : 'creator';

      return `**#${i + 1}** [${s.platform} Clip](${s.url}) — ${statusIcon} \`${s.status}\`\n   └ ${viewsDesc} • by ${creatorName} • \`${shortId}\``;
    }).join('\n');

    if (submissions.length > 8) {
      clipsListText += `\n*...and ${submissions.length - 8} more clips.*`;
    }
  }

  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = await import('discord.js');

  const embed = new EmbedBuilder()
    .setTitle(`📊 Live Campaign Report — ${campaign.name}`)
    .setColor(0x5865F2)
    .setDescription(
      `**Client:** ${campaign.clientName} • **Slug:** \`${campaign.slug}\`\n` +
      `**Status:** \`${campaign.status}\` • **Pay Rate:** \`$${payRateNum.toFixed(2)} / 1k views\`\n` +
      `**Allowed Platforms:** \`${platformsStr}\`` +
      (campaign.description ? `\n**Description:** ${campaign.description}` : '')
    )
    .addFields(
      {
        name: `👥 Clippers Joined (${members.length})`,
        value: clippersListText.slice(0, 1024),
        inline: false
      },
      {
        name: `🎬 Uploaded Clips & Direct Review (${totalClips})`,
        value: clipsListText.slice(0, 1024),
        inline: false
      },
      {
        name: '💰 Financial Progress (Live Calculation)',
        value:
          `• **Total Budget:** \`$${totalBudget.toFixed(2)} ${campaign.currency || 'USD'}\`\n` +
          `• **Consumed Budget:** \`$${liveConsumed.toFixed(2)}\` (${fulfillmentPct}% fulfilled)\n` +
          `• **Remaining Budget:** \`$${remainingBudget.toFixed(2)}\`\n` +
          `• **Creator Cap:** \`$${Number(campaign.creatorEarningCap || 600).toFixed(2)}\``,
        inline: true
      },
      {
        name: '📈 Verified Reach & Status',
        value:
          `• **Approved Clips:** \`${approvedClips.length}\` / \`${totalClips}\`\n` +
          `• **Total Approved Views:** \`${approvedViewsSum.toLocaleString()}\`\n` +
          `• **Credited Views:** \`${Number(earningsAgg?._sum?.eligibleViews || 0).toLocaleString()}\`\n` +
          `• **Clip Duration:** \`${campaign.minClipDurationSeconds || 7}s – ${campaign.maxClipDurationSeconds || 120}s\``,
        inline: true
      }
    )
    .setFooter({ text: 'Peak Clip Staff Operations • Live Campaign Report & Direct Clip Inspection' })
    .setTimestamp();

  const components = [];

  // Direct Review Buttons for up to 5 submissions
  if (submissions.length > 0 && submissions.length <= 5) {
    const clipRow = new ActionRowBuilder();
    submissions.forEach((sub, i) => {
      const snapViews = sub.snapshots?.[0]?.views;
      const rawViews = snapViews != null ? snapViews : sub.views;
      const views = (rawViews != null && rawViews !== '') ? Number(rawViews) : 0;
      let label = `#${i + 1}`;
      if (views > 0) {
        label += ` (${views >= 1000 ? `${(views / 1000).toFixed(1)}k` : views})`;
      } else if (sub.status === 'APPROVED') {
        label += ' (0 views)';
      } else {
        label += ` (${sub.status})`;
      }
      clipRow.addComponents(
        new ButtonBuilder()
          .setCustomId(staffIds.subView(sub.id))
          .setLabel(`🔎 ${label}`.slice(0, 80))
          .setStyle(
            sub.status === 'APPROVED' ? ButtonStyle.Success :
            sub.status === 'REJECTED' ? ButtonStyle.Secondary :
            sub.status === 'FLAGGED' ? ButtonStyle.Danger :
            ButtonStyle.Primary
          )
      );
    });
    components.push(clipRow);
  } else if (submissions.length > 5) {
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('admin_camp_report_sub_select')
      .setPlaceholder('🔎 Select a clip to review & refresh directly...')
      .addOptions(
        submissions.slice(0, 25).map((sub, i) => {
          const snapViews = sub.snapshots?.[0]?.views;
          const rawViews = snapViews != null ? snapViews : sub.views;
          const views = (rawViews != null && rawViews !== '') ? Number(rawViews).toLocaleString() : '0';
          const shortUrl = sub.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 50);
          return new StringSelectMenuOptionBuilder()
            .setLabel(`Clip #${i + 1}: ${sub.platform} [${sub.status}]`.slice(0, 100))
            .setDescription(`${views} views • ${shortUrl}`.slice(0, 100))
            .setValue(sub.id);
        })
      );
    components.push(new ActionRowBuilder().addComponents(selectMenu));
  }

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(staffIds.cmpView(campaignId))
      .setLabel('◀ Back to Campaign')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(staffIds.cmpReport(campaignId, 'overview'))
      .setLabel('🔄 Refresh Report')
      .setStyle(ButtonStyle.Primary)
  );
  components.push(navRow);

  await safeEditReply(interaction, { embeds: [embed], components });
}

// =========================================================================
// 4. PAYOUT FINANCIAL OPERATIONS (#payout-queue)
// =========================================================================

export async function handleStaffPayoutHub(interaction) {
  assertAdminPermission(interaction, AdminPermission.PAYOUT_VIEW);
  await ack(interaction);

  const [pendingReqs, approvedReqs] = await Promise.all([
    prisma.payoutRequest.findMany({ where: { status: 'REQUESTED' } }).catch(() => []),
    prisma.payoutRequest.count({ where: { status: 'APPROVED' } }).catch(() => 0)
  ]);

  let totalPending = 0;
  for (const r of pendingReqs) totalPending += Number(r.amount || 0);

  const embed = buildStaffPayoutHubEmbed({
    pendingCount: pendingReqs.length,
    totalPendingAmount: totalPending,
    approvedCount: approvedReqs
  });
  const row = buildStaffPayoutHubRow();

  await safeEditReply(interaction, { embeds: [embed], components: [row] });
}

export async function handleStaffPayoutQueueView(interaction, page = 1) {
  assertAdminPermission(interaction, AdminPermission.PAYOUT_VIEW);
  await ack(interaction);

  const p = Math.max(1, parseInt(page, 10) || 1);
  const requests = await adminPayoutService.listPayoutRequests({ status: 'REQUESTED', page: p, limit: PAGE_SIZE }).catch(() => []);
  const total = await prisma.payoutRequest.count({ where: { status: 'REQUESTED' } }).catch(() => requests.length);
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;

  const embed = buildStaffPayoutListEmbed(requests, p, totalPages, false);
  const rows = buildStaffPayoutNavRow(p, totalPages, requests, false);

  await safeEditReply(interaction, { embeds: [embed], components: rows });
}

export async function handleStaffPayoutHistory(interaction, page = 1) {
  assertAdminPermission(interaction, AdminPermission.PAYOUT_VIEW);
  await ack(interaction);

  const p = Math.max(1, parseInt(page, 10) || 1);
  const requests = await adminPayoutService.listPayoutRequests({ page: p, limit: PAGE_SIZE }).catch(() => []);
  const total = await prisma.payoutRequest.count().catch(() => requests.length);
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;

  const embed = buildStaffPayoutListEmbed(requests, p, totalPages, true);
  const rows = buildStaffPayoutNavRow(p, totalPages, requests, true);

  await safeEditReply(interaction, { embeds: [embed], components: rows });
}

async function enrichPayoutReq(req) {
  if (!req || !req.userId) return req;
  const [balance, profile] = await Promise.all([
    payoutService.getAvailablePayoutBalance(req.userId).catch(() => null),
    payoutProfileService.getProfile(req.userId).catch(() => null)
  ]);
  if (balance) req.balanceBreakdown = balance;
  if (profile) req.activeProfile = profile;
  return req;
}

export async function handleStaffPayoutViewReq(interaction, payoutId) {
  assertAdminPermission(interaction, AdminPermission.PAYOUT_VIEW);
  await ack(interaction);

  const req = await adminPayoutService.getPayoutDetails(payoutId);
  await enrichPayoutReq(req);
  const hasEvidence = Array.isArray(req.evidence) && req.evidence.length > 0;
  const embed = buildStaffPayoutDetailEmbed(req);
  const row = buildStaffPayoutDetailRow(req.id, req.status, hasEvidence);

  await safeEditReply(interaction, { embeds: [embed], components: [row], files: [] });
}

export async function handleStaffEvidenceReview(interaction, payoutId, targetVersion = null) {
  assertAdminPermission(interaction, AdminPermission.PAYOUT_VIEW);
  await ack(interaction);

  const req = await adminPayoutService.getPayoutDetails(payoutId);
  if (!req) {
    await safeEditReply(interaction, { content: '⚠️ Payout request not found.', embeds: [], components: [], files: [] });
    return;
  }

  const evidenceList = [...(req.evidence || [])].sort((a, b) => (b.version || 0) - (a.version || 0));
  const selectedEv = targetVersion != null
    ? evidenceList.find((e) => e.version === targetVersion) || evidenceList[0] || null
    : evidenceList[0] || null;

  const files = [];
  let fileError = null;

  if (selectedEv?.storageKey) {
    try {
      const buffer = await storageService.getFileBuffer(selectedEv.storageKey);
      if (buffer && buffer.length > 0) {
        if (buffer.length <= 25 * 1024 * 1024) {
          const ext = path.extname(selectedEv.filename || '') || '.mp4';
          const safeName = `evidence_${req.id.substring(0, 8)}_v${selectedEv.version || 1}${ext}`;
          files.push(new AttachmentBuilder(buffer, { name: safeName }));
        } else {
          fileError = 'Video file exceeds Discord 25MB attachment limit';
          logger.warn({ storageKey: selectedEv.storageKey, size: buffer.length }, fileError);
        }
      } else {
        fileError = 'Video file buffer is empty on disk';
      }
    } catch (err) {
      fileError = `Could not load video: ${err.message}`;
      logger.error({ err: err.message, storageKey: selectedEv.storageKey }, 'Failed to read evidence video file');
    }
  }

  const embed = buildStaffEvidenceReviewEmbed(req, selectedEv, {
    fileError,
    hasAttachment: files.length > 0,
    totalVersions: evidenceList.length
  });

  const row = buildStaffEvidenceReviewRow(req.id, selectedEv?.id, selectedEv?.status);
  const components = [row];

  if (evidenceList.length > 1) {
    const vRow = buildStaffEvidenceVersionsRow(req.id, evidenceList, selectedEv?.version);
    if (vRow) components.push(vRow);
  }

  await safeEditReply(interaction, { embeds: [embed], components, files });
}

export async function handleStaffEvidenceAccept(interaction, evidenceId) {
  assertAdminPermission(interaction, AdminPermission.PAYOUT_APPROVE);
  await ack(interaction);

  const actor = { discordId: interaction.user.id, userId: null };
  const updated = await adminPayoutService.acceptEvidence(evidenceId, actor, 'Evidence accepted by staff');

  const components = [];
  if (updated?.payoutRequestId) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(staffIds.pqViewReq(updated.payoutRequestId))
          .setLabel('◀ Return to Payout Request')
          .setStyle(ButtonStyle.Primary)
      )
    );
  }

  await safeEditReply(interaction, {
    content: `✅ Analytics evidence \`${evidenceId}\` **ACCEPTED**. The payout request may now be approved for disbursement.`,
    embeds: [],
    files: [],
    components
  });
}

export async function handleStaffEvidenceRejectBtn(interaction, evidenceId) {
  assertAdminPermission(interaction, AdminPermission.PAYOUT_REJECT);
  const modal = buildEvidenceRejectModal(evidenceId);
  await interaction.showModal(modal);
}

export async function handleStaffEvidenceRejectModalSubmit(interaction, evidenceId) {
  assertAdminPermission(interaction, AdminPermission.PAYOUT_REJECT);
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const reason = interaction.fields.getTextInputValue('reason')?.trim();
  const notes = interaction.fields.getTextInputValue('notes')?.trim() || null;
  const actor = { discordId: interaction.user.id, userId: null };

  const updated = await adminPayoutService.rejectEvidence(evidenceId, actor, { structuredReason: reason, notes });

  const components = [];
  if (updated?.payoutRequestId) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(staffIds.pqViewReq(updated.payoutRequestId))
          .setLabel('◀ Return to Payout Request')
          .setStyle(ButtonStyle.Primary)
      )
    );
  }

  await safeEditReply(interaction, {
    content: `❌ Analytics recording \`${evidenceId}\` has been **REJECTED** (\`${reason}\`). Creator has been notified.`,
    embeds: [],
    files: [],
    components
  });
}

export async function handleStaffPayoutApprove(interaction, payoutId) {
  assertAdminPermission(interaction, AdminPermission.PAYOUT_APPROVE);
  await ack(interaction);

  const actor = { discordId: interaction.user.id, userId: null };
  const updated = await adminPayoutService.approvePayout(payoutId, actor);

  const req = await adminPayoutService.getPayoutDetails(updated.id);
  await enrichPayoutReq(req);
  const embed = buildStaffPayoutDetailEmbed(req);
  const row = buildStaffPayoutDetailRow(req.id, req.status, true);

  await safeEditReply(interaction, { embeds: [embed], components: [row] });
}

export async function handleStaffPayoutRejectBtn(interaction, payoutId) {
  assertAdminPermission(interaction, AdminPermission.PAYOUT_REJECT);
  const modal = buildPayoutRejectModal(payoutId);
  await interaction.showModal(modal);
}

export async function handleStaffPayoutRejectModalSubmit(interaction, payoutId) {
  assertAdminPermission(interaction, AdminPermission.PAYOUT_REJECT);
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const reason = interaction.fields.getTextInputValue('reason')?.trim();
  const actor = { discordId: interaction.user.id, userId: null };

  await adminPayoutService.rejectPayout(payoutId, actor, reason);
  await safeEditReply(interaction, {
    content: `❌ Payout request \`${payoutId}\` has been **REJECTED**. Reserved funds released back to creator.`
  });
}

export async function handleStaffPayoutProcess(interaction, payoutId) {
  assertAdminPermission(interaction, AdminPermission.PAYOUT_PROCESS);
  await ack(interaction);

  const actor = { discordId: interaction.user.id, userId: null };
  const result = await adminPayoutService.processDisbursement(payoutId, actor, 'MANUAL');

  const req = await adminPayoutService.getPayoutDetails(payoutId);
  await enrichPayoutReq(req);
  const embed = buildStaffPayoutDetailEmbed(req);
  const row = buildStaffPayoutDetailRow(req.id, req.status, false);

  await safeEditReply(interaction, {
    content: `💸 Disbursement processed! (Ref: \`${result.disbursement?.providerReference || 'MANUAL'}\`).`,
    embeds: [embed],
    components: [row]
  });
}

// =========================================================================
// 5. AUDIT LOG WORKSPACE (#audit-log)
// =========================================================================

export async function handleStaffAuditHub(interaction) {
  assertAdminPermission(interaction, AdminPermission.AUDIT_VIEW);
  await ack(interaction);

  const total = await prisma.adminAuditEvent.count().catch(() => 0);
  const embed = buildStaffAuditHubEmbed({ totalEvents: total });
  const row = buildStaffAuditHubRow();

  await safeEditReply(interaction, { embeds: [embed], components: [row] });
}

export async function handleStaffAuditList(interaction, page = 1) {
  assertAdminPermission(interaction, AdminPermission.AUDIT_VIEW);
  await ack(interaction);

  const p = Math.max(1, parseInt(page, 10) || 1);
  const auditData = await adminAuditService.getAuditTrail({ page: p, limit: PAGE_SIZE }).catch(() => ({ items: [], total: 0, totalPages: 1 }));

  const embed = buildStaffAuditListEmbed(auditData.items, p, auditData.totalPages);
  const row = buildStaffAuditNavRow(p, auditData.totalPages);

  await safeEditReply(interaction, { embeds: [embed], components: [row] });
}

// =========================================================================
// 6. SYSTEM STATUS & ERRORS (#bot-status & #bot-errors)
// =========================================================================

export async function handleStaffSystemStatus(interaction) {
  assertAdminPermission(interaction, AdminPermission.AUDIT_VIEW);
  await ack(interaction);

  // Measure database latency
  const dbStart = Date.now();
  await prisma.$queryRaw`SELECT 1`.catch(() => {});
  const dbLatency = Date.now() - dbStart;

  const mem = process.memoryUsage();
  const memoryMb = Math.round(mem.rss / (1024 * 1024));
  const uptimeSec = Math.floor(process.uptime());
  const hours = Math.floor(uptimeSec / 3600);
  const mins = Math.floor((uptimeSec % 3600) / 60);

  const embed = buildStaffSystemStatusEmbed({
    gatewayPing: interaction.client.ws.ping >= 0 ? interaction.client.ws.ping : 0,
    dbLatency,
    memoryMb,
    uptimeStr: `${hours}h ${mins}m`,
    redisStatus: 'Deferred/Offline fallback'
  });
  const row = buildStaffSystemStatusRow();

  await safeEditReply(interaction, { embeds: [embed], components: [row] });
}


export async function handleStaffBotErrorsRefresh(interaction) {
  assertAdminPermission(interaction, AdminPermission.AUDIT_VIEW);
  await ack(interaction);

  const embed = buildStaffBotErrorsEmbed({ recentCount: 0 });
  const row = buildStaffSystemErrorsRow();

  await safeEditReply(interaction, { embeds: [embed], components: [row] });
}

// =========================================================================
// 8. SUBMISSION REGISTRY WORKSPACE (cross-channel registry of all clips)
// =========================================================================

/**
 * List all submissions with optional platform/status filter and pagination.
 */
export async function handleStaffSubmissionRegistryList(interaction, page = 1, platform = 'ALL', status = 'ALL') {
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_VIEW);
  await ack(interaction);

  const p = Math.max(1, parseInt(page, 10) || 1);
  const filters = {
    page: p,
    limit: PAGE_SIZE,
    platform: platform !== 'ALL' ? platform : undefined,
    status: status !== 'ALL' ? status : undefined
  };

  const result = await adminSubmissionService.listSubmissions(filters);
  const items = Array.isArray(result) ? result : (result?.items || []);
  const totalCount = result?.total ?? items.length;
  const totalPages = result?.totalPages ?? Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const embed = buildStaffSubmissionRegistryEmbed(items, { page: p, totalPages, totalCount, platform, status });
  const navRow = buildStaffSubmissionRegistryNavRow(p, totalPages, platform, status);

  // Per-submission view buttons (up to 5)
  const rows = [navRow];
  if (items.length > 0) {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
    const { staffIds } = await import('../components/staffComponentIds.js');
    const viewRow = new ActionRowBuilder();
    items.slice(0, 5).forEach((sub, i) => {
      const idx = (p - 1) * PAGE_SIZE + i + 1;
      viewRow.addComponents(
        new ButtonBuilder()
          .setCustomId(staffIds.subView(sub.id))
          .setLabel(`🔎 #${idx}`)
          .setStyle(ButtonStyle.Secondary)
      );
    });
    rows.unshift(viewRow);
  }

  await safeEditReply(interaction, { embeds: [embed], components: rows });
}

/**
 * View a single submission from the registry (same as review-queue detail view).
 */
export async function handleStaffSubmissionRegistryDetail(interaction, submissionId) {
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_VIEW);
  await ack(interaction);

  const submission = await adminSubmissionService.getSubmissionDetails(submissionId, { isStaff: true });
  const embed = buildStaffSubmissionDetailEmbed(submission);
  const rows = buildStaffSubmissionDetailRow(submission.id, submission.status, submission.url);

  await safeEditReply(interaction, { embeds: [embed], components: rows });
}

/**
 * Refresh live metrics for a submission by fetching from the platform provider.
 */
export async function handleStaffSubmissionRefreshMetrics(interaction, submissionId) {
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_REVIEW);

  // In-flight deduplication: prevent accidental double execution while refresh is running
  if (inFlightRefreshes.has(submissionId)) {
    if (!interaction.deferred && !interaction.replied) {
      if (typeof interaction.reply === 'function') {
        await interaction.reply({
          content: `⚠️ A metrics refresh is already in progress for submission \`${submissionId}\`. Please wait a moment.`,
          flags: MessageFlags.Ephemeral
        }).catch(() => {});
      } else if (typeof interaction.update === 'function') {
        await interaction.update({
          content: `⚠️ A metrics refresh is already in progress for submission \`${submissionId}\`. Please wait a moment.`
        }).catch(() => {});
      }
    }
    return;
  }

  inFlightRefreshes.add(submissionId);

  try {
    // Immediate loading feedback with temporarily disabled button row (<300ms perceived response)
    await showLoadingFeedback(
      interaction,
      `🔄 Refreshing metrics for \`${submissionId}\`...`,
      buildStaffSubmissionRefreshingRow(submissionId)
    );

    const actor = { discordId: interaction.user.id, userId: null };
    const updated = await adminSubmissionService.refreshSubmissionMetrics(submissionId, actor);
    const submission = updated.submission;

    const embed = buildStaffSubmissionDetailEmbed(submission);
    const rows = buildStaffSubmissionDetailRow(submission.id, submission.status, submission.url);

    // Surface availability info from refresh result
    const availabilityNote = updated?.lastAvailabilityStatus
      ? `\n🌐 Availability: \`${updated.lastAvailabilityStatus}\``
      : '';

    await safeEditReply(interaction, {
      content: `✅ Metrics refreshed for \`${submissionId}\`.${availabilityNote}`,
      embeds: [embed],
      components: rows
    });
  } finally {
    inFlightRefreshes.delete(submissionId);
  }
}

/**
 * Present the manual metrics entry modal to staff.
 */
export async function handleStaffSubmissionManualMetricsBtn(interaction, submissionId) {
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_REVIEW);
  const modal = buildStaffManualMetricsModal(submissionId);
  await interaction.showModal(modal);
}

/**
 * Handle submission of the manual metrics entry modal.
 */
export async function handleStaffSubmissionManualMetricsModalSubmit(interaction, submissionId) {
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_REVIEW);
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const viewsStr = interaction.fields.getTextInputValue('views')?.trim();
  const likesStr = interaction.fields.getTextInputValue('likes')?.trim() || null;
  const commentsStr = interaction.fields.getTextInputValue('comments')?.trim() || null;
  const sharesStr = interaction.fields.getTextInputValue('shares')?.trim() || null;
  const notes = interaction.fields.getTextInputValue('notes')?.trim() || null;

  if (!viewsStr || isNaN(Number(viewsStr)) || Number(viewsStr) < 0) {
    await safeEditReply(interaction, {
      content: '❌ Invalid views count. A non-negative integer is required.'
    });
    return;
  }

  const actor = { discordId: interaction.user.id, userId: null };
  await adminSubmissionService.recordManualMetrics(submissionId, {
    views: viewsStr,
    likes: likesStr,
    comments: commentsStr,
    shares: sharesStr,
    notes
  }, actor);

  const submission = await adminSubmissionService.getSubmissionDetails(submissionId, { isStaff: true });
  const embed = buildStaffSubmissionDetailEmbed(submission);
  const rows = buildStaffSubmissionDetailRow(submission.id, submission.status, submission.url, submission.platform);

  await safeEditReply(interaction, {
    content: `✅ Verified metrics recorded manually for submission \`${submissionId}\`.\n👁️ Views: **${Number(viewsStr).toLocaleString()}**${likesStr ? ` | ❤️ Likes: **${Number(likesStr).toLocaleString()}**` : ''}`,
    embeds: [embed],
    components: rows
  });
}

/**
 * View paginated metric snapshot history for a submission.
 */
export async function handleStaffSubmissionAnalytics(interaction, submissionId, page = 1) {
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_VIEW);
  await showLoadingFeedback(interaction, '⏳ Loading analytics...');

  const p = Math.max(1, parseInt(page, 10) || 1);
  const analyticsResult = await adminSubmissionService.getSubmissionAnalytics(submissionId, { page: p, limit: PAGE_SIZE });

  const embed = buildStaffSubmissionAnalyticsEmbed(analyticsResult);
  const navRow = buildStaffAnalyticsNavRow(
    submissionId,
    analyticsResult.page || p,
    analyticsResult.totalPages || 1
  );

  await safeEditReply(interaction, { content: null, embeds: [embed], components: [navRow] });
}

/**
 * Open the submission search modal.
 */
export async function handleStaffSubmissionSearchBtn(interaction) {
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_VIEW);
  const modal = buildSubmissionSearchModal();
  await interaction.showModal(modal);
}

/**
 * Handle submission search modal submit — search by ID, URL, or creator handle.
 */
export async function handleStaffSubmissionSearchModalSubmit(interaction) {
  assertAdminPermission(interaction, AdminPermission.SUBMISSION_VIEW);
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const query = interaction.fields.getTextInputValue('query')?.trim();
  if (!query) {
    await safeEditReply(interaction, { content: '⚠️ No search query provided.' });
    return;
  }

  const result = await adminSubmissionService.listSubmissions({ search: query, page: 1, limit: PAGE_SIZE });
  const items = Array.isArray(result) ? result : (result?.items || []);
  const totalCount = result?.total ?? items.length;
  const totalPages = result?.totalPages ?? Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  if (items.length === 0) {
    await safeEditReply(interaction, { content: `🔍 No submissions found matching: \`${query}\`` });
    return;
  }

  // If exact single match, show detail view directly
  if (items.length === 1) {
    const submission = await adminSubmissionService.getSubmissionDetails(items[0].id, { isStaff: true });
    const embed = buildStaffSubmissionDetailEmbed(submission);
    const rows = buildStaffSubmissionDetailRow(submission.id, submission.status, submission.url);
    await safeEditReply(interaction, { embeds: [embed], components: rows });
    return;
  }


  // Multiple results — show registry list
  const embed = buildStaffSubmissionRegistryEmbed(items, {
    page: 1, totalPages, totalCount, platform: 'ALL', status: 'ALL'
  });
  const navRow = buildStaffSubmissionRegistryNavRow(1, totalPages, 'ALL', 'ALL');
  await safeEditReply(interaction, { embeds: [embed], components: [navRow] });
}
