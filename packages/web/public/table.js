// Reusable data-grid for the dashboard tables: sortable, resizable, reorderable, filterable
// columns with a column-visibility menu — all state persisted per-table in localStorage.
//
// Usage (app.js):
//   dataTable({ id, columns, rows, leading?, trailing?, rerender })  -> HTML string
// Columns: { key, label, width, min?, num?, sortable?(=true), filterable?(=true),
//            get(row)->sortable/filterable value, cell(row)->html }
// leading/trailing: fixed (non-configurable) edge columns { width, cell(row)->html }.
// `rerender` is called after any state change so the caller can re-render its view.

(() => {
  const LS = (id) => `swarm.table.${id}`;
  // Persisted state per grid: localStorage is read once per id, then written through on every mutation.
  const cache = new Map();
  const load = (id) => {
    let st = cache.get(id);
    if (!st) {
      try {
        st = JSON.parse(localStorage.getItem(LS(id)) || "{}");
      } catch {
        st = {};
      }
      cache.set(id, st);
    }
    return st;
  };
  const save = (id, st) => {
    cache.set(id, st);
    localStorage.setItem(LS(id), JSON.stringify(st));
  };
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const registry = new Map(); // id -> { columns, leading, trailing, rerender }

  // Merge persisted state with the column defaults, dropping keys that no longer exist.
  function resolve(id, columns) {
    const st = load(id);
    const keys = columns.map((c) => c.key);
    const order = (st.order || keys).filter((k) => keys.includes(k));
    for (const k of keys) if (!order.includes(k)) order.push(k);
    return {
      sort: st.sort && keys.includes(st.sort.key) ? st.sort : null,
      widths: st.widths || {},
      hidden: (st.hidden || []).filter((k) => keys.includes(k)),
      order,
      filters: st.filters || {},
      showFilters: !!st.showFilters,
    };
  }

  function dataTable({ id, columns, rows, leading, trailing, rerender, rowAttrs }) {
    registry.set(id, { columns, leading, trailing, rerender });
    const st = resolve(id, columns);
    const byKey = Object.fromEntries(columns.map((c) => [c.key, c]));
    const visible = st.order.map((k) => byKey[k]).filter((c) => c && !st.hidden.includes(c.key));

    // ---- sort + filter the rows
    let view = rows;
    const needles = Object.entries(st.filters)
      .map(([k, raw]) => [byKey[k], String(raw || "").trim().toLowerCase()])
      .filter(([col, q]) => col && q);
    if (needles.length) view = view.filter((r) => needles.every(([col, q]) => String(col.get?.(r) ?? "").toLowerCase().includes(q)));
    const col = st.sort ? byKey[st.sort.key] : null;
    if (col) {
      // keys computed once per row (get() may format), then sort indices
      const dir = st.sort.dir === "desc" ? -1 : 1;
      const keys = view.map((r) => col.get?.(r));
      const idx = keys.map((_, i) => i);
      idx.sort((i, j) => {
        const x = keys[i],
          y = keys[j];
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        const c = typeof x === "number" && typeof y === "number" ? x - y : collator.compare(String(x), String(y));
        return c * dir;
      });
      view = idx.map((i) => view[i]);
    }

    // ---- header
    // A column marked flex gets no width (table-layout:fixed lets it absorb the remainder)
    // unless the user has explicitly resized it.
    const w = (c) => {
      const px = st.widths[c.key] ?? (c.flex ? null : (c.width ?? 100));
      return px ? `style="width:${px}px"` : "";
    };
    const arrow = (c) =>
      st.sort?.key === c.key ? `<i class="sort ${st.sort.dir}"></i>` : "";
    const th = (c) =>
      `<th ${c.num ? 'class="num" ' : ""}${w(c)} draggable="true" data-col="${c.key}" data-tid="${id}"` +
      `${c.sortable === false ? "" : ' data-sort="1"'} title="${esc(c.label)} — click to sort, drag to reorder, drag the edge to resize">` +
      `<span class="th-l">${esc(c.label)}${arrow(c)}</span>` +
      `<span class="th-grip" data-resize="${c.key}"></span></th>`;
    const lead = leading ? `<th style="width:${leading.width}px"></th>` : "";
    const trail = trailing
      ? `<th style="width:${trailing.width}px" class="th-tools"><span class="th-cols" data-cols="${id}" title="Columns">${window.icon ? window.icon("sliders", 14) : ""}</span></th>`
      : "";
    const head = `<tr>${lead}${visible.map(th).join("")}${trail}</tr>`;

    // ---- optional filter row
    const frow = st.showFilters
      ? `<tr class="filters">${leading ? "<th></th>" : ""}${visible
          .map((c) =>
            c.filterable === false
              ? "<th></th>"
              : `<th><input data-filter="${c.key}" data-tid="${id}" value="${esc(st.filters[c.key] || "")}" placeholder="${esc(c.label)}"></th>`,
          )
          .join("")}${trailing ? "<th></th>" : ""}</tr>`
      : "";

    // ---- body
    const body = view
      .map((r) => {
        const attrs = rowAttrs ? rowAttrs(r) : "";
        const lc = leading ? `<td>${leading.cell(r)}</td>` : "";
        const tc = trailing ? `<td class="td-tools">${trailing.cell(r)}</td>` : "";
        return `<tr ${attrs}>${lc}${visible.map((c) => `<td ${c.num || c.cls ? `class="${[c.num ? "num" : "", c.cls ?? ""].filter(Boolean).join(" ")}"` : ""}>${c.cell(r)}</td>`).join("")}${tc}</tr>`;
      })
      .join("");

    const ncols = visible.length + (leading ? 1 : 0) + (trailing ? 1 : 0);
    const empty = view.length ? "" : `<tr class="tbl-empty"><td colspan="${ncols}">No rows${Object.keys(st.filters).some((k) => st.filters[k]) ? " match the filters" : ""}.</td></tr>`;
    return `<div class="card grid" data-tid="${id}"><table class="dt"><thead>${head}${frow}</thead><tbody>${body}${empty}</tbody></table></div>`;
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const mutate = (id, fn) => {
    const st = load(id);
    fn(st);
    save(id, st);
    registry.get(id)?.rerender?.();
  };

  // ---------- delegated interactions (attached once) ----------
  // sort
  document.addEventListener("click", (e) => {
    const cols = e.target.closest?.("[data-cols]");
    if (cols) return openColumnsMenu(cols);
    const th = e.target.closest?.("th[data-sort]");
    if (!th || e.target.closest(".th-grip")) return;
    const id = th.dataset.tid,
      key = th.dataset.col;
    mutate(id, (st) => {
      const cur = st.sort;
      if (!cur || cur.key !== key) st.sort = { key, dir: "asc" };
      else if (cur.dir === "asc") st.sort = { key, dir: "desc" };
      else st.sort = null; // third click clears
    });
  });

  // filter input (debounced-ish via input event)
  document.addEventListener("input", (e) => {
    const inp = e.target.closest?.("input[data-filter]");
    if (!inp) return;
    const id = inp.dataset.tid,
      key = inp.dataset.filter,
      val = inp.value;
    const st = load(id);
    st.filters = st.filters || {};
    if (val) st.filters[key] = val;
    else delete st.filters[key];
    save(id, st);
    // re-render but keep focus + caret on the same filter input
    registry.get(id)?.rerender?.();
    const again = document.querySelector(`input[data-filter="${key}"][data-tid="${id}"]`);
    if (again) {
      again.focus();
      again.setSelectionRange(again.value.length, again.value.length);
    }
  });

  // resize + reorder (mousedown starts a drag; both tracked on document)
  let drag = null;
  document.addEventListener("mousedown", (e) => {
    const grip = e.target.closest?.(".th-grip");
    if (!grip) return;
    e.preventDefault();
    e.stopPropagation();
    const th = grip.closest("th");
    drag = { type: "resize", id: th.dataset.tid, key: grip.dataset.resize, startX: e.clientX, startW: th.offsetWidth, th };
    document.body.classList.add("col-resizing");
  });
  document.addEventListener("mousemove", (e) => {
    if (drag?.type !== "resize") return;
    const min = 40;
    const wpx = Math.max(min, drag.startW + (e.clientX - drag.startX));
    drag.w = wpx;
    if (drag.th) drag.th.style.width = `${wpx}px`; // live feedback without a full re-render
  });
  document.addEventListener("mouseup", () => {
    if (drag?.type === "resize" && drag.w) {
      const { id, key, w } = drag;
      mutate(id, (st) => {
        st.widths = st.widths || {};
        st.widths[key] = w;
      });
    }
    drag = null;
    document.body.classList.remove("col-resizing");
  });

  // reorder via native HTML5 drag on the <th>
  let dragCol = null;
  document.addEventListener("dragstart", (e) => {
    const th = e.target.closest?.("th[data-col]");
    if (!th || e.target.closest(".th-grip")) return;
    dragCol = { id: th.dataset.tid, key: th.dataset.col };
    e.dataTransfer.effectAllowed = "move";
    th.classList.add("dragging");
  });
  document.addEventListener("dragover", (e) => {
    const th = e.target.closest?.("th[data-col]");
    if (dragCol && th && th.dataset.tid === dragCol.id) e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    const th = e.target.closest?.("th[data-col]");
    if (!dragCol || !th || th.dataset.tid !== dragCol.id) return;
    e.preventDefault();
    const target = th.dataset.col;
    if (target === dragCol.key) return;
    mutate(dragCol.id, (st) => {
      const reg = registry.get(dragCol.id);
      const keys = reg.columns.map((c) => c.key);
      const order = (st.order || keys).filter((k) => keys.includes(k));
      for (const k of keys) if (!order.includes(k)) order.push(k);
      order.splice(order.indexOf(dragCol.key), 1);
      order.splice(order.indexOf(target), 0, dragCol.key);
      st.order = order;
    });
  });
  document.addEventListener("dragend", () => {
    for (const el of document.querySelectorAll("th.dragging")) el.classList.remove("dragging");
    dragCol = null;
  });

  // columns visibility + filter toggle menu
  function openColumnsMenu(anchor) {
    const id = anchor.dataset.cols;
    const reg = registry.get(id);
    if (!reg || !window.menus) return;
    const st = resolve(id, reg.columns);
    const items = [
      { label: st.showFilters ? "Hide filters" : "Show filters", icon: "magnifying-glass", run: () => mutate(id, (s) => (s.showFilters = !s.showFilters)) },
      { label: "Reset layout", icon: "arrows-clockwise", run: () => mutate(id, (s) => { s.order = undefined; s.widths = {}; s.hidden = []; s.sort = null; s.filters = {}; s.showFilters = false; }) },
      { section: "Columns" },
      ...reg.columns.map((c) => ({
        label: c.label.charAt(0).toUpperCase() + c.label.slice(1),
        icon: st.hidden.includes(c.key) ? undefined : "check",
        run: () =>
          mutate(id, (s) => {
            s.hidden = s.hidden || [];
            const i = s.hidden.indexOf(c.key);
            if (i >= 0) s.hidden.splice(i, 1);
            else s.hidden.push(c.key);
          }),
      })),
    ];
    window.menus.open(anchor, { items });
  }

  window.dataTable = dataTable;
})();
