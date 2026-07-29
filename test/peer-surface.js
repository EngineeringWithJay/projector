'use strict';

const assert = require('assert/strict');
const path = require('path');

const RuntimeAdapter = require('../src/runtime/node');
const { makeTempDir } = require('./helpers');

function makeConn(hex) {
  return { remotePublicKey: Buffer.from(hex, 'hex') };
}

function main() {
  const baseDir = makeTempDir('projector-peer-surface-');
  const adapter = new RuntimeAdapter({ storagePath: path.join(baseDir, 'adapter') });

  const knownSwarmPeerId = '01'.repeat(32);
  const pendingSwarmPeerId = '02'.repeat(32);

  adapter.node.getPeers = () => [{
    deviceId: 'viewer-1',
    swarmPeerId: knownSwarmPeerId,
    label: 'Viewer One',
    role: 'viewer',
  }];
  adapter.node.swarm.swarm = {
    connections: new Set([
      makeConn(knownSwarmPeerId),
      makeConn(pendingSwarmPeerId),
    ]),
  };

  const peers = adapter.getPeers();
  assert.equal(peers.length, 2, 'known peer plus pending connection are surfaced');

  const connected = peers.find((peer) => peer.deviceId === 'viewer-1');
  const pending = peers.find((peer) => peer.pending);

  assert.ok(connected, 'known peer remains visible');
  assert.equal(connected.pending, false, 'known peer is not marked pending');
  assert.ok(pending, 'raw connection is exposed as pending');
  assert.equal(pending.swarmPeerId, pendingSwarmPeerId, 'pending peer keeps swarm id');
  assert.equal(pending.role, 'pending', 'pending peer uses pending role label');

  console.log('PASS projector peer surface');
}

main();
