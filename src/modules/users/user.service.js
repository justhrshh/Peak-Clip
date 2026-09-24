import { userRepository as defaultUserRepo } from './user.repository.js';
import { UserNotFoundError, UserSuspendedError, UserBannedError } from './user.errors.js';
import { logger } from '../../utils/logger.js';

export class UserService {
  constructor(userRepo = defaultUserRepo) {
    this.userRepo = userRepo;
  }

  /**
   * Idempotently get or create a platform user from Discord identity
   * @param {object} discordUser - Discord User object or partial
   * @param {string} discordUser.id - Discord snowflake ID
   * @param {string} discordUser.username
   * @param {string} [discordUser.globalName]
   * @param {string} [discordUser.displayName]
   * @param {string} [discordUser.avatar]
   * @param {Function} [discordUser.displayAvatarURL]
   * @returns {Promise<object>}
   */
  async getOrCreateFromDiscord(discordUser) {
    if (!discordUser || !discordUser.id) {
      throw new Error('Valid Discord user identity is required');
    }

    const discordId = String(discordUser.id);
    const username = discordUser.username || `user_${discordId}`;
    const displayName = discordUser.displayName || discordUser.globalName || null;

    let avatarUrl = null;
    if (typeof discordUser.displayAvatarURL === 'function') {
      avatarUrl = discordUser.displayAvatarURL({ extension: 'png', size: 256 });
    } else if (discordUser.avatar) {
      avatarUrl = `https://cdn.discordapp.com/avatars/${discordId}/${discordUser.avatar}.png`;
    }

    logger.debug({ discordId, username }, 'Syncing Discord user profile');

    return this.userRepo.upsertFromDiscord({
      discordId,
      username,
      displayName,
      avatarUrl
    });
  }

  /**
   * Retrieve a user by their Discord snowflake ID
   * @param {string} discordId
   * @returns {Promise<object|null>}
   */
  async getByDiscordId(discordId) {
    if (!discordId) return null;
    return this.userRepo.findByDiscordId(String(discordId));
  }

  /**
   * Get user profile by internal UUID
   * @param {string} userId
   * @returns {Promise<object>}
   */
  async getProfile(userId) {
    const user = await this.userRepo.findWithMemberships(userId);
    if (!user) {
      throw new UserNotFoundError(userId);
    }
    return user;
  }

  /**
   * Update user last seen timestamp
   * @param {string} userId
   * @returns {Promise<object>}
   */
  async updateLastSeen(userId) {
    return this.userRepo.updateLastSeen(userId);
  }

  /**
   * Assert user is active and allowed to participate in campaigns
   * @param {object} user
   * @throws {UserSuspendedError|UserBannedError}
   */
  assertUserCanParticipate(user) {
    if (!user) {
      throw new UserNotFoundError('unknown');
    }

    if (user.status === 'SUSPENDED') {
      throw new UserSuspendedError(user.id);
    }

    if (user.status === 'BANNED') {
      throw new UserBannedError(user.id);
    }

    if (user.status !== 'ACTIVE') {
      throw new Error(`User account is inactive (${user.status})`);
    }

    return true;
  }
}

export const userService = new UserService();
export default userService;
