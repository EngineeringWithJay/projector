'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const TASKS = [
  { label: 'projector test suite', script: path.join(ROOT, 'test', 'run.js') },
  { label: 'projector e2e swarm', script: path.join(ROOT, 'scripts', 'e2e-swarm-validation.js') },
];
const NODE_EXECUTABLE = process.env.npm_node_execpath || process.env.NODE || 'node';

function runNodeScript(task) {
  return new Promise((resolve, reject) => {
    console.log(`\n=== ${task.label} ===`);
    const child = spawn(NODE_EXECUTABLE, [task.script], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${task.label} failed with exit code ${code}`));
    });
  });
}

async function main() {
  await app.whenReady();
  for (const task of TASKS) {
    await runNodeScript(task);
  }
  console.log('\nPASS projector electron test runner');
  app.exit(0);
}

main().catch((err) => {
  console.error('\nFAIL projector electron test runner');
  console.error(err.stack || err.message);
  app.exit(1);
});
