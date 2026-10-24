/**
 * Columns of the News grid (M14.2), at module scope. The title is an external link: the app's
 * delegated click handler routes it through the desktop shell, so the webview never navigates.
 */
import type { NewsItemView, NewsKind } from "@swarm/core/newsfeed";
import type { Column } from "../../components/DataGrid";
import { Absent, Badge, type BadgeTone } from "../../components/ui";
import { ago } from "../../lib/format";

export const KIND_LABEL: Record<NewsKind, string> = {
  vendor: "vendor",
  authority: "authority",
  press: "press",
  ai: "AI",
};

const KIND_TONE: Record<NewsKind, BadgeTone> = {
  vendor: "acc",
  authority: "warn",
  press: "plain",
  ai: "ok",
};

export const NEWS_COLUMNS: Column<NewsItemView>[] = [
  {
    key: "published",
    label: "when",
    width: 76,
    get: (i) => i.published,
    cell: (i) => (
      <span className="dim" title={i.published}>
        {ago(i.published)}
      </span>
    ),
  },
  {
    key: "feed",
    label: "source",
    width: 170,
    get: (i) => i.feed,
    cell: (i) => <span className="clip">{i.feed}</span>,
  },
  {
    key: "kind",
    label: "kind",
    width: 90,
    get: (i) => i.kind,
    cell: (i) => <Badge tone={KIND_TONE[i.kind]}>{KIND_LABEL[i.kind]}</Badge>,
  },
  {
    key: "title",
    label: "article",
    flex: true,
    get: (i) => i.title,
    cell: (i) => (
      <a href={i.url} target="_blank" rel="noopener noreferrer" title={i.summary}>
        {i.title}
      </a>
    ),
  },
  {
    key: "matched",
    label: "names",
    width: 220,
    get: (i) => i.matched.join(" "),
    cell: (i) =>
      i.matched.length ? (
        <span className="clip" title={i.matched.join(", ")}>
          {i.matched.slice(0, 4).map((k) => (
            <span className="br" key={k}>
              {k}
            </span>
          ))}
        </span>
      ) : (
        <Absent />
      ),
  },
];
