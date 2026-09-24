import { z } from 'zod';
import { InvalidStatusTransitionError } from './campaign.errors.js';
import { CAMPAIGN_POLICY } from './campaign.policy.js';

export const VALID_PLATFORMS = CAMPAIGN_POLICY.SUPPORTED_PLATFORMS.map((p) => p.toLowerCase());

export const campaignRequirementsSchema = z.object({
  allowedPlatforms: z
    .array(z.enum(['youtube', 'tiktok', 'instagram', 'facebook']))
    .min(1, { message: 'At least one valid platform must be allowed' }),
  // Legacy/JSON requirements fields (clip duration now also stored as first-class columns)
  minClipDuration: z.number().int().positive().optional(),
  maxClipDuration: z.number().int().positive().optional(),
  rules: z.union([z.string(), z.array(z.string())]).optional(),
  contentGuidelines: z.string().optional()
}).refine((data) => {
  if (data.minClipDuration && data.maxClipDuration) {
    return data.maxClipDuration >= data.minClipDuration;
  }
  return true;
}, {
  message: 'maxClipDuration must be >= minClipDuration',
  path: ['maxClipDuration']
});

export const campaignCreateSchema = z
  .object({
    name: z.string().min(3).max(128),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
      message: 'Slug must be lower-case alphanumeric with hyphens'
    }),
    description: z.string().min(10).max(4000),
    clientName: z.string().min(2).max(128),
    payRate: z.coerce.number().positive({ message: 'Pay rate (CPM) must be greater than 0' }),
    minimumPayout: z.coerce
      .number()
      .nonnegative({ message: 'Minimum payout must be 0 or greater' })
      .default(0),
    // --- Phase 10A: Budget & Cap ---
    totalBudget: z.coerce
      .number()
      .positive({ message: 'Total budget must be greater than 0' })
      .min(Number(CAMPAIGN_POLICY.MINIMUM_TOTAL_BUDGET), {
        message: `Total budget must be at least $${CAMPAIGN_POLICY.MINIMUM_TOTAL_BUDGET.toFixed(2)}`
      })
      .default(1000),
    creatorEarningCap: z.coerce
      .number()
      .positive({ message: 'Creator earning cap must be greater than 0' })
      .min(Number(CAMPAIGN_POLICY.MINIMUM_CREATOR_EARNING_CAP), {
        message: `Creator earning cap must be at least $${CAMPAIGN_POLICY.MINIMUM_CREATOR_EARNING_CAP.toFixed(2)}`
      })
      .default(Number(CAMPAIGN_POLICY.DEFAULT_CREATOR_EARNING_CAP)),
    // --- Phase 10A: Clip Duration ---
    minClipDurationSeconds: z.coerce
      .number()
      .int()
      .positive()
      .default(CAMPAIGN_POLICY.DEFAULT_MIN_CLIP_DURATION_SECONDS),
    maxClipDurationSeconds: z.coerce
      .number()
      .int()
      .positive()
      .default(CAMPAIGN_POLICY.DEFAULT_MAX_CLIP_DURATION_SECONDS),
    // --- Phase 10A: Retention ---
    retentionRequired: z.boolean().default(false),
    retentionDays: z.coerce.number().int().positive().nullable().optional(),
    // --- Date Window (retained for scheduling) ---
    startsAt: z.preprocess((val) => {
      if (val === '' || val === null || val === undefined) return new Date();
      return val;
    }, z.coerce.date().default(() => new Date())),
    endsAt: z.preprocess((val) => {
      if (val === '' || val === null || val === undefined) return undefined;
      return val;
    }, z.coerce.date().optional()),
    requirements: campaignRequirementsSchema.default({ allowedPlatforms: ['youtube', 'tiktok', 'instagram'] })
  })
  .refine((data) => {
    if (!data.endsAt || !data.startsAt) return true;
    if (isNaN(data.startsAt.getTime()) || isNaN(data.endsAt.getTime())) return true;
    return data.endsAt > data.startsAt;
  }, {
    message: 'Campaign endsAt must be chronologically after startsAt',
    path: ['endsAt']
  })
  .transform((data) => {
    if (!data.endsAt) {
      data.endsAt = new Date(data.startsAt.getTime() + 30 * 86400000);
    }
    return data;
  })
  .refine((data) => data.maxClipDurationSeconds >= data.minClipDurationSeconds, {
    message: 'maxClipDurationSeconds must be >= minClipDurationSeconds',
    path: ['maxClipDurationSeconds']
  })
  .refine((data) => !data.retentionRequired || (data.retentionDays != null && data.retentionDays >= 1), {
    message: 'retentionDays must be >= 1 when retentionRequired is true',
    path: ['retentionDays']
  });

/**
 * Valid state transitions for campaigns.
 * COMPLETED is a system-only state (triggered by budget exhaustion).
 * It is NOT available in the admin set-status command.
 */
export const ALLOWED_STATUS_TRANSITIONS = Object.freeze({
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['PAUSED', 'ENDED', 'COMPLETED'],
  PAUSED: ['ACTIVE', 'ENDED'],
  COMPLETED: ['ARCHIVED'],
  ENDED: ['ARCHIVED'],
  ARCHIVED: []
});

/**
 * Status values that admin may set manually (excludes system-only COMPLETED)
 */
export const ADMIN_SETTABLE_STATUSES = Object.freeze(['ACTIVE', 'PAUSED', 'ENDED', 'ARCHIVED']);

/**
 * Validate campaign status transition
 * @param {string} currentStatus
 * @param {string} targetStatus
 * @throws {InvalidStatusTransitionError}
 */
export function validateStatusTransition(currentStatus, targetStatus) {
  if (currentStatus === targetStatus) return true;

  const allowed = ALLOWED_STATUS_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(targetStatus)) {
    throw new InvalidStatusTransitionError(currentStatus, targetStatus);
  }
  return true;
}
