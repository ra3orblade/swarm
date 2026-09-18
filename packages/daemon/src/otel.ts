/**
 * M12.1 OTLP exporter: every `[otel] interval` seconds, what happened since the last successful
 * export goes to `[otel] endpoint` as OTLP/HTTP JSON (`/v1/traces`, `/v1/metrics`). Off unless an
 * endpoint is set. Two cursors in `meta` — event seq for spans, turn rowid for metrics — each moved
 * only after its POST is accepted, so a collector that is down loses nothing, and span ids are
 * derived from the session, so a retried batch lands on the same spans instead of duplicating.
 */
import { buildMetrics, buildTraces, type OtelOptions } from "@swarm/core";
import type { Store } from "./store";

const MAX_BACKOFF_MS = 300_000;

export class OtelExporter {
  private lastTry = 0;
  private backoffMs = 0;
  private busy = false;
  private sent = { spans: 0, points: 0 };
  private lastError: string | null = null;
  private lastOkAt: string | null = null;

  constructor(
    private store: Store,
    private version: string,
    private post: typeof fetch = fetch,
  ) {}

  status() {
    const o = this.store.policyFor(null).config.otel;
    return {
      configured: o.endpoint != null,
      endpoint: o.endpoint,
      compat: o.compat,
      includeContent: o.include_content,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      sent: this.sent,
    };
  }

  /** Called from the daemon tick; paced by `[otel] interval` and backoff. Never throws. */
  async tick(now = Date.now()): Promise<boolean> {
    const cfg = this.store.policyFor(null).config.otel;
    if (!cfg.endpoint || this.busy) return false;
    if (now - this.lastTry < cfg.interval * 1000 + this.backoffMs) return false;
    this.lastTry = now;
    this.busy = true;
    try {
      const opts: OtelOptions = {
        compat: cfg.compat,
        includeContent: cfg.include_content,
        serviceVersion: this.version,
      };
      const seq = Number(this.store.metaValue("otel_seq") ?? "-1");
      const turn = Number(this.store.metaValue("otel_turn") ?? "-1");
      // First run: start from now, not from the whole history.
      if (seq < 0 || turn < 0) {
        this.store.setMetaValue("otel_seq", String(this.store.otelSeqHead()));
        this.store.setMetaValue("otel_turn", String(this.store.otelTurnHead()));
        this.store.setMetaValue("otel_at", new Date(now).toISOString());
        return false;
      }
      const b = this.store.otelBatch(seq, turn, cfg.include_content);
      const since =
        this.store.metaValue("otel_at") ?? new Date(now - cfg.interval * 1000).toISOString();
      const at = new Date(now).toISOString();
      const traces = buildTraces(b, opts);
      if (traces) {
        await this.send(`${cfg.endpoint}/v1/traces`, traces, cfg.headers);
        this.sent.spans += b.tools.length + b.waits.length + b.ended.length;
      }
      this.store.setMetaValue("otel_seq", String(b.maxSeq));
      const metrics = buildMetrics(b.turns, { start: since, end: at }, opts);
      if (metrics) {
        await this.send(`${cfg.endpoint}/v1/metrics`, metrics, cfg.headers);
        this.sent.points += b.turns.length;
      }
      this.store.setMetaValue("otel_turn", String(b.maxTurn));
      this.store.setMetaValue("otel_at", at);
      this.lastOkAt = at;
      this.lastError = null;
      this.backoffMs = 0;
      return true;
    } catch (e) {
      this.lastError = (e as Error).message;
      this.backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(5_000, this.backoffMs * 2));
      return false;
    } finally {
      this.busy = false;
    }
  }

  private async send(url: string, body: object, headers: Record<string, string>) {
    const r = await this.post(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`${url} answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
}
