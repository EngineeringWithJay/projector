const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {

  // --- Config & Profile ---
  getConfig:        ()       => ipcRenderer.invoke('get-config'),
  getSessionHealth: ()       => ipcRenderer.invoke('get-session-health'),
  saveConfig:       (patch)  => ipcRenderer.invoke('save-config', patch),
  getAppLogs:       (params) => ipcRenderer.invoke('get-app-logs', params),
  clearAppLogs:     ()       => ipcRenderer.invoke('clear-app-logs'),
  openLogFolder:    ()       => ipcRenderer.invoke('open-log-folder'),
  setLocalProfile:  (params) => ipcRenderer.invoke('set-local-profile', params),
  login:            (params) => ipcRenderer.invoke('login', params),
  logout:           ()       => ipcRenderer.invoke('logout'),
  returnToLogin:    ()       => ipcRenderer.invoke('return-to-login'),
  resetProfile:     ()       => ipcRenderer.invoke('reset-profile'),

  // --- Session Lifecycle ---
  createSession:    ()       => ipcRenderer.invoke('create-session'),
  joinSession:      (params) => ipcRenderer.invoke('join-session', params),
  switchSession:    (params) => ipcRenderer.invoke('switch-session', params),
  forgetSession:    (params) => ipcRenderer.invoke('forget-session', params),
  getSessionLibrary: ()      => ipcRenderer.invoke('get-session-library'),
  renameSession:    (params) => ipcRenderer.invoke('rename-session', params),

  // --- Member Management ---
  setMemberAccessPolicy: (params) => ipcRenderer.invoke('set-member-access-policy', params),
  setMemberRole:         (params) => ipcRenderer.invoke('set-member-role', params),
  removeMember:          (params) => ipcRenderer.invoke('remove-member', params),
  setVisibilityRule:     (params) => ipcRenderer.invoke('set-visibility-rule', params),
  createPrivateShare:    (params) => ipcRenderer.invoke('create-private-share', params),
  deletePrivateShare:    (params) => ipcRenderer.invoke('delete-private-share', params),
  getMemberList:         ()       => ipcRenderer.invoke('get-member-list'),
  getSessionPeers:       ()       => ipcRenderer.invoke('get-session-peers'),

  // --- Folder ---
  selectFolder:     ()       => ipcRenderer.invoke('select-folder'),
  openPrivateShareFolder: (params) => ipcRenderer.invoke('open-private-share-folder', params),

  // --- Swarm ---
  disconnectSwarm:  ()       => ipcRenderer.invoke('disconnect-swarm'),
  connectSwarm:     ()       => ipcRenderer.invoke('connect-swarm'),

  // --- Workspace ---
  getFileList:         ()       => ipcRenderer.invoke('get-file-list'),
  openWorkspaceEntry:  (params) => ipcRenderer.invoke('open-workspace-entry', params),
  downloadSharedItem:  (params) => ipcRenderer.invoke('download-shared-item', params),
  deleteLocalCopy:     (params) => ipcRenderer.invoke('delete-local-copy', params),

  // --- Requests + Notices ---
  listRequests:        ()       => ipcRenderer.invoke('list-requests'),
  submitRequest:       (params) => ipcRenderer.invoke('submit-request', params),
  respondToRequest:    (params) => ipcRenderer.invoke('respond-to-request', params),
  createAnnouncement:  (params) => ipcRenderer.invoke('create-announcement', params),

  // --- IPC Listeners ---
  // Primary health event — THE ONLY summary truth for UI
  onSessionHealth:       (cb) => ipcRenderer.on('session-health',         (_, d) => cb(d)),
  // Detail events — populate rows/lists only
  onFileListUpdate:      (cb) => ipcRenderer.on('file-list-update',       (_, d) => cb(d)),
  onActivityUpdate:      (cb) => ipcRenderer.on('activity-update',        (_, d) => cb(d)),
  onMessageUpdate:       (cb) => ipcRenderer.on('message-update',         (_, d) => cb(d)),
  onPeerListUpdate:      (cb) => ipcRenderer.on('peer-list-update',       (_, d) => cb(d)),
  onRequestListUpdate:   (cb) => ipcRenderer.on('request-list-update',    (_, d) => cb(d)),
  onSessionLibraryUpdate:(cb) => ipcRenderer.on('session-library-update', (_, d) => cb(d)),
});
