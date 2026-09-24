import { DEFAULT_VERIFICATION_POLICY } from './policy.js';

/**
 * Deterministically assess risk level from observed verification signals using a configurable policy
 *
 * Scoring Methodology:
 * - Score is an anomaly index bounded between 0.00 and 1.00.
 * - Represents cumulative signal deviation from standard organic clip engagement.
 * - Not a mathematical probability of fraud.
 *
 * Risk Tiers:
 * - LOW_RISK: Minor or zero flags; eligible for standard approval consideration.
 * - REVIEW_REQUIRED: Moderate flags or single high-severity signal; human review recommended.
 * - HIGH_RISK: Substantial anomalies; flagged for priority review.
 *
 * @param {Array<{ type: string, severity: 'INFO'|'LOW'|'MEDIUM'|'HIGH'|'CRITICAL', explanation: string }>} signals
 * @param {object} [policy=DEFAULT_VERIFICATION_POLICY] - Configurable policy with severity weights and thresholds
 * @returns {{ riskLevel: 'LOW_RISK'|'REVIEW_REQUIRED'|'HIGH_RISK', score: number, primaryReasons: string[] }}
 */
export function assessVerificationRisk(signals = [], policy = DEFAULT_VERIFICATION_POLICY) {
  if (!signals || signals.length === 0) {
    return {
      riskLevel: 'LOW_RISK',
      score: 0.0,
      primaryReasons: ['No anomalous engagement signals detected. Observed metrics conform to expected baselines.']
    };
  }

  const weights = policy.severityWeights || DEFAULT_VERIFICATION_POLICY.severityWeights;
  const thresholds = policy.riskThresholds || DEFAULT_VERIFICATION_POLICY.riskThresholds;

  let rawScore = policy.baseScore ?? 0.05;
  let criticalCount = 0;
  let highCount = 0;
  let mediumCount = 0;

  for (const signal of signals) {
    const weight = weights[signal.severity] ?? 0;
    rawScore += weight;

    if (signal.severity === 'CRITICAL') criticalCount++;
    else if (signal.severity === 'HIGH') highCount++;
    else if (signal.severity === 'MEDIUM') mediumCount++;
  }

  const score = Math.min(1.0, Number(rawScore.toFixed(2)));

  let riskLevel = 'LOW_RISK';
  if (
    score >= thresholds.highRiskScore ||
    criticalCount >= thresholds.highRiskCriticalSignalCount ||
    highCount >= thresholds.highRiskHighScoreCount
  ) {
    riskLevel = 'HIGH_RISK';
  } else if (
    score >= thresholds.reviewRequiredScore ||
    highCount >= thresholds.reviewRequiredHighScoreCount ||
    mediumCount >= thresholds.reviewRequiredMediumScoreCount
  ) {
    riskLevel = 'REVIEW_REQUIRED';
  }

  // Extract top explanatory reasons sorted by signal severity
  const severityRank = { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 };
  const sortedSignals = [...signals].sort(
    (a, b) => (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0)
  );

  const primaryReasons = sortedSignals.slice(0, 3).map((s) => `[${s.severity}] ${s.explanation}`);

  return {
    riskLevel,
    score,
    primaryReasons
  };
}
