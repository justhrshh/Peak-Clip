import { PermissionFlagsBits } from 'discord.js';

/**
 * Security Invariant: Administrator bit must NEVER be granted to any role or overwrite.
 */
export const FORBIDDEN_ADMIN_FLAG = PermissionFlagsBits.Administrator;

/**
 * Helper to combine an array of PermissionFlagsBits into a single BigInt bitfield,
 * asserting that Administrator is never present.
 *
 * @param {Array<bigint>} flags
 * @returns {bigint}
 */
export function combinePermissions(flags = []) {
  let bitfield = 0n;
  for (const flag of flags) {
    if (flag === FORBIDDEN_ADMIN_FLAG) {
      throw new Error('Security Violation: Administrator permission flag cannot be granted.');
    }
    bitfield |= flag;
  }
  return bitfield;
}

/**
 * Filter a requested bitfield against the bot's effective guild permissions.
 * Ensures the bot only delegates permissions it legitimately possesses.
 *
 * @param {bigint} bitfield
 * @param {import('discord.js').PermissionsBitField|bigint} botPermissions
 * @returns {bigint}
 */
export function filterDelegatablePermissions(bitfield, botPermissions) {
  if (!botPermissions) return bitfield;
  const botBits = typeof botPermissions === 'bigint' ? botPermissions : botPermissions.bitfield;
  return bitfield & botBits;
}

/**
 * Base permissions granted to roles upon creation.
 * Strictly limited to permissions the bot's integration role possesses and can legitimately delegate.
 * Excludes ManageMessages, AddReactions, and UseApplicationCommands unless possessed.
 */
export const BASE_ROLE_PERMISSIONS = Object.freeze({
  PEAK_ADMIN: combinePermissions([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.ReadMessageHistory
  ]),
  CAMPAIGN_MANAGER: combinePermissions([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.ReadMessageHistory
  ]),
  CREATOR: combinePermissions([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.ReadMessageHistory
  ])
});

/**
 * Build permission overwrites for a category
 *
 * @param {string} categoryName
 * @param {object} roleMap - Map of role key (PEAK_ADMIN, CAMPAIGN_MANAGER, CREATOR, PEAK_CLIP_BOT) to Discord Role
 * @param {object} everyoneRole - Discord @everyone Role
 * @returns {Array<object>} Overwrite specifications
 */
export function getCategoryOverwrites(categoryName, roleMap, everyoneRole) {
  const overwrites = [];

  const adminRole = roleMap.PEAK_ADMIN;
  const cmRole = roleMap.CAMPAIGN_MANAGER;
  const creatorRole = roleMap.CREATOR;
  const botRole = roleMap.PEAK_CLIP_BOT;

  const standardReadWrite = combinePermissions([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles
  ]);

  const standardReadOnly = combinePermissions([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory
  ]);

  const denySend = combinePermissions([
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.SendMessagesInThreads
  ]);

  switch (categoryName) {
    case 'INFORMATION': {
      // @everyone: can read/history, cannot send/thread
      overwrites.push({
        id: everyoneRole.id,
        allow: standardReadOnly,
        deny: denySend
      });

      if (creatorRole) {
        overwrites.push({
          id: creatorRole.id,
          allow: standardReadOnly,
          deny: denySend
        });
      }

      if (cmRole) {
        overwrites.push({
          id: cmRole.id,
          allow: standardReadWrite,
          deny: 0n
        });
      }

      if (adminRole) {
        overwrites.push({
          id: adminRole.id,
          allow: standardReadWrite,
          deny: 0n
        });
      }

      if (botRole) {
        overwrites.push({
          id: botRole.id,
          allow: standardReadWrite,
          deny: 0n
        });
      }
      break;
    }

    case 'CREATOR': {
      // @everyone: hidden by default
      overwrites.push({
        id: everyoneRole.id,
        allow: 0n,
        deny: combinePermissions([PermissionFlagsBits.ViewChannel])
      });

      if (creatorRole) {
        overwrites.push({
          id: creatorRole.id,
          allow: standardReadWrite,
          deny: 0n
        });
      }

      if (cmRole) {
        overwrites.push({
          id: cmRole.id,
          allow: standardReadWrite,
          deny: 0n
        });
      }

      if (adminRole) {
        overwrites.push({
          id: adminRole.id,
          allow: standardReadWrite,
          deny: 0n
        });
      }

      if (botRole) {
        overwrites.push({
          id: botRole.id,
          allow: standardReadWrite,
          deny: 0n
        });
      }
      break;
    }

    case 'STAFF': {
      // @everyone: hidden
      overwrites.push({
        id: everyoneRole.id,
        allow: 0n,
        deny: combinePermissions([PermissionFlagsBits.ViewChannel])
      });

      // Creator: strictly hidden
      if (creatorRole) {
        overwrites.push({
          id: creatorRole.id,
          allow: 0n,
          deny: combinePermissions([PermissionFlagsBits.ViewChannel])
        });
      }

      if (adminRole) {
        overwrites.push({
          id: adminRole.id,
          allow: standardReadWrite,
          deny: 0n
        });
      }

      if (botRole) {
        overwrites.push({
          id: botRole.id,
          allow: standardReadWrite,
          deny: 0n
        });
      }
      break;
    }

    case 'SYSTEM': {
      // @everyone: hidden
      overwrites.push({
        id: everyoneRole.id,
        allow: 0n,
        deny: combinePermissions([PermissionFlagsBits.ViewChannel])
      });

      if (creatorRole) {
        overwrites.push({
          id: creatorRole.id,
          allow: 0n,
          deny: combinePermissions([PermissionFlagsBits.ViewChannel])
        });
      }

      if (cmRole) {
        overwrites.push({
          id: cmRole.id,
          allow: 0n,
          deny: combinePermissions([PermissionFlagsBits.ViewChannel])
        });
      }

      if (adminRole) {
        overwrites.push({
          id: adminRole.id,
          allow: standardReadWrite,
          deny: 0n
        });
      }

      if (botRole) {
        overwrites.push({
          id: botRole.id,
          allow: standardReadWrite,
          deny: 0n
        });
      }
      break;
    }

    default:
      break;
  }

  return overwrites;
}

/**
 * Build channel-specific permission overwrites when channel deviates from category defaults
 *
 * @param {string} categoryName
 * @param {string} channelName
 * @param {object} roleMap
 * @param {object} everyoneRole
 * @returns {Array<object>|null} Specific overwrites or null if inherited completely
 */
export function getChannelOverwrites(categoryName, channelName, roleMap, everyoneRole) {
  const cmRole = roleMap.CAMPAIGN_MANAGER;

  const standardReadWrite = combinePermissions([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles
  ]);

  const standardReadOnly = combinePermissions([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory
  ]);

  const denySend = combinePermissions([
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.SendMessagesInThreads
  ]);

  // CREATOR / dashboard: allows @everyone to see so creators can access Creator Center and onboard
  if (categoryName === 'CREATOR' && channelName === 'dashboard') {
    const overwrites = getCategoryOverwrites(categoryName, roleMap, everyoneRole);
    const everyoneOw = overwrites.find((o) => o.id === everyoneRole.id);
    if (everyoneOw) {
      everyoneOw.allow = standardReadOnly;
      everyoneOw.deny = denySend;
    }
    return overwrites;
  }

  // STAFF Category channels: Campaign Manager access rules
  if (categoryName === 'STAFF') {
    const baseStaff = getCategoryOverwrites(categoryName, roleMap, everyoneRole);

    if (['dashboard', 'review-queue', 'creators', 'campaign-management'].includes(channelName)) {
      if (cmRole) {
        baseStaff.push({
          id: cmRole.id,
          allow: standardReadWrite,
          deny: 0n
        });
      }
      return baseStaff;
    }

    if (channelName === 'audit-log') {
      if (cmRole) {
        // Read-only for Campaign Manager
        baseStaff.push({
          id: cmRole.id,
          allow: standardReadOnly,
          deny: denySend
        });
      }
      return baseStaff;
    }

    if (channelName === 'payout-queue') {
      if (cmRole) {
        // Explicitly denied for Campaign Manager (Financial authority restricted to Peak Admin)
        baseStaff.push({
          id: cmRole.id,
          allow: 0n,
          deny: combinePermissions([PermissionFlagsBits.ViewChannel])
        });
      }
      return baseStaff;
    }
  }

  // Inherit category overwrites by default
  return null;
}
