import http from 'node:http';
import { prisma } from '../database/client.js';
import { testRedisConnection } from '../queues/redis.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { getDiscordBotStatus } from '../bot/client.js';

let serverInstance = null;

/**
 * Perform a fast, non-blocking check on Database, Redis, and Discord Bot
 * @returns {Promise<{ db: string, redis: string, discord: string, healthy: boolean }>}
 */
async function performConnectivityChecks() {
  const result = {
    db: 'unknown',
    redis: 'unknown',
    discord: 'unknown',
    healthy: true
  };

  // 1. Database check (SELECT 1 with 2s timeout)
  try {
    const dbPromise = prisma.$queryRaw`SELECT 1`;
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('DB check timed out (>2s)')), 2000)
    );
    await Promise.race([dbPromise, timeoutPromise]);
    result.db = 'connected';
  } catch (err) {
    result.db = `error: ${err.message}`;
    result.healthy = false;
  }

  // 2. Redis check (probe connect & ping with 1s timeout)
  try {
    const isRedisConnected = await testRedisConnection();
    result.redis = isRedisConnected ? 'connected' : 'offline';
  } catch (err) {
    result.redis = `error: ${err.message}`;
  }

  // 3. Discord bot state check
  try {
    const botStatus = getDiscordBotStatus();
    result.discord = botStatus.state;
    if (botStatus.state === 'rate_limited') {
      result.healthy = false;
    }
  } catch (err) {
    result.discord = `error: ${err.message}`;
  }

  return result;
}

/**
 * Resolve the port to bind the health check server to.
 * Priority:
 * 1. Explicit port argument (if passed and valid)
 * 2. process.env.PORT (if set and non-empty)
 * 3. Production fallback (Render scans port 10000 by default when PORT is unset)
 * 4. config.port (if set)
 * 5. Fallback default: 3000 (for local dev)
 *
 * @param {number|string} [port]
 * @returns {number}
 */
export function resolveHealthPort(port) {
  if (port !== undefined && port !== null && port !== '') {
    const parsed = Number(port);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  if (process.env.PORT !== undefined && process.env.PORT !== '') {
    const parsedEnv = Number(process.env.PORT);
    if (!Number.isNaN(parsedEnv) && parsedEnv >= 0) {
      return parsedEnv;
    }
  }

  // Render Web Services default to scanning port 10000 in production when PORT is unset
  if (config?.isProduction) {
    return 10000;
  }

  if (config?.port !== undefined && config?.port !== null) {
    const parsedConfig = Number(config.port);
    if (!Number.isNaN(parsedConfig) && parsedConfig >= 0) {
      return parsedConfig;
    }
  }

  return 3000;
}

/**
 * Start the lightweight HTTP health check server for Render/Cloud platforms
 * Binds strictly to 0.0.0.0 on process.env.PORT
 *
 * @param {number} [port]
 * @returns {Promise<http.Server>}
 */
export function startHealthServer(port) {
  if (serverInstance) {
    return Promise.resolve(serverInstance);
  }

  const resolvedPort = resolveHealthPort(port);

  logger.info(
    {
      rawEnvPort: process.env.PORT ?? null,
      resolvedPort,
      nodeEnv: config?.env ?? 'development',
      isProduction: Boolean(config?.isProduction)
    },
    `Health check port configuration: process.env.PORT=${JSON.stringify(process.env.PORT ?? null)}, resolvedPort=${resolvedPort}`
  );

  return new Promise((resolve, reject) => {
    let hasSettled = false;

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      // Public health check routes (no auth required)
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
        const checks = await performConnectivityChecks();
        const payload = {
          status: checks.healthy ? 'ok' : 'degraded',
          timestamp: new Date().toISOString(),
          uptimeSeconds: Math.floor(process.uptime()),
          environment: config.env,
          services: {
            database: checks.db,
            redis: checks.redis,
            discord: checks.discord
          }
        };

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(JSON.stringify(payload, null, 2));
        return;
      }

      // Any other endpoint
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    });

    server.on('error', (err) => {
      if (!hasSettled) {
        hasSettled = true;
        logger.fatal(
          { err: err.message, stack: err.stack, port: resolvedPort, host: '0.0.0.0' },
          `Fatal: Health check HTTP server failed to bind on 0.0.0.0:${resolvedPort}`
        );
        reject(err);
      } else {
        logger.error({ err: err.message, port: resolvedPort }, 'Health check HTTP server runtime error');
      }
    });

    try {
      // Explicitly bind to 0.0.0.0 for containerized platforms like Render
      server.listen(resolvedPort, '0.0.0.0', () => {
        hasSettled = true;
        serverInstance = server;
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr !== null ? addr.port : resolvedPort;
        logger.info(
          { port: actualPort, host: '0.0.0.0', requestedPort: resolvedPort },
          `Health check HTTP server listening on 0.0.0.0:${actualPort} [GET /health]`
        );
        resolve(server);
      });
    } catch (err) {
      if (!hasSettled) {
        hasSettled = true;
        logger.fatal(
          { err: err.message, stack: err.stack, port: resolvedPort, host: '0.0.0.0' },
          `Fatal: Synchronous error binding Health check HTTP server on 0.0.0.0:${resolvedPort}`
        );
        reject(err);
      }
    }
  });
}

/**
 * Get current HTTP health check server instance (useful for testing and inspection)
 * @returns {http.Server|null}
 */
export function getHealthServer() {
  return serverInstance;
}

/**
 * Gracefully stop the HTTP health check server
 * @returns {Promise<void>}
 */
export function stopHealthServer() {
  if (!serverInstance) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    if (typeof serverInstance.closeAllConnections === 'function') {
      serverInstance.closeAllConnections();
    }
    serverInstance.close((err) => {
      if (err) {
        logger.warn({ err: err.message }, 'Error closing health check HTTP server');
      } else {
        logger.info('Health check HTTP server stopped cleanly.');
      }
      serverInstance = null;
      resolve();
    });
  });
}
