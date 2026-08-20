/**
 * Model pricing in USD per million tokens. Static table ships with Harness; the daemon may
 * overlay ~/.harness/pricing.json (same shape) or a LiteLLM refresh. Unknown models → null cost
 * (tokens still shown). Sources: anthropic.com/pricing as of the table date.
 */
export interface Price {
  input: number;
  output: number;
  cacheWrite: number; // 5-minute cache write
  cacheWrite1h?: number;
  cacheRead: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  cacheRead: number;
}

export const PRICING_DATE = "2026-08-20";

/** Keys are matched as prefixes against the model id, longest match wins. */
export const PRICES: Record<string, Price> = {
  "claude-opus-4": { input: 15, output: 75, cacheWrite: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  "claude-opus-4-5": { input: 5, output: 25, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-sonnet-4": { input: 3, output: 15, cacheWrite: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cacheWrite: 1, cacheWrite1h: 1.6, cacheRead: 0.08 },
  // Claude 5 family (LiteLLM model_prices, 2026-08-20); overridable via ~/.harness/pricing.json
  "claude-opus-5": { input: 5, output: 25, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  "claude-fable-5": { input: 10, output: 50, cacheWrite: 12.5, cacheWrite1h: 20, cacheRead: 1 },
};

export function priceFor(model: string | null | undefined, table = PRICES): Price | null {
  if (!model) return null;
  const m = model.toLowerCase();
  let best: string | null = null;
  for (const k of Object.keys(table)) {
    if (m.startsWith(k) && (!best || k.length > best.length)) best = k;
  }
  return best ? (table[best] ?? null) : null;
}

export function costUsd(model: string | null | undefined, u: Usage, table = PRICES): number | null {
  const p = priceFor(model, table);
  if (!p) return null;
  const w5 = u.cacheWrite - (u.cacheWrite1h ?? 0);
  return (
    (u.input * p.input +
      u.output * p.output +
      w5 * p.cacheWrite +
      (u.cacheWrite1h ?? 0) * (p.cacheWrite1h ?? p.cacheWrite) +
      u.cacheRead * p.cacheRead) /
    1_000_000
  );
}

/** Convert a LiteLLM model_prices_and_context_window.json into our table (anthropic entries only). */
export function fromLiteLLM(json: Record<string, Record<string, unknown>>): Record<string, Price> {
  const out: Record<string, Price> = {};
  for (const [k, v] of Object.entries(json)) {
    if (!k.startsWith("claude-") || typeof v.input_cost_per_token !== "number") continue;
    const n = (x: unknown, fb: number) => (typeof x === "number" ? x * 1_000_000 : fb);
    const input = n(v.input_cost_per_token, 0);
    out[k] = {
      input,
      output: n(v.output_cost_per_token, 0),
      cacheWrite: n(v.cache_creation_input_token_cost, input * 1.25),
      cacheWrite1h: n(v.cache_creation_input_token_cost_above_1hr, input * 2),
      cacheRead: n(v.cache_read_input_token_cost, input * 0.1),
    };
  }
  return out;
}
