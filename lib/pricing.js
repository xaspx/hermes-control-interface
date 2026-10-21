// ── LLM Pricing (via @pydantic/genai-prices) ──
const { calcPrice } = require('@pydantic/genai-prices');

// Free models (no cost regardless of pricing data)
const FREE_MODELS = new Set([
  'xiaomi/mimo-v2-pro',
  'mimo-v2-pro',
]);

// Hermes billing_provider → genai-prices providerId mapping
const PROVIDER_MAP = {
  openrouter: 'openrouter',
  'openai-codex': 'openai',
  'opencode-go': 'openrouter', // minimax available via OpenRouter pricing
};

// Custom pricing for models not in genai-prices (per million tokens).
// MiniMax-M3 uses the standard <=512k baseline; the published long-context
// threshold has no exact integer expansion, so the fallback avoids guessing it.
const CUSTOM_PRICING = {
  'minimax-m2': { input_mtok: 0.30, output_mtok: 1.20, cache_read_mtok: 0.03 },
  'minimax-m2.7': { input_mtok: 0.30, output_mtok: 1.20, cache_read_mtok: 0.06 },
  'minimax-m3.1-flash': { input_mtok: 0.15, output_mtok: 0.60, cache_read_mtok: 0.015 },
  'minimax-m3': { input_mtok: 0.30, output_mtok: 1.20, cache_read_mtok: 0.06 },
};

// Calculate cost in USD from token counts
function calculateCost(model, inputTokens, outputTokens, cacheReadTokens = 0, billingProvider) {
  if (!model || FREE_MODELS.has(model)) return 0;

  // genai-prices expects input_tokens = total input (including cache)
  // Our DB stores input and cache separately, so combine them
  const usage = {
    input_tokens: inputTokens + cacheReadTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
  };

  // 1. Try with provider hint
  const providerId = PROVIDER_MAP[billingProvider];
  if (providerId) {
    try {
      const r = calcPrice(usage, model, { providerId });
      if (r) return r.total_price;
    } catch (_) { /* fallback to next */ }
  }

  // 2. Try without provider (match across all providers)
  try {
    const r = calcPrice(usage, model);
    if (r) return r.total_price;
  } catch (_) { /* fallback to custom pricing */ }

  // 3. Custom pricing fallback
  const custom = CUSTOM_PRICING[String(model).toLowerCase()];
  if (custom) {
    return (inputTokens / 1e6) * custom.input_mtok
      + (outputTokens / 1e6) * custom.output_mtok
      + (cacheReadTokens / 1e6) * (custom.cache_read_mtok || custom.input_mtok * 0.1);
  }

  return 0;
}

module.exports = { calculateCost };
