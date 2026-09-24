import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AdminCreatorService } from '../src/modules/admin/admin.creator.service.js';
import { UserService } from '../src/modules/users/user.service.js';
import { PayoutService } from '../src/modules/payouts/payout.service.js';
import {
  UserNotFoundError,
  UserSuspendedError,
  UserBannedError
} from '../src/modules/users/user.errors.js';
import { InactiveUserError } from '../src/modules/payouts/payout.errors.js';
import { InvalidAdminActionError } from '../src/modules/admin/admin.errors.js';

function createMockCreatorEnvironment() {
  const users = new Map();
  const memberships = new Map();
  const submissions = [];
  const payoutRequests = [];
  const auditEvents = [];

  const db = {
    user: {
      async findMany({ where, take }) {
        let list = Array.from(users.values());
        if (where?.OR) {
          list = list.filter((u) => {
            return where.OR.some((cond) => {
              if (cond.discordId && u.discordId === cond.discordId) return true;
              if (cond.username && u.username.toLowerCase().includes(cond.username.contains.toLowerCase())) return true;
              if (cond.displayName && u.displayName && u.displayName.toLowerCase().includes(cond.displayName.contains.toLowerCase())) return true;
              return false;
            });
          });
        }
        return list.slice(0, take);
      },
      async findFirst({ where }) {
        for (const u of users.values()) {
          if (where.OR) {
            for (const cond of where.OR) {
              if (cond.id && u.id === cond.id) return { ...u, campaignMemberships: [], _count: { submissions: 0, payoutRequests: 0 } };
              if (cond.discordId && u.discordId === cond.discordId) return { ...u, campaignMemberships: [], _count: { submissions: 0, payoutRequests: 0 } };
            }
          } else {
            if (where.id && u.id === where.id) return u;
            if (where.discordId && u.discordId === where.discordId) return u;
          }
        }
        return null;
      },
      async update({ where, data }) {
        const u = users.get(where.id);
        if (!u) throw new Error('User not found');
        const updated = { ...u, ...data, updatedAt: new Date() };
        users.set(where.id, updated);
        return updated;
      }
    },
    submission: {
      async groupBy({ by, where }) {
        const userSubs = submissions.filter((s) => s.userId === where.userId);
        const map = {};
        for (const s of userSubs) {
          map[s.status] = (map[s.status] || 0) + 1;
        }
        return Object.entries(map).map(([status, count]) => ({ status, _count: { id: count } }));
      }
    }
  };

  const auditService = {
    async logAction(event) {
      auditEvents.push(event);
      return event;
    }
  };

  const creatorService = new AdminCreatorService(db, auditService);
  const userService = new UserService({
    async findWithMemberships(id) {
      return users.get(id) || null;
    }
  });

  return {
    users,
    submissions,
    payoutRequests,
    auditEvents,
    creatorService,
    userService
  };
}

describe('Admin Creator Management & Operational Enforcement', () => {
  const actor = { discordId: 'staff_123', userId: 'staff_user_1' };

  test('searches creators by Discord ID and username', async () => {
    const env = createMockCreatorEnvironment();

    env.users.set('u1', {
      id: 'u1',
      discordId: '123456789012345678',
      username: 'top_clipper',
      displayName: 'Top Clipper',
      status: 'ACTIVE',
      createdAt: new Date(),
      lastSeenAt: new Date()
    });

    env.users.set('u2', {
      id: 'u2',
      discordId: '987654321098765432',
      username: 'other_user',
      displayName: 'Other',
      status: 'ACTIVE',
      createdAt: new Date(),
      lastSeenAt: new Date()
    });

    // Search by snowflake
    const res1 = await env.creatorService.searchCreators('123456789012345678');
    assert.equal(res1.length, 1);
    assert.equal(res1[0].username, 'top_clipper');

    // Search by username substring
    const res2 = await env.creatorService.searchCreators('clipper');
    assert.equal(res2.length, 1);
    assert.equal(res2[0].id, 'u1');

    // Search empty query
    const resEmpty = await env.creatorService.searchCreators('');
    assert.equal(resEmpty.length, 0);
  });

  test('updates creator status with audit logging and blocks platform actions on SUSPENDED/BANNED', async () => {
    const env = createMockCreatorEnvironment();

    env.users.set('u_target', {
      id: 'u_target',
      discordId: 'target_dc_id',
      username: 'target_user',
      displayName: 'Target User',
      status: 'ACTIVE',
      createdAt: new Date(),
      lastSeenAt: new Date()
    });

    // 1. Suspend creator
    const suspended = await env.creatorService.updateCreatorStatus(
      'u_target',
      'SUSPENDED',
      actor,
      'Suspected automated metric manipulation'
    );
    assert.equal(suspended.status, 'SUSPENDED');

    // Audit event logged
    const auditSuspend = env.auditEvents.find((e) => e.action === 'CREATOR_SUSPENDED');
    assert.ok(auditSuspend);
    assert.equal(auditSuspend.entityId, 'u_target');
    assert.equal(auditSuspend.reason, 'Suspected automated metric manipulation');

    // Participation assertion fails with UserSuspendedError
    assert.throws(
      () => env.userService.assertUserCanParticipate(env.users.get('u_target')),
      UserSuspendedError
    );

    // 2. Ban creator
    const banned = await env.creatorService.updateCreatorStatus('u_target', 'BANNED', actor, 'Confirmed fraud');
    assert.equal(banned.status, 'BANNED');

    // Participation assertion fails with UserBannedError
    assert.throws(
      () => env.userService.assertUserCanParticipate(env.users.get('u_target')),
      UserBannedError
    );

    // 3. Reinstate creator to ACTIVE
    const active = await env.creatorService.updateCreatorStatus('u_target', 'ACTIVE', actor, 'Appeal granted');
    assert.equal(active.status, 'ACTIVE');

    assert.doesNotThrow(() =>
      env.userService.assertUserCanParticipate(env.users.get('u_target'))
    );
  });

  test('rejects invalid status mutation', async () => {
    const env = createMockCreatorEnvironment();
    env.users.set('u1', { id: 'u1', discordId: 'dc1', username: 'usr', status: 'ACTIVE' });

    await assert.rejects(
      () => env.creatorService.updateCreatorStatus('u1', 'DELETED', actor),
      InvalidAdminActionError
    );
  });
});
