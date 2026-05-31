#!/usr/bin/env node
const { upsertWorkerStatus } = require('../lib/workflow-worker-status');

function usage() {
  return `Usage: node scripts/workflow-worker-status.js --repo <repo> --file <relative-json> --id <worker-id> --status <status> [options]

Options:
  --label <label>          Human label shown in HCI
  --provider <provider>    codex | claude | hermes | other
  --session-id <id>        Provider/session id
  --note <text>            Short status note
  --updated-at <iso>       Override timestamp

Example:
  node scripts/workflow-worker-status.js \\
    --repo ~/repos/MiraRepo \\
    --file reports/workflows/runtime/mira-hci.json \\
    --id codex-lane-1 \\
    --label "Codex Lane 1" \\
    --provider codex \\
    --status running \\
    --session-id codex-abc123
`;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--help' || item === '-h') {
      args.help = true;
      continue;
    }
    if (!item.startsWith('--')) {
      throw new Error(`unexpected argument: ${item}`);
    }
    const key = item.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`missing value for ${item}`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function expandHome(value) {
  if (!value || !value.startsWith('~/')) return value;
  return `${process.env.HOME || ''}/${value.slice(2)}`;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }

  const snapshot = upsertWorkerStatus({
    repoDir: expandHome(args.repo),
    file: args.file,
    id: args.id,
    label: args.label,
    provider: args.provider,
    status: args.status,
    sessionId: args.sessionId,
    updatedAt: args.updatedAt,
    note: args.note,
  });

  process.stdout.write(`${JSON.stringify({ ok: true, total: snapshot.workers.length, worker: args.id }, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}`);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs };
