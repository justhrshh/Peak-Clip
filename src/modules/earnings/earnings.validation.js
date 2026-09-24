import { z } from 'zod';

export const userEarningsInputSchema = z.object({
  userId: z.string().min(1, 'User ID is required')
});

export const campaignEarningsInputSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  campaignId: z.string().min(1, 'Campaign ID is required')
});

export const submissionEarningsInputSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  submissionId: z.string().min(1, 'Submission ID is required')
});

export const creditViewsInputSchema = z.object({
  submissionId: z.string().min(1, 'Submission ID is required'),
  snapshotId: z.string().optional()
});
