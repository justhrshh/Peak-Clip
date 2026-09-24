import 'dotenv/config';
import { disconnectDatabase } from '../database/client.js';
import * as verifyCommand from '../bot/commands/verify.js';
import * as campaignsCommand from '../bot/commands/campaigns.js';
import * as statisticsCommand from '../bot/commands/statistics.js';
import * as earningsCommand from '../bot/commands/earnings.js';
import * as payoutCommand from '../bot/commands/payout.js';
import { DEV_FIXTURES } from './seed-dev.js';
import { logger } from '../utils/logger.js';

function createMockInteraction(user) {
  let replyData = null;
  let isDeferred = false;

  return {
    user,
    member: {
      roles: []
    },
    guild: null,
    deferReply: async (opts) => {
      isDeferred = true;
      return { deferred: true, ...opts };
    },
    editReply: async (data) => {
      replyData = data;
      return data;
    },
    reply: async (data) => {
      replyData = data;
      return data;
    },
    getReply: () => replyData,
    isDeferred: () => isDeferred
  };
}

async function runDiscordCommandsDevTest() {
  logger.info('=== Starting Discord Command Handlers Live DB Verification ===');
  const user = DEV_FIXTURES.CREATOR;
  const results = {};

  // 1. /verify
  logger.info('Testing /verify command handler...');
  const verifyInt = createMockInteraction({
    id: user.discordId,
    username: user.username,
    displayName: user.displayName
  });
  await verifyCommand.execute(verifyInt);
  const verifyReply = verifyInt.getReply();
  const verifyTitle = verifyReply?.embeds?.[0]?.data?.title;
  logger.info({ verifyTitle }, '/verify executed successfully');
  results.verify = { success: true, title: verifyTitle };

  // 2. /campaigns
  logger.info('Testing /campaigns command handler...');
  const campaignsInt = createMockInteraction({
    id: user.discordId,
    username: user.username,
    displayName: user.displayName
  });
  await campaignsCommand.execute(campaignsInt);
  const campaignsReply = campaignsInt.getReply();
  const campaignsFields = campaignsReply?.embeds?.[0]?.data?.fields || [];
  logger.info({ fieldCount: campaignsFields.length }, '/campaigns executed successfully');
  results.campaigns = {
    success: true,
    campaignNames: campaignsFields.map((f) => f.name)
  };

  // 3. /statistics
  logger.info('Testing /statistics command handler...');
  const statsInt = createMockInteraction({
    id: user.discordId,
    username: user.username,
    displayName: user.displayName
  });
  await statisticsCommand.execute(statsInt);
  const statsReply = statsInt.getReply();
  const statsTitle = statsReply?.embeds?.[0]?.data?.title;
  logger.info({ statsTitle }, '/statistics executed successfully');
  results.statistics = { success: true, title: statsTitle };

  // 4. /earnings
  logger.info('Testing /earnings command handler...');
  const earningsInt = createMockInteraction({
    id: user.discordId,
    username: user.username,
    displayName: user.displayName
  });
  await earningsCommand.execute(earningsInt);
  const earningsReply = earningsInt.getReply();
  const earningsTitle = earningsReply?.embeds?.[0]?.data?.title;
  logger.info({ earningsTitle }, '/earnings executed successfully');
  results.earnings = { success: true, title: earningsTitle };

  // 5. /payout
  logger.info('Testing /payout command handler...');
  const payoutInt = createMockInteraction({
    id: user.discordId,
    username: user.username,
    displayName: user.displayName
  });
  await payoutCommand.execute(payoutInt);
  const payoutReply = payoutInt.getReply();
  const payoutTitle = payoutReply?.embeds?.[0]?.data?.title;
  logger.info({ payoutTitle }, '/payout executed successfully');
  results.payout = { success: true, title: payoutTitle };

  console.log('DISCORD_COMMANDS_DEV_SUCCESS', JSON.stringify(results, null, 2));
}

runDiscordCommandsDevTest()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: err.message, stack: err.stack }, 'Discord command dev verification failed');
    process.exit(1);
  })
  .finally(async () => {
    await disconnectDatabase();
  });
