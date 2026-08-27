/**
 * Paging controls under a grid (M11.4).
 *
 * A grid pages by default because the alternative is not "a long page" but a slow one: Incidents
 * can return 500 rows and the fleet grid grows without bound, and every row is real DOM that the
 * browser lays out on every poll. Paging is the performance fix, not a stylistic one.
 *
 * The page size is remembered per table alongside the column layout, and "All" is offered because
 * ⌘F over a whole table is sometimes exactly what you want.
 */
import { icon } from "../lib/icon";

/** Choices offered in the page-size control. 0 renders every row. */
export const PAGE_SIZES = [25, 50, 100, 0] as const;

export interface GridPagerProps {
  /** Rows after filtering — what is being paged, not what was fetched. */
  total: number;
  page: number;
  pageSize: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}

export function GridPager({ total, page, pageSize, onPage, onPageSize }: GridPagerProps) {
  const pages = pageSize > 0 ? Math.ceil(total / pageSize) : 1;

  // Hide the whole control only when the table is too small for paging to mean anything. The
  // condition must not depend on the *current* size: "All" makes `pages` 1, so hiding on that
  // removed the only control that could switch back off it — chosen once, stuck forever.
  const smallest = PAGE_SIZES[0];
  if (total <= smallest && pages <= 1) return null;
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = pageSize > 0 ? Math.min((page + 1) * pageSize, total) : total;

  return (
    <div className="gpager">
      <span className="dim">
        {pageSize > 0 ? (
          <>
            {from}–{to} of {total}
          </>
        ) : (
          <>{total} rows</>
        )}
      </span>

      {pages > 1 && (
        <>
          <button
            type="button"
            className="gp-btn"
            title="Previous page"
            aria-label="Previous page"
            disabled={page === 0}
            onClick={() => onPage(page - 1)}
          >
            {icon("arrow-left", 12)}
          </button>
          <span className="dim">
            {page + 1} / {pages}
          </span>
          <button
            type="button"
            className="gp-btn"
            title="Next page"
            aria-label="Next page"
            disabled={page + 1 >= pages}
            onClick={() => onPage(page + 1)}
          >
            {icon("arrow-right", 12)}
          </button>
        </>
      )}

      <span className="seg gp-size">
        {PAGE_SIZES.map((size) => (
          <button
            type="button"
            key={size}
            className={pageSize === size ? "on" : ""}
            title={size === 0 ? "Show every row" : `${size} rows per page`}
            onClick={() => onPageSize(size)}
          >
            {size === 0 ? "All" : size}
          </button>
        ))}
      </span>
    </div>
  );
}
