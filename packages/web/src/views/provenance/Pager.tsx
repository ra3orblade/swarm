/**
 * Newer/older paging under a ranked grid (M11.10).
 *
 * The rows are ordered worst-first, so a page really is the page that matters — which is why the
 * control says Newer/Older rather than pretending to be a page number.
 */
import type { Page } from "@swarm/core/provenance";
import { icon } from "../../lib/icon";

/** The current page, and where to go. */
export interface PagerProps {
  page: Page;
  onGo: (offset: number) => void;
}

export function Pager({ page, onGo }: PagerProps) {
  if (page.total <= page.limit) return null;
  const from = page.total ? page.offset + 1 : 0;
  const to = Math.min(page.offset + page.limit, page.total);
  const atStart = page.offset === 0;
  const atEnd = to >= page.total;

  return (
    <div className="chips pager">
      <button
        type="button"
        className={atStart ? "chip off" : "chip"}
        disabled={atStart}
        onClick={() => onGo(Math.max(0, page.offset - page.limit))}
      >
        {icon("arrow-left", 12)} Newer
      </button>
      <span className="dim">
        {from}–{to} of {page.total}
      </span>
      <button
        type="button"
        className={atEnd ? "chip off" : "chip"}
        disabled={atEnd}
        onClick={() => onGo(page.offset + page.limit)}
      >
        Older {icon("arrow-right", 12)}
      </button>
    </div>
  );
}
