'use strict';

const assert = require('assert/strict');
const { Permissions } = require('hyperframe');

const { computeSessionHealth } = require('../src/runtime/health');

function makeSession({ role = Permissions.ROLE_VIEWER } = {}) {
  const viewerId = 'viewer-1';
  return {
    ownerId: 'owner-1',
    admins: role === Permissions.ROLE_ADMIN ? [viewerId] : [],
    viewers: role === Permissions.ROLE_VIEWER ? [viewerId] : [],
    memberAccessPolicies: {
      [viewerId]: {
        status: Permissions.ACCESS_APPROVED,
        workspaceAccess: Permissions.WORKSPACE_ALLOWED,
        activityAccess: Permissions.ACTIVITY_ALL,
        uploadAccess: Permissions.UPLOAD_NONE,
      },
    },
    sessionCode: 'session-123',
    name: 'Demo Session',
  };
}

function main() {
  const viewerHealth = computeSessionHealth({
    session: makeSession(),
    deviceId: 'viewer-1',
    ownerReachable: false,
    sourceFolderPath: '/tmp/source',
    watcherActive: true,
    mirrorActive: false,
    activeTransferCount: 2,
    uploadTransferCount: 1,
    uploadTransferredBytes: 256,
    uploadTotalBytes: 512,
    importTransferCount: 1,
    importTransferredBytes: 128,
    importTotalBytes: 1024,
    localAvailableBytes: 512,
    localCapacityBytes: 1024,
    fabricAvailableBytes: 4096,
    fabricCapacityBytes: 8192,
    fabricOnlineNodes: 2,
    fabricTotalNodes: 3,
    fabricWritableNodes: 2,
  });

  assert.equal(viewerHealth.role, Permissions.ROLE_VIEWER);
  assert.equal(viewerHealth.workspaceVisible, true);
  assert.equal(viewerHealth.sourceFolderPath, '/tmp/source');
  assert.equal(viewerHealth.sourceFolderSelected, true);
  assert.equal(viewerHealth.watcherActive, true);
  assert.equal(viewerHealth.mirrorActive, false);
  assert.equal(viewerHealth.activeTransferCount, 2);
  assert.equal(viewerHealth.uploadTransferCount, 1);
  assert.equal(viewerHealth.uploadTransferredBytes, 256);
  assert.equal(viewerHealth.uploadTotalBytes, 512);
  assert.equal(viewerHealth.importTransferCount, 1);
  assert.equal(viewerHealth.importTransferredBytes, 128);
  assert.equal(viewerHealth.importTotalBytes, 1024);
  assert.equal(viewerHealth.publishProgress, 0);
  assert.equal(viewerHealth.publishTotalBytes, 0);
  assert.equal(viewerHealth.localAvailableBytes, 512);
  assert.equal(viewerHealth.localCapacityBytes, 1024);
  assert.equal(viewerHealth.fabricAvailableBytes, 4096);
  assert.equal(viewerHealth.fabricCapacityBytes, 8192);
  assert.equal(viewerHealth.fabricOnlineNodes, 2);
  assert.equal(viewerHealth.fabricTotalNodes, 3);
  assert.equal(viewerHealth.fabricWritableNodes, 2);

  const ownerHealth = computeSessionHealth({
    session: makeSession({ role: Permissions.ROLE_OWNER }),
    deviceId: 'owner-1',
    ownerReachable: false,
    mirrorActive: true,
    publishProgress: 1.25,
    publishTransferredBytes: 128,
    publishTotalBytes: 256,
    publishCurrentPath: 'Private/member/file.mov',
    publishCurrentBytes: 64,
    publishCurrentTotalBytes: 128,
    publishCompletedOps: 2,
    publishTotalOps: 4,
  });

  assert.equal(ownerHealth.role, Permissions.ROLE_OWNER);
  assert.equal(ownerHealth.ownerReachable, true, 'owner health always reports owner reachable');
  assert.equal(ownerHealth.sourceFolderSelected, false);
  assert.equal(ownerHealth.activeTransferCount, 0);
  assert.equal(ownerHealth.publishProgress, 1, 'publish progress is clamped');
  assert.equal(ownerHealth.publishTransferredBytes, 128);
  assert.equal(ownerHealth.publishTotalBytes, 256);
  assert.equal(ownerHealth.publishCurrentPath, 'Private/member/file.mov');
  assert.equal(ownerHealth.publishCurrentBytes, 64);
  assert.equal(ownerHealth.publishCurrentTotalBytes, 128);
  assert.equal(ownerHealth.publishCompletedOps, 2);
  assert.equal(ownerHealth.publishTotalOps, 4);

  console.log('PASS projector health summary');
}

main();
