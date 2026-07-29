'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { Permissions } = require('hyperframe');

const RuntimeAdapter = require('../src/runtime/node');
const WorkspaceSync = require('../src/services/workspace-sync');
const PathService = require('../src/services/path-service');
const { waitFor, destroyAll, wait } = require('./helpers');

function bindNoopEmitters(adapter) {
  adapter.bindEmitters({
    emitHealth: () => {},
    emitFileList: () => {},
    emitActivity: () => {},
    emitPeerList: () => {},
    emitSessionLibrary: () => {},
    emitRequests: () => {},
  });
}

async function main() {
  const tmpRoot = path.join(__dirname, '.tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const baseDir = fs.mkdtempSync(path.join(tmpRoot, 'projector-private-upload-growing-'));
  const owner = new RuntimeAdapter({ storagePath: path.join(baseDir, 'owner') });
  const viewer = new RuntimeAdapter({ storagePath: path.join(baseDir, 'viewer') });
  const ownerSync = new WorkspaceSync(owner);
  const viewerSync = new WorkspaceSync(viewer);

  const hardTimeout = setTimeout(() => {
    throw new Error('Growing private upload test exceeded 90s hard timeout');
  }, 90000);

  try {
    bindNoopEmitters(owner);
    bindNoopEmitters(viewer);

    console.log('STEP init adapters');
    await owner.init();
    await viewer.init();

    console.log('STEP create and join session');
    const session = await owner.createSession({ label: 'Owner' });
    await viewer.joinSession(session.sessionCode, { label: 'Viewer' });
    await waitFor(() => viewer.session.metadataKey && viewer.session.workspaceKey, 'viewer receiving session state');

    console.log('STEP approve viewer with uploads');
    await owner.setMemberPolicy(viewer.identity.deviceId, {
      status: Permissions.ACCESS_APPROVED,
      workspaceAccess: Permissions.WORKSPACE_ALLOWED,
      activityAccess: Permissions.ACTIVITY_OWN,
      uploadAccess: Permissions.UPLOAD_ALLOWED,
    });
    await waitFor(() => viewer.node.getAccessPolicy()?.status === Permissions.ACCESS_APPROVED, 'viewer seeing approval');
    await waitFor(() => viewer.session.privateShares?.[viewer.identity.deviceId]?.path, 'viewer seeing private share');

    console.log('STEP start owner mirror and viewer upload watcher');
    const ownerWorkspacePath = PathService.ensureManagedWorkspace(owner.storagePath, session.sessionCode);
    await ownerSync.startOwnerSync(ownerWorkspacePath);
    await viewerSync.getFileList();
    await waitFor(() => viewer.watcherActive, 'viewer upload watcher active');
    await waitFor(() => owner.peerRegistry.get(viewer.identity.deviceId)?.uploadDriveKey, 'owner seeing viewer upload drive key');

    console.log('STEP write viewer private file in slow chunks');
    const sharePath = viewer.session.privateShares[viewer.identity.deviceId].path;
    const viewerPrivateRoot = PathService.resolveWorkspacePath(
      PathService.ensureManagedWorkspace(viewer.storagePath, session.sessionCode),
      sharePath
    );
    fs.mkdirSync(viewerPrivateRoot, { recursive: true });

    const localFilePath = path.join(viewerPrivateRoot, 'growing.bin');
    const chunks = [
      Buffer.alloc(256 * 1024, 1),
      Buffer.alloc(256 * 1024, 2),
      Buffer.alloc(256 * 1024, 3),
    ];
    for (const chunk of chunks) {
      fs.appendFileSync(localFilePath, chunk);
      await wait(1200);
    }

    const expectedSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const ownerImportedPath = PathService.resolveWorkspacePath(ownerWorkspacePath, `${sharePath}/growing.bin`);

    await waitFor(() => fs.existsSync(ownerImportedPath), 'owner importing grown upload', 30000);
    await waitFor(() => fs.statSync(ownerImportedPath).size === expectedSize, 'owner importing final grown file size', 30000);
    await waitFor(async () => {
      const entry = await owner.dataPlane.entry('/' + `${sharePath}/growing.bin`);
      return entry?.value?.blob?.byteLength === expectedSize;
    }, 'owner publishing final grown file size', 30000);

    assert.equal(fs.statSync(ownerImportedPath).size, expectedSize, 'owner receives the final grown file');

    console.log('PASS projector growing private upload');
    console.log(`Base dir: ${baseDir}`);
  } finally {
    clearTimeout(hardTimeout);
    await ownerSync.stop().catch(() => {});
    await viewerSync.stop().catch(() => {});
    await destroyAll([owner, viewer]);
  }
}

main().catch((err) => {
  console.error('FAIL projector growing private upload');
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
