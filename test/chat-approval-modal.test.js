const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function extractFunction(source, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'm');
  const match = re.exec(source);
  assert.ok(match, `missing function ${name}`);
  let i = match.index + match[0].length - 1;
  let depth = 0;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

test('Approval Required modal is actionable with approve and deny controls', () => {
  const gatewaySource = read('src/js/chat/gateway.js');
  const modalSource = read('src/js/components/modal.js');
  const approval = extractFunction(gatewaySource, 'showApprovalModal');
  const showModal = extractFunction(modalSource, 'showModal');

  const approvalUsesModernButtons =
    /buttons\s*:\s*\[/.test(approval)
    && /approvalRespond\(\s*true\s*,\s*command\s*\)/.test(approval)
    && /approvalRespond\(\s*false\s*,\s*command\s*\)/.test(approval);

  const showModalSupportsLegacyApprovalApi =
    /body/.test(showModal)
    && /confirmText/.test(showModal)
    && /cancelText/.test(showModal)
    && /onConfirm/.test(showModal)
    && /onCancel/.test(showModal);

  assert.ok(
    approvalUsesModernButtons || showModalSupportsLegacyApprovalApi,
    'showApprovalModal currently passes body/confirmText/cancelText/onConfirm/onCancel; showModal must support that API or approval must use buttons[] with approve/deny actions',
  );
});

test('Approval Required modal includes command and description in its body', () => {
  const gatewaySource = read('src/js/chat/gateway.js');
  const approval = extractFunction(gatewaySource, 'showApprovalModal');

  assert.match(approval, /description/);
  assert.match(approval, /command/);
  assert.match(approval, /escapeHtml\(command\)/);
});
