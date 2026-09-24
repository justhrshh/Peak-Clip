import { BaseDisbursementProvider } from '../base.disbursement.provider.js';
import { logger } from '../../../utils/logger.js';

/**
 * Manual / Internal Disbursement Provider
 *
 * Provides deterministic simulation and manual disbursement tracking
 * without coupling payout accounting to external payment rails.
 * Does NOT move real money.
 */
export class ManualDisbursementProvider extends BaseDisbursementProvider {
  constructor() {
    super('MANUAL');
  }

  /**
   * Initiate manual disbursement record
   * @param {object} params
   * @param {string} params.payoutRequestId
   * @param {import('@prisma/client').Prisma.Decimal} params.amount
   * @param {string} params.currency
   * @param {object} [params.metadata]
   * @returns {Promise<{ status: 'PROCESSING', providerReference: string, metadata: object }>}
   */
  async createDisbursement({ payoutRequestId, amount, currency, metadata = {} }) {
    const providerReference = `man_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    logger.info(
      { payoutRequestId, amount: amount.toString(), currency, providerReference },
      'Manual disbursement initiated'
    );

    return {
      status: 'PROCESSING',
      providerReference,
      metadata: {
        mode: 'MANUAL_SIMULATION',
        initiatedAt: new Date().toISOString(),
        ...metadata
      }
    };
  }

  /**
   * Check status
   * @param {string} providerReference
   * @returns {Promise<{ status: 'PROCESSING', metadata: object }>}
   */
  async getDisbursementStatus(providerReference) {
    return {
      status: 'PROCESSING',
      metadata: {
        providerReference,
        checkedAt: new Date().toISOString()
      }
    };
  }

  /**
   * Cancel manual disbursement
   * @param {string} providerReference
   * @returns {Promise<{ cancelled: boolean }>}
   */
  async cancelDisbursement(providerReference) {
    logger.info({ providerReference }, 'Manual disbursement cancelled');
    return {
      cancelled: true
    };
  }
}

export const manualDisbursementProvider = new ManualDisbursementProvider();
export default manualDisbursementProvider;
