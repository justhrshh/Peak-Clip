/**
 * Phase 10H.8: Payout Request Draft Manager
 *
 * Manages guided payout request drafts before final submission.
 * Ensures:
 * 1. Evidence must be collected and validated BEFORE PayoutRequest creation.
 * 2. No financial mutations or balance reservations happen during draft/upload.
 * 3. Atomic single-use consumption prevents concurrent double submissions.
 * 4. Automatic expiry (30-minute TTL) clears stale drafts.
 */

class PayoutDraftManager {
  constructor(ttlMs = 30 * 60 * 1000) {
    this.drafts = new Map();
    this.ttlMs = ttlMs;
  }

  /**
   * Initialize a new payout draft for a user
   * @param {string} userId
   * @param {object} params
   * @param {string} params.amount
   * @param {string} [params.currency='USD']
   * @param {object} params.profileSnapshot
   * @returns {object} draft
   */
  createDraft(userId, { amount, currency = 'USD', profileSnapshot }) {
    const draft = {
      userId,
      amount: String(amount),
      currency,
      profileSnapshot,
      step: 'AWAITING_EVIDENCE',
      evidence: null,
      createdAt: Date.now()
    };
    this.drafts.set(userId, draft);
    return draft;
  }

  /**
   * Retrieve an active draft by userId
   * @param {string} userId
   * @returns {object|null}
   */
  getDraft(userId) {
    const draft = this.drafts.get(userId);
    if (!draft) return null;

    if (Date.now() - draft.createdAt > this.ttlMs) {
      this.drafts.delete(userId);
      return null;
    }
    return draft;
  }

  /**
   * Attach validated evidence to an active draft
   * @param {string} userId
   * @param {object} evidenceData
   * @param {Buffer} evidenceData.buffer
   * @param {string} evidenceData.filename
   * @param {string} evidenceData.mimeType
   * @param {number|null} [evidenceData.durationSeconds]
   * @param {number} evidenceData.fileSize
   * @returns {object|null}
   */
  attachEvidence(userId, evidenceData) {
    const draft = this.getDraft(userId);
    if (!draft) return null;

    draft.evidence = {
      buffer: evidenceData.buffer,
      filename: evidenceData.filename,
      mimeType: evidenceData.mimeType,
      durationSeconds: evidenceData.durationSeconds || null,
      fileSize: evidenceData.fileSize
    };
    draft.step = 'EVIDENCE_ATTACHED';
    return draft;
  }

  /**
   * Atomically consume a draft for submission
   * Removes from map immediately so concurrent clicks cannot reuse it.
   * @param {string} userId
   * @returns {object|null}
   */
  consumeDraft(userId) {
    const draft = this.getDraft(userId);
    if (!draft) return null;

    this.drafts.delete(userId);
    return draft;
  }

  /**
   * Cancel/clear draft
   * @param {string} userId
   */
  clearDraft(userId) {
    this.drafts.delete(userId);
  }
}

export const payoutDraftManager = new PayoutDraftManager();
