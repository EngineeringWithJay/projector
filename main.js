'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { Permissions, Identity } = require('hyperframe');

// App adapter + app-specific services
const RuntimeAdapter = require('./src/runtime/node');
const DeviceIdentity = require('./src/services/device-identity');
const PathService = require('./src/services/path-service');
const WorkspaceSync = require('./src/services/workspace-sync');
const AppLogger = require('./src/services/app-logger');

// --- App state ---
let mainWindow = null;
let adapter = null;
let workspaceSync = null;
let logger = null;
let processLoggingBound = false;

const storagePath = process.env.PROJECTOR_STORAGE_PATH
  ? path.resolve(process.env.PROJECTOR_STORAGE_PATH)
  : path.join(app.getPath('userData'), 'projector-data');

// --- Helpers ---

function safeSend(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send(channel, data); } catch (_) {}
  }
}

function log(level, scope, message, meta = null) {
  if (!logger || typeof logger[level] !== 'function') return;
  logger[level](scope, message, meta);
}

function bindProcessLogging() {
  if (processLoggingBound) return;
  processLoggingBound = true;
  process.on('uncaughtException', (err) => {
    log('error', 'process', 'Uncaught exception', err);
  });
  process.on('unhandledRejection', (reason) => {
    log('error', 'process', 'Unhandled rejection', reason);
  });
}

function attachWindowLogging(window) {
  if (!window || window.isDestroyed()) return;
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const logLevel = level >= 3 ? 'error' : level === 2 ? 'warn' : 'info';
    log(logLevel, 'renderer', message, { line, sourceId, level });
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    log('error', 'renderer', 'Render process gone', details);
  });
}

function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (err) {
      log('error', 'ipc', `${channel} failed`, { args, error: err });
      throw err;
    }
  });
}

function emitHealth() {
  if (!adapter) return;
  safeSend('session-health', adapter.getHealth());
}

function emitPeerList() {
  if (!adapter) return;
  safeSend('peer-list-update', adapter.getPeers());
}

function emitSessionLibrary() {
  if (!adapter) return;
  safeSend('session-library-update', {
    sessions: adapter.sessions.listSessions(),
    currentSessionId: adapter.sessions.getCurrentSession()?.id || null,
  });
}

function ensureWorkspaceSync() {
  if (!adapter) return null;
  if (!workspaceSync) {
    workspaceSync = new WorkspaceSync(adapter);
  }
  return workspaceSync;
}

async function stopWorkspaceSync() {
  if (!workspaceSync) return;
  await workspaceSync.stop();
  workspaceSync = null;
}

async function emitFileList() {
  if (!adapter?.session || adapter.transitioning) {
    safeSend('file-list-update', []);
    return;
  }
  const sync = ensureWorkspaceSync();
  if (!sync) return;
  const files = await sync.getFileList();
  safeSend('file-list-update', files);
}

function emitRequests() {
  if (!adapter) return;
  try {
    const messages = adapter.getVisibleMessages();
    safeSend('request-list-update', messages);
  } catch (_) {}
}

function isOwnerSession() {
  return !!(
    adapter?.session
    && Permissions.getRoleForDevice(adapter.session, adapter.identity.deviceId) === Permissions.ROLE_OWNER
  );
}

function ensureManagedWorkspace() {
  if (!adapter?.session?.sessionCode) return null;
  return PathService.ensureManagedWorkspace(storagePath, adapter.session.sessionCode);
}

function rememberSourceFolder(folderPath) {
  if (!adapter?.session?.id || !folderPath) return folderPath;
  const updated = adapter.sessions.updateSession(adapter.session.id, { sourceFolderPath: folderPath });
  if (updated && adapter.session?.id === updated.id) {
    adapter.session = updated;
  }
  return folderPath;
}

function getPreferredOwnerWorkspacePath() {
  if (!adapter?.session?.sessionCode) return null;
  return adapter.sourceFolderPath || adapter.session?.sourceFolderPath || ensureManagedWorkspace();
}

function getPeerManagedWorkspacePath() {
  if (!adapter?.session?.sessionCode) return null;
  return PathService.ensureManagedWorkspace(storagePath, adapter.session.sessionCode);
}

function cleanupRuntimeArtifactsFor(session = adapter?.session, workspacePath = null) {
  if (!session?.sessionCode) return;
  PathService.cleanupSessionRuntimeArtifacts(storagePath, session.sessionCode);
  const targetWorkspacePath = workspacePath
    || (Permissions.getRoleForDevice(session, adapter?.identity?.deviceId) === Permissions.ROLE_OWNER
      ? (adapter?.sourceFolderPath || session?.sourceFolderPath || null)
      : PathService.getWorkspacePath(storagePath, session.sessionCode));
  if (targetWorkspacePath) {
    PathService.cleanupWorkspacePrivateArtifacts(targetWorkspacePath, session.sessionCode);
  }
}

function movePathWithMerge(sourcePath, targetPath) {
  if (!sourcePath || !targetPath || sourcePath === targetPath || !fs.existsSync(sourcePath)) return false;
  let sourceStat = null;
  try {
    sourceStat = fs.statSync(sourcePath);
  } catch (_) {
    return false;
  }

  if (sourceStat.isDirectory()) {
    fs.mkdirSync(targetPath, { recursive: true });
    let changed = false;
    let names = [];
    try {
      names = fs.readdirSync(sourcePath);
    } catch (_) {
      return false;
    }
    for (const name of names) {
      changed = movePathWithMerge(path.join(sourcePath, name), path.join(targetPath, name)) || changed;
    }
    try {
      if (fs.existsSync(sourcePath) && fs.readdirSync(sourcePath).length === 0) {
        fs.rmdirSync(sourcePath);
        changed = true;
      }
    } catch (_) {}
    return changed;
  }

  if (fs.existsSync(targetPath)) {
    try {
      const targetStat = fs.statSync(targetPath);
      if (targetStat.isFile() && targetStat.size === sourceStat.size) {
        fs.rmSync(sourcePath, { force: true });
        return true;
      }
    } catch (_) {}
    return false;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  try {
    fs.renameSync(sourcePath, targetPath);
  } catch (err) {
    if (err?.code !== 'EXDEV') return false;
    try {
      fs.copyFileSync(sourcePath, targetPath);
      fs.rmSync(sourcePath, { force: true });
    } catch (_) {
      return false;
    }
  }
  return true;
}

function reconcileManagedPrivateImports() {
  if (!isOwnerSession() || !adapter?.session?.sessionCode) return false;
  const managedWorkspacePath = PathService.getWorkspacePath(storagePath, adapter.session.sessionCode);
  const activeWorkspacePath = getPreferredOwnerWorkspacePath();
  if (path.resolve(activeWorkspacePath || '') !== path.resolve(managedWorkspacePath)) return false;

  const privateShares = Object.entries(adapter.session.privateShares || {})
    .map(([deviceId, share]) => ({
      deviceId,
      sharePath: Permissions.normalizeSessionPath(share?.path || `Private/${String(deviceId || '').trim()}`),
    }))
    .filter((entry) => entry.deviceId && entry.sharePath.startsWith('Private/'));
  if (privateShares.length !== 1) return false;

  const [{ deviceId, sharePath }] = privateShares;
  const shareRoot = PathService.ensureWorkspaceFolder(activeWorkspacePath, sharePath);
  const reserved = new Set(['Shared', 'Private', 'Requests', 'Announcements']);

  let names = [];
  try {
    names = fs.readdirSync(activeWorkspacePath);
  } catch (_) {
    return false;
  }

  let changed = false;
  for (const name of names) {
    if (!name || reserved.has(name) || name === String(deviceId)) continue;
    changed = movePathWithMerge(
      path.join(activeWorkspacePath, name),
      path.join(shareRoot, name)
    ) || changed;
  }

  changed = movePathWithMerge(path.join(activeWorkspacePath, String(deviceId)), shareRoot) || changed;
  return changed;
}

async function ensureOwnerWorkspaceReady() {
  if (!isOwnerSession()) return null;
  const workspacePath = getPreferredOwnerWorkspacePath();
  if (!workspacePath) return null;
  if (reconcileManagedPrivateImports()) {
    cleanupRuntimeArtifactsFor(adapter.session, workspacePath);
  }
  cleanupRuntimeArtifactsFor(adapter.session, workspacePath);
  if (!adapter.dataPlane?.drive || !adapter.dataPlane.writable) {
    adapter.syncReady = false;
    emitHealth();
    return workspacePath;
  }
  if (!adapter.watcherActive || adapter.sourceFolderPath !== workspacePath) {
    await stopWorkspaceSync();
    const sync = ensureWorkspaceSync();
    await sync.startOwnerSync(workspacePath);
  }
  rememberSourceFolder(workspacePath);
  return workspacePath;
}

function ensureOwnerPrivateFolder(deviceId) {
  if (!isOwnerSession()) return null;
  const workspacePath = getPreferredOwnerWorkspacePath();
  if (!workspacePath) return null;
  PathService.ensureWorkspaceLayout(workspacePath);
  if (!deviceId) {
    return PathService.ensurePrivateRootFolder(workspacePath);
  }
  const sharePath = Permissions.normalizeSessionPath(
    adapter?.session?.privateShares?.[deviceId]?.path || `Private/${String(deviceId || '').trim()}`
  );
  return PathService.ensureWorkspaceFolder(workspacePath, sharePath);
}

function resolvePrivateFolderTarget(targetDeviceId = null, currentRemotePath = '') {
  if (!adapter?.session?.sessionCode) throw new Error('No active session.');

  const session = adapter.session;
  const deviceId = adapter.identity?.deviceId;
  const role = Permissions.getRoleForDevice(session, deviceId);
  const requestedPath = Permissions.normalizeSessionPath(currentRemotePath || '');

  if (role === Permissions.ROLE_OWNER) {
    if (requestedPath === 'Private' || requestedPath.startsWith('Private/')) {
      return PathService.ensureWorkspaceFolder(getPreferredOwnerWorkspacePath(), requestedPath);
    }
    return targetDeviceId ? ensureOwnerPrivateFolder(targetDeviceId) : ensureOwnerPrivateFolder();
  }

  const peerWorkspacePath = getPeerManagedWorkspacePath();
  const sharePath = Permissions.normalizeSessionPath(
    session.privateShares?.[deviceId]?.path || `Private/${String(deviceId || '').trim()}`
  );
  const targetPath = requestedPath && (requestedPath === sharePath || requestedPath.startsWith(sharePath + '/'))
    ? requestedPath
    : sharePath;
  return PathService.ensureWorkspaceFolder(peerWorkspacePath, targetPath);
}

function resolveWorkspaceEntryTarget(remotePath) {
  if (!adapter?.session?.sessionCode) throw new Error('No active session.');
  const normalizedPath = Permissions.normalizeSessionPath(remotePath);
  if (!normalizedPath) throw new Error('A workspace path is required.');

  const session = adapter.session;
  const deviceId = adapter.identity?.deviceId;
  const role = Permissions.getRoleForDevice(session, deviceId);
  const targetPath = role === Permissions.ROLE_OWNER
    ? PathService.resolveWorkspacePath(getPreferredOwnerWorkspacePath(), normalizedPath)
    : (() => {
        const peerWorkspacePath = getPeerManagedWorkspacePath();
        const workspaceTarget = peerWorkspacePath
          ? PathService.resolveWorkspacePath(peerWorkspacePath, normalizedPath)
          : null;
        if (workspaceTarget && fs.existsSync(workspaceTarget)) return workspaceTarget;
        return PathService.resolveLocalPath(storagePath, session.sessionCode, normalizedPath);
      })();

  if (!fs.existsSync(targetPath)) {
    throw new Error('The selected item is not available locally yet.');
  }
  return targetPath;
}

function removeManagedPrivateArtifacts(deviceId) {
  if (!deviceId || !adapter?.session?.sessionCode) return;
  const managedWorkspacePath = PathService.getWorkspacePath(storagePath, adapter.session.sessionCode);
  const activeWorkspacePath = getPreferredOwnerWorkspacePath();
  if (path.resolve(activeWorkspacePath || '') !== path.resolve(managedWorkspacePath)) return;
  const sharePath = Permissions.normalizeSessionPath(
    adapter?.session?.privateShares?.[deviceId]?.path || `Private/${String(deviceId || '').trim()}`
  );
  const target = PathService.resolveWorkspacePath(activeWorkspacePath, sharePath);
  try {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  } catch (_) {}
}

// --- Boot ---

async function boot() {
  PathService.ensureDirectories(storagePath);
  PathService.cleanupStorageRuntimeArtifacts(storagePath);
  logger = new AppLogger({ storagePath });
  bindProcessLogging();
  log('info', 'app', 'Booting Projector', { storagePath });

  adapter = new RuntimeAdapter({ storagePath, logger });
  adapter.bindEmitters({ emitHealth, emitFileList, emitActivity: () => {}, emitPeerList, emitSessionLibrary, emitRequests });
  await adapter.init();

  emitHealth();
  emitSessionLibrary();
  await emitFileList();
  emitRequests();
}

// --- IPC Handlers ---

function registerIPC() {
  // Config
  handle('get-config', () => adapter.getConfig());
  handle('get-session-health', () => adapter.getHealth());
  handle('save-config', (_, patch) => {
    adapter.saveConfig(patch);
    return true;
  });
  handle('get-app-logs', (_, params = {}) => logger.readRecent(params.limit));
  handle('clear-app-logs', () => {
    logger.clear();
    log('info', 'logs', 'Log file cleared');
    return true;
  });
  handle('open-log-folder', async () => {
    const target = logger.getLogPath();
    const openError = await shell.openPath(logger.getLogDir());
    if (openError) {
      shell.showItemInFolder(target);
    }
    return { path: target };
  });

  // Profile
  handle('set-local-profile', (_, params) => {
    const result = DeviceIdentity.setLocalProfile(adapter, params);
    adapter.saveIdentity();
    emitHealth();
    return result;
  });
  handle('login', (_, params) => {
    const result = DeviceIdentity.login(adapter, params);
    adapter.saveIdentity();
    emitHealth();
    return result;
  });
  handle('logout', () => {
    DeviceIdentity.logout(adapter);
    adapter.saveIdentity();
    emitHealth();
  });
  handle('return-to-login', async () => {
    await stopWorkspaceSync();
    cleanupRuntimeArtifactsFor();
    await adapter.leaveActiveSession();
    return true;
  });
  handle('reset-profile', async () => {
    await stopWorkspaceSync();
    cleanupRuntimeArtifactsFor();
    await adapter.leaveActiveSession();
    DeviceIdentity.resetProfile(adapter);
    adapter.saveIdentity();
    emitHealth();
  });

  // Session lifecycle
  handle('create-session', async () => {
    await stopWorkspaceSync();
    cleanupRuntimeArtifactsFor();
    const session = await adapter.createSession();
    await ensureOwnerWorkspaceReady();
    await emitFileList();
    emitRequests();
    return session;
  });
  handle('join-session', async (_, params) => {
    await stopWorkspaceSync();
    cleanupRuntimeArtifactsFor();
    const sessionCode = String(params.sessionCode || '').trim();
    const existing = sessionCode ? adapter.sessions.getSession(sessionCode) : null;
    const session = existing
      ? await adapter.switchSession(existing.id)
      : await adapter.joinSession(sessionCode, params);
    await ensureOwnerWorkspaceReady();
    await emitFileList();
    emitRequests();
    return session;
  });
  handle('switch-session', async (_, params) => {
    await stopWorkspaceSync();
    cleanupRuntimeArtifactsFor();
    const session = await adapter.switchSession(params.sessionId);
    await ensureOwnerWorkspaceReady();
    await emitFileList();
    emitRequests();
    return session;
  });
  handle('forget-session', async (_, params) => {
    const result = adapter.forgetSession(params.sessionId);
    PathService.deleteSessionArtifacts(storagePath, result.sessionCode);
    emitHealth();
    await emitFileList();
    emitRequests();
    return result;
  });
  handle('get-session-library', () => ({
    sessions: adapter.sessions.listSessions(),
    currentSessionId: adapter.sessions.getCurrentSession()?.id || null,
  }));
  handle('rename-session', (_, params) => adapter.renameSession(params.sessionId, params.name));

  // Member management
  handle('set-member-access-policy', async (_, params) => {
    const result = await adapter.setMemberPolicy(params.deviceId, params);
    if (params.status === Permissions.ACCESS_APPROVED) {
      ensureOwnerPrivateFolder(params.deviceId);
      await emitFileList();
    }
    return result;
  });
  handle('set-member-role', async (_, params) => adapter.setMemberRole(params.deviceId, params.role));
  handle('remove-member', async (_, params) => {
    const result = await adapter.removeMember(params.deviceId);
    removeManagedPrivateArtifacts(params.deviceId);
    await emitFileList();
    return result;
  });
  handle('set-visibility-rule', async (_, params) => adapter.setVisibilityRule(params.path, params.visibility));
  handle('create-private-share', async (_, params) => {
    const result = await adapter.setPrivateShare(params.deviceId, params);
    ensureOwnerPrivateFolder(params.deviceId);
    await emitFileList();
    return result;
  });
  handle('delete-private-share', async (_, params) => {
    const result = await adapter.clearPrivateShare(params.shareId);
    cleanupRuntimeArtifactsFor();
    await emitFileList();
    return result;
  });
  handle('get-member-list', () => adapter.getMemberList());

  // Swarm
  handle('disconnect-swarm', async () => { await adapter.node.swarm.disconnectAll(); emitHealth(); });
  handle('connect-swarm', async () => { await adapter.node._startSwarm(); emitHealth(); });

  // Peer list
  handle('get-session-peers', () => adapter.getPeers());

  // Requests + Notices
  handle('list-requests', () => adapter.getVisibleMessages());
  handle('submit-request', async (_, params) => adapter.requestAccess(params.body));
  handle('respond-to-request', async (_, params) => adapter.respondToRequest(params.requestId, params.action, params.comment));
  handle('create-announcement', async (_, params) => adapter.createAnnouncement(params));

  // Folder selection + sync
  handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths.length) return null;
    const folder = result.filePaths[0];
    if (isOwnerSession()) {
      await stopWorkspaceSync();
      const sync = ensureWorkspaceSync();
      await sync.startOwnerSync(folder);
      rememberSourceFolder(folder);
      await emitFileList();
    }
    return folder;
  });
  handle('open-private-share-folder', async (_, params = {}) => {
    const folderPath = resolvePrivateFolderTarget(params.deviceId || null, params.path || '');
    const openError = await shell.openPath(folderPath);
    if (openError) {
      shell.showItemInFolder(folderPath);
    }
    return { path: folderPath };
  });

  // File list
  handle('get-file-list', async () => {
    if (adapter.transitioning || !adapter.session) return [];
    await ensureOwnerWorkspaceReady();
    const sync = ensureWorkspaceSync();
    return sync ? sync.getFileList() : [];
  });
  handle('open-workspace-entry', async (_, params = {}) => {
    const targetPath = resolveWorkspaceEntryTarget(params.path || '');
    const openError = await shell.openPath(targetPath);
    if (openError) {
      shell.showItemInFolder(targetPath);
    }
    return { path: targetPath };
  });

  // Download
  handle('download-shared-item', async (_, params) => {
    const sync = ensureWorkspaceSync();
    return sync ? sync.downloadFile(params.path) : null;
  });

  // Delete local
  handle('delete-local-copy', async (_, params) => {
    const sync = ensureWorkspaceSync();
    const result = sync ? sync.deleteLocalCopy(params.path) : false;
    await emitFileList();
    return result;
  });
}

// --- Electron lifecycle ---

app.whenReady().then(async () => {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Projector',
  });
  attachWindowLogging(mainWindow);

  registerIPC();
  await boot();
  mainWindow.loadFile('index.html');

  mainWindow.on('closed', () => { mainWindow = null; });
});

app.on('window-all-closed', async () => {
  await stopWorkspaceSync();
  cleanupRuntimeArtifactsFor();
  if (adapter) {
    await adapter.destroy();
  }
  app.quit();
});

app.on('activate', () => {
  if (!mainWindow) {
    app.whenReady().then(() => {
      mainWindow = new BrowserWindow({
        width: 1200, height: 800,
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true, nodeIntegration: false,
        },
      });
      attachWindowLogging(mainWindow);
      mainWindow.loadFile('index.html');
    });
  }
});
