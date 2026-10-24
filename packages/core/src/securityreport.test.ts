import { describe, expect, test } from "bun:test";
import type { AdvisoryReport } from "./advisories";
import type { NewsReport } from "./newsfeed";
import type { SecurityReport } from "./security";
import { renderSecurityReport } from "./securityreport";
import type { StackReport } from "./stack";

const at = "2026-10-24T12:00:00.000Z";
const stack: StackReport = {
  enabled: true,
  scannedAt: "2026-10-24T11:58:00.000Z",
  projects: [
    {
      projectId: "p1",
      name: "web",
      total: 143,
      byEcosystem: { npm: 127, PyPI: 0, "GitHub Actions": 16 },
      byScope: { runtime: 12, development: 20, "": 111 },
      manifests: [
        { path: "bun.lock", kind: "bun.lock", packages: 127, scannedAt: at, error: null },
        { path: "apps/x/yarn.lock", kind: "yarn-lock", packages: 0, scannedAt: at, error: "boom" },
      ],
    },
  ],
  rows: [],
};
const advisories: AdvisoryReport = {
  enabled: true,
  offline: false,
  lastFetch: "2026-10-24T09:00:00.000Z",
  lastError: null,
  minSeverity: "high",
  counts: { critical: 1, high: 0, medium: 0, low: 0, unknown: 0 },
  hits: [
    {
      projectId: "p1",
      advisory: {
        id: "GHSA-1",
        aliases: [],
        summary: "x",
        severity: "critical",
        cvss: 9.1,
        url: "https://osv.dev/vulnerability/GHSA-1",
        published: null,
        modified: null,
      },
      ecosystem: "npm",
      name: "proxy-addr",
      version: "2.0.7",
      fixed: "2.0.8",
      manifest: "bun.lock",
      scope: "",
      firstSeen: at,
      resolvedAt: null,
      acked: false,
      fixTask: "sec/proxy-addr-2.0.8",
      fixing: false,
    },
  ],
  enable: {
    file: "~/.swarm/config.toml",
    toml: "[security]\nadvisories = true",
    source: "default",
    settingsFile: "~/.swarm/settings.toml",
    sends: "the list",
  },
};
const activity: SecurityReport = {
  egress: [],
  installs: [{ ecosystem: "npm", pkg: "hono", hits: 3, sessions: 1 }],
  secrets: [],
  rules: [
    { rule: "pipe_to_shell", hits: 1, sessions: 1, examples: [] },
    { rule: "secrets", hits: 0, sessions: 0, examples: [] },
  ],
  totals: { scanned: 1204, remoteHosts: 6, installs: 3, secrets: 0 },
};
const news: NewsReport = {
  enabled: true,
  offline: false,
  since: "2026-10-17T12:00:00.000Z",
  days: 7,
  keywords: ["Hono", "npm", "Node.js"],
  counts: { shown: 1, unread: 1, total: 40 },
  items: [
    {
      key: "k",
      feed: "Node.js vulnerability reports",
      kind: "vendor",
      title: "October security releases",
      url: "https://nodejs.org/x",
      published: "2026-10-23T10:00:00.000Z",
      summary: "",
      image: null,
      matched: ["Node.js"],
      read: false,
    },
  ],
  feeds: { on: 27, error: 0, off: 18 },
  lastFetch: at,
  lastError: null,
};

describe("renderSecurityReport", () => {
  test("one section per concern, tables for hits, the off text when advisories are off", () => {
    const md = renderSecurityReport({
      project: { id: "p1", name: "web" },
      generatedAt: at,
      stack,
      advisories,
      activity,
      news,
      newsDays: 7,
    });
    expect(md).toContain("## web — security report, 2026-10-24");
    expect(md).toContain(
      "**Stack.** 143 packages from 2 manifests — npm 127, GitHub Actions 16 (runtime 12, development 20). Scanned 2 min ago.",
    );
    expect(md).toContain("- `apps/x/yarn.lock` could not be read: boom");
    expect(md).toContain(
      "**Advisories.** OSV read 3 h ago. 1 critical · 0 high · 0 medium · 0 low · 0 unknown.",
    );
    expect(md).toContain(
      "| critical 9.1 | [GHSA-1](https://osv.dev/vulnerability/GHSA-1) | proxy-addr (npm) | 2.0.7 → 2.0.8 | `bun.lock` |",
    );
    expect(md).toContain(
      "**Activity (14 days).** 1,204 commands · 6 remote hosts named · 3 installs (npm 3) · 0 credential files opened by name · rules: `pipe_to_shell` would hit 1.",
    );
    expect(md).toContain("**News (7 days, 1 of 40 items matched: Hono, npm, Node.js).**");
    expect(md).toContain(
      "- 2026-10-23 · Node.js vulnerability reports · [October security releases](https://nodejs.org/x) — Node.js",
    );

    const off = renderSecurityReport({
      project: { id: "p1", name: "web" },
      generatedAt: at,
      stack: { ...stack, enabled: false },
      advisories: { ...advisories, enabled: false },
      activity: { ...activity, totals: { ...activity.totals, scanned: 0 } },
      news: { ...news, enabled: false },
      newsDays: 7,
    });
    expect(off).toContain("Stack detection is off");
    expect(off).toContain("**Advisories.** Off — add to `~/.swarm/config.toml`:");
    expect(off).toContain("advisories = true");
    expect(off).toContain("No commands recorded.");
    expect(off).toContain("**News.** Off");
  });
});
