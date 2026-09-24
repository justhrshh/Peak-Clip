import http from 'node:http';
import { prisma } from '../database/client.js';
import { testRedisConnection } from '../queues/redis.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

let serverInstance = null;

/**
 * Perform a fast, non-blocking check on Database and Redis
 * @returns {Promise<{ db: string, redis: string, healthy: boolean }>}
 */
async function performConnectivityChecks() {
  const result = {
    db: 'unknown',
    redis: 'unknown',
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

  return result;
}

/**
 * Start the lightweight HTTP health check server for Render/Cloud platforms
 * Binds strictly to 0.0.0.0 on process.env.PORT
 *
 * @param {number} [port]
 * @returns {Promise<http.Server>}
 */
export function startHealthServer(port = Number(process.env.PORT) || config.port || 3000) {
  if (serverInstance) {
    return Promise.resolve(serverInstance);
  }

  return new Promise((resolve, reject) => {
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
            redis: checks.redis
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
      logger.error({ err: err.message, port }, 'Health check HTTP server error');
      reject(err);
    });

    // Explicitly bind to 0.0.0.0 for containerized platforms like Render
    server.listen(port, '0.0.0.0', () => {
      serverInstance = server;
      logger.info({ port, host: '0.0.0.0' }, `Health check HTTP server listening on 0.0.0.0:${port} [GET /health]`);
      resolve(server);
    });
  });
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
