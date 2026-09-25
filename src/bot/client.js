import { Client, GatewayIntentBits, Collection, Events, Status, RESTEvents } from 'discord.js';
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
import { runComprehensiveLoginDiagnostics, sanitizeDebugMessage } from './diagnostics.js';

let discordClient = null;
let activeRateLimit = null;
let botLifecycleState = 'idle'; // 'idle' | 'ready' | 'rate_limited' | 'reconnecting' | 'standby' | 'failed'
let reconnectTimer = null;
let isReconnecting = false;
let isLoginInFlight = false;

export const DiscordAuthFailureReason = {
  INVALID_TOKEN: 'INVALID_TOKEN',
  DISALLOWED_INTENTS: 'DISALLOWED_INTENTS',
  RATE_LIMITED: 'RATE_LIMITED',
  TRANSIENT_GATEWAY_ERROR: 'TRANSIENT_GATEWAY_ERROR'
};

/**
 * Classify Discord authentication failures to differentiate unrecoverable
 * credential errors from transient 429 rate limits and network drops.
 *
 * @param {Error|object} err
 * @param {Client} [client]
 * @returns {string} One of DiscordAuthFailureReason
 */
export function classifyDiscordError(err, client) {
  const msg = err?.message?.toLowerCase() || '';
  const code = err?.code;
  const status = err?.status;

  // 1. Invalid token (Fatal, permanent)
  if (
    code === 'TokenInvalid' ||
    status === 401 ||
    (msg.includes('token') && msg.includes('invalid')) ||
    msg.includes('an invalid token was provided')
  ) {
    return DiscordAuthFailureReason.INVALID_TOKEN;
  }

  // 2. Disallowed intents (Fatal configuration error)
  if (code === 4014 || msg.includes('disallowed intent')) {
    return DiscordAuthFailureReason.DISALLOWED_INTENTS;
  }

  // 3. HTTP 429 / Rate Limited
  if (
    status === 429 ||
    status === '429' ||
    code === 429 ||
    code === '429' ||
    code === 'RATE_LIMITED' ||
    code === 'RateLimitError' ||
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('you are being rate limited') ||
    (activeRateLimit && activeRateLimit.resetAt > Date.now())
  ) {
    return DiscordAuthFailureReason.RATE_LIMITED;
  }

  // 4. Transient network / gateway socket errors
  return DiscordAuthFailureReason.TRANSIENT_GATEWAY_ERROR;
}

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

  // Track REST rate limits and extract exact Discord Retry-After values
  client.rest.on(RESTEvents.RateLimited, (rateLimitData) => {
    botLifecycleState = 'rate_limited';
    activeRateLimit = {
      retryAfter: rateLimitData.retryAfter,
      global: rateLimitData.global,
      scope: rateLimitData.scope,
      url: rateLimitData.url,
      resetAt: Date.now() + rateLimitData.retryAfter
    };
    logger.warn(
      {
        retryAfterMs: rateLimitData.retryAfter,
        global: rateLimitData.global,
        scope: rateLimitData.scope,
        url: rateLimitData.url
      },
      `Discord REST rate limit encountered (HTTP 429). Retry-After: ${rateLimitData.retryAfter}ms`
    );
  });

  // Ready event
  client.once(Events.ClientReady, (c) => {
    botLifecycleState = 'ready';
    activeRateLimit = null;
    isReconnecting = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
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
    logger.warn({ info }, '[Discord Warning]');
  });

  // Client internal debug logging - promoted to info so it is visible in production logs
  client.on(Events.Debug, (message) => {
    logger.info({ gatewayDebug: sanitizeDebugMessage(message) }, '[Discord Gateway Debug]');
  });

  // REST debug and response tracking
  client.rest.on(RESTEvents.Response, (request, response) => {
    logger.info(
      { method: request.method, route: request.route, status: response.status },
      `[Discord REST Response] ${request.method} ${request.route} -> HTTP ${response.status}`
    );
  });

  client.rest.on(RESTEvents.Debug, (message) => {
    logger.info({ restDebug: sanitizeDebugMessage(message) }, '[Discord REST Debug]');
  });

  client.on(Events.ShardReady, (shardId, unavailableGuilds) => {
    logger.info({ shardId, unavailableGuildsCount: unavailableGuilds?.size ?? 0 }, '[Discord Shard Ready]');
  });

  client.on(Events.ShardReconnecting, (shardId) => {
    logger.info({ shardId }, '[Discord Shard Reconnecting]');
  });

  client.on(Events.ShardResume, (shardId, replayedEvents) => {
    logger.info({ shardId, replayedEvents }, '[Discord Shard Resumed]');
  });

  // Raw gateway packet monitoring for protocol opcodes (Hello, Ready, Reconnect, Heartbeat ACK)
  client.on(Events.Raw, (packet, shardId) => {
    if (packet && (packet.op === 10 || packet.op === 9 || packet.op === 7 || packet.t === 'READY' || packet.t === 'RESUMED')) {
      logger.info(
        {
          shardId,
          op: packet.op,
          opName: packet.op === 10 ? 'HELLO' : packet.op === 9 ? 'INVALID_SESSION' : packet.op === 7 ? 'RECONNECT' : 'DISPATCH',
          eventType: packet.t,
          heartbeatInterval: packet.d?.heartbeat_interval
        },
        `[Discord Gateway Protocol Event] ${packet.t || `Opcode ${packet.op}`}`
      );
    }
  });

  return client;
}

/**
 * Perform a raw, unauthenticated HTTPS reachability check to Discord's public gateway API.
 * Preserved for on-demand diagnostics only; omitted from automatic startup to conserve quota.
 *
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
 * Execute a single login attempt with an in-flight concurrency guard and dynamic timeout.
 *
 * @param {number} [timeoutMs=60000]
 * @returns {Promise<boolean>}
 */
export async function executeLoginAttempt(timeoutMs = 60000) {
  if (isLoginInFlight) {
    logger.warn('Discord login attempt already in flight; skipping concurrent invocation.');
    return false;
  }
  isLoginInFlight = true;

  const client = getDiscordClient();
  let timeoutHandle = null;
  let progressTicker = null;
  const loginStartTime = Date.now();

  // Run deep pre-login diagnostics (DNS, TLS, REST /gateway/bot, Application metadata)
  try {
    await runComprehensiveLoginDiagnostics(config.discord.token, client);
  } catch (diagErr) {
    logger.warn({ err: diagErr.message }, '[DIAGNOSTIC] Notice while running pre-login diagnostics');
  }

  // Adapt timeout: if Discord provided a Retry-After, extend timeout so we don't preempt the cooldown
  const effectiveTimeout = activeRateLimit && activeRateLimit.resetAt > Date.now()
    ? Math.max(activeRateLimit.retryAfter + 30000, timeoutMs)
    : timeoutMs;

  // Periodic in-flight diagnostic checkpoints every 10 seconds
  progressTicker = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - loginStartTime) / 1000);
    const wsStatus = client.ws?.status;
    const wsStatusName = Status[wsStatus] ?? 'Unknown';
    const shards = [];
    if (client.ws?.shards) {
      for (const [id, shard] of client.ws.shards) {
        shards.push({
          id,
          status: shard.status,
          statusName: Status[shard.status] ?? 'Unknown',
          ping: shard.ping
        });
      }
    }
    logger.info(
      {
        elapsedSeconds,
        wsStatus,
        wsStatusName,
        shardsCount: client.ws?.shards?.size ?? 0,
        shards,
        hasWsInternalManager: Boolean(client.ws?._ws),
        hasGatewayInfo: Boolean(client.ws?._ws?.gatewayInformation)
      },
      `[Discord Login Progress Checkpoint] Login in flight for ${elapsedSeconds}s (wsStatus: ${wsStatus}/${wsStatusName}, shards: ${client.ws?.shards?.size ?? 0})`
    );
  }, 10000);

  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(async () => {
      const seconds = effectiveTimeout / 1000;
      const wsStatus = client.ws?.status;
      const wsStatusName = Status[wsStatus] ?? 'Unknown';
      const shards = [];
      if (client.ws?.shards) {
        for (const [id, shard] of client.ws.shards) {
          shards.push({
            id,
            status: shard.status,
            statusName: Status[shard.status] ?? 'Unknown',
            ping: shard.ping
          });
        }
      }

      const diagnosticAnalysis = {
        elapsedSeconds: seconds,
        wsStatus,
        wsStatusName,
        shardsCount: client.ws?.shards?.size ?? 0,
        shards,
        hasWsInternalManager: Boolean(client.ws?._ws),
        hasGatewayInfo: Boolean(client.ws?._ws?.gatewayInformation),
        gatewayUrlReturned: client.ws?._ws?.gatewayInformation?.data?.url ?? null,
        hangingPhase: (client.ws?.shards?.size ?? 0) === 0
          ? 'REST_GATEWAY_BOT_FETCH (client.rest.get /gateway/bot did not complete)'
          : 'WEBSOCKET_HANDSHAKE_OR_HELLO (Shard created, waiting for WebSocket connection or Opcode 10 Hello)'
      };

      logger.error(diagnosticAnalysis, `[DIAGNOSTIC TIMEOUT ANALYSIS] Login timed out after ${seconds}s.`);

      const err = new Error(
        `Discord login attempt timed out after ${seconds}s. ` +
        `Phase: ${diagnosticAnalysis.hangingPhase}. Client WS status: ${wsStatus} (${wsStatusName}).`
      );
      err.code = 'DISCORD_LOGIN_TIMEOUT';
      reject(err);
    }, effectiveTimeout);
  });

  try {
    logger.info(
      { effectiveTimeoutMs: effectiveTimeout, wsStatus: client.ws?.status },
      'Executing Discord Gateway login...'
    );
    await Promise.race([client.login(config.discord.token), timeoutPromise]);
    botLifecycleState = 'ready';
    activeRateLimit = null;
    return true;
  } catch (err) {
    // If the timeout won the race, tear down connection cleanly to avoid orphan in-flight sockets
    if (err.code === 'DISCORD_LOGIN_TIMEOUT') {
      try {
        await client.destroy();
      } catch (destroyErr) {
        logger.debug({ err: destroyErr.message }, 'Notice during cleanup of timed-out client');
      }
    }
    const reason = classifyDiscordError(err, client);
    err.reason = reason;
    throw err;
  } finally {
    isLoginInFlight = false;
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (progressTicker) {
      clearInterval(progressTicker);
    }
  }
}

/**
 * Launch an asynchronous background reconnect loop with exponential backoff and Retry-After priority.
 *
 * @param {number} [initialBackoffMs=5000]
 * @param {number} [maxBackoffMs=300000]
 * @param {number} [maxAttempts=Infinity]
 * @returns {void}
 */
export function launchBackgroundReconnect(initialBackoffMs = 5000, maxBackoffMs = 300000, maxAttempts = Infinity) {
  if (isReconnecting || botLifecycleState === 'ready') {
    return;
  }
  isReconnecting = true;
  let attempt = 0;

  const scheduleNext = () => {
    if (!isReconnecting || botLifecycleState === 'ready') {
      isReconnecting = false;
      return;
    }

    attempt++;
    if (attempt > maxAttempts) {
      botLifecycleState = 'failed';
      isReconnecting = false;
      logger.error({ attempts: attempt }, 'Background Discord reconnection reached max attempts limit. Halting retry loop.');
      return;
    }

    // Exponential backoff: initialBackoff * 2^(attempt - 1) + jitter
    const expWait = Math.min(initialBackoffMs * Math.pow(2, attempt - 1), maxBackoffMs);
    const jitter = Math.floor(Math.random() * 1000);
    let waitMs = expWait + jitter;

    // Respect active Discord 429 Retry-After if larger than calculated exponential backoff
    if (activeRateLimit && activeRateLimit.resetAt > Date.now()) {
      botLifecycleState = 'rate_limited';
      const remainingCooldown = activeRateLimit.resetAt - Date.now();
      waitMs = Math.max(waitMs, remainingCooldown + 1000);
    } else {
      botLifecycleState = 'reconnecting';
    }

    logger.info(
      {
        attempt,
        waitMs,
        botLifecycleState,
        rateLimited: Boolean(activeRateLimit)
      },
      `Scheduling Discord background reconnect attempt #${attempt} in ${(waitMs / 1000).toFixed(1)}s...`
    );

    reconnectTimer = setTimeout(async () => {
      if (!isReconnecting || botLifecycleState === 'ready') {
        return;
      }

      // Concurrency guard: if another attempt is still in flight, reschedule
      if (isLoginInFlight) {
        logger.info('A login attempt is currently in flight; rescheduling background retry.');
        scheduleNext();
        return;
      }

      try {
        botLifecycleState = 'reconnecting';
        logger.info({ attempt }, 'Executing background Discord gateway login attempt...');
        await executeLoginAttempt(60000);

        botLifecycleState = 'ready';
        activeRateLimit = null;
        isReconnecting = false;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        logger.info({ attempt }, 'Discord bot successfully reconnected in background.');
      } catch (err) {
        const reason = err.reason || classifyDiscordError(err, getDiscordClient());
        err.reason = reason;

        // Fatal non-recoverable errors: abort permanently to stop wasting network quota
        if (
          reason === DiscordAuthFailureReason.INVALID_TOKEN ||
          reason === DiscordAuthFailureReason.DISALLOWED_INTENTS
        ) {
          botLifecycleState = 'failed';
          isReconnecting = false;
          logger.fatal(
            { err: err.message, reason },
            'Fatal Discord configuration error detected in background reconnect. Aborting retry loop.'
          );
          return;
        }

        if (reason === DiscordAuthFailureReason.RATE_LIMITED) {
          botLifecycleState = 'rate_limited';
          logger.warn(
            { err: err.message, retryAfterMs: activeRateLimit?.retryAfter },
            'Background Discord reconnect was rate-limited (HTTP 429). Retrying after cooldown.'
          );
        } else {
          botLifecycleState = 'reconnecting';
          logger.warn(
            { err: err.message, reason },
            'Background Discord reconnect encountered transient error. Scheduling backoff retry.'
          );
        }

        scheduleNext();
      }
    }, waitMs);
  };

  scheduleNext();
}

/**
 * Start and authenticate the Discord bot.
 * Differentiates fatal credentials from 429 rate limits, launching background backoff if rate-limited.
 *
 * @param {object|number} [optionsOrTimeout={}]
 * @returns {Promise<boolean>}
 */
export async function startDiscordBot(optionsOrTimeout = {}) {
  const options = typeof optionsOrTimeout === 'number'
    ? { maxInitialWaitMs: optionsOrTimeout, enableBackgroundRetry: false, throwOnFailure: false }
    : optionsOrTimeout;

  const {
    maxInitialWaitMs = 30000,
    initialBackoffMs = 5000,
    maxBackoffMs = 300000,
    enableBackgroundRetry = true,
    throwOnFailure = false
  } = options;

  const client = getDiscordClient();

  if (!config.discord.token) {
    if (config.isDevelopment || config.isTest) {
      botLifecycleState = 'standby';
      logger.warn('DISCORD_TOKEN is not provided. Discord bot is in offline/standby mode for local/test development.');
      return false;
    }
    throw new Error('DISCORD_TOKEN is required in production.');
  }

  // Pre-login low-level state diagnostics (token length only, never the value)
  const rawToken = config.discord.token ?? '';
  const tokenLength = typeof rawToken === 'string' ? rawToken.trim().length : 0;
  const tokenPresent = tokenLength > 0;
  const wsStatus = client.ws?.status;
  const wsStatusName = Status[wsStatus] ?? 'Unknown';

  logger.info(
    {
      tokenPresent,
      tokenLength,
      wsStatus,
      wsStatusName,
      maxInitialWaitMs
    },
    `Initiating Discord Bot login (tokenLength: ${tokenLength}, wsStatus: ${wsStatus}/${wsStatusName})`
  );

  try {
    await executeLoginAttempt(maxInitialWaitMs);
    botLifecycleState = 'ready';
    return true;
  } catch (initialError) {
    const reason = initialError.reason;
    logger.warn({ reason, err: initialError.message }, 'Initial Discord gateway login attempt did not succeed');

    // Fatal permanent errors: throw immediately so caller can terminate if appropriate
    if (
      reason === DiscordAuthFailureReason.INVALID_TOKEN ||
      reason === DiscordAuthFailureReason.DISALLOWED_INTENTS ||
      throwOnFailure
    ) {
      if (
        reason === DiscordAuthFailureReason.INVALID_TOKEN ||
        reason === DiscordAuthFailureReason.DISALLOWED_INTENTS
      ) {
        botLifecycleState = 'failed';
      }
      throw initialError;
    }

    if (reason === DiscordAuthFailureReason.RATE_LIMITED) {
      botLifecycleState = 'rate_limited';
    } else {
      botLifecycleState = 'reconnecting';
    }

    // Rate-limited or transient: launch background reconnect loop with backoff and do not crash
    if (enableBackgroundRetry) {
      launchBackgroundReconnect(initialBackoffMs, maxBackoffMs);
    }
    return false;
  }
}

/**
 * Get current Discord bot lifecycle and rate limit status
 * @returns {{ state: string, isLoginInFlight: boolean, isReconnecting: boolean, activeRateLimit: object|null }}
 */
export function getDiscordBotStatus() {
  return {
    state: botLifecycleState,
    isLoginInFlight,
    isReconnecting,
    activeRateLimit: activeRateLimit ? { ...activeRateLimit } : null
  };
}

/**
 * Gracefully stop Discord client and cancel any active reconnect loops
 */
export async function stopDiscordBot() {
  isReconnecting = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  botLifecycleState = 'idle';
  activeRateLimit = null;
  isLoginInFlight = false;

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
