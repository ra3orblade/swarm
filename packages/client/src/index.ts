import type { SwarmEvent } from "@swarm/core";
import { authedFetch, resolveBaseUrl } from "./daemon";

export * from "./bins";
export * from "./daemon";

export interface ClientOptions {
  baseUrl?: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

/** Thin typed HTTP client for swarmd. Every CLI/MCP/hook/web call goes through here. */
export class SwarmClient {
  readonly baseUrl: string;
  private readonly f: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = resolveBaseUrl(opts.baseUrl);
    this.f = opts.fetch ?? authedFetch;
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
