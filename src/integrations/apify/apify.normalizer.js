/**
 * Apify Scraper Output Normalizer
 *
 * Transforms heterogeneous Apify Actor datasets into standardized Peak Clip
 * provider payloads adhering to system invariants:
 * - BigInt numeric representation for views, likes, comments, shares
 * - Transparent metadata tracking for rounded/estimated counts (e.g. "3.2M")
 * - UTC Date instances for publication timestamps
 * - Precise availability mapping without fabricating data
 */

/**
 * Parses count value, detecting and flagging rounded strings (e.g., 3.2M, 15K)
 *
 * @param {any} val
 * @returns {{ value: bigint|null, isRounded: boolean, raw: string|null }}
 */
export function parseCount(val) {
  if (val === null || val === undefined || val === '') {
    return { value: null, isRounded: false, raw: null };
  }

  if (typeof val === 'bigint') {
    return { value: val, isRounded: false, raw: val.toString() };
  }

  if (typeof val === 'number') {
    if (isNaN(val) || val < 0) {
      return { value: null, isRounded: false, raw: String(val) };
    }
    return { value: BigInt(Math.floor(val)), isRounded: false, raw: String(val) };
  }

  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (/^\d+$/.test(trimmed)) {
      try {
        return { value: BigInt(trimmed), isRounded: false, raw: trimmed };
      } catch {
        return { value: null, isRounded: false, raw: trimmed };
      }
    }

    // Detect K / M / B abbreviations (e.g., "3.2M", "45K", "1.5B")
    const match = trimmed.match(/^([\d.,]+)\s*([kKmMbB])$/);
    if (match) {
      const numericPart = parseFloat(match[1].replace(/,/g, ''));
      const unit = match[2].toLowerCase();
      const multiplier = unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1_000_000_000;

      if (!isNaN(numericPart)) {
        return {
          value: BigInt(Math.floor(numericPart * multiplier)),
          isRounded: true,
          raw: trimmed
        };
      }
    }
  }

  return { value: null, isRounded: false, raw: String(val) };
}

/**
 * Parses a date or timestamp into a valid UTC Date
 *
 * @param {any} val
 * @returns {Date|null}
 */
export function parseDate(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;

  if (typeof val === 'number') {
    const ms = val < 10_000_000_000 ? val * 1000 : val;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }

  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (/^\d+$/.test(trimmed)) {
      const num = parseInt(trimmed, 10);
      const ms = num < 10_000_000_000 ? num * 1000 : num;
      const d = new Date(ms);
      return isNaN(d.getTime()) ? null : d;
    }

    const d = new Date(trimmed);
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}

/**
 * Normalize TikTok Apify scraper output
 *
 * Supports schemas from:
 * - clockworks/free-tiktok-scraper
 * - clockworks/tiktok-scraper
 * - apify/tiktok-scraper
 *
 * @param {object} item - Raw dataset item from Apify
 * @param {string} originalUrl - The submitted video URL
 * @returns {object} Standardized provider result
 */
export function normalizeTikTokOutput(item, originalUrl) {
  if (!item || typeof item !== 'object') {
    return {
      status: 'DATA_UNAVAILABLE',
      platform: 'TIKTOK',
      isAvailable: false,
      views: null,
      likes: null,
      comments: null,
      shares: null,
      publishedAt: null,
      durationSeconds: null,
      availability: {
        views: 'UNAVAILABLE',
        likes: 'UNAVAILABLE',
        comments: 'UNAVAILABLE',
        shares: 'UNAVAILABLE',
        duration: 'UNAVAILABLE'
      },
      reason: 'Empty or invalid item returned from TikTok scraper'
    };
  }

  // Detect explicit errors or private/deleted status reported by scraper
  if (
    item.error === 'not_found' ||
    item.error === 'video_deleted' ||
    item.privateItem === true ||
    item.statusCode === 10204 ||
    item.statusCode === 10221 ||
    item.isPrivate === true
  ) {
    return {
      status: 'NOT_FOUND',
      platform: 'TIKTOK',
      isAvailable: false,
      isPermanentDisappearance: true,
      reason: item.error || (item.privateItem ? 'Video is private' : 'Video was deleted or not found')
    };
  }

  const rawViews = item.playCount ?? item.viewsCount ?? item.views ?? item.stats?.playCount;
  const rawLikes = item.diggCount ?? item.likesCount ?? item.likes ?? item.stats?.diggCount;
  const rawComments = item.commentCount ?? item.commentsCount ?? item.comments ?? item.stats?.commentCount;
  const rawShares = item.shareCount ?? item.sharesCount ?? item.shares ?? item.stats?.shareCount;

  const viewsData = parseCount(rawViews);
  const likesData = parseCount(rawLikes);
  const commentsData = parseCount(rawComments);
  const sharesData = parseCount(rawShares);

  const rawPublishedAt = item.createTimeISO ?? item.createTime ?? item.postPage?.createTime ?? item.uploadedAt;
  const publishedAt = parseDate(rawPublishedAt);

  const rawDuration = item.duration ?? item.videoMeta?.duration ?? item.video?.duration;
  let durationSeconds = null;
  if (rawDuration != null) {
    const durNum = Number(rawDuration);
    if (!isNaN(durNum) && durNum > 0) {
      durationSeconds = Math.round(durNum);
    }
  }

  const author = item.authorMeta?.name || item.authorMeta?.nickName || item.author?.uniqueId || item.author?.nickname || null;
  const contentId = item.id || item.videoId || null;

  return {
    status: 'AVAILABLE',
    platform: 'TIKTOK',
    isAvailable: true,
    views: viewsData.value,
    likes: likesData.value,
    comments: commentsData.value,
    shares: sharesData.value,
    publishedAt: publishedAt ? publishedAt.toISOString() : null,
    durationSeconds,
    availability: {
      views: viewsData.value !== null ? 'AVAILABLE' : 'UNAVAILABLE',
      likes: likesData.value !== null ? 'AVAILABLE' : 'UNAVAILABLE',
      comments: commentsData.value !== null ? 'AVAILABLE' : 'UNAVAILABLE',
      shares: sharesData.value !== null ? 'AVAILABLE' : 'UNAVAILABLE',
      duration: durationSeconds !== null ? 'AVAILABLE' : 'NOT_SUPPORTED'
    },
    metadata: {
      source: 'APIFY_SCRAPER',
      author,
      contentId,
      originalUrl,
      isRounded: viewsData.isRounded || likesData.isRounded,
      rawViews: viewsData.raw,
      rawLikes: likesData.raw,
      rawComments: commentsData.raw,
      rawShares: sharesData.raw
    }
  };
}

/**
 * Normalize Facebook Apify scraper output
 *
 * Supports schemas from:
 * - apify/facebook-reels-scraper
 * - apify/facebook-posts-scraper
 * - scrapers-delight/facebook-reels-scraper
 *
 * @param {object} item - Raw dataset item from Apify
 * @param {string} originalUrl - The submitted video URL
 * @returns {object} Standardized provider result
 */
export function normalizeFacebookOutput(item, originalUrl) {
  if (!item || typeof item !== 'object') {
    return {
      status: 'DATA_UNAVAILABLE',
      platform: 'FACEBOOK',
      isAvailable: false,
      views: null,
      likes: null,
      comments: null,
      shares: null,
      publishedAt: null,
      durationSeconds: null,
      availability: {
        views: 'UNAVAILABLE',
        likes: 'UNAVAILABLE',
        comments: 'UNAVAILABLE',
        shares: 'UNAVAILABLE',
        duration: 'UNAVAILABLE'
      },
      reason: 'Empty or invalid item returned from Facebook scraper'
    };
  }

  // Detect deletion / private / removed
  if (
    item.error === 'not_found' ||
    item.error === 'post_deleted' ||
    item.isDeleted === true ||
    item.isPrivate === true ||
    item.unavailable === true
  ) {
    return {
      status: 'NOT_FOUND',
      platform: 'FACEBOOK',
      isAvailable: false,
      isPermanentDisappearance: true,
      reason: item.error || 'Facebook video/reel was removed or is private'
    };
  }

  const rawViews = item.viewCount ?? item.viewsCount ?? item.playCount ?? item.views ?? item.videoViewCount ?? item.video?.viewsCount;
  const rawLikes = item.reactionCount ?? item.likesCount ?? item.likes ?? item.reactionsCount ?? item.reactions ?? item.likers?.count ?? item.unified_reactors?.count;
  const rawComments = item.commentsCount ?? item.commentCount ?? item.comments ?? item.total_comment_count;
  const rawShares = item.sharesCount ?? item.shareCount ?? item.shares ?? item.share_count_reduced ?? item.share_count;

  const viewsData = parseCount(rawViews);
  const likesData = parseCount(rawLikes);
  const commentsData = parseCount(rawComments);
  const sharesData = parseCount(rawShares);

  const rawPublishedAt = item.timestamp ?? item.time ?? item.date ?? item.publishedAt ?? item.createdTime ?? item.creation_time;
  const publishedAt = parseDate(rawPublishedAt);

  const rawDuration = item.duration ?? item.length ?? item.videoDuration ?? item.video?.duration;
  let durationSeconds = null;
  if (rawDuration != null) {
    const durNum = Number(rawDuration);
    if (!isNaN(durNum) && durNum > 0) {
      durationSeconds = Math.round(durNum);
    }
  }

  const author = item.authorName || item.pageName || item.owner?.name || item.user?.name || null;
  const contentId = item.facebookId || item.postId || item.reelId || item.id || null;

  return {
    status: 'AVAILABLE',
    platform: 'FACEBOOK',
    isAvailable: true,
    views: viewsData.value,
    likes: likesData.value,
    comments: commentsData.value,
    shares: sharesData.value,
    publishedAt: publishedAt ? publishedAt.toISOString() : null,
    durationSeconds,
    availability: {
      views: viewsData.value !== null ? 'AVAILABLE' : 'UNAVAILABLE',
      likes: likesData.value !== null ? 'AVAILABLE' : 'UNAVAILABLE',
      comments: commentsData.value !== null ? 'AVAILABLE' : 'UNAVAILABLE',
      shares: sharesData.value !== null ? 'AVAILABLE' : 'UNAVAILABLE',
      duration: durationSeconds !== null ? 'AVAILABLE' : 'NOT_SUPPORTED'
    },
    metadata: {
      source: 'APIFY_SCRAPER',
      author,
      contentId,
      originalUrl,
      isRounded: viewsData.isRounded || likesData.isRounded,
      rawViews: viewsData.raw,
      rawLikes: likesData.raw,
      rawComments: commentsData.raw,
      rawShares: sharesData.raw
    }
  };
}

/**
 * Normalize Instagram Apify scraper output
 *
 * Supports schemas from:
 * - apify/instagram-scraper
 * - apify/instagram-post-scraper
 *
 * @param {object} item - Raw dataset item from Apify
 * @param {string} originalUrl - The submitted video URL
 * @returns {object} Standardized provider result
 */
export function normalizeInstagramOutput(item, originalUrl) {
  if (!item || typeof item !== 'object') {
    return {
      status: 'DATA_UNAVAILABLE',
      platform: 'INSTAGRAM',
      isAvailable: false,
      views: null,
      likes: null,
      comments: null,
      shares: null,
      publishedAt: null,
      durationSeconds: null,
      availability: {
        views: 'UNAVAILABLE',
        likes: 'UNAVAILABLE',
        comments: 'UNAVAILABLE',
        shares: 'NOT_SUPPORTED',
        duration: 'NOT_SUPPORTED'
      },
      reason: 'Empty or invalid item returned from Instagram scraper'
    };
  }

  // Detect explicit errors or private/deleted status reported by scraper
  if (
    item.error === 'not_found' ||
    item.error === 'post_deleted' ||
    item.isDeleted === true ||
    item.isPrivate === true ||
    item.private === true ||
    item.unavailable === true
  ) {
    return {
      status: 'NOT_FOUND',
      platform: 'INSTAGRAM',
      isAvailable: false,
      isPermanentDisappearance: true,
      reason: item.error || (item.isPrivate || item.private ? 'Instagram post is private' : 'Instagram post was deleted or not found')
    };
  }

  const rawViews = item.videoPlayCount ?? item.videoViewCount ?? item.playCount ?? item.viewCount ?? item.viewsCount ?? item.views;
  const rawLikes = item.likesCount ?? item.likeCount ?? item.likes;
  const rawComments = item.commentsCount ?? item.commentCount ?? item.comments;
  const rawShares = item.sharesCount ?? item.shareCount ?? item.shares;

  const viewsData = parseCount(rawViews);
  const likesData = parseCount(rawLikes);
  const commentsData = parseCount(rawComments);
  const sharesData = parseCount(rawShares);

  const rawPublishedAt = item.timestamp ?? item.createTimeISO ?? item.createTime ?? item.publishedAt ?? item.takenAtTimestamp;
  const publishedAt = parseDate(rawPublishedAt);

  const rawDuration = item.videoDuration ?? item.duration ?? item.videoDurationInSeconds;
  let durationSeconds = null;
  if (rawDuration != null) {
    const durNum = Number(rawDuration);
    if (!isNaN(durNum) && durNum > 0) {
      durationSeconds = Math.round(durNum);
    }
  }

  const author = item.ownerUsername || item.username || item.owner?.username || item.author?.username || null;
  const contentId = item.shortCode || item.shortcode || item.id || null;

  return {
    status: 'AVAILABLE',
    platform: 'INSTAGRAM',
    isAvailable: true,
    views: viewsData.value,
    likes: likesData.value,
    comments: commentsData.value,
    shares: sharesData.value,
    publishedAt: publishedAt ? publishedAt.toISOString() : null,
    durationSeconds,
    availability: {
      views: viewsData.value !== null ? 'AVAILABLE' : 'UNAVAILABLE',
      likes: likesData.value !== null ? 'AVAILABLE' : 'UNAVAILABLE',
      comments: commentsData.value !== null ? 'AVAILABLE' : 'UNAVAILABLE',
      shares: 'NOT_SUPPORTED',
      duration: durationSeconds !== null ? 'AVAILABLE' : 'NOT_SUPPORTED'
    },
    metadata: {
      source: 'APIFY_SCRAPER',
      author,
      contentId,
      originalUrl,
      isRounded: viewsData.isRounded || likesData.isRounded,
      rawViews: viewsData.raw,
      rawLikes: likesData.raw,
      rawComments: commentsData.raw,
      rawShares: sharesData.raw
    }
  };
}
