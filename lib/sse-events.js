/**
 * SSE Event Normalizer
 * Standardizes event formats from both SSE endpoints and WebSocket messages
 * into a consistent internal format for the HCI chat UI.
 *
 * Sources:
 * - WebSocket: `ws://host/ws` → JSON messages from ws-client.js
 * - SSE (CLI): `/api/chat/send` → `data: {type, content, sessionId}`
 * - SSE (Gateway): `/api/gateway/responses` → raw gateway events
 */

export const SSE_EVENT_TYPES = {
  // Stream lifecycle
  THINKING:     'chat.thinking',
  REASONING:    'chat.reasoning',
  MESSAGE_START: 'chat.start',
  TEXT_DELTA:   'chat.text',
  DONE:         'chat.done',
  ERROR:        'chat.error',

  // Tool calls
  TOOL_GENERATING: 'chat.tool.generating',
  TOOL_START:      'chat.tool.start',
  TOOL_PROGRESS:   'chat.tool.progress',
  TOOL_DONE:       'chat.tool.done',

  // Interaction
  CLARIFY:   'chat.clarify',
  APPROVAL:  'chat.approval',
  SUDO:      'chat.sudo',
  SECRET:    'chat.secret',

  // Session
  SESSION:  'chat.session',

  // Subagents
  SUBAGENT_START:    'chat.subagent.start',
  SUBAGENT_PROGRESS: 'chat.subagent.progress',
  SUBAGENT_COMPLETE: 'chat.subagent.complete',

  // TUI
  TUI_READY:  'tui.ready',
  TUI_STDERR: 'tui.stderr',
  TUI_ERROR:  'tui.error',
};

// Internal event types (what handlers expect)
export const INTERNAL_TYPES = {
  THINKING:     'thinking',
  REASONING:    'reasoning',
  MESSAGE_START: 'message_start',
  TEXT_DELTA:   'text_delta',
  DONE:         'done',
  ERROR:        'error',
  TOOL_GENERATING: 'tool_generating',
  TOOL_START:      'tool_start',
  TOOL_PROGRESS:   'tool_progress',
  TOOL_DONE:       'tool_done',
  CLARIFY:   'clarify',
  APPROVAL:  'approval',
  SUDO:      'sudo',
  SECRET:    'secret',
  SESSION:   'session',
  SUBAGENT_START:    'subagent_start',
  SUBAGENT_PROGRESS: 'subagent_progress',
  SUBAGENT_COMPLETE: 'subagent_complete',
};

/**
 * Parse raw SSE line(s) into event objects.
 * Handles both single-line and multi-line SSE data.
 */
export function parseSSEData(raw) {
  const events = [];
  const lines = raw.split('\n');
  let eventType = null;
  let eventData = '';

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const raw = line.slice(6).trim();
      try {
        const parsed = JSON.parse(raw);
        events.push(parsed);
      } catch {
        // Not JSON — plain text event
        events.push({ type: 'token', content: raw });
      }
    }
  }
  return events;
}

/**
 * Normalize a raw SSE event from /api/chat/send or /api/gateway/responses
 * into a unified internal event object.
 *
 * @param {object} raw - Parsed SSE event object
 * @returns {object} - Normalized event
 */
export function normalizeSSEEvent(raw) {
  const { type, ...rest } = raw;
  switch (type) {
    case 'token':
      // CLI SSE: text token
      return { internalType: INTERNAL_TYPES.TEXT_DELTA, delta: rest.content || '' };

    case 'thinking':
      return { internalType: INTERNAL_TYPES.THINKING, delta: rest.delta || rest.content || '' };

    case 'reasoning':
      return { internalType: INTERNAL_TYPES.REASONING, delta: rest.delta || rest.content || '' };

    case 'message.started':
    case 'run.started':
      return { internalType: INTERNAL_TYPES.MESSAGE_START };

    case 'assistant.delta':
    case 'text_delta':
      return { internalType: INTERNAL_TYPES.TEXT_DELTA, delta: rest.delta || rest.content || rest.text || '' };

    case 'assistant.completed':
    case 'run.completed':
      return { internalType: INTERNAL_TYPES.DONE, content: rest.content || '' };

    case 'done':
      return {
        internalType: INTERNAL_TYPES.DONE,
        sessionId: rest.sessionId || rest.session_id || '',
        elapsed: rest.elapsed,
      };

    case 'error':
      return { internalType: INTERNAL_TYPES.ERROR, error: rest.content || rest.error || '' };

    // Tool events (gateway format)
    case 'tool.pending':
    case 'tool.started':
      return {
        internalType: INTERNAL_TYPES.TOOL_START,
        toolId: rest.tool_id || rest.id || makeId(),
        name: rest.name || rest.tool_name || 'tool',
        context: rest.context || rest.args || {},
      };

    case 'tool.running':
    case 'tool.progress':
      return {
        internalType: INTERNAL_TYPES.TOOL_PROGRESS,
        name: rest.name || rest.tool_name || 'tool',
        preview: rest.preview || rest.progress || '',
      };

    case 'tool.completed':
    case 'tool.done':
      return {
        internalType: INTERNAL_TYPES.TOOL_DONE,
        toolId: rest.tool_id || rest.id || makeId(),
        name: rest.name || rest.tool_name || 'tool',
        summary: rest.summary || rest.result || '',
        error: rest.error || null,
        inlineDiff: rest.inline_diff || null,
      };

    case 'tool.failed':
    case 'tool.error':
      return {
        internalType: INTERNAL_TYPES.TOOL_DONE,
        toolId: rest.tool_id || rest.id || makeId(),
        name: rest.name || rest.tool_name || 'tool',
        error: rest.error || rest.message || 'Tool failed',
      };

    // Artifact
    case 'artifact.created':
      return { internalType: 'artifact', ...rest };

    // Interaction (pass-through from gateway)
    case 'chat.clarify':
    case 'clarify':
      return { internalType: INTERNAL_TYPES.CLARIFY, ...rest };

    case 'chat.approval':
    case 'approval':
      return { internalType: INTERNAL_TYPES.APPROVAL, ...rest };

    default:
      // Pass through unknown events as-is for future extensibility
      return { internalType: 'unknown', raw };
  }
}

/**
 * Map WebSocket message type to internal handler type.
 * WebSocket uses different type strings than normalized SSE.
 */
export function mapWsType(wsType) {
  const map = {
    'chat.thinking':          INTERNAL_TYPES.THINKING,
    'chat.reasoning':         INTERNAL_TYPES.REASONING,
    'chat.start':             INTERNAL_TYPES.MESSAGE_START,
    'chat.text':              INTERNAL_TYPES.TEXT_DELTA,
    'chat.done':              INTERNAL_TYPES.DONE,
    'chat.error':             INTERNAL_TYPES.ERROR,
    'chat.tool.generating':   INTERNAL_TYPES.TOOL_GENERATING,
    'chat.tool.start':        INTERNAL_TYPES.TOOL_START,
    'chat.tool.progress':     INTERNAL_TYPES.TOOL_PROGRESS,
    'chat.tool.done':         INTERNAL_TYPES.TOOL_DONE,
    'chat.clarify':           INTERNAL_TYPES.CLARIFY,
    'chat.approval':          INTERNAL_TYPES.APPROVAL,
    'chat.sudo':              INTERNAL_TYPES.SUDO,
    'chat.secret':            INTERNAL_TYPES.SECRET,
    'chat.session':           INTERNAL_TYPES.SESSION,
    'chat.subagent.start':    INTERNAL_TYPES.SUBAGENT_START,
    'chat.subagent.progress': INTERNAL_TYPES.SUBAGENT_PROGRESS,
    'chat.subagent.complete': INTERNAL_TYPES.SUBAGENT_COMPLETE,
  };
  return map[wsType] || wsType;
}

function makeId() {
  return 'tool-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
