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
const state = { projects: [], sessions: [], worktrees: {}, spend: null, seq: 0, sel: null, session: null, log: [], turns: [], view: "fleet", agentFilter: null };

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ago = (iso) => { const d = (Date.now() - new Date(iso)) / 1000; return d < 60 ? `${d | 0}s` : d < 3600 ? `${(d / 60) | 0}m` : d < 86400 ? `${(d / 3600) | 0}h` : `${(d / 86400) | 0}d`; };
const hhmm = (iso) => new Date(iso).toTimeString().slice(0, 8);
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
const agentBadge = (a) => (a && a !== "claude-code" ? `<span class="badge agent" style="color:${viz.agentColor(a)};background:color-mix(in srgb,${viz.agentColor(a)} 14%,transparent)">${esc(agentLabel(a))}</span>` : "");

async function refresh() {
  Object.assign(state, await (await fetch("/v1/state")).json());
  render();
}
function render() {
  // Live refresh re-renders the whole view; keep focus + caret in a grid filter input alive.
  const af = document.activeElement;
  const keep = af?.dataset?.filter ? { key: af.dataset.filter, tid: af.dataset.tid, pos: af.selectionStart } : null;
  renderProjects();
  renderHeader();
  if (state.session) renderSession();
  else if (state.view === "spend") renderSpend();
  else if (state.view === "timeline") renderTimeline();
  else renderFleet();
  if (keep) {
    const el = document.querySelector(`input[data-filter="${keep.key}"][data-tid="${keep.tid}"]`);
    if (el) { el.focus(); el.setSelectionRange(keep.pos, keep.pos); }
  }
}
function renderHeader() {
  const today = state.spend ? sumBy(state.spend.byProjectToday, (x) => x.cost) : 0;
  $("#today").innerHTML = `Today <b>${usd(today)}</b>`;
  for (const a of document.querySelectorAll("header a[data-view]")) a.classList.toggle("on", !state.session && a.dataset.view === state.view);
}

function renderProjects() {
  const live = (pid) => state.sessions.filter((s) => s.projectId === pid && (s.state === "active" || s.state === "waiting")).length;
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
    return `<div class="proj ${state.sel === p.id ? "sel" : ""}" data-id="${p.id}" data-ctx="project" data-pid="${p.id}" title="${esc(p.root)}">
      <span class="st ${live(p.id) ? "live" : ""}"></span>${ic("folder-simple", 14)}<span class="nm">${disamb(p)}${esc(p.name)}</span><small>${live(p.id) || ""}</small>${act}</div>`;
  };
  const liveAll = state.sessions.filter((s) => s.state === "active" || s.state === "waiting").length;
  $("#projects").innerHTML =
    `<h4>Projects <span class="h4-act" id="addProj" title="Add project">${ic("plus", 14)}</span></h4>` +
    `<div class="proj ${state.sel === null ? "sel" : ""}" data-id=""><span class="st ${liveAll ? "live" : ""}"></span>${ic("folders", 14)}<span class="nm">All projects</span><small>${liveAll || ""}</small></div>` +
    pinned.map(row).join("") +
    (unpinned.length ? `<h4>Unpinned <span class="faint" style="text-transform:none;letter-spacing:0;font-weight:400">· seen, not pinned</span></h4>${unpinned.map(row).join("")}` : "") +
    (!pinned.length && !unpinned.length ? `<div class="empty" style="padding:16px;font-size:12px">${PX.folder()}No projects yet.<br>Add a folder below, or start Claude in one.</div>` : "");
}

// ---------- fleet
// Fleet data-grid columns (sortable/resizable/reorderable/filterable via table.js).
const FLEET_COLS = [
  { key: "project", label: "project", width: 104, get: (s) => projName(s.projectId), cell: (s) => esc(projName(s.projectId)) },
  { key: "session", label: "session", width: 236, get: (s) => s.title ?? s.id, cell: (s) => `${kindIcon(s)}${agentBadge(s.agent)}<b>${esc(s.title ?? s.id.slice(0, 8))}</b>${s.subagents ? ` <span class="badge acc">${s.subagents} Sub</span>` : ""}` },
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
  const agents = [...new Set(base.map((s) => s.agent))].sort();
  const rows = base.filter((s) => !state.agentFilter || s.agent === state.agentFilter);
  const live = rows.filter((s) => s.state === "active" || s.state === "waiting");
  const rest = rows.filter((s) => !(s.state === "active" || s.state === "waiting"));
  const cols = FLEET_COLS.filter((c) => !(c.key === "project" && state.sel));
  const table = (list) =>
    dataTable({
      id: "fleet",
      columns: cols,
      rows: list,
      leading: { width: 24, cell: (s) => `<span class="s ${s.state}"></span>` },
      trailing: { width: 34, cell: (s) => `<span class="more" data-menu="session" data-sid="${s.id}" title="Session actions">${ic("dots-three", 15)}</span>` },
      rowAttrs: (s) => `data-s="${s.id}" data-ctx="session" data-sid="${s.id}"`,
      rerender: renderFleet,
    });
  const chips = agents.length > 1
    ? `<div class="chips"><span class="chip ${!state.agentFilter ? "on" : ""}" data-agent="">All</span>${agents
        .map((a) => `<span class="chip ${state.agentFilter === a ? "on" : ""}" data-agent="${a}">${esc(agentLabel(a))} <b>${base.filter((s) => s.agent === a).length}</b></span>`)
        .join("")}</div>`
    : "";
  $("#main").innerHTML = chips +
    `<h2>Live <span>${live.length} sessions · ${usd(sumBy(live, (s) => s.costUsd))}</span></h2>` +
    (live.length ? table(live) : `<div class="empty">${PX.idle()}Nothing running.${state.sessions.length ? "" : "<br><br>Run <kbd>swarm install</kbd> once, then start <kbd>claude</kbd> in any folder — it will appear here."}</div>`) +
    (rest.length ? `<h2 class="mt-sec">Earlier <span>${rest.length}</span></h2>${table(rest.slice(0, 30))}` : "") +
    renderClaims() +
    renderWorktrees();
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
      rerender: render,
    });
}

function renderWorktrees() {
  const ids = state.sel ? [state.sel] : state.projects.map((p) => p.id);
  const rows = ids.flatMap((id) => (state.worktrees[id] ?? []).map((w) => ({ ...w, projectId: id })));
  if (!rows.length) return "";
  const inside = (w) => state.sessions.filter((s) => s.state !== "ended" && (s.cwd === w.path || s.cwd.startsWith(`${w.path}/`)));
  const badge = (n, label, cls) => (n > 0 ? `<span class="badge ${cls}">${n} ${label}</span>` : "");
  const cols = [
    { key: "project", label: "project", width: 104, get: (w) => projName(w.projectId), cell: (w) => esc(projName(w.projectId)) },
    { key: "branch", label: "branch", width: 240, get: (w) => w.branch ?? "", cell: (w) => `<span class="br">${esc(w.branch ?? "(detached)")}</span>${w.main ? ' <span class="badge">Main tree</span>' : ""}` },
    { key: "head", label: "head", width: 90, get: (w) => w.head, cell: (w) => `<span class="br">${esc(w.head)}</span>` },
    { key: "path", label: "path", flex: true, get: (w) => w.path, cell: (w) => `<span class="now" title="${esc(w.path)}">${esc(short(w.path))}</span>` },
    { key: "state", label: "state", width: 170, get: (w) => w.dirty * 1000 + w.ahead, cell: (w) => `${badge(w.dirty, "Dirty", "warn")}${badge(w.ahead, "Unpushed", "acc")}${w.dirty === 0 && w.ahead <= 0 ? '<span class="badge">Clean</span>' : ""}` },
    { key: "sessions", label: "sessions", width: 160, get: (w) => inside(w).length, cell: (w) => inside(w).map((x) => `<a href="#" data-s="${x.id}">${esc(x.title ?? x.id.slice(0, 8))}</a>`).join(", ") || '<span class="dim">—</span>' },
  ].filter((c) => !(c.key === "project" && state.sel));
  return `<h2 class="mt-sec">Worktrees <span>${rows.length}</span></h2>` +
    dataTable({
      id: "worktrees",
      columns: cols,
      rows,
      leading: { width: 24, cell: (w) => `<span class="s ${inside(w).length ? "active" : w.dirty > 0 ? "waiting" : "ended"}"></span>` },
      trailing: { width: 34, cell: () => "" },
      rerender: render,
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
  for (let i = N - 1; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(d.toISOString().slice(0, 10)); }
  const inRange = sp.daily.filter((d) => inSel(d) && d.day >= days[0]);
  const agents = [...new Set(inRange.map((d) => d.agent))].sort(viz.agentSort);
  const series = Object.fromEntries(agents.map((a) => [a, days.map((day) => sumBy(inRange.filter((d) => d.day === day && d.agent === a), (d) => d.cost))]));
  const total14 = sumBy(inRange, (d) => d.cost);
  const today = days.at(-1);
  const todayCost = sumBy(inRange.filter((d) => d.day === today), (d) => d.cost);
  const todayTurns = sumBy(inRange.filter((d) => d.day === today), (d) => d.turns);
  const activeDays = new Set(inRange.filter((d) => d.cost).map((d) => d.day)).size;
  const prevDays = new Set(inRange.filter((d) => d.cost && d.day !== today).map((d) => d.day)).size;
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
      rerender: render,
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
     <div class="cols" class="mt-sec"><div><h2>By project · today <span>${usd(sumBy(filt(sp.byProjectToday), (x) => x.cost))}</span></h2>${tbl(filt(sp.byProjectToday), "project", projName)}
     <h2 class="mt-sec">By project · all time</h2>${tbl(filt(sp.byProjectAll), "project", projName)}</div>
     <div>${byAgentToday ? `<h2>By model · today</h2>${tbl(sp.byModelToday, "model", model)}` : ""}<h2 style="${byAgentToday ? "margin-top:18px" : ""}">By model · all time</h2>${tbl(sp.byModelAll, "model", model)}</div></div>
     <p class="dim" style="margin-top:var(--gap-sec)">Costs use list prices (static table, refreshed from LiteLLM when online; override in <code>~/.swarm/pricing.json</code>). Cache reads are the bulk of "ctx". Sessions on a subscription plan still show what the tokens would cost at API rates.</p>`;
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
async function openSession(id) {
  state.session = id;
  const d = await (await fetch(`/v1/sessions/${id}/events`)).json();
  state.log = d.events;
  state.turns = d.turns;
  render();
}
function sessionStream(s) {
  const items = [
    ...state.log.filter((e) => e.payload?.hook !== "PostToolUse").map((e) => ({ ts: e.ts, kind: e.payload?.hook ?? e.type, text: e.payload?.summary ?? "", cls: e.type })),
    ...state.turns.filter((t) => t.text).map((t) => ({ ts: t.ts, kind: t.sidechain ? "subagent" : "assistant", text: t.text, cls: "assistant", cost: t.costUsd, out: t.output })),
  ].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  return items.map((i) => `<div class="ev ${i.cls}"><span class="t">${hhmm(i.ts)}</span><span class="k">${esc(i.kind)}</span><span class="m">${esc(i.text)}${i.out ? `<span class="dim"> · ${tok(i.out)} out${i.cost != null ? ` · $${i.cost.toFixed(3)}` : ""}</span>` : ""}</span></div>`).join("");
}
function renderSession() {
  const s = state.sessions.find((x) => x.id === state.session);
  if (!s) return;
  const logEl = $("#log");
  const atBottom = !logEl || logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 40;
  const prevTop = logEl ? logEl.scrollTop : 0;
  const tools = Object.entries(s.toolCounts).sort((a, b) => b[1] - a[1]);
  const t = s.tokens;
  const ctx = t.input + t.cacheRead + t.cacheWrite;
  const subTurns = state.turns.filter((x) => x.sidechain || x.agentId);
  const STAT_ICON = { cost: "coin", model: "robot", turns: "arrows-clockwise", "tool calls": "wrench", output: "chart-bar", context: "rows", started: "clock", "last seen": "eye", "subagent turns": "tree-structure" };
  const stat = (k, v) => `<div class="stat"><span>${ic(STAT_ICON[k] ?? "list-bullets", 13)}${k}</span><b>${v}</b></div>`;
  $("#main").innerHTML = `<h2 class="hrow"><a class="back" href="#" id="back">${ic("arrow-left", 13)}back</a> ${esc(projName(s.projectId))} · <span class="s ${s.state}"></span> ${kindIcon(s)}${agentBadge(s.agent)}<b>${esc(s.title ?? s.id.slice(0, 8))}</b> <span>${esc(short(s.cwd))}${s.branch ? ` · ${esc(s.branch)}` : ""} · ${s.state}</span></h2>
  <div class="sess"><div id="log">${sessionStream(s)}</div>
  <aside class="side">
    ${stat("cost", usd(s.costUsd))}${stat("model", esc(model(s.model)) || "—")}${stat("turns", s.turns)}${stat("tool calls", s.toolCalls)}
    ${stat("output", `${tok(t.output)}${t.thinking ? `<small> · ${tok(t.thinking)} thinking</small>` : ""}`)}${stat("context", `${tok(ctx)}<small> · ${ctx ? ((100 * t.cacheRead) / ctx).toFixed(0) : 0}% cached</small>`)}
    ${stat("started", `${ago(s.startedAt)} ago`)}${stat("last seen", `${ago(s.lastSeenAt)} ago`)}
    ${subTurns.length ? stat("subagent turns", subTurns.length) : ""}
    <h4>tokens</h4>${viz.compositionBar([{ label: "cache read", v: t.cacheRead }, { label: "cache write", v: t.cacheWrite }, { label: "input", v: t.input }, { label: "thinking", v: t.thinking }, { label: "output", v: t.output }])}
    ${state.turns.length > 1 ? `<h4>cost per turn</h4>${viz.turnStrip(state.turns, { height: 54 })}` : ""}
    <h4>tools</h4>${tools.length ? viz.hbars(tools.slice(0, 8).map(([k, v]) => [k.replace(/^mcp__[a-z0-9-]+__/i, ""), v])) : '<span class="dim">None yet</span>'}
    ${s.transcriptPath ? `<h4>transcript</h4><div class="dim mono" style="word-break:break-all">${ic("file-text", 12)} ${esc(short(s.transcriptPath))}</div>` : ""}
  </aside></div>`;
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
      { label: "Show sessions", icon: "squares-four", caption: live ? `${live} live` : undefined, run: () => { state.sel = p.id; state.view = "fleet"; state.session = null; render(); } },
      { label: "Show in Timeline", icon: "clock-counter-clockwise", run: () => { state.sel = p.id; state.view = "timeline"; state.session = null; render(); } },
      { label: "Spend", icon: "coins", run: () => { state.sel = p.id; state.view = "spend"; state.session = null; render(); } },
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
      { label: "Show in Timeline", icon: "clock-counter-clockwise", run: () => { state.sel = s.projectId; state.view = "timeline"; state.session = null; render(); } },
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
      { label: "Documentation", icon: "book-open", caption: "GitHub", run: () => window.open("https://github.com/ra3orblade/swarm#readme", "_blank") },
    ] };
  }
  return null;
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
  const t = ev.target.closest("[data-menu],#settings,[data-id],[data-s],#back,[data-view],.chip,[data-tl],[data-days],[data-release],[data-forcerelease]");
  if (!t) return;
  if (t.dataset.menu) { ev.preventDefault(); ev.stopPropagation(); return openMenu(t.dataset.menu, t, t.dataset); }
  if (t.id === "settings") { ev.preventDefault(); return openMenu("settings", t, {}); }
  if (t.dataset.view) { ev.preventDefault(); state.view = t.dataset.view; state.session = null; return render(); }
  if (t.dataset.tl) { ev.preventDefault(); state.tlHours = Number(t.dataset.tl); return render(); }
  if (t.dataset.days) { ev.preventDefault(); state.spendDays = Number(t.dataset.days); return render(); }
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
  if (t.dataset.agent !== undefined && t.classList.contains("chip")) { state.agentFilter = t.dataset.agent || null; return renderFleet(); }
  if (t.id === "back") { ev.preventDefault(); state.session = null; return render(); }
  if (t.dataset.s) { ev.preventDefault(); return openSession(t.dataset.s); }
  if (t.dataset.id !== undefined) { state.sel = t.dataset.id || null; state.session = null; return render(); }
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
  if (ev.target.closest("#pkAdd")) { const p = $("#pkPath")?.value.trim() || picker.path; closePicker(); addProject(p); }
});
$("#picker").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && ev.target.id === "pkPath") { ev.preventDefault(); pickerGo(ev.target.value.trim()); }
});
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && $("#picker").innerHTML) closePicker(); });

// ---------- live
function connect() {
  const es = new EventSource(`/v1/events?since=${state.seq}`);
  const on = () => $("#daemon .dot").classList.add("on");
  es.addEventListener("open", on);
  es.addEventListener("ping", on);
  es.onerror = () => { $("#daemon .dot").classList.remove("on"); es.close(); setTimeout(connect, 1500); };
  let pending = false;
  const onAny = (e) => {
    on();
    const ev = JSON.parse(e.data);
    state.seq = Math.max(state.seq, ev.seq);
    if (state.session && ev.sessionId === state.session) { state.log.push(ev); renderSession(); }
    if (!pending) { pending = true; setTimeout(() => { pending = false; state.session ? openSession(state.session) : refresh(); }, 400); }
  };
  for (const t of ["session.started", "session.ended", "prompt.submitted", "tool.requested", "tool.completed", "subagent.started", "subagent.stopped", "agent.text", "incident.opened", "claim.acquired", "claim.released"]) es.addEventListener(t, onAny);
}
refresh().then(connect);
setInterval(() => { if (state.session) openSession(state.session); else refresh(); }, 5000);
