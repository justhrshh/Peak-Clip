import { PermissionsBitField } from 'discord.js';
import { config } from '../../config/index.js';
import {
  UnauthorizedAdminActionError,
  InsufficientPermissionError
} from './admin.errors.js';

/**
 * Administrative Role Definitions
 */
export const AdminRole = Object.freeze({
  ADMIN: 'ADMIN',
  CAMPAIGN_MANAGER: 'CAMPAIGN_MANAGER'
});

/**
 * Granular Administrative Permissions
 */
export const AdminPermission = Object.freeze({
  // Campaign Lifecycle
  CAMPAIGN_CREATE: 'CAMPAIGN_CREATE',
  CAMPAIGN_EDIT: 'CAMPAIGN_EDIT',
  CAMPAIGN_ACTIVATE: 'CAMPAIGN_ACTIVATE',
  CAMPAIGN_PAUSE: 'CAMPAIGN_PAUSE',
  CAMPAIGN_END: 'CAMPAIGN_END',
  CAMPAIGN_ARCHIVE: 'CAMPAIGN_ARCHIVE',

  // Campaign Members
  MEMBER_VIEW: 'MEMBER_VIEW',
  MEMBER_REMOVE: 'MEMBER_REMOVE',
  MEMBER_REACTIVATE: 'MEMBER_REACTIVATE',

  // Creators
  CREATOR_VIEW: 'CREATOR_VIEW',
  CREATOR_STATUS_MANAGE: 'CREATOR_STATUS_MANAGE',

  // Submissions & Verification
  SUBMISSION_VIEW: 'SUBMISSION_VIEW',
  SUBMISSION_REVIEW: 'SUBMISSION_REVIEW',
  SUBMISSION_APPROVE: 'SUBMISSION_APPROVE',
  SUBMISSION_REJECT: 'SUBMISSION_REJECT',
  SUBMISSION_FLAG: 'SUBMISSION_FLAG',

  // Financial & Payouts (Restricted to ADMIN only)
  PAYOUT_VIEW: 'PAYOUT_VIEW',
  PAYOUT_APPROVE: 'PAYOUT_APPROVE',
  PAYOUT_REJECT: 'PAYOUT_REJECT',
  PAYOUT_PROCESS: 'PAYOUT_PROCESS',

  // Audit
  AUDIT_VIEW: 'AUDIT_VIEW'
});

/**
 * Server-Side Role-to-Permissions Mapping
 */
export const ROLE_PERMISSIONS = Object.freeze({
  [AdminRole.ADMIN]: Object.freeze(Object.values(AdminPermission)),
  [AdminRole.CAMPAIGN_MANAGER]: Object.freeze([
    AdminPermission.CAMPAIGN_CREATE,
    AdminPermission.CAMPAIGN_EDIT,
    AdminPermission.CAMPAIGN_ACTIVATE,
    AdminPermission.CAMPAIGN_PAUSE,
    AdminPermission.CAMPAIGN_END,
    AdminPermission.CAMPAIGN_ARCHIVE,
    AdminPermission.MEMBER_VIEW,
    AdminPermission.MEMBER_REMOVE,
    AdminPermission.MEMBER_REACTIVATE,
    AdminPermission.CREATOR_VIEW,
    AdminPermission.CREATOR_STATUS_MANAGE,
    AdminPermission.SUBMISSION_VIEW,
    AdminPermission.SUBMISSION_REVIEW,
    AdminPermission.SUBMISSION_APPROVE,
    AdminPermission.SUBMISSION_REJECT,
    AdminPermission.SUBMISSION_FLAG,
    AdminPermission.PAYOUT_VIEW,
    AdminPermission.AUDIT_VIEW
    // Strictly NO PAYOUT_APPROVE, PAYOUT_REJECT, PAYOUT_PROCESS
  ])
});

/**
 * Resolve administrative roles server-side from Discord interaction context
 *
 * Security Invariants:
 * 1. Never trusts Discord custom IDs, usernames, or client-provided booleans.
 * 2. Resolves membership directly from Discord guild member roles and administrator permissions.
 *
 * @param {object} interaction - Discord interaction or synthetic test context
 * @param {object} [customConfig=config.admin]
 * @returns {Array<string>} List of assigned AdminRole enum values
 */
export function resolveAdminRoles(interaction, customConfig = config?.admin) {
  if (!interaction) return [];

  // Direct role array passed (e.g. from unit test or programmatic caller)
  if (Array.isArray(interaction.roles)) {
    return interaction.roles.filter((r) => Object.values(AdminRole).includes(r));
  }

  const member = interaction.member;
  if (!member) return [];

  const roles = new Set();
  const adminRoleIds = customConfig?.adminRoleIds || [];
  const campaignManagerRoleIds = customConfig?.campaignManagerRoleIds || [];

  // 1. Guild Administrator permission grant full ADMIN
  if (member.permissions) {
    try {
      if (typeof member.permissions.has === 'function') {
        if (member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          roles.add(AdminRole.ADMIN);
        }
      } else if (typeof member.permissions === 'bigint' || typeof member.permissions === 'string') {
        const bitfield = new PermissionsBitField(member.permissions);
        if (bitfield.has(PermissionsBitField.Flags.Administrator)) {
          roles.add(AdminRole.ADMIN);
        }
      }
    } catch {
      // Ignore bitfield parse failures
    }
  }

  // 2. Resolve roles from Discord member role snowflake collection/array
  const memberRoleIds = new Set();
  if (member.roles) {
    if (Array.isArray(member.roles)) {
      for (const r of member.roles) memberRoleIds.add(typeof r === 'string' ? r : r.id);
    } else if (member.roles.cache && typeof member.roles.cache.has === 'function') {
      for (const id of member.roles.cache.keys()) memberRoleIds.add(id);
    }
  }

  for (const adminRoleId of adminRoleIds) {
    if (memberRoleIds.has(adminRoleId)) {
      roles.add(AdminRole.ADMIN);
    }
  }

  for (const cmRoleId of campaignManagerRoleIds) {
    if (memberRoleIds.has(cmRoleId)) {
      roles.add(AdminRole.CAMPAIGN_MANAGER);
    }
  }

  // 3. Fallback: match by canonical role names if present on member
  if (member.roles?.cache && typeof member.roles.cache.values === 'function') {
    for (const r of member.roles.cache.values()) {
      if (r.name === 'Peak Admin') {
        roles.add(AdminRole.ADMIN);
      } else if (r.name === 'Campaign Manager') {
        roles.add(AdminRole.CAMPAIGN_MANAGER);
      }
    }
  }

  return Array.from(roles);
}

/**
 * Check if a set of roles satisfies a required permission
 *
 * @param {Array<string>} userRoles
 * @param {string} permission
 * @returns {boolean}
 */
export function hasPermission(userRoles = [], permission) {
  if (!userRoles || userRoles.length === 0) return false;

  for (const role of userRoles) {
    const permissions = ROLE_PERMISSIONS[role] || [];
    if (permissions.includes(permission)) {
      return true;
    }
  }

  return false;
}

/**
 * Assert that the interaction user possesses the required permission
 * Throws domain error if unauthorized.
 *
 * @param {object} interaction
 * @param {string} permission
 * @param {object} [customConfig]
 * @returns {Array<string>} The verified roles
 */
export function assertAdminPermission(interaction, permission, customConfig = config?.admin) {
  const roles = resolveAdminRoles(interaction, customConfig);

  if (roles.length === 0) {
    throw new UnauthorizedAdminActionError(
      'You are not authorized to perform this administrative action. Staff role required.'
    );
  }

  if (!hasPermission(roles, permission)) {
    throw new InsufficientPermissionError(permission, roles);
  }

  return roles;
}
