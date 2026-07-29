'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const PathService = require('../src/services/path-service');
const { makeTempDir } = require('./helpers');

function exists(target) {
  return fs.existsSync(target);
}

function main() {
  const baseDir = makeTempDir('projector-path-service-');

  PathService.ensureDirectories(baseDir);
  const workspacePath = PathService.ensureManagedWorkspace(baseDir, 'session-123');
  const privateMemberPath = PathService.ensurePrivateMemberFolder(workspacePath, 'viewer-1');
  const customWorkspacePath = PathService.ensureWorkspaceFolder(workspacePath, 'Private/custom-folder');
  const cachedPrivatePath = PathService.ensureLocalFolder(baseDir, 'session-123', 'Private/viewer-1');

  assert.ok(exists(path.join(baseDir, 'cache')), 'cache root exists');
  assert.ok(exists(path.join(baseDir, 'staging')), 'staging root exists');
  assert.ok(exists(path.join(baseDir, 'sessions')), 'sessions root exists');
  assert.ok(exists(path.join(workspacePath, 'Shared')), 'Shared folder exists');
  assert.ok(exists(path.join(workspacePath, 'Private')), 'Private folder exists');
  assert.ok(exists(path.join(workspacePath, 'Requests')), 'Requests folder exists');
  assert.ok(exists(path.join(workspacePath, 'Announcements')), 'Announcements folder exists');
  assert.ok(exists(privateMemberPath), 'viewer private folder exists');
  assert.ok(exists(customWorkspacePath), 'custom workspace folder exists');
  assert.ok(exists(cachedPrivatePath), 'cached private folder exists');

  fs.mkdirSync(PathService.getCachePath(baseDir, 'session-123'), { recursive: true });
  fs.mkdirSync(PathService.getStagingPath(baseDir, 'session-123'), { recursive: true });
  assert.equal(PathService.deleteSessionArtifacts(baseDir, 'session-123'), true, 'session artifacts removed');
  assert.equal(exists(PathService.getSessionPath(baseDir, 'session-123')), false, 'managed session workspace removed');
  assert.equal(exists(PathService.getCachePath(baseDir, 'session-123')), false, 'session cache removed');
  assert.equal(exists(PathService.getStagingPath(baseDir, 'session-123')), false, 'session staging removed');

  console.log('PASS projector path service');
}

main();
