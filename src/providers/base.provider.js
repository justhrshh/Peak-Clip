/**
 * Abstract base provider defining the contract for social video platform integrations
 */
export class BasePlatformProvider {
  /**
   * @param {string} platform - E.g. 'YOUTUBE', 'TIKTOK', 'INSTAGRAM'
   */
  constructor(platform) {
    if (new.target === BasePlatformProvider) {
      throw new TypeError('Cannot construct BasePlatformProvider instances directly');
    }
    this.platform = platform;
  }


  get name() {
    return this.platform;
  }

  /**
   * Fetch video metadata (title, author, publishedAt)
   * @param {string} contentId
   * @returns {Promise<object>}
   */
  async getVideo(contentId) {
    throw new Error(`getVideo() not implemented for provider ${this.platform}`);
  }

  /**
   * Fetch live engagement metrics
   * @param {string} contentId
   * @returns {Promise<{ views: bigint|null, likes: bigint|null, comments: bigint|null, shares: bigint|null, status?: string, reason?: string, metadata?: object }>}
   */
  async getCurrentMetrics(contentId) {
    throw new Error(`getCurrentMetrics() not implemented for provider ${this.platform}`);
  }

  /**
   * Fetch live engagement metrics (worker alias for getCurrentMetrics)
   * @param {string} contentId
   * @returns {Promise<object>}
   */
  async getVideoMetrics(contentId) {
    return this.getCurrentMetrics(contentId);
  }

  /**
   * Fetch author/channel details
   * @param {string} contentId
   * @returns {Promise<object>}
   */
  async getAuthor(contentId) {
    throw new Error(`getAuthor() not implemented for provider ${this.platform}`);
  }

  /**
   * Check if the video is publicly accessible
   * @param {string} contentId
   * @returns {Promise<{ isAvailable: boolean, status: string, reason?: string }>}
   */
  async getAvailability(contentId) {
    throw new Error(`getAvailability() not implemented for provider ${this.platform}`);
  }

  /**
   * Fetch video clip duration in seconds
   * @param {string} contentId
   * @returns {Promise<{ durationSeconds: number|null, status: string, reason?: string }>}
   */
  async getDuration(contentId) {
    throw new Error(`getDuration() not implemented for provider ${this.platform}`);
  }
}
