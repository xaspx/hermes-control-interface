const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildWorkflowIndex,
  getWorkflowDetail,
  normalizeWorkerStatus,
} = require('../lib/workflows');

function makeRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hci-workflows-'));
  fs.mkdirSync(path.join(repoDir, 'docs', 'workflows', 'definitions'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'docs', 'workflows', 'runbooks'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'reports', 'workflows'), { recursive: true });
  return repoDir;
}

test('buildWorkflowIndex reads MiraRepo workflow definitions and links cron/runbook/report', () => {
  const repoDir = makeRepo();
  fs.writeFileSync(path.join(repoDir, 'docs', 'workflows', 'definitions', 'weekly-memory-refactor.yaml'), `id: weekly-memory-refactor
name: Weekly Memory Refactor
business_goal: Keep memory concise
schedule:
  human_readable: Weekly Monday 06:30 JST
risk:
  level: low
execution:
  hermes_cron_job_id: d27468bad831
links:
  runbook: docs/workflows/runbooks/weekly-memory-refactor.md
`);
  fs.writeFileSync(path.join(repoDir, 'docs', 'workflows', 'runbooks', 'weekly-memory-refactor.md'), '# Runbook\n');
  fs.writeFileSync(path.join(repoDir, 'reports', 'workflows', 'weekly-memory-refactor-report.md'), '# Report\n');

  const index = buildWorkflowIndex({
    repoDir,
    cronJobs: [{
      id: 'd27468bad831',
      name: 'weekly-memory-refactor',
      status: 'active',
      schedule: '0 6 * * 1',
      deliver: 'local',
    }],
  });

  assert.equal(index.summary.total, 1);
  assert.equal(index.summary.ok, 1);
  assert.equal(index.workflows[0].id, 'weekly-memory-refactor');
  assert.equal(index.workflows[0].cron.id, 'd27468bad831');
  assert.equal(index.workflows[0].runbookPath, 'docs/workflows/runbooks/weekly-memory-refactor.md');
  assert.equal(index.workflows[0].latestReportPath, 'reports/workflows/weekly-memory-refactor-report.md');
});

test('getWorkflowDetail exposes raw definition and runbook without mutating files', () => {
  const repoDir = makeRepo();
  fs.writeFileSync(path.join(repoDir, 'docs', 'workflows', 'definitions', 'sample.yaml'), 'id: sample\nname: Sample\n');
  fs.writeFileSync(path.join(repoDir, 'docs', 'workflows', 'runbooks', 'sample.md'), '# Sample Runbook\n');

  const detail = getWorkflowDetail({ repoDir, id: 'sample', cronJobs: [] });

  assert.equal(detail.id, 'sample');
  assert.match(detail.definitionRaw, /id: sample/);
  assert.match(detail.runbookRaw, /Sample Runbook/);
  assert.equal(detail.status, 'missing_cron');
});

test('local delivery with an origin delivery error is classified as stale warning', () => {
  const repoDir = makeRepo();
  fs.writeFileSync(path.join(repoDir, 'docs', 'workflows', 'definitions', 'delivery.yaml'), 'id: delivery\nname: Delivery\n');
  fs.writeFileSync(path.join(repoDir, 'docs', 'workflows', 'runbooks', 'delivery.md'), '# Delivery\n');

  const index = buildWorkflowIndex({
    repoDir,
    cronJobs: [{
      id: 'delivery-job',
      name: 'delivery',
      status: 'active',
      deliver: 'local',
      lastDeliveryError: 'deliver=origin failed for old thread',
    }],
  });

  assert.equal(index.workflows[0].status, 'stale_warning');
});

test('normalizeWorkerStatus maps ADHDev-style worker states to the HCI status vocabulary', () => {
  assert.equal(normalizeWorkerStatus('waiting_approval'), 'waiting_approval');
  assert.equal(normalizeWorkerStatus('generating'), 'generating');
  assert.equal(normalizeWorkerStatus('running'), 'generating');
  assert.equal(normalizeWorkerStatus('complete'), 'idle');
  assert.equal(normalizeWorkerStatus('blocked'), 'waiting_approval');
  assert.equal(normalizeWorkerStatus('crashed'), 'error');
  assert.equal(normalizeWorkerStatus(''), 'unknown');
});

test('buildWorkflowIndex exposes normalized worker session status and summary counts', () => {
  const repoDir = makeRepo();
  fs.writeFileSync(path.join(repoDir, 'docs', 'workflows', 'definitions', 'workers.yaml'), `id: workers
name: Worker Status
execution:
  workers:
    - id: codex-lane
      label: Codex Lane
      provider: codex
      status: running
      session_id: codex-session-1
      updated_at: 2026-05-31T13:20:00+09:00
    - id: claude-review
      provider: claude
      status: waiting_approval
`);
  fs.writeFileSync(path.join(repoDir, 'docs', 'workflows', 'runbooks', 'workers.md'), '# Workers\n');

  const index = buildWorkflowIndex({ repoDir, cronJobs: [{ id: 'workers', name: 'workers', status: 'active' }] });

  assert.deepEqual(index.summary.workers, {
    total: 2,
    starting: 0,
    generating: 1,
    waiting_approval: 1,
    idle: 0,
    error: 0,
    stopped: 0,
    unknown: 0,
  });
  assert.equal(index.workflows[0].workers[0].id, 'codex-lane');
  assert.equal(index.workflows[0].workers[0].label, 'Codex Lane');
  assert.equal(index.workflows[0].workers[0].provider, 'codex');
  assert.equal(index.workflows[0].workers[0].status, 'generating');
  assert.equal(index.workflows[0].workers[0].sessionId, 'codex-session-1');
  assert.equal(index.workflows[0].workers[1].status, 'waiting_approval');
});
