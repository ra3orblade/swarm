/**
 * Team (M13.12): host a team, or join one, without a terminal.
 *
 * Hosting starts the source-available `swarm-teamd` on this machine and hands back an invite link;
 * joining takes that link. Everything else on this page is the forwarder's own status, which used
 * to be readable only through `swarm doctor`.
 */
import { useState } from "react";
import {
  fetchTeamd,
  hostTeam,
  joinTeam,
  leaveTeam,
  type TeamActionResult,
  type TeamStatus,
} from "../api/actions";
import { routes } from "../api/endpoints";
import { useResource } from "../api/useResource";
import { Badge, Empty, Failed, Loading, Section, Stat, StatRow } from "../components/ui";
import { copyText } from "../lib/copy";
import { ago } from "../lib/format";

function Invite({ invite, address }: { invite: string; address: string | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="card card-pad setup">
      <p>Invite link — a teammate pastes this into their Team panel.</p>
      <div className="perm-c">{invite}</div>
      <div className="setup-row">
        <button
          type="button"
          className="ok"
          onClick={async () => {
            setCopied(await copyText(invite));
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy invite"}
        </button>
        {!address && (
          <span className="dim">
            this machine has no network address — the link only works on this machine
          </span>
        )}
      </div>
    </div>
  );
}

function Forwarding({ data }: { data: TeamStatus }) {
  return (
    <StatRow>
      <Stat
        label="forwarding"
        value={data.pending ? `${data.pending} pending` : "in sync"}
        detail={data.oldest ? `oldest ${ago(data.oldest)}` : "nothing queued"}
        tone={data.lastError ? "hot" : undefined}
      />
      <Stat label="this machine" value={data.machine.name} detail={data.machine.id.slice(0, 8)} />
      <Stat
        label="credentials"
        value={data.authed ? "registered" : "not registered"}
        tone={data.authed ? undefined : "warm"}
      />
      <Stat
        label="role"
        value={data.hosting ? "hosting" : "member"}
        detail={data.hosting ? `pid ${data.pid} · port ${data.port}` : (data.url ?? "")}
      />
    </StatRow>
  );
}

interface RunProps {
  busy: boolean;
  run: (fn: () => Promise<TeamActionResult>) => void;
}

const FSL = "https://github.com/ra3orblade/swarm/blob/main/packages/team/LICENSE.md";

function HostForm({ busy, run, teamd }: RunProps & { teamd: TeamStatus["teamd"] }) {
  const [port, setPort] = useState("7878");
  return (
    <>
      <Section title="Host a team" spaced hint="runs swarm-teamd on this machine" />
      <div className="card card-pad setup">
        <p>A shared secret is minted for you; every teammate joins with the invite link.</p>
        {teamd === null ? (
          <p>
            Hosting runs <code>swarm-teamd</code>, the team daemon. It is source-available under the{" "}
            <a href={FSL} target="_blank" rel="noopener noreferrer">
              Functional Source License (FSL-1.1-ALv2)
            </a>
            , not the Apache-2.0 license of this app, so it is not bundled: download it for this
            machine (about 60 MB, checked against the release&apos;s checksums), or install it
            yourself — <code>npm i -g @ra3orblade/swarm-team</code>, or the{" "}
            <code>ghcr.io/ra3orblade/swarm-teamd</code> image on a server.{" "}
            <button type="button" disabled={busy} onClick={() => run(fetchTeamd)}>
              {busy ? "Downloading…" : "Accept the license and download"}
            </button>
          </p>
        ) : (
          <p className="dim">
            <code>swarm-teamd</code> is here (
            {teamd === "downloaded"
              ? "downloaded into ~/.swarm/bin"
              : teamd === "path"
                ? "on PATH"
                : "from this clone"}
            ); it is source-available under FSL-1.1-ALv2.
          </p>
        )}
        <div className="setup-row">
          <label htmlFor="team-port">port</label>
          <input
            id="team-port"
            size={6}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            inputMode="numeric"
          />
          <button
            type="button"
            className="ok"
            disabled={busy || teamd === null}
            onClick={() => run(() => hostTeam({ mode: "token", port: Number(port) || 7878 }))}
          >
            {busy ? "Starting…" : "Host a team"}
          </button>
        </div>
      </div>
    </>
  );
}

function JoinForm({ busy, run }: RunProps) {
  const [invite, setInvite] = useState("");
  const join = () => {
    if (invite.trim()) run(() => joinTeam({ invite }));
  };
  return (
    <>
      <Section title="Join a team" spaced hint="from whoever is hosting" />
      <div className="setup stdin">
        <input
          placeholder="swarm+team://join?url=… — or http://nas.local:7878"
          value={invite}
          onChange={(e) => setInvite(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") join();
          }}
        />
        <button type="button" className="ok" disabled={busy || !invite.trim()} onClick={join}>
          Join
        </button>
      </div>
    </>
  );
}

function Leave({ data, busy, run }: RunProps & { data: TeamStatus }) {
  return (
    <div className="setup setup-row">
      <button
        type="button"
        className="danger"
        disabled={busy}
        title="Stop forwarding. Your local ledger, claims and worktrees are untouched."
        onClick={() => run(() => leaveTeam(false))}
      >
        Leave the team
      </button>
      {data.hosting && (
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => run(() => leaveTeam(true))}
        >
          Leave and stop hosting
        </button>
      )}
    </div>
  );
}

export function Team() {
  const { data, error, reload } = useResource<TeamStatus>(routes.team());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TeamActionResult | null>(null);

  const run = (fn: () => Promise<TeamActionResult>) => {
    setBusy(true);
    void fn().then((r) => {
      setResult(r);
      setBusy(false);
      reload();
    });
  };

  if (error && !data) return <Failed error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  return (
    <>
      <Section title="Team" hint={data.configured ? `forwarding to ${data.url}` : "not set up"} />
      {!data.configured && (
        <div className="setup">
          <p>One machine is free and needs no account — a team is a second person.</p>
        </div>
      )}
      {data.configured && <Forwarding data={data} />}
      {data.lastError && (
        <p className="dim">
          <Badge tone="warn">last error</Badge> {data.lastError}
        </p>
      )}
      {data.hosting && data.invite && <Invite invite={data.invite} address={data.address} />}
      {data.configured ? (
        <Leave data={data} busy={busy} run={run} />
      ) : (
        <>
          <HostForm busy={busy} run={run} teamd={data.teamd} />
          <JoinForm busy={busy} run={run} />
        </>
      )}
      {result && !result.ok && <Empty>{result.error}</Empty>}
    </>
  );
}
