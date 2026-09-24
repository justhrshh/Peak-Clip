import { ChannelType } from 'discord.js';

/**
 * Standard Role Names for Peak Clip DEV
 */
export const ROLE_NAMES = Object.freeze({
  PEAK_ADMIN: 'Peak Admin',
  CAMPAIGN_MANAGER: 'Campaign Manager',
  CREATOR: 'Creator',
  PEAK_CLIP_BOT: 'Peak Clip' // Discord-managed bot integration role
});

/**
 * Roles to be created and managed by the provisioning subsystem
 * Note: The bot role is dynamically resolved from the guild's managed integration role,
 * NOT created as a duplicate role.
 */
export const ROLES_DEFINITION = Object.freeze([
  {
    key: 'PEAK_ADMIN',
    name: ROLE_NAMES.PEAK_ADMIN,
    color: 0xe74c3c, // Red
    hoist: true,
    mentionable: false,
    description: 'Full administrative operations and financial authority'
  },
  {
    key: 'CAMPAIGN_MANAGER',
    name: ROLE_NAMES.CAMPAIGN_MANAGER,
    color: 0x3498db, // Blue
    hoist: true,
    mentionable: false,
    description: 'Operational staff managing campaigns, creators, and submission reviews'
  },
  {
    key: 'CREATOR',
    name: ROLE_NAMES.CREATOR,
    color: 0x2ecc71, // Green
    hoist: true,
    mentionable: false,
    description: 'Verified content creators submitting clips and tracking earnings'
  }
]);

/**
 * Category and Channel Definitions
 */
export const SERVER_STRUCTURE = Object.freeze([
  {
    category: 'INFORMATION',
    channels: [
      {
        name: 'rules',
        type: ChannelType.GuildText,
        topic: 'Community guidelines and clipping submission terms.'
      },
      {
        name: 'announcements',
        type: ChannelType.GuildText,
        topic: 'Official Peak Clip campaign and platform announcements.'
      }
    ]
  },
  {
    category: 'CREATOR',
    channels: [
      {
        name: 'dashboard',
        type: ChannelType.GuildText,
        topic: 'Peak Clip Creator Center — private creator workspace and control hub.'
      },
      {
        name: 'campaigns',
        type: ChannelType.GuildText,
        topic: 'Browse active campaigns, rates, and requirements.'
      },
      {
        name: 'submissions',
        type: ChannelType.GuildText,
        topic: 'Submit clips and review your submitted content status.'
      },
      {
        name: 'stats',
        type: ChannelType.GuildText,
        topic: 'Check verified views, clip performance, and analytics.'
      },
      {
        name: 'earnings',
        type: ChannelType.GuildText,
        topic: 'Review verified earnings and available balance.'
      },
      {
        name: 'payouts',
        type: ChannelType.GuildText,
        topic: 'Manage payout profile, request disbursements, and review history.'
      }
    ]
  },
  {
    category: 'STAFF',
    channels: [
      {
        name: 'dashboard',
        type: ChannelType.GuildText,
        topic: 'Staff Control Center and campaign operations overview.'
      },
      {
        name: 'review-queue',
        type: ChannelType.GuildText,
        topic: 'Staff queue for manual submission verification and flagged clips.'
      },
      {
        name: 'creators',
        type: ChannelType.GuildText,
        topic: 'Creator management, onboarding status, and member controls.'
      },
      {
        name: 'campaign-management',
        type: ChannelType.GuildText,
        topic: 'Create, update, activate, and manage campaign lifecycles.'
      },
      {
        name: 'payout-queue',
        type: ChannelType.GuildText,
        topic: 'Financial staff queue for review, approval, and disbursement tracking.'
      },
      {
        name: 'audit-log',
        type: ChannelType.GuildText,
        topic: 'Immutable audit log of staff actions and state changes.'
      }
    ]
  },
  {
    category: 'SYSTEM',
    channels: [
      {
        name: 'bot-status',
        type: ChannelType.GuildText,
        topic: 'Peak Clip Bot health, heartbeat, and polling system status.'
      },
      {
        name: 'bot-errors',
        type: ChannelType.GuildText,
        topic: 'Automated error alerts, rate limits, and diagnostic logs.'
      }
    ]
  }
]);

/**
 * Total expected count of categories, channels, and active roles
 */
export const EXPECTED_COUNTS = Object.freeze({
  roles: ROLES_DEFINITION.length + 1, // 3 created staff/creator roles + 1 managed bot role = 4
  categories: SERVER_STRUCTURE.length,
  channels: SERVER_STRUCTURE.reduce((acc, cat) => acc + cat.channels.length, 0)
});
