'use strict';

const path = require('path');
const fs = require('fs');

/**
 * PathService — Directory structure management.
 *
 * Design rule: workspace metadata view (what exists on the drive) and the local
 * materialized cache (what bytes exist on disk) are ALWAYS separate concerns.
 */

/**
 * Ensure crucial directories exist.
 */
function ensureDirectories(storagePath) {
  const dirs = [
    path.join(storagePath, 'cache'),     // Materialized local cache
    path.join(storagePath, 'staging'),   // Upload/download staging
    path.join(storagePath, 'corestore'), // Corestore data
    path.join(storagePath, 'sessions'),  // App-managed session workspaces
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getSessionsPath(storagePath) {
  return path.join(storagePath, 'sessions');
}

function getSessionPath(storagePath, sessionCode) {
  return path.join(getSessionsPath(storagePath), sessionCode);
}

function getWorkspacePath(storagePath, sessionCode) {
  return path.join(getSessionPath(storagePath, sessionCode), 'workspace');
}

function resolveWorkspacePath(workspacePath, remotePath = '') {
  return path.join(workspacePath, ...String(remotePath).split('/').filter(Boolean));
}

function ensureWorkspaceFolder(workspacePath, remotePath = '') {
  const target = remotePath ? resolveWorkspacePath(workspacePath, remotePath) : workspacePath;
  fs.mkdirSync(target, { recursive: true });
  return target;
}

function ensureWorkspaceLayout(workspacePath) {
  const dirs = [
    workspacePath,
    path.join(workspacePath, 'Shared'),
    path.join(workspacePath, 'Private'),
    path.join(workspacePath, 'Requests'),
    path.join(workspacePath, 'Announcements'),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return workspacePath;
}

function ensureManagedWorkspace(storagePath, sessionCode) {
  return ensureWorkspaceLayout(getWorkspacePath(storagePath, sessionCode));
}

function getPrivateRootFolder(workspacePath) {
  return path.join(workspacePath, 'Private');
}

function ensurePrivateRootFolder(workspacePath) {
  return ensureWorkspaceFolder(workspacePath, 'Private');
}

function ensurePrivateMemberFolder(workspacePath, deviceId) {
  return ensureWorkspaceFolder(workspacePath, path.join('Private', String(deviceId || '').trim()));
}

/**
 * Get the local cache path for a session.
 * @param {string} storagePath
 * @param {string} sessionCode
 * @returns {string}
 */
function getCachePath(storagePath, sessionCode) {
  return path.join(storagePath, 'cache', sessionCode);
}

/**
 * Get the staging path for transfer jobs.
 */
function getStagingPath(storagePath, sessionCode) {
  return path.join(storagePath, 'staging', sessionCode);
}

function removeMatchingFiles(rootPath, predicate) {
  if (!rootPath || !fs.existsSync(rootPath)) return false;
  let changed = false;
  const stack = [rootPath];
  while (stack.length) {
    const currentPath = stack.pop();
    let names = [];
    try {
      names = fs.readdirSync(currentPath);
    } catch (_) {
      continue;
    }
    for (const name of names) {
      const absolutePath = path.join(currentPath, name);
      let stat = null;
      try {
        stat = fs.lstatSync(absolutePath);
      } catch (_) {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!predicate(absolutePath, name)) continue;
      try {
        fs.rmSync(absolutePath, { force: true });
        changed = true;
      } catch (_) {}
    }
  }
  return changed;
}

function pruneEmptyDirectories(rootPath, { preserveRoot = true } = {}) {
  if (!rootPath || !fs.existsSync(rootPath)) return false;
  let changed = false;
  const visit = (currentPath, isRoot = false) => {
    let names = [];
    try {
      names = fs.readdirSync(currentPath);
    } catch (_) {
      return false;
    }
    for (const name of names) {
      const childPath = path.join(currentPath, name);
      let stat = null;
      try {
        stat = fs.lstatSync(childPath);
      } catch (_) {
        continue;
      }
      if (stat.isDirectory()) {
        visit(childPath, false);
      }
    }
    try {
      if ((preserveRoot && isRoot) || fs.readdirSync(currentPath).length > 0) return false;
      fs.rmdirSync(currentPath);
      changed = true;
      return true;
    } catch (_) {
      return false;
    }
  };
  visit(rootPath, true);
  return changed;
}

function cleanupSessionRuntimeArtifacts(storagePath, sessionCode) {
  const stagingPath = getStagingPath(storagePath, sessionCode);
  const removedIncoming = removeMatchingFiles(
    stagingPath,
    (_, name) => String(name || '').endsWith(`.${sessionCode}.incoming`)
  );
  const prunedEmpty = pruneEmptyDirectories(stagingPath, { preserveRoot: true });
  return removedIncoming || prunedEmpty;
}

function cleanupStorageRuntimeArtifacts(storagePath) {
  const stagingRoot = path.join(storagePath, 'staging');
  if (!fs.existsSync(stagingRoot)) return false;
  let changed = false;
  let sessionCodes = [];
  try {
    sessionCodes = fs.readdirSync(stagingRoot);
  } catch (_) {
    return false;
  }
  for (const sessionCode of sessionCodes) {
    changed = cleanupSessionRuntimeArtifacts(storagePath, sessionCode) || changed;
  }
  changed = pruneEmptyDirectories(stagingRoot, { preserveRoot: true }) || changed;
  return changed;
}

function cleanupWorkspacePrivateArtifacts(workspacePath, sessionCode = '') {
  const privateRoot = getPrivateRootFolder(workspacePath);
  if (!fs.existsSync(privateRoot)) return false;
  let changed = false;
  if (sessionCode) {
    changed = removeMatchingFiles(
      privateRoot,
      (_, name) => String(name || '').endsWith(`.${sessionCode}.incoming`)
    ) || changed;
  }
  changed = pruneEmptyDirectories(privateRoot, { preserveRoot: true }) || changed;
  return changed;
}

/**
 * Resolve a remote entry path to its local cache location.
 */
function resolveLocalPath(storagePath, sessionCode, remotePath) {
  const cachePath = getCachePath(storagePath, sessionCode);
  return path.join(cachePath, ...String(remotePath).split('/').filter(Boolean));
}

function ensureLocalFolder(storagePath, sessionCode, remotePath = '') {
  const folder = remotePath ? resolveLocalPath(storagePath, sessionCode, remotePath) : getCachePath(storagePath, sessionCode);
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

/**
 * Check if a local file exists in the materialized cache.
 */
function localFileExists(storagePath, sessionCode, remotePath) {
  const localPath = resolveLocalPath(storagePath, sessionCode, remotePath);
  try { return fs.existsSync(localPath); } catch (_) { return false; }
}

/**
 * Get local file size (from cache). Returns 0 if not present.
 */
function getLocalFileSize(storagePath, sessionCode, remotePath) {
  const localPath = resolveLocalPath(storagePath, sessionCode, remotePath);
  try {
    const stat = fs.statSync(localPath);
    return stat.size;
  } catch (_) { return 0; }
}

/**
 * Delete a locally cached file (subscriber-local copy only).
 * NEVER deletes the owner's source copy.
 */
function deleteLocalCopy(storagePath, sessionCode, remotePath) {
  const localPath = resolveLocalPath(storagePath, sessionCode, remotePath);
  try {
    if (fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
      return true;
    }
  } catch (_) {}
  return false;
}

/**
 * Delete all locally cached files for a session.
 */
function deleteSessionCache(storagePath, sessionCode) {
  const cachePath = getCachePath(storagePath, sessionCode);
  try {
    if (fs.existsSync(cachePath)) {
      fs.rmSync(cachePath, { recursive: true, force: true });
      return true;
    }
  } catch (_) {}
  return false;
}

function deleteSessionArtifacts(storagePath, sessionCode) {
  const targets = [
    getCachePath(storagePath, sessionCode),
    getStagingPath(storagePath, sessionCode),
    getSessionPath(storagePath, sessionCode),
  ];
  let removed = false;
  for (const target of targets) {
    try {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
        removed = true;
      }
    } catch (_) {}
  }
  return removed;
}

module.exports = {
  ensureDirectories,
  getSessionsPath,
  getSessionPath,
  getWorkspacePath,
  resolveWorkspacePath,
  ensureWorkspaceFolder,
  ensureWorkspaceLayout,
  ensureManagedWorkspace,
  getPrivateRootFolder,
  ensurePrivateRootFolder,
  ensurePrivateMemberFolder,
  getCachePath,
  getStagingPath,
  cleanupSessionRuntimeArtifacts,
  cleanupStorageRuntimeArtifacts,
  cleanupWorkspacePrivateArtifacts,
  resolveLocalPath,
  ensureLocalFolder,
  localFileExists,
  getLocalFileSize,
  deleteLocalCopy,
  deleteSessionCache,
  deleteSessionArtifacts,
};
