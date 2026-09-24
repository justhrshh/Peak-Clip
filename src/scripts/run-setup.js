import { Client, GatewayIntentBits, Events } from 'discord.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { serverProvisioner } from '../bot/provisioning/server.provisioner.js';

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
  logger.info({ botUser: client.user.tag }, 'Discord bot authenticated successfully');

  logger.info({ guildId: config.discord.guildId }, 'Fetching target DEV guild...');
  const guild = await client.guilds.fetch(config.discord.guildId);
  logger.info({ guildName: guild.name, guildId: guild.id }, 'Target guild fetched');

  // Fetch guild owner to act as the authorized Peak Admin actor
  const owner = await guild.fetchOwner();
  logger.info({ ownerTag: owner.user.tag, ownerId: owner.id }, 'Resolved guild owner as provisioning actor');

  const actorContext = {
    guild,
    member: owner,
    user: owner.user
  };

  logger.info('Invoking ServerProvisioner against Peak Clip — DEV...');
  const result = await serverProvisioner.provisionServer(guild, actorContext);

  console.log('\n================ PROVISIONING COMPLETED ================');
  console.log(JSON.stringify(result, null, 2));
  console.log('========================================================\n');

  client.destroy();
  process.exit(0);
}

main().catch((err) => {
  logger.error(
    {
      err: err.message,
      code: err.code,
      status: err.status,
      diagnostic: err.diagnostic,
      stack: err.stack
    },
    'Provisioning execution script failed'
  );
  process.exit(1);
});
