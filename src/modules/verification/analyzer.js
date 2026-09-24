import { DEFAULT_VERIFICATION_POLICY } from './policy.js';

/**
 * Safe ratio division handling zero denominators and null/BigInt values
 * Explicitly distinguishes null/unavailable from 0
 * @param {bigint|number|null} numerator
 * @param {bigint|number|null} denominator
 * @returns {number|null}
 */
export function calculateRatio(numerator, denominator) {
  if (numerator === null || denominator === null || denominator === undefined || numerator === undefined) {
    return null;
  }
  const denomNum = Number(denominator);
  const numNum = Number(numerator);

  if (denomNum <= 0) return null;
  return Number((numNum / denomNum).toFixed(6));
}

/**
 * Calculate all engagement ratios for a metric snapshot
 * Respects explicit availability: if views are unavailable, no ratios are computed.
 * @param {object} snapshot
 * @param {bigint|null} snapshot.views
 * @param {bigint|null} snapshot.likes
 * @param {bigint|null} snapshot.comments
 * @param {bigint|null} [snapshot.shares]
 * @returns {{ likeViewRatio: number|null, commentViewRatio: number|null, shareViewRatio: number|null, engagementViewRatio: number|null }}
 */
export function calculateEngagementRatios(snapshot) {
  const views = snapshot.views ?? null;
  const likes = snapshot.likes ?? null;
  const comments = snapshot.comments ?? null;
  const shares = snapshot.shares ?? null;

  if (views === null) {
    return {
      likeViewRatio: null,
      commentViewRatio: null,
      shareViewRatio: null,
      engagementViewRatio: null
    };
  }

  const likeViewRatio = calculateRatio(likes, views);
  const commentViewRatio = calculateRatio(comments, views);
  const shareViewRatio = calculateRatio(shares, views);

  let engagementViewRatio = null;
  if (Number(views) > 0 && likes !== null && comments !== null) {
    const totalEngagement = Number(likes) + Number(comments) + (shares !== null ? Number(shares) : 0);
    engagementViewRatio = calculateRatio(totalEngagement, views);
  }

  return {
    likeViewRatio,
    commentViewRatio,
    shareViewRatio,
    engagementViewRatio
  };
}

/**
 * Analyzes current and historical metric snapshots using a configurable verification policy
 * @param {object} currentSnapshot - Current metric snapshot
 * @param {Array<object>} historicalSnapshots - All prior snapshots sorted ascending by capturedAt
 * @param {object} [policy=DEFAULT_VERIFICATION_POLICY] - Configurable policy thresholds
 * @returns {Array<{ type: string, severity: 'INFO'|'LOW'|'MEDIUM'|'HIGH'|'CRITICAL', value: object, explanation: string }>}
 */
export function analyzeMetricSignals(currentSnapshot, historicalSnapshots = [], policy = DEFAULT_VERIFICATION_POLICY) {
  const signals = [];
  const availability = currentSnapshot.metadata?.availability || {};

  // 1. Data Availability Check
  if (currentSnapshot.views === null || currentSnapshot.views === undefined || availability.views === 'UNAVAILABLE' || availability.views === 'TEMPORARILY_UNAVAILABLE') {
    signals.push({
      type: 'DATA_UNAVAILABLE',
      severity: 'MEDIUM',
      value: { reason: currentSnapshot.metadata?.reason || 'Provider returned unavailable metrics', availability },
      explanation: 'Engagement metrics could not be retrieved from the platform provider.'
    });
    return signals;
  }

  const currentViews = BigInt(currentSnapshot.views);
  const currentLikes = currentSnapshot.likes !== null && currentSnapshot.likes !== undefined ? BigInt(currentSnapshot.likes) : null;
  const currentComments = currentSnapshot.comments !== null && currentSnapshot.comments !== undefined ? BigInt(currentSnapshot.comments) : null;
  const ratios = calculateEngagementRatios(currentSnapshot);

  // 2. Metric Inconsistency Check (Comparing with immediately preceding snapshot)
  if (historicalSnapshots.length > 0) {
    const latestHistorical = historicalSnapshots[historicalSnapshots.length - 1];

    if (latestHistorical.views !== null && latestHistorical.views !== undefined) {
      const prevViews = BigInt(latestHistorical.views);
      if (currentViews < prevViews) {
        const drop = Number(prevViews - currentViews);
        signals.push({
          type: 'METRIC_INCONSISTENCY',
          severity: 'HIGH',
          value: { previousViews: Number(prevViews), currentViews: Number(currentViews), drop },
          explanation: `Observed view count decreased by ${drop.toLocaleString()} (from ${prevViews.toLocaleString()} to ${currentViews.toLocaleString()}). Potential reasons include platform audit, private video, or regional restriction.`
        });
      }
    }

    if (currentLikes !== null && latestHistorical.likes !== null && latestHistorical.likes !== undefined) {
      const prevLikes = BigInt(latestHistorical.likes);
      if (currentLikes < prevLikes) {
        signals.push({
          type: 'METRIC_INCONSISTENCY',
          severity: 'LOW',
          value: { previousLikes: Number(prevLikes), currentLikes: Number(currentLikes) },
          explanation: 'Observed like count decreased compared to prior snapshot.'
        });
      }
    }
  }

  // 3. Engagement Ratio Signals (Calculated on videos with meaningful sample size according to policy)
  if (Number(currentViews) >= policy.minimumViewsForRatioAnalysis) {
    // Atypical low like-to-view ratio (only if likes are available)
    if (ratios.likeViewRatio !== null && ratios.likeViewRatio < policy.likeViewRatio.low) {
      const pct = (ratios.likeViewRatio * 100).toFixed(2);
      signals.push({
        type: 'LIKE_VIEW_RATIO',
        severity: 'MEDIUM',
        value: { likeViewRatio: ratios.likeViewRatio, views: Number(currentViews), likes: Number(currentLikes ?? 0) },
        explanation: `Observed like-to-view ratio is ${pct}%, significantly below standard platform engagement baselines.`
      });
    }

    // Atypical high like-to-view ratio
    if (ratios.likeViewRatio !== null && ratios.likeViewRatio > policy.likeViewRatio.high) {
      const pct = (ratios.likeViewRatio * 100).toFixed(2);
      signals.push({
        type: 'LIKE_VIEW_RATIO',
        severity: 'LOW',
        value: { likeViewRatio: ratios.likeViewRatio },
        explanation: `Observed like-to-view ratio is unusually high (${pct}%). May indicate niche high-affinity audience or promotional engagement.`
      });
    }

    // Zero comments on substantial views (only if comments are explicitly AVAILABLE and equal to 0)
    if (
      currentComments !== null &&
      Number(currentComments) === 0 &&
      Number(currentViews) >= policy.commentViewRules.minViewsForZeroCommentsWarning &&
      availability.comments !== 'NOT_SUPPORTED'
    ) {
      signals.push({
        type: 'COMMENT_VIEW_RATIO',
        severity: 'LOW',
        value: { views: Number(currentViews), comments: 0 },
        explanation: `Clip has accumulated ${Number(currentViews).toLocaleString()} views with zero comments recorded (comments may be disabled).`
      });
    }
  }

  // 4. Sudden Growth & Velocity Spike Check (Requires at least 2 historical snapshots with valid views)
  if (historicalSnapshots.length >= 2) {
    const validHistory = historicalSnapshots.filter((s) => s.views !== null && s.views !== undefined);
    if (validHistory.length >= 2) {
      const older = validHistory[validHistory.length - 2];
      const prev = validHistory[validHistory.length - 1];

      const prevDurationHours = Math.max(
        0.1,
        (new Date(prev.capturedAt).getTime() - new Date(older.capturedAt).getTime()) / (1000 * 60 * 60)
      );
      const currDurationHours = Math.max(
        0.1,
        (new Date(currentSnapshot.capturedAt).getTime() - new Date(prev.capturedAt).getTime()) / (1000 * 60 * 60)
      );

      const prevVelocity = Math.max(0, Number(BigInt(prev.views) - BigInt(older.views)) / prevDurationHours);
      const currVelocity = Math.max(0, Number(currentViews - BigInt(prev.views)) / currDurationHours);

      const viewDiff = Number(currentViews - BigInt(prev.views));

      if (
        prevVelocity > 0 &&
        currVelocity > policy.suddenGrowthMultiplier * prevVelocity &&
        viewDiff > policy.suddenGrowthMinGain
      ) {
        signals.push({
          type: 'SUDDEN_GROWTH',
          severity: 'MEDIUM',
          value: {
            priorVelocityPerHour: Math.round(prevVelocity),
            currentVelocityPerHour: Math.round(currVelocity),
            viewGain: viewDiff,
            thresholdMultiplier: policy.suddenGrowthMultiplier
          },
          explanation: `View velocity accelerated by ${(currVelocity / prevVelocity).toFixed(1)}x compared to prior historical trajectory (+${viewDiff.toLocaleString()} views).`
        });
      }
    }
  }

  return signals;
}
