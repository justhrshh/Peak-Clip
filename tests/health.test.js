import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config/index.js';
import { getPrismaClient } from '../src/database/client.js';
import { QUEUE_NAMES } from '../src/queues/index.js';
import { createDiscordClient } from '../src/bot/client.js';
import { AppError, DatabaseError, ProviderError } from '../src/utils/errors.js';
import { startHealthServer, stopHealthServer, resolveHealthPort } from '../src/server/health.js';

test('Configuration loads with expected defaults', () => {
  assert.ok(config);
  assert.equal(typeof config.env, 'string');
  assert.equal(typeof config.port, 'number');
  assert.ok(config.redis);
  assert.ok(config.db);
  assert.ok(config.discord);
});

test('resolveHealthPort respects process.env.PORT, explicit arguments, and defaults', () => {
  const originalEnvPort = process.env.PORT;

  try {
    // 1. Explicit port argument takes highest precedence
    assert.equal(resolveHealthPort(8080), 8080);
    assert.equal(resolveHealthPort('9090'), 9090);
    assert.equal(resolveHealthPort(0), 0);

    // 2. process.env.PORT is respected when set
    process.env.PORT = '5555';
    assert.equal(resolveHealthPort(), 5555);

    process.env.PORT = '10000';
    assert.equal(resolveHealthPort(), 10000);

    // 3. Fallback when PORT is unset
    delete process.env.PORT;
    const fallback = resolveHealthPort();
    assert.equal(fallback, config.port || 3000);
  } finally {
    if (originalEnvPort !== undefined) {
      process.env.PORT = originalEnvPort;
    } else {
      delete process.env.PORT;
    }
  }
});

test('HTTP health check server starts, binds dynamically, and responds on /health', async () => {
  // Bind to port 0 (ephemeral free port) to avoid port collisions and confirm dynamic binding
  const server = await startHealthServer(0);
  assert.ok(server);
  assert.equal(server.listening, true);

  const address = server.address();
  assert.ok(address);
  assert.ok(typeof address === 'object' && address.port > 0);

  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.status === 'ok' || body.status === 'degraded');
    assert.ok(body.services);
    assert.ok(typeof body.uptimeSeconds === 'number');
  } finally {
    await stopHealthServer();
    assert.equal(server.listening, false);
  }
});

test('Error classes instantiate with expected properties', () => {
  const appErr = new AppError('test error', 'TEST_CODE', 400);
  assert.equal(appErr.message, 'test error');
  assert.equal(appErr.code, 'TEST_CODE');
  assert.equal(appErr.statusCode, 400);

  const dbErr = new DatabaseError('db failed');
  assert.equal(dbErr.code, 'DATABASE_ERROR');

  const providerErr = new ProviderError('api down', 'youtube');
  assert.equal(providerErr.code, 'PROVIDER_ERROR');
  assert.equal(providerErr.details.provider, 'youtube');
});

test('Prisma client singleton initializes without crash', () => {
  const client = getPrismaClient();
  assert.ok(client);
});

test('Queue definitions are defined with standard names', () => {
  assert.equal(QUEUE_NAMES.VERIFICATION, 'verification-queue');
  assert.equal(QUEUE_NAMES.METRICS, 'metrics-queue');
  assert.equal(QUEUE_NAMES.PAYOUT, 'payout-queue');
});

test('Discord client factory instantiates client and registers ping command', () => {
  const client = createDiscordClient();
  assert.ok(client);
  assert.ok(client.commands.has('ping'));
});

