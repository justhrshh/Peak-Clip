/**
 * Verification Policy & Anomaly Detection Configuration
 *
 * NOTE:
 * These thresholds are operational heuristics designed to detect statistical
 * irregularities relative to organic clip baselines. They are NOT definitive
 * or scientifically proven fraud thresholds. Human review must always remain
 * possible.
 */
export const DEFAULT_VERIFICATION_POLICY = Object.freeze({
  // Velocity and trajectory analysis
  suddenGrowthMultiplier: 10,
  suddenGrowthMinGain: 5000,

  // Volume baseline for engagement ratios
  minimumViewsForRatioAnalysis: 1000,

  // Like-to-view ratio boundaries
  likeViewRatio: Object.freeze({
    low: 0.001, // 0.10% (1 like per 1,000 views)
    high: 0.50  // 50.0%
  }),

  // Comment volume rules
  commentViewRules: Object.freeze({
    minViewsForZeroCommentsWarning: 25000
  }),

  // Base anomaly risk score
  baseScore: 0.05,

  // Severity contribution weights to anomaly score index
  severityWeights: Object.freeze({
    INFO: 0.0,
    LOW: 0.05,
    MEDIUM: 0.15,
    HIGH: 0.35,
    CRITICAL: 0.60
  }),

  // Risk tier classification boundaries
  riskThresholds: Object.freeze({
    highRiskScore: 0.70,
    reviewRequiredScore: 0.30,
    highRiskCriticalSignalCount: 1,
    highRiskHighScoreCount: 2,
    reviewRequiredHighScoreCount: 1,
    reviewRequiredMediumScoreCount: 2
  })
});

/**
 * Resolve verification policy with optional custom/campaign overrides
 * Allows future extension for platform-specific and campaign-specific policies
 * without refactoring the analyzer.
 * @param {object} [customOverrides={}]
 * @returns {typeof DEFAULT_VERIFICATION_POLICY}
 */
export function resolveVerificationPolicy(customOverrides = {}) {
  if (!customOverrides || Object.keys(customOverrides).length === 0) {
    return DEFAULT_VERIFICATION_POLICY;
  }

  return {
    ...DEFAULT_VERIFICATION_POLICY,
    ...customOverrides,
    likeViewRatio: {
      ...DEFAULT_VERIFICATION_POLICY.likeViewRatio,
      ...(customOverrides.likeViewRatio || {})
    },
    commentViewRules: {
      ...DEFAULT_VERIFICATION_POLICY.commentViewRules,
      ...(customOverrides.commentViewRules || {})
    },
    severityWeights: {
      ...DEFAULT_VERIFICATION_POLICY.severityWeights,
      ...(customOverrides.severityWeights || {})
    },
    riskThresholds: {
      ...DEFAULT_VERIFICATION_POLICY.riskThresholds,
      ...(customOverrides.riskThresholds || {})
    }
  };
}
