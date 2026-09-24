import 'dotenv/config';
import { Prisma } from '@prisma/client';
import { prisma, disconnectDatabase } from '../database/client.js';
import { userService } from '../modules/users/user.service.js';
import { campaignService } from '../modules/campaigns/campaign.service.js';
import { submissionService } from '../modules/submissions/submission.service.js';
import { statisticsService } from '../modules/statistics/statistics.service.js';
import { earningsService } from '../modules/earnings/earnings.service.js';
import { payoutService } from '../modules/payouts/payout.service.js';
import { adminCampaignService } from '../modules/admin/admin.campaign.service.js';
import { adminCreatorService } from '../modules/admin/admin.creator.service.js';
import { assertAdminPermission } from '../modules/admin/admin.auth.js';
import { NotCampaignMemberError } from '../modules/submissions/submission.errors.js';
import { InsufficientBalanceError, BelowMinimumPayoutError } from '../modules/payouts/payout.errors.js';
import { UnauthorizedAdminActionError } from '../modules/admin/admin.errors.js';
import { UserSuspendedError, UserBannedError } from '../modules/users/user.errors.js';
import { DEV_FIXTURES } from './seed-dev.js';
import { logger } from '../utils/logger.js';

export async function verifyDevPlatform() {
  logger.info('=== Starting Phase 9C.2 DEV Platform Verification ===');
  const results = {};

  // -------------------------------------------------------------
  // 1. Database Verification
  // -------------------------------------------------------------
  logger.info('Step 1: Database records verification...');

  // Creator
  const creator = await prisma.user.findUnique({
    where: { discordId: DEV_FIXTURES.CREATOR.discordId }
  });
  if (!creator || creator.status !== 'ACTIVE') {
    throw new Error(`Creator fixture missing or not ACTIVE. Found: ${JSON.stringify(creator)}`);
  }

  // Campaign A
  const campaignA = await prisma.campaign.findUnique({
    where: { slug: 'dev-youtube-campaign' }
  });
  if (!campaignA || campaignA.status !== 'ACTIVE') {
    throw new Error(`Campaign A missing or not ACTIVE. Found: ${JSON.stringify(campaignA)}`);
  }

  // Campaign B
  const campaignB = await prisma.campaign.findUnique({
    where: { slug: 'dev-secondary-campaign' }
  });
  if (!campaignB || campaignB.status !== 'ACTIVE') {
    throw new Error(`Campaign B missing or not ACTIVE. Found: ${JSON.stringify(campaignB)}`);
  }

  // Membership A
  const membershipA = await prisma.campaignMember.findUnique({
    where: {
      userId_campaignId: {
        userId: creator.id,
        campaignId: campaignA.id
      }
    }
  });
  if (!membershipA || membershipA.status !== 'ACTIVE') {
    throw new Error(`Membership A missing or not ACTIVE. Found: ${JSON.stringify(membershipA)}`);
  }

  // Membership B should NOT exist initially (isolation check)
  const membershipBInitial = await prisma.campaignMember.findUnique({
    where: {
      userId_campaignId: {
        userId: creator.id,
        campaignId: campaignB.id
      }
    }
  });

  results.database = {
    creatorId: creator.id,
    creatorStatus: creator.status,
    campaignAId: campaignA.id,
    campaignAStatus: campaignA.status,
    campaignBId: campaignB.id,
    campaignBStatus: campaignB.status,
    membershipAStatus: membershipA.status,
    membershipBInitiallyExists: !!membershipBInitial
  };
  logger.info(results.database, 'Step 1 complete: Database verification passed');

  // -------------------------------------------------------------
  // 2. Database Constraint Verification
  // -------------------------------------------------------------
  logger.info('Step 2: Database constraint verification...');

  // Constraint 1: Unique discordId
  let duplicateDiscordCaught = false;
  try {
    await prisma.user.create({
      data: {
        discordId: DEV_FIXTURES.CREATOR.discordId,
        username: 'violator_discord_id'
      }
    });
  } catch (err) {
    if (err.code === 'P2002') duplicateDiscordCaught = true;
  }
  if (!duplicateDiscordCaught) {
    throw new Error('Database failed to enforce unique discordId constraint');
  }

  // Constraint 2: Unique slug
  let duplicateSlugCaught = false;
  try {
    await prisma.campaign.create({
      data: {
        name: 'Violator Slug Campaign',
        slug: 'dev-youtube-campaign',
        description: 'Violator Description',
        clientName: 'Violator Client',
        status: 'ACTIVE',
        payRate: new Prisma.Decimal('1.00'),
        minimumPayout: new Prisma.Decimal('10.00'),
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 10000)
      }
    });
  } catch (err) {
    if (err.code === 'P2002') duplicateSlugCaught = true;
  }
  if (!duplicateSlugCaught) {
    throw new Error('Database failed to enforce unique campaign slug constraint');
  }

  // Constraint 3: Unique (userId, campaignId) membership
  let duplicateMemberCaught = false;
  try {
    await prisma.campaignMember.create({
      data: {
        userId: creator.id,
        campaignId: campaignA.id,
        status: 'ACTIVE'
      }
    });
  } catch (err) {
    if (err.code === 'P2002') duplicateMemberCaught = true;
  }
  if (!duplicateMemberCaught) {
    throw new Error('Database failed to enforce unique (userId, campaignId) membership constraint');
  }

  results.constraints = {
    uniqueDiscordIdEnforced: duplicateDiscordCaught,
    uniqueSlugEnforced: duplicateSlugCaught,
    uniqueMembershipEnforced: duplicateMemberCaught
  };
  logger.info(results.constraints, 'Step 2 complete: Constraints verified');

  // -------------------------------------------------------------
  // 3. CampaignService Verification
  // -------------------------------------------------------------
  logger.info('Step 3: CampaignService verification...');
  const activeCampaigns = await campaignService.listActiveCampaigns();
  const slugs = activeCampaigns.map((c) => c.slug);
  if (!slugs.includes('dev-youtube-campaign') || !slugs.includes('dev-secondary-campaign')) {
    throw new Error(`listActiveCampaigns did not return both DEV campaigns. Slugs found: ${slugs.join(', ')}`);
  }

  // Creator can join Campaign B
  const joinedB = await campaignService.joinCampaign(creator.id, campaignB.id);
  if (!joinedB || joinedB.status !== 'ACTIVE') {
    throw new Error(`Failed to join Campaign B: ${JSON.stringify(joinedB)}`);
  }

  // Repeated join is idempotent
  const repeatedJoinB = await campaignService.joinCampaign(creator.id, campaignB.id);
  if (repeatedJoinB.id !== joinedB.id) {
    throw new Error('Repeated join created duplicate membership record');
  }

  // Creator can leave Campaign B to restore original state
  await campaignService.leaveCampaign(creator.id, campaignB.id);
  const leftB = await prisma.campaignMember.findUnique({
    where: { userId_campaignId: { userId: creator.id, campaignId: campaignB.id } }
  });
  if (leftB.status !== 'LEFT') {
    throw new Error(`Expected membership B status LEFT, got ${leftB.status}`);
  }

  results.campaignService = {
    activeCampaignCount: activeCampaigns.length,
    containsDevCampaigns: true,
    joinSucceeded: true,
    joinIdempotent: true,
    leaveSucceeded: true
  };
  logger.info(results.campaignService, 'Step 3 complete: CampaignService verified');

  // -------------------------------------------------------------
  // 4. UserService Verification
  // -------------------------------------------------------------
  logger.info('Step 4: UserService verification...');
  const userProfile = await userService.getProfile(creator.id);
  if (!userProfile || userProfile.discordId !== DEV_FIXTURES.CREATOR.discordId) {
    throw new Error('userService.getProfile returned unexpected user profile');
  }

  // Active check passes
  userService.assertUserCanParticipate(userProfile);

  // Suspended check
  let suspendedCaught = false;
  try {
    userService.assertUserCanParticipate({ ...userProfile, status: 'SUSPENDED' });
  } catch (err) {
    if (err instanceof UserSuspendedError) suspendedCaught = true;
  }
  if (!suspendedCaught) throw new Error('assertUserCanParticipate failed to catch SUSPENDED status');

  // Banned check
  let bannedCaught = false;
  try {
    userService.assertUserCanParticipate({ ...userProfile, status: 'BANNED' });
  } catch (err) {
    if (err instanceof UserBannedError) bannedCaught = true;
  }
  if (!bannedCaught) throw new Error('assertUserCanParticipate failed to catch BANNED status');

  results.userService = {
    profileRetrieved: true,
    activeCheckPassed: true,
    suspendedGuardActive: suspendedCaught,
    bannedGuardActive: bannedCaught
  };
  logger.info(results.userService, 'Step 4 complete: UserService verified');

  // -------------------------------------------------------------
  // 5. SubmissionService Verification
  // -------------------------------------------------------------
  logger.info('Step 5: SubmissionService verification...');
  // Verify membership requirement: Attempt submission to Campaign B while membership is LEFT
  let notMemberCaught = false;
  try {
    await submissionService.createSubmission({
      userId: creator.id,
      campaignId: campaignB.id,
      rawUrl: 'https://youtube.com/shorts/dQw4w9WgXcQ'
    });
  } catch (err) {
    if (err instanceof NotCampaignMemberError) {
      notMemberCaught = true;
    }
  }
  if (!notMemberCaught) {
    throw new Error('submissionService allowed submission to campaign where user is not an active member');
  }

  results.submissionService = {
    membershipRequirementEnforced: notMemberCaught
  };
  logger.info(results.submissionService, 'Step 5 complete: SubmissionService verified');

  // -------------------------------------------------------------
  // 6. StatisticsService Verification
  // -------------------------------------------------------------
  logger.info('Step 6: StatisticsService verification...');
  const userStats = await statisticsService.getUserOverview(creator.id);
  if (userStats.totalSubmissions !== 0 || userStats.totalViews.knownSum !== null) {
    throw new Error(`Unexpected statistics for new creator: ${JSON.stringify(userStats)}`);
  }

  const campaignAStats = await statisticsService.getCampaignOverview(creator.id, campaignA.id);
  if (campaignAStats.totalSubmissions !== 0 || campaignAStats.membership.status !== 'ACTIVE') {
    throw new Error(`Unexpected campaign statistics: ${JSON.stringify(campaignAStats)}`);
  }

  results.statisticsService = {
    totalSubmissions: userStats.totalSubmissions,
    totalViewsKnownSum: userStats.totalViews.knownSum,
    activeCampaignsJoined: userStats.activeCampaignsJoined,
    campaignMembershipStatus: campaignAStats.membership.status
  };
  logger.info(results.statisticsService, 'Step 6 complete: StatisticsService verified');

  // -------------------------------------------------------------
  // 7. EarningsService Verification
  // -------------------------------------------------------------
  logger.info('Step 7: EarningsService verification...');
  const balance = await earningsService.getUserBalance(creator.id);
  const earningsOverview = await earningsService.getUserEarnings(creator.id);

  if (!balance.eligibleEarnings.equals(new Prisma.Decimal('0.00')) ||
      !balance.totalGrossEarnings.equals(new Prisma.Decimal('0.00'))) {
    throw new Error(`Expected zero earnings for new creator, got: ${JSON.stringify(balance)}`);
  }
  if (earningsOverview.isPayoutThresholdReached !== false) {
    throw new Error('Payout threshold should not be reached with zero earnings');
  }

  results.earningsService = {
    eligibleEarnings: balance.eligibleEarnings.toFixed(2),
    totalGrossEarnings: balance.totalGrossEarnings.toFixed(2),
    totalEligibleViews: balance.totalEligibleViews.toString(),
    isPayoutThresholdReached: earningsOverview.isPayoutThresholdReached
  };
  logger.info(results.earningsService, 'Step 7 complete: EarningsService verified');

  // -------------------------------------------------------------
  // 8. PayoutService Verification
  // -------------------------------------------------------------
  logger.info('Step 8: PayoutService verification...');
  // Attempt payout creation with zero balance: should fail with BelowMinimumPayoutError or InsufficientBalanceError
  let payoutRejected = false;
  let rejectionErrorName = null;
  try {
    await payoutService.createPayoutRequest(creator.id, '10.00', 'USD');
  } catch (err) {
    payoutRejected = true;
    rejectionErrorName = err.name;
    if (!(err instanceof InsufficientBalanceError) && !(err instanceof BelowMinimumPayoutError)) {
      throw new Error(`Unexpected payout error: ${err.name} - ${err.message}`);
    }
  }
  if (!payoutRejected) {
    throw new Error('PayoutService allowed payout creation with zero balance');
  }

  // Attempt payout creation below minimum: $5.00 when min is $10.00
  let belowMinRejected = false;
  try {
    await payoutService.createPayoutRequest(creator.id, '5.00', 'USD');
  } catch (err) {
    if (err instanceof BelowMinimumPayoutError) {
      belowMinRejected = true;
    }
  }
  if (!belowMinRejected) {
    throw new Error('PayoutService allowed payout creation below minimum payout threshold');
  }

  results.payoutService = {
    zeroBalancePayoutBlocked: payoutRejected,
    rejectionReason: rejectionErrorName,
    belowMinimumPayoutBlocked: belowMinRejected
  };
  logger.info(results.payoutService, 'Step 8 complete: PayoutService verified');

  // -------------------------------------------------------------
  // 9. Admin Services & Authorization Verification
  // -------------------------------------------------------------
  logger.info('Step 9: Admin Services & Authorization verification...');
  // Admin discovery of campaign
  const adminCampaignDetails = await adminCampaignService.getCampaignDetails(campaignA.id);
  if (!adminCampaignDetails || adminCampaignDetails.slug !== 'dev-youtube-campaign') {
    throw new Error('adminCampaignService failed to retrieve campaign details');
  }

  // Admin discovery of creator
  const adminCreatorDetails = await adminCreatorService.getCreatorDetails(creator.id);
  if (!adminCreatorDetails || adminCreatorDetails.discordId !== DEV_FIXTURES.CREATOR.discordId) {
    throw new Error('adminCreatorService failed to retrieve creator details');
  }

  // Unauthorized access check
  let unauthorizedCaught = false;
  try {
    const creatorInteraction = {
      member: {
        roles: ['1551291864496214056'], // Creator role ID
        permissions: 0n
      }
    };
    assertAdminPermission(creatorInteraction, 'CAMPAIGN_CREATE');
  } catch (err) {
    if (err instanceof UnauthorizedAdminActionError) {
      unauthorizedCaught = true;
    }
  }
  if (!unauthorizedCaught) {
    throw new Error('assertAdminPermission failed to block creator from administrative action');
  }

  results.adminServices = {
    campaignDiscovered: true,
    creatorDiscovered: true,
    unauthorizedCreatorBlocked: unauthorizedCaught
  };
  logger.info(results.adminServices, 'Step 9 complete: Admin Services verified');

  logger.info('=== All Phase 9C.2 Platform Verifications Succeeded! ===');
  return results;
}

// CLI entry point
if (process.argv[1]?.replace(/\\/g, '/').endsWith('src/scripts/verify-dev-platform.js')) {
  verifyDevPlatform()
    .then((results) => {
      console.log('VERIFY_DEV_PLATFORM_SUCCESS', JSON.stringify(results, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err: err.message, stack: err.stack }, 'Platform verification failed');
      process.exit(1);
    })
    .finally(async () => {
      await disconnectDatabase();
    });
}
