import { AppError } from '../../utils/errors.js';

export class BaseDisbursementProvider {
  /**
   * @param {string} name - Provider identifier (e.g. 'MANUAL', 'STRIPE')
   */
  constructor(name) {
    if (this.constructor === BaseDisbursementProvider) {
      throw new Error('BaseDisbursementProvider is abstract and cannot be instantiated directly');
    }
    this.name = name;
  }

  /**
   * Initiate a disbursement attempt
   * @param {object} params
   * @param {string} params.payoutRequestId
   * @param {import('@prisma/client').Prisma.Decimal} params.amount
   * @param {string} params.currency
   * @param {object} [params.metadata]
   * @returns {Promise<{ status: 'PENDING'|'PROCESSING'|'COMPLETED'|'FAILED', providerReference: string, metadata?: object, failureReason?: string }>}
   */
  async createDisbursement(params) {
    throw new AppError(`createDisbursement not implemented for provider ${this.name}`, 'NOT_IMPLEMENTED', 501);
  }

  /**
   * Fetch current disbursement status from the provider
   * @param {string} providerReference
   * @returns {Promise<{ status: 'PENDING'|'PROCESSING'|'COMPLETED'|'FAILED', metadata?: object, failureReason?: string }>}
   */
  async getDisbursementStatus(providerReference) {
    throw new AppError(`getDisbursementStatus not implemented for provider ${this.name}`, 'NOT_IMPLEMENTED', 501);
  }

  /**
   * Cancel an in-flight disbursement if supported
   * @param {string} providerReference
   * @returns {Promise<{ cancelled: boolean, reason?: string }>}
   */
  async cancelDisbursement(providerReference) {
    throw new AppError(`cancelDisbursement not implemented for provider ${this.name}`, 'NOT_IMPLEMENTED', 501);
  }
}
