import { prisma } from '../../database/client.js';

export class UserRepository {
  constructor(dbClient = prisma) {
    this.db = dbClient;
  }

  /**
   * Find a user by internal UUID
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async findById(id) {
    return this.db.user.findUnique({
      where: { id }
    });
  }

  /**
   * Find a user by Discord snowflake ID
   * @param {string} discordId
   * @returns {Promise<object|null>}
   */
  async findByDiscordId(discordId) {
    return this.db.user.findUnique({
      where: { discordId }
    });
  }

  /**
   * Create or update a user from their Discord identity
   * Idempotent: creates if new, updates profile & lastSeenAt if existing
   * @param {object} params
   * @param {string} params.discordId
   * @param {string} params.username
   * @param {string|null} [params.displayName]
   * @param {string|null} [params.avatarUrl]
   * @returns {Promise<object>}
   */
  async upsertFromDiscord({ discordId, username, displayName = null, avatarUrl = null }) {
    const now = new Date();
    return this.db.user.upsert({
      where: { discordId },
      update: {
        username,
        displayName,
        avatarUrl,
        lastSeenAt: now
      },
      create: {
        discordId,
        username,
        displayName,
        avatarUrl,
        status: 'ACTIVE',
        lastSeenAt: now
      }
    });
  }

  /**
   * Update the user's last seen timestamp
   * @param {string} id
   * @returns {Promise<object>}
   */
  async updateLastSeen(id) {
    return this.db.user.update({
      where: { id },
      data: { lastSeenAt: new Date() }
    });
  }

  /**
   * Update the user status (e.g. ACTIVE, SUSPENDED, BANNED)
   * @param {string} id
   * @param {'ACTIVE'|'SUSPENDED'|'BANNED'} status
   * @returns {Promise<object>}
   */
  async updateStatus(id, status) {
    return this.db.user.update({
      where: { id },
      data: { status }
    });
  }

  /**
   * Find user with their campaign memberships
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async findWithMemberships(id) {
    return this.db.user.findUnique({
      where: { id },
      include: {
        campaignMemberships: {
          include: {
            campaign: true
          }
        }
      }
    });
  }
}

export const userRepository = new UserRepository();
export default userRepository;
