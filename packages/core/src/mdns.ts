/**
 * mDNS / DNS-SD for teams on the LAN (M13.13): just enough of RFC 1035 + RFC 6762/6763 to
 * announce `_swarm-team._tcp.local` and to find it — PTR, SRV, TXT and A records, compression
 * pointers on the way in, none on the way out. Pure: sockets live in the team daemon (responder)
 * and the local daemon (browser).
 *
 * What is announced is what a teammate needs to type anyway — a name, an address, a port and the
 * auth mode. Never a secret: a token-mode team still needs the invite link.
 */

export const TEAM_SERVICE = "_swarm-team._tcp.local";
export const MDNS_ADDR = "224.0.0.251";
export const MDNS_PORT = 5353;

export const T_A = 1;
export const T_PTR = 12;
export const T_TXT = 16;
export const T_SRV = 33;
export const T_ANY = 255;
const CLASS_IN = 1;
const CACHE_FLUSH = 0x8000;
const QU = 0x8000;

export interface Srv {
  priority: number;
  weight: number;
  port: number;
  target: string;
}
export type RData = string | Srv | Record<string, string> | null;
export interface DnsRecord {
  name: string;
  type: number;
  ttl: number;
  data: RData;
}
export interface DnsMessage {
  id: number;
  flags: number;
  questions: Array<{ name: string; type: number; unicast: boolean }>;
  /** Answers and additionals together — responders put the SRV/TXT/A in either. */
  records: DnsRecord[];
}

// ---------- encoding

function nameBytes(name: string): number[] {
  const out: number[] = [];
  for (const label of name.replace(/\.$/, "").split(".")) {
    const b = [...new TextEncoder().encode(label)];
    if (b.length > 63) throw new Error(`label too long: ${label}`);
    out.push(b.length, ...b);
  }
  out.push(0);
  return out;
}
const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

function header(id: number, flags: number, qd: number, an: number, ar = 0): number[] {
  return [...u16(id), ...u16(flags), ...u16(qd), ...u16(an), ...u16(0), ...u16(ar)];
}

/** A query for `name` (default: the team service's PTR). `unicast` sets the QU bit. */
export function encodeQuery(
  name = TEAM_SERVICE,
  type = T_PTR,
  id = 0,
  unicast = false,
): Uint8Array {
  return new Uint8Array([
    ...header(id, 0, 1, 0),
    ...nameBytes(name),
    ...u16(type),
    ...u16(CLASS_IN | (unicast ? QU : 0)),
  ]);
}

function record(
  name: string,
  type: number,
  ttl: number,
  rdata: number[],
  unique: boolean,
): number[] {
  return [
    ...nameBytes(name),
    ...u16(type),
    ...u16(CLASS_IN | (unique ? CACHE_FLUSH : 0)),
    ...u32(ttl),
    ...u16(rdata.length),
    ...rdata,
  ];
}

export interface Announce {
  /** Instance label, e.g. "Acme team" — becomes `Acme team._swarm-team._tcp.local`. */
  instance: string;
  /** Host label without `.local`. */
  host: string;
  port: number;
  ip4: string[];
  txt: Record<string, string>;
  /** 0 = goodbye (the service is going away). */
  ttl?: number;
}

export const instanceName = (instance: string) => `${instance.replace(/\./g, "-")}.${TEAM_SERVICE}`;

/**
 * An authoritative response carrying the whole service — PTR, SRV, TXT, A — so one packet is
 * enough. `question` (with the query's `id`) is echoed for legacy unicast replies (RFC 6762 §6.7).
 */
export function encodeAnnounce(
  a: Announce,
  opts: { id?: number; question?: { name: string; type: number } } = {},
): Uint8Array {
  const ttl = a.ttl ?? 120;
  const inst = instanceName(a.instance);
  const host = `${a.host}.local`;
  const txt = Object.entries(a.txt).flatMap(([k, v]) => {
    const b = [...new TextEncoder().encode(`${k}=${v}`)].slice(0, 255);
    return [b.length, ...b];
  });
  const answers = [
    record(TEAM_SERVICE, T_PTR, ttl, nameBytes(inst), false),
    record(inst, T_SRV, ttl, [...u16(0), ...u16(0), ...u16(a.port), ...nameBytes(host)], true),
    record(inst, T_TXT, ttl, txt.length ? txt : [0], true),
    ...a.ip4.map((ip) => record(host, T_A, ttl, ip.split(".").map(Number), true)),
  ];
  const q = opts.question
    ? [...nameBytes(opts.question.name), ...u16(opts.question.type), ...u16(CLASS_IN)]
    : [];
  return new Uint8Array([
    ...header(opts.id ?? 0, 0x8400, opts.question ? 1 : 0, answers.length),
    ...q,
    ...answers.flat(),
  ]);
}

// ---------- decoding

function readName(buf: Uint8Array, at: number): { name: string; next: number } {
  const labels: string[] = [];
  let i = at;
  let next = -1;
  for (let hops = 0; hops < 64; hops++) {
    const len = buf[i];
    if (len === undefined) throw new Error("truncated name");
    if (len === 0) {
      if (next < 0) next = i + 1;
      return { name: labels.join("."), next };
    }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | (buf[i + 1] ?? 0);
      if (next < 0) next = i + 2;
      i = ptr;
      continue;
    }
    labels.push(new TextDecoder().decode(buf.subarray(i + 1, i + 1 + len)));
    i += 1 + len;
  }
  throw new Error("name compression loop");
}

const r16 = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const r32 = (b: Uint8Array, i: number) => ((r16(b, i) << 16) >>> 0) + r16(b, i + 2);

/** Parse a DNS message; throws on anything malformed (callers drop the packet). */
export function decodeMessage(buf: Uint8Array): DnsMessage {
  if (buf.length < 12) throw new Error("short packet");
  const id = r16(buf, 0);
  const flags = r16(buf, 2);
  const qd = r16(buf, 4);
  const rr = r16(buf, 6) + r16(buf, 8) + r16(buf, 10);
  let i = 12;
  const questions: DnsMessage["questions"] = [];
  for (let q = 0; q < qd; q++) {
    const n = readName(buf, i);
    i = n.next;
    questions.push({ name: n.name, type: r16(buf, i), unicast: (r16(buf, i + 2) & QU) !== 0 });
    i += 4;
  }
  const records: DnsRecord[] = [];
  for (let r = 0; r < rr; r++) {
    const n = readName(buf, i);
    i = n.next;
    const type = r16(buf, i);
    const ttl = r32(buf, i + 4);
    const len = r16(buf, i + 8);
    const start = i + 10;
    if (start + len > buf.length) throw new Error("truncated record");
    let data: RData = null;
    if (type === T_PTR) data = readName(buf, start).name;
    else if (type === T_A && len === 4) data = [...buf.subarray(start, start + 4)].join(".");
    else if (type === T_SRV)
      data = {
        priority: r16(buf, start),
        weight: r16(buf, start + 2),
        port: r16(buf, start + 4),
        target: readName(buf, start + 6).name,
      };
    else if (type === T_TXT) {
      const kv: Record<string, string> = {};
      for (let j = start; j < start + len; ) {
        const l = buf[j] ?? 0;
        const s = new TextDecoder().decode(buf.subarray(j + 1, j + 1 + l));
        const eq = s.indexOf("=");
        if (s) kv[eq < 0 ? s : s.slice(0, eq)] = eq < 0 ? "" : s.slice(eq + 1);
        j += 1 + l;
      }
      data = kv;
    }
    records.push({ name: n.name, type, ttl, data });
    i = start + len;
  }
  return { id, flags, questions, records };
}

export interface FoundTeam {
  /** The instance label, as the host named it. */
  name: string;
  host: string;
  port: number;
  addresses: string[];
  txt: Record<string, string>;
  /** `http://<first address>:<port>` — what Join needs. */
  url: string;
}

/** Assemble teams from the records of any number of responses; goodbyes (ttl 0) remove. */
export function teamsFrom(records: DnsRecord[]): FoundTeam[] {
  const lower = (s: string) => s.toLowerCase();
  const byName = <T>(type: number) => {
    const m = new Map<string, { ttl: number; data: T }>();
    for (const r of records)
      if (r.type === type) m.set(lower(r.name), { ttl: r.ttl, data: r.data as T });
    return m;
  };
  const srv = byName<Srv>(T_SRV);
  const txt = byName<Record<string, string>>(T_TXT);
  const a = new Map<string, string[]>();
  for (const r of records)
    if (r.type === T_A && typeof r.data === "string" && r.ttl > 0)
      a.set(lower(r.name), [...new Set([...(a.get(lower(r.name)) ?? []), r.data])]);
  const out: FoundTeam[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (r.type !== T_PTR || lower(r.name) !== TEAM_SERVICE || typeof r.data !== "string") continue;
    const inst = lower(r.data);
    if (seen.has(inst)) continue;
    seen.add(inst);
    const s = srv.get(inst);
    if (!s || r.ttl === 0 || s.ttl === 0) continue;
    const addresses = a.get(lower(s.data.target)) ?? [];
    if (!addresses.length) continue;
    out.push({
      name: r.data.slice(0, r.data.length - TEAM_SERVICE.length - 1),
      host: s.data.target,
      port: s.data.port,
      addresses,
      txt: txt.get(inst)?.data ?? {},
      url: `http://${addresses[0]}:${s.data.port}`,
    });
  }
  return out;
}
