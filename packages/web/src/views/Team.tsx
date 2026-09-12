/**
 * Team (M13.12): host a team, or join one, without a terminal.
 *
 * Hosting starts the source-available `swarm-teamd` on this machine and hands back an invite link;
 * joining takes that link. Everything else on this page is the forwarder's own status, which used
 * to be readable only through `swarm doctor`.
 */
import { useState } from "react";
import {
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
    <div className="perm">
      <div className="perm-t">Invite link — a teammate pastes this into their Team panel</div>
      <div className="perm-c">{invite}</div>
      <div className="perm-b">
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

function HostForm({ busy, run }: RunProps) {
  const [port, setPort] = useState("7878");
  return (
    <>
      <Section title="Host a team" spaced hint="runs swarm-teamd on this machine" />
      <div className="perm">
        <div className="perm-c">
          A shared secret is minted for you; every teammate joins with the invite link. The team
          daemon is source-available (FSL-1.1-ALv2) and ships separately from this Apache-2.0
          bundle: it runs from a clone, or from <code>swarm-teamd</code> on your PATH.
        </div>
        <div className="perm-b">
          <label className="dim" htmlFor="team-port">
            port{" "}
            <input
              id="team-port"
              size={6}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              inputMode="numeric"
            />
          </label>
          <button
            type="button"
            className="ok"
            disabled={busy}
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
      <Section title="Join a team" spaced hint="paste an invite link, a URL, or a host name" />
      <div className="perm">
        <div className="perm-b stdin">
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
      </div>
    </>
  );
}

function Leave({ data, busy, run }: RunProps & { data: TeamStatus }) {
  return (
    <div className="perm">
      <div className="perm-b">
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
      <Section
        title="Team"
        hint={
          data.configured
            ? `forwarding to ${data.url}`
            : "one machine is free and needs no account — a team is a second person"
        }
      />
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
          <HostForm busy={busy} run={run} />
          <JoinForm busy={busy} run={run} />
        </>
      )}
      {result && !result.ok && <Empty>{result.error}</Empty>}
    </>
  );
}
