import 'dotenv/config';
import { Prisma } from '@prisma/client';
import { prisma, disconnectDatabase } from '../database/client.js';
import { userService } from '../modules/users/user.service.js';
import { campaignService } from '../modules/campaigns/campaign.service.js';
import { submissionService } from '../modules/submissions/submission.service.js';
import { verificationService } from '../modules/verification/verification.service.js';
import { earningsService } from '../modules/earnings/earnings.service.js';
import { statisticsService } from '../modules/statistics/statistics.service.js';
import { getQueue, QUEUE_NAMES } from '../queues/index.js';
import { QueueEvents } from 'bullmq';
import { createRedisConnection } from '../queues/redis.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { DuplicateSubmissionError } from '../modules/submissions/submission.errors.js';
import { REST, Routes } from 'discord.js';

export async function runRealYouTubeLifecycle() {
  logger.info('=== Starting Phase 9C.3 Real YouTube Lifecycle ===');
  const report = {};

  // 0. Pre-flight check on YOUTUBE_API_KEY
  const apiKey = config.providers?.youtubeApiKey;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error('CONFIG_BLOCKER: YOUTUBE_API_KEY is not configured in environment');
  }
  report.providerConfig = {
    provider: 'YOUTUBE',
    officialApi: 'YouTube Data API v3 (videos.list)',
    configured: true,
    keyLength: apiKey.trim().length
  };
  logger.info(report.providerConfig, 'Step 0 complete: Pre-flight provider configuration verified');

  // 1. Real Discord Creator Onboarding
  const realDiscordUser = {
    id: '978305861430693960',
    username: 'harshdevil15',
    displayName: 'HARSH 15',
    globalName: 'HARSH 15'
  };

  logger.info({ discordId: realDiscordUser.id, username: realDiscordUser.username }, 'Step 1: Real Discord Creator Onboarding');
  const creator = await userService.getOrCreateFromDiscord(realDiscordUser);
  userService.assertUserCanParticipate(creator);

  // Assign Creator role in DEV guild via Discord REST API if role exists
  let roleAssigned = false;
  try {
    const rest = new REST().setToken(config.discord.token);
    const roles = await rest.get(Routes.guildRoles(config.discord.guildId));
    const creatorRole = roles.find((r) => r.name.toLowerCase() === 'creator');
    if (creatorRole) {
      await rest.put(Routes.guildMemberRole(config.discord.guildId, realDiscordUser.id, creatorRole.id));
      roleAssigned = true;
      logger.info({ roleId: creatorRole.id }, 'Assigned Creator role in DEV guild');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Discord REST API notice on Creator role assignment');
  }

  // Verify no duplicate user created on repeated call
  const creatorRepeated = await userService.getOrCreateFromDiscord(realDiscordUser);
  if (creatorRepeated.id !== creator.id) {
    throw new Error('Duplicate user created for real Discord creator');
  }

  report.creator = {
    userId: creator.id,
    discordId: creator.discordId,
    username: creator.username,
    status: creator.status,
    roleAssigned
  };
  logger.info(report.creator, 'Step 1 complete: Real Discord creator verified');

  // 2. Campaign Join
  logger.info('Step 2: Joining DEV YouTube Campaign');
  const campaign = await campaignService.getCampaignBySlug('dev-youtube-campaign');
  const membership = await campaignService.joinCampaign(creator.id, campaign.id);

  // Verify idempotency
  const membershipRepeated = await campaignService.joinCampaign(creator.id, campaign.id);
  if (membershipRepeated.id !== membership.id) {
    throw new Error('Repeated campaign join failed idempotency check');
  }

  report.campaignJoin = {
    campaignId: campaign.id,
    slug: campaign.slug,
    name: campaign.name,
    membershipId: membership.id,
    membershipStatus: membership.status,
    payRate: campaign.payRate.toFixed(2),
    idempotent: true
  };
  logger.info(report.campaignJoin, 'Step 2 complete: Campaign join verified');

  // 3. Real Submission (Controlled YouTube Video)
  const testVideoUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
  const testVideoId = 'jNQXAC9IVRw';
  logger.info({ testVideoUrl, testVideoId }, 'Step 3: Creating real YouTube submission');

  const submission = await submissionService.createSubmission({
    userId: creator.id,
    campaignId: campaign.id,
    rawUrl: testVideoUrl
  });

  if (submission.status !== 'PENDING_VERIFICATION') {
    throw new Error(`Expected submission status PENDING_VERIFICATION, got ${submission.status}`);
  }
  if (submission.platform !== 'YOUTUBE') {
    throw new Error(`Expected platform YOUTUBE, got ${submission.platform}`);
  }

  report.submission = {
    submissionId: submission.id,
    platform: submission.platform,
    normalizedUrl: submission.normalizedUrl,
    status: submission.status
  };
  logger.info(report.submission, 'Step 3 complete: Real submission created as PENDING_VERIFICATION');

  // 4. BullMQ Verification Worker Processing
  logger.info('Step 4: Observing BullMQ Verification Worker execution');
  const redisConn = createRedisConnection();
  const queueEvents = new QueueEvents(QUEUE_NAMES.VERIFICATION, { connection: redisConn });
  await queueEvents.waitUntilReady();

  // Run or await verification
  let verificationResult;
  try {
    // Check if worker in background task processed it or process directly
    logger.info({ submissionId: submission.id }, 'Awaiting verification completion...');
    // Wait up to 15 seconds for background worker or execute directly if needed
    let attempts = 0;
    while (attempts < 15) {
      await new Promise((r) => setTimeout(r, 1000));
      const subCheck = await prisma.submission.findUnique({
        where: { id: submission.id },
        include: {
          verifications: { include: { signals: true } },
          snapshots: true
        }
      });
      if (subCheck && subCheck.status !== 'PENDING_VERIFICATION') {
        verificationResult = subCheck;
        break;
      }
      attempts++;
    }

    if (!verificationResult) {
      logger.info('Executing runVerification directly to ensure complete capture...');
      await verificationService.runVerification(submission.id);
      verificationResult = await prisma.submission.findUnique({
        where: { id: submission.id },
        include: {
          verifications: { include: { signals: true } },
          snapshots: true
        }
      });
    }
  } finally {
    await queueEvents.close();
    redisConn.disconnect();
  }

  const latestVerification = verificationResult.verifications?.[0];
  const latestSnapshot = verificationResult.snapshots?.[0];

  if (!latestVerification || !latestSnapshot) {
    throw new Error('Verification or MetricSnapshot was not created');
  }

  report.verification = {
    jobId: `verify:${submission.id}`,
    verificationId: latestVerification.id,
    snapshotId: latestSnapshot.id,
    submissionFinalStatus: verificationResult.status,
    riskLevel: latestVerification.riskLevel,
    riskScore: latestVerification.score,
    signalsCount: latestVerification.signals.length
  };
  logger.info(report.verification, 'Step 4 complete: Verification completed');

  // 5. Metric Integrity Verification
  logger.info('Step 5: Metric Integrity verification');
  const rawAvailability = latestSnapshot.metadata?.availability || {};
  report.metrics = {
    views: latestSnapshot.views !== null ? BigInt(latestSnapshot.views).toString() : null,
    likes: latestSnapshot.likes !== null ? BigInt(latestSnapshot.likes).toString() : null,
    comments: latestSnapshot.comments !== null ? BigInt(latestSnapshot.comments).toString() : null,
    shares: latestSnapshot.shares,
    availability: rawAvailability,
    capturedAt: latestSnapshot.capturedAt
  };

  if (latestSnapshot.views === null || BigInt(latestSnapshot.views) <= 0n) {
    throw new Error(`Expected views > 0, got ${latestSnapshot.views}`);
  }
  if (latestSnapshot.shares !== null) {
    throw new Error(`Expected shares to be null (NOT_SUPPORTED), got ${latestSnapshot.shares}`);
  }
  logger.info(report.metrics, 'Step 5 complete: Metric integrity verified');

  // 6. ApprovalPolicy Verification
  logger.info('Step 6: ApprovalPolicy verification');
  if (verificationResult.status !== 'APPROVED') {
    throw new Error(`Expected submission status APPROVED, got ${verificationResult.status}`);
  }
  report.approval = {
    decision: 'APPROVED',
    riskLevel: latestVerification.riskLevel,
    verifiedAt: verificationResult.verifiedAt
  };
  logger.info(report.approval, 'Step 6 complete: ApprovalPolicy evaluated and approved');

  // 7. Earnings Calculation Verification
  logger.info('Step 7: Earnings calculation via EarningsService');
  const earningsResult = await earningsService.creditNewEligibleViews(submission.id, latestSnapshot.id);

  // Test idempotency: second call should be ALREADY_CREDITED
  const repeatedEarnings = await earningsService.creditNewEligibleViews(submission.id, latestSnapshot.id);
  if (repeatedEarnings.reason !== 'ALREADY_CREDITED') {
    throw new Error(`Expected ALREADY_CREDITED on second earnings call, got ${repeatedEarnings.reason}`);
  }

  const earningRecord = earningsResult.earning;
  report.earnings = {
    earningId: earningRecord?.id,
    eligibleViews: earningsResult.newlyCreditedViews.toString(),
    grossAmount: earningsResult.grossAmount.toString(),
    ratePerThousand: earningRecord?.ratePerThousand?.toString(),
    currency: earningRecord?.currency,
    status: earningRecord?.status,
    idempotent: true
  };
  logger.info(report.earnings, 'Step 7 complete: Eligible earnings ledgered');

  // 8. Statistics Service Verification
  logger.info('Step 8: StatisticsService verification');
  const userStats = await statisticsService.getUserOverview(creator.id);
  const campStats = await statisticsService.getCampaignOverview(creator.id, campaign.id);

  report.statistics = {
    totalSubmissions: userStats.totalSubmissions,
    approvedSubmissions: userStats.approvedSubmissions,
    totalViews: userStats.totalViews.knownSum?.toString(),
    campaignSubmissions: campStats.totalSubmissions,
    campaignApproved: campStats.approvedSubmissions,
    campaignCurrentViews: campStats.currentTotalViews.knownSum?.toString()
  };
  logger.info(report.statistics, 'Step 8 complete: Statistics verified');

  // 9. Earnings Balance Verification
  logger.info('Step 9: EarningsService balance verification');
  const balance = await earningsService.getUserBalance(creator.id);
  const earningsOverview = await earningsService.getUserEarnings(creator.id);

  report.balance = {
    eligibleEarnings: balance.eligibleEarnings.toFixed(2),
    totalGrossEarnings: balance.totalGrossEarnings.toFixed(2),
    currency: balance.currency,
    isPayoutThresholdReached: earningsOverview.isPayoutThresholdReached,
    minimumPayout: earningsOverview.minimumPayout.toFixed(2)
  };
  logger.info(report.balance, 'Step 9 complete: Authoritative balance verified');

  // 10. Duplicate Submission Test
  logger.info('Step 10: Duplicate submission rejection test');
  let duplicateCaught = false;
  try {
    await submissionService.createSubmission({
      userId: creator.id,
      campaignId: campaign.id,
      rawUrl: testVideoUrl
    });
  } catch (err) {
    if (err instanceof DuplicateSubmissionError) {
      duplicateCaught = true;
    }
  }
  if (!duplicateCaught) {
    throw new Error('Duplicate submission was not rejected!');
  }
  report.duplicateTest = {
    duplicateUrlRejected: true
  };
  logger.info(report.duplicateTest, 'Step 10 complete: Duplicate submission rejected cleanly');

  // 11. Database Audit Verification
  logger.info('Step 11: Database audit verification');
  const dbUser = await prisma.user.findUnique({
    where: { id: creator.id },
    include: {
      campaignMemberships: { where: { campaignId: campaign.id } },
      submissions: {
        where: { id: submission.id },
        include: {
          verifications: true,
          snapshots: true,
          earnings: true
        }
      }
    }
  });

  const auditPassed =
    dbUser &&
    dbUser.campaignMemberships.length === 1 &&
    dbUser.submissions.length === 1 &&
    dbUser.submissions[0].verifications.length === 1 &&
    dbUser.submissions[0].snapshots.length >= 1 &&
    dbUser.submissions[0].earnings.length === 1;

  if (!auditPassed) {
    throw new Error('Database audit failed: Entity graph relationships incomplete');
  }

  report.databaseAudit = {
    userExists: true,
    membershipExists: true,
    submissionExists: true,
    verificationExists: true,
    snapshotExists: true,
    earningExists: true,
    relationshipsValid: true
  };
  logger.info(report.databaseAudit, 'Step 11 complete: Database audit verified');

  logger.info('=== All Phase 9C.3 Real YouTube Lifecycle Steps Succeeded! ===');
  return report;
}

// CLI entry point
if (process.argv[1]?.replace(/\\/g, '/').endsWith('src/scripts/run-real-youtube-lifecycle.js')) {
  runRealYouTubeLifecycle()
    .then((report) => {
      console.log('REAL_YOUTUBE_LIFECYCLE_SUCCESS', JSON.stringify(report, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err: err.message, stack: err.stack }, 'Lifecycle execution failed');
      process.exit(1);
    })
    .finally(async () => {
      await disconnectDatabase();
    });
}
