import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { AdminPayoutService } from '../src/modules/admin/admin.payout.service.js';
import { PayoutService } from '../src/modules/payouts/payout.service.js';
import {
  AdminRole,
  AdminPermission,
  hasPermission
} from '../src/modules/admin/admin.auth.js';

function createMockPayoutEnvironment() {
  const payoutRequests = new Map();
  const disbursements = new Map();
  const payoutEvents = [];
  const auditEvents = [];

  let disCounter = 1;

  const payoutRepo = {
    async transaction(cb) {
      return cb(payoutRepo);
    },
    async acquirePayoutRequestLock() {},
    async getPayoutRequestById(id) {
      const pr = payoutRequests.get(id);
      if (!pr) return null;
      const prDis = Array.from(disbursements.values()).filter((d) => d.payoutRequestId === id);
      return { ...pr, disbursements: prDis };
    },
    async updatePayoutRequest(id, data) {
      const pr = payoutRequests.get(id);
      if (!pr) throw new Error('Not found');
      const updated = { ...pr, ...data, updatedAt: new Date() };
      payoutRequests.set(id, updated);
      return updated;
    },
    async listPayoutRequests(filter = {}) {
      let list = Array.from(payoutRequests.values());
      if (filter.status) list = list.filter((p) => p.status === filter.status);
      return list;
    },
    async recordPayoutEvent(event) {
      payoutEvents.push(event);
    },
    async createDisbursement(data) {
      const id = `dis_${disCounter++}`;
      const record = { id, ...data, createdAt: new Date() };
      disbursements.set(id, record);
      return record;
    },
    async updateDisbursement(id, data) {
      const dis = disbursements.get(id);
      if (!dis) throw new Error('Not found');
      const updated = { ...dis, ...data, updatedAt: new Date() };
      disbursements.set(id, updated);
      return updated;
    }
  };

  const fakeProvider = {
    name: 'MANUAL',
    async createDisbursement({ payoutRequestId }) {
      return {
        providerReference: `man_ref_${payoutRequestId}`,
        status: 'PROCESSING'
      };
    }
  };

  const corePayoutService = new PayoutService(payoutRepo, () => fakeProvider);

  const auditService = {
    async logAction(event) {
      auditEvents.push(event);
      return event;
    }
  };

  const adminPayoutService = new AdminPayoutService(corePayoutService, auditService);

  return {
    payoutRequests,
    disbursements,
    payoutEvents,
    auditEvents,
    adminPayoutService
  };
}

describe('Admin Payout Queue & Financial Operations', () => {
  const actor = { discordId: 'admin_finance_1', userId: 'usr_fin' };

  test('permission separation: Campaign Manager is denied payout approve/reject/process', () => {
    assert.equal(hasPermission([AdminRole.CAMPAIGN_MANAGER], AdminPermission.PAYOUT_VIEW), true);
    assert.equal(hasPermission([AdminRole.CAMPAIGN_MANAGER], AdminPermission.PAYOUT_APPROVE), false);
    assert.equal(hasPermission([AdminRole.CAMPAIGN_MANAGER], AdminPermission.PAYOUT_REJECT), false);
    assert.equal(hasPermission([AdminRole.CAMPAIGN_MANAGER], AdminPermission.PAYOUT_PROCESS), false);

    assert.equal(hasPermission([AdminRole.ADMIN], AdminPermission.PAYOUT_APPROVE), true);
    assert.equal(hasPermission([AdminRole.ADMIN], AdminPermission.PAYOUT_PROCESS), true);
  });

  test('approves, processes, and completes payout request with audit logging', async () => {
    const env = createMockPayoutEnvironment();

    env.payoutRequests.set('pr_1', {
      id: 'pr_1',
      userId: 'creator_1',
      amount: new Prisma.Decimal('100.00'),
      currency: 'USD',
      status: 'UNDER_REVIEW'
    });

    // 1. Approve
    const approved = await env.adminPayoutService.approvePayout('pr_1', actor);
    assert.equal(approved.status, 'APPROVED');

    const approveAudit = env.auditEvents.find((e) => e.action === 'PAYOUT_APPROVE');
    assert.ok(approveAudit);
    assert.equal(approveAudit.entityId, 'pr_1');

    // 2. Process disbursement
    const processed = await env.adminPayoutService.processDisbursement('pr_1', actor, 'MANUAL');
    assert.equal(processed.payoutRequest.status, 'PROCESSING');
    assert.equal(processed.disbursement.providerReference, 'man_ref_pr_1');

    const processAudit = env.auditEvents.find((e) => e.action === 'PAYOUT_PROCESS');
    assert.ok(processAudit);

    // 3. Mark completed
    const completed = await env.adminPayoutService.completeDisbursement('pr_1', actor, 'BANK_WIRE_777');
    assert.equal(completed.status, 'COMPLETED');

    const completeAudit = env.auditEvents.find((e) => e.action === 'PAYOUT_COMPLETE');
    assert.ok(completeAudit);
  });

  test('rejecting payout updates status and records audit event', async () => {
    const env = createMockPayoutEnvironment();

    env.payoutRequests.set('pr_2', {
      id: 'pr_2',
      userId: 'creator_2',
      amount: new Prisma.Decimal('50.00'),
      currency: 'USD',
      status: 'UNDER_REVIEW'
    });

    const rejected = await env.adminPayoutService.rejectPayout('pr_2', actor, 'Account verification mismatch');
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.rejectionReason, 'Account verification mismatch');

    const rejectAudit = env.auditEvents.find((e) => e.action === 'PAYOUT_REJECT');
    assert.ok(rejectAudit);
    assert.equal(rejectAudit.reason, 'Account verification mismatch');
  });
});
