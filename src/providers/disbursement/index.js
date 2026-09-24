import { manualDisbursementProvider } from './manual/manual.disbursement.provider.js';
import { AppError } from '../../utils/errors.js';

const providers = {
  MANUAL: manualDisbursementProvider
};

/**
 * Resolve disbursement provider by name
 * @param {string} [name='MANUAL']
 * @returns {import('./base.disbursement.provider.js').BaseDisbursementProvider}
 */
export function getDisbursementProvider(name = 'MANUAL') {
  const upper = (name || 'MANUAL').toUpperCase();
  const provider = providers[upper];
  if (!provider) {
    throw new AppError(`Unsupported disbursement provider: ${name}`, 'UNSUPPORTED_PROVIDER', 400);
  }
  return provider;
}
