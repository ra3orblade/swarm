const $ = (s) => document.querySelector(s);
const state = { projects: [], sessions: [], worktrees: {}, seq: 0, sel: null, session: null, log: [] };

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const ago = (iso) => {
  const d = (Date.now() - new Date(iso)) / 1000;
  return d < 60 ? `${d | 0}s` : d < 3600 ? `${(d / 60) | 0}m` : `${(d / 3600) | 0}h`;
};
const hhmm = (iso) => new Date(iso).toTimeString().slice(0, 8);
const projName = (id) =>
  state.projects.find((p) => p.id === id)?.name ?? (id === "p_unknown" ? "?" : id);

async function refresh() {
  const r = await fetch("/v1/state");
  Object.assign(state, await r.json());
  render();
}

function render() {
  renderProjects();
  if (state.session) renderSession();
  else renderFleet();
}

function renderProjects() {
  const live = (pid) =>
    state.sessions.filter((s) => s.projectId === pid && s.state !== "ended").length;
  const reg = state.projects.filter((p) => !p.discovered);
  const disc = state.projects.filter((p) => p.discovered);
  const row = (
    p,
  ) => `<div class="proj ${state.sel === p.id ? "sel" : ""}" data-id="${p.id}" title="${esc(p.root)}">
      <span class="st ${live(p.id) ? "live" : ""}"></span><span>${esc(p.name)}</span><small>${live(p.id) || ""}</small><span class="x" data-rm="${p.id}" title="remove">×</span></div>`;
  $("#projects").innerHTML =
    `<div class="proj ${state.sel === null ? "sel" : ""}" data-id=""><span class="st ${state.sessions.some((s) => s.state !== "ended") ? "live" : ""}"></span>All<small>${state.sessions.filter((s) => s.state !== "ended").length || ""}</small></div>` +
    reg.map(row).join("") +
    (disc.length ? `<h4>discovered</h4>${disc.map(row).join("")}` : "") +
    (!reg.length && !disc.length
      ? `<div class="empty" style="padding:14px">No projects yet.<br>Add a folder below.</div>`
      : "");
}

function renderWorktrees() {
  const ids = state.sel ? [state.sel] : state.projects.map((p) => p.id);
  const rows = ids.flatMap((id) => (state.worktrees[id] ?? []).map((w) => ({ ...w, projectId: id })));
  if (!rows.length) return "";
  const inside = (w) => state.sessions.filter((s) => s.state !== "ended" && (s.cwd === w.path || s.cwd.startsWith(`${w.path}/`)));
  const badge = (n, label, cls) => (n > 0 ? `<span class="badge ${cls}">${n} ${label}</span>` : "");
  const short = (p) => p.replace(/^\/Users\/[^/]+/, "~");
  return `<h2 style="margin-top:18px">Worktrees <span>${rows.length}</span></h2>
    <table><thead><tr><th style="width:30px"></th>${state.sel ? "" : '<th style="width:140px">project</th>'}<th style="width:260px">branch</th><th style="width:80px">head</th><th>path</th><th style="width:180px">state</th><th style="width:120px">sessions</th></tr></thead><tbody>${rows
      .map((w) => {
        const ss = inside(w);
        const dot = ss.length ? "active" : w.dirty > 0 ? "waiting" : "ended";
        const clean = w.dirty === 0 && w.ahead <= 0 ? '<span class="badge">clean</span>' : "";
        return `<tr><td><span class="s ${dot}"></span></td>${state.sel ? "" : `<td>${esc(projName(w.projectId))}</td>`}<td class="br">${esc(w.branch ?? "(detached)")}${w.main ? ' <span class="badge">main tree</span>' : ""}</td><td class="br">${esc(w.head)}</td><td class="now" title="${esc(w.path)}">${esc(short(w.path))}</td><td>${badge(w.dirty, "dirty", "warn")}${badge(w.ahead, "unpushed", "acc")}${clean}</td><td>${ss.map((s) => `<a href="#" data-s="${s.id}">${s.id.slice(0, 8)}</a>`).join(" ") || '<span style="color:var(--dim)">—</span>'}</td></tr>`;
      })
      .join("")}</tbody></table>`;
}

function renderFleet() {
  const rows = state.sessions.filter((s) => !state.sel || s.projectId === state.sel);
  const liveN = rows.filter((s) => s.state !== "ended").length;
  $("#main").innerHTML =
    `<h2>Fleet <span>${liveN} live · ${rows.length - liveN} ended</span></h2>` +
    (rows.length
      ? `<table><thead><tr><th style="width:30px"></th><th style="width:140px">project</th><th style="width:100px">session</th><th style="width:200px">branch</th><th>now</th><th style="width:60px">age</th><th style="width:60px">tools</th><th style="width:60px">subs</th></tr></thead><tbody>` +
        rows
          .map(
            (s) =>
              `<tr data-s="${s.id}"><td><span class="s ${s.state}"></span></td><td>${esc(projName(s.projectId))}</td><td title="${s.id}">${s.id.slice(0, 8)}</td><td class="br" title="${esc(s.cwd)}">${esc(s.branch ?? "")}</td><td class="now" title="${esc(s.last)}">${esc(s.last)}</td><td>${ago(s.lastSeenAt)}</td><td>${s.toolCalls}</td><td>${s.subagents || ""}</td></tr>`,
          )
          .join("") +
        `</tbody></table>`
      : `<div class="empty">No sessions seen yet.<br><br>Run <kbd>harness install</kbd> once, then start <kbd>claude</kbd> in any folder — it will appear here.</div>`) +
    renderWorktrees();
}

async function openSession(id) {
  state.session = id;
  state.log = await (await fetch(`/v1/sessions/${id}/events`)).json();
  renderSession();
}

function renderSession() {
  const s = state.sessions.find((x) => x.id === state.session);
  if (!s) return;
  const line = (e) =>
    `<div class="ev ${e.type}"><span class="t">${hhmm(e.ts)}</span><span class="k">${esc(e.payload?.hook ?? e.type)}</span><span class="m">${esc(e.payload?.summary ?? JSON.stringify(e.payload))}</span></div>`;
  const atBottom =
    !$("#log") || $("#log").scrollTop + $("#log").clientHeight >= $("#log").scrollHeight - 20;
  $("#main").innerHTML =
    `<h2><a class="back" href="#" id="back">← fleet</a> ${esc(projName(s.projectId))} · <span class="s ${s.state}"></span> ${s.id.slice(0, 8)} <span>${esc(s.cwd)} · ${s.toolCalls} tool calls · ${s.state}</span></h2><div id="log">${state.log.map(line).join("")}</div>`;
  if (atBottom) $("#log").scrollTop = $("#log").scrollHeight;
}

// ---- events
document.addEventListener("click", async (ev) => {
  const t = ev.target.closest("[data-rm],[data-id],[data-s],#back,#navFleet");
  if (!t) return;
  if (t.dataset.rm) {
    ev.stopPropagation();
    await fetch(`/v1/projects/${t.dataset.rm}`, { method: "DELETE" });
    return refresh();
  }
  if (t.id === "back" || t.id === "navFleet") {
    ev.preventDefault();
    state.session = null;
    return render();
  }
  if (t.dataset.s) return openSession(t.dataset.s);
  if (t.dataset.id !== undefined) {
    state.sel = t.dataset.id || null;
    state.session = null;
    return render();
  }
});
$("#addForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const path = $("#addPath").value.trim();
  if (!path) return;
  const r = await fetch("/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!r.ok) return alert((await r.json()).error);
  $("#addPath").value = "";
  refresh();
});

// ---- live
function connect() {
  const es = new EventSource(`/v1/events?since=${state.seq}`);
  es.addEventListener("open", () => $("#daemon .dot").classList.add("on"));
  es.addEventListener("ping", () => $("#daemon .dot").classList.add("on"));
  es.onerror = () => {
    $("#daemon .dot").classList.remove("on");
    es.close();
    setTimeout(connect, 1500);
  };
  let pending = false;
  es.onmessage = null;
  const onAny = (e) => {
    $("#daemon .dot").classList.add("on");
    const ev = JSON.parse(e.data);
    state.seq = Math.max(state.seq, ev.seq);
    if (state.session && ev.sessionId === state.session) {
      state.log.push(ev);
      renderSession();
    }
    if (!pending) {
      pending = true;
      setTimeout(() => {
        pending = false;
        refresh();
      }, 150);
    }
  };
  for (const t of [
    "session.started",
    "session.ended",
    "prompt.submitted",
    "tool.requested",
    "tool.completed",
    "subagent.started",
    "subagent.stopped",
    "agent.text",
    "incident.opened",
    "claim.acquired",
    "claim.released",
  ])
    es.addEventListener(t, onAny);
}
refresh().then(connect);
setInterval(() => {
  if (!state.session) renderFleet();
}, 5000);
