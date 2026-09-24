/**
 * Deterministic YouTube Data API v3 fixtures
 */

export const YOUTUBE_FIXTURES = {
  // Standard video with all metrics
  STANDARD_VIDEO: {
    kind: 'youtube#videoListResponse',
    items: [
      {
        id: 'dQw4w9WgXcQ',
        snippet: {
          title: 'Rick Astley - Never Gonna Give You Up (Official Music Video)',
          channelTitle: 'Rick Astley',
          publishedAt: '2009-10-25T06:57:33Z',
          channelId: 'UCuAXFkgsw1L7xaCfnd5JJOw'
        },
        status: {
          uploadStatus: 'processed',
          privacyStatus: 'public'
        },
        statistics: {
          viewCount: '1500000',
          likeCount: '150000',
          commentCount: '25000'
        }
      }
    ]
  },

  // Video with hidden likes (likeCount omitted by creator)
  HIDDEN_LIKES_VIDEO: {
    kind: 'youtube#videoListResponse',
    items: [
      {
        id: 'vid_hidden_likes',
        snippet: {
          title: 'Video with Hidden Likes',
          channelTitle: 'Sample Channel',
          publishedAt: '2026-01-10T12:00:00Z',
          channelId: 'UC123456789'
        },
        status: {
          uploadStatus: 'processed',
          privacyStatus: 'public'
        },
        statistics: {
          viewCount: '50000',
          commentCount: '1200'
        }
      }
    ]
  },

  // Video with disabled comments (commentCount omitted)
  DISABLED_COMMENTS_VIDEO: {
    kind: 'youtube#videoListResponse',
    items: [
      {
        id: 'vid_no_comments',
        snippet: {
          title: 'Video with Comments Disabled',
          channelTitle: 'Sample Channel',
          publishedAt: '2026-02-15T12:00:00Z',
          channelId: 'UC123456789'
        },
        status: {
          uploadStatus: 'processed',
          privacyStatus: 'public'
        },
        statistics: {
          viewCount: '25000',
          likeCount: '800'
        }
      }
    ]
  },

  // Newly published video with exactly zero views
  ZERO_VIEWS_VIDEO: {
    kind: 'youtube#videoListResponse',
    items: [
      {
        id: 'vid_zero_views',
        snippet: {
          title: 'Brand New Upload',
          channelTitle: 'Creator Channel',
          publishedAt: '2026-09-20T10:00:00Z',
          channelId: 'UC999999'
        },
        status: {
          uploadStatus: 'processed',
          privacyStatus: 'public'
        },
        statistics: {
          viewCount: '0',
          likeCount: '0',
          commentCount: '0'
        }
      }
    ]
  },

  // Private video
  PRIVATE_VIDEO: {
    kind: 'youtube#videoListResponse',
    items: [
      {
        id: 'vid_private',
        snippet: {
          title: 'Private Video',
          channelTitle: 'Private Channel'
        },
        status: {
          uploadStatus: 'processed',
          privacyStatus: 'private'
        },
        statistics: {
          viewCount: '10'
        }
      }
    ]
  },

  // Rejected / deleted video by YouTube
  REJECTED_VIDEO: {
    kind: 'youtube#videoListResponse',
    items: [
      {
        id: 'vid_rejected',
        snippet: {
          title: 'Violated Terms'
        },
        status: {
          uploadStatus: 'rejected',
          privacyStatus: 'public'
        }
      }
    ]
  },

  // Empty response when video is completely deleted or 404
  DELETED_OR_NOT_FOUND: {
    kind: 'youtube#videoListResponse',
    items: []
  },

  // Quota exceeded error response
  QUOTA_EXCEEDED_BODY: JSON.stringify({
    error: {
      code: 403,
      message: 'The request cannot be completed because you have exceeded your quota.',
      errors: [
        {
          message: 'The request cannot be completed because you have exceeded your quota.',
          domain: 'youtube.quota',
          reason: 'quotaExceeded'
        }
      ]
    }
  }),

  // Bad API key error response
  INVALID_API_KEY_BODY: JSON.stringify({
    error: {
      code: 400,
      message: 'API key not valid. Please pass a valid API key.',
      errors: [
        {
          message: 'API key not valid. Please pass a valid API key.',
          domain: 'global',
          reason: 'keyInvalid'
        }
      ]
    }
  })
};
