import { prisma as defaultPrisma } from '../../database/client.js';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

export class PayoutProfileError extends AppError {
  constructor(message, code = 'PAYOUT_PROFILE_ERROR', statusCode = 400, details = {}) {
    super(message, code, statusCode, details);
    this.name = 'PayoutProfileError';
  }
}

/**
 * Mask a public wallet address for safe display in Discord embeds
 * Example: 0x1234••••••••••7890 or 4Nd1••••••••••9ZqX
 *
 * @param {string} address
 * @returns {string}
 */
export function maskWalletAddress(address) {
  if (!address || typeof address !== 'string') return 'N/A';
  const trimmed = address.trim();
  if (trimmed.length <= 10) {
    return `${trimmed.slice(0, 3)}••••••••••${trimmed.slice(-2)}`;
  }
  const prefixLength = trimmed.startsWith('0x') ? 6 : 4;
  const suffixLength = 4;
  return `${trimmed.slice(0, prefixLength)}••••••••••${trimmed.slice(-suffixLength)}`;
}

export class PayoutProfileService {
  constructor(dbClient = defaultPrisma) {
    this.prisma = dbClient;
  }

  /**
   * Validate raw profile inputs
   * @param {object} data
   * @returns {object} normalized
   */
  validateProfileData(data) {
    const walletAddress = (data.walletAddress || '').trim();
    const network = (data.network || '').toUpperCase().trim();
    const walletName = (data.walletName || 'Standard').trim();
    const creatorHandle = (data.creatorHandle || data.discordHandle || data.username || 'Creator').trim();
    const rawPlatform = (data.platform || 'YOUTUBE').toUpperCase().trim();

    if (!walletAddress || walletAddress.length < 8) {
      throw new PayoutProfileError('A valid wallet address must be provided (minimum 8 characters).', 'INVALID_WALLET');
    }

    if (!network || network.length < 2) {
      throw new PayoutProfileError('A payment network must be specified (e.g. SOLANA, ETHEREUM, POLYGON, BASE).', 'INVALID_NETWORK');
    }

    const allowedPlatforms = ['YOUTUBE', 'TIKTOK', 'INSTAGRAM', 'FACEBOOK'];
    if (data.platform && !allowedPlatforms.includes(rawPlatform)) {
      throw new PayoutProfileError(`Invalid platform. Allowed platforms: ${allowedPlatforms.join(', ')}`, 'INVALID_PLATFORM');
    }
    const platform = allowedPlatforms.includes(rawPlatform) ? rawPlatform : 'YOUTUBE';

    return {
      walletAddress,
      network,
      walletName: walletName || 'Standard',
      creatorHandle: creatorHandle || 'Creator',
      platform
    };
  }

  /**
   * Retrieve active payout profile by internal user UUID
   * @param {string} userId
   * @param {object} [tx=null]
   * @returns {Promise<object|null>}
   */
  async getProfileByUserId(userId, tx = null) {
    const client = (tx && tx.payoutProfile) ? tx : this.prisma;
    if (!client?.payoutProfile?.findUnique) {
      return null;
    }
    return client.payoutProfile.findUnique({
      where: { userId }
    });
  }

  /**
   * Alias for getProfileByUserId
   */
  async getProfile(userId, tx = null) {
    return this.getProfileByUserId(userId, tx);
  }

  /**
   * Upsert helper: creates if new, updates if exists
   */
  async saveProfile(userId, data, actor = null, tx = null) {
    const client = (tx && tx.payoutProfile) ? tx : this.prisma;
    const existing = await client.payoutProfile.findUnique({ where: { userId } });
    if (existing) {
      return this.updateProfile(userId, data, actor, tx);
    }
    return this.createProfile(userId, data, actor, tx);
  }

  /**
   * Create creator payout profile
   *
   * @param {string|object} userIdOrData
   * @param {object} dataOrActor
   * @param {object} [actorOrTx=null]
   * @param {object} [tx=null]
   * @returns {Promise<object>}
   */
  async createProfile(userIdOrData, dataOrActor, actorOrTx = null, tx = null) {
    let userId;
    let data;
    let actor;
    let clientTx = tx;

    if (typeof userIdOrData === 'object' && userIdOrData !== null && userIdOrData.userId) {
      userId = userIdOrData.userId;
      data = userIdOrData;
      actor = dataOrActor;
      clientTx = actorOrTx || tx;
    } else {
      userId = userIdOrData;
      data = dataOrActor || {};
      actor = actorOrTx;
    }

    const validated = this.validateProfileData({
      ...data,
      creatorHandle: data.creatorHandle || actor?.username || actor?.discordId || 'Creator'
    });
    const client = clientTx || this.prisma;

    const existing = await client.payoutProfile.findUnique({ where: { userId } });
    if (existing) {
      throw new PayoutProfileError('A payout profile already exists for this creator. Please use the update flow.', 'PROFILE_ALREADY_EXISTS');
    }

    const profile = await client.payoutProfile.create({
      data: {
        userId,
        walletAddress: validated.walletAddress,
        network: validated.network,
        walletName: validated.walletName,
        creatorHandle: validated.creatorHandle,
        platform: validated.platform,
        verifiedAt: new Date()
      }
    });

    // Record audit event WITHOUT storing full raw wallet address
    if (client.payoutProfileAudit) {
      await client.payoutProfileAudit.create({
        data: {
          userId,
          action: 'CREATE',
          actorUserId: actor?.userId || userId,
          actorDiscordId: actor?.discordId || 'SYSTEM',
          newNetwork: validated.network,
          newWalletName: validated.walletName,
          platform: validated.platform,
          walletAddressChanged: true,
          metadata: {
            maskedAddress: maskWalletAddress(validated.walletAddress)
          }
        }
      });
    }

    logger.info({ userId, network: validated.network, actorDiscordId: actor?.discordId }, 'Creator payout profile created');
    return profile;
  }

  /**
   * Update creator payout profile
   *
   * @param {string} userId
   * @param {object} data
   * @param {object} actor - { discordId, userId }
   * @param {object} [tx=null]
   * @returns {Promise<object>}
   */
  async updateProfile(userId, data, actor, tx = null) {
    const client = tx || this.prisma;

    const existing = await client.payoutProfile.findUnique({ where: { userId } });
    if (!existing) {
      throw new PayoutProfileError('Payout profile not found. Please create your profile first.', 'PROFILE_NOT_FOUND');
    }

    const validated = this.validateProfileData({
      ...data,
      creatorHandle: data.creatorHandle || existing.creatorHandle || actor?.username || 'Creator',
      platform: data.platform || existing.platform || 'YOUTUBE'
    });

    const walletAddressChanged = existing.walletAddress !== validated.walletAddress;

    const updated = await client.payoutProfile.update({
      where: { userId },
      data: {
        walletAddress: validated.walletAddress,
        network: validated.network,
        walletName: validated.walletName,
        creatorHandle: validated.creatorHandle,
        platform: validated.platform,
        updatedAt: new Date()
      }
    });

    // Record audit event WITHOUT storing raw full address
    if (client.payoutProfileAudit) {
      await client.payoutProfileAudit.create({
        data: {
          userId,
          action: 'UPDATE',
          actorUserId: actor?.userId || userId,
          actorDiscordId: actor?.discordId || 'SYSTEM',
          oldNetwork: existing.network,
          newNetwork: validated.network,
          oldWalletName: existing.walletName,
          newWalletName: validated.walletName,
          platform: validated.platform,
          walletAddressChanged,
          metadata: {
            maskedAddress: maskWalletAddress(validated.walletAddress),
            previousMaskedAddress: maskWalletAddress(existing.walletAddress)
          }
        }
      });
    }

    logger.info(
      { userId, network: validated.network, walletAddressChanged, actorDiscordId: actor?.discordId },
      'Creator payout profile updated'
    );

    return updated;
  }
}

export const payoutProfileService = new PayoutProfileService();
export default payoutProfileService;
