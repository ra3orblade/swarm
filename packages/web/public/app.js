const $ = (s) => document.querySelector(s);
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
const agentLabel = (a) => viz.agentName(a);
const agentBadge = (a) => (a && a !== "claude-code" ? `<span class="badge agent" style="color:${viz.agentColor(a)};background:color-mix(in srgb,${viz.agentColor(a)} 14%,transparent)">${esc(agentLabel(a))}</span>` : "");

async function refresh() {
  Object.assign(state, await (await fetch("/v1/state")).json());
  render();
}
function render() {
  renderProjects();
  renderHeader();
  if (state.session) renderSession();
  else if (state.view === "spend") renderSpend();
  else if (state.view === "timeline") renderTimeline();
  else renderFleet();
}
function renderHeader() {
  const today = state.spend ? sumBy(state.spend.byProjectToday, (x) => x.cost) : 0;
  $("#today").innerHTML = `today <b>${usd(today)}</b>`;
  for (const a of document.querySelectorAll("header a[data-view]")) a.classList.toggle("on", !state.session && a.dataset.view === state.view);
}

function renderProjects() {
  const live = (pid) => state.sessions.filter((s) => s.projectId === pid && (s.state === "active" || s.state === "waiting")).length;
  const pinned = state.projects.filter((p) => !p.discovered);
  const unpinned = state.projects.filter((p) => p.discovered);
  const row = (p) => {
    const act = p.discovered
      ? `<span class="act" data-pin="${p.id}" title="Pin this project">☆</span>`
      : `<span class="act rm" data-rm="${p.id}" title="Remove from Swarm">×</span>`;
    return `<div class="proj ${state.sel === p.id ? "sel" : ""}" data-id="${p.id}" title="${esc(p.root)}">
      <span class="st ${live(p.id) ? "live" : ""}"></span><span class="nm">${esc(p.name)}</span><small>${live(p.id) || ""}</small>${act}</div>`;
  };
  const liveAll = state.sessions.filter((s) => s.state === "active" || s.state === "waiting").length;
  $("#projects").innerHTML =
    `<h4>Projects</h4>` +
    `<div class="proj ${state.sel === null ? "sel" : ""}" data-id=""><span class="st ${liveAll ? "live" : ""}"></span><span class="nm">All projects</span><small>${liveAll || ""}</small></div>` +
    pinned.map(row).join("") +
    (unpinned.length ? `<h4>Unpinned <span class="faint" style="text-transform:none;letter-spacing:0;font-weight:400">· seen, not pinned</span></h4>${unpinned.map(row).join("")}` : "") +
    (!pinned.length && !unpinned.length ? `<div class="empty" style="padding:16px;font-size:12px">No projects yet.<br>Add a folder below, or start Claude in one.</div>` : "");
}

// ---------- fleet
function renderFleet() {
  const base = state.sessions.filter((s) => !state.sel || s.projectId === state.sel);
  const agents = [...new Set(base.map((s) => s.agent))].sort();
  const rows = base.filter((s) => !state.agentFilter || s.agent === state.agentFilter);
  const live = rows.filter((s) => s.state === "active" || s.state === "waiting");
  const rest = rows.filter((s) => !(s.state === "active" || s.state === "waiting"));
  const table = (list) => `<div class="card"><table><thead><tr><th style="width:24px"></th>${state.sel ? "" : '<th style="width:104px">project</th>'}<th style="width:236px">session</th><th style="width:134px">branch</th><th>now</th><th style="width:88px">model</th><th style="width:100px" title="output tokens per turn, last 24 turns">trend</th><th class="num" style="width:66px">out</th><th class="num" style="width:70px">ctx</th><th class="num" style="width:62px">cost</th><th class="num" style="width:46px">age</th></tr></thead><tbody>${list
    .map((s) => `<tr data-s="${s.id}"><td><span class="s ${s.state}"></span></td>${state.sel ? "" : `<td>${esc(projName(s.projectId))}</td>`}<td title="${s.id}">${agentBadge(s.agent)}<b>${esc(s.title ?? s.id.slice(0, 8))}</b>${s.subagents ? ` <span class="badge acc">${s.subagents} sub</span>` : ""}</td><td class="br">${esc(s.branch ?? "")}</td><td class="now" title="${esc(s.last)}">${esc(s.state === "waiting" ? (s.lastText ? s.lastText.split("\\n")[0] : s.last) : s.last)}</td><td class="br" title="${s.models > 1 ? `${s.models} models used this session` : ""}">${esc(model(s.model))}${s.models > 1 ? ` <span class="faint">+${s.models - 1}</span>` : ""}</td><td>${viz.sparkline(s.spark.map((p) => p[0]), viz.agentColor(s.agent))}</td><td class="num">${tok(s.tokens.output)}</td><td class="num" title="cache read + input">${tok(s.tokens.cacheRead + s.tokens.input + s.tokens.cacheWrite)}</td><td class="num">${usd(s.costUsd)}</td><td class="num dim">${ago(s.lastSeenAt)}</td></tr>`)
    .join("")}</tbody></table></div>`;
  const chips = agents.length > 1
    ? `<div class="chips"><span class="chip ${!state.agentFilter ? "on" : ""}" data-agent="">all</span>${agents
        .map((a) => `<span class="chip ${state.agentFilter === a ? "on" : ""}" data-agent="${a}">${esc(agentLabel(a))} <b>${base.filter((s) => s.agent === a).length}</b></span>`)
        .join("")}</div>`
    : "";
  $("#main").innerHTML = chips +
    `<h2>Live <span>${live.length} sessions · ${usd(sumBy(live, (s) => s.costUsd))}</span></h2>` +
    (live.length ? table(live) : `<div class="empty">Nothing running.${state.sessions.length ? "" : "<br><br>Run <kbd>swarm install</kbd> once, then start <kbd>claude</kbd> in any folder — it will appear here."}</div>`) +
    (rest.length ? `<h2 style="margin-top:18px">Earlier <span>${rest.length}</span></h2>${table(rest.slice(0, 30))}` : "") +
    renderWorktrees();
}

function renderWorktrees() {
  const ids = state.sel ? [state.sel] : state.projects.map((p) => p.id);
  const rows = ids.flatMap((id) => (state.worktrees[id] ?? []).map((w) => ({ ...w, projectId: id })));
  if (!rows.length) return "";
  const inside = (w) => state.sessions.filter((s) => s.state !== "ended" && (s.cwd === w.path || s.cwd.startsWith(`${w.path}/`)));
  const badge = (n, label, cls) => (n > 0 ? `<span class="badge ${cls}">${n} ${label}</span>` : "");
  return `<h2 style="margin-top:18px">Worktrees <span>${rows.length}</span></h2>
    <div class="card"><table><thead><tr><th style="width:24px"></th>${state.sel ? "" : '<th style="width:104px">project</th>'}<th style="width:260px">branch</th><th style="width:80px">head</th><th>path</th><th style="width:180px">state</th><th style="width:160px">sessions</th></tr></thead><tbody>${rows
      .map((w) => {
        const ss = inside(w);
        const dot = ss.length ? "active" : w.dirty > 0 ? "waiting" : "ended";
        const clean = w.dirty === 0 && w.ahead <= 0 ? '<span class="badge">clean</span>' : "";
        return `<tr><td><span class="s ${dot}"></span></td>${state.sel ? "" : `<td>${esc(projName(w.projectId))}</td>`}<td class="br">${esc(w.branch ?? "(detached)")}${w.main ? ' <span class="badge">main tree</span>' : ""}</td><td class="br">${esc(w.head)}</td><td class="now" title="${esc(w.path)}">${esc(short(w.path))}</td><td>${badge(w.dirty, "dirty", "warn")}${badge(w.ahead, "unpushed", "acc")}${clean}</td><td>${ss.map((s) => `<a href="#" data-s="${s.id}">${esc(s.title ?? s.id.slice(0, 8))}</a>`).join(", ") || '<span class="dim">—</span>'}</td></tr>`;
      })
      .join("")}</tbody></table></div>`;
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
  const rangeChips = `<span style="margin-left:auto;display:flex;gap:2px">${[7, 14, 30, 90].map((n) => `<a href="#" class="nav ${N === n ? "on" : ""}" data-days="${n}">${n}d</a>`).join("")}</span>`;
  const byAgentToday = state.sel ? null : sp.byAgentToday;
  const kpi = (l, v, d) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
  const tbl = (rows, label, name, color) => `<div class="card"><table><thead><tr><th>${label}</th><th class="num" style="width:88px">cost</th><th class="num" style="width:88px">in+cache</th><th class="num" style="width:84px">out</th><th class="num" style="width:64px">turns</th></tr></thead><tbody>${rows
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))
    .map((r) => `<tr><td>${color ? `<i class="sw" style="background:${color(r.key)}"></i>` : ""}${esc(name(r.key))}</td><td class="num">${usd(r.cost)}</td><td class="num">${tok(r.input)}</td><td class="num">${tok(r.output)}</td><td class="num">${r.turns}</td></tr>`)
    .join("")}</tbody></table></div>`;
  const hm = sp.hourly.filter(inSel).map((c) => ({ dow: c.dow, hour: c.hour, v: c.cost ?? 0 }));
  $("#main").innerHTML =
    `<h2>Spend <span>${state.sel ? esc(projName(state.sel)) : "all projects"}</span>${rangeChips}</h2>
     <div class="kpis">${kpi("today", usd(todayCost), `${todayTurns} turns`)}${kpi(`${N}-day total`, usd(total14), `${activeDays} active day${activeDays === 1 ? "" : "s"}`)}${kpi("today vs avg", prevDays ? `${todayCost >= avg ? "+" : ""}${(((todayCost - avg) / avg) * 100).toFixed(0)}%` : "—", prevDays ? `vs ${usd(avg)} / active day` : "no earlier days to compare")}${kpi("agents", agents.length, agents.map(agentLabel).join(" · ") || "—")}</div>
     <div class="chart-card"><h3>Daily cost · last ${N} days <span>stacked by agent</span></h3>${viz.stackedColumns(days, series)}${agents.length > 1 ? viz.legend(agents) : ""}</div>
     <div class="cols">
       <div class="chart-card" style="margin:0"><h3>When the agents work <span>cost by weekday × hour · last 4 weeks · local time</span></h3>${viz.heatmap(hm)}</div>
       <div>${byAgentToday ? `<h2>By agent · today <span>${usd(sumBy(byAgentToday, (x) => x.cost))}</span></h2>${tbl(byAgentToday, "agent", agentLabel, viz.agentColor)}<h2 style="margin-top:18px">By agent · all time</h2>${tbl(sp.byAgentAll, "agent", agentLabel, viz.agentColor)}` : `<h2>By model · today</h2>${tbl(sp.byModelToday, "model", model)}`}</div>
     </div>
     <div class="cols" style="margin-top:22px"><div><h2>By project · today <span>${usd(sumBy(filt(sp.byProjectToday), (x) => x.cost))}</span></h2>${tbl(filt(sp.byProjectToday), "project", projName)}
     <h2 style="margin-top:18px">By project · all time</h2>${tbl(filt(sp.byProjectAll), "project", projName)}</div>
     <div>${byAgentToday ? `<h2>By model · today</h2>${tbl(sp.byModelToday, "model", model)}` : ""}<h2 style="${byAgentToday ? "margin-top:18px" : ""}">By model · all time</h2>${tbl(sp.byModelAll, "model", model)}</div></div>
     <p class="dim" style="margin-top:14px">Costs use list prices (static table, refreshed from LiteLLM when online; override in <code>~/.swarm/pricing.json</code>). Cache reads are the bulk of "ctx". Sessions on a subscription plan still show what the tokens would cost at API rates.</p>`;
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
     ${rows.length ? viz.timeline(rows, { from, to, projName, now }) : `<div class="empty">No sessions in the last ${hours}h.</div>`}
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
  const tools = Object.entries(s.toolCounts).sort((a, b) => b[1] - a[1]);
  const t = s.tokens;
  const ctx = t.input + t.cacheRead + t.cacheWrite;
  const subTurns = state.turns.filter((x) => x.sidechain || x.agentId);
  const stat = (k, v) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`;
  $("#main").innerHTML = `<h2><a class="back" href="#" id="back">← back</a> ${esc(projName(s.projectId))} · <span class="s ${s.state}"></span> <b>${esc(s.title ?? s.id.slice(0, 8))}</b> <span>${esc(short(s.cwd))}${s.branch ? ` · ${esc(s.branch)}` : ""} · ${s.state}</span></h2>
  <div class="sess"><div id="log">${sessionStream(s)}</div>
  <aside class="side">
    ${stat("cost", usd(s.costUsd))}${stat("model", esc(model(s.model)) || "—")}${stat("turns", s.turns)}${stat("tool calls", s.toolCalls)}
    ${stat("output", `${tok(t.output)}${t.thinking ? `<small> · ${tok(t.thinking)} thinking</small>` : ""}`)}${stat("context", `${tok(ctx)}<small> · ${ctx ? ((100 * t.cacheRead) / ctx).toFixed(0) : 0}% cached</small>`)}
    ${stat("started", `${ago(s.startedAt)} ago`)}${stat("last seen", `${ago(s.lastSeenAt)} ago`)}
    ${subTurns.length ? stat("subagent turns", subTurns.length) : ""}
    <h4>tokens</h4>${viz.compositionBar([{ label: "cache read", v: t.cacheRead }, { label: "cache write", v: t.cacheWrite }, { label: "input", v: t.input }, { label: "thinking", v: t.thinking }, { label: "output", v: t.output }])}
    ${state.turns.length > 1 ? `<h4>cost per turn</h4>${viz.turnStrip(state.turns, { height: 54 })}` : ""}
    <h4>tools</h4>${tools.length ? viz.hbars(tools.slice(0, 8).map(([k, v]) => [k.replace(/^mcp__[a-z0-9-]+__/i, ""), v])) : '<span class="dim">none yet</span>'}
    ${s.transcriptPath ? `<h4>transcript</h4><div class="dim mono" style="word-break:break-all">${esc(short(s.transcriptPath))}</div>` : ""}
  </aside></div>`;
  if (atBottom) $("#log").scrollTop = $("#log").scrollHeight;
}

// ---------- events
document.addEventListener("click", async (ev) => {
  const t = ev.target.closest("[data-rm],[data-pin],[data-id],[data-s],#back,[data-view],.chip,[data-tl],[data-days]");
  if (!t) return;
  if (t.dataset.rm) { ev.stopPropagation(); await fetch(`/v1/projects/${t.dataset.rm}`, { method: "DELETE" }); return refresh(); }
  if (t.dataset.pin) { ev.stopPropagation(); await fetch(`/v1/projects/${t.dataset.pin}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned: true }) }); return refresh(); }
  if (t.dataset.view) { ev.preventDefault(); state.view = t.dataset.view; state.session = null; return render(); }
  if (t.dataset.tl) { ev.preventDefault(); state.tlHours = Number(t.dataset.tl); return render(); }
  if (t.dataset.days) { ev.preventDefault(); state.spendDays = Number(t.dataset.days); return render(); }
  if (t.dataset.agent !== undefined && t.classList.contains("chip")) { state.agentFilter = t.dataset.agent || null; return renderFleet(); }
  if (t.id === "back") { ev.preventDefault(); state.session = null; return render(); }
  if (t.dataset.s) { ev.preventDefault(); return openSession(t.dataset.s); }
  if (t.dataset.id !== undefined) { state.sel = t.dataset.id || null; state.session = null; return render(); }
});
$("#addForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const path = $("#addPath").value.trim();
  if (!path) return;
  const r = await fetch("/v1/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
  if (!r.ok) return alert((await r.json()).error);
  $("#addPath").value = "";
  refresh();
});

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
