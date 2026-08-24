import { describe, expect, it } from "bun:test";
import { createTeamApp, PROTOCOL } from "./app";
import { TeamStore } from "./store";

describe("team app (M8.3a)", () => {
  it("serves /t1/health with version, protocol and schema", async () => {
    const app = createTeamApp(new TeamStore(":memory:"));
    const res = await app.request("/t1/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.protocol).toBe(PROTOCOL);
    expect(body.schema).toBe(TeamStore.SCHEMA_VERSION);
  });
});
