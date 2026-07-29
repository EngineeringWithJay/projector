'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { Permissions } = require('hyperframe');

const RuntimeAdapter = require('../src/runtime/node');
const WorkspaceSync = require('../src/services/workspace-sync');
const PathService = require('../src/services/path-service');
const { waitFor, makeTempDir, destroyAll } = require('./helpers');

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
  const baseDir = makeTempDir('projector-private-upload-');
  const owner = new RuntimeAdapter({ storagePath: path.join(baseDir, 'owner') });
  const viewer = new RuntimeAdapter({ storagePath: path.join(baseDir, 'viewer') });
  const ownerSync = new WorkspaceSync(owner);
  const viewerSync = new WorkspaceSync(viewer);

  const hardTimeout = setTimeout(() => {
    throw new Error('Private upload test exceeded 60s hard timeout');
  }, 60000);

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

    console.log('STEP write into viewer private folder');
    const sharePath = viewer.session.privateShares[viewer.identity.deviceId].path;
    const viewerPrivateRoot = PathService.resolveWorkspacePath(
      PathService.ensureManagedWorkspace(viewer.storagePath, session.sessionCode),
      sharePath
    );
    fs.mkdirSync(viewerPrivateRoot, { recursive: true });
    const payload = Buffer.alloc(256 * 1024, 7);
    const nestedPrivateDir = path.join(viewerPrivateRoot, 'nested');
    fs.mkdirSync(nestedPrivateDir, { recursive: true });
    const localFilePath = path.join(nestedPrivateDir, 'upload.bin');
    fs.writeFileSync(localFilePath, payload);

    const ownerImportedPath = PathService.resolveWorkspacePath(ownerWorkspacePath, `${sharePath}/nested/upload.bin`);
    const ownerImportedDir = PathService.resolveWorkspacePath(ownerWorkspacePath, `${sharePath}/nested`);

    await waitFor(() => fs.existsSync(ownerImportedPath), 'owner importing uploaded private file', 30000);
    await waitFor(async () => {
      const entry = await owner.dataPlane.entry('/' + `${sharePath}/nested/upload.bin`);
      return !!entry?.value?.blob;
    }, 'owner publishing uploaded private file', 30000);
    await waitFor(() => !!owner.node.getObjectManifest(`${sharePath}/nested/upload.bin`), 'owner creating private-share object manifest', 30000);
    await waitFor(() => {
      const extentSummary = owner.node.getExtentHealthSummary();
      return extentSummary.totalObjects > 0 && extentSummary.totalExtents > 0 && extentSummary.totalStoredBytes > 0;
    }, 'owner seeding private-share extents', 30000);

    const ownerBytes = fs.readFileSync(ownerImportedPath);
    assert.equal(ownerBytes.length, payload.length, 'owner imported the full uploaded payload');
    assert.equal(
      owner.node.getObjectManifest(`${sharePath}/nested/upload.bin`)?.sizeBytes,
      payload.length,
      'owner manifest tracks the private-share file size'
    );

    const viewerFiles = await viewerSync.getFileList();
    assert.ok(
      viewerFiles.some((entry) => entry.path === `${sharePath}/nested/upload.bin`),
      'viewer browse includes uploaded private file'
    );

    console.log('STEP delete nested viewer private folder');
    fs.rmSync(nestedPrivateDir, { recursive: true, force: true });

    await waitFor(() => !fs.existsSync(ownerImportedPath), 'owner removing deleted uploaded file', 30000);
    await waitFor(() => !fs.existsSync(ownerImportedDir), 'owner pruning deleted uploaded folder', 30000);
    await waitFor(async () => {
      const entry = await owner.dataPlane.entry('/' + `${sharePath}/nested/upload.bin`);
      return !entry;
    }, 'owner pruning deleted uploaded file from session drive', 30000);
    await waitFor(() => !owner.node.getObjectManifest(`${sharePath}/nested/upload.bin`), 'owner pruning deleted uploaded file manifest', 30000);
    await waitFor(async () => {
      const viewerFilesAfterDelete = await viewerSync.getFileList();
      return !viewerFilesAfterDelete.some((entry) => entry.path === `${sharePath}/nested/upload.bin`);
    }, 'viewer browse pruning deleted uploaded file', 30000);
    await waitFor(async () => {
      const ownerFilesAfterDelete = await ownerSync.getFileList();
      return !ownerFilesAfterDelete.some((entry) => entry.path === `${sharePath}/nested/upload.bin`);
    }, 'owner browse pruning deleted uploaded file', 30000);

    console.log('PASS projector private upload');
    console.log(`Base dir: ${baseDir}`);
  } finally {
    clearTimeout(hardTimeout);
    await ownerSync.stop().catch(() => {});
    await viewerSync.stop().catch(() => {});
    await destroyAll([owner, viewer]);
  }
}

main().catch((err) => {
  console.error('FAIL projector private upload');
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
