'use strict';

const assert = require('assert/strict');
const path = require('path');
const { Permissions } = require('hyperframe');

const RuntimeAdapter = require('../src/runtime/node');
const { makeTempDir, destroyAll } = require('./helpers');

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
  const baseDir = makeTempDir('projector-runtime-session-reopen-');
  const adapter = new RuntimeAdapter({ storagePath: path.join(baseDir, 'adapter') });
  const storagePath = path.join(baseDir, 'adapter');
  let relaunched = null;

  try {
    bindNoopEmitters(adapter);
    await adapter.init();

    const session = await adapter.createSession({ label: 'Owner' });
    const reopened = await adapter.joinSession(session.sessionCode, { label: 'Owner' });

    assert.equal(reopened.origin, 'owned', 'saved owned session reopens as owned');
    assert.equal(adapter.session.origin, 'owned', 'runtime keeps owned origin');
    assert.equal(adapter.getHealth().role, Permissions.ROLE_OWNER, 'runtime stays owner');

    adapter.sessions.updateSession(session.id, {
      ownerId: 'someone-else',
      ownerLabel: 'Wrong Owner',
      sourceFolderPath: '/tmp/projector-owned-source',
      memberAccessPolicies: {
        [adapter.identity.deviceId]: {
          status: Permissions.ACCESS_PENDING,
          workspaceAccess: Permissions.WORKSPACE_NONE,
          activityAccess: Permissions.ACTIVITY_NONE,
          uploadAccess: Permissions.UPLOAD_NONE,
          allowedPaths: [],
        },
      },
    });

    const switched = await adapter.switchSession(session.id);
    assert.equal(switched.origin, 'owned', 'switching saved owned session preserves owned origin');
    assert.equal(switched.ownerId, adapter.identity.deviceId, 'switching repairs owner id for saved owned session');
    assert.equal(adapter.getHealth().role, Permissions.ROLE_OWNER, 'switching repairs owner role');
    assert.equal(adapter.session.sourceFolderPath, '/tmp/projector-owned-source', 'saved owner source folder metadata survives reopen');

    await adapter.leaveActiveSession();
    assert.equal(adapter.session, null, 'leaveActiveSession clears the live session');
    assert.equal(adapter.sessions.getCurrentSession(), null, 'leaveActiveSession clears the current saved-session binding');
    assert.equal(adapter.getHealth().sessionCode, null, 'health reports no active session after leaving');

    const resumed = await adapter.switchSession(session.id);
    assert.equal(resumed.origin, 'owned', 'saved owned session can be reopened after leaving');
    assert.equal(adapter.getHealth().role, Permissions.ROLE_OWNER, 'reopened saved session restores owner role');

    await destroyAll([adapter]);

    relaunched = new RuntimeAdapter({ storagePath });
    bindNoopEmitters(relaunched);
    await relaunched.init();
    await relaunched.restoreSession();

    assert.equal(relaunched.identity.deviceId, switched.ownerId, 'device identity survives relaunch');
    assert.equal(relaunched.session.ownerId, relaunched.identity.deviceId, 'owned session rebinds to current sacred device id');
    assert.equal(relaunched.getHealth().role, Permissions.ROLE_OWNER, 'relaunch preserves owner role');

    assert.throws(
      () => relaunched.forgetSession(session.id),
      /Switch away from the current session/,
      'current session cannot be forgotten in place'
    );

    console.log('PASS projector runtime session reopen');
  } finally {
    // destroyAll tolerates already-closed runtimes
    await destroyAll([adapter, relaunched]);
  }
}

main().catch((err) => {
  console.error('FAIL projector runtime session reopen');
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
