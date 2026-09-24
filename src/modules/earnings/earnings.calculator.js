import { Prisma } from '@prisma/client';

/**
 * Pure monetary calculation function for eligible campaign views.
 *
 * Exact Math & Precision Rules:
 * - Strictly uses Prisma.Decimal (never JavaScript binary floats).
 * - Rate is defined as the currency amount per 1,000 eligible views.
 * - Formula: (eligibleViews / 1,000) * ratePerThousand
 * - Rounding Policy: Rounded to 2 decimal places using ROUND_HALF_UP (standard financial rounding).
 *
 * @param {bigint|number|string} eligibleViews - Number of newly eligible views
 * @param {Prisma.Decimal|string|number} ratePerThousand - Campaign pay rate per 1,000 views
 * @returns {Prisma.Decimal} - Calculated gross amount rounded to 2 decimal places
 */
export function calculateGrossAmount(eligibleViews, ratePerThousand) {
  if (eligibleViews === null || eligibleViews === undefined || ratePerThousand === null || ratePerThousand === undefined) {
    return new Prisma.Decimal('0.00');
  }

  const viewsDec = new Prisma.Decimal(eligibleViews.toString());
  if (viewsDec.lessThanOrEqualTo(0)) {
    return new Prisma.Decimal('0.00');
  }

  const rateDec = new Prisma.Decimal(ratePerThousand.toString());
  if (rateDec.lessThanOrEqualTo(0)) {
    return new Prisma.Decimal('0.00');
  }

  // Divide views by 1,000 with exact Decimal division
  const thousands = viewsDec.dividedBy(1000);

  // Multiply by the rate per thousand
  const gross = thousands.times(rateDec);

  // Standard financial rounding: 2 decimal places with ROUND_HALF_UP
  return gross.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Apply budget and creator-cap constraints to a raw CPM earning.
 *
 * Computes: actualCredit = MIN(rawAmount, campaignRemaining, creatorRemaining)
 *
 * All three values must be provided. Any null/undefined input causes a $0 return.
 * Negative remainders are treated as $0 (never negative earnings).
 *
 * @param {Prisma.Decimal|string|number} rawAmount - Uncapped CPM-calculated gross
 * @param {Prisma.Decimal|string|number} campaignRemaining - Campaign remaining budget
 * @param {Prisma.Decimal|string|number} creatorRemaining - Creator remaining cap in this campaign
 * @returns {{ actualCredit: Prisma.Decimal, cappedBy: string|null }}
 *   actualCredit is the amount to credit; cappedBy indicates what applied the cap (null = no cap, 'CAMPAIGN', 'CREATOR', 'BOTH')
 */
export function applyBudgetCaps(rawAmount, campaignRemaining, creatorRemaining) {
  const zero = new Prisma.Decimal('0.00');

  const raw = rawAmount != null ? new Prisma.Decimal(rawAmount.toString()) : zero;
  const campRem = campaignRemaining != null ? new Prisma.Decimal(campaignRemaining.toString()) : zero;
  const creatRem = creatorRemaining != null ? new Prisma.Decimal(creatorRemaining.toString()) : zero;

  // Clamp negatives to zero
  const effectiveCampRem = campRem.greaterThan(0) ? campRem : zero;
  const effectiveCreatRem = creatRem.greaterThan(0) ? creatRem : zero;

  if (raw.lessThanOrEqualTo(0) || effectiveCampRem.lessThanOrEqualTo(0) || effectiveCreatRem.lessThanOrEqualTo(0)) {
    // Determine which cap was hit
    let cappedBy = null;
    if (effectiveCampRem.lessThanOrEqualTo(0) && effectiveCreatRem.lessThanOrEqualTo(0)) {
      cappedBy = 'BOTH';
    } else if (effectiveCampRem.lessThanOrEqualTo(0)) {
      cappedBy = 'CAMPAIGN';
    } else if (effectiveCreatRem.lessThanOrEqualTo(0)) {
      cappedBy = 'CREATOR';
    }
    return { actualCredit: zero, cappedBy };
  }

  // Apply caps using Decimal.min semantics
  const afterCampaignCap = Prisma.Decimal.min(raw, effectiveCampRem);
  const actualCredit = Prisma.Decimal.min(afterCampaignCap, effectiveCreatRem);

  actualCredit.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

  // Determine what cap applied
  let cappedBy = null;
  if (actualCredit.lessThan(raw)) {
    const campaignCapped = effectiveCampRem.lessThan(raw);
    const creatorCapped = effectiveCreatRem.lessThan(raw);
    if (campaignCapped && creatorCapped) {
      cappedBy = effectiveCampRem.lessThan(effectiveCreatRem) ? 'CAMPAIGN' : 'CREATOR';
    } else if (campaignCapped) {
      cappedBy = 'CAMPAIGN';
    } else {
      cappedBy = 'CREATOR';
    }
  }

  return {
    actualCredit: actualCredit.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
    cappedBy
  };
}
