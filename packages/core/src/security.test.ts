import { describe, expect, test } from "bun:test";
import { hostsIn, installsIn, type ScanRow, secretsIn, securityScan } from "./security";

const row = (o: Partial<ScanRow> & Pick<ScanRow, "command">): ScanRow => ({
  sessionId: "s1",
  tool: "Bash",
  at: "2026-08-26T12:00:00.000Z",
  ...o,
});

describe("hostsIn", () => {
  test("pulls the host out of a URL, without the port", () => {
    expect(hostsIn("curl https://api.example.com:8443/v1/thing")).toEqual(["api.example.com"]);
  });

  test("drops credentials embedded in the URL rather than reporting them as a host", () => {
    expect(hostsIn("curl https://user:pw@git.example.com/repo")).toEqual(["git.example.com"]);
  });

  test("finds several hosts and de-duplicates", () => {
    expect(hostsIn("curl http://a.com && curl https://b.com && curl http://a.com")).toEqual([
      "a.com",
      "b.com",
    ]);
  });

  test("stops at the punctuation a URL is usually wrapped in", () => {
    expect(hostsIn('fetch("https://example.com/x") // and https://other.com,')).toEqual([
      "example.com",
      "other.com",
    ]);
  });

  test("a shell variable for the port does not become part of the host", () => {
    // Real commands write `127.0.0.1:$PORT`; stripping only a numeric port left junk behind.
    expect(hostsIn("curl http://127.0.0.1:$PORT/v1/state")).toEqual(["127.0.0.1"]);
  });

  test("an IPv6 literal keeps its address and loses the port", () => {
    expect(hostsIn("curl http://[::1]:7777/x")).toEqual(["::1"]);
  });

  test("a bare domain with no scheme is not a host", () => {
    // Otherwise every `foo.ts` in a sentence becomes egress.
    expect(hostsIn("see example.com for details")).toEqual([]);
  });
});

describe("installsIn", () => {
  test("names the package and the ecosystem", () => {
    expect(installsIn("npm install left-pad")).toEqual([{ ecosystem: "npm", pkg: "left-pad" }]);
  });

  test("a bare install still counts — it installs whatever the manifest says", () => {
    expect(installsIn("bun install")).toEqual([{ ecosystem: "bun", pkg: "(from manifest)" }]);
  });

  test("flags are not packages", () => {
    expect(installsIn("pip install --upgrade requests")).toEqual([
      { ecosystem: "pip", pkg: "requests" },
    ]);
  });

  test("several packages in one command are several installs", () => {
    expect(installsIn("cargo add serde tokio").map((i) => i.pkg)).toEqual(["serde", "tokio"]);
  });

  test("stops at a command separator so the next command is not swallowed", () => {
    expect(installsIn("npm i foo && rm -rf /tmp/x").map((i) => i.pkg)).toEqual(["foo"]);
  });

  test("sudo apt-get install is still an apt install", () => {
    expect(installsIn("sudo apt-get install ripgrep")).toEqual([
      { ecosystem: "apt", pkg: "ripgrep" },
    ]);
  });

  test("a word containing 'install' is not an install", () => {
    expect(installsIn("./scripts/reinstall-hooks.sh")).toEqual([]);
  });

  test("a redirection is not a package", () => {
    // `bun install >/dev/null 2>&1` was being read as packages called `>/dev/null` and `2`.
    expect(installsIn("bun install >/dev/null 2>&1")).toEqual([
      { ecosystem: "bun", pkg: "(from manifest)" },
    ]);
  });

  test("prose around the word install is not a package list", () => {
    // This sentence produced four packages: `and`, `the`, `rest`, `follows`.
    expect(installsIn("then npm install and the rest follows")).toEqual([]);
  });

  test("an installer after a separator is still in command position", () => {
    expect(installsIn("cd app && npm i left-pad")).toEqual([{ ecosystem: "npm", pkg: "left-pad" }]);
  });

  test("scoped, pinned and path-style package names still parse", () => {
    expect(installsIn("npm i @scope/pkg").map((i) => i.pkg)).toEqual(["@scope/pkg"]);
    expect(installsIn("pip install requests==2.31").map((i) => i.pkg)).toEqual(["requests==2.31"]);
    expect(installsIn("go get github.com/x/y").map((i) => i.pkg)).toEqual(["github.com/x/y"]);
  });
});

describe("secretsIn", () => {
  test("recognises credential files by name", () => {
    expect(secretsIn("cat .env")).toEqual([".env file"]);
    expect(secretsIn("cat ~/.ssh/id_ed25519")).toEqual(["SSH private key"]);
    expect(secretsIn("cat ~/.aws/credentials")).toEqual(["AWS credentials"]);
  });

  test("a suffixed env file counts", () => {
    expect(secretsIn("cat .env.production")).toEqual([".env file"]);
  });

  test("the keychain command counts even with no path", () => {
    expect(secretsIn("security find-generic-password -s github")).toEqual(["macOS keychain"]);
  });

  test("a word that merely contains env does not count", () => {
    expect(secretsIn("bun run dev --environment staging")).toEqual([]);
  });
});

describe("securityScan", () => {
  test("aggregates hits and distinct sessions per host", () => {
    const r = securityScan([
      row({ command: "curl https://api.example.com/a" }),
      row({ command: "curl https://api.example.com/b", sessionId: "s2" }),
    ]);
    expect(r.egress[0]).toEqual({ host: "api.example.com", hits: 2, sessions: 2, local: false });
  });

  test("loopback is marked local and sorts last", () => {
    const r = securityScan([
      row({ command: "curl http://127.0.0.1:7777/v1/state" }),
      row({ command: "curl https://example.com" }),
    ]);
    expect(r.egress.map((h) => h.host)).toEqual(["example.com", "127.0.0.1"]);
    expect(r.egress[1]?.local).toBe(true);
    expect(r.totals.remoteHosts).toBe(1);
  });

  test("private ranges are local too", () => {
    const r = securityScan([row({ command: "curl http://192.168.1.10/x" })]);
    expect(r.egress[0]?.local).toBe(true);
    expect(r.totals.remoteHosts).toBe(0);
  });

  test("the file path is scanned as well as the command", () => {
    const r = securityScan([row({ tool: "Read", command: "", path: "/app/.env" })]);
    expect(r.secrets.map((s) => s.what)).toEqual([".env file"]);
  });

  test("installs are only read from the command, never the path", () => {
    // A file called `npm install.md` is not an install.
    const r = securityScan([row({ tool: "Read", command: "", path: "docs/npm install.md" })]);
    expect(r.installs).toEqual([]);
  });

  test("totals count hits, not distinct kinds", () => {
    const r = securityScan([
      row({ command: "npm i a" }),
      row({ command: "npm i a" }),
      row({ command: "cat .env" }),
    ]);
    expect(r.totals.installs).toBe(2);
    expect(r.totals.secrets).toBe(1);
    expect(r.totals.scanned).toBe(3);
  });

  test("rows with no session or no text are skipped", () => {
    const r = securityScan([
      row({ command: "curl https://x.com", sessionId: "" }),
      row({ command: "", path: null }),
    ]);
    expect(r.totals.scanned).toBe(0);
    expect(r.egress).toEqual([]);
  });

  test("empty in, empty out", () => {
    expect(securityScan([])).toEqual({
      egress: [],
      installs: [],
      secrets: [],
      totals: { scanned: 0, remoteHosts: 0, installs: 0, secrets: 0 },
    });
  });
});
