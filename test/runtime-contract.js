'use strict';

const assert = require('assert/strict');
const path = require('path');
const { Permissions } = require('hyperframe');

const RuntimeAdapter = require('../src/runtime/node');
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
  const baseDir = makeTempDir('projector-runtime-contract-');
  const owner = new RuntimeAdapter({ storagePath: path.join(baseDir, 'owner') });
  const viewer = new RuntimeAdapter({ storagePath: path.join(baseDir, 'viewer') });

  const hardTimeout = setTimeout(() => {
    throw new Error('Runtime contract test exceeded 60s hard timeout');
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
    await waitFor(() => viewer.peerRegistry.has(owner.identity.deviceId), 'viewer identifying owner on first session state');
    assert.ok(
      viewer.getPeers().some((peer) => peer.deviceId === owner.identity.deviceId && !peer.pending),
      'viewer peer list promotes owner beyond raw handshake state'
    );
    await waitFor(() => owner.node.messages.length === 0 && owner.peerRegistry.has(viewer.identity.deviceId), 'owner seeing viewer presence');

    console.log('STEP viewer request returns full visible message list');
    const messagesAfterRequest = await viewer.requestAccess('Need approval');
    assert.ok(Array.isArray(messagesAfterRequest), 'requestAccess returns a message list');
    assert.ok(messagesAfterRequest.some((msg) => msg.kind === 'request' && msg.body === 'Need approval'), 'request list includes submitted request');

    await waitFor(() => owner.node.messages.some((msg) => msg.kind === 'request' && msg.authorDeviceId === viewer.identity.deviceId), 'owner receiving request');
    const request = owner.node.messages.find((msg) => msg.kind === 'request' && msg.authorDeviceId === viewer.identity.deviceId);
    assert.ok(request, 'owner can resolve submitted request');

    console.log('STEP owner response returns full visible message list');
    const messagesAfterResponse = await owner.respondToRequest(request.id, 'approve');
    assert.ok(Array.isArray(messagesAfterResponse), 'respondToRequest returns a message list');
    assert.ok(messagesAfterResponse.some((msg) => msg.id === request.id && msg.status === 'approved'), 'response list includes resolved request');

    await waitFor(() => viewer.node.getAccessPolicy()?.status === Permissions.ACCESS_APPROVED, 'viewer seeing approval');
    await waitFor(() => viewer.node.getAccessPolicy()?.workspaceAccess === Permissions.WORKSPACE_SCOPED, 'viewer default approval is private-only');
    await waitFor(() => viewer.session.privateShares?.[viewer.identity.deviceId]?.path, 'viewer receives private share path');
    assert.deepEqual(
      viewer.node.getAccessPolicy()?.allowedPaths,
      [viewer.session.privateShares[viewer.identity.deviceId].path],
      'viewer default allowed path is their private share'
    );

    console.log('STEP owner announcement returns full visible message list');
    const messagesAfterAnnouncement = await owner.createAnnouncement({ body: 'Maintenance window', pinned: true, priority: 'high' });
    assert.ok(Array.isArray(messagesAfterAnnouncement), 'createAnnouncement returns a message list');
    assert.ok(messagesAfterAnnouncement.some((msg) => msg.kind === 'announcement' && msg.body === 'Maintenance window'), 'announcement list includes announcement');

    console.log('STEP member list shape is stable and nested');
    const members = owner.getMemberList();
    assert.equal(members.length, 1, 'owner sees one non-owner member');
    const member = members[0];
    assert.equal(member.deviceId, viewer.identity.deviceId);
    assert.equal(member.role, Permissions.ROLE_VIEWER);
    assert.equal(member.status, undefined, 'legacy flat status field is absent');
    assert.ok(member.policy && typeof member.policy === 'object', 'member row contains nested policy');
    assert.equal(member.policy.status, Permissions.ACCESS_APPROVED);
    assert.equal(member.policy.workspaceAccess, Permissions.WORKSPACE_SCOPED);
    assert.deepEqual(member.policy.allowedPaths, [viewer.session.privateShares[viewer.identity.deviceId].path]);
    assert.ok(Array.isArray(member.policy.allowedPaths), 'member policy exposes allowedPaths');

    console.log('STEP owner can remove stale member state');
    await owner.removeMember(viewer.identity.deviceId);
    assert.equal(owner.getMemberList().length, 0, 'owner member list no longer includes removed device');
    assert.ok(!owner.getVisibleMessages().some((msg) => msg.authorDeviceId === viewer.identity.deviceId), 'removed member messages are cleared');

    console.log('PASS projector runtime contract');
    console.log(`Base dir: ${baseDir}`);
  } finally {
    clearTimeout(hardTimeout);
    await destroyAll([owner, viewer]);
  }
}

main().catch((err) => {
  console.error('FAIL projector runtime contract');
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
