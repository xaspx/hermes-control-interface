const { spawnSync } = require('node:child_process');
const { upsertWorkerStatus } = require('./workflow-worker-status');

function currentTimestamp(now) {
  return typeof now === 'function' ? now() : (now || new Date().toISOString());
}

function statusForExit(result = {}) {
  if (result.signal) return 'stopped';
  if (result.status === 0) return 'idle';
  if (result.status === 130 || result.status === 143) return 'stopped';
  return 'error';
}

function noteForExit(result = {}) {
  if (result.signal) return `terminated by ${result.signal}`;
  return `exited ${Number.isInteger(result.status) ? result.status : 1}`;
}

function writeWorkerStatus(options, status, note) {
  const snapshot = upsertWorkerStatus({
    repoDir: options.repoDir,
    file: options.file,
    id: options.id,
    label: options.label,
    provider: options.provider,
    sessionId: options.sessionId,
    status,
    note,
    updatedAt: currentTimestamp(options.now),
  });
  if (typeof options.onStatus === 'function') options.onStatus(snapshot);
  return snapshot;
}

function runWorkerCommand(options) {
  if (!options || typeof options !== 'object') throw new Error('options are required');
  const command = String(options.command || '').trim();
  if (!command) throw new Error('command is required');

  writeWorkerStatus(options, 'generating', options.startNote || 'started');

  const runner = options.spawnSync || spawnSync;
  const result = runner(command, options.args || [], {
    cwd: options.cwd || options.repoDir || process.cwd(),
    env: options.env || process.env,
    stdio: options.stdio || 'inherit',
    shell: Boolean(options.shell),
  });

  if (result.error) {
    writeWorkerStatus(options, 'error', result.error.message || 'failed to launch');
    return { exitCode: 1, signal: result.signal || null, error: result.error };
  }

  const finalStatus = statusForExit(result);
  writeWorkerStatus(options, finalStatus, noteForExit(result));

  return {
    exitCode: Number.isInteger(result.status) ? result.status : (result.signal ? 143 : 1),
    signal: result.signal || null,
  };
}

module.exports = {
  runWorkerCommand,
  statusForExit,
};
