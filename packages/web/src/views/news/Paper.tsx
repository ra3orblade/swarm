/**
 * The news as a paper (M14.11): a dateline for each day, newest first, and under it the day's
 * articles set in tiers as a front page is — the first two as heroes across the width, the next
 * three as features in a row, the rest as briefs in as many columns as fit.
 *
 * Each card is the link to the article, whole, and lights under the pointer; the app's delegated
 * click handler hands the URL to the real browser, and the click also marks the item read. The
 * picture is the one the feed gave, or the article page's own Open Graph picture the daemon read
 * once; it comes from the publisher's host, lazily and without a referrer, and one that fails to
 * load leaves no hole.
 */
import type { NewsItemView } from "@swarm/core/newsfeed";
import { Badge } from "../../components/ui";
import { KIND_LABEL } from "./columns";
import { byDay, dayLabel, inTiers, relativeDay, type Tier } from "./tiers";

export function NewsPaper({
  items,
  onRead,
}: {
  items: readonly NewsItemView[];
  onRead: (key: string) => void;
}) {
  const days = byDay(items);
  return (
    <div className="paper">
      {days.map(({ day, items: articles }) => (
        <section key={day || "undated"} className="paper-day">
          <h3>
            <span>{day ? dayLabel(day) : "Undated"}</span>
            {day && <span className="paper-ago">{relativeDay(day)}</span>}
          </h3>
          {inTiers(articles).map((row) => (
            <div key={row.items[0]?.key ?? row.tier} className={`paper-row ${row.tier}`}>
              {row.items.map((item) => (
                <NewsCard key={item.key} item={item} tier={row.tier} onRead={onRead} />
              ))}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function NewsCard({
  item,
  tier,
  onRead,
}: {
  item: NewsItemView;
  tier: Tier;
  onRead: (key: string) => void;
}) {
  const cls = ["paper-card", tier, item.image && "with-picture", !item.read && "unread"]
    .filter(Boolean)
    .join(" ");
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cls}
      onClick={() => {
        if (!item.read) onRead(item.key);
      }}
    >
      {item.image && (
        <span className="paper-picture">
          <img
            src={item.image}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(e) => e.currentTarget.parentElement?.remove()}
          />
        </span>
      )}
      <p className="paper-kicker">
        <span>{item.feed}</span>
        <span className="paper-kind">{KIND_LABEL[item.kind]}</span>
      </p>
      <h4 className="paper-headline">{item.title}</h4>
      {item.summary && <p className="paper-summary">{item.summary}</p>}
      {item.matched.length > 0 && (
        <p className="paper-tags">
          {item.matched.map((k) => (
            <Badge key={k} tone="acc">
              {k}
            </Badge>
          ))}
        </p>
      )}
    </a>
  );
}
