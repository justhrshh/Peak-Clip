import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config/index.js';
import { getPrismaClient } from '../src/database/client.js';
import { QUEUE_NAMES } from '../src/queues/index.js';
import { createDiscordClient } from '../src/bot/client.js';
import { AppError, DatabaseError, ProviderError } from '../src/utils/errors.js';

test('Configuration loads with expected defaults', () => {
  assert.ok(config);
  assert.equal(typeof config.env, 'string');
  assert.equal(typeof config.port, 'number');
  assert.ok(config.redis);
  assert.ok(config.db);
  assert.ok(config.discord);
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
