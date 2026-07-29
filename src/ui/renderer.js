/**
 * Renderer — DOMContentLoaded entry point.
 *
 * sessionHealth remains the only summary truth. The renderer derives labels
 * only from that object; detail events populate rows and lists.
 */

document.addEventListener('DOMContentLoaded', async () => {
  const { electron } = window;
  if (!electron) {
    console.error('[RENDERER] preload missing');
    return;
  }

  const state = {
    role: 'viewer',
    approvalStatus: 'pending',
    workspaceVisible: false,
    activityVisible: 'none',
    swarmConnected: false,
    peerCount: 0,
    syncReady: false,
    ownerReachable: false,
    transitioning: false,
    lastMirrorStatus: 'pending',
    lastError: null,
    sessionCode: null,
    sessionName: null,
    sourceFolderPath: null,
    sourceFolderSelected: false,
    watcherActive: false,
    mirrorActive: false,
    activeTransferCount: 0,
    uploadTransferCount: 0,
    uploadTransferredBytes: 0,
    uploadTotalBytes: 0,
    importTransferCount: 0,
    importTransferredBytes: 0,
    importTotalBytes: 0,
    publishProgress: 0,
    publishTransferredBytes: 0,
    publishTotalBytes: 0,
    publishCurrentPath: null,
    publishCurrentBytes: 0,
    publishCurrentTotalBytes: 0,
    publishCompletedOps: 0,
    publishTotalOps: 0,
    localAvailableBytes: 0,
    localCapacityBytes: 0,
    fabricAvailableBytes: 0,
    fabricCapacityBytes: 0,
    fabricOnlineNodes: 0,
    fabricTotalNodes: 0,
    fabricWritableNodes: 0,
    storageRootPath: null,
    managedWorkspacePath: null,
    activeWorkspacePath: null,
    privateRootPath: null,
    localPrivateSharePath: null,
    totalObjects: 0,
    totalExtents: 0,
    healthyExtents: 0,
    degradedExtents: 0,
    unavailableExtents: 0,
    underReplicatedExtents: 0,
    repairingExtents: 0,
    totalAssignedBytes: 0,
    totalStoredBytes: 0,
    totalCachedBytes: 0,
    totalAssignedLocalBytes: 0,
    onlineHolderCount: 0,
    offlineHolderCount: 0,
    repairQueueSize: 0,
    rebalanceQueueSize: 0,
    deviceId: null,
    deviceLabel: '',
    profileSetupComplete: false,
    files: [],
    peers: [],
    members: [],
    requests: [],
    announcements: [],
    currentTab: 'browse',
    currentBrowsePath: '',
    expandedMembers: {},
    savedSessions: [],
    currentSessionId: null,
    logs: [],
    logPath: null,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    firstRunScreen: $('first-run-screen'),
    appScreen: $('app-screen'),
    firstRunNameInput: $('first-run-name-input'),
    firstRunCreateBtn: $('first-run-create-btn'),
    firstRunJoinInput: $('first-run-join-input'),
    firstRunJoinBtn: $('first-run-join-btn'),
    firstRunStatus: $('first-run-status'),
    firstRunSessionsCard: $('first-run-sessions-card'),
    firstRunSessionLibrary: $('first-run-session-library'),
    healthRoleDot: $('health-role-dot'),
    healthRoleLabel: $('health-role-label'),
    healthNetworkDot: $('health-network-dot'),
    healthNetworkLabel: $('health-network-label'),
    healthWorkspaceDot: $('health-workspace-dot'),
    healthWorkspaceLabel: $('health-workspace-label'),
    healthSessionDot: $('health-session-dot'),
    healthSessionLabel: $('health-session-label'),
    healthSessionName: $('health-session-name'),
    browseTitle: $('browse-title'),
    browseSubtitle: $('browse-subtitle'),
    browseBreadcrumbs: $('browse-breadcrumbs'),
    browseUpBtn: $('browse-up-btn'),
    browseOwnerActions: $('browse-owner-actions'),
    browseSyncProgress: $('browse-sync-progress'),
    browseSyncLabel: $('browse-sync-label'),
    browseSyncValue: $('browse-sync-value'),
    browseSyncFill: $('browse-sync-fill'),
    openPrivateFolderBtn: $('open-private-folder-btn'),
    selectFolderBtn: $('select-folder-btn'),
    fileTree: $('file-tree'),
    browseEmpty: $('browse-empty'),
    memberManagement: $('member-management'),
    memberList: $('member-list'),
    pendingPeerList: $('pending-peer-list'),
    peerList: $('peer-list'),
    networkSelfCard: $('network-self-card'),
    requestsTitle: $('requests-title'),
    requestsSubtitle: $('requests-subtitle'),
    requestSubmitSection: $('request-submit-section'),
    requestBodyInput: $('request-body-input'),
    submitRequestBtn: $('submit-request-btn'),
    requestSubmitStatus: $('request-submit-status'),
    requestList: $('request-list'),
    requestsEmpty: $('requests-empty'),
    announcementsTitle: $('announcements-title'),
    announcementsSubtitle: $('announcements-subtitle'),
    announcementCompose: $('announcement-compose'),
    announcementBodyInput: $('announcement-body-input'),
    announcementPinnedInput: $('announcement-pinned-input'),
    announcementPriorityInput: $('announcement-priority-input'),
    postAnnouncementBtn: $('post-announcement-btn'),
    announcementComposeStatus: $('announcement-compose-status'),
    announcementList: $('announcement-list'),
    announcementsEmpty: $('announcements-empty'),
    displaySessionName: $('display-session-name'),
    displayRole: $('display-role'),
    displayApproval: $('display-approval'),
    displayNetworkStatus: $('display-network-status'),
    displayPeerCount: $('display-peer-count'),
    displayOwnerReachable: $('display-owner-reachable'),
    displaySessionState: $('display-session-state'),
    displayWorkspaceStatus: $('display-workspace-status'),
    displaySourceFolder: $('display-source-folder'),
    displayStorageRoot: $('display-storage-root'),
    displayManagedWorkspace: $('display-managed-workspace'),
    displayPrivateRoot: $('display-private-root'),
    displayPrivateSharePath: $('display-private-share-path'),
    displayUploadPermission: $('display-upload-permission'),
    displayPrivateUploadLane: $('display-private-upload-lane'),
    displayWatcherActive: $('display-watcher-active'),
    displayMirrorActivity: $('display-mirror-activity'),
    displayPublishProgress: $('display-publish-progress'),
    displaySyncReady: $('display-sync-ready'),
    displayTransferCount: $('display-transfer-count'),
    displayUploadJobs: $('display-upload-jobs'),
    displayUploadProgress: $('display-upload-progress'),
    displayImportJobs: $('display-import-jobs'),
    displayImportProgress: $('display-import-progress'),
    displayLastError: $('display-last-error'),
    displayFabricCapacity: $('display-fabric-capacity'),
    displayFabricFree: $('display-fabric-free'),
    displayFabricOnline: $('display-fabric-online'),
    displayFabricWritable: $('display-fabric-writable'),
    displayLocalStorage: $('display-local-storage'),
    displayTotalObjects: $('display-total-objects'),
    displayTotalExtents: $('display-total-extents'),
    displayHealthyExtents: $('display-healthy-extents'),
    displayDegradedExtents: $('display-degraded-extents'),
    displayUnderReplicatedExtents: $('display-under-replicated-extents'),
    displayUnavailableExtents: $('display-unavailable-extents'),
    displayRepairingExtents: $('display-repairing-extents'),
    displayAssignedBytes: $('display-assigned-bytes'),
    displayStoredBytes: $('display-stored-bytes'),
    displayCachedBytes: $('display-cached-bytes'),
    displayLocalHeldBytes: $('display-local-held-bytes'),
    displayOnlineHolders: $('display-online-holders'),
    displayOfflineHolders: $('display-offline-holders'),
    displayRepairQueue: $('display-repair-queue'),
    displayRebalanceQueue: $('display-rebalance-queue'),
    displayFabricMode: $('display-fabric-mode'),
    displaySessionCode: $('display-session-code'),
    displayDeviceId: $('display-device-id'),
    displayLogPath: $('display-log-path'),
    systemLogList: $('system-log-list'),
    systemSessionLibrary: $('system-session-library'),
    copySessionBtn: $('copy-session-btn'),
    refreshLogsBtn: $('refresh-logs-btn'),
    openLogFolderBtn: $('open-log-folder-btn'),
    clearLogsBtn: $('clear-logs-btn'),
    logOffBtn: $('log-off-btn'),
    resetProfileBtn: $('reset-profile-btn'),
  };

  const config = await electron.getConfig();
  state.deviceId = config.deviceId;
  state.deviceLabel = config.deviceLabel;
  state.profileSetupComplete = config.profileSetupComplete;

  const lib = await electron.getSessionLibrary();
  state.savedSessions = lib.sessions || [];
  state.currentSessionId = lib.currentSessionId;
  const initialHealth = await electron.getSessionHealth();
  Object.assign(state, initialHealth || {});

  if (!state.profileSetupComplete || !state.sessionCode) {
    showFirstRun();
  } else {
    showApp();
  }

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      state.currentTab = item.dataset.tab;
      document.querySelectorAll('.nav-item').forEach((navItem) => {
        navItem.classList.toggle('active', navItem.dataset.tab === state.currentTab);
      });
      document.querySelectorAll('.tab-content').forEach((tab) => {
        tab.classList.toggle('active', tab.id === `tab-${state.currentTab}`);
      });
      if (state.currentTab === 'network' && state.role === 'owner') {
        void refreshMemberList();
      }
      if (state.currentTab === 'requests' || state.currentTab === 'announcements') {
        void refreshRequests();
      }
    });
  });

  els.firstRunCreateBtn.addEventListener('click', async () => {
    const name = els.firstRunNameInput.value.trim();
    if (!name) {
      els.firstRunStatus.textContent = 'Name is required';
      return;
    }
    els.firstRunStatus.textContent = 'Creating session...';
    try {
      await electron.setLocalProfile({ label: name });
      await electron.createSession();
      showApp();
    } catch (err) {
      els.firstRunStatus.textContent = err.message;
    }
  });

  els.firstRunJoinBtn.addEventListener('click', async () => {
    const name = els.firstRunNameInput.value.trim();
    const code = els.firstRunJoinInput.value.trim();
    if (!name) {
      els.firstRunStatus.textContent = 'Name is required';
      return;
    }
    if (!code) {
      els.firstRunStatus.textContent = 'Session code is required';
      return;
    }
    els.firstRunStatus.textContent = 'Joining session...';
    try {
      await electron.setLocalProfile({ label: name });
      await electron.joinSession({ sessionCode: code, label: name });
      showApp();
    } catch (err) {
      els.firstRunStatus.textContent = err.message;
    }
  });

  els.copySessionBtn?.addEventListener('click', () => {
    if (state.sessionCode) navigator.clipboard?.writeText(state.sessionCode);
  });
  els.selectFolderBtn?.addEventListener('click', async () => {
    await electron.selectFolder();
  });
  els.browseUpBtn?.addEventListener('click', () => {
    setBrowsePath(parentBrowsePath(state.currentBrowsePath));
  });
  els.openPrivateFolderBtn?.addEventListener('click', async () => {
    if (state.role === 'owner') {
      setBrowsePath(isOwnerPrivateBrowsePath(state.currentBrowsePath) ? '' : 'Private');
      return;
    }
    const button = els.openPrivateFolderBtn;
    button.disabled = true;
    const previousLabel = button.textContent;
    button.textContent = 'Opening...';
    try {
      await electron.openPrivateShareFolder({ path: state.currentBrowsePath });
    } catch (err) {
      console.error(err);
    }
    button.disabled = false;
    button.textContent = previousLabel;
  });
  els.resetProfileBtn?.addEventListener('click', async () => {
    await electron.resetProfile();
    showFirstRun();
  });
  els.logOffBtn?.addEventListener('click', async () => {
    await electron.returnToLogin();
    showFirstRun();
  });
  els.refreshLogsBtn?.addEventListener('click', async () => {
    await refreshLogs();
  });
  els.openLogFolderBtn?.addEventListener('click', async () => {
    try {
      await electron.openLogFolder();
    } catch (err) {
      console.error(err);
    }
  });
  els.clearLogsBtn?.addEventListener('click', async () => {
    try {
      await electron.clearAppLogs();
      await refreshLogs();
    } catch (err) {
      console.error(err);
    }
  });

  els.postAnnouncementBtn?.addEventListener('click', async () => {
    const body = els.announcementBodyInput?.value.trim();
    if (!body) {
      if (els.announcementComposeStatus) els.announcementComposeStatus.textContent = 'Announcement body is required';
      return;
    }
    els.postAnnouncementBtn.disabled = true;
    if (els.announcementComposeStatus) els.announcementComposeStatus.textContent = 'Posting...';
    try {
      const allMessages = await electron.createAnnouncement({
        body,
        pinned: els.announcementPinnedInput?.checked || false,
        priority: els.announcementPriorityInput?.value || 'normal',
      });
      applyVisibleMessages(allMessages);
      if (els.announcementBodyInput) els.announcementBodyInput.value = '';
      if (els.announcementPinnedInput) els.announcementPinnedInput.checked = false;
      if (els.announcementPriorityInput) els.announcementPriorityInput.value = 'normal';
      if (els.announcementComposeStatus) els.announcementComposeStatus.textContent = 'Posted';
    } catch (err) {
      if (els.announcementComposeStatus) els.announcementComposeStatus.textContent = err.message || 'Failed';
    }
    els.postAnnouncementBtn.disabled = false;
  });

  els.submitRequestBtn?.addEventListener('click', async () => {
    const body = els.requestBodyInput?.value.trim();
    if (!body) {
      if (els.requestSubmitStatus) els.requestSubmitStatus.textContent = 'Please describe your request';
      return;
    }
    els.submitRequestBtn.disabled = true;
    if (els.requestSubmitStatus) els.requestSubmitStatus.textContent = 'Submitting...';
    try {
      const allMessages = await electron.submitRequest({ body });
      applyVisibleMessages(allMessages);
      if (els.requestBodyInput) els.requestBodyInput.value = '';
      if (els.requestSubmitStatus) els.requestSubmitStatus.textContent = 'Request submitted';
    } catch (err) {
      if (els.requestSubmitStatus) els.requestSubmitStatus.textContent = err.message || 'Failed to submit';
    }
    els.submitRequestBtn.disabled = false;
  });

  electron.onSessionHealth((health) => {
    const previousSessionCode = state.sessionCode;
    Object.assign(state, health);
    if (previousSessionCode !== state.sessionCode) {
      state.currentBrowsePath = '';
      state.expandedMembers = {};
    }
    if (!state.profileSetupComplete || !state.sessionCode) {
      if (els.firstRunScreen.style.display === 'none') showFirstRun();
    } else if (els.appScreen.style.display === 'none') {
      showApp();
    }
    coerceBrowsePath();
    updateHealthBar();
    updateBrowseHeader();
    renderBrowseToolbar();
    updatePublishProgressSurface();
    updateBrowseEmptyState();
    updatePrivateFolderAction();
    updateMemberManagementVisibility();
    updateRequestSurface();
    updateAnnouncementSurface();
    updateSystemPanel();
    renderLogPanel();
  });

  electron.onFileListUpdate((files) => {
    state.files = files;
    coerceBrowsePath();
    renderBrowseToolbar();
    renderFileTree();
  });

  electron.onPeerListUpdate((peers) => {
    state.peers = peers;
    renderPeerList();
    if (state.role === 'owner') void refreshMemberList();
  });

  electron.onRequestListUpdate((allMessages) => {
    applyVisibleMessages(allMessages);
  });

  electron.onSessionLibraryUpdate((nextLib) => {
    state.savedSessions = nextLib.sessions || [];
    state.currentSessionId = nextLib.currentSessionId;
    renderSessionLibrary();
  });

  function showFirstRun() {
    els.firstRunScreen.style.display = '';
    els.appScreen.style.display = 'none';
    if (els.firstRunNameInput) els.firstRunNameInput.value = state.deviceLabel || '';
    if (els.firstRunStatus) els.firstRunStatus.textContent = '';
    if (els.firstRunJoinInput) els.firstRunJoinInput.value = '';
    if (state.savedSessions.length > 0) {
      els.firstRunSessionsCard.style.display = '';
      els.firstRunSessionLibrary.innerHTML = state.savedSessions.map((session) =>
        `<div class="peer-row" style="cursor:pointer" data-session-id="${esc(session.id)}">
          <span class="peer-label">${esc(session.name)}</span>
          <span class="peer-role">${esc(session.origin)}</span>
        </div>`
      ).join('');
      els.firstRunSessionLibrary.querySelectorAll('.peer-row').forEach((row) => {
        row.addEventListener('click', async () => {
          const name = els.firstRunNameInput.value.trim();
          if (name) await electron.setLocalProfile({ label: name });
          await electron.switchSession({ sessionId: row.dataset.sessionId });
          showApp();
        });
      });
    } else {
      els.firstRunSessionsCard.style.display = 'none';
      els.firstRunSessionLibrary.innerHTML = '';
    }
  }

  function showApp() {
    els.firstRunScreen.style.display = 'none';
    els.appScreen.style.display = '';
    updateHealthBar();
    updateBrowseHeader();
    renderBrowseToolbar();
    updatePublishProgressSurface();
    updateBrowseEmptyState();
    updatePrivateFolderAction();
    updateRequestSurface();
    updateAnnouncementSurface();
    updateSystemPanel();
    renderLogPanel();
    renderSessionLibrary();
    void loadAppData();
  }

  async function loadAppData() {
    await Promise.all([
      refreshHealth(),
      refreshFileList(),
      refreshRequests(),
      refreshPeerList(),
      state.role === 'owner' ? refreshMemberList() : Promise.resolve(),
      refreshLogs(),
    ]);
  }

  function updateHealthBar() {
    const roleColors = { owner: 'green', admin: 'yellow', viewer: 'grey' };
    const network = deriveNetworkPresentation();
    const workspace = deriveWorkspacePresentation();
    const session = deriveSessionPresentation();

    els.healthRoleDot.className = `dot ${roleColors[state.role] || 'grey'}`;
    els.healthRoleLabel.textContent = cap(state.role);
    els.healthNetworkDot.className = `dot ${network.color}`;
    els.healthNetworkLabel.textContent = network.label;
    els.healthWorkspaceDot.className = `dot ${workspace.color}`;
    els.healthWorkspaceLabel.textContent = workspace.label;
    els.healthSessionDot.className = `dot ${session.color}`;
    els.healthSessionLabel.textContent = session.label;
    els.healthSessionName.textContent = state.sessionName || 'Unnamed session';
  }

  function updateBrowseHeader() {
    if (state.lastError) {
      els.browseTitle.textContent = 'Workspace';
      els.browseSubtitle.textContent = state.lastError;
      els.browseOwnerActions.style.display = state.role === 'owner' ? '' : 'none';
      return;
    }

    if (state.role === 'owner') {
      const inPrivateBrowse = isOwnerPrivateBrowsePath(state.currentBrowsePath);
      els.browseTitle.textContent = inPrivateBrowse ? 'Private Shares' : 'Workspace';
      if (inPrivateBrowse) {
        els.browseSubtitle.textContent = 'Member private lanes are separated from the main workspace view.';
      } else if (!state.sourceFolderSelected) {
        els.browseSubtitle.textContent = 'Choose a source folder to publish workspace files.';
      } else if (state.mirrorActive) {
        els.browseSubtitle.textContent = getPublishSubtitle();
      } else if (state.watcherActive) {
        els.browseSubtitle.textContent = 'Watching the selected source folder for changes.';
      } else {
        els.browseSubtitle.textContent = 'Source folder selected for this session.';
      }
      els.browseOwnerActions.style.display = '';
      return;
    }

    els.browseTitle.textContent = 'Workspace';
    if (state.approvalStatus === 'blocked') {
      els.browseSubtitle.textContent = 'Workspace access is blocked for this device.';
    } else if (state.approvalStatus !== 'approved') {
      els.browseSubtitle.textContent = 'Waiting for owner approval before workspace files become visible.';
    } else if (!state.workspaceVisible) {
      els.browseSubtitle.textContent = 'Your current policy does not expose workspace files in this session.';
    } else if (state.ownerReachable) {
      els.browseSubtitle.textContent = 'Browse files currently shared in this session.';
    } else {
      els.browseSubtitle.textContent = 'Owner offline. Cached metadata remains visible.';
    }
    els.browseOwnerActions.style.display = 'none';
  }

  function updatePublishProgressSurface() {
    if (!els.browseSyncProgress || !els.browseSyncLabel || !els.browseSyncValue || !els.browseSyncFill) return;

    const visible = state.role === 'owner'
      && state.mirrorActive
      && ((state.publishTotalOps || 0) > 0 || (state.publishTotalBytes || 0) > 0);

    if (!visible) {
      els.browseSyncProgress.style.display = 'none';
      els.browseSyncFill.style.width = '0%';
      return;
    }

    els.browseSyncProgress.style.display = '';
    els.browseSyncLabel.textContent = getPublishLabel();
    els.browseSyncValue.textContent = getPublishValue();
    els.browseSyncFill.style.width = `${Math.round((state.publishProgress || 0) * 100)}%`;
  }

  function updateBrowseEmptyState() {
    if (!els.browseEmpty) return;
    let message = 'No visible files in this session yet';
    const currentPath = normalizeBrowsePath(state.currentBrowsePath);

    if (state.role === 'owner') {
      if (isOwnerPrivateBrowsePath(currentPath)) {
        message = currentPath === 'Private'
          ? 'No member private folders yet'
          : `No private items in ${currentPath}`;
      } else {
        message = state.sourceFolderSelected
          ? (currentPath ? `No visible items in ${currentPath}` : 'No visible files in the selected source folder yet')
          : 'Select a source folder to publish workspace files';
      }
    } else if (state.approvalStatus === 'blocked') {
      message = 'Workspace access is blocked';
    } else if (state.approvalStatus !== 'approved') {
      message = 'Waiting for workspace approval';
    } else if (!state.workspaceVisible) {
      message = 'No visible files in this session yet';
    } else if (currentPath) {
      message = `No visible items in ${currentPath}`;
    }

    els.browseEmpty.innerHTML = `<p>${esc(message)}</p>`;
  }

  function normalizeBrowsePath(entryPath = '') {
    return String(entryPath || '').replace(/^\/+|\/+$/g, '');
  }

  function parentBrowsePath(entryPath = '') {
    const normalized = normalizeBrowsePath(entryPath);
    if (!normalized) return '';
    const parts = normalized.split('/');
    parts.pop();
    return parts.join('/');
  }

  function isHiddenBrowseEntry(file) {
    return String(file?.name || '').startsWith('.');
  }

  function isOwnerPrivateBrowsePath(entryPath = '') {
    const normalized = normalizeBrowsePath(entryPath);
    return state.role === 'owner' && (normalized === 'Private' || normalized.startsWith('Private/'));
  }

  function isManagedOwnerInternalRootEntry(entryPath = '') {
    const normalized = normalizeBrowsePath(entryPath);
    if (state.role !== 'owner') return false;
    if (!normalized || normalizeBrowsePath(state.currentBrowsePath)) return false;
    if (!state.activeWorkspacePath || !state.managedWorkspacePath) return false;
    if (state.activeWorkspacePath !== state.managedWorkspacePath) return false;
    return normalized === 'Private' || normalized === 'Requests' || normalized === 'Announcements';
  }

  function browsePathExists(entryPath = '') {
    const normalized = normalizeBrowsePath(entryPath);
    if (!normalized) return true;
    return state.files.some((file) => {
      const filePath = normalizeBrowsePath(file.path);
      return filePath === normalized || filePath.startsWith(normalized + '/');
    });
  }

  function isDirectBrowseChild(entryPath, parentPath = '') {
    const normalizedEntry = normalizeBrowsePath(entryPath);
    const normalizedParent = normalizeBrowsePath(parentPath);
    if (!normalizedEntry) return false;
    if (!normalizedParent) return !normalizedEntry.includes('/');
    if (!normalizedEntry.startsWith(normalizedParent + '/')) return false;
    const remainder = normalizedEntry.slice(normalizedParent.length + 1);
    return !!remainder && !remainder.includes('/');
  }

  function getBrowseEntries() {
    const currentPath = normalizeBrowsePath(state.currentBrowsePath);
    return state.files
      .filter((file) => !isHiddenBrowseEntry(file))
      .filter((file) => !isManagedOwnerInternalRootEntry(file.path))
      .filter((file) => isDirectBrowseChild(file.path, currentPath))
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
        return String(a.name || '').localeCompare(String(b.name || ''));
      });
  }

  function coerceBrowsePath() {
    let nextPath = normalizeBrowsePath(state.currentBrowsePath);
    while (nextPath && !browsePathExists(nextPath)) {
      nextPath = parentBrowsePath(nextPath);
    }
    state.currentBrowsePath = nextPath;
  }

  function setBrowsePath(entryPath = '') {
    state.currentBrowsePath = normalizeBrowsePath(entryPath);
    coerceBrowsePath();
    renderBrowseToolbar();
    renderFileTree();
  }

  function renderBrowseToolbar() {
    if (!els.browseBreadcrumbs || !els.browseUpBtn) return;
    const currentPath = normalizeBrowsePath(state.currentBrowsePath);
    const parts = currentPath ? currentPath.split('/') : [];
    const crumbs = [{ label: 'Workspace', path: '' }];
    let runningPath = '';
    for (const part of parts) {
      runningPath = runningPath ? `${runningPath}/${part}` : part;
      crumbs.push({ label: part, path: runningPath });
    }

    els.browseBreadcrumbs.innerHTML = crumbs.map((crumb, index) => {
      const button = `<button class="breadcrumb-btn${crumb.path === currentPath ? ' active' : ''}" data-browse-path="${esc(crumb.path)}">${esc(crumb.label)}</button>`;
      if (index === crumbs.length - 1) return button;
      return `${button}<span class="breadcrumb-sep">/</span>`;
    }).join('');

    els.browseBreadcrumbs.querySelectorAll('[data-browse-path]').forEach((btn) => {
      btn.addEventListener('click', () => setBrowsePath(btn.dataset.browsePath));
    });

    els.browseUpBtn.disabled = !currentPath;
  }

  function renderFileTree() {
    const currentEntries = getBrowseEntries();
    if (!currentEntries.length) {
      els.fileTree.innerHTML = '';
      updateBrowseEmptyState();
      els.browseEmpty.style.display = '';
      return;
    }

    els.browseEmpty.style.display = 'none';
    els.fileTree.innerHTML = currentEntries.map((file) => {
      const icon = file.kind === 'directory' ? '📁' : '📄';
      const sizeStr = file.kind === 'directory' ? '' : formatSize(file.size);
      const badgeClass = `badge-${file.availability === 'meta-only' ? 'meta' : file.availability}`;
      const badgeText = file.availability === 'meta-only'
        ? 'meta'
        : file.availability === 'local-only'
          ? 'local'
          : file.availability;
      const isTransferring = !!file.transferId;
      const canOpenLocal = file.kind !== 'directory'
        && !isTransferring
        && (file.availability === 'downloaded' || file.localOnly);
      let actionsHtml = '';

      if (file.kind === 'directory') {
        actionsHtml = `<button class="btn btn-ghost btn-sm" data-action="enter" data-path="${esc(file.path)}">Open</button>`;
      } else if (isTransferring) {
        const transferLabel = file.transferDirection === 'upload' ? 'Uploading' : 'Downloading';
        actionsHtml = `<div class="transfer-status">
          <span class="transfer-label">${esc(transferLabel)}</span>
          <div class="progress-bar"><div class="progress-fill" style="width:${Math.round((file.progress || 0) * 100)}%"></div></div>
        </div>`;
      } else if (state.role === 'owner') {
        actionsHtml = `<button class="btn btn-ghost btn-sm" data-action="open-entry" data-path="${esc(file.path)}">Open</button>`;
      } else if (file.localOnly) {
        actionsHtml = `<button class="btn btn-ghost btn-sm" data-action="open-entry" data-path="${esc(file.path)}">Open</button>
          <button class="btn btn-ghost btn-sm" data-action="delete-local" data-path="${esc(file.path)}">Remove</button>`;
      } else if ((file.availability === 'meta-only' || file.availability === 'partial') && !isTransferring) {
        const label = file.availability === 'partial' ? 'Resume' : 'Download';
        actionsHtml = `<button class="btn btn-ghost btn-sm" data-action="download" data-path="${esc(file.path)}">${label}</button>`;
      } else if (file.availability === 'downloaded') {
        actionsHtml = `<button class="btn btn-ghost btn-sm" data-action="open-entry" data-path="${esc(file.path)}">Open</button>
          <button class="btn btn-ghost btn-sm" data-action="delete-local" data-path="${esc(file.path)}">Delete Local</button>`;
      }

      return `<div class="file-row ${file.kind === 'directory' ? 'directory' : ''}${canOpenLocal ? ' file-openable' : ''}" data-path="${esc(file.path)}" data-kind="${esc(file.kind)}">
        <span class="file-icon">${icon}</span>
        <span class="file-name">${esc(file.name)}</span>
        <span class="file-size">${sizeStr}</span>
        <span class="file-badge ${badgeClass}">${badgeText}</span>
        <span class="file-actions">${actionsHtml}</span>
      </div>`;
    }).join('');

    els.fileTree.querySelectorAll('[data-action="enter"]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        setBrowsePath(btn.dataset.path);
      });
    });

    els.fileTree.querySelectorAll('[data-action="open-entry"]').forEach((btn) => {
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        btn.disabled = true;
        try { await electron.openWorkspaceEntry({ path: btn.dataset.path }); } catch (_) {}
        btn.disabled = false;
      });
    });

    els.fileTree.querySelectorAll('[data-action="download"]').forEach((btn) => {
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        btn.disabled = true;
        btn.textContent = '...';
        try { await electron.downloadSharedItem({ path: btn.dataset.path }); } catch (_) {}
      });
    });

    els.fileTree.querySelectorAll('[data-action="delete-local"]').forEach((btn) => {
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        btn.disabled = true;
        try { await electron.deleteLocalCopy({ path: btn.dataset.path }); } catch (_) {}
      });
    });

    els.fileTree.querySelectorAll('.file-row[data-kind="directory"]').forEach((row) => {
      row.addEventListener('click', () => setBrowsePath(row.dataset.path));
    });
  }

  function updateMemberManagementVisibility() {
    if (els.memberManagement) {
      els.memberManagement.style.display = state.role === 'owner' ? '' : 'none';
    }
  }

  async function refreshMemberList() {
    if (state.role !== 'owner') return;
    try {
      state.members = await electron.getMemberList();
      renderMemberList();
      renderPeerList();
    } catch (_) {}
  }

  function renderMemberList() {
    if (!els.memberList) return;
    if (!state.members.length) {
      els.memberList.innerHTML = '<div class="empty-state"><p>No other members yet</p></div>';
      return;
    }
    els.memberList.innerHTML = state.members.map((member) => renderMemberCard(member)).join('');
    bindMemberCardActions();
  }

  function renderMemberCard(member) {
    const statusBadge = `badge-${member.policy.status}`;
    const isExpanded = !!state.expandedMembers[member.deviceId];
    const privateShareSummary = member.privateShares.length
      ? `${member.privateShares.length} private ${pluralize('share', member.privateShares.length)}`
      : 'No private shares';
    const scopedSummary = member.policy.workspaceAccess === 'scoped'
      ? `${(member.policy.allowedPaths || []).length} scoped ${pluralize('path', (member.policy.allowedPaths || []).length)}`
      : cap(member.policy.workspaceAccess);
    const storageSummary = member.online
      ? formatStorageSummary(member.storageTelemetry?.availableBytes || 0, member.storageTelemetry?.capacityBytes || 0)
      : 'Offline';
    const assignmentSummary = formatFabricAssignmentSummary(member.storageAssignment);
    return `<div class="member-card" data-device-id="${esc(member.deviceId)}">
      <div class="member-card-header member-card-summary">
        <div class="member-summary-main">
          <div class="member-summary-title">
            <div class="member-online ${member.online ? 'online' : 'offline'}"></div>
            <span class="member-name">${esc(member.label)}</span>
          </div>
          <div class="member-summary-meta">
            <span class="member-role-badge">${cap(member.role)}</span>
            <span class="file-badge ${statusBadge}">${cap(member.policy.status)}</span>
            <span class="member-summary-text">${esc(scopedSummary)}</span>
            <span class="member-summary-text">${esc(privateShareSummary)}</span>
            <span class="member-summary-text">${esc(storageSummary)}</span>
            <span class="member-summary-text">${esc(assignmentSummary)}</span>
          </div>
        </div>
        <div class="member-summary-actions">
          <select data-member-action="set-status">
            <option value="approved" ${member.policy.status === 'approved' ? 'selected' : ''}>Approved</option>
            <option value="pending" ${member.policy.status === 'pending' ? 'selected' : ''}>Pending</option>
            <option value="blocked" ${member.policy.status === 'blocked' ? 'selected' : ''}>Blocked</option>
          </select>
          <select data-member-action="set-role">
            <option value="viewer" ${member.role === 'viewer' ? 'selected' : ''}>Viewer</option>
            <option value="admin" ${member.role === 'admin' ? 'selected' : ''}>Admin</option>
          </select>
          <button class="btn btn-ghost btn-sm" data-member-action="remove-member">Remove</button>
          <button class="btn btn-ghost btn-sm" data-member-action="toggle-details">${isExpanded ? 'Hide Details' : 'Details'}</button>
        </div>
      </div>

      <div class="member-card-body${isExpanded ? '' : ' collapsed'}">
      <div class="member-section">
        <h4>Permissions</h4>
        <div class="member-field">
          <label>Upload</label>
          <select data-member-action="set-upload">
            <option value="none" ${member.policy.uploadAccess === 'none' ? 'selected' : ''}>Blocked</option>
            <option value="allowed" ${member.policy.uploadAccess === 'allowed' ? 'selected' : ''}>Allowed</option>
          </select>
        </div>
        <div class="member-field">
          <label>Workspace</label>
          <select data-member-action="set-workspace">
            <option value="none" ${member.policy.workspaceAccess === 'none' ? 'selected' : ''}>None</option>
            <option value="allowed" ${member.policy.workspaceAccess === 'allowed' ? 'selected' : ''}>Full</option>
            <option value="scoped" ${member.policy.workspaceAccess === 'scoped' ? 'selected' : ''}>Scoped</option>
          </select>
        </div>
        <div class="member-field">
          <label>Activity</label>
          <select data-member-action="set-activity">
            <option value="none" ${member.policy.activityAccess === 'none' ? 'selected' : ''}>None</option>
            <option value="own" ${member.policy.activityAccess === 'own' ? 'selected' : ''}>Own</option>
            <option value="visible-paths" ${member.policy.activityAccess === 'visible-paths' ? 'selected' : ''}>Visible Paths</option>
            <option value="all" ${member.policy.activityAccess === 'all' ? 'selected' : ''}>All</option>
          </select>
        </div>
        <div class="member-field">
          <label>Company</label>
          <input type="text" value="${esc(member.policy.companyLabel)}" data-member-action="set-company" placeholder="Company label">
        </div>
        ${member.policy.workspaceAccess === 'scoped' ? renderAllowedPaths(member) : ''}
      </div>

      <div class="member-section">
        <h4>Private Shares</h4>
        ${member.privateShares.length ? member.privateShares.map((share) =>
          `<div class="private-share-row">
            <div class="share-main">
              <span class="share-path">${esc(share.path)}</span>
              <span class="share-label">${esc(share.label)}</span>
              ${share.localPath ? `<div class="share-local-path">Imported to ${esc(share.localPath)}</div>` : ''}
            </div>
            <button class="btn btn-ghost btn-sm" data-member-action="open-share" data-share-device-id="${esc(member.deviceId)}">Open Folder</button>
            <button class="btn btn-ghost btn-sm" data-member-action="delete-share" data-share-id="${esc(share.shareId)}">✕</button>
          </div>`
        ).join('') : '<span class="text-muted" style="font-size:12px">None</span>'}
        <button class="btn btn-ghost btn-sm" data-member-action="create-share" style="margin-top:6px">+ Create Private Share</button>
      </div>
      </div>
    </div>`;
  }

  function renderAllowedPaths(member) {
    const paths = member.policy.allowedPaths || [];
    return `<div class="path-editor">
      <label style="font-size:12px;color:var(--text-muted)">Allowed Paths</label>
      ${paths.map((entryPath) => `<span class="path-tag">${esc(entryPath)}<span class="remove-path" data-member-action="remove-path" data-path="${esc(entryPath)}">×</span></span>`).join('')}
      <div class="path-add">
        <input type="text" data-member-action="add-path-input" placeholder="folder/subfolder">
        <button class="btn btn-ghost btn-sm" data-member-action="add-path">Add</button>
      </div>
    </div>`;
  }

  function bindMemberCardActions() {
    els.memberList.querySelectorAll('.member-card').forEach((card) => {
      const deviceId = card.dataset.deviceId;
      card.querySelectorAll('[data-member-action="set-status"]').forEach((select) => {
        select.addEventListener('change', () => setMemberStatus(deviceId, select.value));
      });
      card.querySelectorAll('[data-member-action="set-role"]').forEach((select) => {
        select.addEventListener('change', () => setMemberRole(deviceId, select.value));
      });
      card.querySelectorAll('[data-member-action="remove-member"]').forEach((btn) => {
        btn.addEventListener('click', () => removeMember(deviceId));
      });
      card.querySelectorAll('[data-member-action="toggle-details"]').forEach((btn) => {
        btn.addEventListener('click', () => {
          state.expandedMembers[deviceId] = !state.expandedMembers[deviceId];
          renderMemberList();
        });
      });
      card.querySelectorAll('[data-member-action="set-upload"]').forEach((select) => {
        select.addEventListener('change', () => setMemberPolicy(deviceId, { uploadAccess: select.value }));
      });
      card.querySelectorAll('[data-member-action="set-workspace"]').forEach((select) => {
        select.addEventListener('change', () => setMemberPolicy(deviceId, { workspaceAccess: select.value }));
      });
      card.querySelectorAll('[data-member-action="set-activity"]').forEach((select) => {
        select.addEventListener('change', () => setMemberPolicy(deviceId, { activityAccess: select.value }));
      });
      card.querySelectorAll('[data-member-action="set-company"]').forEach((input) => {
        let debounce = null;
        input.addEventListener('input', () => {
          clearTimeout(debounce);
          debounce = setTimeout(() => setMemberPolicy(deviceId, { companyLabel: input.value }), 500);
        });
      });
      card.querySelectorAll('[data-member-action="remove-path"]').forEach((btn) => {
        btn.addEventListener('click', () => removePath(deviceId, btn.dataset.path));
      });
      card.querySelectorAll('[data-member-action="add-path"]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const input = card.querySelector('[data-member-action="add-path-input"]');
          if (input?.value.trim()) addPath(deviceId, input.value.trim());
        });
      });
      card.querySelectorAll('[data-member-action="create-share"]').forEach((btn) => {
        btn.addEventListener('click', () => createShare(deviceId));
      });
      card.querySelectorAll('[data-member-action="open-share"]').forEach((btn) => {
        btn.addEventListener('click', () => openPrivateFolder(btn.dataset.shareDeviceId));
      });
      card.querySelectorAll('[data-member-action="delete-share"]').forEach((btn) => {
        btn.addEventListener('click', () => deleteShare(btn.dataset.shareId));
      });
    });
  }

  async function setMemberStatus(deviceId, status) {
    try {
      await electron.setMemberAccessPolicy({ deviceId, status });
      await refreshMemberList();
    } catch (err) {
      console.error(err);
    }
  }

  async function setMemberRole(deviceId, role) {
    try {
      await electron.setMemberRole({ deviceId, role });
      await refreshMemberList();
    } catch (err) {
      console.error(err);
    }
  }

  async function setMemberPolicy(deviceId, patch) {
    try {
      await electron.setMemberAccessPolicy({ deviceId, ...patch });
      await refreshMemberList();
    } catch (err) {
      console.error(err);
    }
  }

  async function addPath(deviceId, entryPath) {
    const member = state.members.find((row) => row.deviceId === deviceId);
    if (!member) return;
    const paths = [...(member.policy.allowedPaths || []), entryPath];
    try {
      await electron.setMemberAccessPolicy({ deviceId, allowedPaths: paths });
      await refreshMemberList();
    } catch (err) {
      console.error(err);
    }
  }

  async function removePath(deviceId, entryPath) {
    const member = state.members.find((row) => row.deviceId === deviceId);
    if (!member) return;
    const paths = (member.policy.allowedPaths || []).filter((currentPath) => currentPath !== entryPath);
    try {
      await electron.setMemberAccessPolicy({ deviceId, allowedPaths: paths });
      await refreshMemberList();
    } catch (err) {
      console.error(err);
    }
  }

  async function createShare(deviceId) {
    try {
      await electron.createPrivateShare({ deviceId, label: 'Private' });
      await refreshMemberList();
    } catch (err) {
      console.error(err);
    }
  }

  async function deleteShare(shareId) {
    try {
      await electron.deletePrivateShare({ shareId });
      await refreshMemberList();
    } catch (err) {
      console.error(err);
    }
  }

  async function openPrivateFolder(deviceId = null) {
    try {
      await electron.openPrivateShareFolder(deviceId ? { deviceId } : { path: state.currentBrowsePath });
    } catch (err) {
      console.error(err);
    }
  }

  async function removeMember(deviceId) {
    if (!window.confirm('Remove this member and clear its saved governance state from the session?')) return;
    try {
      await electron.removeMember({ deviceId });
      delete state.expandedMembers[deviceId];
      await refreshMemberList();
      await refreshPeerList();
      await refreshRequests();
    } catch (err) {
      console.error(err);
    }
  }

  function renderPeerList() {
    if (els.networkSelfCard) {
      const approval = state.role === 'owner' ? 'Owner session' : `Approval: ${cap(state.approvalStatus)}`;
      els.networkSelfCard.innerHTML = `
        <strong>${esc(state.deviceLabel || 'You')}</strong>
        <span class="text-muted">(${cap(state.role)})</span>
        <div class="text-muted" style="margin-top:6px">${esc(approval)}</div>
      `;
    }

    const pendingPeers = state.peers.filter((peer) => peer.pending);
    const membersById = new Map(state.members.map((member) => [member.deviceId, member]));
    const connectedPeers = state.peers.filter((peer) => {
      if (peer.pending) return false;
      if (state.role !== 'owner') return true;
      return !peer.deviceId || !membersById.has(peer.deviceId);
    });

    if (els.pendingPeerList) {
      if (!pendingPeers.length) {
        els.pendingPeerList.innerHTML = '<div class="empty-state"><p>No pending peers</p></div>';
      } else {
        els.pendingPeerList.innerHTML = pendingPeers.map((peer) =>
          `<div class="peer-row">
            <span class="peer-label">${esc(peer.label || `Peer ${peer.swarmPeerId?.slice(0, 12) || 'unknown'}`)}</span>
            <span class="peer-role">Handshake pending</span>
          </div>`
        ).join('');
      }
    }

    if (!connectedPeers.length) {
      const message = state.role === 'owner' && state.peers.some((peer) => !peer.pending)
        ? 'Live peers are represented above'
        : (pendingPeers.length ? 'No identified peers connected' : 'No peers connected');
      els.peerList.innerHTML = `<div class="empty-state"><p>${message}</p></div>`;
      return;
    }

    els.peerList.innerHTML = connectedPeers.map((peer) => renderPeerModerationRow(peer, membersById.get(peer.deviceId))).join('');
    bindPeerModerationActions();
  }

  function renderPeerModerationRow(peer, member) {
    const isOwnerPeer = peer.role === 'owner';
    const role = isOwnerPeer ? 'owner' : (member?.role || peer.role || 'viewer');
    const status = isOwnerPeer ? 'approved' : (member?.policy?.status || 'pending');
    const storageSummary = formatStorageSummary(peer.storageTelemetry?.availableBytes || 0, peer.storageTelemetry?.capacityBytes || 0);
    const assignmentSummary = formatFabricAssignmentSummary(peer.storageAssignment);
    const statusButtons = state.role === 'owner' && peer.deviceId
      ? `<div class="peer-moderation-buttons">
          <button class="btn btn-sm ${status === 'approved' ? 'active-status' : 'btn-secondary'}" data-peer-action="approve" data-device-id="${esc(peer.deviceId)}">Approve</button>
          <button class="btn btn-sm ${status === 'pending' ? 'active-status' : 'btn-secondary'}" data-peer-action="pending" data-device-id="${esc(peer.deviceId)}">Pending</button>
          <button class="btn btn-sm ${status === 'blocked' ? 'active-status' : 'btn-secondary'}" data-peer-action="block" data-device-id="${esc(peer.deviceId)}">Block</button>
        </div>`
      : '';
    const roleControl = state.role === 'owner' && peer.deviceId
      ? `<select class="peer-role-select" data-peer-action="set-role" data-device-id="${esc(peer.deviceId)}">
          <option value="viewer" ${role === 'viewer' ? 'selected' : ''}>Viewer</option>
          <option value="admin" ${role === 'admin' ? 'selected' : ''}>Admin</option>
        </select>`
      : `<span class="peer-role">${esc(role)}</span>`;
    const badgeClass = `badge-${status}`;
    const statusBadge = isOwnerPeer
      ? '<span class="file-badge badge-approved">Owner</span>'
      : member
        ? `<span class="file-badge ${badgeClass}">${cap(status)}</span>`
        : '<span class="file-badge badge-pending">Pending</span>';

    return `<div class="peer-row peer-row-detailed">
      <div class="peer-summary">
        <div class="peer-summary-main">
          <span class="peer-label">${esc(peer.label || peer.deviceId?.slice(0, 12) || peer.swarmPeerId?.slice(0, 12) || 'Peer')}</span>
          <span class="peer-meta">${esc(storageSummary)}${assignmentSummary ? ` · ${esc(assignmentSummary)}` : ''}</span>
        </div>
        ${statusBadge}
      </div>
      <div class="peer-controls">
        ${roleControl}
        ${statusButtons}
      </div>
    </div>`;
  }

  function bindPeerModerationActions() {
    els.peerList.querySelectorAll('[data-peer-action="approve"]').forEach((btn) => {
      btn.addEventListener('click', () => setMemberStatus(btn.dataset.deviceId, 'approved'));
    });
    els.peerList.querySelectorAll('[data-peer-action="pending"]').forEach((btn) => {
      btn.addEventListener('click', () => setMemberStatus(btn.dataset.deviceId, 'pending'));
    });
    els.peerList.querySelectorAll('[data-peer-action="block"]').forEach((btn) => {
      btn.addEventListener('click', () => setMemberStatus(btn.dataset.deviceId, 'blocked'));
    });
    els.peerList.querySelectorAll('[data-peer-action="set-role"]').forEach((select) => {
      select.addEventListener('change', () => setMemberRole(select.dataset.deviceId, select.value));
    });
  }

  function updateRequestSurface() {
    if (state.role === 'owner') {
      if (els.requestsTitle) els.requestsTitle.textContent = 'Request Inbox';
      if (els.requestsSubtitle) els.requestsSubtitle.textContent = 'Review and respond to member requests.';
      if (els.requestSubmitSection) els.requestSubmitSection.style.display = 'none';
    } else {
      if (els.requestsTitle) els.requestsTitle.textContent = 'My Requests';
      if (els.requestsSubtitle) els.requestsSubtitle.textContent = 'Submit access or policy requests to the owner.';
      if (els.requestSubmitSection) els.requestSubmitSection.style.display = '';
    }
    if (!state.requests.length && els.requestsEmpty) {
      const message = state.role === 'owner'
        ? 'No member requests yet'
        : 'You have not submitted any requests yet';
      els.requestsEmpty.innerHTML = `<p>${esc(message)}</p>`;
    }
  }

  function updateAnnouncementSurface() {
    if (els.announcementsTitle) {
      els.announcementsTitle.textContent = state.role === 'owner' ? 'Announcements' : 'Session Announcements';
    }
    if (els.announcementsSubtitle) {
      els.announcementsSubtitle.textContent = state.role === 'owner'
        ? 'Post updates for approved members.'
        : 'Announcements posted by the owner.';
    }
    if (els.announcementCompose) {
      els.announcementCompose.style.display = state.role === 'owner' ? '' : 'none';
    }
    if (!state.announcements.length && els.announcementsEmpty) {
      els.announcementsEmpty.innerHTML = '<p>No announcements posted yet</p>';
    }
  }

  function applyVisibleMessages(allMessages) {
    const normalized = Array.isArray(allMessages) ? allMessages : [];
    state.announcements = normalized.filter((message) => message.kind === 'announcement');
    state.requests = normalized.filter((message) => message.kind !== 'announcement');
    renderAnnouncementList();
    renderRequestList();
  }

  async function refreshHealth() {
    try {
      const health = await electron.getSessionHealth();
      const previousSessionCode = state.sessionCode;
      Object.assign(state, health || {});
      if (previousSessionCode !== state.sessionCode) {
        state.currentBrowsePath = '';
        state.expandedMembers = {};
      }
      coerceBrowsePath();
      updateHealthBar();
      updateBrowseHeader();
      renderBrowseToolbar();
      updatePublishProgressSurface();
      updateBrowseEmptyState();
      updatePrivateFolderAction();
      updateMemberManagementVisibility();
      updateRequestSurface();
      updateAnnouncementSurface();
      updateSystemPanel();
    } catch (_) {}
  }

  async function refreshFileList() {
    try {
      state.files = await electron.getFileList();
      renderFileTree();
    } catch (_) {}
  }

  async function refreshPeerList() {
    try {
      state.peers = await electron.getSessionPeers();
      renderPeerList();
    } catch (_) {}
  }

  async function refreshRequests() {
    try {
      const allMessages = await electron.listRequests();
      applyVisibleMessages(allMessages);
    } catch (_) {}
  }

  async function refreshLogs() {
    try {
      const payload = await electron.getAppLogs({ limit: 80 });
      state.logs = payload?.entries || [];
      state.logPath = payload?.logPath || null;
    } catch (err) {
      state.logs = [{
        timestamp: new Date().toISOString(),
        level: 'error',
        scope: 'renderer',
        message: err.message || 'Failed to load logs',
        meta: null,
      }];
      state.logPath = null;
    }
    renderLogPanel();
  }

  function renderAnnouncementList() {
    if (!els.announcementList) return;
    const sorted = [...state.announcements].sort((a, b) => {
      const aPinned = a.metadata?.pinned;
      const bPinned = b.metadata?.pinned;
      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });

    if (!sorted.length) {
      els.announcementList.innerHTML = '';
      if (els.announcementsEmpty) els.announcementsEmpty.style.display = '';
      return;
    }

    if (els.announcementsEmpty) els.announcementsEmpty.style.display = 'none';
    els.announcementList.innerHTML = sorted.map((message) => renderAnnouncementCard(message)).join('');
  }

  function renderAnnouncementCard(message) {
    const isPinned = message.metadata?.pinned;
    const classes = ['announcement-card'];
    if (isPinned) classes.push('pinned');
    if (message.priority === 'high') classes.push('priority-high');

    const timeStr = message.createdAt ? new Date(message.createdAt).toLocaleString() : '';
    const badges = [];
    if (isPinned) badges.push('<span class="announcement-badge badge-pinned">Pinned</span>');
    if (message.priority === 'high') badges.push('<span class="announcement-badge badge-high">High</span>');

    return `<div class="${classes.join(' ')}">
      <div class="announcement-card-header">
        <span class="kind-announcement">Announcement</span>
        ${badges.join('')}
      </div>
      <div class="announcement-card-body">${esc(message.body)}</div>
      <div class="announcement-card-meta">${timeStr}</div>
    </div>`;
  }

  function renderRequestList() {
    if (!els.requestList) return;
    const sorted = [...state.requests].sort((a, b) => {
      const statusRank = (message) => message.status === 'open' ? 0 : 1;
      const rankDiff = statusRank(a) - statusRank(b);
      if (rankDiff !== 0) return rankDiff;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });

    if (!sorted.length) {
      els.requestList.innerHTML = '';
      if (els.requestsEmpty) els.requestsEmpty.style.display = '';
      updateRequestSurface();
      return;
    }

    if (els.requestsEmpty) els.requestsEmpty.style.display = 'none';
    els.requestList.innerHTML = sorted.map((message) => renderRequestCard(message)).join('');
    bindRequestCardActions();
  }

  function renderRequestCard(message) {
    const kindClass = message.kind === 'request' ? 'kind-request' : 'kind-notice';
    const statusBadge = message.status
      ? `badge-${message.status === 'open' ? 'pending' : message.status === 'approved' ? 'approved' : message.status === 'denied' ? 'blocked' : 'pending'}`
      : '';
    const authorLabel = message.authorDeviceId === state.deviceId ? 'You' : (message.authorDeviceId?.slice(0, 12) || 'Unknown');
    const timeStr = message.updatedAt ? new Date(message.updatedAt).toLocaleString() : '';
    const showActions = state.role === 'owner' && message.kind === 'request' && message.status === 'open';

    return `<div class="request-card" data-msg-id="${esc(message.id)}">
      <div class="request-card-header">
        <span class="request-kind ${kindClass}">${message.kind}</span>
        <span class="request-author">${esc(authorLabel)}</span>
        ${message.status ? `<span class="request-status ${statusBadge}">${cap(message.status)}</span>` : ''}
      </div>
      <div class="request-card-body">${esc(message.body)}</div>
      <div class="request-card-meta">${timeStr}</div>
      ${showActions ? `<div class="request-card-actions">
        <button class="btn btn-sm btn-primary" data-req-action="approve">Approve</button>
        <button class="btn btn-sm btn-secondary" data-req-action="hold">Hold</button>
        <button class="btn btn-sm btn-danger" data-req-action="deny">Deny</button>
      </div>` : ''}
    </div>`;
  }

  function bindRequestCardActions() {
    els.requestList.querySelectorAll('.request-card').forEach((card) => {
      const messageId = card.dataset.msgId;
      card.querySelectorAll('[data-req-action]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            const allMessages = await electron.respondToRequest({
              requestId: messageId,
              action: btn.dataset.reqAction,
            });
            applyVisibleMessages(allMessages);
            if (state.role === 'owner') void refreshMemberList();
          } catch (err) {
            console.error(err);
          }
        });
      });
    });
  }

  function updateSystemPanel() {
    const network = deriveNetworkPresentation();
    const workspace = deriveWorkspacePresentation();
    const session = deriveSessionPresentation();

    if (els.displaySessionName) els.displaySessionName.textContent = state.sessionName || 'Unnamed session';
    if (els.displayRole) els.displayRole.textContent = cap(state.role);
    if (els.displayApproval) {
      els.displayApproval.textContent = state.role === 'owner' ? 'Owner' : cap(state.approvalStatus);
    }
    if (els.displayNetworkStatus) els.displayNetworkStatus.textContent = network.label;
    if (els.displayPeerCount) els.displayPeerCount.textContent = String(state.peerCount || 0);
    if (els.displayOwnerReachable) {
      els.displayOwnerReachable.textContent = state.role === 'owner'
        ? 'You are the owner'
        : yesNo(state.ownerReachable);
    }
    if (els.displaySessionState) els.displaySessionState.textContent = session.label;
    if (els.displayWorkspaceStatus) els.displayWorkspaceStatus.textContent = workspace.label;
    if (els.displaySourceFolder) {
      els.displaySourceFolder.textContent = state.role === 'owner'
        ? (state.sourceFolderPath || 'No source folder selected')
        : 'Remote session workspace';
    }
    if (els.displayStorageRoot) els.displayStorageRoot.textContent = state.storageRootPath || '—';
    if (els.displayManagedWorkspace) els.displayManagedWorkspace.textContent = state.managedWorkspacePath || '—';
    if (els.displayPrivateRoot) els.displayPrivateRoot.textContent = state.privateRootPath || '—';
    if (els.displayPrivateSharePath) {
      els.displayPrivateSharePath.textContent = state.role === 'owner'
        ? 'Owner uses the private root and member share folders beneath it'
        : (state.localPrivateSharePath || 'No private share path');
    }
    if (els.displayUploadPermission) {
      els.displayUploadPermission.textContent = state.role === 'owner'
        ? 'Owner always allowed'
        : (state.canUpload ? 'Allowed' : 'Blocked');
    }
    if (els.displayPrivateUploadLane) {
      let label = 'Not used';
      if (state.role === 'owner') {
        label = 'Owner imports member uploads into the private root';
      } else if (!state.localPrivateSharePath) {
        label = 'No private share path';
      } else if (!state.canUpload) {
        label = 'Inactive: upload permission is blocked';
      } else if (state.watcherActive && state.syncReady) {
        label = 'Active: watching this private share folder';
      } else {
        label = 'Inactive: watcher is not running';
      }
      els.displayPrivateUploadLane.textContent = label;
    }
    if (els.displayWatcherActive) els.displayWatcherActive.textContent = yesNo(state.watcherActive);
    if (els.displayMirrorActivity) {
      els.displayMirrorActivity.textContent = state.mirrorActive ? getPublishLabel() : 'Idle';
    }
    if (els.displayPublishProgress) {
      els.displayPublishProgress.textContent = state.mirrorActive ? getPublishValue() : 'Idle';
    }
    if (els.displaySyncReady) els.displaySyncReady.textContent = yesNo(state.syncReady);
    if (els.displayTransferCount) els.displayTransferCount.textContent = String(state.activeTransferCount || 0);
    if (els.displayUploadJobs) els.displayUploadJobs.textContent = String(state.uploadTransferCount || 0);
    if (els.displayUploadProgress) {
      els.displayUploadProgress.textContent = formatTransferSummary(
        state.uploadTransferCount,
        state.uploadTransferredBytes,
        state.uploadTotalBytes
      );
    }
    if (els.displayImportJobs) els.displayImportJobs.textContent = String(state.importTransferCount || 0);
    if (els.displayImportProgress) {
      els.displayImportProgress.textContent = formatTransferSummary(
        state.importTransferCount,
        state.importTransferredBytes,
        state.importTotalBytes
      );
    }
    if (els.displayLastError) els.displayLastError.textContent = state.lastError || 'None';
    if (els.displayFabricCapacity) {
      els.displayFabricCapacity.textContent = formatProgressSize(state.fabricCapacityBytes || 0);
    }
    if (els.displayFabricFree) {
      els.displayFabricFree.textContent = formatStorageSummary(state.fabricAvailableBytes, state.fabricCapacityBytes);
    }
    if (els.displayFabricOnline) {
      els.displayFabricOnline.textContent = `${state.fabricOnlineNodes || 0} / ${state.fabricTotalNodes || 0}`;
    }
    if (els.displayFabricWritable) {
      els.displayFabricWritable.textContent = String(state.fabricWritableNodes || 0);
    }
    if (els.displayLocalStorage) {
      els.displayLocalStorage.textContent = formatStorageSummary(state.localAvailableBytes, state.localCapacityBytes);
    }
    if (els.displayTotalObjects) els.displayTotalObjects.textContent = String(state.totalObjects || 0);
    if (els.displayTotalExtents) els.displayTotalExtents.textContent = String(state.totalExtents || 0);
    if (els.displayHealthyExtents) els.displayHealthyExtents.textContent = String(state.healthyExtents || 0);
    if (els.displayDegradedExtents) els.displayDegradedExtents.textContent = String(state.degradedExtents || 0);
    if (els.displayUnderReplicatedExtents) els.displayUnderReplicatedExtents.textContent = String(state.underReplicatedExtents || 0);
    if (els.displayUnavailableExtents) els.displayUnavailableExtents.textContent = String(state.unavailableExtents || 0);
    if (els.displayRepairingExtents) els.displayRepairingExtents.textContent = String(state.repairingExtents || 0);
    if (els.displayAssignedBytes) els.displayAssignedBytes.textContent = formatProgressSize(state.totalAssignedBytes || 0);
    if (els.displayStoredBytes) els.displayStoredBytes.textContent = formatProgressSize(state.totalStoredBytes || 0);
    if (els.displayCachedBytes) els.displayCachedBytes.textContent = formatProgressSize(state.totalCachedBytes || 0);
    if (els.displayLocalHeldBytes) els.displayLocalHeldBytes.textContent = formatProgressSize(state.totalAssignedLocalBytes || 0);
    if (els.displayOnlineHolders) els.displayOnlineHolders.textContent = String(state.onlineHolderCount || 0);
    if (els.displayOfflineHolders) els.displayOfflineHolders.textContent = String(state.offlineHolderCount || 0);
    if (els.displayRepairQueue) els.displayRepairQueue.textContent = String(state.repairQueueSize || 0);
    if (els.displayRebalanceQueue) els.displayRebalanceQueue.textContent = String(state.rebalanceQueueSize || 0);
    if (els.displayFabricMode) els.displayFabricMode.textContent = deriveFabricModeLabel();
    if (els.displaySessionCode) els.displaySessionCode.textContent = state.sessionCode || '—';
    if (els.displayDeviceId) els.displayDeviceId.textContent = state.deviceId || '—';
    if (els.displayLogPath) els.displayLogPath.textContent = state.logPath || '—';
  }

  function renderLogPanel() {
    if (!els.systemLogList) return;
    if (!state.logs.length) {
      els.systemLogList.innerHTML = '<div class="system-log-empty">No recent logs</div>';
      return;
    }
    els.systemLogList.innerHTML = state.logs.slice().reverse().map((entry) => {
      const level = esc(entry.level || 'info');
      const scope = esc(entry.scope || 'app');
      const timestamp = esc(entry.timestamp || '');
      const message = esc(entry.message || '');
      const meta = entry.meta ? `<div class="system-log-extra">${esc(JSON.stringify(entry.meta, null, 2))}</div>` : '';
      return `<div class="system-log-row">
        <div class="system-log-meta">
          <span class="system-log-level ${level}">${level}</span>
          <span>${timestamp}</span>
          <span>${scope}</span>
        </div>
        <div class="system-log-message">${message}</div>
        ${meta}
      </div>`;
    }).join('');
  }

  function updatePrivateFolderAction() {
    if (!els.openPrivateFolderBtn) return;
    const label = state.role === 'owner'
      ? (isOwnerPrivateBrowsePath(state.currentBrowsePath) ? 'Back to Workspace' : 'View Private Shares')
      : 'Open My Private Folder';
    els.openPrivateFolderBtn.textContent = label;
    els.openPrivateFolderBtn.style.display = state.sessionCode ? '' : 'none';
  }

  function renderSessionLibrary() {
    if (!els.systemSessionLibrary) return;
    if (!state.savedSessions.length) {
      els.systemSessionLibrary.innerHTML = '<div class="empty-state compact-empty"><p>No saved sessions</p></div>';
      return;
    }

    els.systemSessionLibrary.innerHTML = state.savedSessions.map((session) => {
      const isCurrent = session.id === state.currentSessionId;
      const action = isCurrent
        ? '<span class="session-library-badge">Current</span>'
        : `<button class="btn btn-secondary btn-sm" data-session-action="switch" data-session-id="${esc(session.id)}">Switch</button>
           <button class="btn btn-ghost btn-sm" data-session-action="forget" data-session-id="${esc(session.id)}">Forget</button>`;
      return `<div class="session-library-row">
        <div class="session-library-meta">
          <strong>${esc(session.name)}</strong>
          <span class="text-muted">${esc(session.origin)}</span>
        </div>
        <div class="session-library-actions">${action}</div>
      </div>`;
    }).join('');

    els.systemSessionLibrary.querySelectorAll('[data-session-action="switch"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Switching...';
        try {
          await electron.switchSession({ sessionId: btn.dataset.sessionId });
        } catch (err) {
          console.error(err);
          btn.disabled = false;
          btn.textContent = 'Switch';
        }
      });
    });

    els.systemSessionLibrary.querySelectorAll('[data-session-action="forget"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const sessionId = btn.dataset.sessionId;
        if (!window.confirm('Forget this saved session from this device?')) return;
        btn.disabled = true;
        btn.textContent = 'Forgetting...';
        try {
          await electron.forgetSession({ sessionId });
        } catch (err) {
          console.error(err);
          btn.disabled = false;
          btn.textContent = 'Forget';
        }
      });
    });
  }

  function deriveNetworkPresentation() {
    if (state.role === 'owner') {
      if (state.peerCount > 0) {
        return { color: 'green', label: `${state.peerCount} ${pluralize('peer', state.peerCount)} connected` };
      }
      return { color: 'grey', label: 'No peers connected' };
    }

    if (state.ownerReachable || state.peerCount > 0) {
      return { color: 'green', label: 'Owner reachable' };
    }

    return { color: 'yellow', label: 'Waiting for owner' };
  }

  function deriveWorkspacePresentation() {
    if (state.role === 'owner') {
      if (!state.sourceFolderSelected) return { color: 'grey', label: 'No source folder selected' };
      if (state.watcherActive) return { color: 'green', label: 'Watching source folder' };
      return { color: 'yellow', label: 'Source folder selected' };
    }

    if (state.approvalStatus === 'blocked') return { color: 'red', label: 'Workspace access blocked' };
    if (state.approvalStatus !== 'approved') return { color: 'yellow', label: 'Waiting for approval' };
    if (state.workspaceVisible) return { color: 'green', label: 'Shared workspace visible' };
    return { color: 'grey', label: 'No workspace access' };
  }

  function deriveSessionPresentation() {
    if (state.transitioning) return { color: 'yellow', label: 'Switching session' };
    if (state.activeTransferCount > 0) {
      return {
        color: 'yellow',
        label: `Transferring ${state.activeTransferCount} ${pluralize('file', state.activeTransferCount)}`,
      };
    }
    if (state.mirrorActive) return { color: 'yellow', label: getPublishSessionLabel() };
    if (state.lastError) return { color: 'red', label: 'Attention needed' };
    if (state.sessionCode) return { color: 'green', label: 'Session active' };
    return { color: 'grey', label: 'No active session' };
  }

  function getPublishSubtitle() {
    if (state.publishCurrentPath) {
      return `Publishing ${state.publishCurrentPath} to the active session.`;
    }
    return 'Publishing workspace changes to the active session.';
  }

  function getPublishLabel() {
    if (state.publishCurrentPath) {
      return `Publishing ${state.publishCurrentPath}`;
    }
    return 'Publishing workspace changes';
  }

  function getPublishValue() {
    const progressPercent = `${Math.round((state.publishProgress || 0) * 100)}%`;
    if ((state.publishTotalBytes || 0) > 0) {
      const transferred = Math.min(
        (state.publishTransferredBytes || 0) + (state.publishCurrentBytes || 0),
        state.publishTotalBytes || 0
      );
      return `${formatProgressSize(transferred)} / ${formatProgressSize(state.publishTotalBytes)} (${progressPercent})`;
    }
    if ((state.publishTotalOps || 0) > 0) {
      const completedOps = Math.min(
        (state.publishCompletedOps || 0) + inferCurrentPublishOpCompletion(),
        state.publishTotalOps || 0
      );
      return `${completedOps}/${state.publishTotalOps} updates (${progressPercent})`;
    }
    return progressPercent;
  }

  function getPublishSessionLabel() {
    if ((state.publishTotalBytes || 0) > 0 || (state.publishTotalOps || 0) > 0) {
      return `Publishing ${Math.round((state.publishProgress || 0) * 100)}%`;
    }
    return 'Publishing update';
  }
  function inferCurrentPublishOpCompletion() {
    if (!(state.publishTotalOps > 0)) return 0;
    if (state.publishCurrentPath) return 1;
    const inferred = Math.round((state.publishProgress || 0) * state.publishTotalOps) - (state.publishCompletedOps || 0);
    return Math.max(0, Math.min(1, inferred));
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    if (bytes < 1099511627776) return (bytes / 1073741824).toFixed(1) + ' GB';
    return (bytes / 1099511627776).toFixed(1) + ' TB';
  }

  function formatProgressSize(bytes) {
    return formatSize(bytes) || '0 B';
  }

  function formatStorageSummary(availableBytes, capacityBytes) {
    const available = Number(availableBytes) || 0;
    const capacity = Number(capacityBytes) || 0;
    if (capacity > 0) {
      return `${formatProgressSize(available)} free / ${formatProgressSize(capacity)} total`;
    }
    if (available > 0) {
      return `${formatProgressSize(available)} free`;
    }
    return 'Storage unknown';
  }

  function formatTransferSummary(count, transferredBytes, totalBytes, idleLabel = 'Idle') {
    const jobs = Number(count) || 0;
    if (!jobs) return idleLabel;
    const transferred = Number(transferredBytes) || 0;
    const total = Number(totalBytes) || 0;
    if (total > 0) {
      return `${jobs} job${jobs === 1 ? '' : 's'} • ${formatProgressSize(transferred)} / ${formatProgressSize(total)}`;
    }
    return `${jobs} job${jobs === 1 ? '' : 's'}`;
  }

  function deriveFabricModeLabel() {
    if ((state.totalExtents || 0) > 0 || (state.totalObjects || 0) > 0) {
      return 'Extent fabric active';
    }
    if ((state.uploadTransferCount || 0) > 0 || (state.importTransferCount || 0) > 0) {
      return 'Direct private-upload lane active';
    }
    return 'No extent-backed objects yet';
  }

  function formatFabricAssignmentSummary(assignment) {
    if (!assignment) return '';
    const assignedBytes = Number(assignment.assignedBytes) || 0;
    const storedBytes = Number(assignment.storedBytes) || 0;
    const assignedExtentCount = Number(assignment.assignedExtentCount) || 0;
    const storedExtentCount = Number(assignment.storedExtentCount) || 0;
    if (!(assignedBytes > 0 || storedBytes > 0 || assignedExtentCount > 0 || storedExtentCount > 0)) return '';
    return `${formatProgressSize(storedBytes)} stored / ${formatProgressSize(assignedBytes)} assigned · ${storedExtentCount}/${assignedExtentCount} extents`;
  }

  function pluralize(word, count) {
    return count === 1 ? word : `${word}s`;
  }

  function yesNo(value) {
    return value ? 'Yes' : 'No';
  }

  function esc(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function cap(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
  }
});
