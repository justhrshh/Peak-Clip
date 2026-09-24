import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from '../../utils/logger.js';

export class LocalStorageAdapter {
  constructor(baseDir = path.resolve(process.cwd(), 'storage')) {
    this.baseDir = baseDir;
    this.ensureDirectoryExists(this.baseDir);
  }

  ensureDirectoryExists(dir) {
    if (!fsSync.existsSync(dir)) {
      fsSync.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Save a file buffer to local storage
   * @param {object} params
   * @param {Buffer} params.buffer
   * @param {string} params.filename
   * @param {string} params.mimeType
   * @param {string} [params.subfolder='evidence']
   * @returns {Promise<{ storageKey: string, filename: string, mimeType: string, fileSize: number }>}
   */
  async saveFile({ buffer, filename, mimeType, subfolder = 'evidence' }) {
    if (!buffer || buffer.length === 0) {
      throw new Error('Cannot save empty file buffer');
    }

    const sanitizedSubfolder = subfolder.replace(/[^a-zA-Z0-9_-]/g, '');
    const targetDir = path.join(this.baseDir, sanitizedSubfolder);
    this.ensureDirectoryExists(targetDir);

    const ext = path.extname(filename) || '.bin';
    const randomSuffix = crypto.randomBytes(16).toString('hex');
    const safeStorageName = `${Date.now()}_${randomSuffix}${ext}`;
    const fullPath = path.join(targetDir, safeStorageName);

    // Prevent directory traversal
    if (!fullPath.startsWith(this.baseDir)) {
      throw new Error('Invalid storage path destination');
    }

    await fs.writeFile(fullPath, buffer);
    const storageKey = path.join(sanitizedSubfolder, safeStorageName).replace(/\\/g, '/');

    logger.debug({ storageKey, size: buffer.length, filename }, 'File saved to storage adapter');

    return {
      storageKey,
      filename: path.basename(filename),
      mimeType,
      fileSize: buffer.length
    };
  }

  /**
   * Resolve absolute path for storage key (safe, internal only)
   * @private
   */
  _resolvePath(storageKey) {
    const normalized = path.normalize(storageKey).replace(/^(\.\.(\/|\\|$))+/, '');
    const fullPath = path.join(this.baseDir, normalized);
    if (!fullPath.startsWith(this.baseDir)) {
      throw new Error('Security Violation: storage key points outside storage root');
    }
    return fullPath;
  }

  /**
   * Read file buffer
   * @param {string} storageKey
   * @returns {Promise<Buffer>}
   */
  async getFileBuffer(storageKey) {
    const fullPath = this._resolvePath(storageKey);
    return fs.readFile(fullPath);
  }

  /**
   * Check file existence and metadata
   * @param {string} storageKey
   * @returns {Promise<{ exists: boolean, size: number, mtime: Date }>}
   */
  async getFileMetadata(storageKey) {
    try {
      const fullPath = this._resolvePath(storageKey);
      const stat = await fs.stat(fullPath);
      return {
        exists: true,
        size: stat.size,
        mtime: stat.mtime
      };
    } catch {
      return {
        exists: false,
        size: 0,
        mtime: null
      };
    }
  }

  /**
   * Delete file
   * @param {string} storageKey
   * @returns {Promise<boolean>}
   */
  async deleteFile(storageKey) {
    try {
      const fullPath = this._resolvePath(storageKey);
      await fs.unlink(fullPath);
      return true;
    } catch {
      return false;
    }
  }
}

export class StorageService {
  constructor(adapter = new LocalStorageAdapter()) {
    this.adapter = adapter;
  }

  async saveFile(options) {
    return this.adapter.saveFile(options);
  }

  async getFileBuffer(storageKey) {
    return this.adapter.getFileBuffer(storageKey);
  }

  async getFileMetadata(storageKey) {
    return this.adapter.getFileMetadata(storageKey);
  }

  async deleteFile(storageKey) {
    return this.adapter.deleteFile(storageKey);
  }
}

export const storageService = new StorageService();
export default storageService;
