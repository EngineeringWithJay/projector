'use strict';

const path = require('path');
const fs = require('fs');
const { Permissions } = require('hyperframe');
const PathService = require('./path-service');
const TransferJobs = require('./transfer-jobs');

/**
 * WorkspaceSync — owner mirror, peer upload watcher, explicit downloads.
 *
 * The owner remains the only publisher of the canonical workspace drive.
 * Joined peers upload into their own replicated upload drive; the owner pulls
 * those files into the local workspace and the existing owner mirror publishes
 * them into the session workspace.
 */

let MirrorDrive = null;
let LocalDrive = null;
let Hyperdrive = null;
let chokidar = null;
let StreamxTransform = null;

const UPLOAD_SETTLE_POLL_MS = 1000;
const UPLOAD_SETTLE_PASSES = 2;
const LARGE_FILE_SIZE_BYTES = 256 * 1024 * 1024;
const LARGE_UPLOAD_SETTLE_POLL_MS = 1500;
const LARGE_UPLOAD_SETTLE_PASSES = 3;
const MIN_SYNC_HEADROOM_BYTES = 64 * 1024 * 1024;
const MEMBER_UPLOAD_MISSING_GRACE_PASSES = 3;

function loadDeps() {
  if (!MirrorDrive) MirrorDrive = require('mirror-drive');
  if (!LocalDrive) LocalDrive = require('localdrive');
  if (!Hyperdrive) Hyperdrive = require('hyperdrive');
  if (!chokidar) chokidar = require('chokidar');
  if (!StreamxTransform) StreamxTransform = require('streamx').Transform;
}

function isClosedSessionError(err) {
  const text = String(err?.code || err?.message || err || '');
  return text.includes('SESSION_CLOSED');
}

function isRetryableMirrorError(err) {
  const text = String(err?.code || err?.message || err || '');
  return text.includes('Batch was not applied');
}

function normalizeSessionPath(entryPath = '') {
  return String(entryPath || '').replace(/^\/+|\/+$/g, '');
}

function buildRemotePath(rootPath, relativePath = '') {
  const normalizedRoot = normalizeSessionPath(rootPath);
  const normalizedRelative = normalizeSessionPath(relativePath);
  return normalizedRelative ? `${normalizedRoot}/${normalizedRelative}` : normalizedRoot;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const digits = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

class WorkspaceSync {
  constructor(ctx) {
    this.ctx = ctx;
    this._watcher = null;
    this._mirror = null;
    this._transferJobs = null;
    this._mirroring = false;
    this._mirrorTimeout = null;
    this._folderPath = null;
    this._stopped = false;

    this._memberUploadDrives = new Map();
    this._memberUploadPresence = new Map();
    this._memberUploadInterval = null;
    this._memberUploadSyncing = false;

    this._peerUploadWatcher = null;
    this._peerUploadDrive = null;
    this._peerUploadSharePath = null;
    this._peerUploadRoot = null;
    this._peerUploadSessionCode = null;
    this._peerUploadTimers = new Map();
    this._peerUploadState = new Map();

    this._publishProgress = this._createEmptyPublishProgress();
    this._lastPublishEmitAt = 0;
  }

  _log(level, scope, message, meta = null) {
    const logger = this.ctx?.logger;
    if (!logger || typeof logger[level] !== 'function') return;
    logger[level](`workspace-sync:${scope}`, message, meta);
  }

  async startOwnerSync(folderPath) {
    loadDeps();
    if (!this.ctx.session || !this.ctx.dataPlane?.drive || !this.ctx.dataPlane.writable) {
      this.ctx.syncReady = false;
      this.ctx.emitHealth();
      return false;
    }

    await this._stopPeerUploadSync();
    this.ctx.node?.setUploadDriveKey?.(null);
    this._stopped = false;
    PathService.ensureWorkspaceLayout(folderPath);
    this._folderPath = folderPath;
    this.ctx.sourceFolderPath = folderPath;
    this.ctx.watcherActive = false;
    this.ctx.lastError = null;
    this.ctx.emitHealth();
    this._log('info', 'owner', 'Starting owner sync', {
      folderPath,
      sessionCode: this.ctx.session?.sessionCode || null,
    });

    const localDrive = new LocalDrive(folderPath);
    this._mirror = this._createOwnerMirror(localDrive);
    await this._runMirror();

    this._watcher = chokidar.watch(folderPath, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });
    this._watcher.on('all', () => this._debounceMirror());
    this.ctx.watcherActive = true;

    if (this._memberUploadInterval) clearInterval(this._memberUploadInterval);
    this._memberUploadInterval = setInterval(() => {
      void this._syncMemberUploadSources();
    }, 1500);
    void this._syncMemberUploadSources();

    this.ctx.syncReady = true;
    this.ctx.lastMirrorStatus = 'ok';
    this.ctx.emitHealth();
    return true;
  }

  async getFileList() {
    if (this.ctx.transitioning || !this.ctx.session) return [];

    const session = this.ctx.session;
    const deviceId = this.ctx.identity?.deviceId;
    const role = Permissions.getRoleForDevice(session, deviceId);
    const drive = this.ctx.dataPlane.drive;
    const activeJobs = this._getActiveJobs();
    const entriesByPath = new Map();
    const dirs = new Set();

    if (role !== Permissions.ROLE_OWNER) {
      await this._ensurePeerUploadSync();
    }

    if (drive) {
      try {
        for await (const entry of drive.list('/', { recursive: true })) {
          const remotePath = normalizeSessionPath(entry.key);
          if (!remotePath) continue;

          const parts = remotePath.split('/');
          for (let i = 1; i < parts.length; i++) {
            dirs.add(parts.slice(0, i).join('/'));
          }

          const name = path.basename(remotePath);
          const size = entry.value?.blob?.byteLength || 0;
          const visibility = Permissions.getPathVisibility(session, remotePath);
          const canSee = Permissions.canSeePath(session, deviceId, remotePath, role);
          const activeJob = this._getTransferJob(remotePath, activeJobs);

          if (!canSee) {
            entriesByPath.set(remotePath, {
              path: remotePath,
              name,
              size,
              kind: 'file',
              availability: 'restricted',
              localBytes: 0,
              isDirectory: false,
              visibility,
              localOnly: false,
              transferId: activeJob ? activeJob.id : null,
              transferDirection: activeJob ? activeJob.direction : null,
              progress: activeJob ? activeJob.progress : null,
            });
            continue;
          }

          const localInfo = this._getLocalAvailability(remotePath, size, role);
          let availability = 'meta-only';
          if (localInfo.exists) {
            availability = localInfo.localBytes >= size ? 'downloaded' : 'partial';
          } else if (role === Permissions.ROLE_OWNER && activeJob) {
            availability = 'partial';
          }

          entriesByPath.set(remotePath, {
            path: remotePath,
            name,
            size,
            kind: 'file',
            availability,
            localBytes: localInfo.localBytes,
            isDirectory: false,
            visibility,
            localOnly: false,
            transferId: activeJob ? activeJob.id : null,
            transferDirection: activeJob ? activeJob.direction : null,
            progress: activeJob ? activeJob.progress : null,
          });
        }
      } catch (err) {
        if (!this._stopped && !isClosedSessionError(err)) {
          this._log('error', 'browse', 'Error listing drive entries', err);
        }
      }
    }

    if (role === Permissions.ROLE_OWNER) {
      this._mergeOwnerLocalEntries(entriesByPath, dirs, activeJobs);
    } else {
      this._mergePeerUploadEntries(entriesByPath, dirs, activeJobs);
    }

    this._mergeTransferPlaceholders(entriesByPath, dirs, activeJobs);
    this._suppressStaleRemoteEntries(entriesByPath, role);

    for (const dirPath of dirs) {
      if (entriesByPath.has(dirPath)) continue;
      if (role === Permissions.ROLE_OWNER) {
        const workspacePath = this._folderPath || this.ctx.sourceFolderPath;
        if (workspacePath) {
          const localDirPath = PathService.resolveWorkspacePath(workspacePath, dirPath);
          if (!fs.existsSync(localDirPath)) continue;
        }
      } else if (this._peerUploadSharePath) {
        if (dirPath === this._peerUploadSharePath || dirPath.startsWith(this._peerUploadSharePath + '/')) {
          const localDirPath = this._resolvePeerUploadLocalPath(dirPath);
          if (!localDirPath || !fs.existsSync(localDirPath)) continue;
        }
      }
      const visibility = Permissions.getPathVisibility(session, dirPath);
      const canSee = Permissions.canSeePath(session, deviceId, dirPath, role);
      const localInfo = this._getLocalAvailability(dirPath, 0, role);
      entriesByPath.set(dirPath, {
        path: dirPath,
        name: path.basename(dirPath),
        size: 0,
        kind: 'directory',
        availability: canSee || localInfo.exists ? 'downloaded' : 'restricted',
        localBytes: 0,
        isDirectory: true,
        visibility,
        localOnly: !canSee && localInfo.exists,
        transferId: null,
        transferDirection: null,
        progress: null,
      });
    }

    return Array.from(entriesByPath.values()).sort((a, b) => a.path.localeCompare(b.path));
  }

  async downloadFile(remotePath) {
    const session = this.ctx.session;
    const deviceId = this.ctx.identity?.deviceId;
    const role = Permissions.getRoleForDevice(session, deviceId);

    if (!Permissions.canSeePath(session, deviceId, remotePath, role)) {
      throw new Error(`Access denied to path: ${remotePath}`);
    }

    const transferJobs = this._ensureTransferJobs();
    const localPath = PathService.resolveLocalPath(this.ctx.storagePath, session.sessionCode, remotePath);
    const manifest = this.ctx.node?.getObjectManifest?.(remotePath) || null;
    this._log('info', 'download', 'Queueing shared item download', {
      remotePath,
      hasManifest: !!manifest,
    });

    if (manifest) {
      const job = transferJobs.enqueueDownload({
        remotePath,
        localPath,
        totalBytes: Number(manifest.sizeBytes) || 0,
        sessionCode: session.sessionCode,
        createReadStream: (entryPath) => {
          const stream = this.ctx.node?.createVisibleFileStream?.(normalizeSessionPath(entryPath));
          if (!stream) {
            throw new Error(`File not found: ${entryPath}`);
          }
          return stream;
        },
      });
      this._updateTransferState();
      this.ctx.emitHealth();
      return job;
    }

    const drive = this.ctx.dataPlane.drive;
    const drivePath = '/' + normalizeSessionPath(remotePath);
    const entry = await drive.entry(drivePath);
    if (!entry?.value?.blob) {
      throw new Error(`File not found: ${remotePath}`);
    }
    const totalBytes = entry.value.blob.byteLength || 0;

    const job = transferJobs.enqueueDownload({
      remotePath,
      localPath,
      totalBytes,
      sessionCode: session.sessionCode,
      createReadStream: (entryPath) => drive.createReadStream('/' + normalizeSessionPath(entryPath)),
    });
    this._updateTransferState();
    this.ctx.emitHealth();
    return job;
  }

  deleteLocalCopy(remotePath) {
    const role = Permissions.getRoleForDevice(this.ctx.session, this.ctx.identity?.deviceId);
    if (role === Permissions.ROLE_OWNER) {
      throw new Error('Owner cannot delete local copy (it is the source).');
    }

    const uploadPath = this._resolvePeerUploadLocalPath(remotePath);
    if (uploadPath && fs.existsSync(uploadPath)) {
      fs.rmSync(uploadPath, { recursive: true, force: true });
      return true;
    }

    return PathService.deleteLocalCopy(this.ctx.storagePath, this.ctx.session.sessionCode, remotePath);
  }

  cancelAllTransfers() {
    if (this._transferJobs) {
      this._transferJobs.cancelAll(this.ctx.session?.sessionCode);
    }
  }

  getTransferJob(jobId) {
    return this._transferJobs ? this._transferJobs.getJob(jobId) : null;
  }

  async stop() {
    this._stopped = true;

    if (this._watcher) {
      await this._watcher.close();
      this._watcher = null;
    }
    if (this._memberUploadInterval) {
      clearInterval(this._memberUploadInterval);
      this._memberUploadInterval = null;
    }

    await this._stopPeerUploadSync();
    await this._closeMemberUploadDrives();
    this.ctx.node?.setUploadDriveKey?.(null);

    this.cancelAllTransfers();
    this._mirror = null;
    this._transferJobs = null;
    this._folderPath = null;
    if (this._mirrorTimeout) {
      clearTimeout(this._mirrorTimeout);
      this._mirrorTimeout = null;
    }
    this._mirroring = false;
    this.ctx.syncReady = false;
    this.ctx.sourceFolderPath = null;
    this.ctx.watcherActive = false;
    this.ctx.mirrorActive = false;
    this.ctx.activeTransferCount = 0;
    this.ctx.uploadTransferCount = 0;
    this.ctx.uploadTransferredBytes = 0;
    this.ctx.uploadTotalBytes = 0;
    this.ctx.importTransferCount = 0;
    this.ctx.importTransferredBytes = 0;
    this.ctx.importTotalBytes = 0;
    this._resetPublishProgress();
    this.ctx.emitHealth();
  }

  async _runMirror() {
    if (this._mirroring || !this._mirror || this._stopped) return;
    this._mirroring = true;
    this.ctx.mirrorActive = true;
    this._setPublishPlan(await this._planOwnerMirror());
    try {
      let previousDiff = null;
      for await (const diff of this._mirror) {
        if (previousDiff) this._markPublishDiffComplete(previousDiff);
        this._setCurrentPublishDiff(diff);
        previousDiff = diff;
      }
      if (previousDiff) this._markPublishDiffComplete(previousDiff);
      this.ctx.lastMirrorStatus = 'ok';
    } catch (err) {
      if (!this._stopped && isRetryableMirrorError(err)) {
        this.ctx.lastMirrorStatus = 'pending';
        this._debounceMirror();
        return;
      }
      if (!this._stopped && !isClosedSessionError(err)) {
        this._log('error', 'owner', 'Mirror error', err);
        this.ctx.lastMirrorStatus = 'error';
        this.ctx.lastError = err.message;
      }
    } finally {
      this._mirroring = false;
      this.ctx.mirrorActive = false;
      this._resetPublishProgress();
      if (this._stopped) return;
      this.ctx.emitHealth();
      this.ctx.emitFileList();
    }
  }

  _debounceMirror() {
    if (this._mirrorTimeout) return;
    this._mirrorTimeout = setTimeout(async () => {
      this._mirrorTimeout = null;
      if (this._folderPath && !this._mirroring && !this._stopped && this.ctx.dataPlane?.drive) {
        loadDeps();
        const localDrive = new LocalDrive(this._folderPath);
        this._mirror = this._createOwnerMirror(localDrive);
        await this._runMirror();
      }
    }, 500);
  }

  _ensureTransferJobs() {
    if (!this._transferJobs) {
      const stagingDir = PathService.getStagingPath(this.ctx.storagePath, this.ctx.session.sessionCode);
      this._transferJobs = new TransferJobs({
        stagingDir,
        onProgress: () => {
          this._updateTransferState();
          this.ctx.emitFileList();
        },
        onComplete: (job) => {
          this._log('info', 'transfer', 'Transfer complete', job);
          if (job?.direction === 'upload' && job?.meta?.sourcePath) {
            const normalizedSourcePath = path.resolve(job.meta.sourcePath);
            this._peerUploadState.set(normalizedSourcePath, {
              remotePath: job.path,
              totalBytes: Number(job.totalBytes) || 0,
              fingerprint: job.meta.sourceFingerprint || null,
            });
            this._rescheduleIfSourceOutgrewJob(job);
          }
          if (job?.direction === 'download' && job?.meta?.kind === 'member-private-import') {
            void this._ensurePrivateShareObjectManifest(
              job.path,
              job.meta.localPath,
              Number(job.totalBytes) || 0,
              {
                memberId: job.meta.memberId || null,
                sharePath: job.meta.sharePath || null,
              }
            );
          }
          this._refreshTransferStateSoon();
          this.ctx.emitFileList();
        },
        onError: (job) => {
          this._log('error', 'transfer', 'Transfer failed', job);
          if (job?.direction === 'upload' && job?.meta?.sourcePath && fs.existsSync(job.meta.sourcePath)) {
            this._schedulePeerUpload(job.meta.sourcePath, 1000);
          }
          this._refreshTransferStateSoon();
          this.ctx.emitFileList();
        },
      });
    }
    return this._transferJobs;
  }

  _getActiveJobs() {
    return this._transferJobs ? this._transferJobs.getActiveJobs() : [];
  }

  _getTransferJob(remotePath, activeJobs = this._getActiveJobs()) {
    return activeJobs.find((job) => job.path === remotePath && job.status !== 'complete') || null;
  }

  _cancelTransferJobs(predicate) {
    if (!this._transferJobs || typeof predicate !== 'function') return false;
    let cancelled = false;
    for (const job of this._getActiveJobs()) {
      if (!predicate(job)) continue;
      cancelled = this._transferJobs.cancel(job.id) || cancelled;
    }
    if (cancelled) {
      this._refreshTransferStateSoon();
      this.ctx.emitFileList();
    }
    return cancelled;
  }

  _updateTransferState() {
    const jobs = this._transferJobs ? this._transferJobs.getActiveJobs() : [];
    this.ctx.activeTransferCount = jobs.length;
    this.ctx.uploadTransferCount = jobs.filter((job) => job.direction === 'upload').length;
    this.ctx.uploadTransferredBytes = jobs
      .filter((job) => job.direction === 'upload')
      .reduce((sum, job) => sum + (Number(job.bytesTransferred) || 0), 0);
    this.ctx.uploadTotalBytes = jobs
      .filter((job) => job.direction === 'upload')
      .reduce((sum, job) => sum + (Number(job.totalBytes) || 0), 0);
    this.ctx.importTransferCount = jobs.filter((job) => job.direction === 'download').length;
    this.ctx.importTransferredBytes = jobs
      .filter((job) => job.direction === 'download')
      .reduce((sum, job) => sum + (Number(job.bytesTransferred) || 0), 0);
    this.ctx.importTotalBytes = jobs
      .filter((job) => job.direction === 'download')
      .reduce((sum, job) => sum + (Number(job.totalBytes) || 0), 0);
    this.ctx.emitHealth();
  }

  _refreshTransferStateSoon() {
    setTimeout(() => this._updateTransferState(), 0);
  }

  _getPeerUploadRootInfo() {
    const session = this.ctx.session;
    const deviceId = this.ctx.identity?.deviceId;
    if (!session || !deviceId) return null;
    const sharePath = this._getSharePathForDevice(deviceId);
    if (!sharePath) return null;

    const workspacePath = PathService.ensureManagedWorkspace(this.ctx.storagePath, session.sessionCode);
    const localRoot = PathService.ensureWorkspaceFolder(workspacePath, sharePath);
    return { sharePath, localRoot, workspacePath };
  }

  _getSharePathForDevice(deviceId) {
    if (!this.ctx.session || !deviceId) return null;
    const existing = this.ctx.session.privateShares?.[deviceId]?.path || `Private/${String(deviceId || '').trim()}`;
    return normalizeSessionPath(existing);
  }

  _resolvePeerUploadLocalPath(remotePath) {
    const info = this._getPeerUploadRootInfo();
    const normalizedPath = normalizeSessionPath(remotePath);
    if (!info || !normalizedPath) return null;
    if (normalizedPath !== info.sharePath && !normalizedPath.startsWith(info.sharePath + '/')) return null;
    return PathService.resolveWorkspacePath(info.workspacePath, normalizedPath);
  }

  _getLocalAvailability(remotePath, remoteSize, role) {
    const sessionCode = this.ctx.session?.sessionCode || '';
    if (role === Permissions.ROLE_OWNER) {
      const localPath = this._folderPath || this.ctx.sourceFolderPath;
      const absolutePath = localPath ? PathService.resolveWorkspacePath(localPath, remotePath) : null;
      const exists = !!absolutePath && fs.existsSync(absolutePath);
      const localBytes = exists && fs.statSync(absolutePath).isFile() ? fs.statSync(absolutePath).size : 0;
      return { exists, localBytes, localOnly: false };
    }

    const uploadPath = this._resolvePeerUploadLocalPath(remotePath);
    if (uploadPath && fs.existsSync(uploadPath)) {
      const stat = fs.statSync(uploadPath);
      return {
        exists: true,
        localBytes: stat.isFile() ? stat.size : remoteSize || 0,
        localOnly: true,
      };
    }

    const cacheExists = PathService.localFileExists(this.ctx.storagePath, sessionCode, remotePath);
    return {
      exists: cacheExists,
      localBytes: cacheExists ? PathService.getLocalFileSize(this.ctx.storagePath, sessionCode, remotePath) : 0,
      localOnly: false,
    };
  }

  _mergePeerUploadEntries(entriesByPath, dirs, activeJobs) {
    const info = this._getPeerUploadRootInfo();
    if (!info || !fs.existsSync(info.localRoot)) return;

    const stack = [{ absolutePath: info.localRoot, relativePath: '' }];
    while (stack.length) {
      const current = stack.pop();
      let names = [];
      try {
        names = fs.readdirSync(current.absolutePath);
      } catch (_) {
        continue;
      }

      for (const name of names) {
        if (!name || name.startsWith('.')) continue;
        const absolutePath = path.join(current.absolutePath, name);
        let stat = null;
        try {
          stat = fs.statSync(absolutePath);
        } catch (_) {
          continue;
        }

        const relativePath = current.relativePath ? path.join(current.relativePath, name) : name;
        const normalizedRelative = normalizeSessionPath(relativePath);
        const remotePath = buildRemotePath(info.sharePath, normalizedRelative);

        const parts = remotePath.split('/');
        for (let i = 1; i < parts.length; i++) {
          dirs.add(parts.slice(0, i).join('/'));
        }

        if (stat.isDirectory()) {
          if (!entriesByPath.has(remotePath)) {
            entriesByPath.set(remotePath, {
              path: remotePath,
              name,
              size: 0,
              kind: 'directory',
              availability: 'local-only',
              localBytes: 0,
              isDirectory: true,
              visibility: 'all',
              localOnly: true,
              transferId: null,
              transferDirection: null,
              progress: null,
            });
          }
          stack.push({ absolutePath, relativePath: normalizedRelative });
          continue;
        }

        const activeJob = this._getTransferJob(remotePath, activeJobs);
        if (entriesByPath.has(remotePath)) {
          const currentEntry = entriesByPath.get(remotePath);
          currentEntry.size = stat.size;
          currentEntry.localBytes = stat.size;
          currentEntry.localOnly = true;
          currentEntry.availability = activeJob ? 'partial' : 'local-only';
          currentEntry.visibility = 'all';
          if (activeJob) {
            currentEntry.transferId = activeJob.id;
            currentEntry.transferDirection = activeJob.direction;
            currentEntry.progress = activeJob.progress;
          } else {
            currentEntry.transferId = null;
            currentEntry.transferDirection = null;
            currentEntry.progress = null;
          }
          continue;
        }

        entriesByPath.set(remotePath, {
          path: remotePath,
          name,
          size: stat.size,
          kind: 'file',
          availability: 'local-only',
          localBytes: stat.size,
          isDirectory: false,
          visibility: 'all',
          localOnly: true,
          transferId: activeJob ? activeJob.id : null,
          transferDirection: activeJob ? activeJob.direction : null,
          progress: activeJob ? activeJob.progress : null,
        });
      }
    }
  }

  _mergeOwnerLocalEntries(entriesByPath, dirs, activeJobs) {
    const workspacePath = this._folderPath || this.ctx.sourceFolderPath;
    if (!workspacePath || !fs.existsSync(workspacePath)) return;

    const stack = [{ absolutePath: workspacePath, relativePath: '' }];
    while (stack.length) {
      const current = stack.pop();
      let names = [];
      try {
        names = fs.readdirSync(current.absolutePath);
      } catch (_) {
        continue;
      }

      for (const name of names) {
        if (!name || name.startsWith('.')) continue;
        const absolutePath = path.join(current.absolutePath, name);
        let stat = null;
        try {
          stat = fs.statSync(absolutePath);
        } catch (_) {
          continue;
        }

        const relativePath = current.relativePath ? path.join(current.relativePath, name) : name;
        const remotePath = normalizeSessionPath(relativePath);
        if (!remotePath) continue;

        const parts = remotePath.split('/');
        for (let i = 1; i < parts.length; i++) {
          dirs.add(parts.slice(0, i).join('/'));
        }

        const activeJob = this._getTransferJob(remotePath, activeJobs);
        if (stat.isDirectory()) {
          if (!entriesByPath.has(remotePath)) {
            entriesByPath.set(remotePath, {
              path: remotePath,
              name,
              size: 0,
              kind: 'directory',
              availability: 'downloaded',
              localBytes: 0,
              isDirectory: true,
              visibility: Permissions.getPathVisibility(this.ctx.session, remotePath),
              localOnly: false,
              transferId: null,
              transferDirection: null,
              progress: null,
            });
          }
          stack.push({ absolutePath, relativePath: remotePath });
          continue;
        }

        if (entriesByPath.has(remotePath)) {
          const currentEntry = entriesByPath.get(remotePath);
          currentEntry.localBytes = stat.size;
          currentEntry.availability = activeJob ? 'partial' : 'downloaded';
          currentEntry.transferId = activeJob ? activeJob.id : currentEntry.transferId;
          currentEntry.transferDirection = activeJob ? activeJob.direction : currentEntry.transferDirection;
          currentEntry.progress = activeJob ? activeJob.progress : currentEntry.progress;
          continue;
        }

        entriesByPath.set(remotePath, {
          path: remotePath,
          name,
          size: stat.size,
          kind: 'file',
          availability: activeJob ? 'partial' : 'local-only',
          localBytes: stat.size,
          isDirectory: false,
          visibility: Permissions.getPathVisibility(this.ctx.session, remotePath),
          localOnly: true,
          transferId: activeJob ? activeJob.id : null,
          transferDirection: activeJob ? activeJob.direction : null,
          progress: activeJob ? activeJob.progress : null,
        });
      }
    }
  }

  _mergeTransferPlaceholders(entriesByPath, dirs, activeJobs) {
    for (const job of activeJobs) {
      if (!job?.path || entriesByPath.has(job.path)) continue;
      const parts = normalizeSessionPath(job.path).split('/').filter(Boolean);
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join('/'));
      }
      entriesByPath.set(job.path, {
        path: job.path,
        name: path.basename(job.path),
        size: Number(job.totalBytes) || 0,
        kind: 'file',
        availability: 'partial',
        localBytes: Number(job.bytesTransferred) || 0,
        isDirectory: false,
        visibility: Permissions.getPathVisibility(this.ctx.session, job.path),
        localOnly: job.direction === 'upload',
        transferId: job.id,
        transferDirection: job.direction,
        progress: job.progress || 0,
      });
    }
  }

  _suppressStaleRemoteEntries(entriesByPath, role) {
    const workspacePath = this._folderPath || this.ctx.sourceFolderPath;
    const ownSharePath = this._peerUploadSharePath || this._getPeerUploadRootInfo()?.sharePath || null;

    for (const [entryPath, entry] of Array.from(entriesByPath.entries())) {
      if (!entryPath || !entry || entry.transferId) continue;

      if (role === Permissions.ROLE_OWNER) {
        if (!workspacePath) continue;
        const localPath = PathService.resolveWorkspacePath(workspacePath, entryPath);
        if (fs.existsSync(localPath)) continue;
        entriesByPath.delete(entryPath);
        continue;
      }

      if (!ownSharePath) continue;
      if (entryPath !== ownSharePath && !entryPath.startsWith(ownSharePath + '/')) continue;
      const localPath = this._resolvePeerUploadLocalPath(entryPath);
      if (localPath && fs.existsSync(localPath)) continue;
      entriesByPath.delete(entryPath);
    }

    for (const [entryPath, entry] of Array.from(entriesByPath.entries())) {
      if (!entry?.isDirectory) continue;
      const prefix = `${entryPath}/`;
      const hasChild = Array.from(entriesByPath.keys()).some((candidatePath) => (
        candidatePath !== entryPath && candidatePath.startsWith(prefix)
      ));
      if (!hasChild) {
        entriesByPath.delete(entryPath);
      }
    }
  }

  async _ensurePeerUploadSync() {
    loadDeps();
    const session = this.ctx.session;
    const deviceId = this.ctx.identity?.deviceId;
    if (!session || !deviceId) return null;

    const role = Permissions.getRoleForDevice(session, deviceId);
    if (role === Permissions.ROLE_OWNER) return null;

    const shareInfo = this._getPeerUploadRootInfo();
    const canUpload = Permissions.canUpload(session, deviceId, role);
    if (!shareInfo || !canUpload) {
      await this._stopPeerUploadSync();
      this.ctx.node?.setUploadDriveKey?.(null);
      this.ctx.node?.broadcastPresence?.();
      this.ctx.syncReady = false;
      this.ctx.watcherActive = false;
      this.ctx.emitHealth();
      this._log('info', 'peer-upload', 'Peer upload lane inactive', {
        hasShareInfo: !!shareInfo,
        canUpload,
        sessionCode: session.sessionCode,
      });
      return null;
    }

    if (!this._peerUploadDrive || this._peerUploadSessionCode !== session.sessionCode) {
      const store = this.ctx.storage.getStore();
      if (!store || store.closing) return null;

      if (this._peerUploadDrive) {
        try { await this._peerUploadDrive.close(); } catch (_) {}
      }

      const namespace = store.namespace(`uploads:${session.sessionCode}:${deviceId}`);
      this._peerUploadDrive = new Hyperdrive(namespace);
      await this._peerUploadDrive.ready();
      this._peerUploadSessionCode = session.sessionCode;
      this.ctx.node?.setUploadDriveKey?.(this._peerUploadDrive.key?.toString('hex') || null);
      this.ctx.node?.broadcastPresence?.();
      this._log('info', 'peer-upload', 'Peer upload drive ready', {
        sessionCode: session.sessionCode,
        sharePath: shareInfo.sharePath,
      });
    }

    if (!this._peerUploadWatcher || this._peerUploadRoot !== shareInfo.localRoot) {
      if (this._peerUploadWatcher) {
        await this._peerUploadWatcher.close();
      }
      this._peerUploadRoot = shareInfo.localRoot;
      this._peerUploadSharePath = shareInfo.sharePath;
      this._peerUploadWatcher = chokidar.watch(shareInfo.localRoot, {
        ignoreInitial: false,
        persistent: true,
        awaitWriteFinish: { stabilityThreshold: 750, pollInterval: 150 },
      });
      this._peerUploadWatcher.on('addDir', (entryPath) => { void this._queuePeerUploadDirectory(entryPath); });
      this._peerUploadWatcher.on('add', (entryPath) => { this._schedulePeerUpload(entryPath); });
      this._peerUploadWatcher.on('change', (entryPath) => { this._schedulePeerUpload(entryPath); });
      this._peerUploadWatcher.on('unlink', (entryPath) => {
        this._clearPeerUploadTimer(entryPath);
        void this._deletePeerUpload(entryPath);
      });
      this._peerUploadWatcher.on('unlinkDir', (entryPath) => {
        this._clearPeerUploadTimer(entryPath, { recursive: true });
        void this._deletePeerUpload(entryPath, { recursive: true });
      });
      this._log('debug', 'peer-upload', 'Peer upload watcher active', {
        localRoot: shareInfo.localRoot,
        sharePath: shareInfo.sharePath,
      });
    }

    this.ctx.syncReady = true;
    this.ctx.watcherActive = true;
    this.ctx.emitHealth();
    return shareInfo;
  }

  async _stopPeerUploadSync() {
    for (const timer of this._peerUploadTimers.values()) {
      clearTimeout(timer);
    }
    this._peerUploadTimers.clear();
    if (this._peerUploadWatcher) {
      await this._peerUploadWatcher.close();
      this._peerUploadWatcher = null;
    }
    if (this._peerUploadDrive) {
      try { await this._peerUploadDrive.close(); } catch (_) {}
      this._peerUploadDrive = null;
    }
    this._peerUploadRoot = null;
    this._peerUploadSharePath = null;
    this._peerUploadSessionCode = null;
    this._peerUploadState.clear();
  }

  _clearPeerUploadTimer(localPath, { recursive = false } = {}) {
    const normalizedPath = path.resolve(localPath);
    if (!recursive) {
      const timer = this._peerUploadTimers.get(normalizedPath);
      if (timer) {
        clearTimeout(timer);
        this._peerUploadTimers.delete(normalizedPath);
      }
      return;
    }

    for (const [scheduledPath, timer] of Array.from(this._peerUploadTimers.entries())) {
      if (scheduledPath === normalizedPath || scheduledPath.startsWith(normalizedPath + path.sep)) {
        clearTimeout(timer);
        this._peerUploadTimers.delete(scheduledPath);
      }
    }
  }

  _schedulePeerUpload(localPath, delayMs = 250) {
    if (!localPath) return;
    const normalizedPath = path.resolve(localPath);
    this._clearPeerUploadTimer(normalizedPath);
    const timer = setTimeout(async () => {
      this._peerUploadTimers.delete(normalizedPath);
      try {
        await this._waitForSettledLocalFile(normalizedPath);
        await this._queuePeerUpload(normalizedPath);
      } catch (_) {}
    }, delayMs);
    this._peerUploadTimers.set(normalizedPath, timer);
  }

  async _waitForSettledLocalFile(localPath) {
    let initialStat = null;
    try {
      initialStat = fs.statSync(localPath);
    } catch (_) {
      throw new Error('File is unavailable.');
    }
    if (!initialStat.isFile()) {
      throw new Error('Path is not a file.');
    }

    const pollMs = initialStat.size >= LARGE_FILE_SIZE_BYTES
      ? LARGE_UPLOAD_SETTLE_POLL_MS
      : UPLOAD_SETTLE_POLL_MS;
    const requiredPasses = initialStat.size >= LARGE_FILE_SIZE_BYTES
      ? LARGE_UPLOAD_SETTLE_PASSES
      : UPLOAD_SETTLE_PASSES;

    let previousFingerprint = null;
    let stablePasses = 0;
    while (stablePasses < requiredPasses) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      let stat = null;
      try {
        stat = fs.statSync(localPath);
      } catch (_) {
        throw new Error('File disappeared before upload.');
      }
      if (!stat.isFile()) throw new Error('Path is no longer a file.');
      const fingerprint = `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
      if (fingerprint === previousFingerprint) {
        stablePasses += 1;
      } else {
        previousFingerprint = fingerprint;
        stablePasses = 1;
      }
    }
  }

  _getLocalFileFingerprint(stat) {
    if (!stat?.isFile?.()) return null;
    return `${Number(stat.size) || 0}:${Math.trunc(Number(stat.mtimeMs) || 0)}`;
  }

  _resolveExistingPath(targetPath) {
    let currentPath = path.resolve(String(targetPath || this.ctx.storagePath || '.'));
    while (!fs.existsSync(currentPath)) {
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) return null;
      currentPath = parentPath;
    }
    return currentPath;
  }

  _getAvailableBytes(targetPath) {
    const existingPath = this._resolveExistingPath(targetPath);
    if (!existingPath || typeof fs.statfsSync !== 'function') return null;
    try {
      const stats = fs.statfsSync(existingPath);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch (_) {
      return null;
    }
  }

  _requiredFreeBytes(contentBytes) {
    const normalizedBytes = Math.max(0, Number(contentBytes) || 0);
    return Math.max(normalizedBytes + MIN_SYNC_HEADROOM_BYTES, Math.ceil(normalizedBytes * 1.05));
  }

  _setSyncError(message) {
    this.ctx.lastError = message;
    this.ctx.emitHealth();
  }

  _clearSyncError(prefix = 'Not enough free space') {
    if (!this.ctx.lastError) return;
    if (!String(this.ctx.lastError).startsWith(prefix)) return;
    this.ctx.lastError = null;
    this.ctx.emitHealth();
  }

  _ensureFreeSpace(targetPath, contentBytes, operationLabel) {
    const availableBytes = this._getAvailableBytes(targetPath);
    if (availableBytes == null) return true;

    const requiredBytes = this._requiredFreeBytes(contentBytes);
    if (availableBytes >= requiredBytes) return true;

    const volumePath = this._resolveExistingPath(targetPath) || String(targetPath || 'target volume');
    this._setSyncError(
      `Not enough free space for ${operationLabel}. Need about ${formatBytes(requiredBytes)} on ${volumePath}, but only ${formatBytes(availableBytes)} is available.`
    );
    return false;
  }

  _rescheduleIfSourceOutgrewJob(job) {
    const sourcePath = job?.meta?.sourcePath || job?._sourcePath || null;
    if (!sourcePath) return;
    try {
      const stat = fs.statSync(sourcePath);
      if (!stat.isFile()) return;
      if (stat.size > (Number(job.totalBytes) || 0)) {
        this._schedulePeerUpload(sourcePath, 250);
      }
    } catch (_) {}
  }

  async _queuePeerUpload(localPath) {
    if (!this._peerUploadDrive || !this._peerUploadRoot || !this._peerUploadSharePath) return;
    let stat = null;
    try {
      stat = fs.statSync(localPath);
    } catch (_) {
      return;
    }
    if (!stat.isFile()) return;
    const normalizedPath = path.resolve(localPath);
    const sourceFingerprint = this._getLocalFileFingerprint(stat);

    const relativePath = normalizeSessionPath(path.relative(this._peerUploadRoot, localPath));
    if (!relativePath || relativePath.startsWith('..')) return;
    if (path.basename(localPath).startsWith('.')) return;

    const remotePath = buildRemotePath(this._peerUploadSharePath, relativePath);
    const existingUploadState = this._peerUploadState.get(normalizedPath);
    if (existingUploadState?.fingerprint && existingUploadState.fingerprint === sourceFingerprint) {
      return null;
    }

    let existingRemoteEntry = null;
    try {
      existingRemoteEntry = await this._peerUploadDrive.entry('/' + normalizeSessionPath(relativePath));
    } catch (_) {}
    const remoteBytes = Number(existingRemoteEntry?.value?.blob?.byteLength) || 0;
    if (remoteBytes > 0 && remoteBytes === stat.size) {
      this._peerUploadState.set(normalizedPath, {
        remotePath,
        totalBytes: remoteBytes,
        fingerprint: sourceFingerprint,
      });
      return null;
    }

    const existingJob = this._getTransferJob(remotePath);
    if (existingJob) {
      const queuedBytes = Number(existingJob.totalBytes) || 0;
      const transferredBytes = Number(existingJob.bytesTransferred) || 0;
      if (stat.size > queuedBytes || transferredBytes < stat.size) {
        this._schedulePeerUpload(localPath, 1000);
      }
      return existingJob;
    }

    if (!this._ensureFreeSpace(
      path.join(this.ctx.storagePath, 'corestore'),
      stat.size,
      `uploading ${path.basename(localPath)}`
    )) {
      return null;
    }

    const transferJobs = this._ensureTransferJobs();
    const job = transferJobs.enqueueUpload({
      remotePath,
      targetPath: relativePath,
      sourcePath: localPath,
      sourceFingerprint,
      totalBytes: stat.size,
      sessionCode: this.ctx.session.sessionCode,
      meta: {
        kind: 'peer-private-upload',
        sourcePath: localPath,
        sourceFingerprint,
      },
      createWriteStream: (entryPath) => this._peerUploadDrive.createWriteStream('/' + normalizeSessionPath(entryPath)),
    });
    this._log('info', 'peer-upload', 'Queued private upload', {
      remotePath,
      sourcePath: localPath,
      totalBytes: stat.size,
    });
    this._clearSyncError();
    this._updateTransferState();
    this.ctx.emitFileList();
    return job;
  }

  async _queuePeerUploadDirectory(directoryPath) {
    let stat = null;
    try {
      stat = fs.statSync(directoryPath);
    } catch (_) {
      return;
    }
    if (!stat.isDirectory()) return;

    const stack = [directoryPath];
    while (stack.length) {
      const current = stack.pop();
      let names = [];
      try {
        names = fs.readdirSync(current);
      } catch (_) {
        continue;
      }

      for (const name of names) {
        if (!name || name.startsWith('.')) continue;
        const absolutePath = path.join(current, name);
        let childStat = null;
        try {
          childStat = fs.statSync(absolutePath);
        } catch (_) {
          continue;
        }
        if (childStat.isDirectory()) {
          stack.push(absolutePath);
          continue;
        }
        await this._queuePeerUpload(absolutePath);
      }
    }
  }

  async _deletePeerUpload(localPath, { recursive = false } = {}) {
    if (!this._peerUploadDrive || !this._peerUploadRoot) return;
    const normalizedLocalPath = path.resolve(localPath);
    const relativePath = normalizeSessionPath(path.relative(this._peerUploadRoot, localPath));
    if (!relativePath || relativePath.startsWith('..')) return;
    const remotePath = buildRemotePath(this._peerUploadSharePath, relativePath);
    try {
      this._cancelTransferJobs((job) => {
        if (job?.direction !== 'upload' || !job?.path) return false;
        if (!recursive) return job.path === remotePath;
        return job.path === remotePath || job.path.startsWith(remotePath + '/');
      });
      if (recursive) {
        const prefix = relativePath + '/';
        const keys = [];
        for await (const entry of this._peerUploadDrive.list('/', { recursive: true })) {
          const entryPath = normalizeSessionPath(entry.key);
          if (!entryPath || (entryPath !== relativePath && !entryPath.startsWith(prefix))) continue;
          keys.push('/' + entryPath);
        }
        for (const key of keys) {
          await this._peerUploadDrive.del(key);
        }
        await this._peerUploadDrive.del('/' + relativePath).catch(() => {});
        for (const [sourcePath, uploadState] of Array.from(this._peerUploadState.entries())) {
          const sourceRelative = normalizeSessionPath(path.relative(this._peerUploadRoot, sourcePath));
          if (!sourceRelative) continue;
          if (sourceRelative === relativePath || sourceRelative.startsWith(prefix)) {
            this._peerUploadState.delete(sourcePath);
          } else if (uploadState?.remotePath === remotePath
            || uploadState?.remotePath?.startsWith(buildRemotePath(this._peerUploadSharePath, prefix))) {
            this._peerUploadState.delete(sourcePath);
          }
        }
      } else {
        await this._peerUploadDrive.del('/' + relativePath);
        this._peerUploadState.delete(normalizedLocalPath);
      }
      this.ctx.emitFileList();
    } catch (_) {}
  }

  async _syncMemberUploadSources() {
    loadDeps();
    if (this._memberUploadSyncing || this._stopped) return;
    if (!this.ctx.session || !this.ctx.dataPlane?.writable) return;

    this._memberUploadSyncing = true;
    try {
      const workspacePath = this._folderPath || this.ctx.sourceFolderPath;
      if (!workspacePath) return;

      const activeMembers = new Set();
      const memberIds = new Set([
        ...(this.ctx.session.admins || []),
        ...(this.ctx.session.viewers || []),
      ]);

      for (const memberId of memberIds) {
        if (!memberId || memberId === this.ctx.session.ownerId) continue;
        const policy = Permissions.getMemberAccessPolicy(this.ctx.session, memberId);
        const sharePath = this._getSharePathForDevice(memberId);
        const uploadDriveKey = this.ctx.peerRegistry.get(memberId)?.uploadDriveKey || null;
        const canImport = policy.status === Permissions.ACCESS_APPROVED
          && policy.uploadAccess === Permissions.UPLOAD_ALLOWED
          && !!sharePath
          && !!uploadDriveKey;

        if (!canImport) continue;
        activeMembers.add(memberId);

        const uploadDrive = await this._openMemberUploadDrive(memberId, uploadDriveKey);
        if (!uploadDrive) continue;

        const targetRoot = PathService.ensureWorkspaceFolder(workspacePath, sharePath);
        const changed = await this._syncMemberUploadDrive(memberId, uploadDrive, sharePath, targetRoot);
        if (changed) this.ctx.emitFileList();
      }

      for (const [memberId, record] of Array.from(this._memberUploadDrives.entries())) {
        if (activeMembers.has(memberId)) continue;
        try { await record.drive.close(); } catch (_) {}
        this._memberUploadDrives.delete(memberId);
      }
    } catch (err) {
      if (!this._stopped && !isClosedSessionError(err) && !isRetryableMirrorError(err)) {
        this._log('error', 'owner-import', 'Member upload mirror error', err);
      }
    } finally {
      this._memberUploadSyncing = false;
    }
  }

  async _openMemberUploadDrive(memberId, uploadDriveKey) {
    const existing = this._memberUploadDrives.get(memberId);
    if (existing && existing.key === uploadDriveKey && existing.drive && !existing.drive.closing) {
      return existing.drive;
    }

    if (existing?.drive) {
      try { await existing.drive.close(); } catch (_) {}
    }

    const store = this.ctx.storage.getStore();
    if (!store || store.closing) return null;

    const namespace = store.namespace(`uploads:${this.ctx.session.sessionCode}:${memberId}`);
    const drive = new Hyperdrive(namespace, Buffer.from(uploadDriveKey, 'hex'));
    await drive.ready();
    this._memberUploadDrives.set(memberId, { key: uploadDriveKey, drive });
    return drive;
  }

  async _closeMemberUploadDrives() {
    for (const { drive } of this._memberUploadDrives.values()) {
      try { await drive.close(); } catch (_) {}
    }
    this._memberUploadDrives.clear();
    this._memberUploadPresence.clear();
  }

  _getMemberUploadPresence(memberId) {
    if (!this._memberUploadPresence.has(memberId)) {
      this._memberUploadPresence.set(memberId, new Map());
    }
    return this._memberUploadPresence.get(memberId);
  }

  _getActiveImportRelativePaths(sharePath) {
    const activeImports = new Set();
    const normalizedSharePath = normalizeSessionPath(sharePath);
    for (const job of this._getActiveJobs()) {
      if (job?.direction !== 'download' || !job?.path) continue;
      const normalizedPath = normalizeSessionPath(job.path);
      if (!normalizedPath) continue;
      if (normalizedPath === normalizedSharePath) continue;
      if (!normalizedPath.startsWith(normalizedSharePath + '/')) continue;
      activeImports.add(normalizedPath.slice(normalizedSharePath.length + 1));
    }
    return activeImports;
  }

  async _syncMemberUploadDrive(memberId, uploadDrive, sharePath, targetRoot) {
    const transferJobs = this._ensureTransferJobs();
    const remoteFiles = new Set();
    const preservedDirectories = new Set();
    const activeImportPaths = this._getActiveImportRelativePaths(sharePath);
    const presence = this._getMemberUploadPresence(memberId);
    let changed = false;
    const stagingRoot = path.join(
      PathService.getStagingPath(this.ctx.storagePath, this.ctx.session.sessionCode),
      'member-imports',
      String(memberId || 'unknown')
    );

    try {
      for await (const entry of uploadDrive.list('/', { recursive: true })) {
        const relativePath = normalizeSessionPath(entry.key);
        if (!relativePath) continue;
        if (!entry?.value?.blob) continue;

        const remotePath = buildRemotePath(sharePath, relativePath);
        const totalBytes = entry.value?.blob?.byteLength || 0;
        remoteFiles.add(relativePath);
        this._collectParentDirectories(relativePath, preservedDirectories);

        const localTarget = PathService.resolveWorkspacePath(targetRoot, relativePath);
        const activeJob = this._getTransferJob(remotePath);
        if (activeJob) continue;

        let localBytes = 0;
        let localStat = null;
        try {
          if (fs.existsSync(localTarget)) {
            localStat = fs.statSync(localTarget);
            localBytes = localStat.size;
          }
        } catch (_) {}
        if (localBytes === totalBytes && totalBytes > 0) {
          await this._ensurePrivateShareObjectManifest(remotePath, localTarget, totalBytes, {
            memberId,
            sharePath,
            sourceFingerprint: this._getLocalFileFingerprint(localStat),
          });
          continue;
        }

        const tempPath = path.join(
          stagingRoot,
          relativePath + `.${this.ctx.session.sessionCode}.incoming`
        );

        if (!this._ensureFreeSpace(
          path.dirname(tempPath),
          totalBytes,
          `importing ${path.basename(localTarget)}`
        )) {
          continue;
        }

        transferJobs.enqueueDownload({
          remotePath,
          localPath: localTarget,
          tempPath,
          totalBytes,
          sessionCode: this.ctx.session.sessionCode,
          meta: {
            kind: 'member-private-import',
            memberId,
            sharePath,
            localPath: localTarget,
          },
          createReadStream: (entryPath) => {
            const normalizedEntry = normalizeSessionPath(entryPath);
            const relativeEntryPath = normalizedEntry === sharePath
              ? ''
              : normalizedEntry.replace(sharePath + '/', '');
            return uploadDrive.createReadStream('/' + normalizeSessionPath(relativeEntryPath));
          },
        });
        this._log('info', 'owner-import', 'Queued member private import', {
          memberId,
          remotePath,
          localTarget,
          totalBytes,
        });
        this._clearSyncError();
        changed = true;
      }
    } catch (err) {
      if (!this._stopped && !isClosedSessionError(err) && !isRetryableMirrorError(err)) {
        this._log('error', 'owner-import', 'Member upload import error', err);
      }
      return changed;
    }

    const staleImportPaths = Array.from(activeImportPaths).filter((relativePath) => !remoteFiles.has(relativePath));
    if (staleImportPaths.length) {
      const staleSet = new Set(staleImportPaths);
      this._cancelTransferJobs((job) => {
        if (job?.direction !== 'download' || !job?.path) return false;
        const normalizedPath = normalizeSessionPath(job.path);
        if (!normalizedPath.startsWith(sharePath + '/')) return false;
        const relativePath = normalizedPath.slice(sharePath.length + 1);
        return staleSet.has(relativePath);
      });
      for (const relativePath of staleImportPaths) {
        activeImportPaths.delete(relativePath);
      }
    }

    const stack = [targetRoot];
    while (stack.length) {
      const current = stack.pop();
      let names = [];
      try {
        names = fs.readdirSync(current);
      } catch (_) {
        continue;
      }

      for (const name of names) {
        if (!name || name.startsWith('.')) continue;
        const absolutePath = path.join(current, name);
        let stat = null;
        try {
          stat = fs.statSync(absolutePath);
        } catch (_) {
          continue;
        }
        const relativePath = normalizeSessionPath(path.relative(targetRoot, absolutePath));
        if (!relativePath) continue;
        if (stat.isDirectory()) {
          stack.push(absolutePath);
          continue;
        }
        if (remoteFiles.has(relativePath) || activeImportPaths.has(relativePath)) {
          presence.set(relativePath, { missingPasses: 0, lastSeenAt: Date.now() });
          continue;
        }
        const previousPresence = presence.get(relativePath);
        const missingPasses = (previousPresence?.missingPasses || 0) + 1;
        if (missingPasses < MEMBER_UPLOAD_MISSING_GRACE_PASSES) {
          presence.set(relativePath, { missingPasses, lastSeenAt: previousPresence?.lastSeenAt || 0 });
          continue;
        }
        try {
          fs.rmSync(absolutePath, { force: true });
          await this._deletePrivateShareObjectManifest(buildRemotePath(sharePath, relativePath));
          presence.delete(relativePath);
          changed = true;
        } catch (_) {}
      }
    }

    if (this._pruneEmptyDirectories(targetRoot, preservedDirectories)) {
      changed = true;
    }

    this._updateTransferState();
    return changed;
  }

  _collectParentDirectories(relativePath, targetSet) {
    const parts = normalizeSessionPath(relativePath).split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      targetSet.add(parts.slice(0, i).join('/'));
    }
  }

  _pruneEmptyDirectories(rootPath, preservedDirectories = new Set()) {
    let changed = false;
    const visit = (currentPath) => {
      let names = [];
      try {
        names = fs.readdirSync(currentPath);
      } catch (_) {
        return false;
      }

      for (const name of names) {
        if (!name || name.startsWith('.')) continue;
        const childPath = path.join(currentPath, name);
        let stat = null;
        try {
          stat = fs.statSync(childPath);
        } catch (_) {
          continue;
        }
        if (stat.isDirectory()) {
          visit(childPath);
        }
      }

      if (currentPath === rootPath) return false;

      try {
        const relativePath = normalizeSessionPath(path.relative(rootPath, currentPath));
        if (relativePath && preservedDirectories.has(relativePath)) {
          return false;
        }
        const remaining = fs.readdirSync(currentPath).filter((name) => name && !name.startsWith('.'));
        if (remaining.length === 0) {
          fs.rmSync(currentPath, { recursive: true, force: true });
          changed = true;
          return true;
        }
      } catch (_) {}

      return false;
    };

    visit(rootPath);
    return changed;
  }

  _createOwnerMirror(localDrive, opts = {}) {
    return new MirrorDrive(localDrive, this.ctx.dataPlane.drive, {
      ...opts,
      transformers: [
        (key) => this._createPublishTransform(normalizeSessionPath(key)),
      ],
    });
  }

  _createPublishTransform(remotePath) {
    return new StreamxTransform({
      transform: (chunk, cb) => {
        this._updateCurrentPublishBytes(remotePath, chunk?.length || 0);
        cb(null, chunk);
      },
    });
  }

  async _ensurePrivateShareObjectManifest(remotePath, localPath, totalBytes, {
    memberId = null,
    sharePath = null,
    sourceFingerprint = null,
  } = {}) {
    const node = this.ctx.node;
    const session = this.ctx.session;
    if (!node?.session || !session || session.ownerId !== this.ctx.identity?.deviceId) return false;
    if (typeof node.upsertObjectManifest !== 'function' || typeof node.getObjectManifest !== 'function') return false;

    let stat = null;
    try {
      stat = fs.statSync(localPath);
    } catch (_) {
      return false;
    }
    if (!stat.isFile()) return false;

    const normalizedSize = Number(totalBytes) || stat.size || 0;
    const fingerprint = sourceFingerprint || this._getLocalFileFingerprint(stat) || null;
    const current = node.getObjectManifest(remotePath);
    const currentFingerprint = String(current?.metadata?.sourceFingerprint || '').trim() || null;
    const needsManifestUpdate = !current
      || Number(current.sizeBytes) !== normalizedSize
      || currentFingerprint !== fingerprint;

    try {
      if (needsManifestUpdate) {
        await node.upsertObjectManifest(remotePath, {
          sizeBytes: normalizedSize,
          metadata: {
            source: 'projector-private-upload',
            privateShare: true,
            memberId,
            sharePath,
            sourceFingerprint: fingerprint,
          },
        });
      }

      const manifest = node.getObjectManifest(remotePath);
      if (!manifest?.extents?.length || !node.localExtentStore) return needsManifestUpdate;

      let fd = null;
      let storedAny = false;
      try {
        fd = fs.openSync(localPath, 'r');
        for (const extent of manifest.extents) {
          if (await node.localExtentStore.hasExtent(extent.id)) continue;
          const buffer = Buffer.alloc(extent.length);
          const bytesRead = fs.readSync(fd, buffer, 0, extent.length, extent.offset);
          if (bytesRead !== extent.length) {
            throw new Error(`Incomplete extent read for ${remotePath}:${extent.id}`);
          }
          await node.storeExtentBytes(extent.id, buffer, {
            localRole: 'owner_seed',
            source: 'projector-private-upload',
          });
          storedAny = true;
        }
      } finally {
        if (fd != null) {
          try { fs.closeSync(fd); } catch (_) {}
        }
      }

      return needsManifestUpdate || storedAny;
    } catch (err) {
      if (!this._stopped) {
        this._log('error', 'manifest', 'Private share manifest sync error', err);
      }
      return false;
    }
  }

  async _deletePrivateShareObjectManifest(remotePath) {
    const node = this.ctx.node;
    const session = this.ctx.session;
    if (!node?.session || !session || session.ownerId !== this.ctx.identity?.deviceId) return false;
    if (typeof node.deleteObjectManifest !== 'function') return false;
    try {
      return await node.deleteObjectManifest(remotePath);
    } catch (err) {
      if (!this._stopped) {
        this._log('error', 'manifest', 'Private share manifest delete error', err);
      }
      return false;
    }
  }

  _createEmptyPublishProgress() {
    return {
      totalBytes: 0,
      transferredBytes: 0,
      totalOps: 0,
      completedOps: 0,
      totalWorkUnits: 0,
      completedWorkUnits: 0,
      currentPath: null,
      currentTotalBytes: 0,
      currentBytes: 0,
      currentOpWorkUnits: 0,
      progress: 0,
    };
  }

  async _planOwnerMirror() {
    if (!this._folderPath || !this.ctx.dataPlane?.drive) return this._createEmptyPublishProgress();
    loadDeps();
    const localDrive = new LocalDrive(this._folderPath);
    const planner = new MirrorDrive(localDrive, this.ctx.dataPlane.drive, { dryRun: true });
    const plan = this._createEmptyPublishProgress();

    for await (const diff of planner) {
      plan.totalOps += 1;
      plan.totalBytes += Number(diff?.bytesAdded) || 0;
      plan.totalWorkUnits += this._getPublishWorkUnits(diff);
    }

    return plan;
  }

  _getPublishWorkUnits(diff) {
    const bytesAdded = Number(diff?.bytesAdded) || 0;
    if (bytesAdded > 0) return bytesAdded;
    return 1;
  }

  _setPublishPlan(plan) {
    this._publishProgress = {
      ...this._createEmptyPublishProgress(),
      ...plan,
      progress: 0,
    };
    this._syncPublishProgressToContext();
    this._emitPublishProgress(true);
  }

  _setCurrentPublishDiff(diff) {
    if (!diff) return;
    this._publishProgress.currentPath = normalizeSessionPath(diff.key);
    this._publishProgress.currentTotalBytes = Number(diff.bytesAdded) || 0;
    this._publishProgress.currentBytes = 0;
    this._publishProgress.currentOpWorkUnits = this._getPublishWorkUnits(diff);
    this._recomputePublishProgress();
    this._syncPublishProgressToContext();
    this._emitPublishProgress();
  }

  _updateCurrentPublishBytes(remotePath, bytes) {
    if (!remotePath) return;
    if (this._publishProgress.currentPath !== remotePath) {
      this._publishProgress.currentPath = remotePath;
      this._publishProgress.currentBytes = 0;
    }
    this._publishProgress.currentBytes += Number(bytes) || 0;
    this._recomputePublishProgress();
    this._syncPublishProgressToContext();
    this._emitPublishProgress();
  }

  _markPublishDiffComplete(diff) {
    if (!diff) return;
    this._publishProgress.completedOps += 1;
    this._publishProgress.transferredBytes += Number(diff.bytesAdded) || 0;
    this._publishProgress.completedWorkUnits += this._getPublishWorkUnits(diff);
    this._publishProgress.currentPath = null;
    this._publishProgress.currentTotalBytes = 0;
    this._publishProgress.currentBytes = 0;
    this._publishProgress.currentOpWorkUnits = 0;
    this._recomputePublishProgress();
    this._syncPublishProgressToContext();
    this._emitPublishProgress(true);
  }

  _resetPublishProgress() {
    this._publishProgress = this._createEmptyPublishProgress();
    this._syncPublishProgressToContext();
    this._emitPublishProgress(true);
  }

  _recomputePublishProgress() {
    const totalWorkUnits = Number(this._publishProgress.totalWorkUnits) || 0;
    if (totalWorkUnits <= 0) {
      this._publishProgress.progress = this._publishProgress.completedOps > 0 ? 1 : 0;
      return;
    }

    const currentWorkUnits = this._publishProgress.currentTotalBytes > 0
      ? Math.min(this._publishProgress.currentBytes, this._publishProgress.currentTotalBytes)
      : 0;
    const completed = Math.min(
      this._publishProgress.completedWorkUnits + currentWorkUnits,
      totalWorkUnits
    );
    this._publishProgress.progress = Math.max(0, Math.min(1, completed / totalWorkUnits));
  }

  _emitPublishProgress(force = false) {
    const now = Date.now();
    if (!force && now - this._lastPublishEmitAt < 150) return;
    this._lastPublishEmitAt = now;
    this.ctx.emitHealth();
    this.ctx.emitFileList();
  }

  _syncPublishProgressToContext() {
    this.ctx.publishProgress = this._publishProgress.progress || 0;
    this.ctx.publishTransferredBytes = this._publishProgress.transferredBytes || 0;
    this.ctx.publishTotalBytes = this._publishProgress.totalBytes || 0;
    this.ctx.publishCurrentPath = this._publishProgress.currentPath || null;
    this.ctx.publishCurrentBytes = this._publishProgress.currentBytes || 0;
    this.ctx.publishCurrentTotalBytes = this._publishProgress.currentTotalBytes || 0;
    this.ctx.publishCompletedOps = this._publishProgress.completedOps || 0;
    this.ctx.publishTotalOps = this._publishProgress.totalOps || 0;
  }
}

module.exports = WorkspaceSync;
