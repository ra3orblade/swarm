// Swarm team dashboard (M8.3e): one page over GET /t1/state, refreshed on /t1/events SSE pings.
// The token comes from ?token= (persisted to localStorage) — paste the value from
// ~/.swarm/team-token after `swarm login`, or none at all on an open deployment.

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const usd = (n) => (n == null ? "—" : `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`);
const ago = (ts) => {
  if (!ts) return "—";
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 90) return `${Math.max(1, s | 0)}s ago`;
  if (s < 5400) return `${(s / 60) | 0}m ago`;
  if (s < 172800) return `${(s / 3600) | 0}h ago`;
  return `${(s / 86400) | 0}d ago`;
};

const qs = new URLSearchParams(location.search);
if (qs.get("token")) {
  try {
    localStorage.setItem("swarm.team.token", qs.get("token"));
  } catch {}
  history.replaceState(null, "", location.pathname);
}
let TOKEN = null;
try {
  TOKEN = localStorage.getItem("swarm.team.token");
} catch {}
const authq = () => (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "");

function gate(msg) {
  $("main").innerHTML = `<div id="gate">
    <h2 style="margin-top:0">Sign in</h2>
    <p class="dim">${esc(msg)} Paste the token from <span class="mono">~/.swarm/team-token</span> on a machine where you ran <span class="mono">swarm login</span>.</p>
    <input id="tok" type="password" placeholder="swt_…" autocomplete="off">
    <button id="go">Connect</button></div>`;
  $("go").onclick = () => {
    TOKEN = $("tok").value.trim();
    try {
      localStorage.setItem("swarm.team.token", TOKEN);
    } catch {}
    void refresh();
  };
}

function plain(headers, rows) {
  return `<table class="plain"><thead><tr>${headers
    .map((h) => `<th${h.num ? ' class="num"' : ""}>${esc(h.label)}</th>`)
    .join("")}</tr></thead><tbody>${rows
    .map(
      (r) =>
        `<tr>${r.map((c, i) => `<td${headers[i]?.num ? ' class="num"' : ""}>${c}</td>`).join("")}</tr>`,
    )
    .join("")}</tbody></table>`;
}

function render(s) {
  const liveMachines = s.machines.filter(
    (m) => Date.now() - new Date(m.last_seen).getTime() < 120_000,
  );
  const total = s.spend.byProject.reduce((a, p) => a + (p.cost ?? 0), 0);
  $("meta").textContent = `v${s.version} · schema v${s.schema} · auth ${s.auth}`;
  const kpi = (v, l) => `<div class="kpi"><b>${v}</b><span>${esc(l)}</span></div>`;
  const days = [...s.spend.byDay].reverse();
  $("main").innerHTML = `
  <div class="kpis">
    ${kpi(s.machines.length, `machine${s.machines.length === 1 ? "" : "s"} (${liveMachines.length} active)`)}
    ${kpi(s.claims.length, "cluster claims held")}
    ${kpi(usd(s.spend.today), "spend today · all machines")}
    ${kpi(usd(total), "spend all time")}
    ${kpi(s.users.length, `member${s.users.length === 1 ? "" : "s"}`)}
  </div>

  <h2>Machines</h2>
  <div class="card">${plain(
    [
      { label: "machine" },
      { label: "owner" },
      { label: "version" },
      { label: "first seen" },
      { label: "last seen" },
      { label: "" },
    ],
    s.machines.map((m) => [
      `<b>${esc(m.name ?? m.id.slice(0, 8))}</b> <span class="dim mono">${esc(m.id.slice(0, 8))}</span>`,
      esc(m.owner_subject ?? "—"),
      esc(m.version ?? "—"),
      `<span class="dim">${ago(m.first_seen)}</span>`,
      ago(m.last_seen),
      Date.now() - new Date(m.last_seen).getTime() < 120_000
        ? '<span class="badge ok">forwarding</span>'
        : '<span class="badge">quiet</span>',
    ]),
  )}</div>

  <h2>Cluster claims <span>held across every machine — a second claim on the same task is refused at the holder's name</span></h2>
  <div class="card">${
    s.claims.length
      ? plain(
          [
            { label: "project" },
            { label: "task" },
            { label: "held by" },
            { label: "machine" },
            { label: "acquired" },
            { label: "lease ends" },
          ],
          s.claims.map((c) => [
            `<span class="mono">${esc(c.project_key)}</span>`,
            `<b>${esc(c.task)}</b>`,
            esc(c.actor_id ?? "?"),
            esc(c.machine_name ?? c.machine_id),
            ago(c.acquired_at),
            ago(c.expires_at).replace(" ago", ""),
          ]),
        )
      : '<span class="dim">nothing held right now</span>'
  }</div>

  <h2>Spend <span>daily, all machines</span></h2>
  <div class="card">${
    days.length && window.viz
      ? viz.stackedColumns(
          days.map((d) => d.day),
          { team: days.map((d) => d.cost ?? 0) },
          { color: () => "var(--c1)", name: () => "team", sort: () => 0 },
        )
      : '<span class="dim">no spend forwarded yet</span>'
  }</div>

  <div class="cols">
    <div><h2>By project</h2><div class="card">${plain(
      [{ label: "project" }, { label: "cost", num: true }],
      s.spend.byProject.map((p) => [
        `<span class="mono">${esc(p.project_key)}</span>`,
        usd(p.cost),
      ]),
    )}</div></div>
    <div><h2>By user <span>chargeback</span></h2><div class="card">${plain(
      [{ label: "user" }, { label: "cost", num: true }],
      s.spend.byUser.map((u) => [esc(u.subject), usd(u.cost)]),
    )}</div></div>
    <div><h2>By machine</h2><div class="card">${plain(
      [{ label: "machine" }, { label: "owner" }, { label: "cost", num: true }],
      s.spend.byMachine.map((m) => [
        esc(m.name ?? m.machine_id),
        esc(m.owner_subject ?? "—"),
        usd(m.cost),
      ]),
    )}</div></div>
  </div>

  <h2>Recent activity <span>forwarded audit events</span></h2>
  <div class="card"><ul class="feed">${s.events
    .slice(0, 40)
    .map(
      (e) => `<li><span class="t">${esc((e.ts ?? "").slice(5, 16).replace("T", " "))}</span>
        <span class="badge ${e.type === "incident.opened" ? "bad" : e.type.startsWith("claim.") ? "warn" : ""}">${esc(e.type)}</span>
        <span class="mono dim">${esc(e.project_key ?? "")}</span>
        <span>${esc(e.actor_id ?? "")}</span>
        <span class="dim">${esc(summarize(e))}</span></li>`,
    )
    .join("")}</ul></div>`;
}

function summarize(e) {
  const p = e.payload ?? {};
  return p.task ?? p.summary ?? p.reason ?? p.command ?? "";
}

let timer = null;
async function refresh() {
  let res;
  try {
    res = await fetch(`/t1/state${authq()}`);
  } catch {
    $("live").textContent = "offline";
    $("live").className = "badge bad";
    return;
  }
  if (res.status === 401) {
    $("live").textContent = "signed out";
    $("live").className = "badge warn";
    gate("This team daemon requires a token.");
    return;
  }
  const s = await res.json();
  render(s);
  $("live").textContent = "live";
  $("live").className = "badge ok";
}

function connect() {
  const es = new EventSource(`/t1/events${authq()}`);
  es.addEventListener("changed", () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 250); // debounce bursts
  });
  es.onerror = () => {
    $("live").textContent = "reconnecting…";
    $("live").className = "badge warn";
  };
  es.onopen = () => void refresh();
}

void refresh().then(connect);
