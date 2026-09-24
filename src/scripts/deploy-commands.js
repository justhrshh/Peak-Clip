import { REST, Routes } from 'discord.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import * as pingCommand from '../bot/commands/ping.js';
import * as campaignsCommand from '../bot/commands/campaigns.js';
import * as submitCommand from '../bot/commands/submit.js';
import * as submissionsCommand from '../bot/commands/submissions.js';
import * as statisticsCommand from '../bot/commands/statistics.js';
import * as earningsCommand from '../bot/commands/earnings.js';
import * as payoutCommand from '../bot/commands/payout.js';
import * as adminCommand from '../bot/commands/admin.js';
import * as setupCommand from '../bot/commands/setup.js';
import * as verifyCommand from '../bot/commands/verify.js';

const commands = [
  pingCommand,
  campaignsCommand,
  submitCommand,
  submissionsCommand,
  statisticsCommand,
  earningsCommand,
  payoutCommand,
  adminCommand,
  setupCommand,
  verifyCommand
].map((cmd) => cmd.data.toJSON());

/**
 * Register slash commands with Discord REST API
 * If DISCORD_GUILD_ID is provided, deploys instantly to the specified guild (e.g. Peak Clip — DEV).
 * Otherwise deploys globally.
 */
export async function deployCommands() {
  if (!config.discord.token) {
    throw new Error('DISCORD_TOKEN is required in .env to deploy commands.');
  }
  if (!config.discord.clientId) {
    throw new Error('DISCORD_CLIENT_ID is required in .env to deploy commands.');
  }

  const rest = new REST({ version: '10' }).setToken(config.discord.token);

  if (config.discord.guildId) {
    logger.info(
      { guildId: config.discord.guildId, count: commands.length },
      'Deploying slash commands to development guild (instant propagation)...'
    );
    await rest.put(
      Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
      { body: commands }
    );
    logger.info('Successfully deployed guild slash commands.');
  } else {
    logger.info(
      { count: commands.length },
      'Deploying slash commands globally (may take up to an hour to propagate)...'
    );
    await rest.put(
      Routes.applicationCommands(config.discord.clientId),
      { body: commands }
    );
    logger.info('Successfully deployed global slash commands.');
  }
}

// Auto-run when executed directly from CLI
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('deploy-commands.js')) {
  deployCommands().catch((err) => {
    logger.error({ err: err.message }, 'Failed to deploy slash commands');
    process.exit(1);
  });
}
