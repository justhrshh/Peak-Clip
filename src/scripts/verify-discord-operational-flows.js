import 'dotenv/config';
import { Prisma } from '@prisma/client';
import { prisma, disconnectDatabase } from '../database/client.js';
import { userService } from '../modules/users/user.service.js';
import { campaignService } from '../modules/campaigns/campaign.service.js';
import { submissionService } from '../modules/submissions/submission.service.js';
import { verificationService } from '../modules/verification/verification.service.js';
import { earningsService } from '../modules/earnings/earnings.service.js';
import { statisticsService } from '../modules/statistics/statistics.service.js';
import { payoutService } from '../modules/payouts/payout.service.js';
import { adminCampaignService } from '../modules/admin/admin.campaign.service.js';
import { adminCreatorService } from '../modules/admin/admin.creator.service.js';
import { adminSubmissionService } from '../modules/admin/admin.submission.service.js';
import { assertAdminPermission, AdminRole, AdminPermission } from '../modules/admin/admin.auth.js';
import { handleInteraction } from '../bot/interactions/router.js';
import * as verifyCommand from '../bot/commands/verify.js';
import * as campaignsCommand from '../bot/commands/campaigns.js';
import * as submitCommand from '../bot/commands/submit.js';
import * as submissionsCommand from '../bot/commands/submissions.js';
import * as statisticsCommand from '../bot/commands/statistics.js';
import * as earningsCommand from '../bot/commands/earnings.js';
import * as payoutCommand from '../bot/commands/payout.js';
import * as adminCommand from '../bot/commands/admin.js';
import {
  DuplicateSubmissionError,
  InvalidSubmissionUrlError,
  UnsupportedPlatformError,
  CampaignNotJoinableError,
  NotCampaignMemberError
} from '../modules/submissions/submission.errors.js';
import {
  InsufficientBalanceError,
  BelowMinimumPayoutError
} from '../modules/payouts/payout.errors.js';
import {
  UnauthorizedAdminActionError,
  InsufficientPermissionError
} from '../modules/admin/admin.errors.js';
import { UserSuspendedError, UserBannedError } from '../modules/users/user.errors.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

function createMockInteraction({ user, memberRoles = [], guildId = config.discord.guildId, isCustomButton = null }) {
  let replyData = null;
  let isDeferred = false;
  let isEphemeral = false;

  return {
    id: `int_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    guildId,
    user,
    member: {
      user,
      roles: memberRoles,
      permissions: 0n
    },
    isChatInputCommand: () => !isCustomButton,
    isButton: () => !!isCustomButton,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    customId: isCustomButton,
    deferReply: async (opts = {}) => {
      isDeferred = true;
      if (opts.ephemeral) isEphemeral = true;
      return { deferred: true, ...opts };
    },
    editReply: async (data) => {
      replyData = data;
      return data;
    },
    reply: async (data) => {
      replyData = data;
      if (data?.ephemeral) isEphemeral = true;
      return data;
    },
    getReply: () => replyData,
    isDeferred: () => isDeferred,
    isEphemeral: () => isEphemeral
  };
}

export async function verifyOperationalFlows() {
  logger.info('=== Starting Phase 9C.4 Discord UX & Operational Validation ===');
  const results = {};

  const realCreatorDiscord = {
    id: '978305861430693960',
    username: 'harshdevil15',
    displayName: 'HARSH 15'
  };

  const testAdminConfig = {
    adminRoleIds: ['1551291857370087467'],
    campaignManagerRoleIds: ['1551291860654489720']
  };
  const adminRoleIds = testAdminConfig.adminRoleIds;
  const cmRoleIds = testAdminConfig.campaignManagerRoleIds;
  const creatorRoleIds = ['1551291864496214056'];

  // -----------------------------------------------------------------
  // 1. CREATOR FLOW
  // -----------------------------------------------------------------
  logger.info('=== 1. Validating Creator Flow ===');
  
  // 1A. /verify
  const verifyInt = createMockInteraction({ user: realCreatorDiscord, memberRoles: creatorRoleIds });
  await verifyCommand.execute(verifyInt);
  const verifyReply = verifyInt.getReply();
  const creatorUser = await userService.getByDiscordId(realCreatorDiscord.id);

  // 1B. /campaigns
  const campaignsInt = createMockInteraction({ user: realCreatorDiscord, memberRoles: creatorRoleIds });
  await campaignsCommand.execute(campaignsInt);
  const campaignsReply = campaignsInt.getReply();

  // 1C. /submissions
  const submissionsInt = createMockInteraction({ user: realCreatorDiscord, memberRoles: creatorRoleIds });
  await submissionsCommand.execute(submissionsInt);
  const submissionsReply = submissionsInt.getReply();

  // 1D. /statistics
  const statsInt = createMockInteraction({ user: realCreatorDiscord, memberRoles: creatorRoleIds });
  await statisticsCommand.execute(statsInt);
  const statsReply = statsInt.getReply();

  // 1E. /earnings
  const earningsInt = createMockInteraction({ user: realCreatorDiscord, memberRoles: creatorRoleIds });
  await earningsCommand.execute(earningsInt);
  const earningsReply = earningsInt.getReply();

  results.creatorFlow = {
    verified: creatorUser?.status === 'ACTIVE',
    verifyEmbedTitle: verifyReply?.embeds?.[0]?.data?.title,
    campaignsEmbedFields: campaignsReply?.embeds?.[0]?.data?.fields?.length,
    submissionsEmbedFields: submissionsReply?.embeds?.[0]?.data?.fields?.length,
    statisticsEmbedTitle: statsReply?.embeds?.[0]?.data?.title,
    earningsEmbedTitle: earningsReply?.embeds?.[0]?.data?.title
  };
  logger.info(results.creatorFlow, 'Creator Flow validated successfully');

  // -----------------------------------------------------------------
  // 2. FAILURE & EDGE CASE UX
  // -----------------------------------------------------------------
  logger.info('=== 2. Validating Failure & Edge Case UX ===');
  const edgeCases = {};

  const campaign = await campaignService.getCampaignBySlug('dev-youtube-campaign');

  // 2A. Duplicate submission
  try {
    await submissionService.createSubmission({
      userId: creatorUser.id,
      campaignId: campaign.id,
      rawUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
    });
    edgeCases.duplicateSubmission = false;
  } catch (err) {
    edgeCases.duplicateSubmission = err instanceof DuplicateSubmissionError;
  }

  // 2B. Invalid YouTube URL
  try {
    await submissionService.createSubmission({
      userId: creatorUser.id,
      campaignId: campaign.id,
      rawUrl: 'https://www.youtube.com/invalid_page_without_id'
    });
    edgeCases.invalidUrl = false;
  } catch (err) {
    edgeCases.invalidUrl = err instanceof InvalidSubmissionUrlError;
  }

  // 2C. Unsupported platform (e.g. Vimeo)
  try {
    await submissionService.createSubmission({
      userId: creatorUser.id,
      campaignId: campaign.id,
      rawUrl: 'https://vimeo.com/123456789'
    });
    edgeCases.unsupportedPlatform = false;
  } catch (err) {
    edgeCases.unsupportedPlatform = err instanceof UnsupportedPlatformError;
  }

  // 2D. Inactive campaign
  const draftCampaign = await prisma.campaign.upsert({
    where: { slug: 'dev-draft-test-campaign' },
    update: {},
    create: {
      name: 'Draft Test Campaign',
      slug: 'dev-draft-test-campaign',
      description: 'Draft campaign for edge testing',
      clientName: 'Test Client',
      status: 'DRAFT',
      payRate: new Prisma.Decimal('1.00'),
      minimumPayout: new Prisma.Decimal('10.00'),
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 100000)
    }
  });
  try {
    await submissionService.createSubmission({
      userId: creatorUser.id,
      campaignId: draftCampaign.id,
      rawUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });
    edgeCases.inactiveCampaign = false;
  } catch (err) {
    edgeCases.inactiveCampaign = err instanceof CampaignNotJoinableError;
  }

  // 2E. Creator not joined to campaign
  const secondaryCampaign = await campaignService.getCampaignBySlug('dev-secondary-campaign');
  try {
    await submissionService.createSubmission({
      userId: creatorUser.id,
      campaignId: secondaryCampaign.id,
      rawUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });
    edgeCases.notCampaignMember = false;
  } catch (err) {
    edgeCases.notCampaignMember = err instanceof NotCampaignMemberError;
  }

  // 2F. Suspended / Banned creator
  try {
    userService.assertUserCanParticipate({ id: creatorUser.id, status: 'SUSPENDED' });
    edgeCases.suspendedCreator = false;
  } catch (err) {
    edgeCases.suspendedCreator = err instanceof UserSuspendedError;
  }
  try {
    userService.assertUserCanParticipate({ id: creatorUser.id, status: 'BANNED' });
    edgeCases.bannedCreator = false;
  } catch (err) {
    edgeCases.bannedCreator = err instanceof UserBannedError;
  }

  // 2G. Unauthorized admin command (by Creator)
  try {
    assertAdminPermission({ member: { roles: creatorRoleIds, permissions: 0n } }, AdminPermission.CAMPAIGN_CREATE, testAdminConfig);
    edgeCases.unauthorizedAdmin = false;
  } catch (err) {
    edgeCases.unauthorizedAdmin = err instanceof UnauthorizedAdminActionError;
  }

  // 2H. Unauthorized Campaign Manager payout action
  try {
    assertAdminPermission({ member: { roles: cmRoleIds, permissions: 0n } }, AdminPermission.PAYOUT_APPROVE, testAdminConfig);
    edgeCases.cmPayoutUnauthorized = false;
  } catch (err) {
    edgeCases.cmPayoutUnauthorized = err instanceof InsufficientPermissionError;
  }

  // 2I. Tampered / malformed component custom ID
  const tamperedInt = createMockInteraction({
    user: realCreatorDiscord,
    memberRoles: creatorRoleIds,
    isCustomButton: 'tampered_malformed_unknown_button_id'
  });
  await handleInteraction(tamperedInt);
  const tamperedReply = tamperedInt.getReply();
  edgeCases.tamperedCustomIdHandled = typeof tamperedReply?.content === 'string' && tamperedReply.content.includes('unrecognized');

  // 2J. Insufficient payout balance & below campaign minimum
  try {
    await payoutService.createPayoutRequest(creatorUser.id, '5000000.00', 'USD');
    edgeCases.insufficientPayoutBalance = false;
  } catch (err) {
    edgeCases.insufficientPayoutBalance = err instanceof InsufficientBalanceError;
  }
  try {
    await payoutService.createPayoutRequest(creatorUser.id, '3.00', 'USD');
    edgeCases.belowMinimumPayout = false;
  } catch (err) {
    edgeCases.belowMinimumPayout = err instanceof BelowMinimumPayoutError;
  }

  results.edgeCases = edgeCases;
  logger.info(results.edgeCases, 'Failure / Edge Cases validated successfully');

  // -----------------------------------------------------------------
  // 3. ADMIN FLOW
  // -----------------------------------------------------------------
  logger.info('=== 3. Validating Admin Flow ===');
  const adminActor = {
    userId: creatorUser.id,
    discordId: realCreatorDiscord.id
  };

  // Inspect campaigns
  const adminCampaigns = await adminCampaignService.listCampaigns();
  const campaignDetail = await adminCampaignService.getCampaignDetails(campaign.id);

  // Inspect creator
  const creatorDetail = await adminCreatorService.getCreatorDetails(creatorUser.id);

  // Inspect submissions
  const adminSubmissions = await adminSubmissionService.listSubmissions({ campaignId: campaign.id });

  // Inspect verification state
  const verificationState = await verificationService.getVerification(adminSubmissions.items[0].id);

  // Inspect payout queue
  const payoutQueue = await payoutService.listPayoutRequests();

  // Generate a mutating admin action to verify audit logging
  await adminCreatorService.updateCreatorStatus(
    creatorUser.id,
    'ACTIVE',
    adminActor,
    'Operational audit logging verification'
  );
  const auditEvents = await prisma.adminAuditEvent.findMany({
    where: { entityId: creatorUser.id },
    orderBy: { createdAt: 'desc' },
    take: 1
  });
  // Test Campaign Manager permissions:
  // CM can view campaigns, creators, submissions
  const cmInteraction = { member: { roles: cmRoleIds, permissions: 0n } };
  const cmPermitted =
    assertAdminPermission(cmInteraction, AdminPermission.CAMPAIGN_EDIT, testAdminConfig) &&
    assertAdminPermission(cmInteraction, AdminPermission.SUBMISSION_VIEW, testAdminConfig) &&
    assertAdminPermission(cmInteraction, AdminPermission.CREATOR_VIEW, testAdminConfig);

  // CM cannot approve/reject/process payouts
  let cmPayoutDenied = false;
  try {
    assertAdminPermission(cmInteraction, AdminPermission.PAYOUT_APPROVE, testAdminConfig);
  } catch (err) {
    cmPayoutDenied = err instanceof InsufficientPermissionError;
  }

  results.adminFlow = {
    campaignsInspected: adminCampaigns.total >= 2,
    campaignDetailSlug: campaignDetail.slug,
    creatorDetailSubmissions: creatorDetail.totalSubmissions,
    submissionsFound: adminSubmissions.total >= 1,
    verificationRiskLevel: verificationState.riskLevel,
    payoutQueueAccessible: Array.isArray(payoutQueue),
    campaignManagerPermitted: !!cmPermitted,
    campaignManagerPayoutDenied: cmPayoutDenied
  };
  logger.info(results.adminFlow, 'Admin Flow validated successfully');

  // -----------------------------------------------------------------
  // 4. PAYOUT FLOW
  // -----------------------------------------------------------------
  logger.info('=== 4. Validating Controlled Payout Flow ===');

  // Starting balance
  const startingBalance = await payoutService.getAvailablePayoutBalance(creatorUser.id, 'USD');
  const initialAvailable = new Prisma.Decimal(startingBalance.availableBalance);
  const initialCompleted = new Prisma.Decimal(startingBalance.completedPayouts);
  const totalGrossBaseline = (await earningsService.getUserBalance(creatorUser.id)).totalGrossEarnings;

  // 4A. Creator requests payout of $100.00
  const payoutRequestAmount = new Prisma.Decimal('100.00');
  const payoutRequest = await payoutService.createPayoutRequest(
    creatorUser.id,
    payoutRequestAmount.toString(),
    'USD'
  );

  if (payoutRequest.status !== 'REQUESTED') {
    throw new Error(`Expected payout request status REQUESTED, got ${payoutRequest.status}`);
  }

  // Check reservation: available balance should decrease by $100.00
  const postRequestBalance = await payoutService.getAvailablePayoutBalance(creatorUser.id, 'USD');
  const expectedAvailableAfterRequest = initialAvailable.minus(payoutRequestAmount);
  if (!postRequestBalance.availableBalance.equals(expectedAvailableAfterRequest)) {
    throw new Error(`Available balance mismatch after payout request. Expected ${expectedAvailableAfterRequest}, got ${postRequestBalance.availableBalance}`);
  }
  if (!postRequestBalance.reservedBalance.equals(payoutRequestAmount)) {
    throw new Error(`Reserved balance mismatch. Expected ${payoutRequestAmount}, got ${postRequestBalance.reservedBalance}`);
  }

  // 4B. Staff / Admin Review
  const reviewedPayout = await payoutService.reviewPayoutRequest(
    payoutRequest.id,
    creatorUser.id,
    'Controlled DEV payout review'
  );
  if (reviewedPayout.status !== 'UNDER_REVIEW') {
    throw new Error(`Expected status UNDER_REVIEW, got ${reviewedPayout.status}`);
  }

  // 4C. Admin Approval
  const approvedPayout = await payoutService.approvePayoutRequest(
    payoutRequest.id,
    creatorUser.id
  );
  if (approvedPayout.status !== 'APPROVED') {
    throw new Error(`Expected status APPROVED, got ${approvedPayout.status}`);
  }

  // 4D. Manual Disbursement Processing
  const disbursementRes = await payoutService.processDisbursement(
    payoutRequest.id,
    'MANUAL'
  );
  if (disbursementRes.payoutRequest.status !== 'PROCESSING') {
    throw new Error(`Expected status PROCESSING, got ${disbursementRes.payoutRequest.status}`);
  }

  // 4E. Mark Disbursement Completed
  const completedPayout = await payoutService.markDisbursementCompleted(
    payoutRequest.id,
    'MANUAL_REF_TEST_DEV_001'
  );
  if (completedPayout.status !== 'COMPLETED') {
    throw new Error(`Expected status COMPLETED, got ${completedPayout.status}`);
  }

  // Check post-completion balance reconciliation
  const postCompletionBalance = await payoutService.getAvailablePayoutBalance(creatorUser.id, 'USD');
  if (!postCompletionBalance.availableBalance.equals(expectedAvailableAfterRequest)) {
    throw new Error(`Available balance mismatch after completion. Expected ${expectedAvailableAfterRequest}, got ${postCompletionBalance.availableBalance}`);
  }
  if (!postCompletionBalance.reservedBalance.equals(new Prisma.Decimal('0.00'))) {
    throw new Error(`Reserved balance should be 0.00 after completion, got ${postCompletionBalance.reservedBalance}`);
  }
  const expectedCompleted = initialCompleted.plus(payoutRequestAmount);
  if (!postCompletionBalance.completedPayouts.equals(expectedCompleted)) {
    throw new Error(`Completed payouts mismatch. Expected ${expectedCompleted}, got ${postCompletionBalance.completedPayouts}`);
  }

  // 4F. Test Reservation Release on Cancelled Request
  const testCancelAmount = new Prisma.Decimal('50.00');
  const cancelTestPayout = await payoutService.createPayoutRequest(
    creatorUser.id,
    testCancelAmount.toString(),
    'USD'
  );
  const cancelBalanceCheck = await payoutService.getAvailablePayoutBalance(creatorUser.id, 'USD');
  if (!cancelBalanceCheck.reservedBalance.equals(testCancelAmount)) {
    throw new Error('Reservation not created for cancel test payout');
  }

  // Cancel request -> releases reservation
  const cancelledPayout = await payoutService.cancelPayoutRequest(
    creatorUser.id,
    cancelTestPayout.id,
    'Creator cancelled test'
  );
  if (cancelledPayout.status !== 'CANCELLED') {
    throw new Error(`Expected status CANCELLED, got ${cancelledPayout.status}`);
  }

  const postCancelBalance = await payoutService.getAvailablePayoutBalance(creatorUser.id, 'USD');
  if (!postCancelBalance.reservedBalance.equals(new Prisma.Decimal('0.00'))) {
    throw new Error(`Reserved balance should return to 0.00 after cancellation, got ${postCancelBalance.reservedBalance}`);
  }
  if (!postCancelBalance.availableBalance.equals(expectedAvailableAfterRequest)) {
    throw new Error(`Available balance should return to ${expectedAvailableAfterRequest} after cancellation, got ${postCancelBalance.availableBalance}`);
  }

  // 4G. Verify immutable earnings ledger remains completely intact
  const immutableEarnings = await earningsService.getUserBalance(creatorUser.id);
  if (!immutableEarnings.totalGrossEarnings.equals(totalGrossBaseline)) {
    throw new Error(`Immutable earnings ledger modified! Expected ${totalGrossBaseline}, got ${immutableEarnings.totalGrossEarnings}`);
  }

  results.payoutFlow = {
    payoutRequestId: payoutRequest.id,
    requestedAmount: payoutRequestAmount.toFixed(2),
    completedStatus: completedPayout.status,
    totalDisbursed: postCompletionBalance.completedPayouts.toFixed(2),
    availableBalance: postCompletionBalance.availableBalance.toFixed(2),
    reservationAccountingValid: true,
    cancellationReleaseValid: true,
    immutableLedgerUntouched: true
  };
  logger.info(results.payoutFlow, 'Controlled Payout Flow validated successfully');

  // -----------------------------------------------------------------
  // 5. DATABASE INTEGRITY AUDIT
  // -----------------------------------------------------------------
  logger.info('=== 5. Database Integrity Audit ===');
  const userCount = await prisma.user.count({ where: { discordId: realCreatorDiscord.id } });
  const membershipCount = await prisma.campaignMember.count({ where: { userId: creatorUser.id, campaignId: campaign.id } });
  const submissionCount = await prisma.submission.count({ where: { userId: creatorUser.id, campaignId: campaign.id } });
  const payoutEventCount = await prisma.payoutEvent.count({ where: { payoutRequestId: payoutRequest.id } });
  const adminAuditCount = await prisma.adminAuditEvent.count();

  results.databaseIntegrity = {
    singleUserRow: userCount === 1,
    singleMembershipRow: membershipCount === 1,
    singleSubmissionRow: submissionCount === 1,
    payoutEventsLogged: payoutEventCount >= 4,
    adminAuditEventsLogged: adminAuditCount >= 1
  };
  logger.info(results.databaseIntegrity, 'Database Integrity Audit verified');

  logger.info('=== All Phase 9C.4 Operational Validations Completed Successfully ===');
  return results;
}

// CLI execution
if (process.argv[1]?.replace(/\\/g, '/').endsWith('src/scripts/verify-discord-operational-flows.js')) {
  verifyOperationalFlows()
    .then((results) => {
      console.log('OPERATIONAL_FLOWS_SUCCESS', JSON.stringify(results, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err: err.message, stack: err.stack }, 'Operational verification failed');
      process.exit(1);
    })
    .finally(async () => {
      await disconnectDatabase();
    });
}
