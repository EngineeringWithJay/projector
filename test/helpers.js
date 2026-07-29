'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await wait(250);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function destroyAll(items = []) {
  for (const item of items) {
    if (!item) continue;
    await item.destroy().catch(() => {});
  }
}

module.exports = {
  wait,
  waitFor,
  makeTempDir,
  destroyAll,
};
