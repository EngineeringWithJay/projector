'use strict';

const path = require('path');
const fs = require('fs');
const b4a = require('b4a');
const { HyperFrame, Identity, Permissions, MessagePlane } = require('hyperframe');
const { computeSessionHealth } = require('./health');
const PathService = require('../services/path-service');

/**
 * RuntimeAdapter — Thin adapter between HyperFrame SDK and Projector app.
 *
 * Owns the HyperFrame instance. Exposes a ctx-compatible facade so
 * existing services (WorkspaceSync, DeviceIdentity, etc.) work unchanged.
 *
 * Rules:
 * - node is exposed explicitly for lifecycle/swarm operations
 * - message-update is filtered through getVisibleMessages before forwarding
 * - restoreSession fails into a recoverable state, never partial runtime
 * - switchSession follows a strict teardown/rebind sequence
 * - getMemberList returns app-friendly enriched rows
 */
class RuntimeAdapter {
  constructor({ storagePath, logger = null }) {
    if (!storagePath) throw new Error('RuntimeAdapter requires storagePath.');
    this.storagePath = storagePath;
    this.logger = logger;

    // The SDK instance
    this.node = new HyperFrame({ storagePath });

    // App-specific state (not in SDK)
    this.syncReady = false;
    this.transitioning = false;
    this.lastMirrorStatus = 'pending';
    this.lastError = null;
    this.ownerReachable = false;
    this.sourceFolderPath = null;
    this.watcherActive = false;
    this.mirrorActive = false;
    this.activeTransferCount = 0;
    this.uploadTransferCount = 0;
    this.uploadTransferredBytes = 0;
    this.uploadTotalBytes = 0;
    this.importTransferCount = 0;
    this.importTransferredBytes = 0;
    this.importTotalBytes = 0;
    this.publishProgress = 0;
    this.publishTransferredBytes = 0;
    this.publishTotalBytes = 0;
    this.publishCurrentPath = null;
    this.publishCurrentBytes = 0;
    this.publishCurrentTotalBytes = 0;
    this.publishCompletedOps = 0;
    this.publishTotalOps = 0;
    this._lastSessionStateFingerprint = null;
    this._lastPeerPresenceFingerprint = null;
    this._lastStorageFabricFingerprint = null;
    this._ownerStateNudgeTimers = new Set();
    this._lastOwnerStateBurstAt = 0;
    this._ownerStateNudgedPeers = new Set();

    // Event callbacks (injected by main.js via bindEmitters)
    this._emitHealth = () => {};
    this._emitFileList = () => {};
    this._emitActivity = () => {};
    this._emitPeerList = () => {};
    this._emitSessionLibrary = () => {};
    this._emitRequests = () => {};
  }

  _log(level, scope, message, meta = null) {
    if (!this.logger || typeof this.logger[level] !== 'function') return;
    this.logger[level](`runtime:${scope}`, message, meta);
  }

  // --- ctx-compatible accessors (for WorkspaceSync, DeviceIdentity, etc.) ---

  get identity() { return this.node.identity; }
  get session() { return this.node.session; }
  set session(val) { this.node.session = val; }
  get sessions() { return this.node.sessions; }
  get controlPlane() { return this.node.controlPlane; }
  get dataPlane() { return this.node.dataPlane; }
  get messagePlane() { return this.node.messagePlane; }
  get swarm() { return this.node.swarm; }
  get peerRegistry() { return this.node.peerRegistry; }
  get storage() { return this.node.storage; }

  // ctx-compatible event methods
  emitHealth() { this._emitHealth(); }
  emitFileList() { this._emitFileList(); }
  emitActivity() { this._emitActivity(); }
  emitPeerList() { this._emitPeerList(); }
  emitSessionLibrary() { this._emitSessionLibrary(); }

  _getManagedWorkspacePath() {
    if (!this.node.session?.sessionCode) return null;
    return PathService.getWorkspacePath(this.storagePath, this.node.session.sessionCode);
  }

  _getActiveWorkspacePath() {
    if (!this.node.session?.sessionCode) return null;
    return this.sourceFolderPath || this.node.session?.sourceFolderPath || this._getManagedWorkspacePath();
  }

  _getPrivateRootPath() {
    if (!this.node.session) return null;
    const role = Permissions.getRoleForDevice(this.node.session, this.node.identity?.deviceId);
    const workspacePath = role === Permissions.ROLE_OWNER
      ? this._getActiveWorkspacePath()
      : this._getManagedWorkspacePath();
    return workspacePath ? PathService.resolveWorkspacePath(workspacePath, 'Private') : null;
  }

  _getLocalPrivateSharePath(deviceId = this.node.identity?.deviceId) {
    if (!this.node.session || !deviceId) return null;
    const role = Permissions.getRoleForDevice(this.node.session, this.node.identity?.deviceId);
    const workspacePath = role === Permissions.ROLE_OWNER
      ? this._getActiveWorkspacePath()
      : this._getManagedWorkspacePath();
    if (!workspacePath) return null;
    const sharePath = Permissions.normalizeSessionPath(
      this.node.session.privateShares?.[deviceId]?.path || `Private/${String(deviceId || '').trim()}`
    );
    return PathService.resolveWorkspacePath(workspacePath, sharePath);
  }

  _getPeerStorageAssignmentsMap() {
    const rows = this.node.listPeerStorageAssignments ? this.node.listPeerStorageAssignments() : [];
    return new Map(rows.map((row) => [row.deviceId, row]));
  }

  getHealth() {
    const localTelemetry = this.node.getStorageTelemetry ? this.node.getStorageTelemetry() : { availableBytes: 0, capacityBytes: 0 };
    const fabricHealth = this.node.getStorageFabricHealth ? this.node.getStorageFabricHealth() : null;
    const fabric = fabricHealth?.fabric || (this.node.getStorageFabric ? this.node.getStorageFabric() : {
      totalAvailableBytes: 0,
      totalCapacityBytes: 0,
      onlineNodes: 0,
      totalNodes: 0,
      placementCandidates: [],
    });
    const extentSummary = fabricHealth?.extentSummary || {
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
    };

    return computeSessionHealth({
      session: this.node.session,
      deviceId: this.node.identity?.deviceId,
      swarmConnected: this.node.swarm?.connectionCount > 0,
      peerCount: this.node.swarm?.connectionCount || 0,
      syncReady: this.syncReady,
      transitioning: this.transitioning,
      lastMirrorStatus: this.lastMirrorStatus,
      updateAvailable: false,
      lastError: this.lastError,
      ownerReachable: this.ownerReachable,
      sourceFolderPath: this.sourceFolderPath || this.node.session?.sourceFolderPath || null,
      watcherActive: this.watcherActive,
      mirrorActive: this.mirrorActive,
      activeTransferCount: this.activeTransferCount,
      uploadTransferCount: this.uploadTransferCount,
      uploadTransferredBytes: this.uploadTransferredBytes,
      uploadTotalBytes: this.uploadTotalBytes,
      importTransferCount: this.importTransferCount,
      importTransferredBytes: this.importTransferredBytes,
      importTotalBytes: this.importTotalBytes,
      publishProgress: this.publishProgress,
      publishTransferredBytes: this.publishTransferredBytes,
      publishTotalBytes: this.publishTotalBytes,
      publishCurrentPath: this.publishCurrentPath,
      publishCurrentBytes: this.publishCurrentBytes,
      publishCurrentTotalBytes: this.publishCurrentTotalBytes,
      publishCompletedOps: this.publishCompletedOps,
      publishTotalOps: this.publishTotalOps,
      localAvailableBytes: localTelemetry.availableBytes || 0,
      localCapacityBytes: localTelemetry.capacityBytes || 0,
      fabricAvailableBytes: fabric.totalAvailableBytes || 0,
      fabricCapacityBytes: fabric.totalCapacityBytes || 0,
      fabricOnlineNodes: fabric.onlineNodes || 0,
      fabricTotalNodes: fabric.totalNodes || 0,
      fabricWritableNodes: Array.isArray(fabric.placementCandidates) ? fabric.placementCandidates.length : 0,
      storageRootPath: this.storagePath,
      managedWorkspacePath: this._getManagedWorkspacePath(),
      activeWorkspacePath: this._getActiveWorkspacePath(),
      privateRootPath: this._getPrivateRootPath(),
      localPrivateSharePath: this._getLocalPrivateSharePath(),
      totalObjects: extentSummary.totalObjects || 0,
      totalExtents: extentSummary.totalExtents || 0,
      healthyExtents: extentSummary.healthyExtents || 0,
      degradedExtents: extentSummary.degradedExtents || 0,
      unavailableExtents: extentSummary.unavailableExtents || 0,
      underReplicatedExtents: extentSummary.underReplicatedExtents || 0,
      repairingExtents: extentSummary.repairingExtents || 0,
      totalAssignedBytes: extentSummary.totalAssignedBytes || 0,
      totalStoredBytes: extentSummary.totalStoredBytes || 0,
      totalCachedBytes: extentSummary.totalCachedBytes || 0,
      totalAssignedLocalBytes: extentSummary.totalAssignedLocalBytes || 0,
      onlineHolderCount: extentSummary.onlineHolderCount || 0,
      offlineHolderCount: extentSummary.offlineHolderCount || 0,
      repairQueueSize: extentSummary.repairQueueSize || 0,
      rebalanceQueueSize: extentSummary.rebalanceQueueSize || 0,
    });
  }

  _resetTransientState() {
    this.syncReady = false;
    this.ownerReachable = false;
    this.lastError = null;
    this.lastMirrorStatus = 'pending';
    this.sourceFolderPath = null;
    this.watcherActive = false;
    this.mirrorActive = false;
    this.activeTransferCount = 0;
    this.uploadTransferCount = 0;
    this.uploadTransferredBytes = 0;
    this.uploadTotalBytes = 0;
    this.importTransferCount = 0;
    this.importTransferredBytes = 0;
    this.importTotalBytes = 0;
    this.publishProgress = 0;
    this.publishTransferredBytes = 0;
    this.publishTotalBytes = 0;
    this.publishCurrentPath = null;
    this.publishCurrentBytes = 0;
    this.publishCurrentTotalBytes = 0;
    this.publishCompletedOps = 0;
    this.publishTotalOps = 0;
    this._lastSessionStateFingerprint = null;
    this._lastPeerPresenceFingerprint = null;
    this._lastStorageFabricFingerprint = null;
    for (const timer of this._ownerStateNudgeTimers) {
      clearTimeout(timer);
    }
    this._ownerStateNudgeTimers.clear();
    this._lastOwnerStateBurstAt = 0;
    this._ownerStateNudgedPeers.clear();
  }

  _primeHeartbeatFingerprints() {
    this._lastSessionStateFingerprint = this._getSessionStateFingerprint();
    this._lastPeerPresenceFingerprint = this._getPeerPresenceFingerprint();
    this._lastStorageFabricFingerprint = this._getStorageFabricFingerprint();
  }

  _nudgeOwnerStateBroadcast(reason) {
    if (this.node.getRole?.() !== Permissions.ROLE_OWNER) return;
    if (typeof this.node._broadcastSessionState !== 'function') return;
    const now = Date.now();
    if (now - this._lastOwnerStateBurstAt < 1500) return;
    this._lastOwnerStateBurstAt = now;
    this._log('debug', 'session', 'Scheduling owner state broadcast burst', { reason });
    for (const delayMs of [0, 150, 500, 1000, 2000, 3500, 5000]) {
      const timer = setTimeout(() => {
        this._ownerStateNudgeTimers.delete(timer);
        try {
          this.node._broadcastSessionState();
        } catch (err) {
          this._log('warn', 'session', 'Owner state nudge failed', { reason, delayMs, error: err?.message || String(err) });
        }
      }, delayMs);
      this._ownerStateNudgeTimers.add(timer);
    }
  }

  _getSessionStateFingerprint() {
    if (!this.node.session) return null;
    const deviceId = this.node.identity?.deviceId || null;
    const selfPolicy = deviceId
      ? Permissions.getMemberAccessPolicy(this.node.session, deviceId)
      : null;
    const selfSharePath = deviceId
      ? this.node.session.privateShares?.[deviceId]?.path || null
      : null;
    return JSON.stringify({
      id: this.node.session.id || null,
      code: this.node.session.sessionCode || null,
      origin: this.node.session.origin || null,
      role: Permissions.getRoleForDevice(this.node.session, deviceId),
      ownerId: this.node.session.ownerId || null,
      metadataKey: this.node.session.metadataKey || null,
      workspaceKey: this.node.session.workspaceKey || null,
      selfPolicy,
      selfSharePath,
    });
  }

  _getPeerPresenceFingerprint() {
    return JSON.stringify(this.getPeers().map((peer) => ({
      deviceId: peer.deviceId || null,
      swarmPeerId: peer.swarmPeerId || null,
      label: peer.label || null,
      role: peer.role || null,
      pending: !!peer.pending,
      uploadDriveKey: peer.uploadDriveKey || null,
    })).sort((a, b) => String(a.deviceId || a.swarmPeerId || '').localeCompare(String(b.deviceId || b.swarmPeerId || ''))));
  }

  _getStorageFabricFingerprint() {
    const fabricHealth = this.node.getStorageFabricHealth ? this.node.getStorageFabricHealth() : null;
    const fabric = fabricHealth?.fabric || {};
    const extentSummary = fabricHealth?.extentSummary || {};
    return JSON.stringify({
      totalAvailableBytes: fabric.totalAvailableBytes || 0,
      totalCapacityBytes: fabric.totalCapacityBytes || 0,
      onlineNodes: fabric.onlineNodes || 0,
      totalNodes: fabric.totalNodes || 0,
      placementCandidates: Array.isArray(fabric.placementCandidates) ? fabric.placementCandidates.map((node) => ({
        deviceId: node.deviceId || null,
        availableBytes: node.availableBytes || 0,
        writable: !!node.writable,
      })) : [],
      totalObjects: extentSummary.totalObjects || 0,
      totalExtents: extentSummary.totalExtents || 0,
      totalStoredBytes: extentSummary.totalStoredBytes || 0,
      repairQueueSize: extentSummary.repairQueueSize || 0,
      rebalanceQueueSize: extentSummary.rebalanceQueueSize || 0,
    });
  }

  async _waitForOwnerBootstrapReady(timeoutMs = 5000) {
    if (typeof this.node.getBootstrapTrace !== 'function') return false;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const trace = this.node.getBootstrapTrace();
      const settled = trace.some((entry) => (
        entry?.stage === 'discovery:announce:done'
        || entry?.stage === 'discovery:announce:timeout'
        || entry?.stage === 'bootstrap:window:skip'
        || entry?.stage === 'bootstrap:result'
      ));
      if (settled) {
        this._log('debug', 'session', 'Owner bootstrap announce settled', {
          durationMs: Date.now() - start,
          traceDepth: trace.length,
        });
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this._log('warn', 'session', 'Owner bootstrap announce wait timed out', {
      timeoutMs,
      traceDepth: this.node.getBootstrapTrace().length,
    });
    return false;
  }

  async _waitForJoinedSessionState(timeoutMs = 7000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (
        this.node.session?.origin === 'joined'
        && this.node.session?.ownerId
        && this.node.session?.metadataKey
        && this.node.session?.workspaceKey
      ) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this._log('warn', 'session', 'Joined session state wait timed out', {
      timeoutMs,
      sessionId: this.node.session?.id || null,
      sessionCode: this.node.session?.sessionCode || null,
      ownerId: this.node.session?.ownerId || null,
      metadataKey: this.node.session?.metadataKey || null,
      workspaceKey: this.node.session?.workspaceKey || null,
    });
    return false;
  }

  async _closeActiveRuntime({ clearCurrentSession = false } = {}) {
    try { await this.node.swarm.disconnectAll(); } catch (_) {}
    try { await this.node.controlPlane.close(); } catch (_) {}
    try { await this.node.dataPlane.close(); } catch (_) {}
    try { await this.node.messagePlane.close(); } catch (_) {}

    this.node.peerRegistry.clear();
    this.node.messages = [];
    this.node.session = null;
    if (clearCurrentSession) this.node.sessions.setCurrentSession(null);
    this._resetTransientState();
  }

  _reapplySavedSessionFields(savedSession = null) {
    if (!savedSession?.id || !this.node.session?.id || savedSession.id !== this.node.session.id) {
      return this.node.session;
    }

    const patch = {};
    if (savedSession.sourceFolderPath) {
      patch.sourceFolderPath = savedSession.sourceFolderPath;
    }

    if (!Object.keys(patch).length) {
      return this.node.session;
    }

    const updated = this.node.sessions.updateSession(this.node.session.id, patch);
    if (updated) {
      this.node.session = updated;
    }
    return this.node.session;
  }

  // --- Lifecycle ---

  /**
   * Initialize the SDK and bind event listeners.
   */
  async init() {
    this._log('info', 'lifecycle', 'Initializing runtime adapter', { storagePath: this.storagePath });
    await this.node.init();
    this.saveIdentity();
    this._repairOwnedSessions();
    this._bindEvents();
    this._log('info', 'lifecycle', 'Runtime adapter initialized', {
      deviceId: this.node.identity?.deviceId,
      label: this.node.identity?.deviceLabel || null,
    });
  }

  /**
   * Restore the last active session if identity is ready.
   * Fails into recoverable state, never partial runtime.
   */
  async restoreSession() {
    if (!this.node.identity?.profileSetupComplete) return null;
    const current = this.node.sessions.getCurrentSession();
    if (!current) return null;

    try {
      this._log('info', 'session', 'Restoring active session', {
        sessionId: current.id,
        sessionCode: current.sessionCode,
        origin: current.origin,
      });
      if (current.origin === 'owned') {
        await this.node.createSession({
          sessionCode: current.sessionCode,
          label: this.node.identity.deviceLabel || 'Owner',
        });
        await this._waitForOwnerBootstrapReady();
      } else {
        await this.node.joinSession(current.sessionCode, {
          label: this.node.identity.deviceLabel || 'Peer',
        });
        await this._waitForJoinedSessionState();
      }
      this._reapplySavedSessionFields(current);
      this._primeHeartbeatFingerprints();
      this.ownerReachable = current.origin === 'owned';
      this.emitPeerList();
      this._emitFileList();
      this._log('info', 'session', 'Active session restored', {
        sessionId: this.node.session?.id,
        sessionCode: this.node.session?.sessionCode,
      });
      return this.node.session;
    } catch (err) {
      // Fail into recoverable state
      this.lastError = err.message;
      this.node.session = null;
      this.emitHealth();
      this._log('error', 'session', 'Failed to restore session', {
        sessionId: current.id,
        sessionCode: current.sessionCode,
        error: err,
      });
      return null;
    }
  }

  /**
   * Create a new session (this device becomes Owner).
   */
  async createSession(opts = {}) {
    this._log('info', 'session', 'Creating owner session', { opts });
    const session = await this.node.createSession({
      label: opts.label || this.node.identity.deviceLabel || 'Owner',
      ...opts,
    });
    await this._waitForOwnerBootstrapReady();
    this._primeHeartbeatFingerprints();
    this.ownerReachable = true;
    this.saveIdentity();
    this.emitHealth();
    this.emitPeerList();
    this._emitFileList();
    this.emitSessionLibrary();
    this._log('info', 'session', 'Owner session created', {
      sessionId: session?.id,
      sessionCode: session?.sessionCode,
    });
    return session;
  }

  /**
   * Join an existing session by code.
   */
  async joinSession(sessionCode, opts = {}) {
    this._log('info', 'session', 'Joining session', {
      sessionCode,
      label: opts.label || this.node.identity.deviceLabel || 'Peer',
    });
    const existing = this.node.sessions.getSession(sessionCode);
    if (existing) {
      this._log('info', 'session', 'Joining switched to existing saved session', {
        sessionId: existing.id,
        sessionCode,
      });
      return this.switchSession(existing.id);
    }
    const session = await this.node.joinSession(sessionCode, {
      label: opts.label || this.node.identity.deviceLabel || 'Peer',
      ...opts,
    });
    await this._waitForJoinedSessionState();
    this._primeHeartbeatFingerprints();
    this.saveIdentity();
    this.emitHealth();
    this.emitPeerList();
    this._emitFileList();
    this.emitSessionLibrary();
    this._log('info', 'session', 'Joined session', {
      sessionId: session?.id,
      sessionCode: session?.sessionCode,
    });
    return session;
  }

  /**
   * Switch to a different saved session.
   * Strict sequence: teardown → clear → activate → rebind → emit.
   */
  async switchSession(sessionId) {
    this._log('info', 'session', 'Switching session', {
      fromSessionId: this.node.session?.id || null,
      toSessionId: sessionId,
    });
    this.transitioning = true;
    this.emitHealth();

    try {
      // 1. Stop swarm, planes, connections
      await this._closeActiveRuntime();

      // 3. Activate target session
      const target = this.node.sessions.getSession(sessionId);
      if (!target) throw new Error(`Session ${sessionId} not found.`);
      this.node.sessions.setCurrentSession(sessionId);

      // 4. Rehydrate through the same lifecycle used for restore/create/join.
      if (target.origin === 'owned') {
        await this.node.createSession({
          sessionCode: target.sessionCode,
          label: this.node.identity.deviceLabel || target.ownerLabel || 'Owner',
          name: target.name,
        });
        await this._waitForOwnerBootstrapReady();
        this._reapplySavedSessionFields(target);
        this.ownerReachable = true;
      } else {
        await this.node.joinSession(target.sessionCode, {
          label: this.node.identity.deviceLabel
            || target.memberProfiles?.[this.node.identity.deviceId]?.label
            || 'Peer',
          name: target.name,
        });
        await this._waitForJoinedSessionState();
        this._reapplySavedSessionFields(target);
      }
      this._primeHeartbeatFingerprints();
    } finally {
      this.transitioning = false;
    }

    // 5. Emit fresh state
    this.emitHealth();
    this.emitSessionLibrary();
    this.emitPeerList();
    this._emitFileList();
    this._log('info', 'session', 'Session switched', {
      sessionId: this.node.session?.id,
      sessionCode: this.node.session?.sessionCode,
      origin: this.node.session?.origin,
    });

    return this.node.session;
  }

  async leaveActiveSession() {
    this._log('info', 'session', 'Leaving active session', {
      sessionId: this.node.session?.id || null,
      sessionCode: this.node.session?.sessionCode || null,
    });
    this.transitioning = true;
    this.emitHealth();

    try {
      await this._closeActiveRuntime({ clearCurrentSession: true });
    } finally {
      this.transitioning = false;
    }

    this.emitHealth();
    this.emitSessionLibrary();
    this.emitPeerList();
    this._emitFileList();
    this._emitRequests();
    this._log('info', 'session', 'Active session cleared');
    return null;
  }

  /**
   * Forget (delete) a saved session.
   */
  forgetSession(sessionId) {
    const existing = this.node.sessions.getSession(sessionId);
    if (!existing) {
      throw new Error(`Session ${sessionId} not found.`);
    }
    if (this.node.session?.id === sessionId) {
      throw new Error('Switch away from the current session before forgetting it.');
    }
    const result = this.node.sessions.forgetSession(sessionId);
    this.emitSessionLibrary();
    return existing;
  }

  /**
   * Rename a session.
   */
  renameSession(sessionId, name) {
    const updated = this.node.sessions.updateSession(sessionId, { name });
    if (updated && this.node.session?.id === sessionId) {
      this.node.session = updated;
    }
    this.emitSessionLibrary();
    this.emitHealth();
    return updated;
  }

  // --- Governance ---

  async setMemberPolicy(deviceId, patch) {
    const result = await this.node.setMemberPolicy(deviceId, patch);
    this.emitHealth();
    this.emitPeerList();
    this._emitFileList();
    return result;
  }

  async setMemberRole(deviceId, role) {
    const result = await this.node.setMemberRole(deviceId, role);
    this.emitHealth();
    this.emitPeerList();
    this._emitFileList();
    return result;
  }

  async removeMember(deviceId) {
    const result = await this.node.removeMember(deviceId);
    this.emitHealth();
    this.emitPeerList();
    this._emitFileList();
    this._emitRequests();
    return result;
  }

  async setVisibilityRule(entryPath, visibility) {
    const result = await this.node.setVisibilityRule(entryPath, visibility);
    this.emitHealth();
    this._emitFileList();
    return result;
  }

  async setPrivateShare(deviceId, opts) {
    const result = await this.node.setPrivateShare(deviceId, opts);
    this.emitHealth();
    this._emitFileList();
    return result;
  }

  async clearPrivateShare(deviceId) {
    const result = await this.node.clearPrivateShare(deviceId);
    this.emitHealth();
    this._emitFileList();
    return result;
  }

  async setDeviceAlias(deviceId, alias) {
    const result = await this.node.setDeviceAlias(deviceId, alias);
    this.emitPeerList();
    return result;
  }

  // --- Messaging ---

  /**
   * Get visible messages for the current device. Always filtered.
   */
  getVisibleMessages() {
    return this.node.getVisibleMessages();
  }

  /**
   * Submit an access request (viewer → owner).
   */
  async requestAccess(body) {
    await this.node.requestAccess(body);
    const result = this.node.getVisibleMessages();
    this._emitRequests();
    return result;
  }

  /**
   * Owner creates an announcement visible to approved members.
   */
  async createAnnouncement({ body, pinned = false, priority = 'normal' } = {}) {
    if (!this.node.session) throw new Error('No active session.');
    if (this.node.session.ownerId !== this.node.identity.deviceId) {
      throw new Error('Only the owner can create announcements.');
    }
    await this.node.createAnnouncement({ body, pinned, priority });
    const result = this.node.getVisibleMessages();
    this._emitRequests();
    return result;
  }

  /**
   * Owner responds to a request. Atomic: verify → policy → status → notice.
   *
   * @param {string} requestId
   * @param {'approve'|'hold'|'deny'} action
   * @param {string} [comment]
   */
  async respondToRequest(requestId, action, comment = '') {
    if (!this.node.session) throw new Error('No active session.');
    if (this.node.session.ownerId !== this.node.identity.deviceId) {
      throw new Error('Only the owner can respond to requests.');
    }

    // Resolve and validate
    const request = this.node.messages.find((m) =>
      m.id === requestId && m.kind === MessagePlane.KIND_REQUEST
    );
    if (!request) throw new Error('Request not found.');
    if (request.status !== MessagePlane.STATUS_OPEN) throw new Error('Request is already resolved.');

    // Map action → contract status
    const actionMap = {
      approve: Permissions.ACCESS_APPROVED,
      hold: Permissions.ACCESS_PENDING,
      deny: Permissions.ACCESS_BLOCKED,
    };
    const contractStatus = actionMap[action];
    if (!contractStatus) throw new Error(`Invalid action: ${action}. Must be approve, hold, or deny.`);

    // setMemberPolicy handles: contract update + request status mutation + metadata broadcast
    const policyPatch = { status: contractStatus };
    await this.node.setMemberPolicy(request.authorDeviceId, policyPatch);

    // Create notice for requester
    const actionLabels = { approve: 'approved', hold: 'put on hold', deny: 'denied' };
    const noticeBody = comment
      ? `Your request was ${actionLabels[action]}. ${comment}`
      : `Your request was ${actionLabels[action]}.`;
    await this.node.sendNotice({
      targetDeviceId: request.authorDeviceId,
      body: noticeBody,
    });

    this.emitHealth();
    this.emitPeerList();
    this._emitFileList();
    this._emitRequests();

    return this.node.getVisibleMessages();
  }

  // --- Peers ---

  getPeers() {
    const assignmentsByDeviceId = this._getPeerStorageAssignmentsMap();
    const peers = this.node.getPeers().map((peer) => ({
      ...peer,
      pending: false,
      storageAssignment: peer.deviceId ? (assignmentsByDeviceId.get(peer.deviceId) || null) : null,
    }));
    const knownSwarmPeerIds = new Set(
      peers.map((peer) => peer.swarmPeerId).filter(Boolean)
    );
    const rawConnections = Array.from(this.node.swarm?.swarm?.connections || []);

    for (const conn of rawConnections) {
      const swarmPeerId = conn?.remotePublicKey ? b4a.toString(conn.remotePublicKey, 'hex') : null;
      if (!swarmPeerId || knownSwarmPeerIds.has(swarmPeerId)) continue;
      peers.push({
        deviceId: null,
        swarmPeerId,
        label: `Peer ${swarmPeerId.slice(0, 12)}`,
        avatar: null,
        role: 'pending',
        signerPublicKey: null,
        lastSeenAt: Date.now(),
        pending: true,
        storageAssignment: null,
      });
    }

    return peers;
  }

  /**
   * App-friendly enriched member list for UI.
   */
  getMemberList() {
    if (!this.node.session) return [];
    const session = this.node.session;
    const assignmentsByDeviceId = this._getPeerStorageAssignmentsMap();
    const workspacePath = this._getActiveWorkspacePath();
    const allIds = new Set([...(session.admins || []), ...(session.viewers || [])]);
    const result = [];

    for (const deviceId of allIds) {
      if (deviceId === session.ownerId) continue;
      const role = Permissions.getRoleForDevice(session, deviceId);
      const policy = Permissions.getMemberAccessPolicy(session, deviceId, role);
      const profile = session.memberProfiles?.[deviceId] || {};
      const peerInfo = this.node.peerRegistry.get(deviceId);
      const privateShares = Object.entries(session.privateShares || {})
        .filter(([sid]) => sid === deviceId)
        .map(([sid, s]) => {
          const sharePath = Permissions.normalizeSessionPath(s.path || `Private/${String(deviceId || '').trim()}`);
          return {
            shareId: sid,
            ...s,
            path: sharePath,
            localPath: workspacePath ? PathService.resolveWorkspacePath(workspacePath, sharePath) : null,
          };
        });

      result.push({
        deviceId,
        role,
        label: profile.label || peerInfo?.label || deviceId.slice(0, 12),
        avatar: profile.avatar || null,
        online: !!peerInfo,
        storageTelemetry: peerInfo?.storageTelemetry || null,
        storageAssignment: assignmentsByDeviceId.get(deviceId) || null,
        policy: {
          status: policy.status,
          workspaceAccess: policy.workspaceAccess,
          activityAccess: policy.activityAccess,
          uploadAccess: policy.uploadAccess,
          companyLabel: policy.companyLabel,
          allowedPaths: Array.isArray(policy.allowedPaths) ? [...policy.allowedPaths] : [],
        },
        privateShares,
      });
    }
    return result;
  }

  // --- Identity ---

  getConfig() {
    return {
      ...Identity.serializeIdentity(this.node.identity),
      version: '0.1.0',
    };
  }

  saveConfig(patch) {
    if (patch.deviceLabel !== undefined) this.node.identity.deviceLabel = patch.deviceLabel;
    if (patch.deviceAvatar !== undefined) this.node.identity.deviceAvatar = patch.deviceAvatar;
    this.saveIdentity();
    this.emitHealth();
  }

  saveIdentity() {
    const configPath = path.join(this.storagePath, 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    let config = {};
    try {
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      }
    } catch (_) {}
    config = { ...config, ...Identity.serializeIdentity(this.node.identity) };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  _repairOwnedSessions() {
    const deviceId = this.node.identity?.deviceId;
    const signingKey = this.node.identity?.signingKeys?.publicKey;
    if (!deviceId || !signingKey) return;

    for (const session of this.sessions.listSessions()) {
      if (!session || session.origin !== 'owned') continue;

      const staleOwnerIds = new Set();
      if (session.ownerId && session.ownerId !== deviceId) {
        staleOwnerIds.add(session.ownerId);
      }
      for (const [memberId, memberKey] of Object.entries(session.memberSigningKeys || {})) {
        if (memberId !== deviceId && typeof memberKey === 'string' && memberKey.trim() === signingKey.trim()) {
          staleOwnerIds.add(memberId);
        }
      }

      const filterMap = (input = {}) => Object.fromEntries(
        Object.entries(input).filter(([memberId]) => !staleOwnerIds.has(memberId))
      );
      const filterList = (input = []) => input.filter((memberId) => memberId && !staleOwnerIds.has(memberId) && memberId !== deviceId);

      const previousOwnerProfile = session.memberProfiles?.[session.ownerId] || null;
      const currentProfile = session.memberProfiles?.[deviceId] || null;
      const previousOwnerPolicy = session.memberAccessPolicies?.[session.ownerId] || null;
      const currentPolicy = session.memberAccessPolicies?.[deviceId] || null;

      const nextMemberProfiles = filterMap(session.memberProfiles || {});
      nextMemberProfiles[deviceId] = {
        label: this.node.identity.deviceLabel || currentProfile?.label || previousOwnerProfile?.label || session.ownerLabel || 'Owner',
        avatar: this.node.identity.deviceAvatar || currentProfile?.avatar || previousOwnerProfile?.avatar || null,
        updatedAt: Date.now(),
      };

      const nextMemberAccessPolicies = filterMap(session.memberAccessPolicies || {});
      nextMemberAccessPolicies[deviceId] = Permissions.buildMemberAccessPolicy(
        {
          ...(previousOwnerPolicy || currentPolicy || {}),
          status: Permissions.ACCESS_APPROVED,
          workspaceAccess: Permissions.WORKSPACE_ALLOWED,
          activityAccess: Permissions.ACTIVITY_ALL,
          uploadAccess: Permissions.UPLOAD_ALLOWED,
          companyLabel: 'Owner',
          allowedPaths: [],
          requestOpen: false,
          requestedAt: 0,
          updatedAt: Date.now(),
        },
        Permissions.ROLE_OWNER,
        { updatedAt: Date.now() }
      );

      const repaired = this.sessions.replaceSession(session.id, {
        ...session,
        origin: 'owned',
        role: 'owner',
        ownerId: deviceId,
        ownerLabel: this.node.identity.deviceLabel || session.ownerLabel || nextMemberProfiles[deviceId].label,
        ownerSigningKey: signingKey,
        activeWriterId: !session.activeWriterId || staleOwnerIds.has(session.activeWriterId)
          ? deviceId
          : session.activeWriterId,
        admins: filterList(session.admins || []),
        viewers: filterList(session.viewers || []),
        memberSigningKeys: {
          ...filterMap(session.memberSigningKeys || {}),
          [deviceId]: signingKey,
        },
        memberProfiles: nextMemberProfiles,
        memberAccessPolicies: nextMemberAccessPolicies,
        deviceAliases: filterMap(session.deviceAliases || {}),
        privateShares: filterMap(session.privateShares || {}),
        updatedAt: Date.now(),
      });

      if (this.node.session?.id === repaired?.id) {
        this.node.session = repaired;
      }
    }
  }

  // --- Shutdown ---

  async destroy() {
    this._log('info', 'lifecycle', 'Destroying runtime adapter', {
      sessionId: this.node.session?.id || null,
    });
    await this.node.destroy();
    this._log('info', 'lifecycle', 'Runtime adapter destroyed');
  }

  // --- Emitter binding ---

  /**
   * Inject event forwarding functions from main.js.
   */
  bindEmitters({ emitHealth, emitFileList, emitActivity, emitPeerList, emitSessionLibrary, emitRequests }) {
    this._emitHealth = emitHealth || this._emitHealth;
    this._emitFileList = emitFileList || this._emitFileList;
    this._emitActivity = emitActivity || this._emitActivity;
    this._emitPeerList = emitPeerList || this._emitPeerList;
    this._emitSessionLibrary = emitSessionLibrary || this._emitSessionLibrary;
    this._emitRequests = emitRequests || this._emitRequests;
  }

  // --- Internal: SDK event translation ---

  _bindEvents() {
    this.node.on('session-state', () => {
      const isJoinedPeer = this.node.session?.origin === 'joined';
      const sessionFingerprint = this._getSessionStateFingerprint();
      const repeatedHeartbeat = isJoinedPeer
        && sessionFingerprint
        && sessionFingerprint === this._lastSessionStateFingerprint;
      this._lastSessionStateFingerprint = sessionFingerprint;
      this._log('info', 'event', 'session-state received', {
        sessionId: this.node.session?.id || null,
        sessionCode: this.node.session?.sessionCode || null,
        metadataKey: this.node.session?.metadataKey || null,
        workspaceKey: this.node.session?.workspaceKey || null,
        repeatedHeartbeat,
      });
      this.ownerReachable = true;
      if (repeatedHeartbeat) {
        this.emitHealth();
        return;
      }
      this.emitHealth();
      this.emitPeerList();
      this.emitSessionLibrary();
      this._emitFileList();
    });

    this.node.on('peer-presence', (payload = {}) => {
      const isJoinedPeer = this.node.session?.origin === 'joined';
      const peerFingerprint = this._getPeerPresenceFingerprint();
      const repeatedHeartbeat = peerFingerprint === this._lastPeerPresenceFingerprint;
      this._lastPeerPresenceFingerprint = peerFingerprint;
      this._log('debug', 'event', 'peer-presence received', {
        peerCount: this.node.swarm?.connectionCount || 0,
        repeatedHeartbeat,
      });
      if (
        this.node.getRole?.() === Permissions.ROLE_OWNER
        && payload.deviceId
        && !this._ownerStateNudgedPeers.has(payload.deviceId)
      ) {
        this._ownerStateNudgedPeers.add(payload.deviceId);
        this._nudgeOwnerStateBroadcast('peer-presence:first-seen');
      }
      if (isJoinedPeer && repeatedHeartbeat) return;
      this.emitHealth();
      this.emitPeerList();
    });

    this.node.on('peer-connected', () => {
      this._log('info', 'event', 'peer-connected', {
        peerCount: this.node.swarm?.connectionCount || 0,
      });
      this._nudgeOwnerStateBroadcast('peer-connected');
      this.emitHealth();
      this.emitPeerList();
    });

    this.node.on('peer-disconnected', () => {
      this._log('warn', 'event', 'peer-disconnected', {
        peerCount: this.node.swarm?.connectionCount || 0,
      });
      for (const [deviceId, peer] of this.node.peerRegistry.entries()) {
        if (!peer?.swarmPeerId) continue;
        if ((this.node.swarm?.connectionCount || 0) === 0) {
          this._ownerStateNudgedPeers.delete(deviceId);
        }
      }
      this.emitHealth();
      this.emitPeerList();
    });

    this.node.on('metadata-update', () => {
      this._log('debug', 'event', 'metadata-update');
      this._lastSessionStateFingerprint = this._getSessionStateFingerprint();
      this._lastStorageFabricFingerprint = this._getStorageFabricFingerprint();
      this.emitHealth();
      this._emitFileList();
    });

    this.node.on('object-manifest-update', () => {
      this.emitHealth();
      this._emitFileList();
      this.emitPeerList();
    });

    this.node.on('extent-catalog-update', () => {
      this.emitHealth();
      this._emitFileList();
      this.emitPeerList();
    });

    this.node.on('storage-fabric-update', () => {
      const isJoinedPeer = this.node.session?.origin === 'joined';
      const storageFingerprint = this._getStorageFabricFingerprint();
      const repeatedHeartbeat = isJoinedPeer
        && storageFingerprint === this._lastStorageFabricFingerprint;
      this._lastStorageFabricFingerprint = storageFingerprint;
      this._log('debug', 'event', 'storage-fabric-update', { repeatedHeartbeat });
      if (repeatedHeartbeat) return;
      this.emitHealth();
      this.emitPeerList();
    });

    this.node.on('message-update', () => {
      this._log('debug', 'event', 'message-update');
      this._emitRequests();
    });
  }
}

module.exports = RuntimeAdapter;
