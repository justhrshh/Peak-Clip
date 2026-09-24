/**
 * Guild Audit Script (Read-Only)
 * 
 * Safely inspects a Discord guild to extract a comprehensive JSON summary of:
 * - Roles & hierarchy
 * - Channels, categories, and permission overwrites
 * - Member count and bot members present (identifying other bots & their permissions)
 * 
 * SAFETY GUARANTEES:
 * - Strictly READ-ONLY: performs zero mutations (no message sends, no permission edits, no deletions).
 * - Reads token SOLELY from `process.env.AUDIT_BOT_TOKEN` (never touches DISCORD_TOKEN or main bot config).
 * - Exports formatted output to `audit-output/guild-<guildId>-<timestamp>.json`.
 */

import { Client, GatewayIntentBits, ChannelType, PermissionsBitField } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

// Load .env if present, but NEVER fallback to DISCORD_TOKEN
dotenv.config();

const auditToken = process.env.AUDIT_BOT_TOKEN;
const targetGuildId = process.env.AUDIT_GUILD_ID || (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null);

if (!auditToken) {
  console.error('\x1b[31m[ERROR] AUDIT_BOT_TOKEN environment variable is required.\x1b[0m');
  console.error('Please set AUDIT_BOT_TOKEN in your environment or .env before running this script.');
  console.error('Example:');
  console.error('  $env:AUDIT_BOT_TOKEN="your_temporary_audit_bot_token"');
  console.error('  node scripts/guild-audit.js [GUILD_ID]');
  process.exit(1);
}

async function runAudit(withMembersIntent = true) {
  const intents = [GatewayIntentBits.Guilds];
  if (withMembersIntent) {
    intents.push(GatewayIntentBits.GuildMembers);
  }

  const client = new Client({ intents });

  console.log(`\x1b[36m[AUDIT] Connecting with AUDIT_BOT_TOKEN (Read-Only, MembersIntent=${withMembersIntent})...\x1b[0m`);

  client.once('ready', async () => {
    try {
      console.log(`\x1b[32m[AUDIT] Logged in as ${client.user.tag} (ID: ${client.user.id})\x1b[0m`);

      let guild;
      if (targetGuildId) {
        guild = await client.guilds.fetch(targetGuildId).catch(() => null);
        if (!guild) {
          console.error(`\x1b[31m[ERROR] Could not fetch target guild with ID: ${targetGuildId}\x1b[0m`);
          await client.destroy();
          process.exit(1);
        }
      } else {
        const guilds = await client.guilds.fetch();
        if (guilds.size === 0) {
          console.error('\x1b[31m[ERROR] The audit bot is not a member of any servers.\x1b[0m');
          await client.destroy();
          process.exit(1);
        }
        if (guilds.size > 1) {
          console.log('\x1b[33m[NOTICE] The audit bot is in multiple guilds. Please pass GUILD_ID as an argument or AUDIT_GUILD_ID in env.\x1b[0m');
          console.log('Available guilds:');
          for (const [id, g] of guilds) {
            console.log(`  - ${g.name} (${id})`);
          }
          await client.destroy();
          process.exit(1);
        }
        const firstGuildId = guilds.first().id;
        guild = await client.guilds.fetch(firstGuildId);
      }

      console.log(`\x1b[34m[AUDIT] Extracting audit data for: "${guild.name}" (${guild.id})...\x1b[0m`);

      // 1. Fetch full guild data (roles, channels, members)
      const fetchedRoles = await guild.roles.fetch();
      const fetchedChannels = await guild.channels.fetch();
      
      // Attempt to fetch members for bot audit
      let fetchedMembers = [];
      if (withMembersIntent) {
        try {
          const membersMap = await guild.members.fetch();
          fetchedMembers = Array.from(membersMap.values());
        } catch (err) {
          console.warn('\x1b[33m[WARN] Could not fetch full member list: ' + err.message + '\x1b[0m');
          fetchedMembers = Array.from(guild.members.cache.values());
        }
      } else {
        fetchedMembers = Array.from(guild.members.cache.values());
      }

      // 2. Process Roles (ordered descending by hierarchy position)
      const rolesList = Array.from(fetchedRoles.values())
        .sort((a, b) => b.position - a.position)
        .map((r) => {
          const perms = r.permissions.toArray();
          return {
            id: r.id,
            name: r.name,
            position: r.position,
            color: r.hexColor,
            hoist: r.hoist,
            managed: r.managed,
            mentionable: r.mentionable,
            isAdministrator: r.permissions.has(PermissionsBitField.Flags.Administrator),
            permissions: perms,
            membersCount: r.members.size
          };
        });

      // 3. Process Categories & Channels
      const categories = [];
      const channels = [];

      for (const [, ch] of fetchedChannels) {
        if (!ch) continue;

        // Process permission overwrites
        const overwrites = [];
        for (const [, ow] of ch.permissionOverwrites.cache) {
          const targetName = ow.type === 0 // Role
            ? (fetchedRoles.get(ow.id)?.name || `Role:${ow.id}`)
            : (guild.members.cache.get(ow.id)?.user.tag || `Member:${ow.id}`);

          overwrites.push({
            id: ow.id,
            type: ow.type === 0 ? 'ROLE' : 'MEMBER',
            name: targetName,
            allow: ow.allow.toArray(),
            deny: ow.deny.toArray()
          });
        }

        const channelData = {
          id: ch.id,
          name: ch.name,
          type: ChannelType[ch.type] || ch.type,
          rawType: ch.type,
          position: ch.position,
          parentId: ch.parentId || null,
          parentName: ch.parent ? ch.parent.name : null,
          topic: ch.topic || null,
          rateLimitPerUser: ch.rateLimitPerUser || 0,
          permissionOverwrites: overwrites
        };

        if (ch.type === ChannelType.GuildCategory) {
          categories.push(channelData);
        } else {
          channels.push(channelData);
        }
      }

      // Sort channels by position
      categories.sort((a, b) => a.position - b.position);
      channels.sort((a, b) => a.position - b.position);

      // 4. Process Other Bots & Integrations
      const botsPresent = [];
      for (const member of fetchedMembers) {
        if (member.user?.bot) {
          const memberRoles = member.roles.cache.map((r) => ({
            id: r.id,
            name: r.name,
            position: r.position
          })).sort((a, b) => b.position - a.position);

          botsPresent.push({
            userId: member.user.id,
            tag: member.user.tag,
            username: member.user.username,
            isCurrentAuditBot: member.user.id === client.user.id,
            joinedAt: member.joinedAt ? member.joinedAt.toISOString() : null,
            isAdministrator: member.permissions.has(PermissionsBitField.Flags.Administrator),
            roles: memberRoles,
            effectivePermissions: member.permissions.toArray()
          });
        }
      }

      // 5. Structure Complete Audit Payload
      const auditPayload = {
        metadata: {
          auditVersion: '1.0.0',
          auditedAt: new Date().toISOString(),
          auditedByBot: {
            id: client.user.id,
            tag: client.user.tag
          },
          membersIntentActive: withMembersIntent
        },
        guild: {
          id: guild.id,
          name: guild.name,
          description: guild.description,
          ownerId: guild.ownerId,
          approximateMemberCount: guild.approximateMemberCount || guild.memberCount,
          memberCount: guild.memberCount,
          verificationLevel: guild.verificationLevel,
          explicitContentFilter: guild.explicitContentFilter,
          defaultMessageNotifications: guild.defaultMessageNotifications,
          rulesChannelId: guild.rulesChannelId,
          systemChannelId: guild.systemChannelId,
          publicUpdatesChannelId: guild.publicUpdatesChannelId
        },
        summary: {
          totalRoles: rolesList.length,
          totalCategories: categories.length,
          totalChannels: channels.length,
          totalBotsFound: botsPresent.length,
          adminRolesCount: rolesList.filter((r) => r.isAdministrator).length
        },
        roles: rolesList,
        categories,
        channels,
        bots: botsPresent
      };

      // 6. Save JSON Output
      const outputDir = path.resolve(process.cwd(), 'audit-output');
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `guild-${guild.id}-${timestamp}.json`;
      const outputPath = path.join(outputDir, filename);

      fs.writeFileSync(outputPath, JSON.stringify(auditPayload, null, 2), 'utf-8');

      console.log(`\n\x1b[32m[SUCCESS] Audit completed successfully!\x1b[0m`);
      console.log(`\x1b[37mFile saved to: ${outputPath}\x1b[0m\n`);
      console.log('=== AUDIT SUMMARY ===');
      console.log(`Server: ${guild.name} (${guild.id})`);
      console.log(`Members: ${guild.memberCount}`);
      console.log(`Roles: ${rolesList.length} total (${auditPayload.summary.adminRolesCount} Admin)`);
      console.log(`Categories: ${categories.length}`);
      console.log(`Channels: ${channels.length}`);
      console.log(`Bots Detected: ${botsPresent.length}`);
      if (botsPresent.length > 0) {
        console.log('Detected Bots:');
        for (const bot of botsPresent) {
          console.log(`  - ${bot.tag} (Admin: ${bot.isAdministrator})`);
        }
      } else if (!withMembersIntent) {
        console.log('  (Detailed bot scan omitted: privileged Server Members Intent not enabled on audit token)');
      }
      console.log('=====================\n');

      await client.destroy();
      process.exit(0);
    } catch (err) {
      console.error('\x1b[31m[ERROR] Failed to run guild audit:\x1b[0m', err);
      await client.destroy();
      process.exit(1);
    }
  });

  client.login(auditToken).catch(async (err) => {
    if (withMembersIntent && (err.message?.includes('disallowed intents') || err.code === 'DisallowedIntents')) {
      console.warn('\x1b[33m[WARN] Server Members Intent is not enabled on this bot token in Discord Dev Portal.\x1b[0m');
      console.warn('\x1b[33m[WARN] Automatically falling back to standard unprivileged intent mode...\x1b[0m');
      await client.destroy().catch(() => {});
      return runAudit(false);
    }
    console.error('\x1b[31m[ERROR] Failed to login with AUDIT_BOT_TOKEN:\x1b[0m', err.message);
    process.exit(1);
  });
}

runAudit(true);
