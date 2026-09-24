import 'dotenv/config';
import { z } from 'zod';
import { logger } from '../utils/logger.js';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().default(3000),

  // Database
  DATABASE_URL: z.string().url().optional(),

  // Redis / BullMQ
  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional().default(''),
  REDIS_DB: z.coerce.number().default(0),

  // Discord
  DISCORD_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),
  DISCORD_CREATOR_ROLE_ID: z.string().optional(),
  CLIENT_VERIFIED_ROLE_ID: z.string().optional(),

  // Providers
  YOUTUBE_API_KEY: z.string().optional(),
  META_ACCESS_TOKEN: z.string().optional(),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_INSTAGRAM_ACCOUNT_ID: z.string().optional(),
  APIFY_API_TOKEN: z.string().optional(),
  APIFY_FACEBOOK_ACTOR_ID: z.string().default('apify/facebook-posts-scraper'),
  APIFY_TIKTOK_ACTOR_ID: z.string().default('clockworks/free-tiktok-scraper'),
  APIFY_INSTAGRAM_ACTOR_ID: z.string().default('apify/instagram-scraper'),
  APIFY_TIMEOUT_SECS: z.coerce.number().min(5).max(300).default(60),


  // Scheduled Metric Polling
  METRIC_POLL_INTERVAL_MINUTES: z.coerce.number().min(1).default(60),
  METRIC_POLL_BATCH_SIZE: z.coerce.number().min(1).max(500).default(50),
  METRIC_POLL_MAX_ATTEMPTS: z.coerce.number().min(1).max(10).default(3),
  METRIC_POLL_BACKOFF_MS: z.coerce.number().min(500).default(5000),
  METRIC_POLL_ENABLED: z.preprocess((val) => val === 'true' || val === true || val === undefined, z.boolean()).default(true),

  // Rate Limiting
  RATE_LIMIT_SUBMIT_PER_MINUTE: z.coerce.number().min(1).default(10),
  RATE_LIMIT_PAYOUT_PER_MINUTE: z.coerce.number().min(1).default(5),

  // Staff & Admin Authorization Roles (Phase 8)
  DISCORD_ADMIN_ROLE_IDS: z.preprocess(
    (val) => (typeof val === 'string' ? val.split(',').map((s) => s.trim()).filter(Boolean) : val || []),
    z.array(z.string()).default([])
  ),
  DISCORD_CAMPAIGN_MANAGER_ROLE_IDS: z.preprocess(
    (val) => (typeof val === 'string' ? val.split(',').map((s) => s.trim()).filter(Boolean) : val || []),
    z.array(z.string()).default([])
  ),
  ADMIN_FROM_DISCORD_ADMINISTRATOR: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(false),

  // Channel IDs (Zero Provisioning Client Deployment)
  DISCORD_CHANNEL_CAMPAIGNS_ID: z.string().optional(),
  DISCORD_CHANNEL_SUBMISSIONS_ID: z.string().optional(),
  DISCORD_CHANNEL_REVIEW_QUEUE_ID: z.string().optional(),
  DISCORD_CHANNEL_PAYOUT_QUEUE_ID: z.string().optional(),
  DISCORD_CHANNEL_AUDIT_LOG_ID: z.string().optional(),
  DISCORD_CHANNEL_CREATORS_ID: z.string().optional(),
  DISCORD_CHANNEL_CAMPAIGN_MANAGEMENT_ID: z.string().optional(),
  DISCORD_CHANNEL_STAFF_DASHBOARD_ID: z.string().optional(),
  DISCORD_CHANNEL_CREATOR_DASHBOARD_ID: z.string().optional(),
  DISCORD_CHANNEL_STATS_ID: z.string().optional(),
  DISCORD_CHANNEL_EARNINGS_ID: z.string().optional(),
  DISCORD_CHANNEL_PAYOUTS_ID: z.string().optional(),
  DISCORD_CHANNEL_BOT_STATUS_ID: z.string().optional(),
  DISCORD_CHANNEL_BOT_ERRORS_ID: z.string().optional(),

  // Automated guild provisioning flag (strictly false in client production deployments)
  ENABLE_AUTO_PROVISIONING: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(false)
});

/**
 * Validate and export configuration
 */
function loadConfig() {
  const result = configSchema.safeParse(process.env);

  if (!result.success) {
    const errorDetails = result.error.format();
    logger.fatal({ errors: errorDetails }, 'Configuration validation failed');
    throw new Error('Invalid application configuration');
  }

  const config = result.data;

  // Production-only enforcement
  if (config.NODE_ENV === 'production') {
    const missing = [];
    if (!config.DATABASE_URL) missing.push('DATABASE_URL');
    if (!config.DISCORD_TOKEN) missing.push('DISCORD_TOKEN');
    if (!config.DISCORD_CLIENT_ID) missing.push('DISCORD_CLIENT_ID');

    if (missing.length > 0) {
      const msg = `Missing required production environment variables: ${missing.join(', ')}`;
      logger.fatal(msg);
      throw new Error(msg);
    }
  }

  return {
    env: config.NODE_ENV,
    isProduction: config.NODE_ENV === 'production',
    isDevelopment: config.NODE_ENV === 'development',
    isTest: config.NODE_ENV === 'test',
    logLevel: config.LOG_LEVEL,
    port: config.PORT,
    db: {
      url: config.DATABASE_URL
    },
    redis: {
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
      password: config.REDIS_PASSWORD || undefined,
      db: config.REDIS_DB
    },
    discord: {
      token: config.DISCORD_TOKEN,
      clientId: config.DISCORD_CLIENT_ID,
      guildId: config.DISCORD_GUILD_ID,
      creatorRoleId: config.DISCORD_CREATOR_ROLE_ID || null,
      clientVerifiedRoleId: config.CLIENT_VERIFIED_ROLE_ID || null,
      channels: {
        campaigns: config.DISCORD_CHANNEL_CAMPAIGNS_ID || null,
        submissions: config.DISCORD_CHANNEL_SUBMISSIONS_ID || null,
        reviewQueue: config.DISCORD_CHANNEL_REVIEW_QUEUE_ID || null,
        payoutQueue: config.DISCORD_CHANNEL_PAYOUT_QUEUE_ID || null,
        auditLog: config.DISCORD_CHANNEL_AUDIT_LOG_ID || null,
        creators: config.DISCORD_CHANNEL_CREATORS_ID || null,
        campaignManagement: config.DISCORD_CHANNEL_CAMPAIGN_MANAGEMENT_ID || null,
        staffDashboard: config.DISCORD_CHANNEL_STAFF_DASHBOARD_ID || null,
        creatorDashboard: config.DISCORD_CHANNEL_CREATOR_DASHBOARD_ID || null,
        stats: config.DISCORD_CHANNEL_STATS_ID || null,
        earnings: config.DISCORD_CHANNEL_EARNINGS_ID || null,
        payouts: config.DISCORD_CHANNEL_PAYOUTS_ID || null,
        botStatus: config.DISCORD_CHANNEL_BOT_STATUS_ID || null,
        botErrors: config.DISCORD_CHANNEL_BOT_ERRORS_ID || null
      }
    },
    enableAutoProvisioning: config.ENABLE_AUTO_PROVISIONING,
    providers: {
      youtubeApiKey: config.YOUTUBE_API_KEY,
      metaAccessToken: config.META_ACCESS_TOKEN,
      metaAppId: config.META_APP_ID,
      metaAppSecret: config.META_APP_SECRET,
      metaInstagramAccountId: config.META_INSTAGRAM_ACCOUNT_ID,
      apify: {
        apiToken: config.APIFY_API_TOKEN,
        facebookActorId: config.APIFY_FACEBOOK_ACTOR_ID,
        tiktokActorId: config.APIFY_TIKTOK_ACTOR_ID,
        instagramActorId: config.APIFY_INSTAGRAM_ACTOR_ID,
        timeoutSecs: config.APIFY_TIMEOUT_SECS
      }
    },

    polling: {
      intervalMinutes: config.METRIC_POLL_INTERVAL_MINUTES,
      batchSize: config.METRIC_POLL_BATCH_SIZE,
      maxAttempts: config.METRIC_POLL_MAX_ATTEMPTS,
      backoffMs: config.METRIC_POLL_BACKOFF_MS,
      enabled: config.METRIC_POLL_ENABLED
    },
    rateLimits: {
      submitPerMinute: config.RATE_LIMIT_SUBMIT_PER_MINUTE,
      payoutPerMinute: config.RATE_LIMIT_PAYOUT_PER_MINUTE
    },
    admin: {
      adminRoleIds: config.DISCORD_ADMIN_ROLE_IDS,
      campaignManagerRoleIds: config.DISCORD_CAMPAIGN_MANAGER_ROLE_IDS,
      adminFromDiscordAdministrator: config.ADMIN_FROM_DISCORD_ADMINISTRATOR
    }
  };
}

export const config = loadConfig();
export default config;
