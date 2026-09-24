import 'dotenv/config';
import { Prisma } from '@prisma/client';
import { prisma, disconnectDatabase } from '../database/client.js';
import { userRepository } from '../modules/users/user.repository.js';
import { campaignRepository } from '../modules/campaigns/campaign.repository.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';

export const DEV_FIXTURES = Object.freeze({
  CREATOR: {
    discordId: '999999999999999999',
    username: 'peakclip_dev_creator',
    displayName: 'Peak Clip DEV Creator'
  },
  CAMPAIGNS: [
    {
      slug: 'dev-youtube-campaign',
      name: 'DEV YouTube Campaign',
      clientName: 'Peak Clip DEV Client',
      status: 'ACTIVE',
      payRate: new Prisma.Decimal('1.00'),
      minimumPayout: new Prisma.Decimal('10.00'),
      totalBudget: new Prisma.Decimal('5000.00'),
      currency: 'USD',
      getStartsAt: (now) => new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
      getEndsAt: (now) => new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      requirements: {
        allowedPlatforms: ['YOUTUBE'],
        rules: ['DEV campaign for YouTube clipping verification'],
        contentGuidelines: 'Short-form vertical video test'
      }
    },
    {
      slug: 'dev-secondary-campaign',
      name: 'DEV Secondary Campaign',
      clientName: 'Peak Clip DEV Client 2',
      status: 'ACTIVE',
      payRate: new Prisma.Decimal('0.80'),
      minimumPayout: new Prisma.Decimal('10.00'),
      totalBudget: new Prisma.Decimal('2500.00'),
      currency: 'USD',
      getStartsAt: (now) => new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
      getEndsAt: (now) => new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      requirements: {
        allowedPlatforms: ['YOUTUBE', 'TIKTOK'],
        rules: ['DEV secondary campaign for isolation testing'],
        contentGuidelines: 'Secondary test campaign'
      }
    }
  ]
});

/**
 * Seed deterministic DEV fixtures into PostgreSQL
 * @returns {Promise<{ creator: object, campaigns: Array<object>, memberships: Array<object> }>}
 */
export async function seedDevData() {
  if (config.isProduction || process.env.NODE_ENV === 'production') {
    throw new Error('Seed script aborted: Development seed data cannot be applied in production environment.');
  }

  logger.info('Starting deterministic DEV seeding sequence...');
  const now = new Date();

  // 1. Seed DEV Creator
  const creator = await userRepository.upsertFromDiscord({
    discordId: DEV_FIXTURES.CREATOR.discordId,
    username: DEV_FIXTURES.CREATOR.username,
    displayName: DEV_FIXTURES.CREATOR.displayName,
    avatarUrl: null
  });
  logger.info({ userId: creator.id, discordId: creator.discordId, username: creator.username }, 'DEV creator upserted');

  // 2. Seed DEV Campaigns
  const seededCampaigns = [];
  for (const item of DEV_FIXTURES.CAMPAIGNS) {
    const startsAt = item.getStartsAt(now);
    const endsAt = item.getEndsAt(now);

    const campaign = await prisma.campaign.upsert({
      where: { slug: item.slug },
      update: {
        name: item.name,
        clientName: item.clientName,
        status: item.status,
        payRate: item.payRate,
        minimumPayout: item.minimumPayout,
        totalBudget: item.totalBudget,
        currency: item.currency,
        startsAt,
        endsAt,
        requirements: item.requirements
      },
      create: {
        name: item.name,
        slug: item.slug,
        description: `Deterministic development campaign: ${item.name}`,
        clientName: item.clientName,
        status: item.status,
        payRate: item.payRate,
        minimumPayout: item.minimumPayout,
        totalBudget: item.totalBudget,
        currency: item.currency,
        startsAt,
        endsAt,
        requirements: item.requirements
      }
    });

    seededCampaigns.push(campaign);
    logger.info({ campaignId: campaign.id, slug: campaign.slug, status: campaign.status }, 'DEV campaign upserted');
  }

  // 3. Seed Membership for Campaign A (dev-youtube-campaign) ONLY
  const campaignA = seededCampaigns.find((c) => c.slug === 'dev-youtube-campaign');
  if (!campaignA) {
    throw new Error('Campaign A (dev-youtube-campaign) not found among seeded campaigns');
  }

  const membershipA = await campaignRepository.upsertMembership(creator.id, campaignA.id, 'ACTIVE');
  logger.info({ membershipId: `${creator.id}_${campaignA.id}`, status: membershipA.status }, 'DEV creator membership in Campaign A upserted');

  logger.info('Deterministic DEV seeding completed successfully.');

  return {
    creator,
    campaigns: seededCampaigns,
    memberships: [membershipA]
  };
}

// CLI entry point
if (process.argv[1]?.replace(/\\/g, '/').endsWith('src/scripts/seed-dev.js')) {
  seedDevData()
    .then((result) => {
      console.log('SEED_DEV_SUCCESS', JSON.stringify({
        creatorId: result.creator.id,
        campaignCount: result.campaigns.length,
        membershipCount: result.memberships.length
      }, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err: err.message }, 'Failed to seed DEV data');
      process.exit(1);
    })
    .finally(async () => {
      await disconnectDatabase();
    });
}
