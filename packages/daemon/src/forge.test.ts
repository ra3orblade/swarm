import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeService } from "./forge";
import { Store } from "./store";

const tmpHome = () => mkdtempSync(join(tmpdir(), "swarm-forge-"));

describe("forge", () => {
  it("shares one run between concurrent callers", async () => {
    const forge = new ForgeService(new Store(tmpHome()));
    const root = mkdtempSync(join(tmpdir(), "swarm-repo-"));
    // Both callers land in the same in-flight entry, so they get the identical object back — this
    // is what stops a 5 s poll from stacking a fresh `gh` fan-out on the one still running.
    const [a, b] = await Promise.all([forge.merged("p1", root), forge.merged("p1", root)]);
    expect(a).toBe(b);
  });

  it("survives a project root that no longer exists", async () => {
    const forge = new ForgeService(new Store(tmpHome()));
    const gone = mkdtempSync(join(tmpdir(), "swarm-gone-"));
    rmSync(gone, { recursive: true, force: true });
    // Spawning into a missing cwd throws; one throw used to reject the whole outcomes fan-out.
    const out = await forge.merged("p1", gone);
    expect(out).toMatchObject({ merged: [], reverted: [] });
  });

  it("keeps scratch roots out of the refresh fan-out", async () => {
    const store = new Store(tmpHome());
    const scratch = mkdtempSync(join(tmpdir(), "swarm-scratch-"));
    store.resolveProject(scratch);
    const forge = new ForgeService(store);
    await forge.refresh(0);
    expect(forge.prs()).toEqual([]);
  });
});
