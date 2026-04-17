const test = require('node:test');
const assert = require('node:assert/strict');

async function loadUtils() {
  return import('../src/js/chat-render-utils.mjs');
}

test('toDisplayText preserves strings', async () => {
  const { toDisplayText } = await loadUtils();
  assert.equal(toDisplayText('hello'), 'hello');
});

test('toDisplayText returns empty string for nullish values', async () => {
  const { toDisplayText } = await loadUtils();
  assert.equal(toDisplayText(null), '');
  assert.equal(toDisplayText(undefined), '');
});

test('toDisplayText stringifies plain objects for safe rendering', async () => {
  const { toDisplayText } = await loadUtils();
  assert.equal(
    toDisplayText({ total: 3, pending: 2 }),
    '{\n  "total": 3,\n  "pending": 2\n}'
  );
});

test('toDisplayText stringifies arrays for safe rendering', async () => {
  const { toDisplayText } = await loadUtils();
  assert.equal(toDisplayText(['a', 1]), '[\n  "a",\n  1\n]');
});

test('toDisplayText preserves falsy primitives', async () => {
  const { toDisplayText } = await loadUtils();
  assert.equal(toDisplayText(0), '0');
  assert.equal(toDisplayText(false), 'false');
});

test('toDisplayText falls back to String when JSON serialization returns undefined', async () => {
  const { toDisplayText } = await loadUtils();
  assert.equal(toDisplayText(Symbol('x')), 'Symbol(x)');
});

test('toDisplayText falls back to String when JSON.stringify throws', async () => {
  const { toDisplayText } = await loadUtils();
  const circular = {};
  circular.self = circular;
  assert.equal(toDisplayText(circular), '[object Object]');
});
