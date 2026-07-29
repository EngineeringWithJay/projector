'use strict';

const path = require('path');
const { spawn } = require('child_process');

const TESTS = [
  'health-summary.js',
  'path-service.js',
  'private-upload.js',
  'private-upload-growing.js',
  'peer-surface.js',
  'runtime-contract.js',
  'runtime-session-reopen.js',
  'runtime-emits.js',
];

function runTest(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, file)], {
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${file} exited with code ${code}`));
    });
  });
}

async function main() {
  for (const file of TESTS) {
    console.log(`\n=== ${file} ===`);
    await runTest(file);
  }
  console.log('\nPASS projector test suite');
}

main().catch((err) => {
  console.error('\nFAIL projector test suite');
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
