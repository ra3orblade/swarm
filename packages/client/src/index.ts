import type { SwarmEvent } from "@swarm/core";
import { resolveBaseUrl } from "./daemon";

export * from "./daemon";

export interface ClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Thin typed HTTP client for swarmd. Every CLI/MCP/hook/web call goes through here. */
export class SwarmClient {
  readonly baseUrl: string;
  private readonly f: typeof fetch;

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = resolveBaseUrl(opts.baseUrl);
    this.f = opts.fetch ?? fetch;
  }

  async health(): Promise<{ ok: boolean; version: string }> {
    const r = await this.f(`${this.baseUrl}/v1/health`);
    if (!r.ok) throw new Error(`swarmd: ${r.status}`);
    return (await r.json()) as { ok: boolean; version: string };
  }

  async emit(event: SwarmEvent): Promise<void> {
    const r = await this.f(`${this.baseUrl}/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!r.ok) throw new Error(`swarmd: ${r.status}`);
  }
}
