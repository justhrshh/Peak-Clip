import 'dotenv/config';
import { prisma, disconnectDatabase } from '../database/client.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';

const now = new Date();
const oneDayMs = 24 * 60 * 60 * 1000;

const SEED_CAMPAIGNS = [
  {
    name: '[DEV] Apex Legends Viral Highlights',
    slug: 'dev-apex-legends-viral-highlights',
    clientName: 'Apex Esports League',
    description: 'Create engaging short-form vertical clips featuring top plays, funny moments, and clutch clutches from the Apex Esports League summer qualifiers.',
    status: 'ACTIVE',
    payRate: '5.00',
    minimumPayout: '20.00',
    startsAt: new Date(now.getTime() - 2 * oneDayMs),
    endsAt: new Date(now.getTime() + 30 * oneDayMs),
    requirements: {
      allowedPlatforms: ['youtube', 'tiktok'],
      minClipDuration: 15,
      maxClipDuration: 60,
      rules: [
        'Must include hashtag #ApexClips in the caption',
        'Direct screen capture with clear 1080p+ resolution',
        'No copyrighted music outside of in-game audio'
      ],
      contentGuidelines: 'Focus on action moments, tournament commentary, and fast pacing.'
    }
  },
  {
    name: '[DEV] Tech Pioneers Podcast Clips',
    slug: 'dev-tech-pioneers-podcast-clips',
    clientName: 'Tech Pioneers Media',
    description: 'High-signal educational and provocative clips from episodes 50-75 of the Tech Pioneers podcast.',
    status: 'ACTIVE',
    payRate: '4.50',
    minimumPayout: '15.00',
    startsAt: new Date(now.getTime() - 5 * oneDayMs),
    endsAt: new Date(now.getTime() + 20 * oneDayMs),
    requirements: {
      allowedPlatforms: ['youtube', 'tiktok', 'instagram'],
      minClipDuration: 20,
      maxClipDuration: 90,
      rules: [
        'Subtitles/captions are mandatory',
        'Tag @TechPioneersPod on all uploads'
      ],
      contentGuidelines: 'Clip thought-provoking insights about AI, hardware, and founder stories.'
    }
  },
  {
    name: '[DEV] Upcoming RPG Showcase Preview',
    slug: 'dev-upcoming-rpg-showcase-preview',
    clientName: 'Nexus Interactive',
    description: 'Pre-launch campaign in draft status for testing approval workflows.',
    status: 'DRAFT',
    payRate: '6.00',
    minimumPayout: '25.00',
    startsAt: new Date(now.getTime() + 7 * oneDayMs),
    endsAt: new Date(now.getTime() + 37 * oneDayMs),
    requirements: {
      allowedPlatforms: ['youtube'],
      minClipDuration: 30,
      maxClipDuration: 60
    }
  },
  {
    name: '[DEV] Retro Speedruns Championship',
    slug: 'dev-retro-speedruns-championship',
    clientName: 'Speedrun Guild',
    description: 'Campaign temporarily on hold for review.',
    status: 'PAUSED',
    payRate: '3.50',
    minimumPayout: '10.00',
    startsAt: new Date(now.getTime() - 10 * oneDayMs),
    endsAt: new Date(now.getTime() + 10 * oneDayMs),
    requirements: {
      allowedPlatforms: ['youtube', 'tiktok']
    }
  },
  {
    name: '[DEV] Summer Indie Fest',
    slug: 'dev-summer-indie-fest',
    clientName: 'Indie Game Collective',
    description: 'Concluded campaign for testing historical views and inactive guards.',
    status: 'ENDED',
    payRate: '4.00',
    minimumPayout: '20.00',
    startsAt: new Date(now.getTime() - 30 * oneDayMs),
    endsAt: new Date(now.getTime() - 2 * oneDayMs),
    requirements: {
      allowedPlatforms: ['youtube', 'tiktok', 'instagram']
    }
  }
];

export async function seedCampaigns() {
  if (config.isProduction) {
    logger.warn('Seed script aborted: Development seed data cannot be applied in production environment.');
    return;
  }

  logger.info(`Seeding ${SEED_CAMPAIGNS.length} development campaign fixtures...`);

  for (const item of SEED_CAMPAIGNS) {
    const campaign = await prisma.campaign.upsert({
      where: { slug: item.slug },
      update: {
        name: item.name,
        description: item.description,
        clientName: item.clientName,
        status: item.status,
        payRate: item.payRate,
        minimumPayout: item.minimumPayout,
        startsAt: item.startsAt,
        endsAt: item.endsAt,
        requirements: item.requirements
      },
      create: {
        name: item.name,
        slug: item.slug,
        description: item.description,
        clientName: item.clientName,
        status: item.status,
        payRate: item.payRate,
        minimumPayout: item.minimumPayout,
        startsAt: item.startsAt,
        endsAt: item.endsAt,
        requirements: item.requirements
      }
    });

    logger.info(`Upserted [${campaign.status}] campaign: ${campaign.slug} (${campaign.id})`);
  }

  logger.info('Development seeding completed successfully.');
}

// Direct execution guard
if (process.argv[1]?.replace(/\\/g, '/').endsWith('src/scripts/seed-campaigns.js')) {
  seedCampaigns()
    .catch((err) => {
      logger.error({ err: err.message }, 'Failed to seed development campaigns');
      process.exit(1);
    })
    .finally(async () => {
      await disconnectDatabase();
    });
}
