const fs = require('fs');
const path = require('path');
const { normalizeWorkerStatus } = require('./workflows');

function normalizeString(value) {
  return String(value || '').trim();
}

function resolveWorkerStatusPath(repoDir, file) {
  const resolvedRepoDir = path.resolve(repoDir || process.cwd());
  const rawFile = normalizeString(file);
  if (!rawFile || path.isAbsolute(rawFile)) {
    throw new Error('worker status file must be a repo-local relative path');
  }
  const resolvedPath = path.resolve(resolvedRepoDir, rawFile);
  const relative = path.relative(resolvedRepoDir, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('worker status file resolves outside repo');
  }
  return resolvedPath;
}

function readSnapshot(snapshotPath) {
  try {
    const raw = fs.readFileSync(snapshotPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { workers: parsed };
    if (parsed && typeof parsed === 'object') {
      return { ...parsed, workers: Array.isArray(parsed.workers) ? parsed.workers : [] };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { workers: [] };
}

function buildWorkerPatch({ id, label, provider, status, sessionId, updatedAt, now, note }) {
  const workerId = normalizeString(id);
  if (!workerId) throw new Error('worker id is required');

  const patch = {
    id: workerId,
    status: normalizeWorkerStatus(status),
    updated_at: normalizeString(updatedAt || now || new Date().toISOString()),
  };
  const normalizedLabel = normalizeString(label);
  const normalizedProvider = normalizeString(provider);
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedNote = normalizeString(note);
  if (normalizedLabel) patch.label = normalizedLabel;
  if (normalizedProvider) patch.provider = normalizedProvider;
  if (normalizedSessionId) patch.session_id = normalizedSessionId;
  if (normalizedNote) patch.note = normalizedNote;
  return patch;
}

function writeSnapshotAtomic(snapshotPath, snapshot) {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  const tmpPath = `${snapshotPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  fs.renameSync(tmpPath, snapshotPath);
}

function upsertWorkerStatus(options) {
  const snapshotPath = resolveWorkerStatusPath(options.repoDir, options.file);
  const snapshot = readSnapshot(snapshotPath);
  const patch = buildWorkerPatch(options);
  const workers = new Map();

  for (const worker of snapshot.workers) {
    if (worker && typeof worker === 'object' && normalizeString(worker.id)) {
      workers.set(normalizeString(worker.id), { ...worker });
    }
  }

  workers.set(patch.id, {
    ...(workers.get(patch.id) || {}),
    ...patch,
  });

  const nextSnapshot = {
    ...snapshot,
    updated_at: patch.updated_at,
    workers: Array.from(workers.values()).sort((a, b) => String(a.id).localeCompare(String(b.id))),
  };
  writeSnapshotAtomic(snapshotPath, nextSnapshot);
  return nextSnapshot;
}

module.exports = {
  resolveWorkerStatusPath,
  upsertWorkerStatus,
};
