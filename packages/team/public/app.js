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
    .join("")}</ul></div>
  ${isAdmin() ? settings(s) : ""}`;
}

// ---------- M13.13 Settings: members and roles, machines, the signed org policy (admins only)
let ME = null;
let POLICY = null;
/** The last Settings message — kept here, because a live refresh re-renders the section. */
let NOTE = null;
const isAdmin = () =>
  ME != null &&
  (ME.kind === "open" ||
    (ME.kind === "human" && ME.role === "admin") ||
    (ME.kind === "machine" && ME.id === "shared-token"));

function settings(s) {
  const roles = ["viewer", "developer", "admin"];
  const pol = POLICY;
  return `
  <h2 id="settings">Settings <span>${ME.kind === "machine" ? "the shared secret administers this team" : "admin"}</span></h2>
  <div class="cols">
    <div><h2>Members <span>${ME.kind === "human" ? "roles decide who may change what" : "one shared secret: no member accounts"}</span></h2><div class="card">${
      s.users.length
        ? plain(
            [{ label: "member" }, { label: "role" }, { label: "last login" }, { label: "" }],
            s.users.map((u) => [
              `<b>${esc(u.name ?? u.email ?? u.subject)}</b> <span class="dim mono">${esc(u.email ?? "")}</span>`,
              `<select data-role="${esc(u.subject)}">${roles
                .map((r) => `<option${r === u.role ? " selected" : ""}>${r}</option>`)
                .join("")}</select>`,
              `<span class="dim">${ago(u.last_login)}</span>`,
              `<button class="link" data-remove="${esc(u.subject)}">remove</button>`,
            ]),
          )
        : '<span class="dim">nobody has logged in — members appear after <span class="mono">swarm login</span> in identity-provider mode</span>'
    }</div></div>
    <div><h2>Machines <span>revoke to stop one forwarding</span></h2><div class="card">${plain(
      [{ label: "machine" }, { label: "owner" }, { label: "last seen" }, { label: "" }],
      s.machines.map((m) => [
        `<b>${esc(m.name ?? m.id.slice(0, 8))}</b>`,
        esc(m.owner_subject ?? "—"),
        ago(m.last_seen),
        `<button class="link bad" data-revoke="${esc(m.id)}">revoke</button>`,
      ]),
    )}</div></div>
  </div>
  <h2>Org policy <span>signed with this team's key; every machine verifies it before applying</span></h2>
  <div class="card">
    <p class="dim">${
      pol
        ? `in force since ${ago(pol.createdAt)}, set by ${esc(pol.setBy ?? "?")} · key <span class="mono">${esc(pol.publicKey.slice(0, 16))}…</span>`
        : "no policy yet — machines use their own rules"
    }</p>
    <textarea id="policy" spellcheck="false" rows="10" placeholder='locked = ["rules.destructive_git"]\n\n[rules]\ndestructive_git = "deny"'>${esc(pol?.toml ?? "")}</textarea>
    <div class="row"><button id="publish">Sign and publish</button><span id="settings-msg" class="${NOTE?.bad ? "badge bad" : "dim"}">${esc(NOTE?.msg ?? "")}</span></div>
  </div>`;
}

async function call(method, path, body) {
  const r = await fetch(`${path}${authq()}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `${r.status}`);
  return j;
}
const say = (msg, bad = false) => {
  NOTE = msg ? { msg, bad } : null;
  const el = $("settings-msg");
  if (el) {
    el.textContent = msg;
    el.className = bad ? "badge bad" : "dim";
  }
};

$("main").addEventListener("change", async (e) => {
  const sub = e.target.dataset?.role;
  if (!sub) return;
  try {
    await call("POST", `/t1/users/${encodeURIComponent(sub)}/role`, { role: e.target.value });
    await refresh();
  } catch (err) {
    await refresh();
    say(err.message, true);
  }
});
$("main").addEventListener("click", async (e) => {
  const t = e.target;
  try {
    if (t.dataset?.remove && confirm(`Remove ${t.dataset.remove} from the team?`)) {
      await call("DELETE", `/t1/users/${encodeURIComponent(t.dataset.remove)}`);
      await refresh();
    } else if (t.dataset?.revoke && confirm("Revoke this machine? It stops forwarding at once.")) {
      const r = await call("DELETE", `/t1/machines/${encodeURIComponent(t.dataset.revoke)}`);
      await refresh();
      if (r.note) say(r.note);
    } else if (t.id === "publish") {
      POLICY = (await call("POST", "/t1/policy", { toml: $("policy").value })).policy;
      await refresh();
      say("signed and published — machines pick it up on their next policy check");
    }
  } catch (err) {
    say(err.message, true);
  }
});

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
  if (ME === null) ME = await call("GET", "/t1/me").catch(() => null);
  if (isAdmin()) POLICY = (await call("GET", "/t1/policy").catch(() => ({}))).policy ?? null;
  // a half-typed policy must survive the refresh a live event triggers
  const draft = $("policy")?.value;
  render(s);
  if (draft !== undefined && $("policy") && draft !== (POLICY?.toml ?? ""))
    $("policy").value = draft;
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
