import 'dotenv/config';
import { prisma, disconnectDatabase } from '../database/client.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { DEV_FIXTURES } from './seed-dev.js';

/**
 * Safely clean up only deterministic DEV fixtures
 */
export async function cleanupDevData() {
  if (config.isProduction || process.env.NODE_ENV === 'production') {
    throw new Error('Cleanup script aborted: Cannot run in production environment.');
  }

  logger.info('Starting safe DEV fixtures cleanup...');

  // 1. Resolve DEV creator
  const creator = await prisma.user.findUnique({
    where: { discordId: DEV_FIXTURES.CREATOR.discordId }
  });

  const campaignSlugs = DEV_FIXTURES.CAMPAIGNS.map((c) => c.slug);

  // 2. Remove memberships for DEV creator in DEV campaigns
  if (creator) {
    const deletedMemberships = await prisma.campaignMember.deleteMany({
      where: {
        userId: creator.id,
        campaign: { slug: { in: campaignSlugs } }
      }
    });
    logger.info({ deletedCount: deletedMemberships.count }, 'Deleted DEV campaign memberships');

    // 3. Remove DEV creator
    await prisma.user.delete({
      where: { id: creator.id }
    });
    logger.info({ creatorId: creator.id }, 'Deleted DEV creator');
  }

  // 4. Remove DEV campaigns (only if they have no other submissions/memberships)
  for (const slug of campaignSlugs) {
    const campaign = await prisma.campaign.findUnique({
      where: { slug },
      include: {
        _count: {
          select: {
            submissions: true,
            memberships: true
          }
        }
      }
    });

    if (campaign && campaign._count.submissions === 0 && campaign._count.memberships === 0) {
      await prisma.campaign.delete({ where: { id: campaign.id } });
      logger.info({ slug, campaignId: campaign.id }, 'Deleted DEV campaign');
    }
  }

  logger.info('Safe DEV fixtures cleanup completed.');
}

// CLI entry point
if (process.argv[1]?.replace(/\\/g, '/').endsWith('src/scripts/cleanup-dev.js')) {
  cleanupDevData()
    .then(() => {
      console.log('CLEANUP_DEV_SUCCESS');
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err: err.message }, 'Failed to cleanup DEV data');
      process.exit(1);
    })
    .finally(async () => {
      await disconnectDatabase();
    });
}
