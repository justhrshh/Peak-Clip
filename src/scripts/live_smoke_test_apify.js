/**
 * Live Smoke Test Script for Apify Facebook & TikTok Scrapers
 *
 * Usage:
 *   node src/scripts/live_smoke_test_apify.js --tiktok "https://www.tiktok.com/@username/video/1234567890123456789"
 *   node src/scripts/live_smoke_test_apify.js --facebook "https://www.facebook.com/reel/1234567890/"
 *
 * If APIFY_API_TOKEN is not in .env, you can run:
 *   APIFY_API_TOKEN=your_token node src/scripts/live_smoke_test_apify.js ...
 */

import { apifyClientService } from '../integrations/apify/apify.client.js';
import { tiktokProvider } from '../providers/tiktok/tiktok.provider.js';
import { facebookProvider } from '../providers/facebook/facebook.provider.js';
import { logger } from '../utils/logger.js';

async function runSmokeTest() {
  const args = process.argv.slice(2);
  let tiktokUrl = null;
  let facebookUrl = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tiktok' && args[i + 1]) {
      tiktokUrl = args[i + 1];
      i++;
    } else if (args[i] === '--facebook' && args[i + 1]) {
      facebookUrl = args[i + 1];
      i++;
    }
  }

  console.log('====================================================');
  console.log('  PEAK CLIP — APIFY AUTOMATED PROVIDERS SMOKE TEST');
  console.log('====================================================');

  const isConfigured = apifyClientService.isConfigured();
  console.log(`[Apify Status]: ${isConfigured ? 'CONFIGURED (Token Present)' : 'NOT CONFIGURED (APIFY_API_TOKEN is empty)'}`);

  if (!isConfigured) {
    console.log('\nNotice: APIFY_API_TOKEN is not configured in your environment or .env.');
    console.log('To run a live test against Apify actors, configure APIFY_API_TOKEN:');
    console.log('  APIFY_API_TOKEN="apify_api_..." node src/scripts/live_smoke_test_apify.js --tiktok <URL>\n');
    console.log('Running fallback unconfigured check...');
  }

  if (tiktokUrl) {
    console.log(`\n--- Testing TikTok Provider with: ${tiktokUrl} ---`);
    try {
      const result = await tiktokProvider.getCurrentMetrics(tiktokUrl);
      console.log('Result:', JSON.stringify(result, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
    } catch (err) {
      console.error(`TikTok Scrape Error [${err.name}]:`, err.message);
      if (err.details) console.error('Details:', err.details);
    }
  }

  if (facebookUrl) {
    console.log(`\n--- Testing Facebook Provider with: ${facebookUrl} ---`);
    try {
      const result = await facebookProvider.getCurrentMetrics(facebookUrl);
      console.log('Result:', JSON.stringify(result, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
    } catch (err) {
      console.error(`Facebook Scrape Error [${err.name}]:`, err.message);
      if (err.details) console.error('Details:', err.details);
    }
  }

  if (!tiktokUrl && !facebookUrl) {
    console.log('\nNo test URLs provided. Provide --tiktok <url> and/or --facebook <url>');
    console.log('Example:');
    console.log('  node src/scripts/live_smoke_test_apify.js --tiktok "https://www.tiktok.com/@tiktok/video/7106594312292453678"');
  }

  console.log('\nSmoke test check completed.\n');
}

runSmokeTest().catch((err) => {
  logger.error({ err }, 'Fatal error in Apify smoke test');
  process.exit(1);
});
