import { Client, GatewayIntentBits, Collection, Events, Status } from 'discord.js';
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
  client.on(Events.Error, (err) => {
    logger.error({ err: err.message, stack: err.stack }, 'Discord client connection error');
  });

  // Gateway shard diagnostics (detects code 4014 Disallowed Intents and disconnects)
  client.on(Events.ShardError, (err, shardId) => {
    logger.error({ err: err.message, stack: err.stack, shardId }, 'Discord gateway shard error');
  });

  client.on(Events.ShardDisconnect, (event, shardId) => {
    const isDisallowedIntents = event?.code === 4014;
    logger.error(
      {
        closeCode: event?.code,
        reason: event?.reason,
        wasClean: event?.wasClean,
        shardId,
        isDisallowedIntents
      },
      isDisallowedIntents
        ? 'Discord Gateway closed connection (Code 4014: Disallowed Intents). Check Privileged Gateway Intents (Message Content) in Discord Developer Portal.'
        : `Discord Gateway shard ${shardId} disconnected`
    );
  });

  client.on(Events.Warn, (info) => {
    logger.warn({ info }, 'Discord client warning');
  });

  // Client internal debug logging (gateway connect, shard transitions, session limits)
  client.on(Events.Debug, (message) => {
    logger.debug({ gatewayDebug: message }, 'Discord gateway debug notice');
  });

  return client;
}

/**
 * Perform a raw, unauthenticated HTTPS reachability check to Discord's public gateway API
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<{ reachable: boolean, status?: number, latencyMs?: number, gatewayUrl?: string, err?: string }>}
 */
export async function checkDiscordApiReachability(timeoutMs = 5000) {
  const startTime = Date.now();
  try {
    const res = await fetch('https://discord.com/api/v10/gateway', {
      headers: { 'User-Agent': 'DiscordBot (dc-clipping-bot, 0.1.0)' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const latencyMs = Date.now() - startTime;
    let data = null;
    try {
      data = await res.json();
    } catch {
      // ignore JSON parse failures
    }

    const result = {
      reachable: res.ok,
      status: res.status,
      latencyMs,
      gatewayUrl: data?.url ?? null
    };

    logger.info(
      result,
      `Discord API reachability check: ${res.ok ? 'REACHABLE' : 'UNEXPECTED_STATUS'} (HTTP ${res.status}, ${latencyMs}ms)`
    );
    return result;
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    const result = {
      reachable: false,
      latencyMs,
      err: error.message,
      code: error.code || error.name
    };
    logger.error(
      result,
      `Discord API reachability check: FAILED to reach https://discord.com/api/v10/gateway (${error.message})`
    );
    return result;
  }
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
 * @param {number} [timeoutMs=30000] Gateway login timeout in milliseconds
 * @returns {Promise<boolean>}
 */
export async function startDiscordBot(timeoutMs = 30000) {
  const client = getDiscordClient();

  if (!config.discord.token) {
    if (config.isDevelopment || config.isTest) {
      logger.warn('DISCORD_TOKEN is not provided. Discord bot is in offline/standby mode for local/test development.');
      return false;
    }
    throw new Error('DISCORD_TOKEN is required in production.');
  }

  // 1. Raw network reachability check against public Discord API
  await checkDiscordApiReachability(5000);

  // 2. Pre-login low-level state diagnostics
  const wsStatus = client.ws?.status;
  const wsStatusName = Status[wsStatus] ?? 'Unknown';
  const shardCount = client.ws?.shards?.size ?? 0;
  const restHandlersCount = client.rest?.handlers?.size ?? 0;
  const globalRemaining = client.rest?.globalRemaining ?? null;
  const globalReset = client.rest?.globalReset ?? null;
  const rawToken = config.discord.token ?? '';
  const tokenLength = typeof rawToken === 'string' ? rawToken.trim().length : 0;
  const tokenPresent = tokenLength > 0;

  logger.info(
    {
      tokenPresent,
      tokenLength,
      wsStatus,
      wsStatusName,
      shardCount,
      restHandlersCount,
      globalRemaining,
      globalReset,
      timeoutMs
    },
    `Pre-login Discord client diagnostics (tokenLength: ${tokenLength}, wsStatus: ${wsStatus}/${wsStatusName}, shards: ${shardCount})`
  );

  let timeoutHandle = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const currentWsStatus = client.ws?.status;
      const currentStatusName = Status[currentWsStatus] ?? 'Unknown';
      const timeoutError = new Error(
        `Discord Gateway authentication timed out after ${timeoutMs / 1000}s. ` +
        `Client WS status: ${currentWsStatus} (${currentStatusName}). ` +
        `Verify DISCORD_TOKEN and ensure required Privileged Gateway Intents (Message Content) are enabled in the Discord Developer Portal.`
      );
      timeoutError.code = 'DISCORD_LOGIN_TIMEOUT';
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    logger.info({ timeoutMs }, 'Authenticating with Discord Gateway...');
    await Promise.race([client.login(config.discord.token), timeoutPromise]);
    return true;
  } catch (error) {
    const finalWsStatus = client.ws?.status;
    const finalStatusName = Status[finalWsStatus] ?? 'Unknown';
    logger.fatal(
      {
        err: error.message,
        code: error.code,
        wsStatus: finalWsStatus,
        wsStatusName: finalStatusName
      },
      'Failed to authenticate with Discord Gateway'
    );
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
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
