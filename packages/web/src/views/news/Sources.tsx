/**
 * News › Sources (M14.3): every feed the daemon reads, with its state, and the format check for a
 * URL you are about to add. The check runs the very reader the poller runs, so "it parsed here"
 * means it will parse every half hour.
 */
import {
  type FeedCheck,
  NEWS_KINDS,
  type NewsFeedsReport,
  type NewsKind,
} from "@swarm/core/newsfeed";
import { useState } from "react";
import { checkFeed } from "../../api/actions";
import { routes } from "../../api/endpoints";
import { useResource } from "../../api/useResource";
import { Panel } from "../../components/Panel";
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

export function Sources() {
  const { data, error, reload } = useResource<NewsFeedsReport>(routes.newsFeeds(), 30_000);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<FeedCheck | null>(null);

  const check = async (u: string) => {
    setBusy(u);
    try {
      setResult(await checkFeed(u));
    } finally {
      setBusy(null);
    }
  };

  if (error && !data) return <Failed error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  const on = data.feeds.filter((f) => f.state === "on").length;
  const failing = data.feeds.filter((f) => f.state === "error").length;
  const off = data.feeds.filter((f) => f.state === "off").length;
  // what is failing first, then what is read, then what is off; within a state the kinds in their order
  const feeds = [...data.feeds].sort(
    (a, b) =>
      (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) ||
      NEWS_KINDS.indexOf(a.kind) - NEWS_KINDS.indexOf(b.kind) ||
      a.name.localeCompare(b.name),
  );

  return (
    <Panel
      title="Sources"
      hint={`${on} on · ${failing} failing · ${off} off · built-ins ship with Swarm, yours go in [[security.feeds]]`}
    >
      <table className="mini">
        <colgroup>
          <col style={{ width: "26%" }} />
          <col style={{ width: "10%" }} />
          <col style={{ width: "26%" }} />
          <col style={{ width: "8%" }} />
          <col style={{ width: "8%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "10%" }} />
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
            <tr key={f.url}>
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
                <button
                  type="button"
                  className="mini-act"
                  disabled={busy !== null || data.offline}
                  onClick={() => check(f.url)}
                >
                  {busy === f.url ? "…" : "Check"}
                </button>
              </td>
            </tr>
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
    </Panel>
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
