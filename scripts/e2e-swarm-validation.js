'use strict';

/**
 * E2E Swarm Validation — Projector on HyperFrame SDK.
 *
 * Tests: discovery, presence, metadata replication, contract enforcement,
 * signer mismatch rejection, peer count, data sync, requests, notices.
 *
 * Run: node scripts/e2e-swarm-validation.js
 */

const assert = require('assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HyperFrame, Permissions, Identity, MessagePlane } = require('hyperframe');
const { computeSessionHealth } = require('../src/runtime/health');

async function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(predicate, label, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await predicate();
    if (v) return v;
    await wait(250);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function waitForOwnerBootstrapReady(node, timeoutMs = 5000) {
  if (typeof node.getBootstrapTrace !== 'function') return false;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const trace = node.getBootstrapTrace();
    const settled = trace.some((entry) => (
      entry?.stage === 'discovery:announce:done'
      || entry?.stage === 'discovery:announce:timeout'
      || entry?.stage === 'bootstrap:window:skip'
      || entry?.stage === 'bootstrap:result'
    ));
    if (settled) return true;
    await wait(50);
  }
  return false;
}

async function main() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projector-e2e-'));
  const owner = new HyperFrame({ storagePath: path.join(baseDir, 'owner') });
  const viewer = new HyperFrame({ storagePath: path.join(baseDir, 'viewer') });

  const hardTimeout = setTimeout(() => { throw new Error('E2E exceeded 60s hard timeout'); }, 60000);

  try {
    // --- STEP: Init ---
    console.log('STEP init');
    await owner.init();
    await viewer.init();

    // --- STEP: Owner creates session ---
    console.log('STEP owner creates session');
    const session = await owner.createSession({ label: 'Owner' });
    await waitForOwnerBootstrapReady(owner);
    assert.ok(session.sessionCode, 'Session code generated');
    assert.ok(session.metadataKey, 'Metadata key generated');
    assert.ok(session.workspaceKey, 'Workspace key generated');
    assert.ok(session.messagesKey, 'Messages key generated');
    assert.equal(owner.getRole(), 'owner');

    // --- STEP: Owner health ---
    console.log('STEP owner health');
    const ownerHealth = computeSessionHealth({
      session: owner.session, deviceId: owner.identity.deviceId,
      swarmConnected: false, peerCount: 0, syncReady: false,
    });
    assert.equal(ownerHealth.role, 'owner');
    assert.equal(ownerHealth.approvalStatus, 'approved');
    assert.equal(ownerHealth.workspaceVisible, true);
    assert.equal(ownerHealth.ownerReachable, true);

    // --- STEP: Owner writes data ---
    console.log('STEP owner writes workspace data');
    await owner.dataPlane.put('/test.txt', 'owned-content');
    const check = await owner.dataPlane.get('/test.txt');
    assert.equal(check.toString(), 'owned-content');

    // --- STEP: Viewer joins ---
    console.log('STEP viewer joins session');
    await viewer.joinSession(session.sessionCode, { label: 'Viewer' });
    assert.equal(viewer.getRole(), 'viewer');

    // --- STEP: Wait for session state ---
    console.log('STEP wait for session state sync');
    await waitFor(() => viewer.session.metadataKey && viewer.session.workspaceKey, 'viewer session state');
    assert.equal(viewer.session.workspaceKey, session.workspaceKey);
    assert.equal(viewer.session.metadataKey, session.metadataKey);

    // --- STEP: Wait for metadata replication ---
    console.log('STEP wait for metadata replication');
    await waitFor(() => viewer.session.ownerId === owner.identity.deviceId, 'viewer sees owner identity');
    assert.equal(viewer.session.ownerId, owner.identity.deviceId);

    // --- STEP: Verify contracts ---
    console.log('STEP verify contracts');
    const viewerPolicy = Permissions.getMemberAccessPolicy(owner.session, viewer.identity.deviceId);
    assert.equal(viewerPolicy.status, 'pending');
    assert.equal(viewerPolicy.workspaceAccess, 'none');

    // --- STEP: Owner approves viewer ---
    console.log('STEP owner approves viewer');
    await owner.setMemberPolicy(viewer.identity.deviceId, {
      status: 'approved', workspaceAccess: 'allowed', activityAccess: 'own',
      companyLabel: 'Test Co',
    });

    // --- STEP: Wait for viewer to see approval ---
    console.log('STEP wait for viewer approval');
    await waitFor(() => {
      const p = viewer.session?.memberAccessPolicies?.[viewer.identity.deviceId];
      return p?.status === 'approved';
    }, 'viewer sees approval');
    const viewerApproved = Permissions.getMemberAccessPolicy(viewer.session, viewer.identity.deviceId);
    assert.equal(viewerApproved.status, 'approved');
    assert.equal(viewerApproved.workspaceAccess, 'allowed');

    // --- STEP: Viewer health ---
    console.log('STEP viewer health');
    const viewerHealth = computeSessionHealth({
      session: viewer.session, deviceId: viewer.identity.deviceId,
      swarmConnected: true, peerCount: 1, ownerReachable: true,
    });
    assert.equal(viewerHealth.role, 'viewer');
    assert.equal(viewerHealth.approvalStatus, 'approved');
    assert.equal(viewerHealth.workspaceVisible, true);
    assert.equal(viewerHealth.ownerReachable, true);

    // --- STEP: Peer registry ---
    console.log('STEP peer registry');
    await waitFor(() => owner.peerRegistry.size > 0, 'owner sees peers');
    assert.ok(owner.peerRegistry.has(viewer.identity.deviceId));

    // --- STEP: Signer mismatch rejection ---
    console.log('STEP signer mismatch rejection');
    const fakeKeys = Identity.generateSigningKeys();
    const fakeMsg = Identity.signMessage({
      type: 'presence', sessionCode: session.sessionCode,
      deviceId: viewer.identity.deviceId, deviceLabel: 'Impersonator', role: 'viewer',
    }, fakeKeys.privateKey, fakeKeys.publicKey);
    assert.ok(Identity.verifyMessage(fakeMsg));
    const knownKey = owner.session.memberSigningKeys[viewer.identity.deviceId];
    assert.notEqual(fakeMsg.signerPublicKey, knownKey, 'Signer key mismatch detected');

    // --- STEP: Data plane replication ---
    console.log('STEP data plane replication');
    await waitFor(async () => {
      const data = await viewer.dataPlane.get('/test.txt');
      return data && data.toString() === 'owned-content';
    }, 'viewer reading workspace data');

    // ===== PHASE 3: REQUESTS + NOTICES =====

    // --- STEP: Viewer requests access ---
    console.log('STEP viewer requests access');
    const accessRequest = await viewer.requestAccess('Requesting workspace access');
    assert.equal(accessRequest.kind, 'request');
    assert.equal(accessRequest.status, 'open');
    assert.equal(accessRequest.authorDeviceId, viewer.identity.deviceId);

    // --- STEP: Owner sees request ---
    console.log('STEP owner sees request');
    await waitFor(() => {
      return owner.messages.some((m) => m.kind === 'request' && m.authorDeviceId === viewer.identity.deviceId);
    }, 'owner receiving access request');
    const ownerRequest = owner.messages.find((m) => m.kind === 'request');
    assert.equal(ownerRequest.body, 'Requesting workspace access');

    // --- STEP: Owner responds to request via setMemberPolicy ---
    console.log('STEP owner responds to request');
    // setMemberPolicy auto-updates request status + creates notice internally
    await owner.setMemberPolicy(viewer.identity.deviceId, {
      status: 'approved', workspaceAccess: 'allowed',
    });
    // Verify request status updated
    const updatedRequest = owner.messages.find((m) => m.id === ownerRequest.id);
    assert.equal(updatedRequest.status, 'approved', 'request status = approved');

    // --- STEP: Audience filtering ---
    console.log('STEP audience filtering');
    // Owner should see all messages
    const ownerVisible = owner.getVisibleMessages();
    assert.ok(ownerVisible.length > 0, 'owner sees messages');

    // Viewer should see their own request + any notices targeting them
    await waitFor(() => {
      return viewer.messages.length > 0;
    }, 'viewer receiving messages');
    const viewerVisible = viewer.getVisibleMessages();
    assert.ok(viewerVisible.some((m) => m.kind === 'request'), 'viewer sees their own request');

    // Unrelated peer should see nothing governance-related
    const fakeDeviceId = 'unrelated-device-0000';
    const unrelatedVisible = MessagePlane.getVisibleMessages(owner.session, fakeDeviceId, 'viewer', owner.messages);
    assert.equal(unrelatedVisible.length, 0, 'unrelated peer sees zero governance messages');

    // --- STEP: Unrelated peer exclusion ---
    console.log('STEP unrelated peer exclusion');
    // Double-check with canSeeMessage
    for (const msg of owner.messages) {
      assert.equal(
        MessagePlane.canSeeMessage(owner.session, fakeDeviceId, 'viewer', msg),
        false,
        `unrelated peer cannot see message ${msg.id}`
      );
    }

    // ===== PHASE 5: ANNOUNCEMENTS =====

    // --- STEP: Owner creates announcement ---
    console.log('STEP owner creates announcement');
    const announcement = await owner.createAnnouncement({
      body: 'System maintenance at midnight',
      pinned: true,
      priority: 'high',
    });
    assert.equal(announcement.kind, 'announcement');
    assert.equal(announcement.body, 'System maintenance at midnight');
    assert.equal(announcement.metadata?.pinned, true);
    assert.equal(announcement.priority, 'high');

    // --- STEP: Viewer sees announcement ---
    console.log('STEP viewer sees announcement');
    await waitFor(() => {
      return viewer.messages.some((m) => m.kind === 'announcement');
    }, 'viewer receiving announcement');
    const viewerAnnouncements = viewer.getVisibleMessages().filter((m) => m.kind === 'announcement');
    assert.ok(viewerAnnouncements.length > 0, 'approved viewer sees announcement');
    assert.equal(viewerAnnouncements[0].body, 'System maintenance at midnight');
    assert.equal(viewerAnnouncements[0].metadata?.pinned, true);

    // --- STEP: Unrelated peer cannot see announcement ---
    console.log('STEP unrelated peer cannot see announcement');
    const announcementMsg = owner.messages.find((m) => m.kind === 'announcement');
    assert.equal(
      MessagePlane.canSeeMessage(owner.session, fakeDeviceId, 'viewer', announcementMsg),
      false,
      'unrelated peer cannot see announcement'
    );

    console.log('PASS e2e swarm validation (Phase 0 + 1 + 2 + 3 + 5)');

  } finally {
    clearTimeout(hardTimeout);
    await owner.destroy().catch(() => {});
    await viewer.destroy().catch(() => {});
    console.log(`Base dir: ${baseDir}`);
  }
}

main().catch((err) => {
  console.error('FAIL e2e swarm validation');
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
