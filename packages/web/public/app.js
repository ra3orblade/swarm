const $ = (s) => document.querySelector(s);
// macOS desktop app signals its overlay title bar via ?chrome=inset (see src-tauri/lib.rs).
if (new URLSearchParams(location.search).get("chrome") === "inset") {
  document.documentElement.classList.add("chrome-inset");
  // The overlay title bar has no native drag region — drag the window from the header.
  const twin = () => window.__TAURI__?.window?.getCurrentWindow?.();
  const inert = (e) => e.target.closest("a,button,input,select");
  const hdr = document.querySelector("header");
  hdr?.addEventListener("mousedown", (e) => {
    if (e.button === 0 && !inert(e)) twin()?.startDragging?.();
  });
  hdr?.addEventListener("dblclick", (e) => {
    if (!inert(e)) twin()?.toggleMaximize?.();
  });
}
// UI zoom. The browser zooms natively; the desktop webview doesn't, so the app does it itself:
// ⌘/Ctrl + − 0 here (and the native View menu in src-tauri/lib.rs, which calls swarmZoom).
const ZOOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const isDesktop = () => Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__);
let lastZoomAt = 0;
window.swarmZoom = (dir) => {
  const now = Date.now();
  if (now - lastZoomAt < 80) return; // a native accelerator and the keydown can both fire — once is enough
  lastZoomAt = now;
  const cur = Number(localStorage.getItem("swarm.zoom")) || 1;
  let z = 1;
  if (dir !== 0) {
    const i = ZOOM_STEPS.findIndex((v) => Math.abs(v - cur) < 0.01);
    z = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, (i < 0 ? 3 : i) + dir))];
  }
  localStorage.setItem("swarm.zoom", String(z));
  document.documentElement.style.setProperty("--ui-zoom", String(z));
  document.documentElement.classList.toggle("zoomed", z !== 1);
};
{
  const z = Number(localStorage.getItem("swarm.zoom")) || 1;
  if (z !== 1) { document.documentElement.style.setProperty("--ui-zoom", String(z)); document.documentElement.classList.add("zoomed"); }
}
document.addEventListener("keydown", (ev) => {
  if (!isDesktop() || !(ev.metaKey || ev.ctrlKey) || ev.altKey) return;
  const k = ev.key;
  const dir = k === "=" || k === "+" ? 1 : k === "-" || k === "_" ? -1 : k === "0" ? 0 : null;
  if (dir === null) return;
  ev.preventDefault();
  window.swarmZoom(dir);
});
// `dirty`: a UI-side change (selection, view, filter) needs a render even when the daemon snapshot is unchanged.
const state = { projects: [], sessions: [], worktrees: {}, processes: [], spend: null, incidents: [], allIncidents: null, incFilter: "open", tasks: null, gates: null, runs: [], attribution: null, taskFilter: "ready", resources: [], prs: [], seq: 0, sel: null, session: null, log: [], turns: [], view: "fleet", agentFilter: null, dirty: true };

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ago = (iso) => { const d = (Date.now() - new Date(iso)) / 1000; return d < 60 ? `${d | 0}s` : d < 3600 ? `${(d / 60) | 0}m` : d < 86400 ? `${(d / 3600) | 0}h` : `${(d / 86400) | 0}d`; };
// p2 (zero-pad) is defined in viz.js, which loads first
const hhmm = (iso) => { const d = new Date(iso); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
const projName = (id) => state.projects.find((p) => p.id === id)?.name ?? (id === "p_unknown" ? "?" : id);
const short = (p) => String(p ?? "").replace(/^\/Users\/[^/]+/, "~");
const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n | 0));
const usd = (n) => (n == null ? '<span class="dim">—</span>' : `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`);
const model = (m) => (m ? m.replace(/^claude-/, "").replace(/-\d{8}$/, "") : "");
const sumBy = (arr, f) => arr.reduce((a, x) => a + (f(x) ?? 0), 0);
const leaseLeft = (iso) => { const d = (new Date(iso) - Date.now()) / 1000; if (d <= 0) return "expired"; return d < 3600 ? `${(d / 60) | 0}m left` : `${(d / 3600).toFixed(1)}h left`; };
const ic = (name, size = 14, cls = "") => (window.icon ? window.icon(name, size, cls) : "");
const kindIcon = (s) => ic(s.kind === "subagent" ? "tree-structure" : s.kind === "spawned" ? "play" : "keyboard", 13, "kind");
// pixel-art illustrations for empty states (crispEdges, theme-green; won't clash with icon packs)
function pixmap(rows, cell = 6) {
  const C = { X: "var(--acc)", g: "var(--c5,#7fb069)", d: "var(--c4,#2f7d4f)" };
  const w = Math.max(...rows.map((r) => r.length)) * cell;
  const h = rows.length * cell;
  let r = "";
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const f = C[row[x]];
      if (f) r += `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${f}"/>`;
    }
  });
  return `<svg class="px" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">${r}</svg>`;
}
const PX = {
  idle: () => pixmap([
    "   X  X   ",
    "   X  X   ",
    " XXXXXXXX ",
    " XXXXXXXX ",
    " X  XX  X ",
    " XXXXXXXX ",
    " XX    XX ",
    " XXXXXXXX ",
    "  X    X  ",
  ]),
  folder: () => pixmap([
    " XXXX     ",
    "XXXXXXXXXX",
    "XggggggggX",
    "XggggggggX",
    "XggggggggX",
    "XggggggggX",
    "XXXXXXXXXX",
  ]),
  clock: () => pixmap([
    "  XXXXX  ",
    " X     X ",
    "X   X   X",
    "X   X   X",
    "X   XXX X",
    "X       X",
    "X       X",
    " X     X ",
    "  XXXXX  ",
  ]),
};
// static <i data-icon> placeholders in index.html → inline SVG
for (const el of document.querySelectorAll("i[data-icon]")) el.outerHTML = ic(el.dataset.icon, 15);
// theme: "system" | "light" | "dark", persisted; CSS handles system via prefers-color-scheme
const getTheme = () => localStorage.getItem("swarm.theme") ?? "system";
const setTheme = (t) => { localStorage.setItem("swarm.theme", t); if (t === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t; };
setTheme(getTheme());
const copy = (text) => navigator.clipboard?.writeText(String(text ?? ""));
const tail = (p, n = 24) => { const t = short(p); return t.length > n ? `…${t.slice(-(n - 1))}` : t; };
const agentLabel = (a) => viz.agentName(a);
const agentBadge = (a) => (a ? `<span class="badge agent" style="color:${viz.agentColor(a)};background:color-mix(in srgb,${viz.agentColor(a)} 14%,transparent)">${esc(agentLabel(a))}</span>` : "");

// One render per animation frame, whatever triggered it (SSE, polls, clicks).
let raf = 0;
const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };
const touch = () => { state.dirty = true; schedule(); };
// Last snapshot body + last render time: an unchanged snapshot (same seq, same data) skips the render
// unless the UI changed, or `ago`-style cells are older than 30s.
let lastSnap = "", lastRenderAt = 0;
async function refresh() {
  const txt = await (await fetch("/v1/state")).text();
  const same = txt === lastSnap;
  if (!same) { lastSnap = txt; Object.assign(state, JSON.parse(txt)); }
  if (!state.version) fetch("/v1/health").then((r) => r.json()).then((h) => { state.version = h.version; maybeWhatsNew(); }).catch(() => {});
  let prsChanged = false;
  if (state.view === "prs" && !state.session) {
    const prs = await (await fetch("/v1/prs")).json().catch(() => state.prs ?? []);
    prsChanged = JSON.stringify(prs) !== JSON.stringify(state.prs);
    state.prs = prs;
  }
  let attrChanged = false;
  if (state.view === "spend" && state.sel && !state.session) {
    const a = await fetch(`/v1/attribution?project=${encodeURIComponent(state.sel)}`).then((r) => r.json()).catch(() => state.attribution);
    attrChanged = JSON.stringify(a) !== JSON.stringify(state.attribution);
    state.attribution = a;
  } else if (state.view === "spend" && !state.sel) {
    if (state.attribution) attrChanged = true;
    state.attribution = null;
  }
  let runsChanged = false;
  const openSpawned = state.session && state.sessions.find((x) => x.id === state.session)?.kind === "spawned";
  if (openSpawned || (state.view === "board" && !state.session) || (state.view === "fleet" && !state.session)) {
    const runs = await fetch("/v1/runs").then((r) => r.json()).catch(() => state.runs ?? []);
    runsChanged = JSON.stringify(runs) !== JSON.stringify(state.runs);
    state.runs = runs;
  }
  let tasksChanged = false;
  if (state.view === "board" && state.sel && !state.session) {
    const [t, g] = await Promise.all([
      fetch(`/v1/tasks?project=${encodeURIComponent(state.sel)}`).then((r) => r.json()).catch(() => state.tasks),
      fetch(`/v1/gates?project=${encodeURIComponent(state.sel)}`).then((r) => r.json()).catch(() => state.gates),
    ]);
    tasksChanged = JSON.stringify(t) !== JSON.stringify(state.tasks) || JSON.stringify(g) !== JSON.stringify(state.gates);
    state.tasks = t; state.gates = g;
  }
  let incChanged = false;
  if (state.view === "incidents" && !state.session) {
    const q = new URLSearchParams({ limit: "500" }); if (state.incFilter === "open") q.set("open", "1");
    const inc = await (await fetch(`/v1/incidents?${q}`)).json().catch(() => state.allIncidents ?? []);
    incChanged = JSON.stringify(inc) !== JSON.stringify(state.allIncidents);
    state.allIncidents = inc;
  }
  if (!same || prsChanged || incChanged || tasksChanged || runsChanged || attrChanged || state.dirty || Date.now() - lastRenderAt > 30_000) schedule();
}
const VIEWS = ["fleet", "board", "incidents", "prs", "timeline", "spend", "stats", "search"];
// restore last view + project selection (persisted UI state)
{
  const v = localStorage.getItem("swarm.view");
  if (VIEWS.includes(v)) state.view = v;
  const sel = localStorage.getItem("swarm.sel");
  if (sel) state.sel = sel;
  // Deep links win over persisted state: ?view=board&project=<id>&session=<id>
  const q = new URLSearchParams(location.search);
  if (VIEWS.includes(q.get("view"))) state.view = q.get("view");
  if (q.has("project")) state.sel = q.get("project") || null;
  // Mark the restored tab before the first snapshot lands, so the nav doesn't flash "Fleet".
  for (const a of document.querySelectorAll("header a[data-view]")) a.classList.toggle("on", a.dataset.view === state.view);
}
function render() {
  // Live refresh re-renders the whole view; keep focus + caret in a grid filter input alive.
  const af = document.activeElement;
  const keep = af?.dataset?.filter ? { key: af.dataset.filter, tid: af.dataset.tid, pos: af.selectionStart } : null;
  state.dirty = false;
  lastRenderAt = Date.now();
  if (!dragPid) renderProjects(); // a re-render mid-drag would yank the row out from under the cursor
  renderHeader();
  if (state.session) renderSession();
  else if (state.view === "spend") renderSpend();
  else if (state.view === "stats") { loadStats(); renderStats(); } // loadStats is a no-op while the cache is fresh
  else if (state.view === "search") renderSearch();
  else if (state.view === "timeline") renderTimeline();
  else if (state.view === "board") renderBoard();
  else if (state.view === "incidents") renderIncidentsView();
  else if (state.view === "prs") renderPRs();
  else renderFleet();
  if (keep) {
    const el = document.querySelector(`input[data-filter="${keep.key}"][data-tid="${keep.tid}"]`);
    if (el) { el.focus(); el.setSelectionRange(keep.pos, keep.pos); }
  }
}
let todayHtml = "";
function renderHeader() {
  const today = state.spend ? sumBy(state.spend.byProjectToday, (x) => x.cost) : 0;
  const html = `Today <b>${usd(today)}</b>`;
  if (html !== todayHtml) { todayHtml = html; $("#today").innerHTML = html; }
  const ic_ = $("#incCount"); const n = state.openIncidents ?? 0;
  if (ic_) { ic_.hidden = !n; ic_.textContent = n > 99 ? "99+" : String(n); }
  for (const a of document.querySelectorAll("header a[data-view]")) a.classList.toggle("on", !state.session && a.dataset.view === state.view);
}

const isLive = (s) => s.state === "active" || s.state === "waiting";
// One pass over sessions → live count per project (+ "" for all), instead of a filter per sidebar row.
function liveCounts() {
  const m = new Map();
  for (const s of state.sessions) if (isLive(s)) { m.set(s.projectId, (m.get(s.projectId) ?? 0) + 1); m.set("", (m.get("") ?? 0) + 1); }
  return m;
}
function renderProjects() {
  const lc = liveCounts();
  const live = (pid) => lc.get(pid) ?? 0;
  const pinned = state.projects.filter((p) => !p.discovered);
  const unpinned = state.projects.filter((p) => p.discovered);
  const nameCount = {};
  for (const p of state.projects) nameCount[p.name] = (nameCount[p.name] || 0) + 1;
  const disamb = (p) => {
    if ((nameCount[p.name] || 0) <= 1) return "";
    const parts = String(p.root || "").split("/").filter(Boolean);
    const parent = parts[parts.length - 2];
    return parent ? `<span class="pdir">${esc(parent)}/</span>` : "";
  };
  const row = (p) => {
    const act = `<span class="act more" data-menu="project" data-pid="${p.id}" title="Project actions">${ic("dots-three", 15)}</span>`;
    return `<div class="proj ${state.sel === p.id ? "sel" : ""}" data-id="${p.id}" data-ctx="project" data-pid="${p.id}" title="${esc(p.root)}"${p.discovered ? "" : ' draggable="true"'}>
      <span class="st ${live(p.id) ? "live" : ""}"></span>${ic("folder-simple", 14)}<span class="nm">${disamb(p)}${esc(p.name)}</span><small>${live(p.id) || ""}</small>${act}</div>`;
  };
  const liveAll = live("");
  $("#projects").innerHTML =
    `<h4>Projects <span class="h4-act" id="addProj" title="Add project">${ic("plus", 14)}</span></h4>` +
    `<div class="proj ${state.sel === null ? "sel" : ""}" data-id=""><span class="st ${liveAll ? "live" : ""}"></span>${ic("folders", 14)}<span class="nm">All projects</span><small>${liveAll || ""}</small></div>` +
    `<div id="pinned">${pinned.map(row).join("")}</div>` +
    (unpinned.length ? `<h4>Unpinned <span class="faint" style="text-transform:none;letter-spacing:0;font-weight:400">· seen, not pinned</span></h4>${unpinned.map(row).join("")}` : "") +
    (!pinned.length && !unpinned.length ? `<div class="empty" style="padding:16px;font-size:12px">${PX.folder()}No projects yet.<br>Add a folder below, or start Claude in one.</div>` : "");
}

// Pinned projects reorder by drag-and-drop (native DnD on the rows; order persists on the daemon).
let dragPid = null;
const projectsEl = $("#projects");
projectsEl.addEventListener("dragstart", (ev) => {
  const r = ev.target.closest?.(".proj[draggable]");
  if (!r) return;
  dragPid = r.dataset.pid;
  ev.dataTransfer.effectAllowed = "move";
  ev.dataTransfer.setData("text/plain", dragPid);
  requestAnimationFrame(() => r.classList.add("dragging")); // after the drag image is captured
});
projectsEl.addEventListener("dragover", (ev) => {
  if (!dragPid) return;
  const r = ev.target.closest?.(".proj[draggable]");
  if (!r || r.dataset.pid === dragPid) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = "move";
  const box = r.getBoundingClientRect();
  const before = ev.clientY < box.top + box.height / 2;
  const dragged = projectsEl.querySelector(`.proj[data-pid="${dragPid}"]`);
  if (dragged) r.parentNode.insertBefore(dragged, before ? r : r.nextSibling); // live reflow = the drop preview
});
projectsEl.addEventListener("drop", (ev) => { if (dragPid) ev.preventDefault(); });
projectsEl.addEventListener("dragend", () => {
  if (!dragPid) return;
  dragPid = null;
  const ids = [...projectsEl.querySelectorAll("#pinned .proj[draggable]")].map((r) => r.dataset.pid);
  const rank = new Map(ids.map((id, i) => [id, i]));
  for (const p of state.projects) if (rank.has(p.id)) p.order = rank.get(p.id);
  state.projects.sort((a, b) => Number(a.discovered) - Number(b.discovered) || (a.order ?? 1e9) - (b.order ?? 1e9) || a.name.localeCompare(b.name));
  renderProjects();
  fetch("/v1/projects/order", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) }).then(refresh);
});

// ---------- fleet
// Fleet data-grid columns (sortable/resizable/reorderable/filterable via table.js).
const FLEET_COLS = [
  { key: "project", label: "project", width: 104, get: (s) => projName(s.projectId), cell: (s) => esc(projName(s.projectId)) },
  { key: "agent", label: "agent", width: 84, cls: "td-badge", get: (s) => agentLabel(s.agent), cell: (s) => agentBadge(s.agent) },
  { key: "session", label: "session", width: 236, get: (s) => s.title ?? s.id, cell: (s) => `${kindIcon(s)}<b>${esc(s.title ?? s.id.slice(0, 8))}</b>${s.subagents ? ` <span class="badge acc">${s.subagents} Sub</span>` : ""}` },
  { key: "branch", label: "branch", width: 134, get: (s) => s.branch ?? "", cell: (s) => `<span class="br">${esc(s.branch ?? "")}</span>` },
  { key: "now", label: "now", flex: true, get: (s) => s.last, cell: (s) => `<span class="now" title="${esc(s.last)}">${esc(s.state === "waiting" ? (s.lastText ? s.lastText.split("\n")[0] : s.last) : s.last)}</span>` },
  { key: "model", label: "model", width: 96, get: (s) => model(s.model), cell: (s) => `<span class="br">${esc(model(s.model))}${s.models > 1 ? ` <span class="faint">+${s.models - 1}</span>` : ""}</span>` },
  { key: "trend", label: "trend", width: 100, sortable: false, filterable: false, get: () => null, cell: (s) => viz.sparkline(s.spark.map((p) => p[0]), viz.agentColor(s.agent)) },
  { key: "out", label: "out", width: 66, num: true, get: (s) => s.tokens.output, cell: (s) => tok(s.tokens.output) },
  { key: "ctx", label: "ctx", width: 72, num: true, get: (s) => s.tokens.cacheRead + s.tokens.input + s.tokens.cacheWrite, cell: (s) => tok(s.tokens.cacheRead + s.tokens.input + s.tokens.cacheWrite) },
  { key: "cost", label: "cost", width: 64, num: true, get: (s) => s.costUsd ?? 0, cell: (s) => usd(s.costUsd) },
  { key: "age", label: "age", width: 56, num: true, get: (s) => new Date(s.lastSeenAt).getTime(), cell: (s) => `<span class="dim">${ago(s.lastSeenAt)}</span>` },
];

function renderFleet() {
  const base = state.sessions.filter((s) => !state.sel || s.projectId === state.sel);
  const agentCount = new Map();
  for (const s of base) agentCount.set(s.agent, (agentCount.get(s.agent) ?? 0) + 1);
  const agents = [...agentCount.keys()].sort();
  const live = [], rest = [];
  for (const s of base) if (!state.agentFilter || s.agent === state.agentFilter) (isLive(s) ? live : rest).push(s);
  const cols = FLEET_COLS.filter((c) => !(c.key === "project" && state.sel));
  // Live and Earlier are separate grids: each keeps its own column order/widths/visibility.
  const table = (list, id) =>
    dataTable({
      id,
      columns: cols,
      rows: list,
      leading: { width: 24, cell: (s) => `<span class="s ${s.state}"></span>` },
      trailing: { width: 34, cell: (s) => `<span class="more" data-menu="session" data-sid="${s.id}" title="Session actions">${ic("dots-three", 15)}</span>` },
      rowAttrs: (s) => `data-s="${s.id}" data-ctx="session" data-sid="${s.id}"`,
      rerender: touch,
    });
  const chips = agents.length > 1
    ? `<div class="chips"><span class="chip ${!state.agentFilter ? "on" : ""}" data-agent="">All</span>${agents
        .map((a) => `<span class="chip ${state.agentFilter === a ? "on" : ""}" data-agent="${a}">${esc(agentLabel(a))} <b>${agentCount.get(a)}</b></span>`)
        .join("")}</div>`
    : "";
  $("#main").innerHTML = chips +
    `<h2>Live <span>${live.length} sessions · ${usd(sumBy(live, (s) => s.costUsd))}</span></h2>` +
    (live.length ? table(live, "fleet-live") : `<div class="empty">${PX.idle()}Nothing running.${state.sessions.length ? "" : "<br><br>Run <kbd>swarm install</kbd> once, then start <kbd>claude</kbd> in any folder — it will appear here."}</div>`) +
    (rest.length ? `<h2 class="mt-sec">Earlier <span>${rest.length}</span></h2>${table(rest.slice(0, 30), "fleet-earlier")}` : "") +
    "";
}

// ---------- PRs (one queue across GitHub + GitLab)
function renderPRs() {
  const rows = state.prs ?? [];
  const chk = (c) => c === "pass" ? '<span class="badge ok">Checks ✓</span>'
    : c === "fail" ? '<span class="badge warn">Checks ✗</span>'
    : c === "pending" ? '<span class="badge">Running…</span>' : '<span class="dim">—</span>';
  const rev = (r) => r === "approved" ? '<span class="badge ok">Approved</span>'
    : r === "changes" ? '<span class="badge warn">Changes</span>' : '<span class="dim">—</span>';
  const green = (p) => p.checks !== "fail" && p.mergeable && !p.draft;
  const cols = [
    { key: "repo", label: "repo", width: 170, get: (p) => p.repo, cell: (p) => `${ic(p.forge === "gitlab" ? "git-merge" : "git-pull-request", 13)} <span class="br">${esc(p.repo.split("/").pop())}</span>` },
    { key: "title", label: "title", flex: true, get: (p) => p.title, cell: (p) => `<a href="${esc(p.url)}" target="_blank" rel="noopener"><b>#${p.number}</b> ${esc(p.title)}</a>${p.draft ? ' <span class="badge">Draft</span>' : ""}` },
    { key: "branch", label: "branch", width: 170, get: (p) => p.branch, cell: (p) => `<span class="br">${esc(p.branch)}</span>` },
    { key: "author", label: "author", width: 110, get: (p) => p.author, cell: (p) => esc(p.author) },
    { key: "checks", label: "checks", width: 100, get: (p) => p.checks, cell: (p) => chk(p.checks) },
    { key: "review", label: "review", width: 100, get: (p) => p.review, cell: (p) => rev(p.review) },
    { key: "age", label: "age", width: 56, num: true, get: (p) => new Date(p.createdAt).getTime(), cell: (p) => `<span class="dim">${ago(p.createdAt)}</span>` },
  ];
  $("#main").innerHTML =
    `<h2>Pull requests <span>${rows.length} open · GitHub + GitLab, merged from here</span></h2>` +
    (rows.length
      ? dataTable({
          id: "prs",
          columns: cols,
          rows,
          leading: { width: 24, cell: (p) => `<span class="s ${p.checks === "fail" ? "waiting" : p.checks === "pass" ? "active" : "idle"}"></span>` },
          trailing: { width: 96, cell: (p) => (green(p) ? `<a href="#" data-merge="${p.projectId}:${p.number}" title="Squash-merge via ${p.forge === "gitlab" ? "glab" : "gh"}">Merge</a>` : "") },
          rowAttrs: () => "",
          rerender: touch,
        })
      : `<div class="empty">${PX.idle()}No open pull requests.<br>Agent branches land here the moment they're pushed.</div>`);
}

// ---------- board (coordination: claims, worktrees, incidents)
function renderBoard() {
  const parts = [renderTasks(), renderGates(), renderProcesses(), renderResources(), renderClaims(), renderWorktrees(), renderIncidents()].filter(Boolean);
  $("#main").innerHTML = parts.length
    ? parts.join("").replace(/^(<h2) class="mt-sec"/, "$1") // first section needs no top gap
    : `<div class="empty">${PX.idle()}Nothing on the board.<br>Tasks, processes, claims, worktrees, and incidents appear here.</div>`;
}

// Incident columns are shared by the Board section (open only, recent) and the Incidents view (feed).
function incidentColumns(full) {
  const sess = (id) => state.sessions.find((s) => s.id === id);
  return [
    { key: "ts", label: "when", width: 76, get: (i) => i.ts, cell: (i) => `<span class="dim" title="${esc(i.ts)}">${ago(i.ts)}</span>` },
    { key: "project", label: "project", width: 104, get: (i) => projName(i.projectId), cell: (i) => esc(projName(i.projectId)) },
    { key: "session", label: "session", width: 150, get: (i) => sess(i.sessionId)?.title ?? i.sessionId ?? "", cell: (i) => (i.sessionId ? `<a href="#" data-s="${i.sessionId}">${esc(sess(i.sessionId)?.title ?? i.sessionId.slice(0, 8))}</a>` : '<span class="dim">—</span>') },
    { key: "rule", label: "rule", width: 150, get: (i) => i.rule, cell: (i) => `<span class="br">${esc(i.rule ?? "")}</span>` },
    { key: "action", label: "action", width: 80, get: (i) => i.action, cell: (i) => (i.action === "deny" ? '<span class="badge warn">Denied</span>' : i.action === "orphaned" ? '<span class="badge warn">Orphaned</span>' : i.action === "failed" ? '<span class="badge warn">Failed</span>' : '<span class="badge acc">Asked</span>') },
    { key: "command", label: "command", flex: true, get: (i) => i.command, cell: (i) => `<span class="now" title="${esc(i.reason ?? "")}">${esc(i.command ?? "")}</span>` },
    ...(full ? [
      { key: "reason", label: "reason", width: 260, get: (i) => i.reason ?? "", cell: (i) => `<span class="dim now" title="${esc(i.reason ?? "")}">${esc(i.reason ?? "")}</span>` },
      { key: "acked", label: "acked", width: 80, get: (i) => i.acked ?? "", cell: (i) => (i.acked ? `<span class="dim" title="${esc(i.acked)}">${ago(i.acked)}</span>` : '<span class="badge warn">Open</span>') },
    ] : []),
  ].filter((c) => !(c.key === "project" && state.sel) && !(c.key === "session" && !full));
}
const incidentDot = (i) => `<span class="s ${i.acked ? "ended" : i.action === "deny" || i.action === "orphaned" || i.action === "failed" ? "waiting" : "idle"}"></span>`;
const ackLink = (i) => (i.acked ? "" : `<a href="#" data-ack="${i.seq}" title="Mark as seen">Ack</a>`);

function renderIncidents() {
  const rows = (state.incidents ?? []).filter((i) => !state.sel || i.projectId === state.sel);
  if (!rows.length) return "";
  const open = state.sel ? rows.length : (state.openIncidents ?? rows.length);
  return `<h2 class="mt-sec">Incidents <span>${open} open · what the rules stopped · <a href="#" data-view="incidents">all incidents</a></span></h2>` +
    dataTable({
      id: "incidents",
      columns: incidentColumns(false),
      rows,
      leading: { width: 24, cell: incidentDot },
      trailing: { width: 44, cell: ackLink },
      rowAttrs: (i) => (i.sessionId ? `data-s="${i.sessionId}"` : ""),
      rerender: touch,
    });
}

// M4.6: rule dry-run — replay this project's history under chosen modes; nothing is recorded.
const RULE_IDS = ["pattern_kill", "shared_tree", "destructive_git", "protected_ports", "no_foreign_worktree", "claim_required_to_write"];
const dry = { modes: {}, report: null, busy: false };
async function openDryRun() {
  if (!state.sel) return alert("Pick a project in the sidebar first — the dry-run replays one project's history.");
  dry.modes = {}; dry.report = null;
  await runDryRun();
}
async function runDryRun() {
  dry.busy = true; renderDryRun();
  const q = new URLSearchParams({ project: state.sel, ...dry.modes });
  dry.report = await fetch(`/v1/rules/dryrun?${q}`).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
  dry.busy = false; renderDryRun();
}
function renderDryRun() {
  const r = dry.report;
  const sel = (id) => {
    const cur = dry.modes[id] ?? r?.modes?.[id] ?? "ask";
    return `<label class="dr-rule"><span class="br">${id}</span><select data-drmode="${id}">${["ask", "deny", "off"].map((m) => `<option value="${m}" ${m === cur ? "selected" : ""}>${m}</option>`).join("")}</select>${r ? `<span class="dim">ask <b>${r.byRule[id].ask}</b> · deny <b>${r.byRule[id].deny}</b></span>` : ""}</label>`;
  };
  const flaky = (r?.flaky ?? []).map((f) => `<div class="dr-flaky"><code>${esc(f.display)}</code><div class="dim" style="font-size:var(--fs-sm)">${esc(f.suggestion)} · ${f.sessions} session${f.sessions === 1 ? "" : "s"}</div></div>`).join("");
  const hits = (r?.hits ?? []).slice(-40).reverse().map((h) => `<tr><td class="dim">${hhmm(h.ts)}</td><td><span class="br">${esc(h.rule)}</span></td><td>${h.action}</td><td><code>${esc(h.display)}</code></td><td class="dim">${h.completed ? "ran" : ""}</td></tr>`).join("");
  $("#picker").innerHTML = `<div class="pk wn" role="dialog" aria-modal="true">
    <div class="pk-h">${ic("shield", 15)}<b>Rule dry-run</b><span class="dim" style="margin-left:8px">${esc(projName(state.sel))}</span><span class="grow"></span><button id="pkCancel" title="Close">${ic("x", 14)}</button></div>
    <div class="pk-b">
      <p class="dim" style="font-size:var(--fs-sm)">Replays this project's recorded tool calls through the rules under the modes below — what <em>would</em> have been asked or denied. Nothing is recorded; change a mode and re-run to try a rule before switching it on in <code>.swarm.toml</code>.</p>
      <div class="dr-rules">${RULE_IDS.map(sel).join("")}</div>
      ${dry.busy ? '<p class="dim">replaying…</p>' : r?.error ? `<p class="dim">${esc(r.error)}</p>` : r ? `
      <div class="date">${r.evaluated} of ${r.calls} calls evaluated · ${r.hits.length}${r.hits.length >= 200 ? "+" : ""} hits</div>
      <h4>Flaky signals <span class="dim">rules that keep asking about something that is then allowed anyway</span></h4>
      ${flaky || '<p class="dim" style="font-size:var(--fs-sm)">None — every rule that fired stuck.</p>'}
      <h4>Would have fired <span class="dim">newest first, last 40</span></h4>
      ${hits ? `<div style="overflow-x:auto"><table class="plain"><tbody>${hits}</tbody></table></div>` : '<p class="dim" style="font-size:var(--fs-sm)">Nothing — these modes are silent on this history.</p>'}` : ""}
    </div>
    <div class="pk-f"><span class="grow"></span><button id="drRun" ${dry.busy ? "disabled" : ""}>Re-run</button><button id="pkCancel">Close</button></div>
  </div>`;
}

// ---------- incidents view (M2.3): the denied-action feed, with ack
// M4.3: turn an incident into a .swarm.toml rule + a CLAUDE.md lesson, both copyable.
function codifyIncident(seq) {
  const i = (state.allIncidents ?? []).find((x) => x.seq === Number(seq));
  if (!i?.suggestion) return;
  const sg = i.suggestion;
  $("#picker").innerHTML = `<div class="pk wn" role="dialog" aria-modal="true">
    <div class="pk-h">${ic("shield", 15)}<b>Codify</b><span class="grow"></span><button id="pkCancel" title="Close">${ic("x", 14)}</button></div>
    <div class="pk-b">
      <h3>${esc(sg.title)}</h3>
      <div class="date">from a <span class="br">${esc(i.rule)}</span> incident${i.count > 1 ? ` \u00b7 seen ${i.count}\u00d7` : ""}</div>
      ${sg.toml ? `<h4>.swarm.toml <a href="#" class="cbtn" data-copy-toml="${seq}">${ic("copy", 12)} copy</a></h4><pre class="snip" id="toml-${seq}">${esc(sg.toml)}</pre>` : ""}
      <h4>CLAUDE.md lesson <a href="#" class="cbtn" data-copy-lesson="${seq}">${ic("copy", 12)} copy</a></h4>
      <pre class="snip" id="lesson-${seq}">- ${esc(sg.lesson)}</pre>
      ${sg.toml ? '<p class="dim" style="font-size:var(--fs-sm)">Merge the block into the repo\'s <code>.swarm.toml</code>; the daemon picks it up within ~30s.</p>' : '<p class="dim" style="font-size:var(--fs-sm)">No config rule fits this one \u2014 the lesson is the takeaway.</p>'}
    </div>
    <div class="pk-f"><span class="grow"></span><button id="pkCancel">Close</button></div>
  </div>`;
}

function renderIncidentsView() {
  const all = state.allIncidents;
  const rows = (all ?? []).filter((i) => !state.sel || i.projectId === state.sel);
  const open = rows.filter((i) => !i.acked).length;
  const chip = (k, label) => `<span class="chip ${state.incFilter === k ? "on" : ""}" data-inc="${k}">${label}</span>`;
  const byRule = new Map();
  for (const i of rows) byRule.set(i.rule, (byRule.get(i.rule) ?? 0) + 1);
  const rules = [...byRule.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `<span class="br">${esc(r)}</span> <b>${n}</b>`).join(" · ");
  $("#main").innerHTML =
    `<h2>Incidents <span>${all === null ? "loading…" : `${open} open · ${rows.length} shown`} · every ask/deny the rules made${rules ? ` · ${rules}` : ""}</span></h2>` +
    `<div class="chips">${chip("open", "Open")}${chip("all", "All")}${open ? `<span class="chip" data-ackall="1" title="Mark every open incident${state.sel ? " in this project" : ""} as seen">Ack all <b>${open}</b></span>` : ""}${state.sel ? `<span class="chip" id="dryrun" title="Replay this project's history under different rule modes">${ic("shield", 12)} Dry-run rules</span>` : ""}</div>` +
    (rows.length
      ? dataTable({
          id: "incidents-feed",
          columns: incidentColumns(true),
          rows,
          leading: { width: 24, cell: incidentDot },
          trailing: { width: 120, cell: (i) => `${i.suggestion ? `<a href="#" data-codify="${i.seq}" title="Turn this into a rule / lesson">${ic("shield", 12)} Codify</a> ` : ""}${ackLink(i)}` },
          rowAttrs: () => "",
          rerender: touch,
        })
      : `<div class="empty">${PX.idle()}${state.incFilter === "open" ? "No open incidents." : "No incidents yet."}<br>Every <code>ask</code> or <code>deny</code> a rule makes lands here; ack it once you've seen it.</div>`);
}

// PROCESSES: what `swarm serve` / `swarm proc` started — pid-tracked, stoppable by pid only.
function renderProcesses() {
  const rows = (state.processes ?? []).filter((r) => !state.sel || r.projectId === state.sel);
  if (!rows.length) return "";
  const cols = [
    { key: "name", label: "process", width: 150, get: (r) => r.name, cell: (r) => `<b>${esc(r.name)}</b>` },
    { key: "kind", label: "kind", width: 80, get: (r) => r.kind, cell: (r) => `<span class="badge">${esc(r.kind)}</span>` },
    { key: "project", label: "project", width: 104, get: (r) => projName(r.projectId), cell: (r) => esc(projName(r.projectId)) },
    { key: "pid", label: "pid", width: 76, num: true, get: (r) => r.pid, cell: (r) => r.pid },
    { key: "port", label: "port", width: 70, num: true, get: (r) => r.port ?? 0, cell: (r) => (r.port != null ? `<a href="http://127.0.0.1:${r.port}/" target="_blank" rel="noopener">:${r.port}</a>` : '<span class="dim">—</span>') },
    { key: "owner", label: "owner", width: 110, get: (r) => r.owner, cell: (r) => esc(r.owner) },
    { key: "cmd", label: "command", flex: true, get: (r) => r.cmd, cell: (r) => `<span class="now" title="${esc(r.cwd)}">${esc(r.cmd)}</span>` },
    { key: "up", label: "up", width: 64, get: (r) => r.startedAt, cell: (r) => `<span class="dim">${ago(r.startedAt)}</span>` },
  ].filter((c) => !(c.key === "project" && state.sel));
  return `<h2 class="mt-sec">Processes <span>${rows.length} · started through swarm serve / proc</span></h2>` +
    dataTable({
      id: "processes",
      columns: cols,
      rows,
      leading: { width: 24, cell: () => '<span class="s active"></span>' },
      trailing: { width: 60, cell: (r) => `<a href="#" data-procstop="${r.pid}" data-procproj="${esc(r.projectId)}" title="SIGTERM, then SIGKILL after 3 s">Stop</a>` },
      rowAttrs: () => "",
      rerender: touch,
    });
}

function renderResources() {
  const rows = (state.resources ?? []).filter((r) => !state.sel || r.projectId === state.sel || r.projectId === null);
  if (!rows.length) return "";
  const cols = [
    { key: "name", label: "resource", width: 170, get: (r) => r.name, cell: (r) => `<b>${esc(r.name)}</b>` },
    { key: "kind", label: "kind", width: 90, get: (r) => r.kind, cell: (r) => `<span class="badge">${esc(r.kind)}</span>` },
    { key: "project", label: "project", width: 104, get: (r) => (r.projectId ? projName(r.projectId) : "global"), cell: (r) => (r.projectId ? esc(projName(r.projectId)) : '<span class="dim">global</span>') },
    { key: "owner", label: "owner", width: 130, get: (r) => r.owner, cell: (r) => esc(r.owner) },
    { key: "pid", label: "pid", width: 76, num: true, get: (r) => r.pid ?? 0, cell: (r) => (r.pid ?? '<span class="dim">—</span>') },
    { key: "port", label: "port", width: 76, num: true, get: (r) => r.port ?? 0, cell: (r) => (r.port ?? '<span class="dim">—</span>') },
    { key: "held", label: "held", flex: true, get: (r) => r.acquiredAt, cell: (r) => `<span class="dim">${ago(r.acquiredAt)}${r.expiresAt ? ` · lease ${leaseLeft(r.expiresAt)}` : r.pid ? " · pid-tracked" : ""}</span>` },
  ].filter((c) => !(c.key === "project" && state.sel));
  return `<h2>Resources <span>${rows.length} held · ports auto-protected</span></h2>` +
    dataTable({
      id: "resources",
      columns: cols,
      rows,
      leading: { width: 24, cell: () => '<span class="s active"></span>' },
      trailing: { width: 90, cell: (r) => `<a href="#" data-resrelease="${esc(r.name)}" data-resproj="${esc(r.projectId ?? "")}">Release</a>` },
      rerender: touch,
    });
}

// Gate chips: ✓ pass / ✗ fail / — never run, latest run on hover.
const gateChips = (gates) => gates.map((g) => {
  const cls = g.verdict === "pass" ? "ok" : g.verdict === "fail" ? "warn" : "";
  const mark = g.verdict === "pass" ? "✓" : g.verdict === "fail" ? "✗" : "—";
  return `<span class="badge ${cls}" title="${esc(g.gate)}: ${g.runs} run${g.runs === 1 ? "" : "s"}, ${g.fails} fail${g.fails === 1 ? "" : "s"}">${esc(g.gate)} ${mark}</span>`;
}).join(" ") || '<span class="dim">—</span>';

// RECENT GATES: verification runs on this project (M2.2). Only with a project selected.
function renderGates() {
  if (!state.sel || !state.gates) return "";
  const runs = state.gates.runs ?? [];
  const required = state.gates.required ?? [];
  if (!runs.length && !required.length) return "";
  const sess = (id) => state.sessions.find((s) => s.id === id);
  const cols = [
    { key: "ts", label: "when", width: 76, get: (r) => r.createdAt, cell: (r) => `<span class="dim" title="${esc(r.createdAt)}">${ago(r.createdAt)}</span>` },
    { key: "task", label: "task", width: 110, get: (r) => r.task, cell: (r) => `<b>${esc(r.task)}</b>` },
    { key: "gate", label: "gate", width: 120, get: (r) => r.gate, cell: (r) => `<span class="br">${esc(r.gate)}</span>` },
    { key: "verdict", label: "verdict", width: 80, get: (r) => r.verdict, cell: (r) => (r.verdict === "pass" ? '<span class="badge ok">Pass</span>' : '<span class="badge warn">Fail</span>') },
    { key: "rubric", label: "rubric", flex: true, get: (r) => r.rubric, cell: (r) => `<span class="now" title="${esc(r.rubric)}">${esc(r.rubric)}</span>` },
    { key: "evidence", label: "evidence", width: 220, get: (r) => r.evidence ?? "", cell: (r) => (r.evidence ? `<span class="dim now" title="${esc(r.evidence)}">${esc(r.evidence)}</span>` : '<span class="dim">—</span>') },
    { key: "session", label: "session", width: 140, get: (r) => sess(r.sessionId)?.title ?? "", cell: (r) => (r.sessionId ? `<a href="#" data-s="${r.sessionId}">${esc(sess(r.sessionId)?.title ?? r.sessionId.slice(0, 8))}</a>` : '<span class="dim">—</span>') },
  ];
  return `<h2 class="mt-sec">Recent gates <span>${runs.length} run${runs.length === 1 ? "" : "s"}${required.length ? ` · required: ${required.map(esc).join(", ")}` : ""} · latest run per gate decides</span></h2>` +
    (runs.length
      ? dataTable({
          id: "gates",
          columns: cols,
          rows: runs.slice(0, 50),
          leading: { width: 24, cell: (r) => `<span class="s ${r.verdict === "fail" ? "waiting" : "active"}"></span>` },
          trailing: { width: 12, cell: () => "" },
          rowAttrs: () => "",
          rerender: touch,
        })
      : `<div class="empty">${PX.idle()}No gate runs yet. <code>swarm gate record &lt;task&gt; ${esc(required[0] ?? "review")} pass --rubric "…"</code></div>`);
}

// TASKS: the project's backlog from `.swarm.toml [tasks] source` (M1.6). Only with a project selected.
function renderTasks() {
  if (!state.sel || !state.tasks?.source) return "";
  const all = state.tasks.tasks ?? [];
  const ready = all.filter((t) => t.ready);
  const hasGates = (state.tasks.required ?? []).length > 0 || all.some((t) => (t.gates ?? []).length);
  const rows = state.taskFilter === "ready" ? ready : state.taskFilter === "open" ? all.filter((t) => t.status !== "done") : all;
  const chip = (k, label, n) => `<span class="chip ${state.taskFilter === k ? "on" : ""}" data-task-filter="${k}">${label}${n != null ? ` <b>${n}</b>` : ""}</span>`;
  const st = (t) => t.claimedBy ? `<span class="badge ok">Held · ${esc(t.claimedBy)}</span>`
    : t.status === "done" ? '<span class="badge">Done</span>'
    : t.status === "active" ? '<span class="badge acc">In progress</span>'
    : t.ready ? '<span class="badge ok">Ready</span>' : '<span class="badge">Blocked</span>';
  const cols = [
    { key: "id", label: "id", width: 70, get: (t) => t.id, cell: (t) => `<b>${esc(t.id)}</b>` },
    { key: "title", label: "task", flex: true, get: (t) => t.title, cell: (t) => `<span class="now" title="${esc(t.statusText)}">${esc(t.title)}</span>` },
    { key: "milestone", label: "milestone", width: 160, get: (t) => t.milestone ?? "", cell: (t) => `<span class="dim now">${esc((t.milestone ?? "").split(" — ")[0])}</span>` },
    { key: "depends", label: "depends", width: 130, get: (t) => t.depends.join(" "), cell: (t) => `<span class="br">${esc(t.depends.join(" ")) || "—"}</span>` },
    { key: "state", label: "state", width: 150, get: (t) => (t.claimedBy ? 0 : t.ready ? 1 : t.status === "active" ? 2 : t.status === "done" ? 4 : 3), cell: st },
    ...(hasGates ? [{ key: "gates", label: "gates", width: 170, get: (t) => (t.gates ?? []).filter((g) => g.verdict === "pass").length, cell: (t) => gateChips(t.gates ?? []) }] : []),
  ];
  const srcLabel = state.tasks.source === "github" ? "GitHub Issues" : state.tasks.source === "linear" ? "Linear" : state.tasks.source;
  return `<h2 class="mt-sec">Tasks <span>${ready.length} ready · ${all.length} in ${esc(srcLabel)}${state.tasks.error ? ` · <span class="badge warn" title="${esc(state.tasks.error)}">${ic("warning", 12)} ${esc(state.tasks.error)}</span>` : ""}</span></h2>` +
    `<div class="chips">${chip("ready", "Ready", ready.length)}${chip("open", "Open", all.filter((t) => t.status !== "done").length)}${chip("all", "All", all.length)}</div>` +
    (rows.length
      ? dataTable({
          id: "tasks",
          columns: cols,
          rows,
          leading: { width: 24, cell: (t) => `<span class="s ${t.claimedBy ? "active" : t.ready ? "waiting" : "idle"}"></span>` },
          trailing: { width: 170, cell: (t) => (t.ready ? `<a href="#" data-run="${esc(t.id)}" title="Claim and spawn claude -p in a worktree">${ic("play", 12)} Run</a> · <a href="#" data-claim="${esc(t.id)}" title="Claim into a fresh worktree">Claim</a>` : t.claimedBy ? `<a href="#" data-run="${esc(t.id)}" title="Spawn claude -p in the held worktree">${ic("play", 12)} Run</a>${(state.gates?.executable ?? []).length ? ` · <a href="#" data-gaterun="${esc(t.id)}" title="Execute the repo's [gates.<name>] cmd gates in this task's worktree: ${esc((state.gates.executable ?? []).join(", "))}">${ic("check", 12)} Gates</a>` : ""}` : "") },
          rowAttrs: () => "",
          rerender: touch,
        })
      : `<div class="empty">${PX.idle()}${state.taskFilter === "ready" ? "Nothing ready — every open task is blocked or held." : "No tasks."}</div>`);
}

function renderClaims() {
  const rows = (state.claims ?? []).filter((c) => c.state !== "released" && (!state.sel || c.projectId === state.sel));
  if (!rows.length) return "";
  const order = { orphaned: 0, expired: 1, held: 2 };
  rows.sort((a, b) => (order[a.state] ?? 3) - (order[b.state] ?? 3));
  const badge = (st) => st === "orphaned" ? '<span class="badge warn">Orphaned · holds work</span>' : st === "expired" ? '<span class="badge acc">Expired</span>' : '<span class="badge ok">Held</span>';
  const orphans = rows.filter((c) => c.state === "orphaned").length;
  const cols = [
    { key: "project", label: "project", width: 104, get: (c) => projName(c.projectId), cell: (c) => esc(projName(c.projectId)) },
    { key: "task", label: "task", width: 140, get: (c) => c.task, cell: (c) => `<b>${esc(c.task)}</b>` },
    { key: "owner", label: "owner", width: 120, get: (c) => c.owner || "", cell: (c) => esc(c.owner || "—") },
    { key: "lease", label: "lease", width: 130, get: (c) => (c.state === "held" ? new Date(c.expiresAt).getTime() : 0), cell: (c) => `<span class="dim">${c.state === "held" ? leaseLeft(c.expiresAt) : "—"}</span>` },
    { key: "worktree", label: "worktree", flex: true, get: (c) => c.worktree, cell: (c) => `<span class="now" title="${esc(c.worktree)}">${esc(short(c.worktree))}</span>` },
    { key: "state", label: "state", width: 150, get: (c) => c.state, cell: (c) => badge(c.state) },
  ].filter((c) => !(c.key === "project" && state.sel));
  return `<h2 class="mt-sec">Claims <span>${rows.length}${orphans ? ` · ${orphans} orphaned` : ""}</span></h2>` +
    dataTable({
      id: "claims",
      columns: cols,
      rows,
      leading: { width: 24, cell: (c) => `<span class="s ${c.state === "orphaned" ? "waiting" : c.state === "expired" ? "idle" : "active"}"></span>` },
      trailing: { width: 120, cell: (c) => {
        const key = `${c.projectId}:${c.task}`;
        return c.state === "orphaned"
          ? `<a href="#" data-forcerelease="${key}" title="Discards the worktree AND its uncommitted work">Force release</a>`
          : `<a href="#" data-release="${key}">Release</a>`;
      } },
      rerender: touch,
    });
}

function renderWorktrees() {
  const ids = state.sel ? [state.sel] : state.projects.map((p) => p.id);
  const rows = ids.flatMap((id) => (state.worktrees[id] ?? []).map((w) => ({ ...w, projectId: id })));
  if (!rows.length) return "";
  // worktree path → sessions inside it, built once (not per cell, per row)
  const byPath = new Map(rows.map((w) => [w.path, []]));
  const paths = [...byPath.keys()];
  for (const s of state.sessions) {
    if (s.state === "ended") continue;
    for (const p of paths) if (s.cwd === p || s.cwd.startsWith(`${p}/`)) byPath.get(p).push(s);
  }
  const inside = (w) => byPath.get(w.path);
  const badge = (n, label, cls) => (n > 0 ? `<span class="badge ${cls}">${n} ${label}</span>` : "");
  const cols = [
    { key: "project", label: "project", width: 104, get: (w) => projName(w.projectId), cell: (w) => esc(projName(w.projectId)) },
    { key: "branch", label: "branch", width: 240, get: (w) => w.branch ?? "", cell: (w) => `<span class="br">${esc(w.branch ?? "(detached)")}</span>${w.main ? ' <span class="badge">Main tree</span>' : ""}` },
    { key: "head", label: "head", width: 90, get: (w) => w.head, cell: (w) => `<span class="br">${esc(w.head)}</span>` },
    { key: "path", label: "path", flex: true, get: (w) => w.path, cell: (w) => `<span class="now" title="${esc(w.path)}">${esc(short(w.path))}</span>` },
    { key: "state", label: "state", width: 170, get: (w) => w.dirty * 1000 + w.ahead, cell: (w) => `${badge(w.dirty, "Dirty", "warn")}${badge(w.ahead, "Unpushed", "acc")}${w.dirty === 0 && w.ahead <= 0 ? '<span class="badge">Clean</span>' : ""}` },
    { key: "drift", label: "drift", width: 120, get: (w) => (w.main ? -1 : w.behind), cell: (w) => (w.main ? "" : w.merged ? '<span class="badge" title="This branch is already in the main checkout\'s branch">Merged</span>' : w.behind > 0 ? `<span class="badge warn" title="Commits on the main checkout\'s branch this worktree lacks">${w.behind} behind</span>` : w.behind === 0 ? '<span class="badge">Up to date</span>' : '<span class="dim">—</span>') },
    { key: "sessions", label: "sessions", width: 160, get: (w) => inside(w).length, cell: (w) => inside(w).map((x) => `<a href="#" data-s="${x.id}">${esc(x.title ?? x.id.slice(0, 8))}</a>`).join(", ") || '<span class="dim">—</span>' },
  ].filter((c) => !(c.key === "project" && state.sel));
  const heldBy = new Map(state.claims ? state.claims.filter((c) => c.state === "held").map((c) => [c.worktree, c.task]) : []);
  const actions = (w) => {
    const key = `${w.projectId}:${w.path}`;
    const open = `<a href="#" data-wtopen="${esc(key)}" title="Open this worktree (editor / file manager; [worktree] open in .swarm.toml)">${ic("arrow-square-out", 12)} Open</a>`;
    if (w.main) return open;
    const diff = ` · <a href="#" data-wtdiff="${esc(key)}" title="What this worktree changed vs the main checkout's branch">${ic("folders", 12)} Diff</a>`;
    const pr = w.branch && !w.merged ? ` · <a href="#" data-wtpr="${esc(key)}" title="Push the branch and open a PR prefilled from the task, handoff, gates and files">${ic("git-pull-request", 12)} PR</a>` : "";
    if (heldBy.has(w.path)) return `${open}${diff}${pr}`;
    return `${open}${diff}${pr} · <a href="#" data-wtrm="${esc(key)}" title="${w.dirty > 0 || w.ahead > 0 ? "Refuses while dirty / unpushed (you can force)" : "git worktree remove"}">${ic("trash", 12)} Remove</a>`;
  };
  const gcBtn = state.sel ? ` <a href="#" class="nav" id="wtgc" title="Find worktrees whose branch is merged or whose claim is gone">${ic("trash", 12)} Collect stale</a>` : "";
  const newBtn = state.sel ? ` <a href="#" class="nav" id="wtnew" title="Create a task-less worktree (spike, review checkout)">${ic("plus", 12)} New worktree</a>` : "";
  return `<h2 class="mt-sec hrow">Worktrees <span>${rows.length}</span>${newBtn}${gcBtn}</h2>` +
    dataTable({
      id: "worktrees",
      columns: cols,
      rows,
      leading: { width: 24, cell: (w) => `<span class="s ${inside(w).length ? "active" : w.dirty > 0 ? "waiting" : "ended"}"></span>` },
      trailing: { width: 230, cell: actions },
      rerender: touch,
    });
}

// ---------- spend
function renderSpend() {
  const sp = state.spend;
  if (!sp) return;
  const inSel = (x) => !state.sel || x.projectId === state.sel;
  const filt = (arr) => (state.sel ? arr.filter((x) => x.key === state.sel) : arr);
  // last N days, zero-filled, stacked by agent
  const N = state.spendDays ?? 14;
  const days = [];
  for (let i = N - 1; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(viz.localDay(d)); }
  const inRange = sp.daily.filter((d) => inSel(d) && d.day >= days[0]);
  const today = days.at(-1);
  // one pass: "day|agent" → cost, plus the headline sums
  const cell = new Map(), agentSet = new Set(), active = new Set();
  let total14 = 0, todayCost = 0, todayTurns = 0;
  for (const d of inRange) {
    const k = `${d.day}|${d.agent}`, c = d.cost ?? 0;
    cell.set(k, (cell.get(k) ?? 0) + c);
    agentSet.add(d.agent);
    total14 += c;
    if (c) active.add(d.day);
    if (d.day === today) { todayCost += c; todayTurns += d.turns ?? 0; }
  }
  const agents = [...agentSet].sort(viz.agentSort);
  const series = Object.fromEntries(agents.map((a) => [a, days.map((day) => cell.get(`${day}|${a}`) ?? 0)]));
  const activeDays = active.size;
  const prevDays = activeDays - (active.has(today) ? 1 : 0);
  const avg = prevDays ? (total14 - todayCost) / prevDays : 0;
  const rangeChips = `<span class="seg" style="margin-left:auto">${[7, 14, 30, 90].map((n) => `<a href="#" class="${N === n ? "on" : ""}" data-days="${n}">${n}d</a>`).join("")}</span>`;
  const byAgentToday = state.sel ? null : sp.byAgentToday;
  const kpi = (l, v, d) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
  // Tables of the same shape share one grid id (sort/widths apply to both today/all-time).
  const tbl = (rows, label, name, color) =>
    dataTable({
      id: `spend-${label}`,
      columns: [
        { key: "key", label, flex: true, get: (r) => name(r.key), cell: (r) => `${color ? `<i class="sw" style="background:${color(r.key)}"></i>` : ""}${esc(name(r.key))}` },
        { key: "cost", label: "cost", width: 88, num: true, get: (r) => r.cost ?? 0, cell: (r) => usd(r.cost) },
        { key: "input", label: "in+cache", width: 88, num: true, get: (r) => r.input ?? 0, cell: (r) => tok(r.input) },
        { key: "output", label: "out", width: 84, num: true, get: (r) => r.output ?? 0, cell: (r) => tok(r.output) },
        { key: "turns", label: "turns", width: 64, num: true, get: (r) => r.turns ?? 0, cell: (r) => String(r.turns) },
      ],
      rows: rows.slice().sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)),
      trailing: { width: 34, cell: () => "" },
      rerender: touch,
    });
  const hm = sp.hourly.filter(inSel).map((c) => ({ dow: c.dow, hour: c.hour, v: c.cost ?? 0 }));
  $("#main").innerHTML =
    `<h2>Spend <span>${state.sel ? esc(projName(state.sel)) : "all projects"}</span>${rangeChips}</h2>
     <div class="kpis">${kpi("today", usd(todayCost), `${todayTurns} turns`)}${kpi(`${N}-day total`, usd(total14), `${activeDays} active day${activeDays === 1 ? "" : "s"}`)}${kpi("today vs avg", prevDays ? `${todayCost >= avg ? "+" : ""}${(((todayCost - avg) / avg) * 100).toFixed(0)}%` : "—", prevDays ? `vs ${usd(avg)} / active day` : "no earlier days to compare")}${kpi("agents", agents.length, agents.map(agentLabel).join(" · ") || "—")}</div>
     <div class="chart-card"><h3>Daily cost · last ${N} days <span>stacked by agent</span></h3>${viz.stackedColumns(days, series)}${agents.length > 1 ? viz.legend(agents) : ""}</div>
     <div class="cols">
       <div class="chart-card" style="margin:0"><h3>When the agents work <span>cost by weekday × hour · last 4 weeks · local time</span></h3>${viz.heatmap(hm)}</div>
       <div>${byAgentToday ? `<h2>By agent · today <span>${usd(sumBy(byAgentToday, (x) => x.cost))}</span></h2>${tbl(byAgentToday, "agent", agentLabel, viz.agentColor)}<h2 class="mt-sec">By agent · all time</h2>${tbl(sp.byAgentAll, "agent", agentLabel, viz.agentColor)}` : `<h2>By model · today</h2>${tbl(sp.byModelToday, "model", model)}`}</div>
     </div>
     <div class="cols mt-sec"><div><h2>By project · today <span>${usd(sumBy(filt(sp.byProjectToday), (x) => x.cost))}</span></h2>${tbl(filt(sp.byProjectToday), "project", projName)}
     <h2 class="mt-sec">By project · all time</h2>${tbl(filt(sp.byProjectAll), "project", projName)}</div>
     <div>${byAgentToday ? `<h2>By model · today</h2>${tbl(sp.byModelToday, "model", model)}` : ""}<h2 style="${byAgentToday ? "margin-top:18px" : ""}">By model · all time</h2>${tbl(sp.byModelAll, "model", model)}</div></div>
     ${renderAttribution()}
     <p class="dim" style="margin-top:var(--gap-sec)">Costs use list prices (static table, refreshed from LiteLLM when online; override in <code>~/.swarm/pricing.json</code>). Cache reads are the bulk of "ctx". Sessions on a subscription plan still show what the tokens would cost at API rates.</p>`;
}

// M4.2: cost attributed to tasks (via each claim's worktree) + a context re-processing signal.
// Only meaningful with a project selected.
function renderAttribution() {
  const a = state.attribution;
  if (!state.sel || !a) return "";
  const parts = [];
  if (a.byTask?.length) {
    parts.push(`<h2 class="mt-sec">By task <span>${usd(sumBy(a.byTask, (t) => t.cost))} across ${a.byTask.length} task${a.byTask.length === 1 ? "" : "s"} · attributed by worktree</span></h2>` +
      dataTable({
        id: "spend-task",
        columns: [
          { key: "task", label: "task", width: 150, get: (t) => t.task, cell: (t) => `<b>${esc(t.task)}</b>` },
          { key: "owner", label: "owner", width: 120, get: (t) => t.owner || "", cell: (t) => esc(t.owner || "—") },
          { key: "cost", label: "cost", width: 88, num: true, get: (t) => t.cost, cell: (t) => usd(t.cost) },
          { key: "output", label: "out", width: 84, num: true, get: (t) => t.output, cell: (t) => tok(t.output) },
          { key: "sessions", label: "sessions", width: 84, num: true, get: (t) => t.sessions, cell: (t) => String(t.sessions) },
          { key: "turns", label: "turns", width: 64, num: true, get: (t) => t.turns, cell: (t) => String(t.turns) },
          { key: "worktree", label: "worktree", flex: true, get: (t) => t.worktree, cell: (t) => `<span class="now dim" title="${esc(t.worktree)}">${esc(short(t.worktree))}</span>` },
        ],
        rows: a.byTask,
        leading: { width: 20, cell: () => "" },
        trailing: { width: 8, cell: () => "" },
        rerender: touch,
      }));
  }
  if (a.contextBudget?.length) {
    parts.push(`<h2 class="mt-sec">Context budget <span>sessions re-processing the most context · a high reuse % is a lot of re-reading</span></h2>` +
      dataTable({
        id: "spend-ctx",
        columns: [
          { key: "title", label: "session", flex: true, get: (r) => r.title ?? r.id, cell: (r) => `<a href="#" data-s="${r.id}">${esc(r.title ?? r.id.slice(0, 8))}</a>` },
          { key: "reuse", label: "reuse", width: 90, num: true, get: (r) => r.reuse, cell: (r) => `<span class="${r.reuse > 0.9 ? "br" : "dim"}">${(r.reuse * 100).toFixed(0)}%</span>` },
          { key: "cacheRead", label: "context re-read", width: 120, num: true, get: (r) => r.cacheRead, cell: (r) => tok(r.cacheRead) },
          { key: "cost", label: "cost", width: 88, num: true, get: (r) => r.cost, cell: (r) => usd(r.cost) },
          { key: "turns", label: "turns", width: 64, num: true, get: (r) => r.turns, cell: (r) => String(r.turns) },
        ],
        rows: a.contextBudget,
        leading: { width: 20, cell: () => "" },
        trailing: { width: 8, cell: () => "" },
        rerender: touch,
      }));
  }
  return parts.join("");
}

// ---------- stats
// Heavier than the 5s snapshot, so it has its own endpoint: fetched when the view opens (per project
// scope), then refreshed at most every 30s while the view stays open.
const statsCache = { key: null, at: 0, data: null, busy: false };
async function loadStats() {
  const key = state.sel ?? "";
  if (statsCache.busy || (statsCache.key === key && Date.now() - statsCache.at < 30_000)) return;
  statsCache.busy = true;
  try {
    const data = await (await fetch(`/v1/stats${key ? `?project=${encodeURIComponent(key)}` : ""}`)).json();
    Object.assign(statsCache, { key, at: Date.now(), data });
    if (state.view === "stats" && !state.session) touch();
  } finally { statsCache.busy = false; }
}
const big = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const toolName = (t) => String(t).replace(/^mcp__([^_]+(?:_[^_]+)*)__/, "$1 · ").replace(/^plugin_/, "");
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : "—");
const dur = (ms) => (ms < 3600e3 ? `${Math.round(ms / 60e3)}m` : ms < 86400e3 ? `${(ms / 3600e3).toFixed(1)}h` : `${(ms / 86400e3).toFixed(1)}d`);
// ---------- search view (M4.5): memory over Swarm's own data — handoffs, incidents, gates, what sessions said
const srch = { q: "", kind: "", hits: null, t: 0 };
function renderSearch() {
  const chip = (k, label) => `<span class="chip ${srch.kind === k ? "on" : ""}" data-skind="${k}">${label}</span>`;
  const mark = (s) => esc(s).replace(/\u0001/g, "<mark>").replace(/\u0002/g, "</mark>");
  const link = (h) => h.kind === "session" ? `data-s="${esc(h.ref)}"` : h.sessionId ? `data-s="${esc(h.sessionId)}"` : "";
  const hits = (srch.hits ?? []).map((h) => `<div class="hit"><div class="ht"><span class="badge">${esc(h.kind)}</span><b>${esc(h.title)}</b>${h.task ? `<span class="br">${esc(h.task)}</span>` : ""}<span class="grow"></span>${!state.sel ? `<span class="dim">${esc(projName(h.projectId))} · </span>` : ""}<span class="dim">${ago(h.ts)}</span>${link(h) ? `<a href="#" ${link(h)} title="Open the session">${ic("arrow-right", 12)}</a>` : ""}</div><div class="hs">${mark(h.snippet)}</div></div>`).join("");
  const had = document.activeElement?.id === "srchQ" ? { pos: document.activeElement.selectionStart } : null;
  $("#main").innerHTML =
    `<h2>Search <span>Swarm's own memory${state.sel ? ` · ${esc(projName(state.sel))}` : " · all projects"} — handoffs, incidents, gates, what sessions said. Never your code.</span></h2>` +
    `<div class="srch"><input id="srchQ" type="search" placeholder="pkill, login form, kind:incident git reset, task:M1.2 …" value="${esc(srch.q)}" autocomplete="off"></div>` +
    `<div class="chips">${chip("", "All")}${chip("handoff", "Handoffs")}${chip("incident", "Incidents")}${chip("gate", "Gates")}${chip("session", "Sessions")}</div>` +
    (srch.hits === null ? `<div class="empty">${PX.idle()}Type to search. Words are AND-ed, the last one is a prefix; quote a phrase; <code>kind:</code> and <code>task:</code> filter.</div>`
      : hits || `<div class="empty">${PX.idle()}Nothing in memory matches <b>${esc(srch.q)}</b>.</div>`);
  if (had) { const i = $("#srchQ"); i.focus(); i.setSelectionRange(had.pos, had.pos); }
}
async function runSearch() {
  if (!srch.q.trim()) { srch.hits = null; return renderSearch(); }
  const q = new URLSearchParams({ q: srch.q, limit: "50" });
  if (state.sel) q.set("project", state.sel);
  if (srch.kind) q.set("kind", srch.kind);
  const mine = ++srch.t;
  const j = await fetch(`/v1/memory?${q}`).then((r) => r.json()).catch(() => ({ hits: [] }));
  if (mine !== srch.t) return;
  srch.hits = j.hits ?? [];
  if (state.view === "search" && !state.session) renderSearch();
}
document.addEventListener("input", (ev) => { if (ev.target.id === "srchQ") { srch.q = ev.target.value; clearTimeout(srch.db); srch.db = setTimeout(runSearch, 150); } });
function renderStats() {
  const st = statsCache.key === (state.sel ?? "") ? statsCache.data : null;
  const scope = state.sel ? esc(projName(state.sel)) : "all projects";
  if (!st) { $("#main").innerHTML = `<h2>Stats <span>${scope}</span></h2><div class="empty">${PX.clock()}Crunching numbers…</div>`; return; }
  const T = st.totals;
  if (!T.turns) { $("#main").innerHTML = `<h2>Stats <span>${scope}</span></h2><div class="empty">${PX.clock()}No turns recorded yet. Numbers appear once a session is transcribed.</div>`; return; }
  const N = state.statsDays ?? 90;
  const days = [];
  for (let i = N - 1; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(viz.localDay(d)); }
  const byDay = Object.fromEntries(st.daily.map((d) => [d.day, d]));
  const pick = (k) => days.map((d) => byDay[d]?.[k] ?? 0);
  const rangeChips = `<span class="seg" style="margin-left:auto">${[30, 90, 365].map((n) => `<a href="#" class="${N === n ? "on" : ""}" data-sdays="${n}">${n}d</a>`).join("")}</span>`;
  const kpi = (l, v, d) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;

  // ---- headline numbers
  const allTok = T.input + T.cacheWrite + T.cacheRead + T.output;
  const since = T.firstTs ? new Date(T.firstTs) : null;
  const spanDays = since ? Math.max(1, Math.round((Date.now() - since) / 86400e3)) : 1;
  const activeDays = st.daily.filter((d) => d.turns).map((d) => d.day);
  const sk = viz.streaks(activeDays);
  const costDays = Object.fromEntries(st.daily.map((d) => [d.day, d.cost ?? 0]));
  const kpis =
    kpi("all-time spend", usd(T.cost), `since ${since ? since.toISOString().slice(0, 10) : "—"} · ${usd((T.cost ?? 0) / spanDays)}/day`) +
    kpi("tokens processed", big(allTok), `${big(T.output)} out · ${big(T.cacheRead)} cache read`) +
    kpi("turns", big(T.turns), `${T.sessions} sessions · ${big(T.toolCalls)} tool calls`) +
    kpi("streak", `${sk.current}d`, `longest ${sk.longest}d · ${activeDays.length} active day${activeDays.length === 1 ? "" : "s"} this year`);

  // ---- fun equivalents (a token ≈ 0.75 words; a novel ≈ 90k words; War and Peace ≈ 587k words)
  const words = T.output * 0.75;
  const novels = words / 90_000;
  const ctxWords = (T.input + T.cacheRead + T.cacheWrite) * 0.75;
  const wp = ctxWords / 587_000;
  const coffees = (T.cost ?? 0) / 5;
  const fun =
    kpi("words written", big(words), novels >= 1 ? `≈ ${novels.toFixed(novels < 10 ? 1 : 0)} novels` : `≈ ${(words / 300).toFixed(0)} pages`) +
    kpi("context re-read", `${big(ctxWords)} words`, wp >= 1 ? `≈ ${wp.toFixed(wp < 10 ? 1 : 0)}× War and Peace` : `≈ ${(ctxWords / 300).toFixed(0)} pages`) +
    kpi("thinking share", pct(T.thinking, T.output), `${tok(T.thinking)} reasoning tokens · cache hit ${pct(T.cacheRead, T.input + T.cacheRead + T.cacheWrite)}`) +
    kpi("in coffee", `${coffees >= 100 ? coffees.toFixed(0) : coffees.toFixed(1)} ☕`, `at $5 a cup · ${T.subagents} subagents spawned`);

  // ---- charts
  const classColor = { output: "var(--acc-5)", input: "var(--acc-3)", cacheWrite: "var(--acc-2)", cacheRead: "var(--acc-1)" };
  const className = { output: "output", input: "input", cacheWrite: "cache write", cacheRead: "cache read" };
  const order = ["output", "input", "cacheWrite", "cacheRead"];
  const tokOpts = { fmt: tok, color: (k) => classColor[k], name: (k) => className[k], sort: (a, b) => order.indexOf(a) - order.indexOf(b) };
  const tokSeries = Object.fromEntries(order.map((k) => [k, pick(k)]));
  let acc = 0;
  const cum = days.map((d) => (acc += byDay[d]?.cost ?? 0));
  const hours = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
  const hourSeries = { turns: hours.map((_, h) => st.byHour.find((x) => x.hour === h)?.turns ?? 0) };
  const peakHour = hourSeries.turns.indexOf(Math.max(...hourSeries.turns));
  const hourOpts = { fmt: (n) => String(Math.round(n)), color: () => "var(--acc)", name: () => "turns", label: (h) => (Number(h) % 3 ? "" : h), sort: () => 0 };
  const models = st.byModel.filter((m) => m.model).map((m) => ({ label: `${model(m.model)} · ${m.turns} turns`, v: m.output }));
  const comp = [{ label: "cache read", v: T.cacheRead }, { label: "cache write", v: T.cacheWrite }, { label: "input", v: T.input }, { label: "output", v: T.output }];

  // ---- records
  const R = st.records;
  const sessLink = (r) => (r ? `<a href="#" data-s="${r.id}">${esc(r.title || r.id.slice(0, 8))}</a>` : "—");
  const rec = (l, v, d) => `<div class="rec"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
  const wall = R.longestWallSession ? new Date(R.longestWallSession.lastSeenAt) - new Date(R.longestWallSession.startedAt) : 0;
  const bt = R.biggestTurn;
  const records =
    rec("costliest session", usd(R.costliestSession?.cost), sessLink(R.costliestSession)) +
    rec("most turns in a session", R.longestSession ? String(R.longestSession.turns) : "—", sessLink(R.longestSession)) +
    rec("longest session", wall > 0 ? dur(wall) : "—", sessLink(R.longestWallSession)) +
    rec("biggest single turn", bt ? `${tok(bt.output)} out` : "—", bt ? `${esc(model(bt.model))} · <a href="#" data-s="${bt.sessionId}">${esc(bt.title || bt.sessionId.slice(0, 8))}</a>` : "—") +
    rec("busiest day", R.busiestDay ? usd(R.busiestDay.cost) : "—", R.busiestDay ? `${R.busiestDay.day} · ${R.busiestDay.turns} turns` : "—") +
    rec("favourite hour", `${hours[peakHour]}:00`, `${hourSeries.turns[peakHour]} turns in that hour, all time`);

  $("#main").innerHTML =
    `<h2>Stats <span>${scope}</span>${rangeChips}</h2>
     <div class="kpis">${kpis}</div>
     <div class="kpis">${fun}</div>
     <div class="chart-card"><h3>Activity <span>cost per day · last 52 weeks</span></h3>${viz.calendar(costDays)}</div>
     <div class="chart-card"><h3>Tokens per day <span>last ${N} days · by class</span></h3>${viz.stackedColumns(days, tokSeries, tokOpts)}${viz.legend(order, tokOpts.name, tokOpts.color)}</div>
     <div class="cols">
       <div class="chart-card" style="margin:0"><h3>Output tokens per day <span>last ${N} days</span></h3>${viz.stackedColumns(days, { output: pick("output") }, tokOpts)}</div>
       <div class="chart-card" style="margin:0"><h3>Cumulative spend <span>last ${N} days</span></h3>${viz.line(days, cum)}</div>
     </div>
     <div class="cols mt-sec">
       <div class="chart-card" style="margin:0"><h3>Turns by hour of day <span>all time · local</span></h3>${viz.stackedColumns(hours, hourSeries, hourOpts)}</div>
       <div class="chart-card" style="margin:0"><h3>Model mix <span>by output tokens · all time</span></h3>${viz.compositionBar(models)}
         <h3 style="margin-top:14px">Token composition <span>all time</span></h3>${viz.compositionBar(comp)}</div>
     </div>
     <div class="cols mt-sec">
       <div class="chart-card" style="margin:0"><h3>Tool leaderboard <span>calls · all time</span></h3>${st.tools.length ? viz.hbars(st.tools.map(([k, v]) => [toolName(k), v])) : '<div class="dim">no tool calls yet</div>'}</div>
       <div><h2 style="margin-top:0">Records</h2><div class="records">${records}</div></div>
     </div>
     <p class="dim" style="margin-top:var(--gap-sec)">Word counts assume ~0.75 words per token; a novel is 90k words. Costs use list prices, as on Spend. ${pct(T.sidechainTurns, T.turns)} of turns came from subagents.</p>`;
}

// ---------- timeline
function renderTimeline() {
  const now = Date.now();
  const hours = state.tlHours ?? 12;
  const from = now - hours * 3.6e6, to = now + 0.25 * 3.6e6;
  const rows = state.sessions.filter((s) => (!state.sel || s.projectId === state.sel) && new Date(s.lastSeenAt).getTime() >= from && s.kind !== "subagent");
  const agents = [...new Set(rows.map((s) => s.agent))].sort(viz.agentSort);
  const chip = (h) => `<a href="#" class="nav ${hours === h ? "on" : ""}" data-tl="${h}">${h}h</a>`;
  $("#main").innerHTML =
    `<h2>Timeline <span>${rows.length} sessions · last ${hours}h · ${usd(sumBy(rows, (s) => s.costUsd))}</span><span style="margin-left:auto;display:flex;gap:2px">${[3, 6, 12, 24, 72].map(chip).join("")}</span></h2>
     ${rows.length ? viz.timeline(rows, { from, to, projName, now }) : `<div class="empty">${PX.clock()}No sessions in the last ${hours}h.</div>`}
     ${agents.length ? `<div style="margin-top:10px">${viz.legend(agents)}</div>` : ""}`;
}

// ---------- session
const LOG_CAP = 500;
// Re-polling the open session fetches only what is newer than what we hold (events by seq, turns by ts)
// and appends, deduping against rows the SSE stream already pushed. A different session starts over.
let sessionFetch = null;
async function openSession(id) {
  const same = state.session === id && sessionFetch === id;
  if (!same) { state.session = id; state.log = []; state.turns = []; rowCache.clear(); logRendered = null; state.dirty = true; }
  const q = new URLSearchParams();
  if (same) {
    let seq = 0, ts = "";
    for (const e of state.log) if (e.seq > seq) seq = e.seq;
    for (const t of state.turns) if (t.ts > ts) ts = t.ts;
    if (seq) q.set("after", String(seq));
    if (ts) q.set("afterTs", ts);
  }
  const qs = q.toString();
  const d = await (await fetch(`/v1/sessions/${id}/events${qs ? `?${qs}` : ""}`)).json();
  if (state.session !== id) return; // user moved on while we were fetching
  sessionFetch = id;
  let changed = !same;
  if (same) {
    const seen = new Set(state.log.map((e) => e.seq));
    for (const e of d.events) if (!seen.has(e.seq)) { state.log.push(e); changed = true; }
    const tid = new Set(state.turns.map((t) => t.id));
    for (const t of d.turns) if (!tid.has(t.id)) { state.turns.push(t); changed = true; }
    if (d.events.length) state.log.sort((a, b) => a.seq - b.seq); // SSE pushes and the fetch may interleave
    if (d.turns.length) state.turns.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  } else { state.log = d.events; state.turns = d.turns; }
  if (state.log.length > LOG_CAP) state.log.splice(0, state.log.length - LOG_CAP);
  if (changed) schedule();
}
// Rendered log rows, keyed per event seq / turn id (+ the mutable turn fields) so only new rows are formatted.
const rowCache = new Map();
let logRendered = null; // keys of the rows currently in #log, in order — enables append-only updates
const evRow = (i) => `<div class="ev ${i.cls}"><span class="t">${hhmm(i.ts)}</span><span class="k">${esc(i.kind)}</span><span class="m">${esc(i.text)}${i.out ? `<span class="dim"> · ${tok(i.out)} out${i.cost != null ? ` · $${i.cost.toFixed(3)}` : ""}</span>` : ""}</span></div>`;
// Merge the two ts-sorted inputs (events by seq ≈ ts, turns by ts) in one pass → [{key, html}].
function sessionStream() {
  const out = [];
  const log = state.log, turns = state.turns;
  let i = 0, j = 0;
  const pushEv = (e) => {
    const key = `e${e.seq}`;
    let html = rowCache.get(key);
    if (!html) rowCache.set(key, (html = evRow({ ts: e.ts, kind: e.payload?.hook ?? e.type, text: e.payload?.summary ?? "", cls: e.type })));
    out.push({ key, html });
  };
  const pushTurn = (t) => {
    const key = `t${t.id}:${t.costUsd ?? ""}:${t.output ?? ""}:${t.text.length}`;
    let html = rowCache.get(key);
    if (!html) rowCache.set(key, (html = evRow({ ts: t.ts, kind: t.sidechain ? "subagent" : "assistant", text: t.text, cls: "assistant", cost: t.costUsd, out: t.output })));
    out.push({ key, html });
  };
  while (i < log.length || j < turns.length) {
    if (i < log.length && log[i].payload?.hook === "PostToolUse") { i++; continue; }
    if (j < turns.length && !turns[j].text) { j++; continue; }
    if (j >= turns.length || (i < log.length && log[i].ts < turns[j].ts)) pushEv(log[i++]);
    else pushTurn(turns[j++]);
  }
  return out;
}
// True when `rows` only extends the rows already in #log (same session, same prefix) → append, don't rebuild.
const isAppend = (rows) => logRendered && rows.length >= logRendered.length && logRendered.every((k, n) => rows[n].key === k);
// M4.1 session replay: step through a session's tool calls, one at a time, with full input/output
// (lazy-fetched from /v1/events/:seq). replayState holds the current step; nav by buttons or ←/→.
const replay = { steps: [], i: 0, cache: new Map() };
// M4.4: resume where this died — the daemon builds the prompt from the handoff + tail; we just confirm.
async function resumeDead() {
  const id = state.session; if (!id) return;
  const plan = await fetch(`/v1/sessions/${encodeURIComponent(id)}/resume`).then((r) => r.json());
  if (!plan.ok) return alert(plan.error);
  if (!confirm(`Resume ${plan.task}${plan.owner ? ` as ${plan.owner}` : ""}?\n\n${plan.prompt.slice(0, 900)}${plan.prompt.length > 900 ? "…" : ""}`)) return;
  const r = await fetch(`/v1/sessions/${encodeURIComponent(id)}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((x) => x.json());
  if (!r.ok) return alert(r.error);
  openSession(r.run.sessionId);
}
function openReplay() {
  replay.steps = state.log.filter((e) => e.type === "tool.requested").map((e) => ({ seq: e.seq, tool: e.payload?.tool ?? "tool", summary: e.payload?.summary ?? "" }));
  replay.i = 0;
  replay.cache.clear();
  if (!replay.steps.length) { alert("No tool calls in this session yet."); return; }
  renderReplay();
}
async function renderReplay() {
  const n = replay.steps.length;
  const step = replay.steps[replay.i];
  let detail = replay.cache.get(step.seq);
  if (!detail) {
    // the request event (full input) and the paired completed event (output), both by seq
    const req = await fetch(`/v1/events/${step.seq}`).then((r) => r.json()).catch(() => null);
    const done = state.log.find((e) => e.type === "tool.completed" && e.seq > step.seq && e.payload?.summary === step.summary);
    const res = done ? await fetch(`/v1/events/${done.seq}`).then((r) => r.json()).catch(() => null) : null;
    detail = { input: req?.payload?.toolInput ?? null, output: res?.payload?.toolResponse ?? null, ts: req?.ts };
    replay.cache.set(step.seq, detail);
  }
  const j = (v) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v, null, 2));
  $("#picker").innerHTML = `<div class="pk wn rp" role="dialog" aria-modal="true">
    <div class="pk-h">${ic("play", 15)}<b>Replay</b><span class="dim" style="margin-left:8px">${step.tool}</span><span class="grow"></span><span class="dim" style="font-size:var(--fs-sm)">${replay.i + 1} / ${n}${detail.ts ? ` · ${hhmm(detail.ts)}` : ""}</span><button id="pkCancel" title="Close">${ic("x", 14)}</button></div>
    <div class="pk-b">
      <div class="dim now" style="font-family:var(--mono);font-size:var(--fs-sm);margin-bottom:8px">${esc(step.summary)}</div>
      <h4>input</h4><pre class="snip">${esc(j(detail.input)) || '<span class="dim">—</span>'}</pre>
      <h4>output</h4><pre class="snip">${detail.output != null ? esc(j(detail.output)).slice(0, 4000) : '<span class="dim">(no result captured)</span>'}</pre>
    </div>
    <div class="pk-f"><button id="rpPrev" ${replay.i === 0 ? "disabled" : ""}>${ic("arrow-left", 12)} Prev</button><span class="grow"></span><input id="rpRange" type="range" min="0" max="${n - 1}" value="${replay.i}" style="flex:1;max-width:280px"><span class="grow"></span><button class="primary" id="rpNext" ${replay.i >= n - 1 ? "disabled" : ""}>Next ${ic("arrow-right", 12)}</button></div>
  </div>`;
}
function replayGo(delta) {
  const n = replay.steps.length;
  replay.i = Math.max(0, Math.min(n - 1, replay.i + delta));
  renderReplay();
}

// Spawned sessions get a stdin box while their run is live (M3.3); interactive ones are told where to type.
function stdinBox(s) {
  if (s.kind !== "spawned") return "";
  const run = (state.runs ?? []).find((r) => r.sessionId === s.id);
  if (!run) return `<div class="stdin"><span class="hint">${ic("play", 12)} spawned by swarm run · no longer live</span></div>`;
  const perms = (run.pending ?? []).map((pp) => `<div class="perm"><div class="perm-t">${ic("warning", 13)} <b>${esc(pp.tool)}</b> needs approval<span class="dim now" title="${esc(pp.reason)}"> — ${esc(pp.reason)}</span></div><div class="perm-c">${esc(pp.display)}</div><div class="perm-b"><button class="ok" data-perm-allow="${esc(run.id)}:${esc(pp.requestId)}">Allow</button><button class="danger" data-perm-deny="${esc(run.id)}:${esc(pp.requestId)}">Deny</button></div></div>`).join("");
  return `${perms}<div class="stdin" id="stdin"><input id="stdinText" placeholder="Send a message to this run… (Enter)" autocomplete="off" spellcheck="false"><button id="stdinSend">${ic("arrow-right", 13)} Send</button><button class="danger" data-runstop="${esc(run.id)}">Stop</button><span class="hint">run ${esc(run.id)} · pid ${run.pid}${run.result ? ` · $${run.result.costUsd.toFixed(2)} so far` : ""}</span></div>`;
}
async function sendStdin() {
  const s = state.sessions.find((x) => x.id === state.session);
  const run = (state.runs ?? []).find((r) => r.sessionId === s?.id);
  const el = $("#stdinText"); const text = el?.value.trim();
  if (!run || !text) return;
  el.value = "";
  const r = await fetch(`/v1/runs/${encodeURIComponent(run.id)}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  if (!r.ok) alert((await r.json()).error);
  refresh();
}
document.addEventListener("click", (ev) => {
  if (ev.target.closest("#stdinSend")) return sendStdin();
  const a = ev.target.closest("[data-perm-allow]"), d = ev.target.closest("[data-perm-deny]");
  const key = a?.dataset.permAllow || d?.dataset.permDeny;
  if (key) {
    const [runId, reqId] = key.split(":");
    return fetch(`/v1/runs/${encodeURIComponent(runId)}/permissions/${encodeURIComponent(reqId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ allow: Boolean(a) }) }).then(refresh);
  }
});
document.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target.id === "stdinText") { ev.preventDefault(); sendStdin(); } });

function renderSession() {
  const s = state.sessions.find((x) => x.id === state.session);
  if (!s) return;
  const logEl = $("#log");
  const atBottom = !logEl || logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 40;
  const prevTop = logEl ? logEl.scrollTop : 0;
  const rows = sessionStream();
  const tools = Object.entries(s.toolCounts).sort((a, b) => b[1] - a[1]);
  const t = s.tokens;
  const ctx = t.input + t.cacheRead + t.cacheWrite;
  const subTurns = state.turns.filter((x) => x.sidechain || x.agentId);
  const STAT_ICON = { cost: "coin", model: "robot", turns: "arrows-clockwise", "tool calls": "wrench", output: "chart-bar", context: "rows", started: "clock", "last seen": "eye", "subagent turns": "tree-structure" };
  const stat = (k, v) => `<div class="stat"><span>${ic(STAT_ICON[k] ?? "list-bullets", 13)}${k}</span><b>${v}</b></div>`;
  const head = `<h2 class="hrow"><a class="back" href="#" id="back">${ic("arrow-left", 13)}back</a> ${esc(projName(s.projectId))} · <span class="s ${s.state}"></span> ${kindIcon(s)}${agentBadge(s.agent)}<b>${esc(s.title ?? s.id.slice(0, 8))}</b> <span>${esc(short(s.cwd))}${s.branch ? ` · ${esc(s.branch)}` : ""} · ${s.state}</span><a href="#" class="nav" id="replay" style="margin-left:auto" title="Step through this session's tool calls">${ic("play", 13)} Replay</a>${(state.worktrees[s.projectId] ?? []).some((w) => !w.main && (s.cwd === w.path || s.cwd.startsWith(`${w.path}/`))) ? `<a href="#" class="nav" id="sessDiff" title="What this session's worktree changed">${ic("folders", 13)} Diff</a>` : ""}${s.state === "ended" ? `<a href="#" class="nav" id="resumeDead" title="Spawn a run that picks up this session's task from its handoff + last actions">${ic("reload", 13)} Resume where it died</a>` : ""}</h2>`;
  const side = `<div class="stats">
    ${stat("cost", usd(s.costUsd))}${stat("model", esc(model(s.model)) || "—")}${stat("turns", s.turns)}${stat("tool calls", s.toolCalls)}
    ${stat("output", `${tok(t.output)}${t.thinking ? `<small> · ${tok(t.thinking)} thinking</small>` : ""}`)}${stat("context", `${tok(ctx)}<small> · ${ctx ? ((100 * t.cacheRead) / ctx).toFixed(0) : 0}% cached</small>`)}
    ${stat("started", `${ago(s.startedAt)} ago`)}${stat("last seen", `${ago(s.lastSeenAt)} ago`)}
    ${subTurns.length ? stat("subagent turns", subTurns.length) : ""}
    </div>
    <h4>tokens</h4>${viz.compositionBar([{ label: "cache read", v: t.cacheRead }, { label: "cache write", v: t.cacheWrite }, { label: "input", v: t.input }, { label: "thinking", v: t.thinking }, { label: "output", v: t.output }])}
    ${state.turns.length > 1 ? `<h4>cost per turn</h4>${viz.turnStrip(state.turns, { height: 54 })}` : ""}
    <h4>tools</h4>${tools.length ? viz.hbars(tools.slice(0, 8).map(([k, v]) => [k.replace(/^mcp__[a-z0-9-]+__/i, ""), v])) : '<span class="dim">None yet</span>'}
    ${s.transcriptPath ? `<h4>transcript</h4><div class="dim mono" style="word-break:break-all">${ic("file-text", 12)} ${esc(short(s.transcriptPath))}</div>` : ""}`;
  if (logEl && isAppend(rows)) {
    // Same session, rows only appended: patch header + sidebar, append the new rows — #log keeps its
    // scroll position (and its DOM) untouched.
    $("#main > h2").outerHTML = head;
    $("#main .side").innerHTML = side;
    const sb = stdinBox(s); const cur = $("#main .stdin");
    if (cur && cur.outerHTML !== sb && document.activeElement?.id !== "stdinText") cur.outerHTML = sb;
    else if (!cur && sb) $("#main").insertAdjacentHTML("beforeend", sb);
    if (rows.length > logRendered.length) logEl.insertAdjacentHTML("beforeend", rows.slice(logRendered.length).map((r) => r.html).join(""));
  } else {
    const sb = stdinBox(s);
    $("#main").innerHTML = `${head}<div class="sess ${sb ? "has-stdin" : ""}"><div id="log">${rows.map((r) => r.html).join("")}</div><aside class="side">${side}</aside></div>${sb}`;
  }
  logRendered = rows.map((r) => r.key);
  // Follow the tail when pinned to the bottom; otherwise keep the reading position —
  // innerHTML replacement resets scroll to the top on every live update.
  const nl = $("#log");
  if (nl) nl.scrollTop = atBottom ? nl.scrollHeight : prevTop;
}


// ---------- menus (fancy-menus island; see src/menus.tsx). Menus are plain data.
const pinProject = (id, pinned) => fetch(`/v1/projects/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned }) }).then(refresh);
const removeProject = (id) => fetch(`/v1/projects/${id}`, { method: "DELETE" }).then(refresh);
function menuSpec(kind, d) {
  if (kind === "project") {
    const p = state.projects.find((x) => x.id === d.pid);
    if (!p) return null;
    const live = state.sessions.filter((s) => s.projectId === p.id && (s.state === "active" || s.state === "waiting")).length;
    return { title: p.name, items: [
      { label: "Show sessions", icon: "squares-four", caption: live ? `${live} live` : undefined, run: () => { state.sel = p.id; state.view = "fleet"; state.session = null; touch(); } },
      { label: "Show in Timeline", icon: "clock-counter-clockwise", run: () => { state.sel = p.id; state.view = "timeline"; state.session = null; touch(); } },
      { label: "Spend", icon: "coins", run: () => { state.sel = p.id; state.view = "spend"; state.session = null; touch(); } },
      { label: "Stats", icon: "chart-bar", run: () => { state.sel = p.id; state.view = "stats"; state.session = null; touch(); } },
      { divider: true },
      p.discovered ? { label: "Pin project", icon: "push-pin", run: () => pinProject(p.id, true) } : { label: "Unpin project", icon: "push-pin-slash", run: () => pinProject(p.id, false) },
      { label: "Copy path", icon: "copy", caption: tail(p.root), run: () => copy(p.root) },
      { divider: true },
      { label: "Remove from Swarm", icon: "trash", danger: true, run: () => removeProject(p.id) },
    ] };
  }
  if (kind === "session") {
    const s = state.sessions.find((x) => x.id === d.sid);
    if (!s) return null;
    return { title: s.title ?? s.id.slice(0, 8), items: [
      { label: "Open session", icon: "terminal-window", run: () => openSession(s.id) },
      { label: "Show in Timeline", icon: "clock-counter-clockwise", run: () => { state.sel = s.projectId; state.view = "timeline"; state.session = null; touch(); } },
      { divider: true },
      { section: "Copy" },
      { label: "Session id", icon: "copy", caption: s.id.slice(0, 8), run: () => copy(s.id) },
      { label: "Working directory", icon: "folder-simple", caption: tail(s.cwd, 18), run: () => copy(s.cwd) },
      ...(s.transcriptPath ? [{ label: "Transcript path", icon: "file-text", run: () => copy(s.transcriptPath) }] : []),
      ...(s.branch ? [{ label: "Branch", icon: "git-branch", caption: tail(s.branch, 18), run: () => copy(s.branch) }] : []),
    ] };
  }
  if (kind === "settings") {
    const theme = getTheme();
    const th = (id, label, icon) => ({ label, icon, pressed: theme === id, run: () => { setTheme(id); $("#settings").blur(); } });
    return { items: [
      { label: "Theme", icon: theme === "dark" ? "moon" : theme === "light" ? "sun" : "monitor", caption: theme, children: [th("system", "System", "monitor"), th("light", "Light", "sun"), th("dark", "Dark", "moon")] },
      { divider: true },
      { label: "Refresh pricing", icon: "arrows-clockwise", caption: "LiteLLM", run: async () => { const r = await fetch("/v1/pricing/refresh", { method: "POST" }); if (!r.ok) console.warn("pricing refresh failed", r.status); refresh(); } },
      { label: "Copy dashboard URL", icon: "copy", run: () => copy(location.origin) },
      { divider: true },
      { label: "Desktop notifications", icon: "bell", pressed: notifyOn(), caption: notifyOn() ? "on" : "off", run: () => { notifyOn() ? disableNotifications() : enableNotifications(); $("#settings").blur(); } },
      { label: "What's New", icon: "star", caption: `v${state.version ?? "?"}`, run: () => whatsNew() },
      { label: "Documentation", icon: "book-open", caption: "getswarm", run: () => window.open("https://getswarm.vercel.app/docs/", "_blank") },
      { label: "Send feedback", icon: "comment-text", caption: "GitHub issue", run: () => window.open(feedbackUrl(), "_blank") },
    ] };
  }
  return null;
}
// M4.7 desktop notifications: native notifications (web Notification API — works in the browser and
// the desktop app's webview) for the things you'd want to walk away and be pinged about — a spawned
// run waiting on a permission, and a claim orphaned with unfinished work. Clicking opens the spot to
// act. Off until enabled from the settings menu (which requests OS permission). Quiet while focused.
const NOTIFY_KEY = "swarm.notify";
const notifyOn = () => { try { return localStorage.getItem(NOTIFY_KEY) === "on"; } catch { return false; } };
async function enableNotifications() {
  if (!("Notification" in window)) { alert("This browser doesn't support notifications."); return; }
  const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (perm !== "granted") { alert("Notifications were blocked. Allow them for this site in your browser/OS settings."); return; }
  try { localStorage.setItem(NOTIFY_KEY, "on"); } catch {}
  new Notification("Swarm notifications on", { body: "You'll be pinged when a run needs a permission or a claim is orphaned." });
}
function disableNotifications() { try { localStorage.setItem(NOTIFY_KEY, "off"); } catch {} }
let lastNotifyAt = 0;
function notifyForEvent(ev) {
  if (!notifyOn() || !("Notification" in window) || Notification.permission !== "granted") return;
  if (!document.hidden && ev.type !== "permission.requested") return; // only permission prompts interrupt while you're looking
  const now = Date.now();
  if (now - lastNotifyAt < 1500) return; // don't stack
  const p = ev.payload || {};
  let title, body, onClick;
  if (ev.type === "permission.requested") {
    title = `Permission needed: ${p.tool ?? "tool"}`;
    body = `${p.display ?? ""}
${p.reason ?? ""}`.slice(0, 180);
    onClick = () => { if (ev.sessionId) openSession(ev.sessionId); };
  } else if (ev.type === "claim.orphaned") {
    title = "Claim orphaned";
    body = `${p.task ?? "a task"} — its lease expired with unfinished work in the worktree.`;
    onClick = () => { state.view = "board"; state.sel = ev.projectId || state.sel; state.session = null; refresh(); };
  } else return;
  lastNotifyAt = now;
  const n = new Notification(title, { body, tag: `swarm-${ev.type}-${ev.sessionId ?? ev.seq}` });
  n.onclick = () => { window.focus(); onClick?.(); n.close(); };
}

// What's New: release notes for the running version, from window.RELEASE_NOTES (release-notes.js).
// The desktop menu calls window.swarmWhatsNew; the settings menu calls whatsNew(); it also opens
// itself once after an upgrade (localStorage remembers the last version the user saw).
function releaseNotesFor(version) {
  const all = window.RELEASE_NOTES || {};
  if (version && all[version]) return { version, ...all[version] };
  const latest = Object.keys(all)[0];
  return latest ? { version: latest, ...all[latest] } : null;
}
function whatsNew(version) {
  const n = releaseNotesFor(version || state.version);
  if (!n) return;
  try { localStorage.setItem("swarm.seenVersion", n.version); } catch {}
  $("#picker").innerHTML = `<div class="pk wn" role="dialog" aria-modal="true">
    <div class="pk-h">${ic("star", 15)}<b>What's New</b><span class="grow"></span><button id="pkCancel" title="Close">${ic("x", 14)}</button></div>
    <div class="pk-b"><h3>Swarm ${esc(n.version)}</h3>${n.date ? `<div class="date">${esc(n.date)}</div>` : ""}${n.html}</div>
    <div class="pk-f"><span class="grow"></span><a href="https://getswarm.vercel.app/changelog" target="_blank" rel="noopener" style="align-self:center;color:var(--dim);font-size:var(--fs-sm)">Full changelog →</a><button id="pkCancel">Close</button></div>
  </div>`;
}
window.swarmWhatsNew = (v) => whatsNew(v);
// auto-open once per version, but never on the very first run (nothing to compare against)
function maybeWhatsNew() {
  if (!state.version || !window.RELEASE_NOTES) return;
  let seen; try { seen = localStorage.getItem("swarm.seenVersion"); } catch {}
  if (seen === state.version) return;
  if (!seen) { try { localStorage.setItem("swarm.seenVersion", state.version); } catch {} return; }
  if (releaseNotesFor(state.version)) whatsNew(state.version);
}

// Star nudge: once a month at most, never on first open, dismissable for good. Pure localStorage —
// nothing leaves the machine; clicking Star just opens the repo in a browser.
const STAR = { key: "swarm.star", firstAfterMs: 2 * 86_400_000, everyMs: 30 * 86_400_000 };
function starState() { try { return JSON.parse(localStorage.getItem(STAR.key) || "{}"); } catch { return {}; } }
function starSave(patch) { try { localStorage.setItem(STAR.key, JSON.stringify({ ...starState(), ...patch })); } catch {} }
function maybeStarNudge() {
  const st = starState();
  const now = Date.now();
  if (!st.since) return starSave({ since: now });
  if (st.done || st.never) return;
  if (now - st.since < STAR.firstAfterMs) return;
  if (st.last && now - st.last < STAR.everyMs) return;
  if (document.querySelector(".nudge")) return;
  starSave({ last: now });
  const el = document.createElement("div");
  el.className = "nudge";
  el.innerHTML = `${ic("star", 18, "ic")}<div><b>Enjoying Swarm?</b>A star on GitHub helps other people find it — and tells us it's worth the evenings.
    <div class="row"><button class="pri" data-star="go">${ic("star", 13)} Star on GitHub</button><button data-star="later">Later</button><a href="#" class="dim" data-star="never">Don't ask again</a></div></div>`;
  document.body.appendChild(el);
  el.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-star]"); if (!t) return;
    ev.preventDefault();
    if (t.dataset.star === "go") { starSave({ done: now }); window.open(REPO_URL, "_blank"); }
    else if (t.dataset.star === "never") starSave({ never: now });
    el.remove();
  });
}
window.swarmStarNudge = (force) => { if (force) starSave({ since: 1, last: 0, done: 0, never: 0 }); maybeStarNudge(); };
setTimeout(maybeStarNudge, 4000);

// Feedback lands in a GitHub issue form, prefilled with the environment so people don't have to type it.
const REPO_URL = "https://github.com/ra3orblade/swarm";
function feedbackUrl() {
  const ua = navigator.userAgent;
  const os = /Mac/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "unknown OS";
  const shell = window.__TAURI__ || window.__TAURI_INTERNALS__ ? "desktop" : "browser";
  const env = `swarm ${state.version || "?"} · ${os} · ${shell}`;
  const q = new URLSearchParams({ template: "feedback.yml", environment: env });
  return `${REPO_URL}/issues/new?${q}`;
}
function openMenu(kind, anchor, d) {
  const spec = menuSpec(kind, d);
  if (!spec) return;
  if (!window.menus) { console.warn("menus.js not built — run: bun run build:web"); return; }
  window.menus.open(anchor, spec);
}
document.addEventListener("contextmenu", (ev) => {
  const t = ev.target.closest("[data-ctx]");
  if (!t) return;
  ev.preventDefault();
  openMenu(t.dataset.ctx, { x: ev.clientX, y: ev.clientY }, t.dataset);
});

// ---------- events
document.addEventListener("click", async (ev) => {
  const t = ev.target.closest("[data-menu],#settings,#feedback,[data-id],[data-s],#back,[data-view],.chip,[data-tl],[data-days],[data-sdays],[data-release],[data-forcerelease],[data-resrelease],[data-merge],[data-ack],[data-ackall],[data-inc],[data-task-filter],[data-claim],[data-procstop],[data-run],[data-runstop],[data-wtopen],[data-wtrm],[data-wtdiff],[data-wtpr],[data-dffile],#prGo,#sessDiff,#wtnew,#wtgc,[data-gaterun]");
  if (!t) return;
  if (t.dataset.menu) { ev.preventDefault(); ev.stopPropagation(); return openMenu(t.dataset.menu, t, t.dataset); }
  if (t.id === "settings") { ev.preventDefault(); return openMenu("settings", t, {}); }
  if (t.id === "feedback") { ev.preventDefault(); return window.open(feedbackUrl(), "_blank"); }
  if (t.dataset.view) { ev.preventDefault(); state.view = t.dataset.view; localStorage.setItem("swarm.view", state.view); state.session = null; state.dirty = true; return refresh(); }
  if (t.dataset.tl) { ev.preventDefault(); state.tlHours = Number(t.dataset.tl); return touch(); }
  if (t.dataset.taskFilter) { state.taskFilter = t.dataset.taskFilter; return touch(); }
  if (t.dataset.run) { ev.preventDefault(); return openRunDrawer(t.dataset.run); }
  if (t.dataset.runstop) {
    ev.preventDefault();
    if (!confirm("Stop this run? Its stdin is closed, then the process is signalled by pid.")) return;
    return fetch(`/v1/runs/${encodeURIComponent(t.dataset.runstop)}`, { method: "DELETE" }).then(async (r) => { if (!r.ok) alert((await r.json()).error); return refresh(); });
  }
  if (t.dataset.claim) {
    ev.preventDefault();
    const r = await fetch("/v1/claims", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: state.sel, task: t.dataset.claim, owner: "dashboard" }) }).then((x) => x.json());
    if (!r.ok) alert(r.error); else state.tasks = null;
    return refresh();
  }
  if (t.dataset.wtopen) {
    ev.preventDefault();
    const i = t.dataset.wtopen.indexOf(":");
    const r = await fetch("/v1/worktrees/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: t.dataset.wtopen.slice(0, i), worktree: t.dataset.wtopen.slice(i + 1) }) }).then((x) => x.json());
    if (!r.ok) alert(r.error);
    return;
  }
  if (t.dataset.wtdiff) { ev.preventDefault(); const i = t.dataset.wtdiff.indexOf(":"); return openDiffDrawer(t.dataset.wtdiff.slice(0, i), t.dataset.wtdiff.slice(i + 1)); }
  if (t.dataset.wtpr) { ev.preventDefault(); const i = t.dataset.wtpr.indexOf(":"); return openPrDrawer(t.dataset.wtpr.slice(0, i), t.dataset.wtpr.slice(i + 1)); }
  if (t.dataset.dffile !== undefined) { ev.preventDefault(); return loadDiffFile(t.dataset.dffile); }
  if (t.id === "prGo") { ev.preventDefault(); return submitPr(); }
  if (t.id === "sessDiff") {
    ev.preventDefault();
    const s = state.sessions.find((x) => x.id === state.session);
    if (!s) return;
    const w = (state.worktrees[s.projectId] ?? []).find((x) => !x.main && (s.cwd === x.path || s.cwd.startsWith(`${x.path}/`)));
    return w ? openDiffDrawer(s.projectId, w.path) : null;
  }
  if (t.dataset.wtrm) {
    ev.preventDefault();
    const i = t.dataset.wtrm.indexOf(":");
    const projectId = t.dataset.wtrm.slice(0, i), worktree = t.dataset.wtrm.slice(i + 1);
    const rm = (force) => fetch("/v1/worktrees/remove", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, worktree, force }) }).then((x) => x.json());
    if (!confirm(`Remove worktree ${short(worktree)}?`)) return;
    const r = await rm(false);
    if (!r.ok && (r.refused === "dirty" || r.refused === "unpushed")) {
      if (confirm(`${r.error}\n\nRemove anyway (discards the work)?`)) await rm(true);
    } else if (!r.ok) alert(r.error);
    state.worktrees[projectId] = null;
    return refresh();
  }
  if (t.id === "wtnew") {
    ev.preventDefault();
    const name = prompt("Worktree name (folder under ~/.swarm/worktrees/<project>/; branch wt/<name>):");
    if (!name) return;
    const r = await fetch("/v1/worktrees", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: state.sel, name }) }).then((x) => x.json());
    if (!r.ok) alert(r.error);
    state.worktrees[state.sel] = null;
    return refresh();
  }
  if (t.id === "wtgc") {
    ev.preventDefault();
    const r = await fetch("/v1/worktrees/gc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: state.sel }) }).then((x) => x.json());
    if (!r.candidates.length) return alert("Nothing to collect — no merged branches or released claims with a worktree left behind.");
    const lines = r.candidates.map((c) => `${c.removable ? "•" : "✗"} ${c.branch ?? "(detached)"} — ${c.why}${c.blocker ? ` (blocked: ${c.blocker})` : ""}`).join("\n");
    const n = r.candidates.filter((c) => c.removable).length;
    if (!n) return alert(`Stale worktrees, none removable without force:\n\n${lines}`);
    if (!confirm(`Stale worktrees:\n\n${lines}\n\nRemove the ${n} removable one${n === 1 ? "" : "s"}?`)) return;
    await fetch("/v1/worktrees/gc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: state.sel, apply: true }) });
    state.worktrees[state.sel] = null;
    return refresh();
  }
  if (t.dataset.gaterun) {
    ev.preventDefault();
    const task = t.dataset.gaterun;
    t.textContent = "running…";
    const r = await fetch("/v1/gates/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: state.sel, task }) }).then((x) => x.json());
    if (!r.started?.length) alert(r.error ?? r.skipped?.[0]?.reason ?? "nothing ran");
    else alert(`${task}: ${r.runs.map((x) => `${x.verdict === "pass" ? "✓" : "✗"} ${x.gate} — ${x.rubric}`).join("\n")}${r.skipped.length ? `\n\nskipped: ${r.skipped.map((x) => `${x.gate} (${x.reason})`).join(", ")}` : ""}`);
    state.tasks = null;
    return refresh();
  }
  if (t.dataset.codify) { ev.preventDefault(); return codifyIncident(t.dataset.codify); }
  if (t.id === "dryrun") { ev.preventDefault(); return openDryRun(); }
  if (t.dataset.skind !== undefined) { ev.preventDefault(); srch.kind = t.dataset.skind; return runSearch().then(renderSearch); }
  if (t.id === "drRun") { ev.preventDefault(); return runDryRun(); }
  if (t.dataset.inc) { state.incFilter = t.dataset.inc; state.allIncidents = null; return refresh(); }
  if (t.dataset.ack) {
    ev.preventDefault(); ev.stopPropagation();
    return fetch(`/v1/incidents/${t.dataset.ack}/ack`, { method: "POST" }).then(refresh);
  }
  if (t.dataset.ackall) {
    return fetch("/v1/incidents/ack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: state.sel || undefined }) }).then(refresh);
  }
  if (t.dataset.days) { ev.preventDefault(); state.spendDays = Number(t.dataset.days); return touch(); }
  if (t.dataset.sdays) { ev.preventDefault(); state.statsDays = Number(t.dataset.sdays); return touch(); }
  if (t.dataset.release || t.dataset.forcerelease) {
    ev.preventDefault();
    const force = Boolean(t.dataset.forcerelease);
    const [projectId, task] = (t.dataset.release || t.dataset.forcerelease).split(":");
    if (force && !confirm(`Force-release ${task}? This permanently discards its worktree and any uncommitted work.`)) return;
    const r = await fetch("/v1/claims/release", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, task, force }) }).then((x) => x.json());
    if (!r.ok) {
      if (confirm(`${r.error}\n\nForce-release anyway (discards the work)?`)) {
        await fetch("/v1/claims/release", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, task, force: true }) });
      }
    }
    return refresh();
  }
  if (t.dataset.agent !== undefined && t.classList.contains("chip")) { state.agentFilter = t.dataset.agent || null; return touch(); }
  if (t.dataset.merge !== undefined) {
    ev.preventDefault();
    const [projectId, number] = t.dataset.merge.split(":");
    if (!confirm(`Squash-merge #${number}?`)) return;
    return fetch("/v1/prs/merge", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, number: Number(number) }),
    }).then(async (r) => { if (!r.ok) alert((await r.json()).error); return refresh(); });
  }
  if (t.dataset.procstop) {
    ev.preventDefault();
    if (!confirm(`Stop pid ${t.dataset.procstop}?`)) return;
    return fetch(`/v1/processes/${t.dataset.procstop}?project=${encodeURIComponent(t.dataset.procproj)}`, { method: "DELETE" }).then(async (r) => { if (!r.ok) alert((await r.json()).error); return refresh(); });
  }
  if (t.dataset.resrelease !== undefined) {
    ev.preventDefault();
    const q = new URLSearchParams({ force: "1" }); if (t.dataset.resproj) q.set("project", t.dataset.resproj);
    return fetch(`/v1/resources/${encodeURIComponent(t.dataset.resrelease)}?${q}`, { method: "DELETE" }).then(refresh);
  }
  if (t.id === "back") { ev.preventDefault(); state.session = null; return touch(); }
  if (t.id === "replay") { ev.preventDefault(); return openReplay(); }
  if (t.id === "resumeDead") { ev.preventDefault(); return resumeDead(); }
  if (t.dataset.s) { ev.preventDefault(); return openSession(t.dataset.s); }
  if (t.dataset.id !== undefined) { state.sel = t.dataset.id || null; localStorage.setItem("swarm.sel", state.sel ?? ""); state.session = null; state.tasks = null; state.dirty = true; return refresh(); }
});
async function addProject(path) {
  if (!path) return;
  const r = await fetch("/v1/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
  if (!r.ok) return alert((await r.json()).error);
  refresh();
}
// "+" in the Projects header: menu of ways to add a project
document.addEventListener("click", (ev) => {
  const t = ev.target.closest?.("#addProj");
  if (!t || !window.menus) return;
  window.menus.open(t, { items: [
    { label: "Browse folders\u2026", icon: "folder-simple", run: () => openPicker() },
    { label: "Add by path\u2026", icon: "terminal-window", run: () => openPicker(true) },
  ] });
});
// collapsible sidebar, persisted
const sbApply = () => {
  const off = localStorage.getItem("swarm.sidebar") === "off";
  document.body.classList.toggle("nosb", off);
  const b = $("#sbToggle");
  if (b) b.innerHTML = ic(off ? "arrow-bar-right" : "arrow-bar-left", 15);
};
$("#sbToggle")?.addEventListener("click", () => {
  localStorage.setItem("swarm.sidebar", document.body.classList.contains("nosb") ? "on" : "off");
  sbApply();
});
sbApply();

// ---------- folder picker
const picker = { path: null };
// Run drawer (M3.3): prompt prefilled from the task row; submit = POST /v1/runs.
function openRunDrawer(taskId) {
  const task = (state.tasks?.tasks ?? []).find((t) => t.id === taskId);
  const title = task ? `${task.id} — ${task.title}` : taskId;
  const prompt = task
    ? `Task ${task.id}: ${task.title}\n\nWork only inside this worktree. When done: commit, push, then call swarm_handoff with what was done and what remains, and record the required gates with swarm_gate_record.`
    : "";
  const last = (() => { try { return JSON.parse(localStorage.getItem("swarm.runOpts") || "{}"); } catch { return {}; } })();
  const opt = (v, cur) => `<option value="${v}" ${v === cur ? "selected" : ""}>${v || "default"}</option>`;
  $("#picker").innerHTML = `<div class="pk" role="dialog" aria-modal="true">
    <div class="pk-h">${ic("play", 15)}<b>Run</b><span class="dim now" style="flex:1;margin-left:8px">${esc(title)}</span></div>
    <div class="pk-b">
      <label>prompt<textarea id="rnPrompt" spellcheck="false">${esc(prompt)}</textarea></label>
      <div class="row">
        <label>permission mode<select id="rnMode">${["acceptEdits", "auto", "plan", "dontAsk", "manual", "bypassPermissions"].map((m) => opt(m, last.mode ?? "acceptEdits")).join("")}</select></label>
        <label>model<input id="rnModel" placeholder="default" value="${esc(last.model ?? "")}"></label>
        <label>max turns<input id="rnTurns" type="number" min="1" placeholder="∞" value="${esc(last.turns ?? "")}"></label>
      </div>
      <div class="dim" style="font-size:var(--fs-sm)">Claims <b>${esc(taskId)}</b> (or reuses your held worktree) and spawns <code>claude -p</code> there. The session appears in Fleet; steer it from its page.</div>
    </div>
    <div class="pk-f"><span class="grow"></span><button id="rnCancel">Cancel</button><button class="primary" id="rnGo" data-task="${esc(taskId)}">${ic("play", 13)} Run</button></div>
  </div>`;
  $("#rnPrompt")?.focus();
}
async function submitRun(taskId) {
  const prompt = $("#rnPrompt")?.value.trim();
  if (!prompt) return alert("A prompt is required.");
  const mode = $("#rnMode")?.value, model = $("#rnModel")?.value.trim(), turns = $("#rnTurns")?.value;
  localStorage.setItem("swarm.runOpts", JSON.stringify({ mode, model, turns }));
  closePicker();
  const r = await fetch("/v1/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    projectId: state.sel, task: taskId, prompt, owner: "dashboard", permissionMode: mode, model: model || undefined, maxTurns: turns ? Number(turns) : undefined,
  }) }).then((x) => x.json());
  if (!r.ok) return alert(r.error);
  state.tasks = null;
  await refresh();
  openSession(r.run.sessionId);
}

// ---------- worktree diff + PR drawers (M7.3)
const diffState = { projectId: null, worktree: null, base: null, files: [] };
function colorPatch(patch) {
  return esc(patch).split("\n").map((l) => {
    const c = l.startsWith("+++") || l.startsWith("---") ? "m" : l.startsWith("@@") ? "h" : l.startsWith("+") ? "a" : l.startsWith("-") ? "d" : l.startsWith("diff ") ? "m" : "";
    return c ? `<span class="${c}">${l}</span>` : l;
  }).join("\n");
}
async function openDiffDrawer(projectId, worktree) {
  const q = new URLSearchParams({ project: projectId, worktree });
  const d = await fetch(`/v1/worktrees/diff?${q}`).then((x) => x.json());
  if (d.error) return alert(d.error);
  Object.assign(diffState, { projectId, worktree: d.worktree, base: d.base, files: d.files });
  const files = d.files.map((f) => `<a href="#" data-dffile="${esc(f.path)}"><span class="st">${esc(f.status)}</span><span class="pa" title="${esc(f.path)}">${esc(f.path)}</span>${f.added >= 0 ? `<span class="pl">+${f.added}</span><span class="mi">−${f.deleted}</span>` : '<span class="dim">bin</span>'}</a>`).join("");
  $("#picker").innerHTML = `<div class="pk wide" role="dialog" aria-modal="true">
    <div class="pk-h">${ic("folders", 15)}<b>Diff</b><span class="dim now" style="flex:1;margin-left:8px">${esc(short(d.worktree))} · vs ${esc(d.baseRef ?? "HEAD")} · ${d.commits.length} commit${d.commits.length === 1 ? "" : "s"} · ${d.files.length} file${d.files.length === 1 ? "" : "s"}${d.dirty ? ' · <span class="badge warn">dirty</span>' : ""}</span></div>
    <div class="pk-b">
      ${d.commits.length ? `<div class="dim" style="font-size:var(--fs-sm)">${d.commits.slice(0, 8).map(esc).join("<br>")}${d.commits.length > 8 ? `<br>… ${d.commits.length - 8} more` : ""}</div>` : ""}
      ${d.files.length ? `<div class="df-files">${files}</div><pre class="df-patch" id="dfPatch"><span class="m">select a file — or view everything below</span></pre>` : '<div class="empty">Nothing changed.</div>'}
    </div>
    <div class="pk-f">${d.files.length ? `<a href="#" class="nav" data-dffile="">${ic("folders", 12)} Whole diff</a>` : ""}<span class="grow"></span><button id="pkClose">Close</button></div>
  </div>`;
  $("#pkClose")?.addEventListener("click", closePicker);
}
async function loadDiffFile(file) {
  const q = new URLSearchParams({ project: diffState.projectId, worktree: diffState.worktree });
  if (file) q.set("file", file); else q.set("patch", "1");
  for (const a of document.querySelectorAll(".df-files a")) a.classList.toggle("on", a.dataset.dffile === file);
  const el = $("#dfPatch"); if (el) el.innerHTML = '<span class="m">loading…</span>';
  const d = await fetch(`/v1/worktrees/diff?${q}`).then((x) => x.json());
  if (el) el.innerHTML = d.patch ? colorPatch(d.patch) : '<span class="m">(empty)</span>';
}
async function openPrDrawer(projectId, worktree) {
  const q = new URLSearchParams({ project: projectId, worktree });
  const d = await fetch(`/v1/prs/draft?${q}`).then((x) => x.json());
  if (!d.ok) return alert(d.error);
  $("#picker").innerHTML = `<div class="pk" role="dialog" aria-modal="true">
    <div class="pk-h">${ic("git-pull-request", 15)}<b>Open PR</b><span class="dim now" style="flex:1;margin-left:8px">${esc(d.task)} · ${esc(d.worktree.branch ?? "")}${d.diff.dirty ? ' · <span class="badge warn">uncommitted changes — commit first</span>' : ""}</span></div>
    <div class="pk-b">
      <label>title<input id="prTitle" value="${esc(d.title)}"></label>
      <label>body<textarea id="prBody" style="min-height:220px">${esc(d.body)}</textarea></label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="prDraft" style="width:auto"> draft</label>
      <div class="dim" style="font-size:var(--fs-sm)">Pushes <code>${esc(d.worktree.branch ?? "")}</code> to origin and runs <code>gh pr create</code> / <code>glab mr create</code> with your local login. Swarm never commits for you.</div>
    </div>
    <div class="pk-f"><span class="grow"></span><button id="pkClose">Cancel</button><button class="primary" id="prGo" data-project="${esc(projectId)}" data-worktree="${esc(d.worktree.path)}" ${d.diff.dirty ? "disabled" : ""}>${ic("git-pull-request", 13)} Open PR</button></div>
  </div>`;
  $("#pkClose")?.addEventListener("click", closePicker);
}
async function submitPr() {
  const b = $("#prGo"); if (!b) return;
  const projectId = b.dataset.project, worktree = b.dataset.worktree;
  const title = $("#prTitle")?.value.trim(), body = $("#prBody")?.value, draft = $("#prDraft")?.checked;
  b.disabled = true; b.textContent = "opening…";
  const r = await fetch("/v1/prs/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, worktree, title, body, draft }) }).then((x) => x.json());
  if (!r.ok) { b.disabled = false; b.textContent = "Open PR"; return alert(r.error); }
  closePicker();
  state.prs = [];
  await refresh();
  if (r.url) window.open(r.url, "_blank");
}

async function openPicker(focusPath = false) {
  await pickerGo("");
  if (focusPath) { const i = $("#pkPath"); if (i) { i.focus(); i.select(); } }
}
async function pickerGo(path) {
  let data;
  try {
    const r = await fetch(`/v1/fs/ls?path=${encodeURIComponent(path)}`);
    data = await r.json();
    if (!r.ok) throw new Error(data.error || "cannot read folder");
  } catch (e) { return alert(e.message); }
  picker.path = data.path;
  const rows = [];
  if (data.parent) rows.push(`<div class="pk-row up" data-go="${esc(data.parent)}">${ic("arrow-left", 14)}<span class="nm">..</span></div>`);
  const base = data.path.replace(/\/$/, "");
  for (const e of data.entries)
    rows.push(`<div class="pk-row" data-go="${esc(base)}/${esc(e.name)}">${ic(e.repo ? "git-branch" : "folder-simple", 14)}<span class="nm">${esc(e.name)}</span>${e.repo ? '<span class="badge acc">git</span>' : ""}</div>`);
  $("#picker").innerHTML = `<div class="pk" role="dialog" aria-modal="true">
    <div class="pk-h">${ic("folders", 15)}<input id="pkPath" value="${esc(data.path)}" spellcheck="false" autocomplete="off" title="Type a path and press Enter"></div>
    <div class="pk-list">${rows.join("") || '<div class="empty" style="padding:20px">No sub-folders.</div>'}</div>
    <div class="pk-f"><span class="grow"></span><button type="button" id="pkCancel">Cancel</button><button type="button" id="pkAdd" class="primary">Add this folder</button></div>
  </div>`;
}
const closePicker = () => { $("#picker").innerHTML = ""; };
$("#picker").addEventListener("click", (ev) => {
  if (ev.target.id === "picker" || ev.target.closest("#pkCancel")) return closePicker();
  const go = ev.target.closest("[data-go]");
  if (go) return void pickerGo(go.dataset.go);
  const ctoml = ev.target.closest("[data-copy-toml]"), cles = ev.target.closest("[data-copy-lesson]");
  if (ctoml) { ev.preventDefault(); copy($(`#toml-${ctoml.dataset.copyToml}`)?.textContent); ctoml.lastChild.textContent = " copied"; return; }
  if (cles) { ev.preventDefault(); copy($(`#lesson-${cles.dataset.copyLesson}`)?.textContent); cles.lastChild.textContent = " copied"; return; }
  if (ev.target.closest("#rpPrev")) return replayGo(-1);
  if (ev.target.closest("#rpNext")) return replayGo(1);
  if (ev.target.closest("#rnCancel")) return closePicker();
  const rnGo = ev.target.closest("#rnGo"); if (rnGo) return submitRun(rnGo.dataset.task);
  if (ev.target.closest("#pkAdd")) { const p = $("#pkPath")?.value.trim() || picker.path; closePicker(); addProject(p); }
});
$("#picker").addEventListener("input", (ev) => { if (ev.target.id === "rpRange") { replay.i = Number(ev.target.value); renderReplay(); } });
$("#picker").addEventListener("change", (ev) => { if (ev.target.dataset?.drmode) { dry.modes[ev.target.dataset.drmode] = ev.target.value; } });
$("#picker").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && ev.target.id === "pkPath") { ev.preventDefault(); pickerGo(ev.target.value.trim()); }
  if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey) && ev.target.id === "rnPrompt") { ev.preventDefault(); submitRun($("#rnGo")?.dataset.task); }
  if ((ev.key === "ArrowRight" || ev.key === "ArrowLeft") && $(".rp")) { ev.preventDefault(); replayGo(ev.key === "ArrowRight" ? 1 : -1); }
});
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && $("#picker").innerHTML) closePicker(); });

// ---------- live
// Poll for whatever the stream doesn't carry (turn costs, worktrees, PRs); SSE events coalesce into one
// fetch 400 ms later. Both pause while the tab is hidden and resume on the next visibilitychange.
const poll = () => (state.session ? openSession(state.session) : refresh());
let pending = false;
const pollSoon = () => { if (!pending) { pending = true; setTimeout(() => { pending = false; poll(); }, 400); } };
let backoff = 1500;
function connect() {
  const es = new EventSource(`/v1/events?since=${state.seq}`);
  const on = () => { backoff = 1500; $("#daemon .dot").classList.add("on"); };
  es.addEventListener("open", on);
  es.addEventListener("ping", on);
  es.onerror = () => { $("#daemon .dot").classList.remove("on"); es.close(); setTimeout(connect, backoff); backoff = Math.min(30_000, backoff * 2); };
  const onAny = (e) => {
    $("#daemon .dot").classList.add("on");
    const ev = JSON.parse(e.data);
    // Replayed events (reconnect) only bump the seq; the coalesced poll below picks up the rest.
    const fresh = ev.seq > state.seq;
    state.seq = Math.max(state.seq, ev.seq);
    if (fresh && state.session && ev.sessionId === state.session && !state.log.some((x) => x.seq === ev.seq)) {
      state.log.push(ev);
      if (state.log.length > LOG_CAP) state.log.shift();
      schedule();
    }
    if (fresh) notifyForEvent(ev);
    pollSoon();
  };
  for (const t of ["session.started", "session.ended", "prompt.submitted", "tool.requested", "tool.completed", "subagent.started", "subagent.stopped", "agent.text", "session.notification", "incident.opened", "claim.acquired", "claim.released", "resource.acquired", "resource.released", "resource.reaped", "process.started", "process.exited", "gate.recorded", "claim.orphaned", "claim.renewed", "worktree.bootstrapped", "worktree.created", "worktree.removed", "pr.opened", "permission.requested", "permission.resolved"]) es.addEventListener(t, onAny);
}
refresh().then(() => {
  const sid = new URLSearchParams(location.search).get("session");
  if (sid) openSession(sid);
  connect();
});
setInterval(() => { if (!document.hidden) poll(); }, 5000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
