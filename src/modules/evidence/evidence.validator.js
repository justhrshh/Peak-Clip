import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

export const ALLOWED_VIDEO_MIME_TYPES = Object.freeze([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska'
]);

export const SUPPORTED_VIDEO_EXTENSIONS = Object.freeze(['.mp4', '.webm', '.mov', '.mkv']);

export const MAX_EVIDENCE_FILE_SIZE_BYTES =
  Number(process.env.MAX_EVIDENCE_FILE_SIZE_BYTES) || 20 * 1024 * 1024; // 20MB
export const MAX_EVIDENCE_DURATION_SECONDS = 40.0;

/**
 * Check if a Discord attachment qualifies as a supported video candidate.
 * Do NOT rely exclusively on attachment.contentType.
 * Support contentType when available, with filename extension as fallback.
 *
 * @param {object} attachment
 * @returns {boolean}
 */
export function isSupportedVideoAttachment(attachment) {
  if (!attachment) return false;
  const name = (attachment.name ?? '').toLowerCase();
  const contentType = (attachment.contentType ?? '').toLowerCase();

  const extensionMatches = SUPPORTED_VIDEO_EXTENSIONS.some((ext) => name.endsWith(ext));
  const mimeMatches =
    contentType.startsWith('video/') ||
    ALLOWED_VIDEO_MIME_TYPES.includes(contentType);

  return mimeMatches || extensionMatches;
}

export class EvidenceValidationError extends AppError {
  constructor(code, message, details = {}) {
    super(message, code, 400, details);
    this.name = 'EvidenceValidationError';
  }
}

/**
 * Inspect MP4 buffer for mvhd box duration (server-side media inspection)
 * @param {Buffer} buffer
 * @returns {number|null} duration in seconds, or null if not an MP4 or unparseable
 */
export function extractMp4Duration(buffer) {
  if (!buffer || buffer.length < 32) return null;
  try {
    let offset = 0;
    while (offset < buffer.length - 8) {
      let size = buffer.readUInt32BE(offset);
      const type = buffer.toString('ascii', offset + 4, offset + 8);
      let headerSize = 8;

      if (size === 1) {
        if (offset + 16 > buffer.length) break;
        const sizeHigh = buffer.readUInt32BE(offset + 8);
        const sizeLow = buffer.readUInt32BE(offset + 12);
        size = sizeHigh * 4294967296 + sizeLow;
        headerSize = 16;
      } else if (size === 0) {
        size = buffer.length - offset;
      }

      if (size < headerSize) break;

      if (type === 'moov') {
        // Look inside moov for mvhd
        let moovOffset = offset + headerSize;
        const moovEnd = offset + size;
        while (moovOffset < moovEnd - 8) {
          let subSize = buffer.readUInt32BE(moovOffset);
          const subType = buffer.toString('ascii', moovOffset + 4, moovOffset + 8);
          let subHeaderSize = 8;
          if (subSize === 1) {
            if (moovOffset + 16 > buffer.length) break;
            const subHigh = buffer.readUInt32BE(moovOffset + 8);
            const subLow = buffer.readUInt32BE(moovOffset + 12);
            subSize = subHigh * 4294967296 + subLow;
            subHeaderSize = 16;
          } else if (subSize === 0) {
            subSize = moovEnd - moovOffset;
          }
          if (subSize < subHeaderSize) break;

          if (subType === 'mvhd') {
            const version = buffer.readUInt8(moovOffset + subHeaderSize);
            if (version === 0) {
              const timescale = buffer.readUInt32BE(moovOffset + subHeaderSize + 12);
              const duration = buffer.readUInt32BE(moovOffset + subHeaderSize + 16);
              if (timescale > 0) {
                return duration / timescale;
              }
            } else if (version === 1) {
              const timescale = buffer.readUInt32BE(moovOffset + subHeaderSize + 20);
              const durationHigh = buffer.readUInt32BE(moovOffset + subHeaderSize + 24);
              const durationLow = buffer.readUInt32BE(moovOffset + subHeaderSize + 28);
              const duration = durationHigh * 4294967296 + durationLow;
              if (timescale > 0) {
                return duration / timescale;
              }
            }
          }
          moovOffset += subSize;
        }
      }
      offset += size;
    }
  } catch (err) {
    logger.debug({ err: err.message }, 'Failed to parse MP4 mvhd duration');
  }
  return null;
}

/**
 * Validate an evidence file upload buffer and metadata
 *
 * @param {object} params
 * @param {Buffer} params.buffer
 * @param {string} params.filename
 * @param {string} params.mimeType
 * @param {number} [params.clientDurationSeconds]
 * @returns {{ valid: boolean, durationSeconds: number|null, requiresStaffDurationCheck: boolean }}
 */
export function validateEvidenceFile(paramsOrBuffer, maybeFilename, maybeMimeType) {
  let buffer, filename, mimeType, clientDurationSeconds;

  if (Buffer.isBuffer(paramsOrBuffer) || (paramsOrBuffer && paramsOrBuffer.buffer === undefined)) {
    buffer = paramsOrBuffer;
    filename = maybeFilename;
    mimeType = maybeMimeType;
    clientDurationSeconds = null;
  } else {
    buffer = paramsOrBuffer?.buffer;
    filename = paramsOrBuffer?.filename;
    mimeType = paramsOrBuffer?.mimeType;
    clientDurationSeconds = paramsOrBuffer?.clientDurationSeconds ?? null;
  }

  // 1. Non-empty check
  if (!buffer || buffer.length === 0) {
    throw new EvidenceValidationError('INVALID_FILE', 'The uploaded evidence file is empty (0 bytes).');
  }

  // 2. Maximum file size check
  if (buffer.length > MAX_EVIDENCE_FILE_SIZE_BYTES) {
    throw new EvidenceValidationError(
      'INVALID_FILE',
      `Evidence recording exceeds maximum file size (${(MAX_EVIDENCE_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0)}MB).`
    );
  }

  // 3. MIME type check
  const normalizedMime = (mimeType || '').toLowerCase().trim();
  const hasAllowedMime = ALLOWED_VIDEO_MIME_TYPES.includes(normalizedMime);
  const ext = (filename || '').split('.').pop()?.toLowerCase();
  const hasAllowedExt = ['mp4', 'webm', 'mov', 'mkv'].includes(ext || '');

  if (!hasAllowedMime && !hasAllowedExt) {
    throw new EvidenceValidationError(
      'INVALID_FILE',
      `Unsupported file format (${mimeType || ext}). Please upload a video recording (.mp4, .webm, or .mov).`
    );
  }

  // 4. Server-side duration inspection
  let inspectedDuration = null;
  if (normalizedMime === 'video/mp4' || ext === 'mp4' || ext === 'mov') {
    inspectedDuration = extractMp4Duration(buffer);
    const hasValidContainer = buffer.length >= 16 && (
      buffer.toString('ascii', 4, 8) === 'ftyp' ||
      buffer.toString('ascii', 4, 8) === 'moov' ||
      buffer.includes(Buffer.from('ftyp', 'ascii')) ||
      buffer.includes(Buffer.from('moov', 'ascii'))
    );
    if (!hasValidContainer) {
      // If extension/mime claims to be mp4/mov but no valid container signature exists
      throw new EvidenceValidationError(
        'INVALID_FILE',
        'Unable to parse video stream header. Please ensure the file is an uncorrupted video recording.'
      );
    }
  }

  // Priority: verified server-side duration > client-provided duration
  const effectiveDuration = inspectedDuration !== null ? inspectedDuration : clientDurationSeconds;

  // 5. Maximum duration check (< 40.0 seconds)
  if (effectiveDuration !== null) {
    if (effectiveDuration >= MAX_EVIDENCE_DURATION_SECONDS) {
      throw new EvidenceValidationError(
        'DURATION_EXCEEDED',
        `Evidence recording exceeds allowed length (${effectiveDuration.toFixed(1)}s). The entire recording must be under 40 seconds.`
      );
    }
  }

  return {
    valid: true,
    isValid: true,
    format: ext || 'mp4',
    fileSize: buffer.length,
    durationSeconds: effectiveDuration !== null ? Number(effectiveDuration.toFixed(2)) : null,
    requiresStaffDurationCheck: effectiveDuration === null
  };
}

/**
 * Helper to build a valid synthetic MP4 buffer for testing duration extraction
 * @param {number} timescaleOrSeconds
 * @param {number} [duration]
 * @returns {Buffer}
 */
export function buildMockMp4Buffer(timescaleOrSeconds, duration) {
  let timescale = 1000;
  let dur = 0;

  if (duration === undefined) {
    timescale = 1000;
    dur = Math.round(timescaleOrSeconds * timescale);
  } else {
    timescale = timescaleOrSeconds;
    dur = duration;
  }

  const mvhd = Buffer.alloc(32);
  mvhd.writeUInt32BE(32, 0);
  mvhd.write('mvhd', 4, 4, 'ascii');
  mvhd.writeUInt8(0, 8); // version 0
  mvhd.writeUInt32BE(timescale, 20);
  mvhd.writeUInt32BE(dur, 24);

  const moovSize = 8 + mvhd.length;
  const moov = Buffer.alloc(moovSize);
  moov.writeUInt32BE(moovSize, 0);
  moov.write('moov', 4, 4, 'ascii');
  mvhd.copy(moov, 8);

  const ftyp = Buffer.alloc(16);
  ftyp.writeUInt32BE(16, 0);
  ftyp.write('ftyp', 4, 4, 'ascii');
  ftyp.write('isom', 8, 4, 'ascii');

  return Buffer.concat([ftyp, moov]);
}
