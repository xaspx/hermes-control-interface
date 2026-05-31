#!/usr/bin/env node
const { runWorkerCommand } = require('../lib/workflow-worker-runner');

function usage() {
  return `Usage: node scripts/workflow-worker-run.js --repo <repo> --file <relative-json> --id <worker-id> --provider <provider> -- <command> [args...]

Options:
  --label <label>             Human label shown in HCI
  --provider <provider>       codex | claude | hermes | other
  --session-id <id>           Provider/session id
  --cwd <dir>                 Working directory for command (defaults to repo)
  --start-note <text>         Note written with generating status

Examples:
  node scripts/workflow-worker-run.js \
    --repo ~/repos/MiraRepo \
    --file reports/workflows/runtime/mira-hci.json \
    --id codex-lane-1 \
    --label "Codex Lane 1" \
    --provider codex \
    -- codex --ask-for-approval on-request "Implement issue #123"

  node scripts/workflow-worker-run.js \
    --repo ~/repos/MiraRepo \
    --file reports/workflows/runtime/mira-hci.json \
    --id hermes-lane \
    --provider hermes \
    -- hermes -p default "Run the workflow"
`;
}

function parseArgs(argv) {
  const separatorIndex = argv.indexOf('--');
  const optionTokens = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
  const commandTokens = separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1);
  const args = {};

  for (let index = 0; index < optionTokens.length; index += 1) {
    const item = optionTokens[index];
    if (item === '--help' || item === '-h') {
      args.help = true;
      continue;
    }
    if (!item.startsWith('--')) throw new Error(`unexpected argument: ${item}`);
    const key = item.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = optionTokens[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${item}`);
    args[key] = value;
    index += 1;
  }

  args.command = commandTokens[0];
  args.commandArgs = commandTokens.slice(1);
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
  if (!args.command) throw new Error('command is required after --');

  const result = runWorkerCommand({
    repoDir: expandHome(args.repo),
    file: args.file,
    id: args.id,
    label: args.label,
    provider: args.provider || args.statusProvider,
    sessionId: args.sessionId,
    cwd: expandHome(args.cwd),
    startNote: args.startNote,
    command: args.command,
    args: args.commandArgs,
  });

  return result.exitCode;
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
