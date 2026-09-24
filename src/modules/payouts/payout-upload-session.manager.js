import crypto from 'node:crypto';
import { prisma as defaultPrisma } from '../../database/client.js';
import { logger } from '../../utils/logger.js';

export const UPLOAD_SESSION_STATUS = Object.freeze({
  WAITING_FOR_UPLOAD: 'WAITING_FOR_UPLOAD',
  PROCESSING: 'PROCESSING',
  EVIDENCE_READY: 'EVIDENCE_READY',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED'
});

export const UPLOAD_SESSION_TTL_MS = 2 * 60 * 1000; // 2 minutes strict

export class PayoutUploadSessionManager {
  constructor(dbClient = defaultPrisma, ttlMs = UPLOAD_SESSION_TTL_MS) {
    this.prisma = dbClient;
    this.ttlMs = ttlMs;
    this.inMemorySessions = new Map();
  }

  _getKey(discordUserId) {
    return `upload_session:payout:${discordUserId}`;
  }

  /**
   * Authoritatively create / refresh an upload session
   * @param {object} params
   * @param {string} params.discordUserId
   * @param {string} params.userId
   * @param {string} params.guildId
   * @param {string} params.channelId
   * @param {string} params.amount
   * @param {string} [params.currency='USD']
   * @param {object} [params.profileSnapshot]
   * @param {number} [params.customTtlMs]
   * @returns {Promise<object>}
   */
  async createSession({
    discordUserId,
    userId,
    guildId,
    channelId,
    amount,
    currency = 'USD',
    profileSnapshot = null,
    customTtlMs = null
  }) {
    const now = Date.now();
    const effectiveTtl = customTtlMs || this.ttlMs;
    const sessionData = {
      sessionId: crypto.randomUUID(),
      discordUserId,
      userId,
      guildId,
      channelId,
      amount: String(amount),
      currency,
      profileSnapshot,
      status: UPLOAD_SESSION_STATUS.WAITING_FOR_UPLOAD,
      createdAt: now,
      expiresAt: now + effectiveTtl,
      evidence: null
    };

    this.inMemorySessions.set(discordUserId, sessionData);

    // Persist to database if available
    try {
      if (this.prisma?.systemSetting?.upsert) {
        await this.prisma.systemSetting.upsert({
          where: { key: this._getKey(discordUserId) },
          create: {
            key: this._getKey(discordUserId),
            value: JSON.stringify(sessionData)
          },
          update: {
            value: JSON.stringify(sessionData)
          }
        });
      }
    } catch (err) {
      logger.warn({ err: err.message, discordUserId }, 'Failed to persist upload session to database; falling back to memory');
    }

    logger.debug({ discordUserId, channelId, sessionId: sessionData.sessionId }, 'Payout upload session activated');
    return sessionData;
  }

  /**
   * Retrieve active upload session by discordUserId
   * @param {string} discordUserId
   * @returns {Promise<object|null>}
   */
  async getSession(discordUserId) {
    let session = this.inMemorySessions.get(discordUserId);

    if (!session && this.prisma?.systemSetting?.findUnique) {
      try {
        const record = await this.prisma.systemSetting.findUnique({
          where: { key: this._getKey(discordUserId) }
        });
        if (record?.value) {
          session = JSON.parse(record.value);
          this.inMemorySessions.set(discordUserId, session);
        }
      } catch (err) {
        logger.debug({ err: err.message, discordUserId }, 'Error fetching upload session from database');
      }
    }

    if (!session) return null;

    // Check expiration
    if (Date.now() > session.expiresAt) {
      session.isExpired = true;
      session.status = UPLOAD_SESSION_STATUS.EXPIRED;
      return session;
    }

    return session;
  }

  /**
   * Atomically validate ownership/channel and transition to PROCESSING
   * @param {string} discordUserId
   * @param {object} context - { guildId, channelId }
   * @returns {Promise<object>} result
   */
  async transitionToProcessing(discordUserId, { guildId, channelId } = {}) {
    const session = await this.getSession(discordUserId);

    if (!session) {
      return { notFound: true };
    }

    if (session.isExpired || Date.now() > session.expiresAt || session.status === UPLOAD_SESSION_STATUS.EXPIRED) {
      return { expired: true, session };
    }

    if (guildId && session.guildId && session.guildId !== guildId) {
      return { wrongGuild: true, expectedGuildId: session.guildId };
    }

    if (channelId && session.channelId && session.channelId !== channelId) {
      return { wrongChannel: true, expectedChannelId: session.channelId };
    }

    if (session.status === UPLOAD_SESSION_STATUS.EVIDENCE_READY) {
      return { alreadyReceived: true, session };
    }

    if (session.status === UPLOAD_SESSION_STATUS.PROCESSING) {
      return { concurrent: true, session };
    }

    // Atomic transition
    session.status = UPLOAD_SESSION_STATUS.PROCESSING;
    this.inMemorySessions.set(discordUserId, session);

    try {
      if (this.prisma?.systemSetting?.update) {
        await this.prisma.systemSetting.update({
          where: { key: this._getKey(discordUserId) },
          data: { value: JSON.stringify(session) }
        });
      }
    } catch {
      // Ignored for fallback
    }

    return { success: true, session };
  }

  /**
   * Reset session status back to WAITING_FOR_UPLOAD on validation or network failure
   * @param {string} discordUserId
   */
  async resetToWaiting(discordUserId) {
    const session = this.inMemorySessions.get(discordUserId);
    if (session && session.status === UPLOAD_SESSION_STATUS.PROCESSING) {
      session.status = UPLOAD_SESSION_STATUS.WAITING_FOR_UPLOAD;
      this.inMemorySessions.set(discordUserId, session);

      try {
        if (this.prisma?.systemSetting?.update) {
          await this.prisma.systemSetting.update({
            where: { key: this._getKey(discordUserId) },
            data: { value: JSON.stringify(session) }
          });
        }
      } catch {}
    }
  }

  /**
   * Attach validated evidence to upload session
   * @param {string} discordUserId
   * @param {object} evidenceData
   * @returns {Promise<object|null>}
   */
  async attachEvidence(discordUserId, evidenceData) {
    const session = await this.getSession(discordUserId);
    if (!session) return null;

    session.status = UPLOAD_SESSION_STATUS.EVIDENCE_READY;
    session.evidence = {
      storageKey: evidenceData.storageKey,
      filename: evidenceData.filename,
      mimeType: evidenceData.mimeType,
      fileSize: evidenceData.fileSize,
      durationSeconds: evidenceData.durationSeconds,
      format: evidenceData.format
    };

    this.inMemorySessions.set(discordUserId, session);

    try {
      if (this.prisma?.systemSetting?.update) {
        await this.prisma.systemSetting.update({
          where: { key: this._getKey(discordUserId) },
          data: { value: JSON.stringify(session) }
        });
      }
    } catch {}

    logger.debug({ discordUserId, storageKey: evidenceData.storageKey }, 'Evidence successfully attached to upload session');
    return session;
  }

  /**
   * Atomically clear session (upon cancellation, expiry, or final payout creation)
   * @param {string} discordUserId
   */
  async clearSession(discordUserId) {
    this.inMemorySessions.delete(discordUserId);

    try {
      if (this.prisma?.systemSetting?.delete) {
        await this.prisma.systemSetting.delete({
          where: { key: this._getKey(discordUserId) }
        }).catch(() => {});
      }
    } catch {}
  }
}

export const payoutUploadSessionManager = new PayoutUploadSessionManager();
export default payoutUploadSessionManager;
