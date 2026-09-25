import net from 'node:net';
import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayIntentBits } from 'discord.js';
import { config } from '../src/config/index.js';
import { getPrismaClient } from '../src/database/client.js';
import { QUEUE_NAMES } from '../src/queues/index.js';
import { createDiscordClient, startDiscordBot, getDiscordClient, stopDiscordBot } from '../src/bot/client.js';
import { AppError, DatabaseError, ProviderError } from '../src/utils/errors.js';
import { startHealthServer, stopHealthServer, resolveHealthPort, getHealthServer } from '../src/server/health.js';
import { bootstrap, shutdown } from '../src/app.js';

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

test('full app.js boot sequence opens a live TCP listener on resolved port', async () => {
  const originalPort = process.env.PORT;
  // Use port 0 so the OS assigns an ephemeral free port without collision
  process.env.PORT = '0';

  try {
    await bootstrap();

    const server = getHealthServer();
    assert.ok(server, 'Health server instance must exist after bootstrap');
    assert.equal(server.listening, true, 'Health server must be actively listening');

    const address = server.address();
    assert.ok(address && typeof address === 'object', 'Server address must be an object');
    const actualPort = address.port;
    assert.ok(actualPort > 0, `Expected actual bound port to be > 0, got ${actualPort}`);

    // Assert live TCP listener via net.createConnection
    const connected = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: actualPort }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', (err) => {
        reject(err);
      });
    });
    assert.equal(connected, true, 'TCP socket connection must succeed against listening port');

    // Also assert HTTP GET /health returns 200
    const res = await fetch(`http://127.0.0.1:${actualPort}/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.status === 'ok' || data.status === 'degraded');
  } finally {
    await shutdown('SIGTERM', false);
    if (originalPort !== undefined) {
      process.env.PORT = originalPort;
    } else {
      delete process.env.PORT;
    }
  }
});

test('startHealthServer rejects with fatal error when port is already in use', async () => {
  // Bind a dummy server to an ephemeral port
  const dummy = http.createServer();
  await new Promise((resolve) => dummy.listen(0, '0.0.0.0', resolve));
  const occupiedPort = dummy.address().port;

  try {
    await assert.rejects(
      async () => {
        await startHealthServer(occupiedPort);
      },
      (err) => {
        assert.equal(err.code, 'EADDRINUSE');
        return true;
      }
    );
  } finally {
    await new Promise((resolve) => dummy.close(resolve));
    await stopHealthServer();
  }
});

test('createDiscordClient requests expected gateway intents including MessageContent', () => {
  const client = createDiscordClient();
  assert.ok(client);
  const intentsBitfield = BigInt(client.options.intents.bitfield);
  const messageContentBit = BigInt(GatewayIntentBits.MessageContent);
  assert.equal((intentsBitfield & messageContentBit) === messageContentBit, true);
});

test('startDiscordBot enforces explicit timeout if gateway login hangs', async () => {
  const client = getDiscordClient();
  const origLogin = client.login;
  // Mock client.login to hang indefinitely
  client.login = () => new Promise(() => {});

  const origToken = config.discord.token;
  config.discord.token = 'mock_token_for_timeout_test';

  try {
    await assert.rejects(
      async () => {
        await startDiscordBot(150); // 150ms timeout
      },
      (err) => {
        assert.equal(err.code, 'DISCORD_LOGIN_TIMEOUT');
        assert.match(err.message, /timed out after 0\.15s/);
        return true;
      }
    );
  } finally {
    client.login = origLogin;
    config.discord.token = origToken;
    await stopDiscordBot();
  }
});




