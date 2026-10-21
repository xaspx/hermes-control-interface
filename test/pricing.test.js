const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadPricing(calcPrice) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === '@pydantic/genai-prices') return { calcPrice };
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve('../lib/pricing')];
    return require('../lib/pricing');
  } finally {
    Module._load = originalLoad;
  }
}

test('MiniMax M3.1 Flash fallback uses the documented direct rates and provider hint', () => {
  const calls = [];
  const { calculateCost } = loadPricing((usage, model, options) => {
    calls.push({ usage, model, options });
    return null;
  });

  assert.equal(
    calculateCost('MiniMax-M3.1-Flash', 1_000_000, 1_000_000, 1_000_000, 'opencode-go'),
    0.765
  );
  assert.deepEqual(calls, [
    {
      usage: { input_tokens: 2_000_000, output_tokens: 1_000_000, cache_read_tokens: 1_000_000 },
      model: 'MiniMax-M3.1-Flash',
      options: { providerId: 'openrouter' },
    },
    {
      usage: { input_tokens: 2_000_000, output_tokens: 1_000_000, cache_read_tokens: 1_000_000 },
      model: 'MiniMax-M3.1-Flash',
      options: undefined,
    },
  ]);
});

test('MiniMax M3 fallback stays on the documented standard baseline', () => {
  const { calculateCost } = loadPricing(() => null);

  assert.equal(calculateCost('minimax-m3', 1_000_000, 1_000_000, 1_000_000), 1.56);
});

test('SDK pricing remains authoritative and legacy/free/unknown behavior is preserved', () => {
  const { calculateCost: calculateWithSdk } = loadPricing(() => ({ total_price: 7.25 }));
  assert.equal(calculateWithSdk('minimax-m3.1-flash', 1_000_000, 1_000_000), 7.25);

  const { calculateCost: calculateWithFallback } = loadPricing(() => null);
  assert.equal(calculateWithFallback('mimo-v2-pro', 1_000_000, 1_000_000), 0);
  assert.equal(calculateWithFallback('custom/saved-model', 1_000_000, 1_000_000), 0);
});
