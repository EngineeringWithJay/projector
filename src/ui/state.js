/* Global UI State — fed ONLY by sessionHealth from backend */
const state = {
  // sessionHealth fields (THE ONLY summary truth)
  role: 'viewer',
  approvalStatus: 'pending',
  workspaceVisible: false,
  activityVisible: 'none',
  swarmConnected: false,
  peerCount: 0,
  syncReady: false,
  transitioning: false,
  lastMirrorStatus: 'pending',
  updateAvailable: false,
  lastError: null,
  canPublish: false,
  isActiveWriter: false,
  ownerReachable: false,
  sessionCode: null,
  sessionName: null,

  // Identity (from get-config)
  deviceId: null,
  deviceLabel: '',
  deviceAvatar: null,
  profileSetupComplete: false,
  devicePrivateKey: '',

  // Detail lists (from detail events ONLY)
  files: [],
  activity: [],
  peers: [],
  savedSessions: [],
  currentSessionId: null,

  // UI-local state (navigation only)
  currentTab: 'browse',
};

function updateState(patch) {
  Object.assign(state, patch);
  return state;
}

function getState() { return state; }
