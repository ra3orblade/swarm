/**
 * The dashboard's data grid (M11.4) — sortable, resizable, reorderable, filterable columns with a
 * column-visibility menu, laid out per table and remembered across reloads.
 *
 * Ported from `table.js`, which built one HTML string and then made it interactive with six
 * document-level listeners keyed by `data-` attributes, because the rows it had attached to were
 * replaced on every repaint. Here the handlers belong to the elements, and the grid is generic over
 * its row type: `columns` are checked against the data they render, so a column reading a field
 * that no longer exists is a compile error rather than an empty cell.
 */
import { type ReactNode, useMemo, useRef, useState } from "react";
import { icon } from "../lib/icon";
import { menuSection, openMenu } from "../lib/menus";
import { type GridLayout, useGridLayoutStore } from "../state/gridLayout";

/** One column: how to render a cell, and what value to sort and filter it by. */
export interface Column<Row> {
  key: string;
  label: string;
  /** Fixed width in px. Omit with `flex` to absorb the remaining space. */
  width?: number;
  /** Take the leftover width. `table-layout: fixed` gives it whatever the others do not use. */
  flex?: boolean;
  /** Right-align, for numbers. */
  num?: boolean;
  /** Extra class on every cell in the column. */
  cls?: string;
  sortable?: boolean;
  filterable?: boolean;
  /** The value to sort and filter on. Omit for a column that is neither. */
  get?: (row: Row) => string | number | null | undefined;
  cell: (row: Row) => ReactNode;
}

/** A fixed, non-configurable edge column — a status dot on the left, row actions on the right. */
export interface EdgeColumn<Row> {
  width: number;
  cell: (row: Row) => ReactNode;
}

/** Everything a grid needs. `id` is the identity of the saved layout, so it must be stable. */
export interface DataGridProps<Row> {
  /** Stable identity for the saved layout. Changing it forgets the user's columns. */
  id: string;
  columns: Column<Row>[];
  rows: Row[];
  leading?: EdgeColumn<Row>;
  trailing?: EdgeColumn<Row>;
  rowKey: (row: Row) => string;
  onRowClick?: (row: Row) => void;
  /** Rendered when there are no rows at all, in place of the built-in line. */
  empty?: ReactNode;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Merge the saved layout with the column defaults, dropping keys that no longer exist. */
function resolveOrder<Row>(columns: Column<Row>[], layout: GridLayout): Column<Row>[] {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const known = layout.order?.filter((k) => byKey.has(k)) ?? [];
  const rest = columns.filter((c) => !known.includes(c.key)).map((c) => c.key);
  const hidden = new Set(layout.hidden ?? []);
  return [...known, ...rest]
    .map((k) => byKey.get(k))
    .filter((c): c is Column<Row> => c !== undefined && !hidden.has(c.key));
}

function compare(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return collator.compare(String(a), String(b));
}

export function DataGrid<Row>({
  id,
  columns,
  rows,
  leading,
  trailing,
  rowKey,
  onRowClick,
  empty,
}: DataGridProps<Row>) {
  const layout = useGridLayoutStore((s) => s.tables[id]) ?? {};
  const update = useGridLayoutStore((s) => s.update);
  const reset = useGridLayoutStore((s) => s.reset);
  const visible = useMemo(() => resolveOrder(columns, layout), [columns, layout]);

  const view = useMemo(() => {
    const filters = Object.entries(layout.filters ?? {})
      .map(([key, raw]) => [columns.find((c) => c.key === key), raw.trim().toLowerCase()] as const)
      .filter(([column, needle]) => column !== undefined && needle !== "");

    let result = rows;
    if (filters.length > 0) {
      result = result.filter((row) =>
        filters.every(([column, needle]) =>
          String(column?.get?.(row) ?? "")
            .toLowerCase()
            .includes(needle),
        ),
      );
    }

    const sort = layout.sort;
    const column = sort ? columns.find((c) => c.key === sort.key) : undefined;
    if (sort && column?.get) {
      const direction = sort.dir === "desc" ? -1 : 1;
      // Keys are computed once per row — `get` may format — then the rows are sorted by them.
      const keyed = result.map((row) => ({ row, key: column.get?.(row) }));
      keyed.sort((x, y) => compare(x.key, y.key) * direction);
      result = keyed.map((k) => k.row);
    }
    return result;
  }, [rows, columns, layout.filters, layout.sort]);

  const toggleSort = (key: string) =>
    update(id, (l) => {
      const current = l.sort;
      if (!current || current.key !== key) return { ...l, sort: { key, dir: "asc" } };
      // Third click clears the sort rather than cycling back to ascending.
      if (current.dir === "asc") return { ...l, sort: { key, dir: "desc" } };
      return { ...l, sort: null };
    });

  const setFilter = (key: string, value: string) =>
    update(id, (l) => {
      const filters = { ...(l.filters ?? {}) };
      if (value) filters[key] = value;
      else delete filters[key];
      return { ...l, filters };
    });

  const columnCount = visible.length + (leading ? 1 : 0) + (trailing ? 1 : 0);
  const filtering = Object.values(layout.filters ?? {}).some(Boolean);

  return (
    <div className="card grid" data-tid={id}>
      <table className="dt">
        <thead>
          <tr>
            {leading && <th style={{ width: leading.width }} />}
            {visible.map((column) => (
              <HeaderCell
                key={column.key}
                id={id}
                column={column}
                sort={layout.sort ?? null}
                width={
                  layout.widths?.[column.key] ?? (column.flex ? undefined : (column.width ?? 100))
                }
                onSort={toggleSort}
              />
            ))}
            {trailing && (
              <th style={{ width: trailing.width }} className="th-tools">
                <ColumnsButton
                  id={id}
                  columns={columns}
                  layout={layout}
                  onReset={() => reset(id)}
                />
              </th>
            )}
          </tr>
          {layout.showFilters && (
            <tr className="filters">
              {leading && <th />}
              {visible.map((column) => (
                <th key={column.key}>
                  {column.filterable !== false && (
                    <input
                      value={layout.filters?.[column.key] ?? ""}
                      placeholder={column.label}
                      onChange={(e) => setFilter(column.key, e.target.value)}
                    />
                  )}
                </th>
              ))}
              {trailing && <th />}
            </tr>
          )}
        </thead>
        <tbody>
          {view.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              style={onRowClick ? { cursor: "pointer" } : undefined}
            >
              {leading && <td className="td-lead">{leading.cell(row)}</td>}
              {visible.map((column) => (
                <td
                  key={column.key}
                  className={[column.num ? "num" : "", column.cls ?? ""].filter(Boolean).join(" ")}
                >
                  {column.cell(row)}
                </td>
              ))}
              {trailing && <td className="td-tools">{trailing.cell(row)}</td>}
            </tr>
          ))}
          {view.length === 0 && (
            <tr className="tbl-empty">
              <td colSpan={columnCount}>
                {empty ?? `No rows${filtering ? " match the filters" : ""}.`}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

interface HeaderCellProps<Row> {
  id: string;
  column: Column<Row>;
  sort: { key: string; dir: "asc" | "desc" } | null;
  width: number | undefined;
  onSort: (key: string) => void;
}

/**
 * One column header: click to sort, drag the body to reorder, drag the right edge to resize.
 *
 * Resizing writes the width straight to the element while the pointer moves and commits to the
 * store on release — a store write per mouse-move would re-render every row in the grid to move
 * one border.
 */
function HeaderCell<Row>({ id, column, sort, width, onSort }: HeaderCellProps<Row>) {
  const update = useGridLayoutStore((s) => s.update);
  const cell = useRef<HTMLTableCellElement>(null);
  const [dragging, setDragging] = useState(false);
  const sortable = column.sortable !== false && column.get !== undefined;

  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const th = cell.current;
    if (!th) return;
    const startX = event.clientX;
    const startWidth = th.offsetWidth;
    let latest = startWidth;
    document.body.classList.add("col-resizing");

    const onMove = (move: PointerEvent) => {
      latest = Math.max(MIN_COLUMN_PX, startWidth + (move.clientX - startX));
      th.style.width = `${latest}px`;
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.classList.remove("col-resizing");
      update(id, (l) => ({ ...l, widths: { ...(l.widths ?? {}), [column.key]: latest } }));
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  const drop = (event: React.DragEvent) => {
    event.preventDefault();
    const moved = event.dataTransfer.getData("text/grid-column");
    if (!moved || moved === column.key) return;
    update(id, (l) => {
      const order = [...(l.order ?? [])];
      if (!order.includes(moved) || !order.includes(column.key)) return l;
      order.splice(order.indexOf(moved), 1);
      order.splice(order.indexOf(column.key), 0, moved);
      return { ...l, order };
    });
  };

  return (
    <th
      ref={cell}
      className={[column.num ? "num" : "", dragging ? "dragging" : ""].filter(Boolean).join(" ")}
      style={width === undefined ? undefined : { width }}
      data-col={column.key}
      draggable
      title={`${column.label} — click to sort, drag to reorder, drag the edge to resize`}
      // A sortable header is a control, so it answers to the keyboard and announces its state.
      // The vanilla grid was mouse-only; `aria-sort` is what a screen reader reads out.
      {...(sortable
        ? {
            role: "button" as const,
            tabIndex: 0,
            "aria-sort": ariaSort(sort, column.key),
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onSort(column.key);
            },
          }
        : {})}
      onClick={sortable ? () => onSort(column.key) : undefined}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/grid-column", column.key);
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={drop}
    >
      <span className="th-l">
        {column.label}
        {sort?.key === column.key && <i className={`sort ${sort.dir}`} />}
      </span>
      <span className="th-grip" onPointerDown={startResize} />
    </th>
  );
}

const MIN_COLUMN_PX = 40;

/** What a screen reader announces for this column's sort state. */
function ariaSort(
  sort: { key: string; dir: "asc" | "desc" } | null,
  key: string,
): "ascending" | "descending" | "none" {
  if (sort?.key !== key) return "none";
  return sort.dir === "asc" ? "ascending" : "descending";
}

interface ColumnsButtonProps<Row> {
  id: string;
  columns: Column<Row>[];
  layout: GridLayout;
  onReset: () => void;
}

/** The sliders button: filter toggle, layout reset, and one entry per column. */
function ColumnsButton<Row>({ id, columns, layout, onReset }: ColumnsButtonProps<Row>) {
  const update = useGridLayoutStore((s) => s.update);
  const hidden = new Set(layout.hidden ?? []);

  const open = (event: React.MouseEvent<HTMLSpanElement>) =>
    openMenu(event.currentTarget, [
      {
        label: layout.showFilters ? "Hide filters" : "Show filters",
        icon: "magnifying-glass",
        run: () => update(id, (l) => ({ ...l, showFilters: !l.showFilters })),
      },
      { label: "Reset layout", icon: "arrows-clockwise", run: onReset },
      menuSection("Columns"),
      ...columns.map((column) => ({
        label: column.label.charAt(0).toUpperCase() + column.label.slice(1),
        ...(hidden.has(column.key) ? {} : { icon: "check" }),
        run: () =>
          update(id, (l) => {
            const next = new Set(l.hidden ?? []);
            if (next.has(column.key)) next.delete(column.key);
            else next.add(column.key);
            return { ...l, hidden: [...next] };
          }),
      })),
    ]);

  // A real <button>: the columns menu is a control, and the vanilla <span> could not be tabbed to.
  return (
    <button type="button" className="th-cols" title="Columns" aria-label="Columns" onClick={open}>
      {icon("sliders", 14)}
    </button>
  );
}
