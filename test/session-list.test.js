const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mergeSessionsFromSources,
  parseHermesSessionsList,
} = require('../lib/session-list');

test('parseHermesSessionsList parses hermes CLI table output', () => {
  const raw = `Title                            Preview                                  Last Active   ID
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
Parent Session                   hello world                              2h ago        parent_123`;

  assert.deepEqual(parseHermesSessionsList(raw), [
    {
      id: 'parent_123',
      title: 'Parent Session',
      preview: 'hello world',
      lastActive: '2h ago',
    },
  ]);
});

test('mergeSessionsFromSources keeps child sessions that the CLI omits', () => {
  const cliSessions = [
    {
      id: 'parent_123',
      title: 'Parent Session',
      preview: 'original preview',
      lastActive: '2h ago',
    },
  ];

  const dbSessions = [
    {
      id: 'child_456',
      title: 'Renamed child session',
      parent_session_id: 'parent_123',
      started_at: 1_710_000_100,
      ended_at: 1_710_000_400,
      message_count: 12,
      source: 'telegram',
    },
    {
      id: 'parent_123',
      title: 'Parent Session',
      parent_session_id: null,
      started_at: 1_709_999_000,
      ended_at: 1_710_000_000,
      message_count: 200,
      source: 'telegram',
    },
  ];

  const previewBySessionId = {
    child_456: 'renamed child preview',
    parent_123: 'latest parent preview',
  };

  const merged = mergeSessionsFromSources({
    cliSessions,
    dbSessions,
    previewBySessionId,
    nowMs: 1_710_000_500_000,
  });

  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], {
    id: 'child_456',
    title: 'Renamed child session',
    preview: 'renamed child preview',
    lastActive: '1m ago',
    messageCount: 12,
    parentSessionId: 'parent_123',
    source: 'telegram',
  });
  assert.deepEqual(merged[1], {
    id: 'parent_123',
    title: 'Parent Session',
    preview: 'latest parent preview',
    lastActive: '8m ago',
    messageCount: 200,
    parentSessionId: null,
    source: 'telegram',
  });
});
