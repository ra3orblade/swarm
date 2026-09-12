import { describe, expect, it } from "bun:test";
import {
  DEFAULT_TEAM_SETUP,
  inviteLink,
  mintTeamSecret,
  parseInvite,
  parseTeamSetup,
  renderTeamSetup,
  teamSetupEnv,
  withTeamUrl,
} from "./teamsetup";

describe("team setup (M13.12)", () => {
  it("round-trips a shared-secret team through the file", () => {
    const s = { ...DEFAULT_TEAM_SETUP, name: "Acme", port: 7900, token: "swt_abc" };
    const text = renderTeamSetup(s);
    expect(text).toContain('mode = "token"');
    expect(text).toContain('token = "swt_abc"');
    expect(parseTeamSetup(text)).toEqual(s);
    expect(teamSetupEnv(s)).toEqual({
      SWARM_TEAM_HOST: "0.0.0.0",
      SWARM_TEAM_PORT: "7900",
      SWARM_TEAM_TOKEN: "swt_abc",
    });
  });

  it("round-trips an OIDC team and never writes the other mode's keys", () => {
    const s = {
      ...DEFAULT_TEAM_SETUP,
      mode: "oidc" as const,
      issuer: "https://id.example",
      clientId: "swarm",
      token: null,
    };
    const text = renderTeamSetup(s);
    expect(text).not.toContain("token =");
    expect(parseTeamSetup(text)).toEqual(s);
    expect(teamSetupEnv(s)).toMatchObject({
      SWARM_TEAM_OIDC_ISSUER: "https://id.example",
      SWARM_TEAM_OIDC_CLIENT_ID: "swarm",
    });
  });

  it("survives junk, comments and an empty file", () => {
    expect(parseTeamSetup(null)).toEqual(DEFAULT_TEAM_SETUP);
    expect(parseTeamSetup("")).toEqual(DEFAULT_TEAM_SETUP);
    const messy = `# a note\nport = 99999\nmode = "nonsense"\nnotakey = 1\n\nname = 'Lab'  # inline\n`;
    const out = parseTeamSetup(messy);
    expect(out.port).toBe(DEFAULT_TEAM_SETUP.port); // out of range → default
    expect(out.mode).toBe("token");
    expect(out.name).toBe("Lab");
  });

  it("builds an invite link and accepts every shape people paste", () => {
    const link = inviteLink("http://nas.local:7878/", "swt_abc");
    expect(link).toBe("swarm+team://join?url=http%3A%2F%2Fnas.local%3A7878&token=swt_abc");
    expect(parseInvite(link)).toEqual({ url: "http://nas.local:7878", token: "swt_abc" });
    expect(parseInvite(inviteLink("http://nas.local:7878"))).toEqual({
      url: "http://nas.local:7878",
      token: null,
    });
    expect(parseInvite("  https://swarm.example.internal/  ")).toEqual({
      url: "https://swarm.example.internal",
      token: null,
    });
    expect(parseInvite("http://nas.local:7878#swt_xyz")).toEqual({
      url: "http://nas.local:7878",
      token: "swt_xyz",
    });
    expect(parseInvite("nas.local")).toEqual({ url: "http://nas.local:7878", token: null });
    expect(parseInvite("nas.local:9000")).toEqual({ url: "http://nas.local:9000", token: null });
    expect(parseInvite("")).toBeNull();
    expect(parseInvite("not a url at all")).toBeNull();
    expect(parseInvite("swarm+team://join?token=only")).toBeNull();
  });

  it("mints a secret that is not guessable", () => {
    const a = mintTeamSecret();
    expect(a).toMatch(/^swt_[0-9a-f]{32}$/);
    expect(a).not.toBe(mintTeamSecret());
  });

  it("writes, replaces and clears [team] url without disturbing the rest", () => {
    const base = "[daemon]\nport = 7777\n";
    const added = withTeamUrl(base, "https://swarm.example");
    expect(added).toBe('[daemon]\nport = 7777\n\n[team]\nurl = "https://swarm.example"\n');
    const replaced = withTeamUrl(added, "http://nas.local:7878");
    expect(replaced).toBe('[daemon]\nport = 7777\n\n[team]\nurl = "http://nas.local:7878"\n');
    // other keys in the section survive, and clearing leaves the section in place
    const withForward = '[team]\nurl = "http://x"\nforward = ["ledger"]\n';
    expect(withTeamUrl(withForward, null)).toBe('[team]\n\nforward = ["ledger"]\n');
    expect(withTeamUrl("", null)).toBe("");
  });
});
