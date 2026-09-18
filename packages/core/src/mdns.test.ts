import { describe, expect, test } from "bun:test";
import {
  decodeMessage,
  encodeAnnounce,
  encodeQuery,
  T_A,
  T_PTR,
  T_SRV,
  T_TXT,
  TEAM_SERVICE,
  teamsFrom,
} from "./mdns";

const ANN = {
  instance: "Acme team",
  host: "nas",
  port: 7878,
  ip4: ["192.168.1.20"],
  txt: { v: "0.15.0", auth: "token" },
};

describe("mDNS", () => {
  test("a query round-trips, QU bit included", () => {
    const q = decodeMessage(encodeQuery(TEAM_SERVICE, T_PTR, 7, true));
    expect(q.id).toBe(7);
    expect(q.questions).toEqual([{ name: TEAM_SERVICE, type: T_PTR, unicast: true }]);
  });

  test("an announcement carries PTR, SRV, TXT and A, and assembles into one team", () => {
    const m = decodeMessage(encodeAnnounce(ANN));
    expect(m.flags).toBe(0x8400);
    expect(m.records.map((r) => r.type)).toEqual([T_PTR, T_SRV, T_TXT, T_A]);
    expect(teamsFrom(m.records)).toEqual([
      {
        name: "Acme team",
        host: "nas.local",
        port: 7878,
        addresses: ["192.168.1.20"],
        txt: { v: "0.15.0", auth: "token" },
        url: "http://192.168.1.20:7878",
      },
    ]);
  });

  test("a legacy unicast reply echoes the question and id", () => {
    const m = decodeMessage(
      encodeAnnounce(ANN, { id: 4242, question: { name: TEAM_SERVICE, type: T_PTR } }),
    );
    expect(m.id).toBe(4242);
    expect(m.questions[0]?.name).toBe(TEAM_SERVICE);
    expect(teamsFrom(m.records)).toHaveLength(1);
  });

  test("a goodbye (ttl 0) is not a team; other services are ignored", () => {
    expect(teamsFrom(decodeMessage(encodeAnnounce({ ...ANN, ttl: 0 })).records)).toEqual([]);
    const other = decodeMessage(encodeAnnounce(ANN)).records.map((r) =>
      r.type === T_PTR ? { ...r, name: "_http._tcp.local" } : r,
    );
    expect(teamsFrom(other)).toEqual([]);
  });

  test("compression pointers are followed", () => {
    // header, question "_swarm-team._tcp.local" PTR, answer name = pointer to offset 12
    const q = [...encodeQuery()];
    const nameEnd = q.length - 4;
    const target = [...new TextEncoder().encode("x")];
    const rdata = [target.length, ...target, 0xc0, 12];
    const answer = [0xc0, 12, 0, T_PTR, 0, 1, 0, 0, 0, 120, 0, rdata.length, ...rdata];
    const buf = new Uint8Array([...q.slice(0, 6), 0, 1, ...q.slice(8, nameEnd + 4), ...answer]);
    const m = decodeMessage(buf);
    expect(m.records[0]).toEqual({
      name: TEAM_SERVICE,
      type: T_PTR,
      ttl: 120,
      data: `x.${TEAM_SERVICE}`,
    });
  });

  test("garbage throws rather than misreads", () => {
    expect(() => decodeMessage(new Uint8Array([1, 2, 3]))).toThrow();
    const cut = encodeAnnounce(ANN).slice(0, 40);
    expect(() => decodeMessage(cut)).toThrow();
  });
});
