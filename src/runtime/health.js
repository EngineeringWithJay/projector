'use strict';

const { Permissions } = require('hyperframe');

/**
 * Health — sessionHealth is THE ONLY summary truth.
 *
 * No UI module may invent its own "ready" logic from random events.
 * sessionHealth drives summary UI; detail events only populate rows/lists.
 *
 * Role derivation:
 *   if deviceId === ownerId → owner
 *   else if deviceId in admins → admin
 *   else → viewer
 *
 * workspaceVisible: true if current peer is approved AND has at least one
 *   visible workspace scope under current contract. NOT a synonym for "connected."
 *
 * ownerReachable: false when joined session can see metadata but owner/source
 *   is not reachable. Distinct from blocked, pending approval, or fully synced.
 */

/**
 * Compute the canonical sessionHealth object from runtime state.
 *
 * @param {Object} params
 * @param {Object|null} params.session   - Current session record
 * @param {string|null} params.deviceId  - This device's ID
 * @param {boolean} params.swarmConnected
 * @param {number} params.peerCount
 * @param {boolean} params.syncReady
 * @param {boolean} params.transitioning
 * @param {'ok'|'error'|'pending'} params.lastMirrorStatus
 * @param {boolean} params.updateAvailable
 * @param {string|null} params.lastError
 * @param {boolean} params.ownerReachable
 * @param {string|null} params.sourceFolderPath
 * @param {boolean} params.watcherActive
 * @param {boolean} params.mirrorActive
 * @param {number} params.activeTransferCount
 * @param {number} params.uploadTransferCount
 * @param {number} params.uploadTransferredBytes
 * @param {number} params.uploadTotalBytes
 * @param {number} params.importTransferCount
 * @param {number} params.importTransferredBytes
 * @param {number} params.importTotalBytes
 * @param {number} params.publishProgress
 * @param {number} params.publishTransferredBytes
 * @param {number} params.publishTotalBytes
 * @param {string|null} params.publishCurrentPath
 * @param {number} params.publishCurrentBytes
 * @param {number} params.publishCurrentTotalBytes
 * @param {number} params.publishCompletedOps
 * @param {number} params.publishTotalOps
 * @param {number} params.localAvailableBytes
 * @param {number} params.localCapacityBytes
 * @param {number} params.fabricAvailableBytes
 * @param {number} params.fabricCapacityBytes
 * @param {number} params.fabricOnlineNodes
 * @param {number} params.fabricTotalNodes
 * @param {number} params.fabricWritableNodes
 * @param {string|null} params.storageRootPath
 * @param {string|null} params.managedWorkspacePath
 * @param {string|null} params.activeWorkspacePath
 * @param {string|null} params.privateRootPath
 * @param {string|null} params.localPrivateSharePath
 * @param {number} params.totalObjects
 * @param {number} params.totalExtents
 * @param {number} params.healthyExtents
 * @param {number} params.degradedExtents
 * @param {number} params.unavailableExtents
 * @param {number} params.underReplicatedExtents
 * @param {number} params.repairingExtents
 * @param {number} params.totalAssignedBytes
 * @param {number} params.totalStoredBytes
 * @param {number} params.totalCachedBytes
 * @param {number} params.totalAssignedLocalBytes
 * @param {number} params.onlineHolderCount
 * @param {number} params.offlineHolderCount
 * @param {number} params.repairQueueSize
 * @param {number} params.rebalanceQueueSize
 * @returns {SessionHealth}
 */
function computeSessionHealth({
  session = null,
  deviceId = null,
  swarmConnected = false,
  peerCount = 0,
  syncReady = false,
  transitioning = false,
  lastMirrorStatus = 'pending',
  updateAvailable = false,
  lastError = null,
  ownerReachable = false,
  sourceFolderPath = null,
  watcherActive = false,
  mirrorActive = false,
  activeTransferCount = 0,
  uploadTransferCount = 0,
  uploadTransferredBytes = 0,
  uploadTotalBytes = 0,
  importTransferCount = 0,
  importTransferredBytes = 0,
  importTotalBytes = 0,
  publishProgress = 0,
  publishTransferredBytes = 0,
  publishTotalBytes = 0,
  publishCurrentPath = null,
  publishCurrentBytes = 0,
  publishCurrentTotalBytes = 0,
  publishCompletedOps = 0,
  publishTotalOps = 0,
  localAvailableBytes = 0,
  localCapacityBytes = 0,
  fabricAvailableBytes = 0,
  fabricCapacityBytes = 0,
  fabricOnlineNodes = 0,
  fabricTotalNodes = 0,
  fabricWritableNodes = 0,
  storageRootPath = null,
  managedWorkspacePath = null,
  activeWorkspacePath = null,
  privateRootPath = null,
  localPrivateSharePath = null,
  totalObjects = 0,
  totalExtents = 0,
  healthyExtents = 0,
  degradedExtents = 0,
  unavailableExtents = 0,
  underReplicatedExtents = 0,
  repairingExtents = 0,
  totalAssignedBytes = 0,
  totalStoredBytes = 0,
  totalCachedBytes = 0,
  totalAssignedLocalBytes = 0,
  onlineHolderCount = 0,
  offlineHolderCount = 0,
  repairQueueSize = 0,
  rebalanceQueueSize = 0,
} = {}) {
  const role = Permissions.getRoleForDevice(session, deviceId);
  const policy = session ? Permissions.getMemberAccessPolicy(session, deviceId, role) : null;
  const approvalStatus = policy ? policy.status : Permissions.ACCESS_PENDING;

  // workspaceVisible: approved AND has visible workspace scope
  const workspaceVisible = approvalStatus === Permissions.ACCESS_APPROVED
    && policy.workspaceAccess !== Permissions.WORKSPACE_NONE;

  // activityVisible: from contract
  let activityVisible = 'none';
  if (policy) {
    if (policy.activityAccess === Permissions.ACTIVITY_ALL) activityVisible = 'full';
    else if (policy.activityAccess === Permissions.ACTIVITY_OWN) activityVisible = 'own';
    else if (policy.activityAccess === Permissions.ACTIVITY_VISIBLE_PATHS) activityVisible = 'visible-paths';
    else activityVisible = 'none';
  }

  const canPublishNow = Permissions.canPublish(session, deviceId);
  const canUploadNow = !!(policy && policy.status === Permissions.ACCESS_APPROVED && policy.uploadAccess === Permissions.UPLOAD_ALLOWED);
  const isActiveWriter = session?.activeWriterId === deviceId;

  return {
    role,
    approvalStatus,
    workspaceVisible,
    activityVisible,
    swarmConnected,
    peerCount,
    syncReady,
    transitioning,
    lastMirrorStatus,
    updateAvailable,
    lastError,
    canPublish: canPublishNow,
    canUpload: canUploadNow,
    isActiveWriter,
    ownerReachable: role === 'owner' ? true : ownerReachable,
    sessionCode: session?.sessionCode || null,
    sessionName: session?.name || null,
    sourceFolderPath: sourceFolderPath || null,
    sourceFolderSelected: !!sourceFolderPath,
    watcherActive: !!watcherActive,
    mirrorActive: !!mirrorActive,
    activeTransferCount: Number(activeTransferCount) || 0,
    uploadTransferCount: Number(uploadTransferCount) || 0,
    uploadTransferredBytes: Number(uploadTransferredBytes) || 0,
    uploadTotalBytes: Number(uploadTotalBytes) || 0,
    importTransferCount: Number(importTransferCount) || 0,
    importTransferredBytes: Number(importTransferredBytes) || 0,
    importTotalBytes: Number(importTotalBytes) || 0,
    publishProgress: Math.max(0, Math.min(1, Number(publishProgress) || 0)),
    publishTransferredBytes: Number(publishTransferredBytes) || 0,
    publishTotalBytes: Number(publishTotalBytes) || 0,
    publishCurrentPath: publishCurrentPath || null,
    publishCurrentBytes: Number(publishCurrentBytes) || 0,
    publishCurrentTotalBytes: Number(publishCurrentTotalBytes) || 0,
    publishCompletedOps: Number(publishCompletedOps) || 0,
    publishTotalOps: Number(publishTotalOps) || 0,
    localAvailableBytes: Number(localAvailableBytes) || 0,
    localCapacityBytes: Number(localCapacityBytes) || 0,
    fabricAvailableBytes: Number(fabricAvailableBytes) || 0,
    fabricCapacityBytes: Number(fabricCapacityBytes) || 0,
    fabricOnlineNodes: Number(fabricOnlineNodes) || 0,
    fabricTotalNodes: Number(fabricTotalNodes) || 0,
    fabricWritableNodes: Number(fabricWritableNodes) || 0,
    storageRootPath: storageRootPath || null,
    managedWorkspacePath: managedWorkspacePath || null,
    activeWorkspacePath: activeWorkspacePath || null,
    privateRootPath: privateRootPath || null,
    localPrivateSharePath: localPrivateSharePath || null,
    totalObjects: Number(totalObjects) || 0,
    totalExtents: Number(totalExtents) || 0,
    healthyExtents: Number(healthyExtents) || 0,
    degradedExtents: Number(degradedExtents) || 0,
    unavailableExtents: Number(unavailableExtents) || 0,
    underReplicatedExtents: Number(underReplicatedExtents) || 0,
    repairingExtents: Number(repairingExtents) || 0,
    totalAssignedBytes: Number(totalAssignedBytes) || 0,
    totalStoredBytes: Number(totalStoredBytes) || 0,
    totalCachedBytes: Number(totalCachedBytes) || 0,
    totalAssignedLocalBytes: Number(totalAssignedLocalBytes) || 0,
    onlineHolderCount: Number(onlineHolderCount) || 0,
    offlineHolderCount: Number(offlineHolderCount) || 0,
    repairQueueSize: Number(repairQueueSize) || 0,
    rebalanceQueueSize: Number(rebalanceQueueSize) || 0,
  };
}

module.exports = { computeSessionHealth };
