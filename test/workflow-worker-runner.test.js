const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runWorkerCommand, statusForExit } = require('../lib/workflow-worker-runner');
const { parseArgs } = require('../scripts/workflow-worker-run');

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hci-worker-runner-'));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('runWorkerCommand marks a worker generating before launch and idle after success', () => {
  const repoDir = makeRepo();
  const file = 'reports/workflows/runtime/sample.json';
  const writes = [];

  const result = runWorkerCommand({
    repoDir,
    file,
    id: 'codex-lane',
    label: 'Codex Lane',
    provider: 'codex',
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    now: () => `2026-05-31T14:00:0${writes.length}.000Z`,
    onStatus: (snapshot) => writes.push(snapshot.workers[0].status),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(writes, ['generating', 'idle']);

  const snapshot = readJson(path.join(repoDir, file));
  assert.equal(snapshot.workers[0].id, 'codex-lane');
  assert.equal(snapshot.workers[0].label, 'Codex Lane');
  assert.equal(snapshot.workers[0].provider, 'codex');
  assert.equal(snapshot.workers[0].status, 'idle');
  assert.match(snapshot.workers[0].note, /exited 0/);
});

test('runWorkerCommand marks a worker error after failed command', () => {
  const repoDir = makeRepo();
  const file = 'reports/workflows/runtime/sample.json';

  const result = runWorkerCommand({
    repoDir,
    file,
    id: 'claude-lane',
    provider: 'claude',
    command: process.execPath,
    args: ['-e', 'process.exit(7)'],
    now: () => '2026-05-31T14:00:00.000Z',
  });

  assert.equal(result.exitCode, 7);
  const snapshot = readJson(path.join(repoDir, file));
  assert.equal(snapshot.workers[0].status, 'error');
  assert.match(snapshot.workers[0].note, /exited 7/);
});

test('workflow worker run CLI parser separates wrapper options from command args', () => {
  const args = parseArgs([
    '--repo', '~/repos/MiraRepo',
    '--file', 'reports/workflows/runtime/sample.json',
    '--id', 'codex-lane',
    '--provider', 'codex',
    '--', 'codex', '--ask-for-approval', 'on-request', 'Do the task',
  ]);

  assert.equal(args.repo, '~/repos/MiraRepo');
  assert.equal(args.file, 'reports/workflows/runtime/sample.json');
  assert.equal(args.id, 'codex-lane');
  assert.equal(args.provider, 'codex');
  assert.equal(args.command, 'codex');
  assert.deepEqual(args.commandArgs, ['--ask-for-approval', 'on-request', 'Do the task']);
});

test('statusForExit maps signal termination to stopped', () => {
  assert.equal(statusForExit({ status: null, signal: 'SIGTERM' }), 'stopped');
  assert.equal(statusForExit({ status: 130, signal: null }), 'stopped');
  assert.equal(statusForExit({ status: 0, signal: null }), 'idle');
  assert.equal(statusForExit({ status: 1, signal: null }), 'error');
});
