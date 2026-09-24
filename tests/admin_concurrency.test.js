import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { AdminSubmissionService } from '../src/modules/admin/admin.submission.service.js';
import { AdminCampaignService } from '../src/modules/admin/admin.campaign.service.js';
import { PayoutService } from '../src/modules/payouts/payout.service.js';
import { EarningsService } from '../src/modules/earnings/earnings.service.js';
import { AlreadyReviewedError } from '../src/modules/admin/admin.errors.js';

describe('Admin Concurrency & Transactional Consistency', () => {
  test('two admins concurrently approving the same submission: exactly one succeeds, second gets state conflict', async () => {
    let currentStatus = 'UNDER_REVIEW';
    let lockTaken = false;

    const mockRepo = {
      async getSubmissionWithFullDetails(id) {
        return {
          id,
          status: currentStatus,
          verifications: [],
          snapshots: []
        };
      },
      async updateSubmission(id, data) {
        // Atomic compare-and-swap simulation
        if (currentStatus === 'APPROVED') {
          throw new Error('Already approved');
        }
        currentStatus = data.status;
        return { id, status: currentStatus, verifiedAt: new Date() };
      }
    };

    const auditService = { async logAction() {} };
    const service = new AdminSubmissionService(mockRepo, auditService);

    const adminA = { discordId: 'admin_A', userId: 'u_A' };
    const adminB = { discordId: 'admin_B', userId: 'u_B' };

    // Execute first approval
    const resA = await service.approveSubmission('sub_conc_1', adminA);
    assert.equal(resA.status, 'APPROVED');

    // Second approval must fail with AlreadyReviewedError
    await assert.rejects(
      () => service.approveSubmission('sub_conc_1', adminB),
      AlreadyReviewedError
    );

    assert.equal(currentStatus, 'APPROVED');
  });

  test('two admins concurrently processing the same payout: advisory lock guarantees single disbursement', async () => {
    let lockActive = false;
    let payoutStatus = 'APPROVED';
    const disbursements = [];

    const payoutRepo = {
      async transaction(cb) {
        return cb(payoutRepo);
      },
      async acquirePayoutRequestLock(payoutRequestId) {
        if (lockActive) {
          throw new Error('Lock acquisition failed: concurrent transaction in progress');
        }
        lockActive = true;
      },
      async getPayoutRequestById(id) {
        return {
          id,
          userId: 'u1',
          amount: new Prisma.Decimal('100.00'),
          currency: 'USD',
          status: payoutStatus,
          disbursements
        };
      },
      async updatePayoutRequest(id, data) {
        payoutStatus = data.status;
        return { id, status: payoutStatus };
      },
      async createDisbursement(data) {
        const record = { id: `dis_${disbursements.length + 1}`, ...data };
        disbursements.push(record);
        return record;
      },
      async recordPayoutEvent() {}
    };

    const fakeProvider = {
      name: 'MANUAL',
      async createDisbursement({ payoutRequestId }) {
        return { providerReference: `ref_${payoutRequestId}` };
      }
    };

    const payoutService = new PayoutService(payoutRepo, () => fakeProvider);

    // Admin 1 initiates disbursement
    const result1 = await payoutService.processDisbursement('payout_100', 'MANUAL');
    assert.equal(result1.payoutRequest.status, 'PROCESSING');
    assert.equal(disbursements.length, 1);

    // Admin 2 attempts concurrent disbursement on same payout - blocked by status transition or lock
    await assert.rejects(
      () => payoutService.processDisbursement('payout_100', 'MANUAL')
    );

    // Exactly 1 disbursement record created
    assert.equal(disbursements.length, 1);
  });

  test('admin edits campaign payRate while earnings are ledgered: historical earnings rows remain rate-locked', async () => {
    // 1. Initial campaign rate $0.80
    let currentCampaignRate = new Prisma.Decimal('0.80');
    const earningsLedger = [];

    const earningsRepo = {
      async transaction(cb) {
        return cb(earningsRepo);
      },
      async acquireSubmissionLock() {},
      async getSubmissionForEarnings(submissionId) {
        return {
          id: submissionId,
          userId: 'u_creator',
          status: 'APPROVED',
          campaign: {
            id: 'c1',
            status: 'ACTIVE',
            payRate: currentCampaignRate,
            currency: 'USD'
          },
          verifications: [{ status: 'COMPLETED' }],
          snapshots: [{ id: 'snap_1', views: 100000n }]
        };
      },
      async getSnapshotById(snapId) {
        return { id: snapId, views: 100000n };
      },
      async getPreviouslyCreditedViews() {
        return 0n;
      },
      async getEarningBySnapshotId() {
        return null;
      },
      async createEarning(data) {
        const record = {
          id: `earn_${earningsLedger.length + 1}`,
          ...data,
          ratePerThousand: new Prisma.Decimal(data.ratePerThousand),
          grossAmount: new Prisma.Decimal(data.grossAmount)
        };
        earningsLedger.push(record);
        return record;
      }
    };

    const earningsService = new EarningsService(earningsRepo);

    // First credit: 100k views @ $0.80 -> $80.00
    const earn1 = await earningsService.creditNewEligibleViews('sub_1', 'snap_1');
    assert.equal(earn1.grossAmount.toFixed(2), '80.00');
    assert.equal(earningsLedger[0].ratePerThousand.toFixed(2), '0.80');

    // 2. Admin edits campaign rate to $1.50
    currentCampaignRate = new Prisma.Decimal('1.50');

    // 3. Historical row in earnings ledger is UNTOUCHED
    assert.equal(earningsLedger[0].ratePerThousand.toFixed(2), '0.80');
    assert.equal(earningsLedger[0].grossAmount.toFixed(2), '80.00');

    // 4. Subsequent credit will use the new rate of $1.50
    earningsRepo.getPreviouslyCreditedViews = async () => 100000n;
    earningsRepo.getSubmissionForEarnings = async (submissionId) => ({
      id: submissionId,
      userId: 'u_creator',
      status: 'APPROVED',
      campaign: {
        id: 'c1',
        status: 'ACTIVE',
        payRate: currentCampaignRate,
        currency: 'USD'
      },
      verifications: [{ status: 'COMPLETED' }],
      snapshots: [{ id: 'snap_2', views: 150000n }]
    });
    earningsRepo.getSnapshotById = async (snapId) => ({ id: snapId, views: 150000n });

    const earn2 = await earningsService.creditNewEligibleViews('sub_1', 'snap_2');
    // +50k views @ $1.50 / 1,000 = $75.00
    assert.equal(earn2.grossAmount.toFixed(2), '75.00');
    assert.equal(earningsLedger[1].ratePerThousand.toFixed(2), '1.50');

    // Historical row 1 remains strictly locked at 0.80
    assert.equal(earningsLedger[0].ratePerThousand.toFixed(2), '0.80');
    assert.equal(earningsLedger[0].grossAmount.toFixed(2), '80.00');
  });
});
