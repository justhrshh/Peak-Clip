import { prisma } from '../../database/client.js';

export class VerificationRepository {
  constructor(dbClient = prisma) {
    this.db = dbClient;
  }

  /**
   * Save a new metric snapshot for a submission
   * @param {object} params
   * @param {string} params.submissionId
   * @param {bigint} params.views
   * @param {bigint} params.likes
   * @param {bigint} params.comments
   * @param {bigint|null} [params.shares]
   * @param {string} [params.source='PROVIDER']
   * @param {object} [params.metadata]
   * @returns {Promise<object>}
   */
  async createMetricSnapshot({ submissionId, views, likes, comments, shares = null, source = 'PROVIDER', metadata = null }) {
    return this.db.metricSnapshot.create({
      data: {
        submissionId,
        views: BigInt(views),
        likes: BigInt(likes),
        comments: BigInt(comments),
        shares: shares !== null && shares !== undefined ? BigInt(shares) : null,
        source,
        metadata
      }
    });
  }

  /**
   * Retrieve historical metric snapshots for a submission ordered chronologically
   * @param {string} submissionId
   * @returns {Promise<Array<object>>}
   */
  async getHistoricalSnapshots(submissionId) {
    return this.db.metricSnapshot.findMany({
      where: { submissionId },
      orderBy: { capturedAt: 'asc' }
    });
  }

  /**
   * Create or update a verification record
   * @param {object} params
   * @param {string} params.submissionId
   * @param {'PENDING'|'IN_PROGRESS'|'COMPLETED'|'FAILED'} params.status
   * @param {'LOW_RISK'|'REVIEW_REQUIRED'|'HIGH_RISK'} [params.riskLevel]
   * @param {number|null} [params.score]
   * @param {Date|null} [params.startedAt]
   * @param {Date|null} [params.completedAt]
   * @param {string|null} [params.lastError]
   * @returns {Promise<object>}
   */
  async upsertVerification({
    submissionId,
    status,
    riskLevel = 'LOW_RISK',
    score = null,
    startedAt = null,
    completedAt = null,
    lastError = null
  }) {
    const existing = await this.db.verification.findFirst({
      where: { submissionId },
      orderBy: { createdAt: 'desc' }
    });

    if (existing) {
      return this.db.verification.update({
        where: { id: existing.id },
        data: {
          status,
          riskLevel,
          score,
          startedAt: startedAt || existing.startedAt,
          completedAt: completedAt || existing.completedAt,
          lastError,
          updatedAt: new Date()
        }
      });
    }

    return this.db.verification.create({
      data: {
        submissionId,
        status,
        riskLevel,
        score,
        startedAt: startedAt || new Date(),
        completedAt,
        lastError
      }
    });
  }

  /**
   * Get the active or latest verification record for a submission
   * @param {string} submissionId
   * @returns {Promise<object|null>}
   */
  async getVerificationBySubmissionId(submissionId) {
    return this.db.verification.findFirst({
      where: { submissionId },
      orderBy: { createdAt: 'desc' },
      include: {
        signals: {
          orderBy: { createdAt: 'asc' }
        }
      }
    });
  }

  /**
   * Save detected signals to a verification record
   * @param {string} verificationId
   * @param {Array<{ type: string, severity: string, value: object, explanation: string }>} signals
   * @returns {Promise<Array<object>>}
   */
  async addVerificationSignals(verificationId, signals = []) {
    if (!signals || signals.length === 0) return [];

    const created = [];
    for (const s of signals) {
      const signal = await this.db.verificationSignal.create({
        data: {
          verificationId,
          type: s.type,
          severity: s.severity,
          value: s.value || {},
          explanation: s.explanation
        }
      });
      created.push(signal);
    }
    return created;
  }
}

export const verificationRepository = new VerificationRepository();
export default verificationRepository;
