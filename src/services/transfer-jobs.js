'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

/**
 * TransferJobs — Download/upload queue with bounded concurrency, progress, cancel.
 *
 * Design rule: workspace-sync.js coordinates WHAT to sync.
 * TransferJobs owns HOW (queueing, concurrency, progress, staging paths).
 *
 * @typedef {Object} TransferJob
 * @property {string} id
 * @property {string} path            - Remote file path
 * @property {string} name            - Basename
 * @property {'download'|'upload'} direction
 * @property {'queued'|'active'|'complete'|'failed'|'cancelled'} status
 * @property {number} bytesTransferred
 * @property {number} totalBytes
 * @property {number} progress        - 0.0 to 1.0
 * @property {number|null} etaSeconds
 * @property {string} sessionCode
 * @property {number} startedAt
 * @property {string|null} error
 * @property {string} tempPath        - Staging path for resumable downloads
 */

const MAX_CONCURRENT = 3;

class TransferJobs {
  constructor({ stagingDir, onProgress = null, onComplete = null, onError = null } = {}) {
    this._stagingDir = stagingDir;
    this._onProgress = onProgress;
    this._onComplete = onComplete;
    this._onError = onError;
    this._queue = [];
    this._active = new Map();
    this._completed = [];
    this._abortControllers = new Map();
  }

  /** Enqueue a download job. Returns the job object. */
  enqueueDownload({ remotePath, localPath, totalBytes = 0, sessionCode = '', createReadStream, tempPath = null, meta = null }) {
    const job = {
      id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
      path: remotePath,
      name: path.basename(remotePath),
      direction: 'download',
      status: 'queued',
      bytesTransferred: 0,
      totalBytes,
      progress: 0,
      etaSeconds: null,
      sessionCode,
      startedAt: 0,
      error: null,
      tempPath: tempPath || path.join(this._stagingDir, `${Date.now()}-${path.basename(remotePath)}.tmp`),
      // Internal
      _localPath: localPath,
      _createReadStream: createReadStream,
      _meta: meta && typeof meta === 'object' ? { ...meta } : null,
    };
    this._queue.push(job);
    this._processQueue();
    return this._snapshotJob(job);
  }

  /** Enqueue an upload job. Returns the job object. */
  enqueueUpload({ remotePath, sourcePath, targetPath = remotePath, totalBytes = 0, sessionCode = '', createWriteStream, sourceFingerprint = null, meta = null }) {
    const job = {
      id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
      path: remotePath,
      name: path.basename(remotePath),
      direction: 'upload',
      status: 'queued',
      bytesTransferred: 0,
      totalBytes,
      progress: 0,
      etaSeconds: null,
      sessionCode,
      startedAt: 0,
      error: null,
      tempPath: '',
      // Internal
      _sourcePath: sourcePath,
      _sourceFingerprint: sourceFingerprint,
      _targetPath: targetPath,
      _createWriteStream: createWriteStream,
      _meta: meta && typeof meta === 'object' ? { ...meta } : null,
    };
    this._queue.push(job);
    this._processQueue();
    return this._snapshotJob(job);
  }

  /** Cancel a job (queued or active). */
  cancel(jobId) {
    // Remove from queue
    const qIdx = this._queue.findIndex((j) => j.id === jobId);
    if (qIdx !== -1) {
      const job = this._queue.splice(qIdx, 1)[0];
      job.status = 'cancelled';
      this._completed.push(job);
      return true;
    }
    // Abort active
    const controller = this._abortControllers.get(jobId);
    if (controller) {
      controller.abort();
      return true;
    }
    return false;
  }

  /** Cancel all jobs for a session. */
  cancelAll(sessionCode = null) {
    const toCancel = sessionCode
      ? [...this._queue.filter((j) => j.sessionCode === sessionCode), ...Array.from(this._active.values()).filter((j) => j.sessionCode === sessionCode)]
      : [...this._queue, ...Array.from(this._active.values())];
    for (const job of toCancel) this.cancel(job.id);
  }

  /** Get all active + queued jobs. */
  getActiveJobs() {
    return [
      ...this._queue.map((j) => this._snapshotJob(j)),
      ...Array.from(this._active.values()).map((j) => this._snapshotJob(j)),
    ];
  }

  /** Get a specific job. */
  getJob(jobId) {
    const q = this._queue.find((j) => j.id === jobId);
    if (q) return this._snapshotJob(q);
    const a = this._active.get(jobId);
    if (a) return this._snapshotJob(a);
    const c = this._completed.find((j) => j.id === jobId);
    if (c) return this._snapshotJob(c);
    return null;
  }

  _snapshotJob(job) {
    if (!job) return null;
    return {
      id: job.id,
      path: job.path,
      name: job.name,
      direction: job.direction,
      status: job.status,
      bytesTransferred: job.bytesTransferred,
      totalBytes: job.totalBytes,
      progress: job.progress,
      etaSeconds: job.etaSeconds,
      sessionCode: job.sessionCode,
      startedAt: job.startedAt,
      error: job.error,
      tempPath: job.tempPath,
      meta: job._meta ? { ...job._meta } : null,
    };
  }

  // --- Internal ---

  _processQueue() {
    while (this._active.size < MAX_CONCURRENT && this._queue.length > 0) {
      const job = this._queue.shift();
      this._active.set(job.id, job);
      this._runJob(job);
    }
  }

  async _runJob(job) {
    const controller = new AbortController();
    this._abortControllers.set(job.id, controller);

    job.status = 'active';
    job.startedAt = Date.now();

    try {
      const readStream = job.direction === 'upload'
        ? fs.createReadStream(job._sourcePath)
        : job._createReadStream(job.path);
      const writeStream = job.direction === 'upload'
        ? job._createWriteStream(job._targetPath || job.path)
        : fs.createWriteStream(job.tempPath);
      let transferred = 0;
      const startTime = Date.now();

      readStream.on('data', (chunk) => {
        transferred += chunk.length;
        job.bytesTransferred = transferred;
        job.progress = job.totalBytes > 0 ? Math.min(transferred / job.totalBytes, 1) : 0;
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = elapsed > 0 ? transferred / elapsed : 0;
        job.etaSeconds = rate > 0 && job.totalBytes > 0 ? Math.ceil((job.totalBytes - transferred) / rate) : null;
        if (this._onProgress) this._onProgress(this._snapshotJob(job));
      });

      // Abort handling
      const abortHandler = () => {
        readStream.destroy(new Error('cancelled'));
        if (writeStream && typeof writeStream.destroy === 'function') {
          writeStream.destroy(new Error('cancelled'));
        }
      };
      controller.signal.addEventListener('abort', abortHandler, { once: true });

      if (job.direction !== 'upload') {
        fs.mkdirSync(path.dirname(job.tempPath), { recursive: true });
        fs.mkdirSync(path.dirname(job._localPath), { recursive: true });
      }

      await pipeline(readStream, writeStream);

      if (job.direction !== 'upload') {
        // Move from staging to final location
        try {
          fs.renameSync(job.tempPath, job._localPath);
        } catch (err) {
          if (err?.code !== 'EXDEV') throw err;
          fs.copyFileSync(job.tempPath, job._localPath);
          fs.unlinkSync(job.tempPath);
        }
      }

      job.status = 'complete';
      job.progress = 1;
      job.bytesTransferred = job.totalBytes || transferred;
      if (this._onComplete) this._onComplete(this._snapshotJob(job));

    } catch (err) {
      if (controller.signal.aborted || err.message === 'cancelled') {
        job.status = 'cancelled';
      } else {
        job.status = 'failed';
        job.error = err.message;
        if (this._onError) this._onError(this._snapshotJob(job));
      }
      // Clean up temp file
      if (job.tempPath) {
        try { fs.unlinkSync(job.tempPath); } catch (_) {}
      }
    } finally {
      this._active.delete(job.id);
      this._abortControllers.delete(job.id);
      this._completed.push(job);
      // Clean internal properties before storing
      delete job._localPath;
      delete job._createReadStream;
      delete job._sourcePath;
      delete job._sourceFingerprint;
      delete job._targetPath;
      delete job._createWriteStream;
      delete job._meta;
      this._processQueue();
    }
  }
}

module.exports = TransferJobs;
