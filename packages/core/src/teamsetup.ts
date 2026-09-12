/**
 * Hosting and joining a team (M13.12) — the parts that are pure text.
 *
 * The team daemon has been configured by environment variables since M8.3, which is fine for a
 * server and hostile to a person: it means a shell, exported secrets, and nothing to read back.
 * `~/.swarm/team.toml` is the same settings written down, rendered here and parsed here; the
 * environment still wins, so an existing deployment keeps behaving exactly as it did.
 *
 * The invite link is the other half: one string that carries the URL and, for a shared-secret
 * team, the secret — so joining is a paste rather than two commands.
 */

export type TeamAuthMode = "oidc" | "token" | "open";

export interface TeamSetup {
  /** Shown in the team dashboard; cosmetic. */
  name: string | null;
  host: string;
  port: number;
  mode: TeamAuthMode;
  /** `mode = "token"`: the shared secret every machine forwards with. */
  token: string | null;
  /** `mode = "oidc"`. */
  issuer: string | null;
  clientId: string | null;
  /** Where the team database lives; null = the default beside the rest of `~/.swarm`. */
  db: string | null;
}

export const DEFAULT_TEAM_SETUP: TeamSetup = {
  name: null,
  host: "0.0.0.0",
  port: 7878,
  mode: "token",
  token: null,
  issuer: null,
  clientId: null,
  db: null,
};

/** A shared secret with enough entropy that a LAN is not a lottery. */
export function mintTeamSecret(): string {
  return `swt_${crypto.randomUUID().replaceAll("-", "")}`;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Parse `team.toml`. Deliberately tiny — flat `key = value` lines, `#` comments — because that
 * is all this file ever holds, and a parser that cannot throw is worth more here than one that
 * understands every TOML shape.
 */
export function parseTeamSetup(text: string | null): TeamSetup {
  const out: TeamSetup = { ...DEFAULT_TEAM_SETUP };
  if (!text) return out;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (!m) continue;
    const key = m[1] as string;
    const value = (m[2] as string).trim().replace(/^["']|["']$/g, "");
    switch (key) {
      case "name":
        out.name = str(value);
        break;
      case "host":
        out.host = str(value) ?? out.host;
        break;
      case "port": {
        const n = Number(value);
        if (Number.isInteger(n) && n > 0 && n < 65536) out.port = n;
        break;
      }
      case "mode":
        if (value === "oidc" || value === "token" || value === "open") out.mode = value;
        break;
      case "token":
        out.token = str(value);
        break;
      case "issuer":
        out.issuer = str(value);
        break;
      case "client_id":
        out.clientId = str(value);
        break;
      case "db":
        out.db = str(value);
        break;
      default:
        break; // an unknown key is someone's note to themselves, not an error
    }
  }
  return out;
}

export function renderTeamSetup(s: TeamSetup): string {
  const lines = [
    "# swarm-teamd — written by `swarm-teamd setup` or the dashboard's Team panel.",
    "# Environment variables still win: SWARM_TEAM_PORT / _HOST / _TOKEN / _OIDC_ISSUER /",
    "# _OIDC_CLIENT_ID / _DB override anything here.",
    "",
    `name = ${JSON.stringify(s.name ?? "")}`,
    `host = ${JSON.stringify(s.host)}`,
    `port = ${s.port}`,
    `mode = ${JSON.stringify(s.mode)}`,
  ];
  if (s.mode === "token") lines.push(`token = ${JSON.stringify(s.token ?? "")}`);
  if (s.mode === "oidc") {
    lines.push(`issuer = ${JSON.stringify(s.issuer ?? "")}`);
    lines.push(`client_id = ${JSON.stringify(s.clientId ?? "")}`);
  }
  if (s.db) lines.push(`db = ${JSON.stringify(s.db)}`);
  return `${lines.join("\n")}\n`;
}

/** The env the team daemon reads, from the file — so `authEnv()` needs no new code path. */
export function teamSetupEnv(s: TeamSetup): Record<string, string> {
  const env: Record<string, string> = {
    SWARM_TEAM_HOST: s.host,
    SWARM_TEAM_PORT: String(s.port),
  };
  if (s.mode === "token" && s.token) env.SWARM_TEAM_TOKEN = s.token;
  if (s.mode === "oidc") {
    if (s.issuer) env.SWARM_TEAM_OIDC_ISSUER = s.issuer;
    if (s.clientId) env.SWARM_TEAM_OIDC_CLIENT_ID = s.clientId;
  }
  if (s.db) env.SWARM_TEAM_DB = s.db;
  return env;
}

/** What a teammate pastes into Join. `swarm+team://join?url=…&token=…`. */
export function inviteLink(url: string, token?: string | null): string {
  const q = new URLSearchParams({ url: url.replace(/\/+$/, "") });
  if (token) q.set("token", token);
  return `swarm+team://join?${q}`;
}

export interface ParsedInvite {
  url: string;
  token: string | null;
}

/**
 * Accept an invite link, a bare `http(s)://host:port`, or `http://host:port#<secret>` — people
 * paste all three. Null when there is no usable URL in the text.
 */
export function parseInvite(text: string): ParsedInvite | null {
  const raw = text.trim();
  if (!raw) return null;
  const invite = raw.match(/^swarm\+team:\/\/join\?(.*)$/i);
  if (invite) {
    const q = new URLSearchParams(invite[1] as string);
    const url = q.get("url");
    return url && /^https?:\/\//i.test(url)
      ? { url: url.replace(/\/+$/, ""), token: q.get("token") || null }
      : null;
  }
  const hash = raw.match(/^(https?:\/\/[^\s#]+)#(.+)$/i);
  if (hash)
    return {
      url: (hash[1] as string).replace(/\/+$/, ""),
      token: (hash[2] as string).trim() || null,
    };
  if (/^https?:\/\/\S+$/i.test(raw)) return { url: raw.replace(/\/+$/, ""), token: null };
  // a bare host[:port] is what people type when they mean "the box called nas"
  if (/^[A-Za-z0-9][A-Za-z0-9.-]*(:\d{2,5})?$/.test(raw))
    return {
      url: `http://${raw.includes(":") ? raw : `${raw}:${DEFAULT_TEAM_SETUP.port}`}`,
      token: null,
    };
  return null;
}

/** The URL a teammate should use for a daemon we host, given a LAN address. */
export function hostedUrl(address: string, port: number): string {
  return `http://${address}:${port}`;
}

/**
 * `[team] url = "…"` folded into a `config.toml`'s text: the existing url line is replaced, the
 * section is created when missing, and everything else is left byte for byte. `null` clears it.
 */
export function withTeamUrl(text: string, url: string | null): string {
  const section = text.match(/(^|\n)\[team\]([\s\S]*?)(?=\n\[|$)/);
  if (!section) {
    if (!url) return text;
    return `${text}${text && !text.endsWith("\n") ? "\n" : ""}\n[team]\nurl = ${JSON.stringify(url)}\n`;
  }
  const body = section[2] ?? "";
  const line = url ? `url = ${JSON.stringify(url)}` : "";
  const next = /^[ \t]*url[ \t]*=/m.test(body)
    ? body.replace(/^[ \t]*url[ \t]*=.*$/m, line).replace(/\n{3,}/g, "\n\n")
    : url
      ? `\n${line}${body}`
      : body;
  return text.replace(section[0], `${section[1]}[team]${next}`);
}
