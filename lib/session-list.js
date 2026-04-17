function normalizeText(value, fallback = '—') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function previewText(value) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text || '—';
}

function formatRelativeTime(epochSeconds, nowMs = Date.now()) {
  const tsMs = Number(epochSeconds || 0) * 1000;
  if (!Number.isFinite(tsMs) || tsMs <= 0) return '—';

  const diffMs = Math.max(0, nowMs - tsMs);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return 'just now';
  if (diffMs < hour) {
    const mins = Math.floor(diffMs / minute);
    return `${mins}m ago`;
  }
  if (diffMs < day) {
    const hours = Math.floor(diffMs / hour);
    return `${hours}h ago`;
  }
  if (diffMs < day * 2) return 'yesterday';
  const days = Math.floor(diffMs / day);
  return `${days}d ago`;
}

function parseHermesSessionsList(raw) {
  const lines = String(raw || '').split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  const dataLines = lines.filter((line) =>
    !/^Title\s+Preview\s+Last Active\s+ID$/i.test(line) &&
    !/^[─\-]+$/.test(line) &&
    !/^(Preview|Title|Last Active|Src)\s+(Preview|Title|Last Active|Src)/i.test(line)
  );

  return dataLines.map((line) => {
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length < 4) return null;
    const [title, preview, lastActive, id] = parts;
    return {
      id: String(id || '').trim(),
      title: normalizeText(title),
      preview: previewText(preview),
      lastActive: normalizeText(lastActive),
    };
  }).filter(Boolean);
}

function mergeSessionsFromSources({ cliSessions = [], dbSessions = [], previewBySessionId = {}, nowMs = Date.now() }) {
  const merged = new Map();

  for (const session of cliSessions) {
    if (!session?.id) continue;
    merged.set(session.id, {
      id: String(session.id),
      title: normalizeText(session.title),
      preview: previewText(session.preview),
      lastActive: normalizeText(session.lastActive),
      messageCount: Number(session.messageCount || 0),
      parentSessionId: session.parentSessionId || null,
      source: session.source || null,
      sortTimestamp: Number(session.sortTimestamp || 0),
    });
  }

  for (const row of dbSessions) {
    if (!row?.id) continue;
    const existing = merged.get(row.id) || {};
    const sortTimestamp = Number(row.ended_at || row.started_at || existing.sortTimestamp || 0);
    merged.set(row.id, {
      ...existing,
      id: String(row.id),
      title: normalizeText(row.title, existing.title || '—'),
      preview: previewText(previewBySessionId[row.id] || existing.preview),
      lastActive: sortTimestamp ? formatRelativeTime(sortTimestamp, nowMs) : normalizeText(existing.lastActive),
      messageCount: Number(row.message_count || existing.messageCount || 0),
      parentSessionId: row.parent_session_id || existing.parentSessionId || null,
      source: row.source || existing.source || null,
      sortTimestamp,
    });
  }

  return Array.from(merged.values())
    .sort((a, b) => {
      if (b.sortTimestamp !== a.sortTimestamp) return b.sortTimestamp - a.sortTimestamp;
      return String(b.id).localeCompare(String(a.id));
    })
    .map(({ sortTimestamp, ...session }) => session);
}

module.exports = {
  formatRelativeTime,
  mergeSessionsFromSources,
  parseHermesSessionsList,
};
