import { prisma as defaultPrisma } from '../../database/client.js';
import { storageService as defaultStorageService } from '../storage/storage.service.js';
import { validateEvidenceFile, EvidenceValidationError } from './evidence.validator.js';
import {
  STRUCTURED_EVIDENCE_REJECTION_REASONS,
  isValidEvidenceRejectionReason,
  getCreatorSafeEvidenceLabel,
  EVIDENCE_STATUS
} from './evidence.constants.js';
import { logger } from '../../utils/logger.js';

export class EvidenceService {
  constructor(dbClient = defaultPrisma, storage = defaultStorageService) {
    this.prisma = dbClient;
    this.storage = storage;
  }

  /**
   * Attach an initial evidence recording to a payout request
   *
   * @param {object} params
   * @param {string} params.payoutRequestId
   * @param {string} params.userId
   * @param {string} [params.platform='YOUTUBE']
   * @param {Buffer} params.buffer
   * @param {string} params.filename
   * @param {string} params.mimeType
   * @param {number|null} [params.clientDurationSeconds=null]
   * @param {object} [tx=null]
   * @returns {Promise<object>}
   */
  async attachEvidence({
    payoutRequestId,
    userId,
    platform = 'YOUTUBE',
    buffer,
    filename,
    mimeType,
    clientDurationSeconds = null
  }, tx = null) {
    const client = tx || this.prisma;

    // 1. Validate file (media inspection, <40s duration, mime, size)
    const validation = validateEvidenceFile({
      buffer,
      filename,
      mimeType,
      clientDurationSeconds
    });

    // 2. Persist media into swappable storage adapter
    const saved = await this.storage.saveFile({
      buffer,
      filename,
      mimeType,
      subfolder: 'evidence'
    });

    // 3. Insert immutable evidence record
    const evidence = await client.payoutEvidence.create({
      data: {
        payoutRequestId,
        userId,
        platform,
        filename: saved.filename,
        mimeType: saved.mimeType,
        fileSize: BigInt(saved.fileSize),
        durationSeconds: validation.durationSeconds !== null ? validation.durationSeconds : null,
        storageKey: saved.storageKey,
        status: EVIDENCE_STATUS.PENDING_REVIEW,
        version: 1
      }
    });

    logger.info(
      { evidenceId: evidence.id, payoutRequestId, userId, duration: validation.durationSeconds },
      'Payout evidence attached'
    );

    return evidence;
  }

  /**
   * Submit replacement evidence for a payout request (immutability: preserves historical records)
   *
   * @param {object} params
   * @param {string} params.payoutRequestId
   * @param {string} params.userId
   * @param {string} [params.platform='YOUTUBE']
   * @param {Buffer} params.buffer
   * @param {string} params.filename
   * @param {string} params.mimeType
   * @param {number|null} [params.clientDurationSeconds=null]
   * @param {object} [tx=null]
  /**
   * Replace evidence with a new version (immutable audit history preserved)
   *
   * @param {object|string} paramsOrId
   * @param {object} [dataOrTx=null]
   * @param {object} [possibleTx=null]
   * @returns {Promise<object>}
   */
  async replaceEvidence(paramsOrId, dataOrTx = null, possibleTx = null) {
    let params;
    let tx;
    if (typeof paramsOrId === 'string') {
      params = { payoutRequestId: paramsOrId, ...(dataOrTx || {}) };
      tx = possibleTx;
    } else {
      params = paramsOrId;
      tx = dataOrTx;
    }

    const client = (tx && tx.payoutEvidence) ? tx : this.prisma;
    const {
      payoutRequestId,
      userId,
      platform = 'YOUTUBE',
      buffer,
      filename,
      mimeType,
      clientDurationSeconds = null
    } = params;

    // 1. Resolve existing versions
    const existing = await client.payoutEvidence.findMany({
      where: { payoutRequestId },
      orderBy: { version: 'desc' }
    });

    const nextVersion = existing.length > 0 ? existing[0].version + 1 : 1;

    // 2. Validate file
    const validation = validateEvidenceFile({
      buffer,
      filename,
      mimeType,
      clientDurationSeconds
    });

    // 3. Save to storage
    const saved = await this.storage.saveFile({
      buffer,
      filename,
      mimeType,
      subfolder: 'evidence'
    });

    // 4. Create new version record (old records remain preserved)
    const evidence = await client.payoutEvidence.create({
      data: {
        payoutRequestId,
        userId,
        platform,
        filename: saved.filename,
        mimeType: saved.mimeType,
        fileSize: BigInt(saved.fileSize),
        durationSeconds: validation.durationSeconds !== null ? validation.durationSeconds : null,
        storageKey: saved.storageKey,
        status: EVIDENCE_STATUS.PENDING_REVIEW,
        version: nextVersion
      }
    });

    logger.info(
      { evidenceId: evidence.id, payoutRequestId, version: nextVersion },
      'Replacement evidence attached as new version'
    );

    return evidence;
  }

  /**
   * Get all evidence records for a payout request
   * @param {string} payoutRequestId
   * @returns {Promise<Array<object>>}
   */
  async getEvidenceForPayout(payoutRequestId) {
    return this.prisma.payoutEvidence.findMany({
      where: { payoutRequestId },
      orderBy: { version: 'asc' }
    });
  }

  /**
   * Get the latest active evidence record for a payout request
   * @param {string} payoutRequestId
   * @returns {Promise<object|null>}
   */
  async getLatestEvidence(payoutRequestId) {
    return this.prisma.payoutEvidence.findFirst({
      where: { payoutRequestId },
      orderBy: { version: 'desc' }
    });
  }

  /**
   * Authorized staff approval of payout evidence
   *
   * @param {string} evidenceId
   * @param {object} actor - { discordId, userId }
   * @returns {Promise<object>}
   */
  async acceptEvidence(evidenceId, actor) {
    const evidence = await this.prisma.payoutEvidence.findUnique({
      where: { id: evidenceId }
    });

    if (!evidence) {
      throw new Error(`Evidence record ${evidenceId} not found`);
    }

    const updated = await this.prisma.payoutEvidence.update({
      where: { id: evidenceId },
      data: {
        status: EVIDENCE_STATUS.ACCEPTED,
        reviewedAt: new Date(),
        reviewedBy: actor?.discordId || 'STAFF',
        rejectionReason: null
      }
    });

    logger.info({ evidenceId, reviewer: actor?.discordId }, 'Payout evidence accepted by staff');
    return updated;
  }

  /**
   * Authorized staff rejection of payout evidence
   *
   * @param {string} evidenceId
   * @param {object} actor - { discordId, userId }
   * @param {object} options
   * @param {string} options.structuredReason
   * @param {string|null} [options.notes]
   * @returns {Promise<object>}
   */
  async rejectEvidence(evidenceId, actor, { structuredReason, notes = null } = {}) {
    if (!structuredReason || !isValidEvidenceRejectionReason(structuredReason)) {
      throw new Error(`Invalid or missing structured evidence rejection reason: ${structuredReason}`);
    }

    const evidence = await this.prisma.payoutEvidence.findUnique({
      where: { id: evidenceId }
    });

    if (!evidence) {
      throw new Error(`Evidence record ${evidenceId} not found`);
    }

    const updated = await this.prisma.payoutEvidence.update({
      where: { id: evidenceId },
      data: {
        status: EVIDENCE_STATUS.REJECTED,
        rejectionReason: structuredReason,
        notes: notes || null,
        reviewedAt: new Date(),
        reviewedBy: actor?.discordId || 'STAFF'
      }
    });

    logger.info(
      { evidenceId, structuredReason, reviewer: actor?.discordId },
      'Payout evidence rejected by staff'
    );

    return updated;
  }
}

export const evidenceService = new EvidenceService();
export default evidenceService;
