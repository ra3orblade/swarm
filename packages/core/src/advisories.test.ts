import { describe, expect, test } from "bun:test";
import {
  advisoryReason,
  compareVersions,
  cvss3BaseScore,
  hitsFor,
  inRange,
  osvQueries,
  parseOsvBatch,
  parseOsvVuln,
  queryable,
  queryKey,
  severityAtLeast,
  severityOf,
} from "./advisories";
import type { StackRow } from "./stack";

const rows: StackRow[] = [
  { ecosystem: "npm", name: "hono", version: "4.6.3", scope: "runtime", manifest: "bun.lock" },
  { ecosystem: "npm", name: "hono", version: "4.6.3", scope: "", manifest: "apps/web/bun.lock" },
  { ecosystem: "PyPI", name: "Django", version: "4.2.0", scope: "runtime", manifest: "uv.lock" },
  {
    ecosystem: "GitHub Actions",
    name: "actions/checkout",
    version: "4",
    scope: "",
    manifest: ".github/workflows/ci.yml",
  },
  {
    ecosystem: "GitHub Actions",
    name: "tj-actions/changed-files",
    version: "45.0.1",
    scope: "",
    manifest: ".github/workflows/ci.yml",
  },
  {
    ecosystem: "GitHub Actions",
    name: "x/y",
    version: "8f1a2b3c4d5e6f708192a3b4c5d6e7f8a9b0c1d2",
    scope: "",
    manifest: ".github/workflows/ci.yml",
  },
];

const GHSA = {
  id: "GHSA-aaaa-bbbb-cccc",
  aliases: ["CVE-2026-1"],
  summary: "Path traversal in hono/node-server.",
  details: "long text",
  published: "2026-10-20T00:00:00Z",
  modified: "2026-10-21T00:00:00Z",
  database_specific: { severity: "HIGH" },
  severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N" }],
  affected: [
    {
      package: { ecosystem: "npm", name: "hono" },
      ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "4.0.0" }, { fixed: "4.6.5" }] }],
    },
    { package: { ecosystem: "Go", name: "ignored" }, ranges: [] },
  ],
};

describe("queries", () => {
  test("queryable: releases only", () => {
    expect(queryable(rows[0] as StackRow)).toBe(true);
    expect(queryable(rows[3] as StackRow)).toBe(false); // bare major
    expect(queryable(rows[5] as StackRow)).toBe(false); // a sha
  });

  test("osvQueries: distinct, in row order, keyed", () => {
    const q = osvQueries(rows);
    expect(q.queries).toEqual([
      { package: { name: "hono", ecosystem: "npm" }, version: "4.6.3" },
      { package: { name: "Django", ecosystem: "PyPI" }, version: "4.2.0" },
      {
        package: { name: "tj-actions/changed-files", ecosystem: "GitHub Actions" },
        version: "45.0.1",
      },
    ]);
    expect(q.keys[0]).toBe(queryKey("npm", "hono", "4.6.3"));
  });

  test("parseOsvBatch: answers align with the queries; empty and odd results are skipped", () => {
    const q = osvQueries(rows);
    const m = parseOsvBatch(q.keys, {
      results: [
        { vulns: [{ id: "GHSA-1", modified: "2026-01-01T00:00:00Z" }, { id: "" }] },
        {},
        { vulns: "nope" },
      ],
    });
    expect(m.get(q.keys[0] as string)).toEqual([
      { id: "GHSA-1", modified: "2026-01-01T00:00:00Z" },
    ]);
    expect(m.size).toBe(1);
    expect(parseOsvBatch(q.keys, null).size).toBe(0);
  });
});

describe("severity", () => {
  test("cvss3BaseScore follows the specification", () => {
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBe(9.8);
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N")).toBe(7.5);
    expect(cvss3BaseScore("CVSS:3.0/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N")).toBe(6.1);
    expect(cvss3BaseScore("CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N")).toBe(1.8);
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N")).toBe(0);
    expect(
      cvss3BaseScore("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"),
    ).toBeNull();
    expect(cvss3BaseScore("garbage")).toBeNull();
  });

  test("severityOf: the database's word, else the banded score, else MAL- is critical, else unknown", () => {
    expect(severityOf(GHSA)).toEqual({ severity: "high", cvss: 7.5 });
    expect(severityOf({ database_specific: { severity: "MODERATE" } })).toEqual({
      severity: "medium",
      cvss: null,
    });
    expect(
      severityOf({
        severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
      }),
    ).toEqual({ severity: "critical", cvss: 9.8 });
    expect(severityOf({ id: "MAL-2026-1" })).toEqual({ severity: "critical", cvss: null });
    expect(severityOf({ id: "PYSEC-2026-1" })).toEqual({ severity: "unknown", cvss: null });
  });

  test("severityAtLeast orders worst first", () => {
    expect(severityAtLeast("critical", "high")).toBe(true);
    expect(severityAtLeast("high", "high")).toBe(true);
    expect(severityAtLeast("medium", "high")).toBe(false);
    expect(severityAtLeast("unknown", "unknown")).toBe(true);
  });
});

describe("records and ranges", () => {
  test("parseOsvVuln: packages of known ecosystems, ranges, the first fixed version, the url", () => {
    const a = parseOsvVuln(GHSA);
    expect(a).toMatchObject({
      id: "GHSA-aaaa-bbbb-cccc",
      aliases: ["CVE-2026-1"],
      severity: "high",
      cvss: 7.5,
      url: "https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc",
      summary: "Path traversal in hono/node-server.",
    });
    expect(a?.packages).toEqual([
      {
        ecosystem: "npm",
        name: "hono",
        ranges: [{ introduced: "4.0.0", fixed: "4.6.5" }],
        versions: [],
        fixed: "4.6.5",
      },
    ]);
    expect(parseOsvVuln({})).toBeNull();
    expect(parseOsvVuln({ id: "X", details: "first line\nsecond" })?.summary).toBe("first line");
  });

  test("compareVersions: numeric, dotted, pre-releases first", () => {
    expect(compareVersions("4.6.3", "4.6.5")).toBeLessThan(0);
    expect(compareVersions("4.10.0", "4.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-rc1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("v2.0.0", "2.0.0")).toBe(0);
  });

  test("inRange: explicit versions win; introduced / fixed / last_affected; never fixed", () => {
    const pkg = parseOsvVuln(GHSA)?.packages[0];
    if (!pkg) throw new Error("no pkg");
    expect(inRange("4.6.3", pkg)).toBe(true);
    expect(inRange("4.6.5", pkg)).toBe(false);
    expect(inRange("3.9.9", pkg)).toBe(false);
    expect(inRange("4.0.0", pkg)).toBe(true);
    expect(inRange("1.2.3", { ...pkg, versions: ["1.2.3"], ranges: [] })).toBe(true);
    expect(inRange("1.2.4", { ...pkg, versions: ["1.2.3"], ranges: [] })).toBe(false);
    expect(inRange("9.9.9", { ...pkg, ranges: [{ introduced: "0" }] })).toBe(true);
    expect(
      inRange("2.0.0", { ...pkg, ranges: [{ introduced: "1.0.0", last_affected: "2.0.0" }] }),
    ).toBe(true);
    expect(
      inRange("2.0.1", { ...pkg, ranges: [{ introduced: "1.0.0", last_affected: "2.0.0" }] }),
    ).toBe(false);
  });

  test("advisoryReason reads as one sentence", () => {
    const a = parseOsvVuln(GHSA);
    if (!a) throw new Error("no advisory");
    expect(advisoryReason(a, { name: "hono", version: "4.6.3", fixed: "4.6.5" })).toBe(
      "hono 4.6.3 has a known high advisory (GHSA-aaaa-bbbb-cccc): Path traversal in hono/node-server. Fixed in 4.6.5.",
    );
    expect(advisoryReason(a, { name: "hono", version: "4.6.3", fixed: null })).toContain(
      "No fixed version is named yet.",
    );
  });

  test("hitsFor: one hit per (advisory, row), the range refines OSV's answer, other projects untouched", () => {
    const a = parseOsvVuln(GHSA);
    if (!a) throw new Error("no advisory");
    const q = osvQueries(rows);
    const idsByKey = new Map([[q.keys[0] as string, [{ id: a.id }, { id: "GHSA-unknown" }]]]);
    const hits = hitsFor("p1", rows, idsByKey, new Map([[a.id, a]]));
    expect(
      hits.map((h) => `${h.advisoryId} ${h.name}@${h.version} ${h.manifest} ${h.fixed}`),
    ).toEqual([
      "GHSA-aaaa-bbbb-cccc hono@4.6.3 bun.lock 4.6.5",
      "GHSA-aaaa-bbbb-cccc hono@4.6.3 apps/web/bun.lock 4.6.5",
    ]);
    // a version OSV named but the record's own range excludes
    const fixedEarlier = {
      ...a,
      packages: [
        {
          ...(a.packages[0] as NonNullable<(typeof a.packages)[0]>),
          ranges: [{ introduced: "0", fixed: "4.6.0" }],
        },
      ],
    };
    expect(hitsFor("p1", rows, idsByKey, new Map([[a.id, fixedEarlier]]))).toEqual([]);
  });
});

describe("M14.9 dispatch a fix", () => {
  const { fixPrompt, fixTaskId } = require("./advisories") as typeof import("./advisories");

  test("fixTaskId is a safe branch-shaped id", () => {
    expect(fixTaskId("hono", "4.6.5")).toBe("sec/hono-4.6.5");
    expect(fixTaskId("@modelcontextprotocol/sdk", "1.32.0")).toBe(
      "sec/modelcontextprotocol-sdk-1.32.0",
    );
    expect(fixTaskId("Django", "4.2.11")).toBe("sec/django-4.2.11");
  });

  test("fixPrompt names what, why, where and the limits", () => {
    const p = fixPrompt({
      advisory: {
        id: "GHSA-1",
        severity: "high",
        summary: "Path traversal.",
        url: "https://osv.dev/vulnerability/GHSA-1",
      },
      ecosystem: "npm",
      name: "hono",
      version: "4.6.3",
      fixed: "4.6.5",
      manifest: "bun.lock",
    });
    expect(p).toContain("Upgrade hono from 4.6.3 to 4.6.5 or later");
    expect(p).toContain("GHSA-1 (high): Path traversal — https://osv.dev/vulnerability/GHSA-1");
    expect(p).toContain("bun.lock (npm)");
    expect(p).toContain("open a pull request");
    expect(p).toContain("Do not change anything unrelated");
  });
});
