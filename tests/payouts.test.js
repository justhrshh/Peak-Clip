import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { PayoutService } from '../src/modules/payouts/payout.service.js';
import {
  InsufficientBalanceError,
  BelowMinimumPayoutError,
  InvalidPayoutStatusTransitionError,
  InactiveUserError,
  UnauthorizedPayoutAccessError,
  PayoutNotFoundError
} from '../src/modules/payouts/payout.errors.js';
import {
  validatePayoutTransition,
  isReservingStatus,
  isCompletedStatus,
  ALLOWED_PAYOUT_TRANSITIONS,
  RESERVING_PAYOUT_STATUSES
} from '../src/modules/payouts/payout.state-machine.js';
import {
  buildUserPayoutEmbed,
  buildPayoutSuccessEmbed
} from '../src/bot/embeds/payout.embeds.js';
import {
  buildPayoutActionRow,
  buildPayoutModal
} from '../src/bot/components/payout.components.js';

// In-memory mock repository for Payout engine tests
function createMockPayoutRepo() {
  const users = new Map();
  const campaigns = new Map();
  const earnings = new Map();
  const payoutRequests = new Map();
  const disbursements = new Map();
  const events = [];

  let reqIdCounter = 1;
  let disIdCounter = 1;
  let evtIdCounter = 1;

  const repo = {
    users,
    campaigns,
    earnings,
    payoutRequests,
    disbursements,
    events,

    async transaction(callback) {
      return callback(repo);
    },

    async getUserById(userId, tx = null) {
      return users.get(userId) || null;
    },

    async getPayoutBalanceBreakdown(userId, currency = 'USD', tx = null) {
      // 1. Sum ELIGIBLE earnings
      let eligibleEarnings = new Prisma.Decimal('0.00');
      for (const e of earnings.values()) {
        if (e.userId === userId && e.currency === currency && e.status === 'ELIGIBLE') {
          eligibleEarnings = eligibleEarnings.plus(new Prisma.Decimal(e.grossAmount));
        }
      }

      // 2. Sum RESERVED payouts
      let reservedBalance = new Prisma.Decimal('0.00');
      for (const pr of payoutRequests.values()) {
        if (pr.userId === userId && pr.currency === currency && RESERVING_PAYOUT_STATUSES.includes(pr.status)) {
          reservedBalance = reservedBalance.plus(new Prisma.Decimal(pr.amount));
        }
      }

      // 3. Sum COMPLETED payouts
      let completedPayouts = new Prisma.Decimal('0.00');
      for (const pr of payoutRequests.values()) {
        if (pr.userId === userId && pr.currency === currency && pr.status === 'COMPLETED') {
          completedPayouts = completedPayouts.plus(new Prisma.Decimal(pr.amount));
        }
      }

      // 4. Calculate Available Balance
      let availableBalance = eligibleEarnings.minus(reservedBalance).minus(completedPayouts);
      if (availableBalance.lessThan(0)) {
        availableBalance = new Prisma.Decimal('0.00');
      }

      // 5. Minimum payout resolution from user's earned campaigns
      let minimumPayout = new Prisma.Decimal('10.00');
      const userCampIds = new Set();
      for (const e of earnings.values()) {
        if (e.userId === userId && e.currency === currency && e.status !== 'VOIDED') {
          userCampIds.add(e.campaignId);
        }
      }

      for (const cid of userCampIds) {
        const camp = campaigns.get(cid);
        if (camp?.minimumPayout) {
          const campMin = new Prisma.Decimal(camp.minimumPayout);
          if (campMin.greaterThan(minimumPayout)) {
            minimumPayout = campMin;
          }
        }
      }

      return {
        eligibleEarnings: eligibleEarnings.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
        netAdjustments: new Prisma.Decimal('0.00'),
        reservedBalance: reservedBalance.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
        completedPayouts: completedPayouts.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
        availableBalance: availableBalance.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
        minimumPayout: minimumPayout.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
        currency
      };
    },

    async createPayoutRequest(data, tx = null) {
      const id = `pr_${reqIdCounter++}`;
      const record = {
        id,
        ...data,
        amount: new Prisma.Decimal(data.amount),
        requestedAt: new Date(),
        updatedAt: new Date(),
        disbursements: [],
        events: []
      };
      payoutRequests.set(id, record);
      return record;
    },

    async recordPayoutEvent(data, tx = null) {
      const id = `evt_${evtIdCounter++}`;
      const record = {
        id,
        ...data,
        createdAt: new Date()
      };
      events.push(record);
      const pr = payoutRequests.get(data.payoutRequestId);
      if (pr) {
        pr.events.push(record);
      }
      return record;
    },

    async getPayoutRequestById(payoutRequestId, tx = null) {
      const pr = payoutRequests.get(payoutRequestId);
      if (!pr) return null;
      const user = users.get(pr.userId);
      const prDisbursements = Array.from(disbursements.values())
        .filter((d) => d.payoutRequestId === payoutRequestId)
        .sort((a, b) => b.createdAt - a.createdAt);
      const prEvents = events.filter((e) => e.payoutRequestId === payoutRequestId);

      return {
        ...pr,
        user: user ? { id: user.id, discordId: user.discordId, username: user.username, status: user.status } : null,
        disbursements: prDisbursements,
        events: prEvents
      };
    },

    async updatePayoutRequest(payoutRequestId, data, tx = null) {
      const pr = payoutRequests.get(payoutRequestId);
      if (!pr) throw new Error(`Payout request ${payoutRequestId} not found`);
      const updated = {
        ...pr,
        ...data,
        amount: data.amount ? new Prisma.Decimal(data.amount) : pr.amount,
        updatedAt: new Date()
      };
      payoutRequests.set(payoutRequestId, updated);
      return updated;
    },

    async getUserPayoutRequests(userId) {
      return Array.from(payoutRequests.values())
        .filter((p) => p.userId === userId)
        .map((pr) => {
          const prDisbursements = Array.from(disbursements.values()).filter((d) => d.payoutRequestId === pr.id);
          const prEvents = events.filter((e) => e.payoutRequestId === pr.id);
          return {
            ...pr,
            disbursements: prDisbursements,
            events: prEvents
          };
        })
        .sort((a, b) => b.requestedAt - a.requestedAt);
    },

    async listPayoutRequests(filter = {}) {
      let list = Array.from(payoutRequests.values());
      if (filter.status) {
        list = list.filter((p) => p.status === filter.status);
      }
      if (filter.userId) {
        list = list.filter((p) => p.userId === filter.userId);
      }
      return list.map((pr) => {
        const user = users.get(pr.userId);
        const prDisbursements = Array.from(disbursements.values()).filter((d) => d.payoutRequestId === pr.id);
        return {
          ...pr,
          user: user ? { id: user.id, discordId: user.discordId, username: user.username } : null,
          disbursements: prDisbursements.slice(0, 1)
        };
      });
    },

    async createDisbursement(data, tx = null) {
      const id = `dis_${disIdCounter++}`;
      const record = {
        id,
        ...data,
        amount: new Prisma.Decimal(data.amount),
        createdAt: new Date(),
        updatedAt: new Date()
      };
      disbursements.set(id, record);
      const pr = payoutRequests.get(data.payoutRequestId);
      if (pr) {
        pr.disbursements.unshift(record);
      }
      return record;
    },

    async updateDisbursement(disbursementId, data, tx = null) {
      const dis = disbursements.get(disbursementId);
      if (!dis) throw new Error(`Disbursement ${disbursementId} not found`);
      const updated = {
        ...dis,
        ...data,
        updatedAt: new Date()
      };
      disbursements.set(disbursementId, updated);
      return updated;
    }
  };

  return repo;
}

describe('Payout Balance Derivation & Accounting Invariants', () => {
  test('correctly calculates available balance when no payouts exist', async () => {
    const repo = createMockPayoutRepo();
    const service = new PayoutService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.earnings.set('e1', { id: 'e1', userId: 'u1', campaignId: 'c1', grossAmount: '50.00', currency: 'USD', status: 'ELIGIBLE' });
    repo.earnings.set('e2', { id: 'e2', userId: 'u1', campaignId: 'c1', grossAmount: '25.50', currency: 'USD', status: 'ELIGIBLE' });

    const balance = await service.getAvailablePayoutBalance('u1', 'USD');
    assert.equal(balance.eligibleEarnings.toFixed(2), '75.50');
    assert.equal(balance.reservedBalance.toFixed(2), '0.00');
    assert.equal(balance.completedPayouts.toFixed(2), '0.00');
    assert.equal(balance.availableBalance.toFixed(2), '75.50');
    assert.equal(balance.minimumPayout.toFixed(2), '10.00');
  });

  test('reserves balance for active payout requests (REQUESTED, UNDER_REVIEW, APPROVED, PROCESSING)', async () => {
    const repo = createMockPayoutRepo();
    const service = new PayoutService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.earnings.set('e1', { id: 'e1', userId: 'u1', campaignId: 'c1', grossAmount: '100.00', currency: 'USD', status: 'ELIGIBLE' });

    // 1. REQUESTED status reserves $20
    repo.payoutRequests.set('pr1', { id: 'pr1', userId: 'u1', currency: 'USD', amount: new Prisma.Decimal('20.00'), status: 'REQUESTED' });
    let balance = await service.getAvailablePayoutBalance('u1', 'USD');
    assert.equal(balance.availableBalance.toFixed(2), '80.00');
    assert.equal(balance.reservedBalance.toFixed(2), '20.00');

    // 2. Transition pr1 to UNDER_REVIEW still reserves $20
    repo.payoutRequests.set('pr1', { id: 'pr1', userId: 'u1', currency: 'USD', amount: new Prisma.Decimal('20.00'), status: 'UNDER_REVIEW' });
    balance = await service.getAvailablePayoutBalance('u1', 'USD');
    assert.equal(balance.availableBalance.toFixed(2), '80.00');

    // 3. Add pr2 in APPROVED status for $30 -> total reserved = $50, available = $50
    repo.payoutRequests.set('pr2', { id: 'pr2', userId: 'u1', currency: 'USD', amount: new Prisma.Decimal('30.00'), status: 'APPROVED' });
    balance = await service.getAvailablePayoutBalance('u1', 'USD');
    assert.equal(balance.reservedBalance.toFixed(2), '50.00');
    assert.equal(balance.availableBalance.toFixed(2), '50.00');

    // 4. pr2 in PROCESSING status still reserves $30
    repo.payoutRequests.set('pr2', { id: 'pr2', userId: 'u1', currency: 'USD', amount: new Prisma.Decimal('30.00'), status: 'PROCESSING' });
    balance = await service.getAvailablePayoutBalance('u1', 'USD');
    assert.equal(balance.reservedBalance.toFixed(2), '50.00');
    assert.equal(balance.availableBalance.toFixed(2), '50.00');
  });

  test('released statuses (REJECTED, CANCELLED, FAILED) release the balance reservation', async () => {
    const repo = createMockPayoutRepo();
    const service = new PayoutService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.earnings.set('e1', { id: 'e1', userId: 'u1', campaignId: 'c1', grossAmount: '100.00', currency: 'USD', status: 'ELIGIBLE' });

    // pr1 CANCELLED -> $0 reserved
    repo.payoutRequests.set('pr1', { id: 'pr1', userId: 'u1', currency: 'USD', amount: new Prisma.Decimal('25.00'), status: 'CANCELLED' });
    // pr2 REJECTED -> $0 reserved
    repo.payoutRequests.set('pr2', { id: 'pr2', userId: 'u1', currency: 'USD', amount: new Prisma.Decimal('35.00'), status: 'REJECTED' });
    // pr3 FAILED -> $0 reserved
    repo.payoutRequests.set('pr3', { id: 'pr3', userId: 'u1', currency: 'USD', amount: new Prisma.Decimal('15.00'), status: 'FAILED' });

    const balance = await service.getAvailablePayoutBalance('u1', 'USD');
    assert.equal(balance.reservedBalance.toFixed(2), '0.00');
    assert.equal(balance.completedPayouts.toFixed(2), '0.00');
    assert.equal(balance.availableBalance.toFixed(2), '100.00');
  });

  test('COMPLETED status permanently consumes balance without double-deducting', async () => {
    const repo = createMockPayoutRepo();
    const service = new PayoutService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.earnings.set('e1', { id: 'e1', userId: 'u1', campaignId: 'c1', grossAmount: '100.00', currency: 'USD', status: 'ELIGIBLE' });

    // One completed payout for $40, one active requested payout for $20
    repo.payoutRequests.set('pr1', { id: 'pr1', userId: 'u1', currency: 'USD', amount: new Prisma.Decimal('40.00'), status: 'COMPLETED' });
    repo.payoutRequests.set('pr2', { id: 'pr2', userId: 'u1', currency: 'USD', amount: new Prisma.Decimal('20.00'), status: 'REQUESTED' });

    const balance = await service.getAvailablePayoutBalance('u1', 'USD');
    assert.equal(balance.eligibleEarnings.toFixed(2), '100.00');
    assert.equal(balance.completedPayouts.toFixed(2), '40.00');
    assert.equal(balance.reservedBalance.toFixed(2), '20.00');
    assert.equal(balance.availableBalance.toFixed(2), '40.00'); // 100 - 40 - 20 = 40
  });

  test('ineligible earnings (PENDING, VOIDED) are strictly excluded from available balance', async () => {
    const repo = createMockPayoutRepo();
    const service = new PayoutService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.earnings.set('e1', { id: 'e1', userId: 'u1', campaignId: 'c1', grossAmount: '50.00', currency: 'USD', status: 'ELIGIBLE' });
    repo.earnings.set('e2', { id: 'e2', userId: 'u1', campaignId: 'c1', grossAmount: '30.00', currency: 'USD', status: 'PENDING' });
    repo.earnings.set('e3', { id: 'e3', userId: 'u1', campaignId: 'c1', grossAmount: '20.00', currency: 'USD', status: 'VOIDED' });

    const balance = await service.getAvailablePayoutBalance('u1', 'USD');
    assert.equal(balance.eligibleEarnings.toFixed(2), '50.00');
    assert.equal(balance.availableBalance.toFixed(2), '50.00');
  });

  test('minimum payout resolves dynamically to highest campaign threshold creator earned in', async () => {
    const repo = createMockPayoutRepo();
    const service = new PayoutService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.campaigns.set('c1', { id: 'c1', minimumPayout: '15.00' });
    repo.campaigns.set('c2', { id: 'c2', minimumPayout: '25.00' });

    repo.earnings.set('e1', { id: 'e1', userId: 'u1', campaignId: 'c1', grossAmount: '50.00', currency: 'USD', status: 'ELIGIBLE' });
    repo.earnings.set('e2', { id: 'e2', userId: 'u1', campaignId: 'c2', grossAmount: '50.00', currency: 'USD', status: 'ELIGIBLE' });

    const balance = await service.getAvailablePayoutBalance('u1', 'USD');
    assert.equal(balance.minimumPayout.toFixed(2), '25.00');
  });

  test('currency isolation prevents foreign currency contamination', async () => {
    const repo = createMockPayoutRepo();
    const service = new PayoutService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.earnings.set('e1', { id: 'e1', userId: 'u1', campaignId: 'c1', grossAmount: '100.00', currency: 'EUR', status: 'ELIGIBLE' });
    repo.earnings.set('e2', { id: 'e2', userId: 'u1', campaignId: 'c1', grossAmount: '40.00', currency: 'USD', status: 'ELIGIBLE' });

    const usdBalance = await service.getAvailablePayoutBalance('u1', 'USD');
    assert.equal(usdBalance.availableBalance.toFixed(2), '40.00');

    const eurBalance = await service.getAvailablePayoutBalance('u1', 'EUR');
    assert.equal(eurBalance.availableBalance.toFixed(2), '100.00');
  });
});

describe('Payout Request Creation & Pre-flight Validation', () => {
  test('creates payout request when user has sufficient available balance', async () => {
    const repo = createMockPayoutRepo();
    const service = new PayoutService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.earnings.set('e1', { id: 'e1', userId: 'u1', campaignId: 'c1', grossAmount: '50.00', currency: 'USD', status: 'ELIGIBLE' });

    const payout = await service.createPayoutRequest('u1', '25.00', 'USD');
    assert.ok(payout.id);
    assert.equal(payout.amount.toFixed(2), '25.00');
    assert.equal(payout.status, 'REQUESTED');

    // Verify event was logged
    assert.equal(repo.events.length, 1);
    assert.equal(repo.events[0].type, 'REQUESTED');
    assert.equal(repo.events[0].actorUserId, 'u1');

    // Verify remaining available balance is now 25.00
    const balance = await service.getAvailablePayoutBalance('u1', 'USD');
    assert.equal(balance.availableBalance.toFixed(2), '25.00');
    assert.equal(balance.reservedBalance.toFixed(2), '25.00');
  });

  test('throws InsufficientBalanceError when requested amount exceeds available balance', async () => {
    const repo = createMockPayoutRepo();
    const service = new PayoutService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.earnings.set('e1', { id: 'e1', userId: 'u1', campaignId: 'c1', grossAmount: '20.00', currency: 'USD', status: 'ELIGIBLE' });

    await assert.rejects(
      () => service.createPayoutRequest('u1', '50.00', 'USD'),
      (err) => {
        assert.ok(err instanceof InsufficientBalanceError);
        assert.equal(err.code, 'INSUFFICIENT_BALANCE');
        return true;
      }
    );
  });

  test('throws BelowMinimumPayoutError when requested amount is below threshold', async () => {
    const repo = createMockPayoutRepo();
    const service = new PayoutService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.earnings.set('e1', { id: 'e1', userId: 'u1', campaignId: 'c1', grossAmount: '50.00', currency: 'USD', status: 'ELIGIBLE' });

    // Minimum payout is default $10.00, user requests $5.00
    await assert.rejects(
      () => service.createPayoutRequest('u1', '5.00', 'USD'),
      (err) => {
        assert.ok(err instanceof BelowMinimumPayoutError);
        assert.equal(err.code, 'BELOW_MINIMUM_PAYOUT');
        return true;
      }
    );
  });

  test('rejects zero or negative amounts with validation errors', async () => {
    const repo = createMockPayoutRepo();
    const service = new PayoutService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.earnings.set('e1', { id: 'e1', userId: 'u1', campaignId: 'c1', grossAmount: '50.00', currency: 'USD', status: 'ELIGIBLE' });

    await assert.rejects(() => service.createPayoutRequest('u1', '0.00', 'USD'));
    await assert.rejects(() => service.createPayoutRequest('u1', '-10.00', 'USD'));
    await assert.rejects(() => service.createPayoutRequest('u1', 'invalid', 'USD'));
  });

  test('throws InactiveUserError when user is suspended or banned', async () => {
    const repo = createMockPayoutRepo();
    const service = new PayoutService(repo);

    repo.users.set('u_suspended', { id: 'u_suspended', status: 'SUSPENDED' });
    repo.earnings.set('e1', { id: 'e1', userId: 'u_suspended', campaignId: 'c1', grossAmount: '50.00', currency: 'USD', status: 'ELIGIBLE' });

    await assert.rejects(
      () => service.createPayoutRequest('u_suspended', '20.00', 'USD'),
      (err) => {
        assert.ok(err instanceof InactiveUserError);
        assert.equal(err.code, 'INACTIVE_USER');
        return true;
      }
    );

    repo.users.set('u_banned', { id: 'u_banned', status: 'BANNED' });
    repo.earnings.set('e2', { id: 'e2', userId: 'u_banned', campaignId: 'c1', grossAmount: '50.00', currency: 'USD', status: 'ELIGIBLE' });

    await assert.rejects(
      () => service.createPayoutRequest('u_banned', '20.00', 'USD'),
      (err) => {
        assert.ok(err instanceof InactiveUserError);
        return true;
      }
    );
  });

  test('concurrency: sequential requests properly deplete available balance preventing double spend', async () => {
    const repo = createMockPayoutRepo();
    const service = new PayoutService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.earnings.set('e1', { id: 'e1', userId: 'u1', campaignId: 'c1', grossAmount: '50.00', currency: 'USD', status: 'ELIGIBLE' });

    // Request 1: $30.00 (allowed, leaves $20.00)
    const p1 = await service.createPayoutRequest('u1', '30.00', 'USD');
    assert.equal(p1.amount.toFixed(2), '30.00');

    // Request 2: $30.00 (fails because only $20.00 is available now)
    await assert.rejects(
      () => service.createPayoutRequest('u1', '30.00', 'USD'),
      InsufficientBalanceError
    );

    // Request 3: $20.00 (allowed, consumes remaining)
    const p3 = await service.createPayoutRequest('u1', '20.00', 'USD');
    assert.equal(p3.amount.toFixed(2), '20.00');

    // Balance is now 0.00
    const finalBalance = await service.getAvailablePayoutBalance('u1', 'USD');
    assert.equal(finalBalance.availableBalance.toFixed(2), '0.00');
    assert.equal(finalBalance.reservedBalance.toFixed(2), '50.00');
  });
});

describe('Payout State Machine Transitions', () => {
  test('creator can cancel own payout when in REQUESTED status', async () => {
    const repo = createMockPayoutRepo();
    const service = new PayoutService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.earnings.set('e1', { id: 'e1', userId: 'u1', campaignId: 'c1', grossAmount: '50.00', currency: 'USD', status: 'ELIGIBLE' });

    const pr = await service.createPayoutRequest('u1', '25.00', 'USD');
    assert.equal(pr.status, 'REQUESTED');

    const cancelled = await service.cancelPayoutRequest('u1', pr.id, 'Changed my mind');
    assert.equal(cancelled.status, 'CANCELLED');

    // Verify balance reservation was released
    const balance = await service.getAvailablePayoutBalance('u1', 'USD');
    assert.equal(balance.availableBalance.toFixed(2), '50.00');
    assert.equal(balance.reservedBalance.toFixed(2), '0.00');

    // Verify audit event
    const event = repo.events.find((e) => e.type === 'CANCELLED');
    assert.ok(event);
    assert.equal(event.actorUserId, 'u1');
    assert.equal(event.metadata.reason, 'Changed my mind');
  });

  test('staff review workflow: REQUESTED -> UNDER_REVIEW -> APPROVED / REJECTED', async () => {
    const repo = createMockPayoutRepo();
    const service = new PayoutService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.earnings.set('e1', { id: 'e1', userId: 'u1', campaignId: 'c1', grossAmount: '100.00', currency: 'USD', status: 'ELIGIBLE' });

    const pr1 = await service.createPayoutRequest('u1', '30.00', 'USD');
    const underReview = await service.reviewPayoutRequest(pr1.id, 'admin_1', 'Starting review');
    assert.equal(underReview.status, 'UNDER_REVIEW');

    const approved = await service.approvePayoutRequest(pr1.id, 'admin_1');
    assert.equal(approved.status, 'APPROVED');

    // pr2: REQUESTED -> REJECTED directly by staff
    const pr2 = await service.createPayoutRequest('u1', '20.00', 'USD');
    const rejected = await service.rejectPayoutRequest(pr2.id, 'admin_1', 'Suspicious activity');
    assert.equal(rejected.status, 'REJECTED');

    // Check that rejected released the reservation
    const balance = await service.getAvailablePayoutBalance('u1', 'USD');
    assert.equal(balance.reservedBalance.toFixed(2), '30.00'); // only approved pr1 remains reserved
    assert.equal(balance.availableBalance.toFixed(2), '70.00');
  });

  test('invalid status transitions are strictly prevented', async () => {
    const repo = createMockPayoutRepo();
    const service = new PayoutService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.earnings.set('e1', { id: 'e1', userId: 'u1', campaignId: 'c1', grossAmount: '100.00', currency: 'USD', status: 'ELIGIBLE' });

    const pr = await service.createPayoutRequest('u1', '30.00', 'USD');

    // Cannot jump from REQUESTED directly to COMPLETED
    await assert.rejects(
      () => service.markDisbursementCompleted(pr.id),
      InvalidPayoutStatusTransitionError
    );

    // Cancel pr
    await service.cancelPayoutRequest('u1', pr.id);

    // Terminal state CANCELLED cannot transition to anything
    await assert.rejects(
      () => service.reviewPayoutRequest(pr.id, 'admin_1'),
      InvalidPayoutStatusTransitionError
    );
  });

  test('state machine utility matrix functions accurately', () => {
    assert.doesNotThrow(() => validatePayoutTransition('REQUESTED', 'UNDER_REVIEW'));
    assert.doesNotThrow(() => validatePayoutTransition('REQUESTED', 'CANCELLED'));
    assert.doesNotThrow(() => validatePayoutTransition('REQUESTED', 'REJECTED'));
    assert.doesNotThrow(() => validatePayoutTransition('UNDER_REVIEW', 'APPROVED'));
    assert.doesNotThrow(() => validatePayoutTransition('UNDER_REVIEW', 'REJECTED'));
    assert.doesNotThrow(() => validatePayoutTransition('APPROVED', 'PROCESSING'));
    assert.doesNotThrow(() => validatePayoutTransition('APPROVED', 'CANCELLED'));
    assert.doesNotThrow(() => validatePayoutTransition('PROCESSING', 'COMPLETED'));
    assert.doesNotThrow(() => validatePayoutTransition('PROCESSING', 'FAILED'));
    assert.doesNotThrow(() => validatePayoutTransition('FAILED', 'PROCESSING'));

    // Invalid transitions throw InvalidPayoutStatusTransitionError
    assert.throws(() => validatePayoutTransition('COMPLETED', 'PROCESSING'), InvalidPayoutStatusTransitionError);
    assert.throws(() => validatePayoutTransition('REJECTED', 'REQUESTED'), InvalidPayoutStatusTransitionError);
    assert.throws(() => validatePayoutTransition('REQUESTED', 'COMPLETED'), InvalidPayoutStatusTransitionError);
    assert.throws(() => validatePayoutTransition('UNDER_REVIEW', 'COMPLETED'), InvalidPayoutStatusTransitionError);

    // Reserving statuses
    assert.equal(isReservingStatus('REQUESTED'), true);
    assert.equal(isReservingStatus('UNDER_REVIEW'), true);
    assert.equal(isReservingStatus('APPROVED'), true);
    assert.equal(isReservingStatus('PROCESSING'), true);
    assert.equal(isReservingStatus('COMPLETED'), false);
    assert.equal(isReservingStatus('REJECTED'), false);
    assert.equal(isReservingStatus('CANCELLED'), false);
    assert.equal(isReservingStatus('FAILED'), false);

    // Completed status
    assert.equal(isCompletedStatus('COMPLETED'), true);
    assert.equal(isCompletedStatus('PROCESSING'), false);
  });
});

describe('Disbursement Provider Execution & Error Handling', () => {
  test('manual disbursement provider completes payout and logs disbursement record', async () => {
    const repo = createMockPayoutRepo();
    const service = new PayoutService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.earnings.set('e1', { id: 'e1', userId: 'u1', campaignId: 'c1', grossAmount: '100.00', currency: 'USD', status: 'ELIGIBLE' });

    const pr = await service.createPayoutRequest('u1', '50.00', 'USD');
    await service.reviewPayoutRequest(pr.id, 'admin_1');
    await service.approvePayoutRequest(pr.id, 'admin_1');

    // Initiate disbursement (moves to PROCESSING)
    const { payoutRequest: processingPr, disbursement } = await service.processDisbursement(pr.id, 'MANUAL');
    assert.equal(processingPr.status, 'PROCESSING');
    assert.ok(disbursement.id);
    assert.equal(disbursement.provider, 'MANUAL');
    assert.ok(disbursement.providerReference.startsWith('man_'));

    // Complete disbursement
    const completedPr = await service.markDisbursementCompleted(pr.id);
    assert.equal(completedPr.status, 'COMPLETED');
    assert.ok(completedPr.completedAt);

    // Check accounting: $50 completed, $0 reserved, $50 available
    const balance = await service.getAvailablePayoutBalance('u1', 'USD');
    assert.equal(balance.completedPayouts.toFixed(2), '50.00');
    assert.equal(balance.reservedBalance.toFixed(2), '0.00');
    assert.equal(balance.availableBalance.toFixed(2), '50.00');
  });

  test('handles provider failure gracefully, sets status to FAILED and releases reservation', async () => {
    const repo = createMockPayoutRepo();
    const service = new PayoutService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.earnings.set('e1', { id: 'e1', userId: 'u1', campaignId: 'c1', grossAmount: '100.00', currency: 'USD', status: 'ELIGIBLE' });

    const pr = await service.createPayoutRequest('u1', '50.00', 'USD');
    await service.reviewPayoutRequest(pr.id, 'admin_1');
    await service.approvePayoutRequest(pr.id, 'admin_1');
    await service.processDisbursement(pr.id, 'MANUAL');

    // Mark failed
    const failedPr = await service.markDisbursementFailed(pr.id, 'Simulated bank network failure');
    assert.equal(failedPr.status, 'FAILED');

    // Since FAILED is not a reserving status, the $50 is released back to available balance
    const balance = await service.getAvailablePayoutBalance('u1', 'USD');
    assert.equal(balance.reservedBalance.toFixed(2), '0.00');
    assert.equal(balance.completedPayouts.toFixed(2), '0.00');
    assert.equal(balance.availableBalance.toFixed(2), '100.00');
  });

  test('allows retrying a FAILED payout request back to PROCESSING and COMPLETED', async () => {
    const repo = createMockPayoutRepo();
    const service = new PayoutService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.earnings.set('e1', { id: 'e1', userId: 'u1', campaignId: 'c1', grossAmount: '100.00', currency: 'USD', status: 'ELIGIBLE' });

    const pr = await service.createPayoutRequest('u1', '50.00', 'USD');
    await service.reviewPayoutRequest(pr.id, 'admin_1');
    await service.approvePayoutRequest(pr.id, 'admin_1');
    await service.processDisbursement(pr.id, 'MANUAL');
    await service.markDisbursementFailed(pr.id, 'Temporary outage');

    // Retry disbursement
    const { payoutRequest: retriedPr } = await service.processDisbursement(pr.id, 'MANUAL');
    assert.equal(retriedPr.status, 'PROCESSING');

    const completedPr = await service.markDisbursementCompleted(pr.id);
    assert.equal(completedPr.status, 'COMPLETED');

    const balance = await service.getAvailablePayoutBalance('u1', 'USD');
    assert.equal(balance.completedPayouts.toFixed(2), '50.00');
    assert.equal(balance.availableBalance.toFixed(2), '50.00');
  });

  test('idempotency: completing already completed payout throws InvalidPayoutStatusTransitionError', async () => {
    const repo = createMockPayoutRepo();
    const service = new PayoutService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.earnings.set('e1', { id: 'e1', userId: 'u1', campaignId: 'c1', grossAmount: '100.00', currency: 'USD', status: 'ELIGIBLE' });

    const pr = await service.createPayoutRequest('u1', '50.00', 'USD');
    await service.reviewPayoutRequest(pr.id, 'admin_1');
    await service.approvePayoutRequest(pr.id, 'admin_1');
    await service.processDisbursement(pr.id, 'MANUAL');
    await service.markDisbursementCompleted(pr.id);

    // Try completing again
    await assert.rejects(
      () => service.markDisbursementCompleted(pr.id),
      InvalidPayoutStatusTransitionError
    );
  });
});

describe('Security & Creator Scoping', () => {
  test('creator cannot cancel another creators payout request', async () => {
    const repo = createMockPayoutRepo();
    const service = new PayoutService(repo);

    repo.users.set('u1', { id: 'u1', status: 'ACTIVE' });
    repo.users.set('u2', { id: 'u2', status: 'ACTIVE' });
    repo.earnings.set('e1', { id: 'e1', userId: 'u1', campaignId: 'c1', grossAmount: '50.00', currency: 'USD', status: 'ELIGIBLE' });

    const pr = await service.createPayoutRequest('u1', '25.00', 'USD');

    // u2 tries to cancel u1's request
    await assert.rejects(
      () => service.cancelPayoutRequest('u2', pr.id),
      (err) => {
        assert.ok(err instanceof UnauthorizedPayoutAccessError);
        assert.equal(err.code, 'UNAUTHORIZED_PAYOUT_ACCESS');
        return true;
      }
    );
  });

  test('non-existent payout request throws PayoutNotFoundError', async () => {
    const repo = createMockPayoutRepo();
    const service = new PayoutService(repo);

    await assert.rejects(
      () => service.approvePayoutRequest('non_existent', 'admin_1'),
      PayoutNotFoundError
    );
  });
});

describe('Discord Embeds & Interactive Components', () => {
  test('renders user payout dashboard embed with formatted balances and history', () => {
    const balance = {
      availableBalance: new Prisma.Decimal('75.25'),
      reservedBalance: new Prisma.Decimal('20.00'),
      completedPayouts: new Prisma.Decimal('150.00'),
      minimumPayout: new Prisma.Decimal('10.00'),
      currency: 'USD'
    };
    const history = [
      {
        id: 'pr_1234567890',
        amount: new Prisma.Decimal('50.00'),
        currency: 'USD',
        status: 'COMPLETED',
        requestedAt: new Date('2026-09-15T12:00:00Z')
      }
    ];

    const embed = buildUserPayoutEmbed(balance, history, { username: 'TestCreator' });
    assert.ok(embed.data.title.includes('Payout Dashboard'));
    assert.equal(embed.data.color, 0x57f287);

    // Verify fields contain financial metrics
    const balanceField = embed.data.fields.find((f) => f.name.includes('Payout Balances'));
    assert.ok(balanceField.value.includes('$75.25'));
    assert.ok(balanceField.value.includes('$20.00'));
    assert.ok(balanceField.value.includes('$150.00'));

    const minField = embed.data.fields.find((f) => f.name.includes('Minimum Payout Requirement'));
    assert.ok(minField.value.includes('$10.00'));

    const historyField = embed.data.fields.find((f) => f.name.includes('Recent Payout Requests'));
    assert.ok(historyField.value.includes('COMPLETED'));
    assert.ok(historyField.value.includes('$50.00'));
  });

  test('action row disables Request Payout button when ineligible', () => {
    const row = buildPayoutActionRow('u1', false);
    const reqBtn = row.components.find((c) => c.data.custom_id.startsWith('payout_request_btn'));
    assert.ok(reqBtn);
    assert.equal(reqBtn.data.disabled, true);
  });

  test('action row enables Request Payout button when eligible', () => {
    const row = buildPayoutActionRow('u1', true);
    const reqBtn = row.components.find((c) => c.data.custom_id.startsWith('payout_request_btn'));
    assert.ok(reqBtn);
    assert.equal(reqBtn.data.disabled, false);
  });

  test('builds modal with proper customId and max limit label', () => {
    const modal = buildPayoutModal('u1', '125.50', 'USD');
    assert.equal(modal.data.custom_id, 'payout_modal:u1');
    assert.ok(modal.data.title.includes('USD'));
  });

  test('renders payout success embed with request metadata', () => {
    const payout = {
      id: 'pr_success_99',
      amount: new Prisma.Decimal('45.00'),
      currency: 'USD',
      status: 'REQUESTED'
    };

    const embed = buildPayoutSuccessEmbed(payout, { username: 'TestCreator' });
    assert.ok(embed.data.title.includes('Payout Request Submitted'));
    assert.equal(embed.data.color, 0x57f287);
    assert.ok(embed.data.description.includes('$45.00'));

    const idField = embed.data.fields.find((f) => f.name === 'Request ID');
    assert.ok(idField.value.includes('pr_success_99'));

    const statusField = embed.data.fields.find((f) => f.name === 'Status');
    assert.ok(statusField.value.includes('REQUESTED'));
  });
});
