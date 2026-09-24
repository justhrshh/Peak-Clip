import { InvalidSubmissionUrlError, UnsupportedPlatformError } from './submission.errors.js';

// Safe tracking query parameters to strip
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'si',
  'igsh',
  'igshid',
  'fbclid',
  'gclid',
  'feature',
  'ref',
  'is_from_webapp',
  'sender_device',
  'share_app_id',
  '_r',
  '_t'
]);

/**
 * Clean known tracking parameters from a URLSearchParams object while preserving content params
 * @param {URLSearchParams} searchParams
 * @returns {URLSearchParams}
 */
function cleanTrackingParams(searchParams) {
  const cleaned = new URLSearchParams();
  for (const [key, value] of searchParams.entries()) {
    if (!TRACKING_PARAMS.has(key.toLowerCase())) {
      cleaned.append(key, value);
    }
  }
  return cleaned;
}

/**
 * Parse, validate and normalize video submission URLs
 * @param {string} rawUrl
 * @returns {{ platform: 'YOUTUBE'|'TIKTOK'|'INSTAGRAM', normalizedUrl: string, contentId: string|null, originalUrl: string }}
 */
export function parseAndNormalizeUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new InvalidSubmissionUrlError('URL must be a non-empty string');
  }

  const trimmed = rawUrl.trim();

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new InvalidSubmissionUrlError('Malformed URL format', { rawUrl });
  }

  // Enforce HTTP / HTTPS protocol only
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidSubmissionUrlError('Only HTTP and HTTPS protocols are allowed', {
      protocol: parsed.protocol
    });
  }

  const host = parsed.hostname.toLowerCase().replace(/^(www\.|m\.|web\.)/, '');
  const pathname = parsed.pathname.replace(/\/+$/, ''); // Strip trailing slash

  // ==========================================
  // 1. YouTube
  // ==========================================
  if (host === 'youtube.com' || host === 'youtu.be' || host === 'gaming.youtube.com') {
    let contentId = null;
    let isShorts = false;

    if (host === 'youtu.be') {
      const match = pathname.match(/^\/([A-Za-z0-9_-]{6,15})/);
      if (match) {
        contentId = match[1];
      }
    } else if (pathname.startsWith('/shorts/')) {
      const match = pathname.match(/^\/shorts\/([A-Za-z0-9_-]{6,15})/);
      if (match) {
        contentId = match[1];
        isShorts = true;
      }
    } else if (pathname.startsWith('/watch')) {
      contentId = parsed.searchParams.get('v');
    } else if (pathname.startsWith('/embed/')) {
      const match = pathname.match(/^\/embed\/([A-Za-z0-9_-]{6,15})/);
      if (match) {
        contentId = match[1];
      }
    }

    if (!contentId || !/^[A-Za-z0-9_-]{6,15}$/.test(contentId)) {
      throw new InvalidSubmissionUrlError('Could not extract a valid YouTube video ID from URL', {
        rawUrl
      });
    }

    const normalizedUrl = isShorts
      ? `https://www.youtube.com/shorts/${contentId}`
      : `https://www.youtube.com/watch?v=${contentId}`;

    return {
      platform: 'YOUTUBE',
      normalizedUrl,
      contentId,
      originalUrl: trimmed
    };
  }

  // ==========================================
  // 2. TikTok
  // ==========================================
  if (host === 'tiktok.com' || host === 'vm.tiktok.com' || host === 'vt.tiktok.com') {
    let contentId = null;

    if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com') {
      const match = pathname.match(/^\/([A-Za-z0-9_-]+)/);
      if (match) {
        contentId = match[1];
        return {
          platform: 'TIKTOK',
          normalizedUrl: `https://${host}/${contentId}`,
          contentId,
          originalUrl: trimmed
        };
      }
    }

    // Web TikTok: /@username/video/1234567890 or /v/1234567890
    const videoMatch = pathname.match(/\/(?:video|v)\/(\d+)/);
    if (videoMatch) {
      contentId = videoMatch[1];
      const userMatch = pathname.match(/^\/@([^/]+)/);
      const userPart = userMatch ? `@${userMatch[1].toLowerCase()}` : 'video';

      return {
        platform: 'TIKTOK',
        normalizedUrl: `https://www.tiktok.com/${userPart}/video/${contentId}`,
        contentId,
        originalUrl: trimmed
      };
    }

    throw new InvalidSubmissionUrlError('Could not extract a valid TikTok video ID from URL', {
      rawUrl
    });
  }

  // ==========================================
  // 3. Instagram
  // ==========================================
  if (host === 'instagram.com') {
    let match = pathname.match(/^\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
    let username = null;

    if (!match) {
      const userMatch = pathname.match(/^\/([A-Za-z0-9_.]+)\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
      if (userMatch && !['reel', 'reels', 'p', 'tv', 'explore', 'stories'].includes(userMatch[1].toLowerCase())) {
        username = userMatch[1];
        match = [userMatch[0], userMatch[2]];
      }
    }

    if (match) {
      const contentId = match[1];
      const isPost = pathname.includes('/p/');
      const normalizedUrl = isPost
        ? `https://www.instagram.com/p/${contentId}/`
        : `https://www.instagram.com/reel/${contentId}/`;

      return {
        platform: 'INSTAGRAM',
        normalizedUrl,
        contentId,
        username,
        originalUrl: trimmed
      };
    }

    throw new InvalidSubmissionUrlError('Could not extract a valid Instagram Reel or Post ID from URL', {
      rawUrl
    });
  }

  // ==========================================
  // 4. Facebook
  // ==========================================
  if (host === 'facebook.com' || host === 'fb.watch' || host === 'fb.me') {
    let contentId = null;

    if (host === 'fb.watch' || host === 'fb.me') {
      const match = pathname.match(/^\/([A-Za-z0-9_-]+)/);
      if (match) {
        contentId = match[1];
        return {
          platform: 'FACEBOOK',
          normalizedUrl: `https://fb.watch/${contentId}/`,
          contentId,
          originalUrl: trimmed
        };
      }
    }

    // /share/r/1234567890 or /share/v/1234567890
    const shareMatch = pathname.match(/^\/share\/(?:r|v)\/([A-Za-z0-9_-]+)/);
    if (shareMatch) {
      contentId = shareMatch[1];
      return {
        platform: 'FACEBOOK',
        normalizedUrl: `https://www.facebook.com/reel/${contentId}/`,
        contentId,
        originalUrl: trimmed
      };
    }

    // /reel/1234567890 or /reels/1234567890
    const reelMatch = pathname.match(/^\/(?:reel|reels)\/([A-Za-z0-9_-]+)/);
    if (reelMatch) {
      contentId = reelMatch[1];
      return {
        platform: 'FACEBOOK',
        normalizedUrl: `https://www.facebook.com/reel/${contentId}/`,
        contentId,
        originalUrl: trimmed
      };
    }

    // /watch/?v=1234567890 or /watch?v=1234567890 or /video.php?v=1234567890
    if (pathname.startsWith('/watch') || pathname.startsWith('/video.php')) {
      contentId = parsed.searchParams.get('v');
      if (contentId) {
        return {
          platform: 'FACEBOOK',
          normalizedUrl: `https://www.facebook.com/watch/?v=${contentId}`,
          contentId,
          originalUrl: trimmed
        };
      }
    }

    // /username/videos/1234567890 or /videos/1234567890
    const videoMatch = pathname.match(/\/(?:videos|video)\/(\d+)/);
    if (videoMatch) {
      contentId = videoMatch[1];
      return {
        platform: 'FACEBOOK',
        normalizedUrl: `https://www.facebook.com/watch/?v=${contentId}`,
        contentId,
        originalUrl: trimmed
      };
    }

    throw new InvalidSubmissionUrlError('Could not extract a valid Facebook Video or Reel ID from URL', {
      rawUrl
    });
  }

  // ==========================================
  // Unsupported Domain
  // ==========================================
  throw new UnsupportedPlatformError(parsed.hostname, { rawUrl });
}
