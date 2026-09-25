import { Client, GatewayIntentBits, Collection, Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { handleInteraction } from './interactions/router.js';
import * as pingCommand from './commands/ping.js';
import * as campaignsCommand from './commands/campaigns.js';
import * as submitCommand from './commands/submit.js';
import * as submissionsCommand from './commands/submissions.js';
import * as statisticsCommand from './commands/statistics.js';
import * as earningsCommand from './commands/earnings.js';
import * as payoutCommand from './commands/payout.js';
import * as adminCommand from './commands/admin.js';
import * as setupCommand from './commands/setup.js';
import * as registerCommand from './commands/register.js';
import * as dashboardCommand from './commands/dashboard.js';
import { handleMessageCreate } from './events/messageCreate.handler.js';

let discordClient = null;

/**
 * Initialize Discord Client and register commands & events
 * @returns {Client}
 */
export function createDiscordClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  client.commands = new Collection();

  // Register foundational commands
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
    registerCommand,
    dashboardCommand
  ];
  for (const cmd of commands) {
    if (cmd.data?.name) {
      client.commands.set(cmd.data.name, cmd);
      logger.debug(`Loaded slash command: /${cmd.data.name}`);
    }
  }

  // Ready event
  client.once(Events.ClientReady, (c) => {
    logger.info(`Discord Bot successfully authenticated as ${c.user.tag}`);
  });

  // Interaction router
  client.on(Events.InteractionCreate, async (interaction) => {
    await handleInteraction(interaction);
  });

  // Message router (payout evidence attachments & channel messages)
  client.on(Events.MessageCreate, async (message) => {
    try {
      await handleMessageCreate(message);
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack, messageId: message.id }, 'Unhandled error in messageCreate handler');
    }
  });

  // Client error handler
  client.on('error', (err) => {
    logger.error({ err: err.message }, 'Discord client connection error');
  });

  return client;
}

/**
 * Get or initialize the singleton Discord Client
 * @returns {Client}
 */
export function getDiscordClient() {
  if (!discordClient) {
    discordClient = createDiscordClient();
  }
  return discordClient;
}

/**
 * Start and authenticate the Discord bot
 * @returns {Promise<boolean>}
 */
export async function startDiscordBot() {
  const client = getDiscordClient();

  if (!config.discord.token) {
    if (config.isDevelopment || config.isTest) {
      logger.warn('DISCORD_TOKEN is not provided. Discord bot is in offline/standby mode for local/test development.');
      return false;
    }
    throw new Error('DISCORD_TOKEN is required in production.');
  }

  try {
    logger.info('Authenticating with Discord Gateway...');
    await client.login(config.discord.token);
    return true;
  } catch (error) {
    logger.error({ err: error.message }, 'Failed to login to Discord');
    if (config.isProduction) {
      throw error;
    }
    return false;
  }
}

/**
 * Gracefully stop Discord client
 */
export async function stopDiscordBot() {
  if (discordClient) {
    try {
      discordClient.destroy();
      logger.info('Discord client disconnected cleanly.');
    } catch (error) {
      logger.error({ err: error.message }, 'Error destroying Discord client');
    } finally {
      discordClient = null;
    }
  }
}
