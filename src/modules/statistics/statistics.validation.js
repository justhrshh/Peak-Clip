import { z } from 'zod';

export const userOverviewInputSchema = z.object({
  userId: z.string().min(1, 'User ID is required')
});

export const campaignOverviewInputSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  campaignId: z.string().min(1, 'Campaign ID is required')
});

export const submissionStatsInputSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  submissionId: z.string().min(1, 'Submission ID is required')
});

export const creatorCampaignsInputSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  page: z.number().int().min(1).default(1).optional(),
  limit: z.number().int().min(1).max(50).default(5).optional()
});

export const creatorVideosInputSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  campaignId: z.string().optional().nullable(),
  page: z.number().int().min(1).default(1).optional(),
  limit: z.number().int().min(1).max(50).default(10).optional()
});

export const campaignAnalyticsInputSchema = z.object({
  campaignId: z.string().min(1, 'Campaign ID is required'),
  page: z.number().int().min(1).default(1).optional(),
  limit: z.number().int().min(1).max(50).default(10).optional(),
  sortBy: z.enum(['views', 'earnings', 'clips', 'activity']).default('views').optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc').optional()
});
