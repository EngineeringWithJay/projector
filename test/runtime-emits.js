'use strict';

const assert = require('assert/strict');
const path = require('path');
const { Permissions } = require('hyperframe');

const RuntimeAdapter = require('../src/runtime/node');
const { waitFor, makeTempDir, destroyAll } = require('./helpers');

async function main() {
  const baseDir = makeTempDir('projector-runtime-emits-');
  const owner = new RuntimeAdapter({ storagePath: path.join(baseDir, 'owner') });
  const viewer = new RuntimeAdapter({ storagePath: path.join(baseDir, 'viewer') });

  const counters = {
    ownerFileList: 0,
    ownerHealth: 0,
    ownerRequests: 0,
    viewerFileList: 0,
  };

  const hardTimeout = setTimeout(() => {
    throw new Error('Runtime emits test exceeded 60s hard timeout');
  }, 60000);

  try {
    owner.bindEmitters({
      emitHealth: () => { counters.ownerHealth += 1; },
      emitFileList: () => { counters.ownerFileList += 1; },
      emitActivity: () => {},
      emitPeerList: () => {},
      emitSessionLibrary: () => {},
      emitRequests: () => { counters.ownerRequests += 1; },
    });
    viewer.bindEmitters({
      emitHealth: () => {},
      emitFileList: () => { counters.viewerFileList += 1; },
      emitActivity: () => {},
      emitPeerList: () => {},
      emitSessionLibrary: () => {},
      emitRequests: () => {},
    });

    console.log('STEP init adapters');
    await owner.init();
    await viewer.init();

    console.log('STEP create and join session');
    const session = await owner.createSession({ label: 'Owner' });
    await viewer.joinSession(session.sessionCode, { label: 'Viewer' });

    await waitFor(() => viewer.session.metadataKey && viewer.session.workspaceKey, 'viewer receiving session state');
    const initialViewerFileListCount = counters.viewerFileList;

    console.log('STEP repeated joined-peer heartbeat does not refresh file list');
    viewer.node.emit('session-state');
    viewer.node.emit('peer-presence');
    viewer.node.emit('storage-fabric-update');
    assert.equal(
      counters.viewerFileList,
      initialViewerFileListCount,
      'unchanged joined-peer heartbeat does not refresh viewer file list'
    );

    console.log('STEP metadata and session events refresh file list');
    owner.node.emit('metadata-update');
    owner.node.emit('session-state');
    assert.ok(counters.ownerFileList >= 2, 'owner file list emitter runs on metadata/session events');

    console.log('STEP policy changes refresh file list');
    const fileListCountBeforePolicy = counters.ownerFileList;
    await owner.setMemberPolicy(viewer.identity.deviceId, {
      status: Permissions.ACCESS_APPROVED,
      workspaceAccess: Permissions.WORKSPACE_ALLOWED,
      activityAccess: Permissions.ACTIVITY_ALL,
    });
    assert.ok(counters.ownerFileList > fileListCountBeforePolicy, 'setMemberPolicy emits file list refresh');

    console.log('STEP request flow triggers request emit');
    const ownerRequestCountBefore = counters.ownerRequests;
    await viewer.requestAccess('Still need audit trail');
    await waitFor(() => counters.ownerRequests > ownerRequestCountBefore, 'owner request emitter firing');

    console.log('STEP viewer metadata updates also refresh file list');
    await waitFor(() => counters.viewerFileList > initialViewerFileListCount, 'viewer file list refresh after metadata update');

    console.log('PASS projector runtime emits');
    console.log(`Base dir: ${baseDir}`);
  } finally {
    clearTimeout(hardTimeout);
    await destroyAll([owner, viewer]);
  }
}

main().catch((err) => {
  console.error('FAIL projector runtime emits');
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
