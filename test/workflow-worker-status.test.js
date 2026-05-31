const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  resolveWorkerStatusPath,
  upsertWorkerStatus,
} = require('../lib/workflow-worker-status');

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hci-worker-status-'));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('upsertWorkerStatus writes a repo-local snapshot and updates workers by id', () => {
  const repoDir = makeRepo();
  const file = 'reports/workflows/runtime/sample.json';

  const first = upsertWorkerStatus({
    repoDir,
    file,
    id: 'codex-lane',
    label: 'Codex Lane',
    provider: 'codex',
    status: 'running',
    sessionId: 'session-1',
    note: 'started',
    now: '2026-05-31T14:00:00.000Z',
  });

  assert.equal(first.workers.length, 1);
  assert.equal(first.workers[0].status, 'generating');
  assert.equal(first.workers[0].session_id, 'session-1');
  assert.equal(first.workers[0].updated_at, '2026-05-31T14:00:00.000Z');

  upsertWorkerStatus({
    repoDir,
    file,
    id: 'codex-lane',
    status: 'blocked',
    sessionId: 'session-2',
    note: 'approval required',
    now: '2026-05-31T14:03:00.000Z',
  });

  const snapshotPath = path.join(repoDir, file);
  const snapshot = readJson(snapshotPath);
  assert.equal(snapshot.workers.length, 1);
  assert.equal(snapshot.workers[0].label, 'Codex Lane');
  assert.equal(snapshot.workers[0].provider, 'codex');
  assert.equal(snapshot.workers[0].status, 'waiting_approval');
  assert.equal(snapshot.workers[0].session_id, 'session-2');
  assert.equal(snapshot.workers[0].note, 'approval required');
});

test('upsertWorkerStatus preserves other workers and sorts ids for stable snapshots', () => {
  const repoDir = makeRepo();
  const file = 'reports/workflows/runtime/sample.json';
  fs.mkdirSync(path.join(repoDir, 'reports', 'workflows', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, file), JSON.stringify({
    workers: [{ id: 'zeta', status: 'idle' }],
  }));

  upsertWorkerStatus({ repoDir, file, id: 'alpha', status: 'running', now: '2026-05-31T14:00:00.000Z' });

  const snapshot = readJson(path.join(repoDir, file));
  assert.deepEqual(snapshot.workers.map((worker) => worker.id), ['alpha', 'zeta']);
});

test('resolveWorkerStatusPath rejects absolute paths and traversal outside the repo', () => {
  const repoDir = makeRepo();

  assert.throws(() => resolveWorkerStatusPath(repoDir, '/tmp/outside.json'), /repo-local relative path/);
  assert.throws(() => resolveWorkerStatusPath(repoDir, '../outside.json'), /outside repo/);
});
