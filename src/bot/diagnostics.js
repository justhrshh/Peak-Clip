import dns from 'node:dns/promises';
import tls from 'node:tls';
import { GatewayIntentBits } from 'discord.js';
import { logger } from '../utils/logger.js';

/**
 * Privileged Gateway Intent flag bitmasks on Discord Application objects (GET /api/v10/applications/@me)
 */
const APPLICATION_FLAGS = {
  GATEWAY_PRESENCE: 1 << 12,
  GATEWAY_PRESENCE_LIMITED: 1 << 13,
  GATEWAY_GUILD_MEMBERS: 1 << 14,
  GATEWAY_GUILD_MEMBERS_LIMITED: 1 << 15,
  GATEWAY_MESSAGE_CONTENT: 1 << 18,
  GATEWAY_MESSAGE_CONTENT_LIMITED: 1 << 19
};

/**
 * Sanitize debug strings to ensure tokens or secrets are never exposed
 * @param {string} msg
 * @returns {string}
 */
export function sanitizeDebugMessage(msg) {
  if (typeof msg !== 'string') return String(msg ?? '');
  return msg.replace(/[a-zA-Z0-9_\-]{24,}\.[a-zA-Z0-9_\-]{6,}\.[a-zA-Z0-9_\-]{27,}/g, '[REDACTED_DISCORD_TOKEN]');
}

/**
 * 1. Confirm token presence and structure without exposing token value
 * @param {string} token
 * @returns {object}
 */
export function inspectToken(token) {
  if (!token || typeof token !== 'string') {
    return {
      present: false,
      length: 0,
      partsCount: 0,
      validFormat: false
    };
  }

  const cleaned = token.replace(/^(Bot|Bearer)\s*/i, '').trim();
  const parts = cleaned.split('.');

  return {
    present: true,
    length: cleaned.length,
    partsCount: parts.length,
    validFormat: parts.length === 3 && cleaned.length >= 50 && cleaned.length <= 100
  };
}

/**
 * 2. Confirm requested client intents and check if MessageContent is requested
 * @param {object} client
 * @returns {object}
 */
export function inspectClientIntents(client) {
  const bitfield = BigInt(client?.options?.intents?.bitfield ?? 0);
  const messageContentBit = BigInt(GatewayIntentBits.MessageContent);
  const guildsBit = BigInt(GatewayIntentBits.Guilds);
  const guildMessagesBit = BigInt(GatewayIntentBits.GuildMessages);

  return {
    bitfield: bitfield.toString(),
    hasMessageContent: (bitfield & messageContentBit) === messageContentBit,
    hasGuilds: (bitfield & guildsBit) === guildsBit,
    hasGuildMessages: (bitfield & guildMessagesBit) === guildMessagesBit
  };
}

/**
 * 3. DNS resolution diagnostics for Discord endpoints from current environment
 * @returns {Promise<object>}
 */
export async function checkDiscordDns() {
  const results = {};

  for (const host of ['discord.com', 'gateway.discord.gg']) {
    const start = Date.now();
    try {
      const records = await dns.lookup(host, { all: true });
      results[host] = {
        success: true,
        durationMs: Date.now() - start,
        records: records.map(r => ({ address: r.address, family: `IPv${r.family}` }))
      };
    } catch (err) {
      results[host] = {
        success: false,
        durationMs: Date.now() - start,
        error: err.message,
        code: err.code
      };
    }
  }

  return results;
}

/**
 * 4. TCP & TLS handshake check against Discord Gateway port 443
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<object>}
 */
export async function checkDiscordGatewayTls(timeoutMs = 5000) {
  const host = 'gateway.discord.gg';
  const port = 443;
  const start = Date.now();

  return new Promise((resolve) => {
    let settled = false;

    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        timeout: timeoutMs
      },
      () => {
        if (settled) return;
        settled = true;
        const durationMs = Date.now() - start;
        const protocol = socket.getProtocol();
        const cipher = socket.getCipher();
        const authorized = socket.authorized;
        socket.end();

        resolve({
          success: true,
          durationMs,
          protocol,
          cipher: cipher?.name,
          authorized
        });
      }
    );

    socket.on('timeout', () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        success: false,
        durationMs: Date.now() - start,
        error: `TLS handshake timed out after ${timeoutMs}ms`,
        code: 'ETIMEDOUT'
      });
    });

    socket.on('error', (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        success: false,
        durationMs: Date.now() - start,
        error: err.message,
        code: err.code
      });
    });
  });
}

/**
 * 5. Direct probe: GET /api/v10/gateway/bot (Authenticated)
 * Checks if Discord returns the Gateway URL and session start limits
 * @param {string} token
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<object>}
 */
export async function probeGatewayBotEndpoint(token, timeoutMs = 8000) {
  if (!token) {
    return { success: false, error: 'No token provided' };
  }

  const start = Date.now();
  const cleanedToken = token.replace(/^(Bot|Bearer)\s*/i, '').trim();

  try {
    const res = await fetch('https://discord.com/api/v10/gateway/bot', {
      headers: {
        Authorization: `Bot ${cleanedToken}`,
        'User-Agent': 'DiscordBot (https://github.com/justhrshh/Peak-Clip, 1.0.0)'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });

    const durationMs = Date.now() - start;
    const status = res.status;

    if (!res.ok) {
      let bodyText = '';
      try {
        bodyText = await res.text();
      } catch (_) {}

      return {
        success: false,
        status,
        durationMs,
        rateLimited: status === 429,
        retryAfterHeader: res.headers.get('retry-after'),
        errorBody: bodyText
      };
    }

    const data = await res.json();
    return {
      success: true,
      status,
      durationMs,
      gatewayUrl: data.url,
      recommendedShards: data.shards,
      sessionStartLimit: data.session_start_limit
    };
  } catch (err) {
    return {
      success: false,
      durationMs: Date.now() - start,
      error: err.message,
      code: err.name === 'TimeoutError' ? 'FETCH_TIMEOUT' : err.code
    };
  }
}

/**
 * 6. Direct probe: GET /api/v10/applications/@me (Authenticated)
 * Checks application registration and whether GATEWAY_MESSAGE_CONTENT intent is enabled
 * @param {string} token
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<object>}
 */
export async function probeApplicationMetadata(token, timeoutMs = 8000) {
  if (!token) {
    return { success: false, error: 'No token provided' };
  }

  const start = Date.now();
  const cleanedToken = token.replace(/^(Bot|Bearer)\s*/i, '').trim();

  try {
    const res = await fetch('https://discord.com/api/v10/applications/@me', {
      headers: {
        Authorization: `Bot ${cleanedToken}`,
        'User-Agent': 'DiscordBot (https://github.com/justhrshh/Peak-Clip, 1.0.0)'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });

    const durationMs = Date.now() - start;
    const status = res.status;

    if (!res.ok) {
      return {
        success: false,
        status,
        durationMs,
        error: `HTTP ${status}`
      };
    }

    const app = await res.json();
    const flags = Number(app.flags ?? 0);
    const hasMessageContentIntent = (flags & APPLICATION_FLAGS.GATEWAY_MESSAGE_CONTENT) !== 0 ||
      (flags & APPLICATION_FLAGS.GATEWAY_MESSAGE_CONTENT_LIMITED) !== 0;

    return {
      success: true,
      status,
      durationMs,
      appId: app.id,
      name: app.name,
      botPublic: app.bot_public,
      botRequireCodeGrant: app.bot_require_code_grant,
      flags,
      hasMessageContentIntent
    };
  } catch (err) {
    return {
      success: false,
      durationMs: Date.now() - start,
      error: err.message
    };
  }
}

/**
 * Run complete diagnostic suite before login attempt and log detailed diagnostic summary
 * @param {string} token
 * @param {object} client
 * @returns {Promise<object>}
 */
export async function runComprehensiveLoginDiagnostics(token, client) {
  logger.info('[DIAGNOSTIC] Running pre-login Discord connectivity and infrastructure diagnostics...');

  // 1. Inspect Token & Intents
  const tokenReport = inspectToken(token);
  const intentsReport = inspectClientIntents(client);

  logger.info(
    {
      tokenPresent: tokenReport.present,
      tokenLength: tokenReport.length,
      tokenPartsCount: tokenReport.partsCount,
      tokenValidFormat: tokenReport.validFormat,
      messageContentIntentRequested: intentsReport.hasMessageContent,
      requestedIntentsBitfield: intentsReport.bitfield
    },
    '[DIAGNOSTIC] Token format and requested intents configuration'
  );

  // 2. DNS check
  const dnsReport = await checkDiscordDns();
  logger.info({ dns: dnsReport }, '[DIAGNOSTIC] DNS resolution results');

  // 3. TCP/TLS connection to Gateway
  const tlsReport = await checkDiscordGatewayTls(5000);
  logger.info({ tls: tlsReport }, '[DIAGNOSTIC] TCP/TLS handshake to gateway.discord.gg:443');

  // 4. Authenticated GET /api/v10/gateway/bot
  const gatewayBotReport = await probeGatewayBotEndpoint(token, 8000);
  logger.info(
    {
      gatewayBot: {
        success: gatewayBotReport.success,
        status: gatewayBotReport.status,
        durationMs: gatewayBotReport.durationMs,
        gatewayUrl: gatewayBotReport.gatewayUrl,
        recommendedShards: gatewayBotReport.recommendedShards,
        sessionStartLimit: gatewayBotReport.sessionStartLimit,
        error: gatewayBotReport.error
      }
    },
    '[DIAGNOSTIC] GET /api/v10/gateway/bot probe'
  );

  // 5. Authenticated Application Metadata (check portal intents)
  const appReport = await probeApplicationMetadata(token, 8000);
  logger.info(
    {
      application: {
        success: appReport.success,
        status: appReport.status,
        appId: appReport.appId,
        name: appReport.name,
        hasMessageContentIntent: appReport.hasMessageContentIntent,
        error: appReport.error
      }
    },
    '[DIAGNOSTIC] Application metadata & portal privileged intent check'
  );

  return {
    token: tokenReport,
    intents: intentsReport,
    dns: dnsReport,
    tls: tlsReport,
    gatewayBot: gatewayBotReport,
    application: appReport
  };
}
