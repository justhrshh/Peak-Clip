import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import {
  AdminRole,
  AdminPermission,
  resolveAdminRoles,
  hasPermission,
  assertAdminPermission
} from '../src/modules/admin/admin.auth.js';
import {
  UnauthorizedAdminActionError,
  InsufficientPermissionError
} from '../src/modules/admin/admin.errors.js';

describe('Admin Authorization & Role Resolution', () => {
  const customConfig = {
    adminRoleIds: ['role_admin_123'],
    campaignManagerRoleIds: ['role_cm_456']
  };

  test('resolves ADMIN role for user with Guild Administrator permission only when adminFromDiscordAdministrator is true', () => {
    const interaction = {
      member: {
        permissions: PermissionsBitField.Flags.Administrator,
        roles: []
      }
    };

    // Disabled by default
    const rolesDisabled = resolveAdminRoles(interaction, { ...customConfig, adminFromDiscordAdministrator: false });
    assert.deepEqual(rolesDisabled, []);

    // Enabled explicitly
    const rolesEnabled = resolveAdminRoles(interaction, { ...customConfig, adminFromDiscordAdministrator: true });
    assert.deepEqual(rolesEnabled, [AdminRole.ADMIN]);
  });

  test('resolves ADMIN role for user holding configured admin role snowflake', () => {
    const interaction = {
      member: {
        permissions: 0n,
        roles: ['role_admin_123', 'some_other_role']
      }
    };

    const roles = resolveAdminRoles(interaction, customConfig);
    assert.ok(roles.includes(AdminRole.ADMIN));
  });

  test('resolves CAMPAIGN_MANAGER role for user holding configured CM role snowflake', () => {
    const interaction = {
      member: {
        permissions: 0n,
        roles: ['role_cm_456']
      }
    };

    const roles = resolveAdminRoles(interaction, customConfig);
    assert.deepEqual(roles, [AdminRole.CAMPAIGN_MANAGER]);
  });

  test('resolves empty roles for user with Peak Admin or Campaign Manager role names if IDs do not match', () => {
    const interaction = {
      member: {
        permissions: 0n,
        roles: {
          cache: [
            { id: 'random_id_1', name: 'Peak Admin' },
            { id: 'random_id_2', name: 'Campaign Manager' }
          ]
        }
      }
    };

    const roles = resolveAdminRoles(interaction, customConfig);
    assert.deepEqual(roles, []);
  });

  test('resolves empty roles for creator without staff permissions', () => {
    const interaction = {
      member: {
        permissions: 0n,
        roles: ['regular_creator_role']
      }
    };

    const roles = resolveAdminRoles(interaction, customConfig);
    assert.deepEqual(roles, []);
  });

  test('hasPermission validates role permissions accurately', () => {
    // Admin has everything
    assert.equal(hasPermission([AdminRole.ADMIN], AdminPermission.CAMPAIGN_CREATE), true);
    assert.equal(hasPermission([AdminRole.ADMIN], AdminPermission.PAYOUT_APPROVE), true);
    assert.equal(hasPermission([AdminRole.ADMIN], AdminPermission.PAYOUT_PROCESS), true);

    // Campaign Manager has campaign & submission permissions
    assert.equal(hasPermission([AdminRole.CAMPAIGN_MANAGER], AdminPermission.CAMPAIGN_CREATE), true);
    assert.equal(hasPermission([AdminRole.CAMPAIGN_MANAGER], AdminPermission.SUBMISSION_APPROVE), true);
    assert.equal(hasPermission([AdminRole.CAMPAIGN_MANAGER], AdminPermission.PAYOUT_VIEW), true);

    // Campaign Manager strictly DENIED financial approval and disbursement
    assert.equal(hasPermission([AdminRole.CAMPAIGN_MANAGER], AdminPermission.PAYOUT_APPROVE), false);
    assert.equal(hasPermission([AdminRole.CAMPAIGN_MANAGER], AdminPermission.PAYOUT_REJECT), false);
    assert.equal(hasPermission([AdminRole.CAMPAIGN_MANAGER], AdminPermission.PAYOUT_PROCESS), false);

    // Empty roles denied all
    assert.equal(hasPermission([], AdminPermission.CAMPAIGN_CREATE), false);
  });

  test('assertAdminPermission succeeds for authorized roles and throws for unauthorized roles', () => {
    const adminInteraction = { member: { permissions: 0n, roles: ['role_admin_123'] } };
    const cmInteraction = { member: { permissions: 0n, roles: ['role_cm_456'] } };
    const creatorInteraction = { member: { permissions: 0n, roles: ['creator_role'] } };

    // Admin passes
    assert.doesNotThrow(() =>
      assertAdminPermission(adminInteraction, AdminPermission.PAYOUT_APPROVE, customConfig)
    );

    // Campaign Manager passes campaign operations
    assert.doesNotThrow(() =>
      assertAdminPermission(cmInteraction, AdminPermission.CAMPAIGN_EDIT, customConfig)
    );

    // Campaign Manager denied payout approval (throws InsufficientPermissionError)
    assert.throws(
      () => assertAdminPermission(cmInteraction, AdminPermission.PAYOUT_APPROVE, customConfig),
      InsufficientPermissionError
    );

    // Creator denied all admin actions (throws UnauthorizedAdminActionError)
    assert.throws(
      () => assertAdminPermission(creatorInteraction, AdminPermission.CAMPAIGN_VIEW, customConfig),
      UnauthorizedAdminActionError
    );
  });
});
