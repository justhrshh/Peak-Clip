import { youtubeProvider } from './youtube/youtube.provider.js';
import { tiktokProvider } from './tiktok/tiktok.provider.js';
import { instagramProvider } from './instagram/instagram.provider.js';
import { facebookProvider } from './facebook/facebook.provider.js';
import { UnsupportedPlatformError } from '../modules/submissions/submission.errors.js';

const providerRegistry = {
  YOUTUBE: youtubeProvider,
  TIKTOK: tiktokProvider,
  INSTAGRAM: instagramProvider,
  FACEBOOK: facebookProvider
};

/**
 * Get platform provider by platform identifier
 * @param {'YOUTUBE'|'TIKTOK'|'INSTAGRAM'|'FACEBOOK'|string} platform
 * @returns {import('./base.provider.js').BasePlatformProvider}
 */
export function getProviderForPlatform(platform) {
  const normalized = String(platform).toUpperCase();
  const provider = providerRegistry[normalized];

  if (!provider) {
    throw new UnsupportedPlatformError(platform);
  }

  return provider;
}

export const getPlatformProvider = getProviderForPlatform;
export { youtubeProvider, tiktokProvider, instagramProvider, facebookProvider };
