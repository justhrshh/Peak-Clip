import { Prisma } from '@prisma/client';
import { prisma } from '../../database/client.js';
import { RESERVING_PAYOUT_STATUSES } from './payout.state-machine.js';

export class PayoutRepository {
  constructor(dbClient = prisma) {
    this.prisma = dbClient;
  }

  /**
   * Execute callback inside an atomic interactive transaction
   * @param {function(object): Promise<any>} callback
   * @returns {Promise<any>}
   */
  async transaction(callback) {
    return this.prisma.$transaction(callback);
  }

  /**
   * Acquire PostgreSQL transactional advisory lock for user payout balance derivation and reservation.
   * Eliminates concurrent request double-spending.
   * @param {string} userId
   * @param {object} [tx=null]
   */
  async acquireUserPayoutLock(userId, tx = null) {
    const client = tx || this.prisma;
    if (client?.$executeRaw) {
      try {
        await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'payout_balance_' + userId}))`;
      } catch {
        // Transparent fallback in non-Postgres environments
      }
    }
  }

  /**
   * Acquire PostgreSQL transactional advisory lock for payout request disbursement execution.
   * Eliminates concurrent disbursement processing.
   * @param {string} payoutRequestId
   * @param {object} [tx=null]
   */
  async acquirePayoutRequestLock(payoutRequestId, tx = null) {
    const client = tx || this.prisma;
    if (client?.$executeRaw) {
      try {
        await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'payout_disburse_' + payoutRequestId}))`;
      } catch {
        // Transparent fallback in non-Postgres environments
      }
    }
  }

  /**
   * Fetch user by ID
   * @param {string} userId
   * @param {object} [tx=null]
   * @returns {Promise<object|null>}
   */
  async getUserById(userId, tx = null) {
    const client = tx || this.prisma;
    return client.user.findUnique({
      where: { id: userId }
    });
  }

  /**
   * Authoritatively derive available balance and reservations from the ledger
   *
   * Accounting Formula:
   * availableBalance = eligibleEarnings - reservedBalance - completedPayouts
   *
   * @param {string} userId
   * @param {string} [currency='USD']
   * @param {object} [tx=null]
   * @returns {Promise<{ eligibleEarnings: Prisma.Decimal, reservedBalance: Prisma.Decimal, completedPayouts: Prisma.Decimal, availableBalance: Prisma.Decimal, minimumPayout: Prisma.Decimal, currency: string }>}
   */
  async getPayoutBalanceBreakdown(userId, currency = 'USD', tx = null) {
    const client = tx || this.prisma;

    // 1. Eligible Earnings in this currency
    const earningsAgg = await client.earning.aggregate({
      where: {
        userId,
        currency,
        status: 'ELIGIBLE'
      },
      _sum: {
        grossAmount: true
      }
    });
    const eligibleEarnings = earningsAgg._sum.grossAmount
      ? new Prisma.Decimal(earningsAgg._sum.grossAmount)
      : new Prisma.Decimal('0.00');

    // 2. Financial Adjustments (e.g. retention policy violations)
    let netAdjustments = new Prisma.Decimal('0.00');
    if (client.financialAdjustment) {
      const adjustmentsAgg = await client.financialAdjustment.aggregate({
        where: {
          userId,
          currency
        },
        _sum: {
          amount: true
        }
      });
      if (adjustmentsAgg._sum.amount) {
        netAdjustments = new Prisma.Decimal(adjustmentsAgg._sum.amount);
      }
    }

    // 3. Reserved Payouts (active non-terminal requests)
    const reservedAgg = await client.payoutRequest.aggregate({
      where: {
        userId,
        currency,
        status: { in: [...RESERVING_PAYOUT_STATUSES] }
      },
      _sum: {
        amount: true
      }
    });
    const reservedBalance = reservedAgg._sum.amount
      ? new Prisma.Decimal(reservedAgg._sum.amount)
      : new Prisma.Decimal('0.00');

    // 4. Completed Payouts (permanently disbursed funds)
    const completedAgg = await client.payoutRequest.aggregate({
      where: {
        userId,
        currency,
        status: 'COMPLETED'
      },
      _sum: {
        amount: true
      }
    });
    const completedPayouts = completedAgg._sum.amount
      ? new Prisma.Decimal(completedAgg._sum.amount)
      : new Prisma.Decimal('0.00');

    // 5. Derive Available Balance (factoring in net adjustments)
    let availableBalance = eligibleEarnings.plus(netAdjustments).minus(reservedBalance).minus(completedPayouts);
    if (availableBalance.lessThan(0)) {
      availableBalance = new Prisma.Decimal('0.00');
    }

    // 5. Determine applicable minimum payout based on campaigns creator has earned in
    const userCampaignEarnings = await client.earning.findMany({
      where: { userId, currency, status: { not: 'VOIDED' } },
      select: {
        campaign: {
          select: { minimumPayout: true }
        }
      },
      distinct: ['campaignId']
    });

    let minimumPayout = new Prisma.Decimal('10.00'); // Default baseline
    for (const item of userCampaignEarnings) {
      if (item.campaign?.minimumPayout) {
        const campMin = new Prisma.Decimal(item.campaign.minimumPayout);
        if (campMin.greaterThan(minimumPayout)) {
          minimumPayout = campMin;
        }
      }
    }

    return {
      eligibleEarnings: eligibleEarnings.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      netAdjustments: netAdjustments.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      reservedBalance: reservedBalance.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      completedPayouts: completedPayouts.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      availableBalance: availableBalance.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      minimumPayout: minimumPayout.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      currency
    };
  }

  /**
   * Create a new payout request
   * @param {object} data
   * @param {object} [tx=null]
   * @returns {Promise<object>}
   */
  async createPayoutRequest(data, tx = null) {
    const client = tx || this.prisma;
    return client.payoutRequest.create({
      data
    });
  }

  /**
   * Record an immutable payout lifecycle event
   * @param {object} data
   * @param {object} [tx=null]
   * @returns {Promise<object>}
   */
  async recordPayoutEvent(data, tx = null) {
    const client = tx || this.prisma;
    return client.payoutEvent.create({
      data
    });
  }

  /**
   * Fetch a payout request by ID
   * @param {string} payoutRequestId
   * @param {object} [tx=null]
   * @returns {Promise<object|null>}
   */
  async getPayoutRequestById(payoutRequestId, tx = null) {
    const client = tx || this.prisma;
    return client.payoutRequest.findUnique({
      where: { id: payoutRequestId },
      include: {
        user: {
          select: { id: true, discordId: true, username: true, displayName: true, status: true }
        },
        disbursements: {
          orderBy: { createdAt: 'desc' }
        },
        events: {
          orderBy: { createdAt: 'asc' }
        },
        evidence: {
          orderBy: { version: 'desc' }
        }
      }
    });
  }

  /**
   * Update payout request fields
   * @param {string} payoutRequestId
   * @param {object} data
   * @param {object} [tx=null]
   * @returns {Promise<object>}
   */
  async updatePayoutRequest(payoutRequestId, data, tx = null) {
    const client = tx || this.prisma;
    return client.payoutRequest.update({
      where: { id: payoutRequestId },
      data
    });
  }

  /**
   * Get all payout requests for a user
   * @param {string} userId
   * @returns {Promise<Array<object>>}
   */
  async getUserPayoutRequests(userId) {
    return this.prisma.payoutRequest.findMany({
      where: { userId },
      include: {
        disbursements: {
          orderBy: { createdAt: 'desc' }
        },
        events: {
          orderBy: { createdAt: 'asc' }
        },
        evidence: {
          orderBy: { version: 'desc' }
        }
      },
      orderBy: { requestedAt: 'desc' }
    });
  }

  /**
   * List payout requests for staff/admin review
   * @param {object} [filter={}]
   * @returns {Promise<Array<object>>}
   */
  async listPayoutRequests(filter = {}) {
    const { page, limit, ...where } = filter;
    const query = {
      where,
      include: {
        user: {
          select: { id: true, discordId: true, username: true, displayName: true, status: true }
        },
        evidence: {
          orderBy: { version: 'desc' },
          take: 1
        },
        disbursements: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      },
      orderBy: { requestedAt: 'desc' }
    };

    if (page && limit) {
      query.skip = (Math.max(1, page) - 1) * limit;
      query.take = limit;
    } else if (limit) {
      query.take = limit;
    }

    return this.prisma.payoutRequest.findMany(query);
  }

  /**
   * Create a disbursement record
   * @param {object} data
   * @param {object} [tx=null]
   * @returns {Promise<object>}
   */
  async createDisbursement(data, tx = null) {
    const client = tx || this.prisma;
    return client.disbursement.create({
      data
    });
  }

  /**
   * Update a disbursement record
   * @param {string} disbursementId
   * @param {object} data
   * @param {object} [tx=null]
   * @returns {Promise<object>}
   */
  async updateDisbursement(disbursementId, data, tx = null) {
    const client = tx || this.prisma;
    return client.disbursement.update({
      where: { id: disbursementId },
      data
    });
  }
}

export const payoutRepository = new PayoutRepository();
export default payoutRepository;
