import { z } from 'zod';

export const createPayoutInputSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  amount: z.union([z.string(), z.number()]).refine((val) => {
    const num = Number(val);
    return !isNaN(num) && num > 0;
  }, 'Amount must be greater than zero'),
  currency: z.string().length(3, 'Currency must be an ISO 4217 3-letter code').default('USD')
});

export const cancelPayoutInputSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  payoutRequestId: z.string().min(1, 'Payout request ID is required'),
  reason: z.string().optional()
});

export const reviewPayoutInputSchema = z.object({
  payoutRequestId: z.string().min(1, 'Payout request ID is required'),
  reviewerUserId: z.string().min(1, 'Reviewer user ID is required'),
  notes: z.string().optional()
});

export const rejectPayoutInputSchema = z.object({
  payoutRequestId: z.string().min(1, 'Payout request ID is required'),
  reviewerUserId: z.string().min(1, 'Reviewer user ID is required'),
  rejectionReason: z.string().min(1, 'Rejection reason is required')
});

export const disbursePayoutInputSchema = z.object({
  payoutRequestId: z.string().min(1, 'Payout request ID is required'),
  provider: z.string().default('MANUAL')
});
