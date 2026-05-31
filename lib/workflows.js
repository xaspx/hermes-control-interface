const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const DEFAULT_REPO_CANDIDATES = [
  path.join(os.homedir(), 'worktrees', 'MiraRepo_runtime_main'),
  path.join(os.homedir(), 'repos', 'MiraRepo'),
];

function resolveMiraRepoDir(explicitDir = process.env.MIRA_REPO_DIR) {
  const candidates = [explicitDir, ...DEFAULT_REPO_CANDIDATES].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(path.join(resolved, 'docs', 'workflows'))) return resolved;
  }
  return path.resolve(candidates[0] || DEFAULT_REPO_CANDIDATES[0]);
}

function toPosixRelative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function listFiles(dir, predicate = () => true) {
  try {
    return fs.readdirSync(dir)
      .map((name) => path.join(dir, name))
      .filter((filePath) => {
        try { return fs.statSync(filePath).isFile() && predicate(filePath); }
        catch { return false; }
      })
      .sort();
  } catch {
    return [];
  }
}

function readYamlFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = yaml.load(raw) || {};
  return { raw, data };
}

function getNested(obj, pathParts) {
  let current = obj;
  for (const part of pathParts) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeKey(value) {
  return normalizeString(value).toLowerCase();
}

function pickWorkflowId(filePath, definition) {
  return normalizeString(definition.id) || path.basename(filePath).replace(/\.(ya?ml)$/i, '');
}

function findRunbook(repoDir, id, definition) {
  const linkedRunbook = getNested(definition, ['links', 'runbook']);
  const candidates = [
    linkedRunbook && path.resolve(repoDir, linkedRunbook),
    path.join(repoDir, 'docs', 'workflows', 'runbooks', `${id}.md`),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.startsWith(repoDir) && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function findLatestReport(repoDir, id) {
  const reportsDir = path.join(repoDir, 'reports', 'workflows');
  const reports = listFiles(reportsDir, (filePath) => /\.(md|txt|json|ya?ml)$/i.test(filePath))
    .map((filePath) => {
      let stat;
      try { stat = fs.statSync(filePath); } catch { return null; }
      const base = path.basename(filePath).toLowerCase();
      const score = base.includes(normalizeKey(id)) ? 2 : 0;
      return { filePath, mtimeMs: stat.mtimeMs, score };
    })
    .filter(Boolean)
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs);
  return reports[0]?.filePath || null;
}

function findCronJob(definition, id, cronJobs = []) {
  const explicitIds = [
    getNested(definition, ['execution', 'hermes_cron_job_id']),
    getNested(definition, ['execution', 'cron_job_id']),
    definition.hermes_cron_job_id,
    definition.cron_job_id,
  ].map(normalizeKey).filter(Boolean);

  const names = [id, definition.name].map(normalizeKey).filter(Boolean);

  return cronJobs.find((job) => explicitIds.includes(normalizeKey(job.id)))
    || cronJobs.find((job) => names.includes(normalizeKey(job.name)) || names.includes(normalizeKey(job.id)))
    || cronJobs.find((job) => names.some((name) => normalizeKey(job.name).includes(name)))
    || null;
}

function classifyWorkflow({ runbookPath, cron }) {
  const warnings = [];
  const deliver = normalizeKey(cron?.deliver);
  const lastDeliveryError = normalizeString(cron?.lastDeliveryError || cron?.deliveryError);
  const lastStatus = normalizeKey(cron?.lastStatus);
  const cronStatus = normalizeKey(cron?.status);

  if (lastDeliveryError) {
    if (deliver === 'local' && /deliver=origin|origin/i.test(lastDeliveryError)) {
      warnings.push('last_delivery_error appears stale because current delivery is local');
    } else {
      return { status: 'active_failure', warnings: [lastDeliveryError] };
    }
  }

  if (['failed', 'failure', 'error'].includes(lastStatus) || ['failed', 'failure', 'error'].includes(cronStatus)) {
    return { status: 'active_failure', warnings: [`cron status indicates ${lastStatus || cronStatus}`] };
  }

  if (warnings.length) return { status: 'stale_warning', warnings };
  if (!runbookPath) return { status: 'missing_runbook', warnings: ['runbook is missing'] };
  if (!cron) return { status: 'missing_cron', warnings: ['cron job is not linked'] };
  return { status: 'ok', warnings };
}

const WORKER_STATUS_KEYS = ['starting', 'generating', 'waiting_approval', 'idle', 'error', 'stopped', 'unknown'];

function normalizeWorkerStatus(status) {
  const value = normalizeKey(status).replace(/[\s-]+/g, '_');
  if (['starting', 'booting', 'queued'].includes(value)) return 'starting';
  if (['generating', 'running', 'busy', 'in_progress', 'working'].includes(value)) return 'generating';
  if (['waiting_approval', 'approval_required', 'blocked', 'paused_for_approval'].includes(value)) return 'waiting_approval';
  if (['idle', 'ready', 'complete', 'completed', 'done', 'success', 'ok'].includes(value)) return 'idle';
  if (['error', 'failed', 'failure', 'crashed', 'timeout'].includes(value)) return 'error';
  if (['stopped', 'cancelled', 'canceled', 'killed', 'terminated'].includes(value)) return 'stopped';
  return 'unknown';
}

function normalizeWorkers(definition) {
  const rawWorkers = getNested(definition, ['execution', 'workers']) || definition.workers || [];
  if (!Array.isArray(rawWorkers)) return [];
  return rawWorkers
    .filter((worker) => worker && typeof worker === 'object')
    .map((worker, index) => ({
      id: normalizeString(worker.id || worker.name || `worker-${index + 1}`),
      label: normalizeString(worker.label || worker.title || worker.name || worker.id || `Worker ${index + 1}`),
      provider: normalizeString(worker.provider || worker.type || worker.agent || 'unknown'),
      status: normalizeWorkerStatus(worker.status || worker.state),
      sessionId: normalizeString(worker.session_id || worker.sessionId || worker.providerSessionId),
      updatedAt: normalizeString(worker.updated_at || worker.updatedAt || worker.last_seen_at || worker.lastSeenAt),
      note: normalizeString(worker.note || worker.message || worker.reason),
    }));
}

function emptyWorkerSummary() {
  return WORKER_STATUS_KEYS.reduce((summary, status) => {
    summary[status] = 0;
    return summary;
  }, { total: 0 });
}

function summarizeWorkers(workflows) {
  const summary = emptyWorkerSummary();
  for (const workflow of workflows) {
    for (const worker of workflow.workers || []) {
      summary.total += 1;
      const status = WORKER_STATUS_KEYS.includes(worker.status) ? worker.status : 'unknown';
      summary[status] += 1;
    }
  }
  return summary;
}

function workflowSummary(workflows) {
  const summary = {
    total: workflows.length,
    ok: 0,
    active_failure: 0,
    stale_warning: 0,
    missing_runbook: 0,
    missing_cron: 0,
    unknown: 0,
    workers: emptyWorkerSummary(),
  };
  for (const workflow of workflows) {
    const key = workflow.status || 'unknown';
    summary[key] = (summary[key] || 0) + 1;
  }
  summary.workers = summarizeWorkers(workflows);
  return summary;
}

function buildWorkflowIndex({ repoDir = resolveMiraRepoDir(), cronJobs = [] } = {}) {
  const resolvedRepoDir = path.resolve(repoDir);
  const definitionsDir = path.join(resolvedRepoDir, 'docs', 'workflows', 'definitions');
  const definitionFiles = listFiles(definitionsDir, (filePath) => /\.ya?ml$/i.test(filePath));

  const workflows = definitionFiles.map((definitionPath) => {
    let parsed;
    try {
      parsed = readYamlFile(definitionPath);
    } catch (error) {
      const id = path.basename(definitionPath).replace(/\.(ya?ml)$/i, '');
      return {
        id,
        name: id,
        definitionPath: toPosixRelative(resolvedRepoDir, definitionPath),
        runbookPath: null,
        latestReportPath: null,
        cron: null,
        status: 'active_failure',
        warnings: [`definition parse failed: ${error.message}`],
      };
    }

    const definition = parsed.data;
    const id = pickWorkflowId(definitionPath, definition);
    const runbookPath = findRunbook(resolvedRepoDir, id, definition);
    const latestReportPath = findLatestReport(resolvedRepoDir, id);
    const cron = findCronJob(definition, id, cronJobs);
    const health = classifyWorkflow({ runbookPath, cron });
    const workers = normalizeWorkers(definition);

    return {
      id,
      name: normalizeString(definition.name) || id,
      businessGoal: normalizeString(definition.business_goal || definition.businessGoal),
      schedule: getNested(definition, ['schedule', 'human_readable'])
        || getNested(definition, ['schedule', 'expression'])
        || normalizeString(cron?.schedule),
      riskLevel: getNested(definition, ['risk', 'level']) || definition.risk_level || 'unknown',
      definitionPath: toPosixRelative(resolvedRepoDir, definitionPath),
      runbookPath: runbookPath ? toPosixRelative(resolvedRepoDir, runbookPath) : null,
      latestReportPath: latestReportPath ? toPosixRelative(resolvedRepoDir, latestReportPath) : null,
      cron: cron ? {
        id: cron.id,
        name: cron.name,
        status: cron.status,
        schedule: cron.schedule,
        nextRun: cron.nextRun,
        lastRun: cron.lastRun,
        lastStatus: cron.lastStatus,
        deliver: cron.deliver,
        lastDeliveryError: cron.lastDeliveryError,
      } : null,
      workers,
      status: health.status,
      warnings: health.warnings,
    };
  });

  workflows.sort((a, b) => a.id.localeCompare(b.id));
  return {
    repoDir: resolvedRepoDir,
    workflows,
    summary: workflowSummary(workflows),
  };
}

function getWorkflowDetail({ repoDir = resolveMiraRepoDir(), id, cronJobs = [] } = {}) {
  const index = buildWorkflowIndex({ repoDir, cronJobs });
  const workflow = index.workflows.find((item) => item.id === id);
  if (!workflow) return null;
  const definitionAbs = path.resolve(index.repoDir, workflow.definitionPath);
  const runbookAbs = workflow.runbookPath ? path.resolve(index.repoDir, workflow.runbookPath) : null;
  const reportAbs = workflow.latestReportPath ? path.resolve(index.repoDir, workflow.latestReportPath) : null;

  return {
    ...workflow,
    repoDir: index.repoDir,
    definitionRaw: fs.existsSync(definitionAbs) ? fs.readFileSync(definitionAbs, 'utf8') : '',
    runbookRaw: runbookAbs && fs.existsSync(runbookAbs) ? fs.readFileSync(runbookAbs, 'utf8') : '',
    latestReportRaw: reportAbs && fs.existsSync(reportAbs) ? fs.readFileSync(reportAbs, 'utf8').slice(0, 12000) : '',
  };
}

module.exports = {
  buildWorkflowIndex,
  classifyWorkflow,
  findCronJob,
  getWorkflowDetail,
  normalizeWorkerStatus,
  normalizeWorkers,
  resolveMiraRepoDir,
  summarizeWorkers,
};
