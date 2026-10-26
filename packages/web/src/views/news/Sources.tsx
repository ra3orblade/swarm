/**
 * News › Sources › Manage (M14.3): every feed the daemon knows, with its state, a switch for each,
 * and the format check for a URL you are about to add — in a window opened from the Sources menu.
 * The check runs the very reader the poller runs, so "it parsed here" means it will parse every
 * half hour.
 */
import {
  type FeedCheck,
  NEWS_KINDS,
  type NewsFeedState,
  type NewsFeedsReport,
  type NewsKind,
} from "@swarm/core/newsfeed";
import { useState } from "react";
import { checkFeed, switchFeed } from "../../api/actions";
import { routes } from "../../api/endpoints";
import { useResource } from "../../api/useResource";
import { Modal } from "../../components/Modal";
import { Absent, Badge, type BadgeTone, Failed, Loading } from "../../components/ui";
import { copyText } from "../../lib/copy";
import { ago } from "../../lib/format";
import { KIND_LABEL } from "./columns";

const STATE_ORDER: Record<string, number> = { error: 0, on: 1, pending: 2, off: 3 };

const STATE_TONE: Record<string, BadgeTone> = {
  on: "ok",
  error: "warn",
  off: "plain",
  pending: "plain",
};

function tomlFor(url: string, kind: NewsKind, title: string | null): string {
  const name = (title ?? "").replace(/"/g, "'").slice(0, 60) || "My source";
  return `[[security.feeds]]\nname = "${name}"\nurl = "${url}"\nkind = "${kind}"   # vendor | authority | press | ai`;
}

export function SourcesManager({ onClose }: { onClose: () => void }) {
  const { data, error, reload } = useResource<NewsFeedsReport>(routes.newsFeeds(), 30_000);
  const hint = data
    ? `${data.feeds.filter((f) => f.state === "on").length} on · ${data.feeds.filter((f) => f.state === "error").length} failing · ${data.feeds.filter((f) => f.state === "off").length} off`
    : undefined;
  return (
    <Modal title="News sources" glyph="broadcast" subtitle={hint} size="wide" onClose={onClose}>
      {error && !data ? (
        <Failed error={error} onRetry={reload} />
      ) : data ? (
        <SourcesBody data={data} reload={reload} />
      ) : (
        <Loading />
      )}
    </Modal>
  );
}

function SourcesBody({ data, reload }: { data: NewsFeedsReport; reload: () => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<FeedCheck | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const kinds = new Set(data.kinds);

  const check = async (u: string) => {
    setBusy(u);
    try {
      setResult(await checkFeed(u));
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (name: string, on: boolean) => {
    setBusy(name);
    try {
      const r = await switchFeed(name, on);
      setRefused(r.ok ? null : r.error);
    } catch (e) {
      setRefused((e as Error).message);
    } finally {
      setBusy(null);
      reload();
    }
  };

  // what is failing first, then what is read, then what is off; within a state the kinds in their order
  const feeds = [...data.feeds].sort(
    (a, b) =>
      (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) ||
      NEWS_KINDS.indexOf(a.kind) - NEWS_KINDS.indexOf(b.kind) ||
      a.name.localeCompare(b.name),
  );

  return (
    <>
      <p className="dim note">
        Built-ins ship with Swarm, yours go in <code>[[security.feeds]]</code>. A source switched
        off here is kept in <code>~/.swarm/settings.toml</code>; a built-in of a kind not in{" "}
        <code>[security] kinds</code> stays off whatever its switch says.
      </p>
      {refused && <p className="note bad">{refused}</p>}
      <table className="mini">
        <colgroup>
          <col style={{ width: "25%" }} />
          <col style={{ width: "10%" }} />
          <col style={{ width: "22%" }} />
          <col style={{ width: "8%" }} />
          <col style={{ width: "7%" }} />
          <col style={{ width: "11%" }} />
          <col style={{ width: "17%" }} />
        </colgroup>
        <thead>
          <tr>
            <th>source</th>
            <th>kind</th>
            <th>state</th>
            <th>format</th>
            <th className="num">items</th>
            <th>last read</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {feeds.map((f) => (
            <SourceRow
              key={f.url}
              f={f}
              switchable={f.source === "config" || kinds.has(f.kind)}
              busy={busy}
              offline={data.offline}
              onToggle={toggle}
              onCheck={check}
            />
          ))}
        </tbody>
      </table>

      <div className="setup-row">
        <label htmlFor="news-source-url">add a source</label>
        <input
          id="news-source-url"
          size={48}
          placeholder="https://vendor.example/security.rss"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && url.trim() && busy === null) void check(url.trim());
          }}
        />
        <button
          type="button"
          className="ok"
          disabled={!url.trim() || busy !== null || data.offline}
          onClick={() => check(url.trim())}
        >
          {busy === url.trim() && busy !== null ? "Checking…" : "Check"}
        </button>
        {data.offline && <span className="dim">SWARM_OFFLINE=1: nothing is fetched</span>}
      </div>
      {result && <CheckResult r={result} />}
    </>
  );
}

/** One source in the table: what it is, how its last read went, its switch and its check. */
function SourceRow({
  f,
  switchable,
  busy,
  offline,
  onToggle,
  onCheck,
}: {
  f: NewsFeedState;
  /** False for a built-in of a kind `[security] kinds` leaves out: no switch turns it on. */
  switchable: boolean;
  busy: string | null;
  offline: boolean;
  onToggle: (name: string, on: boolean) => void;
  onCheck: (url: string) => void;
}) {
  const off = f.state === "off";
  return (
    <tr>
      <td className="clip" title={f.url}>
        <b>{f.name}</b>
        {f.source === "config" && <span className="dim"> yours</span>}
      </td>
      <td>
        <Badge>{KIND_LABEL[f.kind]}</Badge>
      </td>
      <td className="clip" title={f.note || undefined}>
        <Badge tone={STATE_TONE[f.state] ?? "plain"}>{f.state}</Badge>
        {f.note && <span className="dim"> {f.note}</span>}
      </td>
      <td>{f.format ? <code>{f.format}</code> : <Absent />}</td>
      <td className="num">{f.items}</td>
      <td className="dim" title={f.lastOk ?? undefined}>
        {f.lastOk ? ago(f.lastOk) : <Absent />}
      </td>
      <td className="num">
        {switchable && (
          <button
            type="button"
            className="mini-act"
            disabled={busy !== null}
            onClick={() => onToggle(f.name, off)}
          >
            {busy === f.name ? "…" : off ? "Turn on" : "Turn off"}
          </button>
        )}
        <button
          type="button"
          className="mini-act"
          disabled={busy !== null || offline}
          onClick={() => onCheck(f.url)}
        >
          {busy === f.url ? "…" : "Check"}
        </button>
      </td>
    </tr>
  );
}

function CheckResult({ r }: { r: FeedCheck }) {
  const [copied, setCopied] = useState(false);
  const kind: NewsKind = "press";
  if (!r.ok) {
    return (
      <p className="note">
        <Badge tone="warn">{r.note}</Badge>{" "}
        <span className="dim">
          {r.url}
          {r.status !== null && ` · HTTP ${r.status}`}
          {r.contentType && ` · ${r.contentType.split(";")[0]}`}
        </span>
      </p>
    );
  }
  const toml = tomlFor(r.url, kind, r.title);
  return (
    <>
      <p className="note">
        <Badge tone="ok">{r.note}</Badge>{" "}
        <span className="dim">
          {r.title ?? r.url}
          {r.contentType && ` · ${r.contentType.split(";")[0]}`}
        </span>
      </p>
      <ul className="plainlist">
        {r.sample.map((i) => (
          <li key={i.url}>
            <span className="dim">{i.published ? ago(i.published) : "undated"}</span> {i.title}
          </li>
        ))}
      </ul>
      <pre className="mono">{toml}</pre>
      <div className="setup-row">
        <button
          type="button"
          className="ok"
          onClick={async () => {
            setCopied(await copyText(toml));
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy TOML"}
        </button>
        <span className="dim">
          paste into <code>~/.swarm/config.toml</code>; the daemon picks it up within a minute and
          reads the source on its next round. Change <code>kind</code> if it is not press.
        </span>
      </div>
    </>
  );
}
