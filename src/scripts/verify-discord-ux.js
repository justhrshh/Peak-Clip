import { Client, GatewayIntentBits, Events } from 'discord.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { ROLE_NAMES } from '../bot/provisioning/server.structure.js';

async function main() {
  if (!config.discord.token) {
    throw new Error('DISCORD_TOKEN is required in .env');
  }
  if (!config.discord.guildId) {
    throw new Error('DISCORD_GUILD_ID is required in .env');
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages
    ]
  });

  logger.info('Authenticating bot client with Discord Gateway...');
  await client.login(config.discord.token);

  await new Promise((resolve) => client.once(Events.ClientReady, resolve));
  logger.info({ botUser: client.user.tag, botId: client.user.id }, 'Discord bot authenticated successfully');

  logger.info({ guildId: config.discord.guildId }, 'Fetching target DEV guild...');
  const guild = await client.guilds.fetch(config.discord.guildId);
  logger.info({ guildName: guild.name, guildId: guild.id }, 'Target guild fetched');

  // 1. Verify Provisioned Roles
  const roles = await guild.roles.fetch();
  const botMember = await guild.members.fetch(client.user.id);
  const botRole = botMember.roles.botRole || roles.find((r) => r.tags?.botId === client.user.id);
  const adminRole = roles.find((r) => r.name.toLowerCase() === ROLE_NAMES.PEAK_ADMIN.toLowerCase());
  const cmRole = roles.find((r) => r.name.toLowerCase() === ROLE_NAMES.CAMPAIGN_MANAGER.toLowerCase());
  const creatorRole = roles.find((r) => r.name.toLowerCase() === ROLE_NAMES.CREATOR.toLowerCase());

  console.log('\n================== 1. ROLE VERIFICATION ==================');
  console.log(`Bot Managed Role:   ${botRole ? `✅ ${botRole.name} (pos: ${botRole.position}, id: ${botRole.id})` : '❌ Missing'}`);
  console.log(`Peak Admin Role:    ${adminRole ? `✅ ${adminRole.name} (pos: ${adminRole.position}, id: ${adminRole.id})` : '❌ Missing'}`);
  console.log(`Campaign Manager:   ${cmRole ? `✅ ${cmRole.name} (pos: ${cmRole.position}, id: ${cmRole.id})` : '❌ Missing'}`);
  console.log(`Creator Role:       ${creatorRole ? `✅ ${creatorRole.name} (pos: ${creatorRole.position}, id: ${creatorRole.id})` : '❌ Missing'}`);

  const hierarchyValid = botRole && adminRole && cmRole && creatorRole &&
    botRole.position > adminRole.position &&
    adminRole.position > cmRole.position &&
    cmRole.position > creatorRole.position;

  console.log(`Role Hierarchy:     ${hierarchyValid ? '✅ VALID (Bot > Admin > CM > Creator)' : '⚠️ Check positions'}`);

  // 2. Verify Slash Command Registrations
  const commands = await guild.commands.fetch();
  const expectedCommands = [
    'ping',
    'setup',
    'verify',
    'campaigns',
    'submit',
    'submissions',
    'statistics',
    'earnings',
    'payout',
    'admin'
  ];

  console.log('\n============== 2. SLASH COMMAND REGISTRATIONS =============');
  console.log(`Total Registered:   ${commands.size}`);
  let allCommandsPresent = true;
  for (const cmdName of expectedCommands) {
    const found = commands.find((c) => c.name === cmdName);
    if (found) {
      console.log(`  /${cmdName.padEnd(14)} ✅ Registered (id: ${found.id})`);
    } else {
      console.log(`  /${cmdName.padEnd(14)} ❌ Missing`);
      allCommandsPresent = false;
    }
  }

  // 3. Verify Provisioned Channels & Categories
  const channels = await guild.channels.fetch();
  const categories = channels.filter((c) => c?.type === 4); // GuildCategory = 4
  const textChannels = channels.filter((c) => c?.type === 0); // GuildText = 0

  console.log('\n================ 3. STRUCTURE VERIFICATION ===============');
  console.log(`Categories:         ${categories.size} found`);
  console.log(`Text Channels:      ${textChannels.size} found`);

  const payoutQueue = channels.find((c) => c?.name === 'payout-queue');
  if (payoutQueue) {
    const overwrites = payoutQueue.permissionOverwrites.cache;
    const everyoneDenied = overwrites.get(guild.id)?.deny.has('ViewChannel');
    const adminAllowed = adminRole && overwrites.get(adminRole.id)?.allow.has('ViewChannel');
    console.log(`  #payout-queue:    ✅ Isolated (@everyone denied View: ${everyoneDenied}, Admin View: ${adminAllowed})`);
  } else {
    console.log('  #payout-queue:    ❌ Missing');
  }

  // 4. Overall UX Readiness Summary
  console.log('\n================== 4. PHASE 9B UX SUMMARY =================');
  const isReady = hierarchyValid && allCommandsPresent && !!payoutQueue;
  console.log(`Phase 9B Status:    ${isReady ? '✅ READY FOR CREATORS & STAFF' : '⚠️ ATTENTION REQUIRED'}`);
  console.log('Guild ID:          ', guild.id);
  console.log('Guild Name:        ', guild.name);
  console.log('===========================================================\n');

  client.destroy();
  process.exit(isReady ? 0 : 1);
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'Live DEV server UX verification failed');
  process.exit(1);
});
