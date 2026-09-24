import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AdminAuditService } from '../src/modules/admin/audit.service.js';
import { AdminAuditRepository } from '../src/modules/admin/audit.repository.js';

describe('Admin Audit Trail & Immutability', () => {
  test('repository is strictly append-only and exposes no update or delete methods', () => {
    const repo = new AdminAuditRepository({});

    assert.equal(typeof repo.recordEvent, 'function');
    assert.equal(typeof repo.listEvents, 'function');

    // Immutability invariant: zero update or delete methods
    assert.equal(repo.updateEvent, undefined);
    assert.equal(repo.deleteEvent, undefined);
    assert.equal(repo.modifyEvent, undefined);
    assert.equal(repo.removeEvent, undefined);
  });

  test('audit service appends and retrieves structured audit events', async () => {
    const storage = [];

    const mockRepo = {
      async recordEvent(params) {
        const record = {
          id: `audit_${storage.length + 1}`,
          ...params,
          createdAt: new Date()
        };
        storage.push(record);
        return record;
      },
      async listEvents({ entityType, entityId, page = 1, limit = 20 } = {}) {
        let list = storage;
        if (entityType) list = list.filter((e) => e.entityType === entityType);
        if (entityId) list = list.filter((e) => e.entityId === entityId);
        return {
          items: list.slice((page - 1) * limit, page * limit),
          total: list.length,
          page,
          totalPages: 1
        };
      }
    };

    const service = new AdminAuditService(mockRepo);

    await service.logAction({
      actorDiscordId: 'staff_1',
      action: 'CAMPAIGN_CREATE',
      entityType: 'CAMPAIGN',
      entityId: 'cmp_100',
      newState: { name: 'New Campaign' }
    });

    await service.logAction({
      actorDiscordId: 'staff_2',
      action: 'SUBMISSION_APPROVE',
      entityType: 'SUBMISSION',
      entityId: 'sub_200',
      reason: 'Approved on review'
    });

    // Query all
    const all = await service.getAuditTrail();
    assert.equal(all.total, 2);

    // Filter by entityType
    const campEvents = await service.getAuditTrail({ entityType: 'CAMPAIGN' });
    assert.equal(campEvents.total, 1);
    assert.equal(campEvents.items[0].action, 'CAMPAIGN_CREATE');
    assert.equal(campEvents.items[0].entityId, 'cmp_100');
  });
});
