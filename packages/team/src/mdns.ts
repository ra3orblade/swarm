/**
 * M13.13: announce this team on the LAN as `_swarm-team._tcp.local`, so the Team panel's Join
 * can list it beside the pasted link. A small responder over `@swarm/core`'s codec: it announces
 * on start, answers queries (unicast to a legacy querier's own port, RFC 6762 §6.7), and says
 * goodbye on the way out. Name, address, port and auth mode only — never a secret.
 *
 * Any socket error just turns it off: a machine without multicast still hosts a team.
 * `SWARM_TEAM_MDNS=0` turns it off on purpose.
 */
import dgram from "node:dgram";
import { hostname, networkInterfaces } from "node:os";
import {
  type Announce,
  decodeMessage,
  encodeAnnounce,
  instanceName,
  MDNS_ADDR,
  MDNS_PORT,
  T_A,
  T_ANY,
  T_PTR,
  T_SRV,
  T_TXT,
  TEAM_SERVICE,
} from "@swarm/core";

function lanIPv4(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  return out;
}

const hostLabel = () =>
  hostname()
    .replace(/\.local\.?$/i, "")
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    // our own label: the machine's name belongs to the OS's responder, whose A records we
    // must not contest
    .concat("-swarm") || "swarm-team";

export function announceTeam(opts: {
  name: string | null;
  port: number;
  txt: Record<string, string>;
  log?: (msg: string) => void;
}): { stop: () => Promise<void> } {
  const log = opts.log ?? (() => {});
  const ip4 = lanIPv4();
  if (process.env.SWARM_TEAM_MDNS === "0" || !ip4.length) return { stop: async () => {} };
  const host = hostLabel();
  const ann: Announce = {
    instance: (opts.name?.trim() || `Swarm team on ${host}`).slice(0, 60),
    host,
    port: opts.port,
    ip4,
    txt: opts.txt,
  };
  const inst = instanceName(ann.instance).toLowerCase();
  const hostName = `${host}.local`.toLowerCase();
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  let open = false;
  const send = (buf: Uint8Array, port = MDNS_PORT, addr = MDNS_ADDR) => {
    if (open) sock.send(buf, port, addr, () => {});
  };

  sock.on("error", (e) => {
    log(`mDNS off: ${e.message}`);
    open = false;
    try {
      sock.close();
    } catch {}
  });
  sock.on("message", (msg, rinfo) => {
    let m: ReturnType<typeof decodeMessage>;
    try {
      m = decodeMessage(new Uint8Array(msg));
    } catch {
      return;
    }
    if (m.flags & 0x8000) return; // a response, not a question
    for (const q of m.questions) {
      const n = q.name.toLowerCase();
      const ours =
        (n === TEAM_SERVICE && (q.type === T_PTR || q.type === T_ANY)) ||
        (n === inst && (q.type === T_SRV || q.type === T_TXT || q.type === T_ANY)) ||
        (n === hostName && (q.type === T_A || q.type === T_ANY));
      if (!ours) continue;
      if (rinfo.port !== MDNS_PORT)
        send(encodeAnnounce(ann, { id: m.id, question: q }), rinfo.port, rinfo.address);
      else if (q.unicast) send(encodeAnnounce(ann), MDNS_PORT, rinfo.address);
      else send(encodeAnnounce(ann));
      return;
    }
  });
  sock.bind(MDNS_PORT, () => {
    try {
      sock.addMembership(MDNS_ADDR);
      sock.setMulticastTTL(255);
      open = true;
      send(encodeAnnounce(ann));
      setTimeout(() => send(encodeAnnounce(ann)), 1000).unref();
      log(`announced on the LAN as "${ann.instance}" (${TEAM_SERVICE})`);
    } catch (e) {
      log(`mDNS off: ${(e as Error).message}`);
    }
  });
  sock.unref();

  return {
    stop: () =>
      new Promise<void>((done) => {
        if (!open) return done();
        sock.send(encodeAnnounce({ ...ann, ttl: 0 }), MDNS_PORT, MDNS_ADDR, () => {
          open = false;
          try {
            sock.close();
          } catch {}
          done();
        });
      }),
  };
}
