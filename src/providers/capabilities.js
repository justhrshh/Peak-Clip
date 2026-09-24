/**
 * Centralized Provider Capability Matrix
 *
 * Exposes explicit capability contracts per platform so verification and polling
 * engines do not rely on hardcoded platform assumptions.
 */

export const PLATFORM_CAPABILITIES = Object.freeze({
  YOUTUBE: Object.freeze({
    fetchViews: true,
    fetchLikes: true,
    fetchComments: true,
    fetchShares: false,
    fetchDuration: true,
    checkAvailability: true,
    historicalMetrics: false,
    authenticatedMetrics: false
  }),
  TIKTOK: Object.freeze({
    fetchViews: true,
    fetchLikes: true,
    fetchComments: true,
    fetchShares: true,
    fetchDuration: true,
    checkAvailability: true,
    historicalMetrics: false,
    authenticatedMetrics: false
  }),
  INSTAGRAM: Object.freeze({
    fetchViews: true,
    fetchLikes: true,
    fetchComments: true,
    fetchShares: false,
    fetchDuration: false,
    checkAvailability: true,
    historicalMetrics: false,
    authenticatedMetrics: true
  }),
  FACEBOOK: Object.freeze({
    fetchViews: true,
    fetchLikes: true,
    fetchComments: true,
    fetchShares: true,
    fetchDuration: true,
    checkAvailability: true,
    historicalMetrics: false,
    authenticatedMetrics: true
  })

});

/**
 * Check whether a platform supports a specific capability
 * @param {string} platform - e.g. 'YOUTUBE', 'TIKTOK', 'INSTAGRAM', 'FACEBOOK'
 * @param {string} capability - e.g. 'fetchViews', 'fetchLikes', 'fetchDuration'
 * @returns {boolean}
 */
export function hasProviderCapability(platform, capability) {
  const normalized = platform ? platform.toUpperCase() : '';
  const caps = PLATFORM_CAPABILITIES[normalized];
  if (!caps) return false;
  return Boolean(caps[capability]);
}

/**
 * Get full capabilities object for a platform
 * @param {string} platform
 * @returns {object}
 */
export function getProviderCapabilities(platform) {
  const normalized = platform ? platform.toUpperCase() : '';
  return PLATFORM_CAPABILITIES[normalized] || Object.freeze({
    fetchViews: false,
    fetchLikes: false,
    fetchComments: false,
    fetchShares: false,
    fetchDuration: false,
    checkAvailability: false,
    historicalMetrics: false,
    authenticatedMetrics: false
  });
}
