import { Prisma } from '@prisma/client';

/**
 * Campaign Policy — centralized, non-hardcoded business rule defaults.
 *
 * All business logic that references campaign defaults MUST read from this
 * object rather than embedding literals in service/handler code.
 *
 * These are defaults only; individual campaigns may override them.
 */
export const CAMPAIGN_POLICY = Object.freeze({
  /**
   * Default per-creator, per-campaign maximum earnings.
   * Creators cannot accrue more than this amount within a single campaign.
   * Configurable per-campaign at creation time.
   */
  DEFAULT_CREATOR_EARNING_CAP: new Prisma.Decimal('600.00'),

  /**
   * Default minimum clip duration in seconds.
   * Clips shorter than this threshold are ineligible (when duration is known).
   */
  DEFAULT_MIN_CLIP_DURATION_SECONDS: 7,

  /**
   * Default maximum clip duration in seconds.
   * Clips longer than this threshold are ineligible (when duration is known).
   */
  DEFAULT_MAX_CLIP_DURATION_SECONDS: 120,

  /**
   * Platforms supported by the Peak Clip provider abstraction.
   * FACEBOOK is listed as a capability boundary: it can be selected but
   * metric collection requires official API access configuration.
   */
  SUPPORTED_PLATFORMS: Object.freeze(['YOUTUBE', 'TIKTOK', 'INSTAGRAM', 'FACEBOOK']),

  /**
   * Platforms with live metric provider implementations.
   */
  IMPLEMENTED_PLATFORMS: Object.freeze(['YOUTUBE']),

  /**
   * Default currency for campaign financial accounting.
   */
  DEFAULT_CURRENCY: 'USD',

  /**
   * Minimum total budget allowed for a campaign (in USD).
   * Prevents zero-budget campaigns that cannot credit any earnings.
   */
  MINIMUM_TOTAL_BUDGET: new Prisma.Decimal('1.00'),

  /**
   * Minimum creator earning cap (in USD).
   * Prevents accidentally setting a cap of $0 which would block all earnings.
   */
  MINIMUM_CREATOR_EARNING_CAP: new Prisma.Decimal('1.00'),
});
