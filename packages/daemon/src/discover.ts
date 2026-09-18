/**
 * M13.13: find teams announced on the LAN (`_swarm-team._tcp.local`) for the Team panel's Join.
 * One mDNS query sent from an ephemeral port — a "legacy unicast" query (RFC 6762 §6.7), so
 * responders answer straight back to this socket and nothing here binds 5353 — then whatever
 * arrives within the window is assembled by `teamsFrom`. Never throws: no multicast, no teams.
 */
import dgram from "node:dgram";
import {
  type DnsRecord,
  decodeMessage,
  encodeQuery,
  type FoundTeam,
  MDNS_ADDR,
  MDNS_PORT,
  teamsFrom,
} from "@swarm/core";

export function discoverTeams(windowMs = 1500): Promise<FoundTeam[]> {
  return new Promise((resolve) => {
    const records: DnsRecord[] = [];
    let sock: dgram.Socket;
    try {
      sock = dgram.createSocket({ type: "udp4" });
    } catch {
      return resolve([]);
    }
    const finish = () => {
      try {
        sock.close();
      } catch {}
      resolve(teamsFrom(records));
    };
    sock.on("error", finish);
    sock.on("message", (msg) => {
      try {
        const m = decodeMessage(new Uint8Array(msg));
        if (m.flags & 0x8000) records.push(...m.records);
      } catch {
        /* not DNS */
      }
    });
    sock.bind(0, () => {
      const id = Math.floor(Math.random() * 0xffff);
      const q = encodeQuery(undefined, undefined, id);
      sock.send(q, MDNS_PORT, MDNS_ADDR, () => {});
      // mDNS is lossy by design; one resend halfway covers a dropped packet
      setTimeout(() => sock.send(q, MDNS_PORT, MDNS_ADDR, () => {}), windowMs / 2).unref?.();
      setTimeout(finish, windowMs);
    });
  });
}
