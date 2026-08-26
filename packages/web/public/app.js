const $ = (s) => document.querySelector(s);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
// Open a URL in the user's browser. The desktop app's webview has no new-window handler, so
// `window.open` and target=_blank silently do nothing there — route through Tauri's shell opener
// when it is present (capability `shell:allow-open`), and fall back to window.open in a browser.
const openExternal = (url) => {
  const shell = window.__TAURI__?.shell;
  if (shell?.open) shell.open(url).catch(() => window.open(url, "_blank"));
  else window.open(url, "_blank");
};
// Every absolute link (PR titles, docs, search hits, dev-server ports) takes the same path.
document.addEventListener("click", (e) => {
  const a = e.target.closest?.('a[href^="http"]');
  if (!a) return;
  e.preventDefault();
  openExternal(a.href);
});
// M8.2b daemon token: `swarm ui` (and the desktop app) open the dashboard with ?token=…; it is kept
// in sessionStorage, stripped from the URL, and sent on every /v1 request. Loopback without a token
// still works while `[daemon] auth = "loopback-optional"`.
const TOKEN = (() => {
  const q = new URLSearchParams(location.search);
  const t = q.get("token");
  if (t) { try { sessionStorage.setItem("swarm.token", t); } catch {} q.delete("token"); history.replaceState(null, "", `${location.pathname}${q.size ? `?${q}` : ""}${location.hash}`); return t; }
  try { return sessionStorage.getItem("swarm.token"); } catch { return null; }
})();
if (TOKEN) {
  const rawFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("/v1/")) return rawFetch(input, init);
    const headers = new Headers(init.headers || {});
    headers.set("authorization", `Bearer ${TOKEN}`);
    return rawFetch(input, { ...init, headers });
  };
}
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
const state = { projects: [], sessions: [], worktrees: {}, processes: [], spend: null, incidents: [], allIncidents: null, incFilter: "open", tasks: null, gates: null, dispatch: null, questions: [], budget: null, runs: [], attribution: null, taskFilter: "ready", resources: [], prs: [], seq: 0, sel: null, session: null, log: [], turns: [], view: "fleet", agentFilter: null, collisions: null, outcomes: null, dirty: true };

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ago = (iso) => { const d = (Date.now() - new Date(iso)) / 1000; return d < 60 ? `${d | 0}s` : d < 3600 ? `${(d / 60) | 0}m` : d < 86400 ? `${(d / 3600) | 0}h` : `${(d / 86400) | 0}d`; };
// p2 (zero-pad) is defined in viz.js, which loads first
const hhmm = (iso) => { const d = new Date(iso); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
/** The project's glyph: its emoji icon, or the folder icon, tinted with its color slot. */
const projGlyph = (p, size = 14) => p?.icon
  ? `<span class="pg ${p.color ? `pg-${p.color}` : ""}">${p.icon.startsWith("data:image/") ? `<img class="pg-img" src="${esc(p.icon)}" alt="">` : esc(p.icon)}</span>`
  : `<span class="pg ${p?.color ? `pg-${p.color}` : ""}">${ic("folder-simple", size)}</span>`;
/** Project cell for tables: glyph + name. */
const projCell = (id) => { const p = state.projects.find((x) => x.id === id); return p ? `${projGlyph(p, 12)} ${esc(p.name)}` : esc(projName(id)); };
const projName = (id) => state.projects.find((p) => p.id === id)?.name ?? (id === "p_unknown" ? "?" : "(removed)");
const short = (p) => String(p ?? "").replace(/^\/Users\/[^/]+/, "~");
// Never wider than 5 characters, so a numeric column never has to ellipsize a number: without a
// billions step a 2.8B context read "2820.0M", and the tenth is noise once the mantissa is 3 digits.
// At most 3 significant digits, so a numeric column never has to ellipsize a number: without a
// billions step a 2.8B context read "2820.0M", and the tenth is noise once the mantissa is 3 digits.
const unit = (n, div, suffix) => `${(n / div).toFixed((n /= div) >= 100 ? 0 : n >= 10 ? 1 : 2)}${suffix}`;
const tok = (n) => (n >= 1e9 ? unit(n, 1e9, "B") : n >= 1e6 ? unit(n, 1e6, "M") : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n | 0));
const usd = (n) => (n == null ? '<span class="dim">—</span>' : `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`);
const model = (m) => (m ? m.replace(/^claude-/, "").replace(/-\d{8}$/, "") : "");
const sumBy = (arr, f) => arr.reduce((a, x) => a + (f(x) ?? 0), 0);
const leaseLeft = (iso) => { const d = (new Date(iso) - Date.now()) / 1000; if (d <= 0) return "expired"; return d < 3600 ? `${(d / 60) | 0}m left` : `${(d / 3600).toFixed(1)}h left`; };
const ic = (name, size = 14, cls = "") => (window.icon ? window.icon(name, size, cls) : "");
const kindIcon = (s) => ic(s.kind === "subagent" ? "tree-structure" : s.kind === "spawned" ? "play" : "keyboard", 13, "kind");
// pixel-art illustrations for empty states (crispEdges, theme-green; won't clash with icon packs)
function pixmap(rows, cell = 6) {
  // Every tone is derived from the accent, so they are guaranteed to separate in either theme.
  // An earlier palette used --c4 for the shade, whose luminance in light mode (0.158) is
  // indistinguishable from --acc's (0.160) — the outline simply vanished into the face.
  // Keep in step with ART_THEME in core/src/art.ts; art.test.ts asserts they match.
  const C = {
    O: "color-mix(in srgb, var(--acc) 40%, black)",
    K: "color-mix(in srgb, var(--acc) 51%, black)",
    D: "color-mix(in srgb, var(--acc) 58%, black)",
    S: "color-mix(in srgb, var(--acc) 71%, black)",
    E: "color-mix(in srgb, var(--acc) 84%, black)",
    M: "var(--acc)",
    L: "color-mix(in srgb, var(--acc) 52%, white)",
  };
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
  // Inline copy of ROBOT in core/src/art.ts — app.js is a plain script and cannot import from
  // core, so art.test.ts asserts the two are byte-identical rather than trusting anyone to
  // remember. Edit the drawing there and re-run `bun tools/icons.ts`, never edit it here.
  idle: () =>
    pixmap(
      [
        "                        MM                     MM                        ",
        "                        LL                     LL                        ",
        "                        LL                     LL                        ",
        "                        LM                     MM                        ",
        "                        MD                     MS                        ",
        "                        LE                     LE                        ",
        "                        ME                     ME                        ",
        "                        MS                     MS                        ",
        "                        KK                     KK                        ",
        "                   SSDDDSDDDDDDDDDDDDDDDDDDDDDDDDDDDDS                   ",
        "                   SSDSDDDDDDDDDDDDDDDDDDDDDDDDDDDDDSS                   ",
        "                   SSDOOOOOOOOOOOOOOOOOOOOOOOOOOOOOKSS                   ",
        "                   SSOMMMMMMMMMMMMMMMMMMMMMMMMMMMMMOSS                   ",
        "                   DDKMMLLLMLLMMMMMMMMMMMMMMMMMMMMMODD                   ",
        "                   DDOMMLMMMMMMMMMMMMMMMMMMMMMMMMMMODD                   ",
        "              SSSSODDOMMLMMMMMMMMMMMMMMMMMMMMMMMMMMODDOSSSS              ",
        "              SSSSODDOMMMMMMMMMMMMMMMMMMMMMMMMMMMMMODDOSSSS              ",
        "             SMMMMODDOMMLMMMMMMMMMMMMMMMMMMMMMMMMMMODDOSMMMS             ",
        "             DMSSSODDOMMMMOOOOOOMMMMMMMMMOOOOOOMMMMODDOSSSED             ",
        "             DSSSSODDOMMMMODDDDDMMMMMMMMMODDDDDMMMMODDOSSSSK             ",
        "             DSMMSODDOMMMMDDDDDDMMMMMMMMMKDDDDDMMMMODDOSMMSK             ",
        "             DSSSSODDOMMMMDDDDDDMMMMMMMMMDDDDDDMMMMODDOSSSSK             ",
        "             DSSSSODDOMMMMDDDDDDMMMMMMMMMDDDDDDMMMMODDODSSSK             ",
        "             DSSSSODDOMMMMDDDDDDMMMMMMMMMDDDDDDMMMMODDODSSSK             ",
        "             DSSSKODDOMMMMDDDDDDMMMMMMMMMDDDDDDMMMMODDODSSSD             ",
        "             OKKKKODDOMMMMMMMMMMMMMMMMMMMMMMMMMMMMMODDOKKKKO             ",
        "              KKKKODDOMMMMMMMMMMMMMMMMMMMMMMMMMMMMMODDOOKKK              ",
        "              KKKOODDOMMMMMMMMMMMMMMMMMMMMMMMMMMMMMODDOOKKK              ",
        "                   DDOMMMMDDDDDDDDDDDDDDDDDDDDDMMMMODD                   ",
        "                   DDOMMMMDDDDDDDDDDDDDDDDDDDDDMMMMODD                   ",
        "                   DDOMMMMDDDDDDDDDDDDDDDDDDDDDMMMMODD                   ",
        "                   DDOMMMMMMMMMMMMMMMMMMMMMMMMMMMMMODD                   ",
        "                   DDOMMMMMMMMMMMMMMMMMMMMMMMMMMMMMODD                   ",
        "                   DDOMMMMMMMMMMMMMMMMMMMMMMMMMMMMMODD                   ",
        "                   DDDOOOOOOOOOOOOOOOOOOOOOOOOOOOOOKDD                   ",
        "                   DDDDDDDDDDDDDDDDDDDDDDDDDDDDDKDDDDD                   ",
        "                   DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD                   ",
        "                               OOOOOOOOOOO                               ",
        "                               OODDDDDKKOO                               ",
        "                               DSMMMMMMSDD                               ",
        "                               OOOOOOOOOOO                               ",
        "                              KDSMMMMMESSKK                              ",
        "                   MMMMMMSSKOOKDSMMMMMSSSDKOODSEMMMMMM                   ",
        "         SSSSDO   MMMMMMSSKKOOOOOOOOOOOOOOOOOKSSSMMMMMM   ODSSSS         ",
        "        EEESSSSOOLLLLMMMMMESSSSSSSSSSSSSSSSSSSSMMMMMLLLLOOSSSSMME        ",
        "       SMMSSSSKOEELLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLEEOOSSSSEMS       ",
        "      DSSSSSSSOOSEEKSMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMSOEEDOOSSSSSSSK      ",
        "      DSSSSSSDOOSEOSKEMMMMMMMMMMMMMMMMMMMMMMMMMMMMMEOSDEDOODSSSSSSK      ",
        "      KSSSSSSKOODSSOSEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEESOEEDOOKSSSSSSK      ",
        "      DKSSSSKKOODSMEEMLLLLLLLLLLLLLLLLLLLLLLLLLLLLLMSEMSDOOKKSSSSDK      ",
        "      OKDDKDKKOOKSMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMSKOOKKKKKKKO      ",
        "      OOOOOKKKOOKSMMMMESSSSSSSSSSSSSMMMMEEEEEESSSSEMMMMSKOOKKKOOOOO      ",
        "      OOOOOOKKOOKSMMMSSKKKKKKKKKKKKKKMMMDKOOOOOOOODDMMMSKOOKKOOOOOO      ",
        "      OKSSKOOOOOKSMMMKKMLLLLLLLLLLLMKMMMDDSSSSSSSSDDMMMSKOOOOODSSKO      ",
        "      SDOKKK    KSMMMKDLLLLLLLLLLLLLKMMMKDKKKDDKKKDKMMMSK    KKKKDS      ",
        "     DMLLMKO    KSMMMKDLLLLLLLLLLLLLKMMMDDDDDDDDDSKDMMMSK    ODMLLMD     ",
        "     DELLMSD    KSMMMKKMLLLLLLLLLLLLKMMMDKKKKKKKKKDDMMMSK    DSMLLEO     ",
        "    KSKKKKDO    KSMMMEDDDDKKDDDKKKDKSMMMDDDDDDDDDSDDMMMSK    ODDKKKSK    ",
        "    EMLLMDO     KSMMMMLLLLLLLLLLLLLLLMMMDOOOOOOOOODDMMMSK     ODMLLME    ",
        "    KMLLMSD     KSMMMMMMMMMMMMMMMMMMMMMMDDSSDDSSSSDDMMMSK     SSMLLEK    ",
        "   KSKKKKSO     KSMMMMMOOMMOOMKOEMOOMMMMDOOOOOOOOODDMMMSK     OSKKKKSO   ",
        "   SMLLMDO      KSMMMMMKKMMKKMDKEMKKMMMMKDDDDSSSSDDDMMMSK      ODMLLMS   ",
        "   SMMMMSD      KSMMMMMEEMMEEMEEMMEEMMMMDSOOOOOOOODDMMSSK      DSMMMMD   ",
        "   OOOOOOO      KSSMMMMMMMMMMMMMMMMMMMMMDDDDDDDDDDDDMSSSK      OOOOOOO   ",
        " KSMLLLMMSKO    KSSSSMMMMMMMMMMMMMMMMMMMSOOOOOOOOOOSSSSSK    OKSMLLLLMSO ",
        " DSMMMEEESKK    KSSKSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSOSSK    KDSMMMMMESD ",
        " DSMMMMMESKK    KSOOKSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSOOKSK    KKSMMMMMMSD ",
        " DSMMMMMESKK    OKSKSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSDSKO    KDSMMMMMMSD ",
        " KDDDDDDDDKK      KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK      KKDDDDDDDDO ",
        " OOOOOOOOOOO         OOOOOOOOO             OOOOOOOOO         OOOOOOOOOOO ",
        "DSDO     OSSO        ODKKKKKKK             OKKKKKKKO        KEDO     ODEK",
        "SMDO     OSMD        KDSSSSSSK             KDSSSSSKO        SMDO     ODMS",
        "DEKO     OOED         OOKKKOOO             OOOKKOOO         SSOO     OKMS",
        "DEKO     OOED         SEMMMMSK             OSMMMMED         SSKO     OKES",
        "DSSO     OESK         SEMMMMSK             OSMMMMED         KSSO     OSSK",
        "KSMS     EEDO         OOKKKKKO             OOKKKKKO         OSEE     EMSO",
        " DSS     SSK          OSEEESDO             ODSEEESO          KSS     SSD ",
        " OOO     OO           SEMMMMSK             OSMMMMED           OO     OOO ",
        "                      KSSSSSDO             OKSSESSK                      ",
        "                   DKKDDDDDDKKDK         KDKDDDDDDDKDK                   ",
        "                  SSMLLMMMMMMLMSK       DSSMMMMMMMLLMSS                  ",
        "                  SMLMMMMMMMMLLED       SEMMMMMMMMMMLMS                  ",
        "                 DMMMMMMMMMMMMMMD       SMMMMMMMMMMMMMSK                 ",
        "                ODSSSSSSSSSSSSSSDO     ODSSSSSSSSSSSSSSKO                ",
        "                OOOOOOOOOOOOOOOOO       OOOOOOOOOOOOOOOOO                ",
        "                OKSSSSSSSSSSSSSSK       KSSSSSSSSSSSSSSKO                ",
        "                OKDDDDDDDDDDDDDDK       KDDDDDDDDDDDDDDOO                ",
      ],
      // 1px a cell: the drawing is 73 cells wide now, and at the old 4 it would be a 292px
      // illustration in a box that used to hold 92.
      1,
    ),
  folder: () => pixmap([
    " MMMM     ",
    "MMMMMMMMMM",
    "MLLLLLLLLM",
    "MLLLLLLLLM",
    "MLLLLLLLLM",
    "MLLLLLLLLM",
    "MMMMMMMMMM",
  ]),
  clock: () => pixmap([
    "  MMMMM  ",
    " M     M ",
    "M   M   M",
    "M   M   M",
    "M   MMM M",
    "M       M",
    "M       M",
    " M     M ",
    "  MMMMM  ",
  ]),
};
// static <i data-icon> placeholders in index.html → inline SVG
for (const el of document.querySelectorAll("i[data-icon]")) el.outerHTML = ic(el.dataset.icon, 15);
// theme: "system" | "light" | "dark", persisted; CSS handles system via prefers-color-scheme
const getTheme = () => localStorage.getItem("swarm.theme") ?? "system";
const setTheme = (t) => { localStorage.setItem("swarm.theme", t); if (t === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t; };
setTheme(getTheme());
const copy = (text) => navigator.clipboard?.writeText(String(text ?? ""));
const tail = (p, n = 16) => { const t = short(p); return t.length > n ? `…${t.slice(-(n - 1))}` : t; };
const agentLabel = (a) => viz.agentName(a);
const agentBadge = (a) => (a ? `<span class="badge agent" style="color:${viz.agentColor(a)};background:color-mix(in srgb,${viz.agentColor(a)} 14%,transparent)">${esc(agentLabel(a))}</span>` : "");

// One render per animation frame, whatever triggered it (SSE, polls, clicks).
let raf = 0;
const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };
const touch = () => { state.dirty = true; schedule(); };
// `render()` refuses to paint while a menu is open (it would detach the anchor the menu is
// positioned against) and defers the frame instead. fancy-menus exposes no close callback, so the
// deferred paint has to wait for the close — armed from that bail, where the menu is known to be
// open. Without it a menu action (switch view, ack, release…) only lands on the next 5s poll,
// which reads as a dead click. One boolean check per frame, only while a menu is open.
// The menus island re-broadcasts the package's `useIsAnyMenuOpen` as `menus:openchange`.
window.addEventListener("menus:openchange", (e) => {
  if (e.detail?.open) return;
  // Menu closed: drop the trigger's open state and paint whatever render() deferred.
  for (const b of $$("#viewnav .navgrp.open")) b.classList.remove("open");
  for (const el of $$(".menu-open")) el.classList.remove("menu-open");
  if (state.dirty) schedule();
});
// Last snapshot body + last render time: an unchanged snapshot (same seq, same data) skips the render
// unless the UI changed, or `ago`-style cells are older than 30s.
let lastSnap = "", lastRenderAt = 0;
async function refresh() {
  const txt = await (await fetch("/v1/state")).text();
  const same = txt === lastSnap;
  if (!same) { lastSnap = txt; Object.assign(state, JSON.parse(txt)); }
  if (!state.version) fetch("/v1/health").then((r) => r.json()).then((h) => { state.version = h.version; state.hooksInstalled = h.hooksInstalled !== false; maybeUpdateNudge(h); maybeWhatsNew(); }).catch(() => {});
  let prsChanged = false;
  if (state.view === "prs" && !state.session) {
    const prs = await (await fetch("/v1/prs")).json().catch(() => state.prs ?? []);
    prsChanged = JSON.stringify(prs) !== JSON.stringify(state.prs);
    state.prs = prs;
  }
  let attrChanged = false;
  if (state.view === "spend" && state.sel && !state.session) {
    const [a, bd] = await Promise.all([
      fetch(`/v1/attribution?project=${encodeURIComponent(state.sel)}`).then((r) => r.json()).catch(() => state.attribution),
      fetch(`/v1/budget?project=${encodeURIComponent(state.sel)}`).then((r) => r.json()).catch(() => state.budget),
    ]);
    attrChanged = JSON.stringify(a) !== JSON.stringify(state.attribution) || JSON.stringify(bd) !== JSON.stringify(state.budget);
    state.attribution = a; state.budget = bd;
  } else if (state.view === "spend" && !state.sel) {
    if (state.attribution) attrChanged = true;
    state.attribution = null;
  }
  let runsChanged = false;
  if (state.session) {
    const ms = await fetch(`/v1/messages?session=${encodeURIComponent(state.session)}&limit=50`).then((r) => r.json()).catch(() => state.msgs ?? []);
    if (JSON.stringify(ms) !== JSON.stringify(state.msgs)) { state.msgs = ms; state.dirty = true; }
  }
  const openSpawned = state.session && state.sessions.find((x) => x.id === state.session)?.kind === "spawned";
  if (openSpawned || (state.view === "board" && !state.session) || (state.view === "fleet" && !state.session)) {
    const runs = await fetch("/v1/runs").then((r) => r.json()).catch(() => state.runs ?? []);
    runsChanged = JSON.stringify(runs) !== JSON.stringify(state.runs);
    state.runs = runs;
  }
  let tasksChanged = false;
  if (state.view === "board" && state.sel && !state.session) {
    const [t, g, d, wf] = await Promise.all([
      fetch(`/v1/tasks?project=${encodeURIComponent(state.sel)}`).then((r) => r.json()).catch(() => state.tasks),
      fetch(`/v1/gates?project=${encodeURIComponent(state.sel)}`).then((r) => r.json()).catch(() => state.gates),
      fetch(`/v1/dispatch?project=${encodeURIComponent(state.sel)}`).then((r) => r.json()).catch(() => state.dispatch),
      fetch(`/v1/workflows?project=${encodeURIComponent(state.sel)}`).then((r) => r.json()).catch(() => state.workflows),
    ]);
    tasksChanged = JSON.stringify(t) !== JSON.stringify(state.tasks) || JSON.stringify(g) !== JSON.stringify(state.gates) || JSON.stringify(d) !== JSON.stringify(state.dispatch) || JSON.stringify(wf) !== JSON.stringify(state.workflows);
    state.tasks = t; state.gates = g; state.dispatch = d; state.workflows = wf;
  }
  let incChanged = false;
  if (state.view === "incidents" && !state.session) {
    const q = new URLSearchParams({ limit: "500" }); if (state.incFilter === "open") q.set("open", "1");
    const inc = await (await fetch(`/v1/incidents?${q}`)).json().catch(() => state.allIncidents ?? []);
    incChanged = JSON.stringify(inc) !== JSON.stringify(state.allIncidents);
    state.allIncidents = inc;
  }
  let linChanged = false;
  if (state.view === "graphs" && (state.graphTab ?? "collisions") === "lineage" && !state.session) {
    const q = state.sel ? `?project=${encodeURIComponent(state.sel)}` : "";
    const open = (state.lineageOpen ?? []).map((g) => `&expand=${encodeURIComponent(g)}`).join("");
    const lin = await fetch(`/v1/graphs/lineage${q || "?"}${open}`).then((r) => r.json()).catch(() => state.lineage);
    linChanged = JSON.stringify(lin) !== JSON.stringify(state.lineage);
    state.lineage = lin;
  }
  let colChanged = false;
  if (state.view === "graphs" && (state.graphTab ?? "collisions") !== "lineage" && !state.session) {
    const q = state.sel ? `?project=${encodeURIComponent(state.sel)}` : "";
    const col = await fetch(`/v1/graphs/collisions${q}`).then((r) => r.json()).catch(() => state.collisions);
    colChanged = JSON.stringify(col) !== JSON.stringify(state.collisions);
    state.collisions = col;
  }
  let waitChanged = false;
  if ((state.view === "fleet" || state.view === "stats") && !state.session) {
    const q = state.sel ? `?project=${encodeURIComponent(state.sel)}` : "";
    const w = await fetch(`/v1/waiting${q}`).then((r) => r.json()).catch(() => state.waiting);
    waitChanged = JSON.stringify(w) !== JSON.stringify(state.waiting);
    state.waiting = w;
  }
  let hygChanged = false;
  if (state.view === "hygiene" && !state.session) {
    const q = state.sel ? `?project=${encodeURIComponent(state.sel)}` : "";
    const hy = await fetch(`/v1/hygiene${q}`).then((r) => r.json()).catch(() => state.hygiene);
    hygChanged = JSON.stringify(hy) !== JSON.stringify(state.hygiene);
    state.hygiene = hy;
  }
  let ctxChanged = false;
  if (state.view === "context" && !state.session) {
    const q = state.sel ? `?project=${encodeURIComponent(state.sel)}` : "";
    const cx = await fetch(`/v1/context${q}`).then((r) => r.json()).catch(() => state.context);
    ctxChanged = JSON.stringify(cx) !== JSON.stringify(state.context);
    state.context = cx;
  }
  let trialsChanged = false;
  if (state.view === "trials" && !state.session) {
    const q = state.sel ? `?project=${encodeURIComponent(state.sel)}` : "";
    const tr = await fetch(`/v1/ab${q}`).then((r) => r.json()).then((r) => r.trials ?? []).catch(() => state.trials);
    trialsChanged = JSON.stringify(tr) !== JSON.stringify(state.trials);
    state.trials = tr;
  }
  let provChanged = false;
  if (state.view === "provenance" && !state.session) {
    const q = state.sel ? `?project=${encodeURIComponent(state.sel)}` : "";
    const off = state.provOffset ?? 0;
    const pv = await fetch(`/v1/provenance${q ? `${q}&` : "?"}limit=50&offset=${off}`).then((r) => r.json()).catch(() => state.provenance);
    provChanged = JSON.stringify(pv) !== JSON.stringify(state.provenance);
    state.provenance = pv;
  }
  let mcpChanged = false;
  if (state.view === "mcp" && !state.session) {
    const q = state.sel ? `?project=${encodeURIComponent(state.sel)}` : "";
    const m = await fetch(`/v1/mcp/health${q}`).then((r) => r.json()).catch(() => state.mcpHealth);
    mcpChanged = JSON.stringify(m) !== JSON.stringify(state.mcpHealth);
    state.mcpHealth = m;
  }
  let ghChanged = false;
  if (state.view === "gates" && !state.session) {
    const q = state.sel ? `?project=${encodeURIComponent(state.sel)}` : "";
    const gh = await fetch(`/v1/gates/health${q}`).then((r) => r.json()).catch(() => state.gateHealth);
    ghChanged = JSON.stringify(gh) !== JSON.stringify(state.gateHealth);
    state.gateHealth = gh;
  }
  let outChanged = false;
  if (state.view === "outcomes" && !state.session) {
    const q = state.sel ? `?project=${encodeURIComponent(state.sel)}` : "";
    const o = await fetch(`/v1/outcomes${q}`).then((r) => r.json()).catch(() => state.outcomes);
    outChanged = JSON.stringify(o) !== JSON.stringify(state.outcomes);
    state.outcomes = o;
  }
  if (!same || prsChanged || incChanged || tasksChanged || runsChanged || attrChanged || colChanged || linChanged || outChanged || waitChanged || ghChanged || mcpChanged || ctxChanged || provChanged || trialsChanged || hygChanged || state.dirty || Date.now() - lastRenderAt > 30_000) schedule();
}
// M9.1: the view registry — the one source of truth that the sidebar nav, render dispatch,
// deep links and the ⌘K palette all derive from. Adding a view = one entry here + its render fn.
const VIEW_DEFS = [
  { id: "fleet", label: "Fleet", icon: "squares-four", group: "Observe", render: () => renderFleet() },
  { id: "timeline", label: "Timeline", icon: "clock-counter-clockwise", group: "Observe", render: () => renderTimeline() },
  { id: "graphs", label: "Graphs", icon: "tree-structure", group: "Observe", render: () => renderGraphs(), badge: () => state.collisions?.contested ?? 0 },
  { id: "board", label: "Board", icon: "stack", group: "Work", render: () => renderBoard() },
  { id: "prs", label: "PRs", icon: "git-pull-request", group: "Work", render: () => renderPRs() },
  { id: "trials", label: "Trials", icon: "robot", group: "Work", render: () => renderTrials(), badge: () => (state.trials ?? []).filter((t) => t.verdict === "undecided").length },
  { id: "hygiene", label: "Hygiene", icon: "trash", group: "Work", render: () => renderHygiene(), badge: () => state.hygiene?.totals?.issues ?? 0 },
  // not "check": inside a menu a tick reads as "this item is selected" rather than as an icon
  { id: "outcomes", label: "Outcomes", icon: "git-branch", group: "Insight", render: () => renderOutcomes() },
  { id: "gates", label: "Gates", icon: "shield", group: "Insight", render: () => renderGateHealth(), badge: () => state.gateHealth?.totals?.flakyGates ?? 0 },
  { id: "mcp", label: "MCP", icon: "plugs-connected", group: "Insight", render: () => renderMcpHealth() },
  { id: "context", label: "Context", icon: "brain", group: "Insight", render: () => renderContext() },
  { id: "spend", label: "Spend", icon: "coins", group: "Insight", render: () => renderSpend() },
  { id: "stats", label: "Stats", icon: "chart-bar", group: "Insight", render: () => { loadStats(); renderStats(); } }, // loadStats is a no-op while the cache is fresh
  { id: "search", label: "Search", icon: "magnifying-glass", group: "Insight", render: () => renderSearch() },
  { id: "provenance", label: "Provenance", icon: "git-commit", group: "Guard", render: () => renderProvenance(), badge: () => state.provenance?.totals?.untracked ?? 0 },
  { id: "incidents", label: "Incidents", icon: "warning", group: "Guard", render: () => renderIncidentsView(), badge: () => state.openIncidents ?? 0 },
];
const viewDef = (id) => VIEW_DEFS.find((v) => v.id === id);
const VIEWS = VIEW_DEFS.map((v) => v.id);
let navHtml = ""; // last-rendered nav html; declared before the restore block below calls renderNav()
// restore last view + project selection (persisted UI state)
{
  const v = localStorage.getItem("swarm.view");
  if (VIEWS.includes(v)) state.view = v;
  const gt = localStorage.getItem("swarm.graphTab");
  if (gt === "lineage" || gt === "collisions") state.graphTab = gt;
  const sel = localStorage.getItem("swarm.sel");
  if (sel) state.sel = sel;
  // Deep links win over persisted state: ?view=board&project=<id>&session=<id>
  const q = new URLSearchParams(location.search);
  if (VIEWS.includes(q.get("view"))) state.view = q.get("view");
  if (q.has("project")) state.sel = q.get("project") || null;
  // Mark the restored tab before the first snapshot lands, so the nav doesn't flash "Fleet".
  renderNav();
}
function render() {
  // A row menu is anchored to DOM that a re-render would replace (and the focus jump closes it):
  // hold the frame while one is open; the next poll or interaction paints it.
  if (window.menus?.isOpen()) { state.dirty = true; return; } // the menus:openchange listener paints on close
  // Live refresh re-renders the whole view; keep focus + caret in a grid filter input alive.
  const af = document.activeElement;
  const keep = af?.dataset?.filter ? { key: af.dataset.filter, tid: af.dataset.tid, pos: af.selectionStart } : null;
  state.dirty = false;
  lastRenderAt = Date.now();
  if (!dragPid) renderProjects(); // a re-render mid-drag would yank the row out from under the cursor
  renderHeader();
  if (state.session) renderSession();
  else (viewDef(state.view)?.render ?? viewDef("fleet").render)();
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
  renderNav();
}
// View nav in the header: one button per group (Observe / Work / Insight / Guard); clicking one
// opens a fancy-menus dropdown of that group's views. Rebuilt only when the html changes (active
// view, badges) so the 5s poll doesn't churn the DOM — and never while its menu is open.
function showView(id) {
  state.view = id;
  localStorage.setItem("swarm.view", id);
  state.session = null;
  state.dirty = true;
  refresh();
}
function viewGroups() {
  const groups = [];
  for (const v of VIEW_DEFS) {
    const g = groups.find((x) => x.name === v.group) ?? groups[groups.push({ name: v.group, views: [] }) - 1];
    g.views.push(v);
  }
  return groups;
}
function renderNav() {
  const html = viewGroups()
    .map((g) => {
      const n = g.views.reduce((a, v) => a + (v.badge?.() ?? 0), 0);
      const on = !state.session && g.views.some((v) => v.id === state.view);
      // The group name alone never says which of its views you are on, so ten destinations hid
      // behind four words. The active group carries the view's own label.
      const cur = on ? g.views.find((v) => v.id === state.view) : null;
      return `<button class="navgrp ${on ? "on" : ""}" data-grp="${g.name}"${on ? ' aria-current="page"' : ""} aria-haspopup="menu">${g.name}${cur ? `<span class="navview">${esc(cur.label)}</span>` : ""}${n ? `<b class="navcount">${n > 99 ? "99+" : n}</b>` : ""}${ic("chevron-down", 12, "chev")}</button>`;
    })
    .join("");
  if (html !== navHtml) { navHtml = html; $("#viewnav").innerHTML = html; }
}
// Delegated: the group buttons are re-rendered, so the listener lives on the container.
$("#viewnav").addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-grp]");
  if (!btn) return;
  const g = viewGroups().find((x) => x.name === btn.dataset.grp);
  if (!g || !window.menus) return;
  btn.classList.add("open"); // cleared by menus:openchange when the menu closes
  window.menus.open(btn, {
    items: g.views.map((v) => {
      const n = v.badge?.() ?? 0;
      return {
        label: v.label,
        icon: v.icon,
        caption: n ? String(n) : undefined,
        pressed: !state.session && state.view === v.id,
        run: () => showView(v.id),
      };
    }),
  });
});

const isLive = (s) => s.state === "active" || s.state === "waiting";
// One pass over sessions → live count per project (+ "" for all), instead of a filter per sidebar row.
function liveCounts() {
  const m = new Map();
  for (const s of state.sessions) if (isLive(s)) { m.set(s.projectId, (m.get(s.projectId) ?? 0) + 1); m.set("", (m.get("") ?? 0) + 1); }
  return m;
}
// M5.7: 14-day spend sparkline per pinned project; hidden when the fortnight cost is ~zero.
function spendSpark(pid) {
  const pts = state.spendSparks?.[pid];
  if (!pts || pts.reduce((a, b) => a + b, 0) < 0.5) return "";
  return `<span class="proj-spark" title="last 14 days · $${pts.reduce((a, b) => a + b, 0).toFixed(0)}">${viz.sparkline(pts, "var(--c1)")}</span>`;
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
      <span class="st ${live(p.id) ? "live" : ""}"></span>${projGlyph(p)}<span class="nm">${disamb(p)}${esc(p.name)}</span>${spendSpark(p.id)}<small>${live(p.id) || ""}</small>${act}</div>`;
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

// First run: no sessions have ever been seen. Say exactly what to do next, and whether hooks are in.
function onboarding() {
  const hooksOk = state.hooksInstalled !== false;
  const step = (n, done, html) => `<div class="ob-step ${done ? "done" : ""}"><span class="ob-n">${done ? "✓" : n}</span><div>${html}</div></div>`;
  return `<div class="onboard">${PX.idle()}
    <h3>Swarm is running and watching this machine.</h3>
    <div class="ob-steps">
      ${step(1, hooksOk, `<b>Hook into Claude Code</b> — <code>swarm install</code> once${hooksOk ? "" : " <span class='badge warn'>not installed</span>"}. Codex and Grok are picked up automatically, nothing to configure.`)}
      ${step(2, false, `<b>Open any agent session</b> — run <code>claude</code> in any repository, in any terminal. No changes to the repo, the agent doesn't know Swarm is there.`)}
      ${step(3, false, `<b>Watch it appear here</b> — live status, branch, tokens and cost per session; Board, Timeline and Spend fill up as you work.`)}
    </div>
    <div class="dim">Something off? <code>swarm doctor</code> checks every piece and prints the fix.</div>
  </div>`;
}

// ---------- fleet
// Fleet data-grid columns (sortable/resizable/reorderable/filterable via table.js).
// M9.4: this session is blocked on a person right now — the badge says for how long, and on what.
const waitFor = (sid) => (state.waiting?.sessions ?? []).find((w) => w.sessionId === sid);
const WAIT_WHAT = { permission: "a permission prompt", question: "a question it asked", notification: "a notification" };
function waitBadge(sid) {
  const w = waitFor(sid);
  if (!w?.openSince) return "";
  const what = WAIT_WHAT[w.openKind] ?? "you";
  return ` <span class="badge warn" title="Blocked on ${esc(what)} since ${esc(w.openSince)}${w.openLabel ? ` — ${esc(w.openLabel)}` : ""}">Waiting ${ago(w.openSince)}</span>`;
}
const FLEET_COLS = [
  { key: "project", label: "project", width: 112, get: (s) => projName(s.projectId), cell: (s) => projCell(s.projectId) },
  { key: "agent", label: "agent", width: 78, cls: "td-badge", get: (s) => agentLabel(s.agent), cell: (s) => agentBadge(s.agent) },
  { key: "session", label: "session", width: 210, get: (s) => s.title ?? s.id, cell: (s) => `${kindIcon(s)}<b>${esc(s.title ?? s.id.slice(0, 8))}</b>${s.subagents ? ` <span class="badge acc">${s.subagents} Sub</span>` : ""}${(state.questions ?? []).some((q) => q.sessionId === s.id) ? ' <span class="badge warn" title="This agent asked a question only a human can answer — open the session">Asking</span>' : ""}${s.stuck ? ` <span class="badge bad" title="${esc(s.stuck)} — heuristic, nothing was interrupted; open the session to judge">Stuck</span>` : ""}${waitBadge(s.id)}` },
  { key: "branch", label: "branch", width: 116, get: (s) => s.branch ?? "", cell: (s) => `<span class="br">${esc(s.branch ?? "")}</span>` },
  { key: "now", label: "now", flex: true, get: (s) => s.last, cell: (s) => {
    const line = s.lastText ? s.lastText.split("\n").find((l) => l.trim()) ?? "" : "";
    if (s.state === "ended") return line ? `<span class="now dim" title="${esc(line)}">${esc(line)}</span>` : '<span class="dim">ended</span>';
    return `<span class="now" title="${esc(s.last)}">${esc(s.state === "waiting" && line ? line : s.last)}</span>`;
  } },
  { key: "model", label: "model", width: 84, get: (s) => model(s.model), cell: (s) => `<span class="br">${esc(model(s.model))}${s.models > 1 ? ` <span class="faint">+${s.models - 1}</span>` : ""}</span>` },
  { key: "trend", label: "trend", width: 84, sortable: false, filterable: false, get: () => null, cell: (s) => viz.sparkline(s.spark.map((p) => p[0]), viz.agentColor(s.agent)) },
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
    (live.length ? table(live, "fleet-live") : state.sessions.length ? `<div class="empty">${PX.idle()}Nothing running.</div>` : onboarding()) +
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
          trailing: { width: 34, cell: (p) => more("pr", `data-pid="${esc(p.projectId)}" data-num="${p.number}"`) },
          rowAttrs: (p) => `data-ctx="pr" data-pid="${esc(p.projectId)}" data-num="${p.number}"`,
          rerender: touch,
        })
      : `<div class="empty">${PX.idle()}No open pull requests.<br>Agent branches land here the moment they're pushed.</div>`);
}

// ---------- board (coordination: claims, worktrees, incidents)
// Board representation toggles (cards vs table), persisted per section.
const boardMode = (k) => localStorage.getItem(`swarm.board.${k}`) ?? "cards";
const modeSeg = (k, a = "Cards", b = "Table") => `<span class="seg"><a href="#" data-bmode="${k}:cards" class="${boardMode(k) === "cards" ? "on" : ""}">${a}</a><a href="#" data-bmode="${k}:table" class="${boardMode(k) === "table" ? "on" : ""}">${b}</a></span>`;

// KPI strip: the board at a glance — what is live, held, dirty, failing, waiting.
function renderBoardKpis() {
  const inSel = (pid) => !state.sel || pid === state.sel;
  const live = state.sessions.filter((s) => inSel(s.projectId) && (s.state === "active" || s.state === "waiting"));
  const waiting = live.filter((s) => s.state === "waiting").length;
  const claims = (state.claims ?? []).filter((c) => c.state !== "released" && inSel(c.projectId));
  const orphaned = claims.filter((c) => c.state === "orphaned").length;
  const wts = (state.sel ? [state.sel] : state.projects.map((p) => p.id)).flatMap((id) => state.worktrees[id] ?? []);
  const dirty = wts.filter((w) => w.dirty > 0).length, merged = wts.filter((w) => !w.main && w.merged).length;
  // The snapshot carries only the 20 most recent open incidents, so counting that window caps the
  // KPI at 20 while the Guard badge shows the real number. Both now read the same true count.
  const inc = state.sel
    ? (state.openIncidentsByProject?.[state.sel] ?? (state.incidents ?? []).filter((i) => inSel(i.projectId) && !i.acked).length)
    : (state.openIncidents ?? (state.incidents ?? []).filter((i) => !i.acked).length);
  const tasks = state.sel && state.tasks?.tasks ? state.tasks.tasks : null;
  const ready = tasks ? tasks.filter((t) => t.ready).length : null;
  const gateFails = tasks ? tasks.filter((t) => (t.gates ?? []).some((g) => g.verdict === "fail")).length : 0;
  if (!live.length && !claims.length && !wts.length && !inc && !tasks) return "";
  const kpi = (l, v, d, cls = "") => `<div class="kpi ${cls}"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
  return `<div class="kpis kpis-5">${
    kpi("Live", live.length, waiting ? `${waiting} waiting on you` : live.length ? "sessions working" : "no sessions", waiting ? "hot" : "")
  }${kpi("Held", claims.length, orphaned ? `${orphaned} orphaned` : claims.length ? "claims with a lease" : "nothing claimed", orphaned ? "hot" : "")
  }${kpi("Worktrees", wts.length, dirty || merged ? `${dirty ? `${dirty} dirty` : ""}${dirty && merged ? " · " : ""}${merged ? `${merged} merged` : ""}` : "all clean", dirty ? "warm" : "")
  }${tasks ? kpi("Ready", ready, gateFails ? `${gateFails} with failing gates` : `${tasks.filter((t) => t.status !== "done").length} open`, gateFails ? "hot" : "") : kpi("Projects", state.sel ? 1 : state.projects.length, "on the board")
  }${kpi("Incidents", inc, inc ? "need a look" : "all acknowledged", inc ? "hot" : "")}</div>`;
}

function renderBoard() {
  const parts = [renderBoardKpis(), renderTasks(), renderDispatch(), renderWorkflowRuns(), renderGates(), renderProcesses(), renderResources(), renderClaims(), renderWorktrees(), renderIncidents()].filter(Boolean);
  $("#main").innerHTML = parts.length
    ? parts.join("").replace(/^(<div class="kpis[^>]*>[\s\S]*?<\/div><\/div>|)(<h2) class="mt-sec"/, "$1$2") // first section needs no top gap
    : `<div class="empty">${PX.idle()}Nothing on the board.<br>Tasks, processes, claims, worktrees, and incidents appear here.</div>`;
}

// Incident columns are shared by the Board section (open only, recent) and the Incidents view (feed).
function incidentColumns(full) {
  const sess = (id) => state.sessions.find((s) => s.id === id);
  return [
    { key: "ts", label: "when", width: 76, get: (i) => i.ts, cell: (i) => `<span class="dim" title="${esc(i.ts)}">${ago(i.ts)}</span>` },
    { key: "project", label: "project", width: 104, get: (i) => projName(i.projectId), cell: (i) => projCell(i.projectId) },
    { key: "session", label: "session", width: 150, get: (i) => sess(i.sessionId)?.title ?? i.sessionId ?? "", cell: (i) => (i.sessionId ? `<a href="#" data-s="${i.sessionId}">${esc(sess(i.sessionId)?.title ?? i.sessionId.slice(0, 8))}</a>` : '<span class="dim">—</span>') },
    { key: "rule", label: "rule", width: 150, get: (i) => i.rule, cell: (i) => `<span class="br">${esc(i.rule ?? "")}</span>` },
    { key: "action", label: "action", width: 80, get: (i) => i.action, cell: (i) => (i.action === "deny" ? '<span class="badge warn">Denied</span>' : i.action === "orphaned" ? '<span class="badge warn">Orphaned</span>' : i.action === "failed" ? '<span class="badge warn">Failed</span>' : '<span class="badge acc">Asked</span>') },
    { key: "command", label: "command", flex: true, get: (i) => i.command, cell: (i) => `<span class="now" title="${esc(i.command ?? "")}${i.reason ? `\n\n${esc(i.reason)}` : ""}">${esc(cmdGist(i.command ?? ""))}</span>` },
    ...(full ? [
      { key: "reason", label: "reason", width: 260, get: (i) => i.reason ?? "", cell: (i) => `<span class="dim now" title="${esc(i.reason ?? "")}">${esc(i.reason ?? "")}</span>` },
      { key: "acked", label: "acked", width: 80, get: (i) => i.acked ?? "", cell: (i) => (i.acked ? `<span class="dim" title="${esc(i.acked)}">${ago(i.acked)}</span>` : '<span class="badge warn">Open</span>') },
    ] : []),
  ].filter((c) => !(c.key === "project" && state.sel) && !(c.key === "session" && !full));
}
/** The part of a shell command worth reading in a cell: drop a leading `cd <dir> &&` / `;`. */
const cmdGist = (c) => c.replace(/^\s*cd\s+\S+\s*(&&|;)\s*/, "").replace(/\s+/g, " ").trim() || c;
const incidentDot = (i) => `<span class="s ${i.acked ? "ended" : i.action === "deny" || i.action === "orphaned" || i.action === "failed" ? "waiting" : "idle"}"></span>`;

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
      trailing: { width: 34, cell: (i) => more("incident", `data-seq="${i.seq}"`) },
      rowAttrs: (i) => `data-ctx="incident" data-seq="${i.seq}"`,
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
          trailing: { width: 34, cell: (i) => more("incident", `data-seq="${i.seq}"`) },
          rowAttrs: (i) => `data-ctx="incident" data-seq="${i.seq}"`,
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
    { key: "project", label: "project", width: 104, get: (r) => projName(r.projectId), cell: (r) => projCell(r.projectId) },
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
      trailing: { width: 34, cell: (r) => more("process", `data-pid="${r.pid}" data-proj="${esc(r.projectId)}" data-cwd="${esc(r.cwd ?? "")}"`) },
      rowAttrs: (r) => `data-ctx="process" data-pid="${r.pid}" data-proj="${esc(r.projectId)}" data-cwd="${esc(r.cwd ?? "")}"`,
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
      trailing: { width: 34, cell: (r) => more("resource", `data-name="${esc(r.name)}" data-proj="${esc(r.projectId ?? "")}"`) },
      rowAttrs: (r) => `data-ctx="resource" data-name="${esc(r.name)}" data-proj="${esc(r.projectId ?? "")}"`,
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
  const history = (gate) => {
    const rs = runs.filter((r) => r.gate === gate).slice(0, 12).reverse();
    if (!rs.length) return "";
    return `<span class="gh" title="${esc(gate)} — last ${rs.length} run${rs.length === 1 ? "" : "s"}, oldest first">${esc(gate)} ${rs.map((r) => `<i class="${r.verdict === "pass" ? "ok" : "bad"}" title="${esc(r.rubric)}"></i>`).join("")}</span>`;
  };
  const gateNames = [...new Set(runs.map((r) => r.gate))];
  return `<h2 class="mt-sec">Recent gates <span>${runs.length} run${runs.length === 1 ? "" : "s"}${required.length ? ` · required: ${required.map(esc).join(", ")}` : ""} · latest run per gate decides</span>${gateNames.length ? `<span class="grow"></span><span class="gh-strip">${gateNames.map(history).join("")}</span>` : ""}</h2>` +
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
  const lane = (t) => (t.claimedBy ? "held" : t.status === "done" ? "done" : t.ready ? "ready" : t.status === "active" ? "held" : "blocked");
  const card = (t) => `<div class="tcard ${lane(t)}" tabindex="0" role="button" data-menu="task" data-ctx="task" data-task="${esc(t.id)}" title="${esc(t.statusText)}">
      <div class="tc-h"><b>${esc(t.id)}</b>${t.claimedBy ? `<span class="badge ok">${esc(t.claimedBy)}</span>` : ""}${t.depends.length && lane(t) === "blocked" ? `<span class="dim">← ${esc(t.depends.join(" "))}</span>` : ""}</div>
      <div class="tc-t">${esc(t.title)}</div>
      ${t.milestone ? `<div class="tc-m">${esc(t.milestone.split(" — ")[0])}</div>` : ""}
      ${(t.gates ?? []).some((g) => g.verdict) ? `<div class="tc-g">${gateChips(t.gates)}</div>` : ""}
    </div>`;
  const kanban = () => {
    const lanes = [["ready", "Ready"], ["held", "In progress"], ["blocked", "Blocked"], ["done", "Done"]];
    const by = Object.fromEntries(lanes.map(([k]) => [k, []]));
    for (const t of all) by[lane(t)].push(t);
    by.done.reverse();
    const CAP = 6;
    return `<div class="kanban">${lanes.map(([k, label]) => {
      const list = by[k];
      const shown = k === "done" ? list.slice(0, CAP) : list;
      return `<div class="lane ${k}"><div class="lane-h">${label} <span>${list.length}</span></div>${shown.map(card).join("") || '<div class="lane-empty">—</div>'}${list.length > shown.length ? `<div class="lane-more dim">+${list.length - shown.length} more in the table</div>` : ""}</div>`;
    }).join("")}</div>`;
  };
  return `<h2 class="mt-sec">Tasks <span>${ready.length} ready · ${all.length} in ${esc(srcLabel)}${state.tasks.error ? ` · <span class="badge warn" title="${esc(state.tasks.error)}">${ic("warning", 12)} ${esc(state.tasks.error)}</span>` : ""}</span></h2>` +
    `<div class="chips">${boardMode("tasks") === "cards" ? "" : chip("ready", "Ready", ready.length) + chip("open", "Open", all.filter((t) => t.status !== "done").length) + chip("all", "All", all.length)}${ready.length ? `<span class="chip" id="dispatch" title="Claim a worktree per ready task and spawn a run in each, ${state.dispatch?.config?.max_parallel ?? 2} at a time">${ic("play", 12)} Dispatch</span>` : ""}<span class="grow"></span>${modeSeg("tasks")}</div>` +
    (all.length && boardMode("tasks") === "cards" ? kanban() : rows.length
      ? dataTable({
          id: "tasks",
          columns: cols,
          rows,
          leading: { width: 24, cell: (t) => `<span class="s ${t.claimedBy ? "active" : t.ready ? "waiting" : "idle"}"></span>` },
          trailing: { width: 34, cell: (t) => (t.ready || t.claimedBy ? more("task", `data-task="${esc(t.id)}"`) : "") },
          rowAttrs: (t) => `data-ctx="task" data-task="${esc(t.id)}"`,
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
    { key: "project", label: "project", width: 104, get: (c) => projName(c.projectId), cell: (c) => projCell(c.projectId) },
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
      trailing: { width: 34, cell: (c) => more("claim", `data-pid="${esc(c.projectId)}" data-task="${esc(c.task)}"`) },
      rowAttrs: (c) => `data-ctx="claim" data-pid="${esc(c.projectId)}" data-task="${esc(c.task)}"`,
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
    { key: "project", label: "project", width: 104, get: (w) => projName(w.projectId), cell: (w) => projCell(w.projectId) },
    { key: "branch", label: "branch", width: 240, get: (w) => w.branch ?? "", cell: (w) => `<span class="br">${esc(w.branch ?? "(detached)")}</span>${w.main ? ' <span class="badge">Main tree</span>' : ""}` },
    { key: "head", label: "head", width: 90, get: (w) => w.head, cell: (w) => `<span class="br">${esc(w.head)}</span>` },
    { key: "path", label: "path", flex: true, get: (w) => w.path, cell: (w) => `<span class="now" title="${esc(w.path)}">${esc(short(w.path))}</span>` },
    { key: "state", label: "state", width: 170, get: (w) => w.dirty * 1000 + w.ahead, cell: (w) => `${badge(w.dirty, "Dirty", "warn")}${badge(w.ahead, "Unpushed", "acc")}${w.dirty === 0 && w.ahead <= 0 ? '<span class="badge">Clean</span>' : ""}` },
    { key: "drift", label: "drift", width: 120, get: (w) => (w.main ? -1 : w.behind), cell: (w) => (w.main ? "" : w.merged ? '<span class="badge" title="This branch is already in the main checkout\'s branch">Merged</span>' : w.behind > 0 ? `<span class="badge warn" title="Commits on the main checkout\'s branch this worktree lacks">${w.behind} behind</span>` : w.behind === 0 ? '<span class="badge">Up to date</span>' : '<span class="dim">—</span>') },
    { key: "sessions", label: "sessions", width: 160, get: (w) => inside(w).length, cell: (w) => inside(w).map((x) => `<a href="#" data-s="${x.id}">${esc(x.title ?? x.id.slice(0, 8))}</a>`).join(", ") || '<span class="dim">—</span>' },
  ].filter((c) => !(c.key === "project" && state.sel));
  const heldBy = new Map(state.claims ? state.claims.filter((c) => c.state === "held").map((c) => [c.worktree, c.task]) : []);
  const gcBtn = state.sel ? ` <a href="#" class="nav" id="wtgc" title="Find worktrees whose branch is merged or whose claim is gone">${ic("trash", 12)} Collect stale</a>` : "";
  const newBtn = state.sel ? ` <a href="#" class="nav" id="wtnew" title="Create a task-less worktree (spike, review checkout)">${ic("plus", 12)} New worktree</a>` : "";
  const stateOf = (w) => (inside(w).length ? "live" : w.dirty > 0 ? "dirty" : w.ahead > 0 ? "ahead" : w.merged ? "merged" : "clean");
  const tile = (w) => `<div class="wt ${stateOf(w)}${w.main ? " main" : ""}${heldBy.has(w.path) ? " held" : ""}" tabindex="0" role="button" data-menu="worktree" data-ctx="worktree" data-pid="${esc(w.projectId)}" data-path="${esc(w.path)}" title="${esc(w.path)}">
      <div class="wt-b"><span class="s ${inside(w).length ? "active" : w.dirty > 0 ? "waiting" : "ended"}"></span><span class="br">${esc(w.branch ?? "(detached)")}</span></div>
      <div class="wt-m">${w.main ? "main tree" : w.merged ? "merged" : w.behind > 0 ? `${w.behind} behind` : w.behind === 0 ? "up to date" : ""}${w.dirty ? ` · <i class="warn">${w.dirty} dirty</i>` : ""}${w.ahead > 0 ? ` · <i class="acc">${w.ahead} unpushed</i>` : ""}${heldBy.has(w.path) ? ` · held: ${esc(heldBy.get(w.path))}` : ""}${inside(w).length ? ` · ${inside(w).map((x) => esc(x.title ?? x.id.slice(0, 8))).join(", ")}` : ""}</div>
    </div>`;
  const map = () => {
    const groups = new Map();
    for (const w of rows) (groups.get(w.projectId) ?? groups.set(w.projectId, []).get(w.projectId)).push(w);
    const order = { live: 0, dirty: 1, ahead: 2, clean: 3, merged: 4 };
    return `<div class="wtmap">${[...groups].map(([pid, list]) => `<div class="wt-group"><div class="wt-proj">${projCell(pid)} <span>${list.length}</span></div><div class="wt-tiles">${list.sort((a, b) => (b.main - a.main) || order[stateOf(a)] - order[stateOf(b)]).map(tile).join("")}</div></div>`).join("")}</div>`;
  };
  return `<h2 class="mt-sec hrow">Worktrees <span>${rows.length}</span>${newBtn}${gcBtn}<span class="grow"></span>${modeSeg("worktrees", "Map", "Table")}</h2>` +
    (boardMode("worktrees") === "cards" ? map() :
    dataTable({
      id: "worktrees",
      columns: cols,
      rows,
      leading: { width: 24, cell: (w) => `<span class="s ${inside(w).length ? "active" : w.dirty > 0 ? "waiting" : "ended"}"></span>` },
      trailing: { width: 34, cell: (w) => more("worktree", `data-pid="${esc(w.projectId)}" data-path="${esc(w.path)}"`) },
      rowAttrs: (w) => `data-ctx="worktree" data-pid="${esc(w.projectId)}" data-path="${esc(w.path)}"`,
      rerender: touch,
    }));
}

// ---------- workflows (M7.8)
function renderWorkflowRuns() {
  const w = state.workflows;
  if (!state.sel || !w?.runs?.length) return "";
  const chip = (r, i) => {
    const label = esc(r.steps[i]);
    if (i < r.step || (r.state === "done" && i <= r.step)) return `<span class="wfs ok" title="${label}">✓ ${label}</span>`;
    if (i === r.step) return r.state === "running" ? `<span class="wfs run" title="${label}">● ${label}</span>` : r.state === "failed" ? `<span class="wfs bad" title="${label}">✗ ${label}</span>` : `<span class="wfs" title="${label}">◦ ${label}</span>`;
    return `<span class="wfs" title="${label}">○ ${label}</span>`;
  };
  const badge = (r) => r.state === "running" ? '<span class="badge acc">Running</span>' : r.state === "done" ? '<span class="badge ok">Done</span>' : r.state === "failed" ? '<span class="badge warn">Failed</span>' : '<span class="badge">Stopped</span>';
  const cols = [
    { key: "task", label: "task", width: 90, get: (r) => r.task, cell: (r) => `<b>${esc(r.task)}</b>` },
    { key: "workflow", label: "workflow", width: 100, get: (r) => r.workflow, cell: (r) => `<span class="br">${esc(r.workflow)}</span>` },
    { key: "steps", label: "steps", flex: true, sortable: false, get: (r) => r.step, cell: (r) => `<span class="wf-steps">${r.steps.map((_, i) => chip(r, i)).join("")}</span>` },
    { key: "state", label: "state", width: 90, get: (r) => r.state, cell: badge },
    { key: "detail", label: "detail", width: 260, get: (r) => r.detail ?? "", cell: (r) => `<span class="dim now" title="${esc(r.detail ?? "")}">${esc(r.detail ?? "")}</span>` },
    { key: "when", label: "updated", width: 76, get: (r) => r.updatedAt, cell: (r) => `<span class="dim">${ago(r.updatedAt)}</span>` },
  ];
  const running = w.runs.filter((r) => r.state === "running").length;
  return `<h2 class="mt-sec">Workflows <span>${running ? `${running} running · ` : ""}${Object.keys(w.defs ?? {}).map(esc).join(", ") || "none declared"}</span></h2>` +
    dataTable({
      id: "workflows",
      columns: cols,
      rows: w.runs.slice(0, 20),
      leading: { width: 24, cell: (r) => `<span class="s ${r.state === "running" ? "active" : r.state === "failed" ? "waiting" : "ended"}"></span>` },
      trailing: { width: 60, cell: (r) => (r.state === "running" ? `<a href="#" data-wfstop="${esc(r.task)}">Stop</a>` : "") },
      rerender: touch,
    });
}

// ---------- dispatch (M7.5)
function renderDispatch() {
  const d = state.dispatch;
  if (!state.sel || !d?.entries?.length) return "";
  const rows = d.entries;
  const oc = (e) => e.state === "queued" ? '<span class="badge">Queued</span>'
    : e.state === "running" ? '<span class="badge acc">Running</span>'
    : e.outcome === "done" ? '<span class="badge ok">Done</span>'
    : e.outcome === "stopped" ? '<span class="badge">Stopped</span>'
    : `<span class="badge warn">${esc(e.outcome ?? "?")}</span>`;
  const cols = [
    { key: "task", label: "task", width: 90, get: (e) => e.task, cell: (e) => `<b>${esc(e.task)}</b>` },
    { key: "title", label: "title", flex: true, get: (e) => e.title, cell: (e) => esc(e.title) },
    { key: "state", label: "state", width: 110, get: (e) => (e.state === "running" ? 0 : e.state === "queued" ? 1 : 2), cell: oc },
    { key: "cost", label: "cost", width: 70, num: true, get: (e) => e.costUsd ?? -1, cell: (e) => (e.costUsd != null ? usd(e.costUsd) : '<span class="dim">—</span>') },
    { key: "detail", label: "detail", width: 360, get: (e) => e.detail ?? "", cell: (e) => `<span class="dim" title="${esc(e.detail ?? "")}">${esc(e.detail ?? "")}</span>` },
  ];
  const running = rows.filter((e) => e.state === "running").length, queued = rows.filter((e) => e.state === "queued").length;
  return `<h2 class="mt-sec hrow">Dispatch <span>${running} running · ${queued} queued · cap ${d.config?.max_parallel ?? 2}</span><a href="#" class="nav" id="dispatchClear" title="Drop queued tasks and clear finished rows (running ones keep going)">${ic("trash", 12)} Clear</a></h2>` +
    dataTable({
      id: "dispatch",
      columns: cols,
      rows,
      leading: { width: 24, cell: (e) => `<span class="s ${e.state === "running" ? "active" : e.state === "queued" ? "waiting" : e.outcome === "done" ? "ended" : "waiting"}"></span>` },
      trailing: { width: 90, cell: (e) => (e.sessionId ? `<a href="#" data-s="${esc(e.sessionId)}">session</a>` : "") },
      rerender: touch,
    });
}

// 0.7.0: the project's [budget] ceiling against what it spent
function budgetKpi(kpi) {
  const b = state.sel ? state.budget : null;
  if (!b?.status) return state.sel ? kpi("budget", "—", "no [budget] in .swarm.toml") : "";
  const s = b.status;
  const pct = Math.round(s.pct * 100);
  const cls = s.level === "exceeded" ? "warn" : s.level === "warn" ? "acc" : "";
  return kpi(`${s.kind} budget`, `<span class="${cls}">${pct}%</span>`, `${usd(s.spent)} of ${usd(s.limit)} · past it: ${b.config.on_exceed}`);
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
     <div class="kpis">${kpi("today", usd(todayCost), `${todayTurns} turns`)}${kpi(`${N}-day total`, usd(total14), `${activeDays} active day${activeDays === 1 ? "" : "s"}`)}${kpi("today vs avg", prevDays ? `${todayCost >= avg ? "+" : ""}${(((todayCost - avg) / avg) * 100).toFixed(0)}%` : "—", prevDays ? `vs ${usd(avg)} / active day` : "no earlier days to compare")}${kpi("agents", agents.length, agents.map(agentLabel).join(" · ") || "—")}${budgetKpi(kpi)}</div>
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
document.addEventListener("change", async (ev) => {
  if (ev.target.id !== "psFile" || !ev.target.files?.[0]) return;
  try { const d = await fileToIconDataUrl(ev.target.files[0]); $("#psImage").value = d; $("#psIcon").value = ""; setIconPreview(d); for (const e of $$(".emoji")) e.classList.remove("on"); }
  catch (e) { alert(e.message); }
});
document.addEventListener("input", (ev) => { if (ev.target.id === "psIcon") { $("#psImage").value = ""; setIconPreview(ev.target.value.trim()); for (const e of $$(".emoji")) e.classList.toggle("on", e.dataset.emoji === ev.target.value.trim()); } });
document.addEventListener("input", (ev) => { if (ev.target.id === "srchQ") { srch.q = ev.target.value; clearTimeout(srch.db); srch.db = setTimeout(runSearch, 150); } });
// M9.4: how much of the fleet's time is spent waiting on a person, and on what. Blocked time is
// not idle time — it is the agent standing still with the work half-done, which is why it gets a
// number rather than a footnote.
function waitingSection() {
  const w = state.waiting;
  if (!w?.totals?.episodes) return "";
  const t = w.totals;
  const kindRow = (k, label) => {
    const x = t.byKind[k];
    return x?.episodes ? `<tr><td>${label}</td><td class="num">${x.episodes}</td><td class="num">${dur(x.blockedMs)}</td></tr>` : "";
  };
  const top = w.sessions.slice(0, 8).map((s) => `<tr${s.sessionId ? ` data-s="${esc(s.sessionId)}"` : ""}>
      <td>${esc(s.title ?? s.sessionId.slice(0, 8))}${s.openSince ? ` <span class="badge warn">waiting ${ago(s.openSince)}</span>` : ""}</td>
      <td class="num">${s.episodes}</td><td class="num">${dur(s.blockedMs)}</td><td class="num">${dur(s.longestMs)}</td></tr>`).join("");
  return `<h2 class="mt-sec">Waiting on you <span>last 7 days · time agents spent blocked on a person${t.waitingNow ? ` · <b class="navcount">${t.waitingNow} waiting now</b>` : ""}</span></h2>
     <div class="cols">
       <div class="chart-card" style="margin:0"><h3>By what blocked them</h3>
         <table class="mini"><thead><tr><th>kind</th><th class="num">times</th><th class="num">blocked</th></tr></thead>
         <tbody>${kindRow("permission", "Permission prompt")}${kindRow("question", "Question it asked")}${kindRow("notification", "Notification")}
           <tr><td><b>Total</b></td><td class="num"><b>${t.episodes}</b></td><td class="num"><b>${dur(t.blockedMs)}</b></td></tr>
           <tr><td class="dim">median wait</td><td class="num"></td><td class="num dim">${dur(t.medianMs)}</td></tr>
           <tr><td class="dim">longest wait</td><td class="num"></td><td class="num dim">${dur(t.longestMs)}</td></tr>
         </tbody></table></div>
       <div class="chart-card" style="margin:0"><h3>Sessions that waited most</h3>
         <table class="mini"><thead><tr><th>session</th><th class="num">waits</th><th class="num">blocked</th><th class="num">longest</th></tr></thead>
         <tbody>${top}</tbody></table></div>
     </div>`;
}
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
     ${waitingSection()}
     <p class="dim" style="margin-top:var(--gap-sec)">Word counts assume ~0.75 words per token; a novel is 90k words. Costs use list prices, as on Spend. ${pct(T.sidechainTurns, T.turns)} of turns came from subagents.</p>`;
}

// ---------- timeline
let tlDetail = { key: "", data: null, busy: false };
async function loadTimelineDetail() {
  const hours = state.tlHours ?? 12;
  const key = `${hours}:${state.sel ?? ""}`;
  if (tlDetail.busy || (tlDetail.key === key && tlDetail.at && Date.now() - tlDetail.at < 15_000)) return;
  tlDetail.busy = true;
  try {
    const q = new URLSearchParams({ hours: String(hours) });
    if (state.sel) q.set("project", state.sel);
    const data = await (await fetch(`/v1/timeline?${q}`)).json();
    tlDetail = { key, at: Date.now(), data, busy: false };
    if (state.view === "timeline" && !state.session) touch();
  } finally { tlDetail.busy = false; }
}
// M9.2: Outcomes — did the agent's work survive? Branch → PR → merged / reverted, with
// scorecards per model and per agent. Data from /v1/outcomes (fetched by the poll while open).
const outBadge = (o) => ({ merged: '<span class="badge ok">merged</span>', reverted: '<span class="badge bad">reverted</span>', open: '<span class="badge acc">open</span>', "no-pr": '<span class="badge">no PR</span>' })[o] ?? esc(o);
const ratePct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const hrs = (x) => (x == null || x < 0 ? "—" : x < 1 ? `${Math.round(x * 60)}m` : x < 48 ? `${x.toFixed(1)}h` : `${(x / 24).toFixed(1)}d`);
const scoreCols = (label) => [
  { key: "key", label, width: 150, get: (r) => r.key, cell: (r) => `<b>${esc(label === "model" ? model(r.key) : viz.agentName(r.key))}</b>` },
  { key: "branches", label: "branches", width: 80, num: true, get: (r) => r.branches, cell: (r) => String(r.branches) },
  { key: "merged", label: "merged", width: 72, num: true, get: (r) => r.merged, cell: (r) => String(r.merged) },
  { key: "reverted", label: "reverted", width: 78, num: true, get: (r) => r.reverted, cell: (r) => (r.reverted ? `<b style="color:var(--bad)">${r.reverted}</b>` : "0") },
  { key: "open", label: "open", width: 60, num: true, get: (r) => r.open, cell: (r) => String(r.open) },
  { key: "nopr", label: "no PR", width: 64, num: true, get: (r) => r.noPr, cell: (r) => String(r.noPr) },
  { key: "rate", label: "merge rate", width: 92, num: true, get: (r) => r.mergeRate ?? -1, cell: (r) => ratePct(r.mergeRate) },
  { key: "lead", label: "median lead", width: 98, num: true, get: (r) => r.medianLeadHours ?? -1, cell: (r) => hrs(r.medianLeadHours) },
  { key: "cpm", label: "$ / merge", width: 84, num: true, get: (r) => r.costPerMerge ?? -1, cell: (r) => (r.costPerMerge == null ? "—" : usd(r.costPerMerge)) },
];
const BRANCH_COLS = [
  { key: "branch", label: "branch", width: 190, get: (r) => r.branch, cell: (r) => `<span class="br">${esc(r.branch)}</span>` },
  { key: "outcome", label: "outcome", width: 92, cls: "td-badge", get: (r) => r.outcome, cell: (r) => outBadge(r.outcome) },
  { key: "pr", label: "PR", flex: true, get: (r) => r.title ?? "", cell: (r) => (r.prNumber ? `<a href="${esc(r.url ?? "#")}" target="_blank" rel="noreferrer">#${r.prNumber}</a> <span class="dim">${esc(r.title ?? "")}</span>` : '<span class="faint">—</span>') },
  { key: "model", label: "model", width: 92, get: (r) => model(r.model), cell: (r) => `<span class="br">${esc(model(r.model))}</span>` },
  { key: "agent", label: "agent", width: 78, cls: "td-badge", get: (r) => agentLabel(r.agent), cell: (r) => agentBadge(r.agent) },
  { key: "sessions", label: "sessions", width: 76, num: true, get: (r) => r.sessions.length, cell: (r) => String(r.sessions.length) },
  { key: "cost", label: "cost", width: 64, num: true, get: (r) => r.costUsd, cell: (r) => usd(r.costUsd) },
  { key: "lead", label: "lead", width: 64, num: true, get: (r) => r.leadHours ?? -1, cell: (r) => hrs(r.leadHours) },
];
function renderOutcomes() {
  const o = state.outcomes;
  const head = (sub) => `<h2>Outcomes <span>${sub}</span></h2>`;
  if (!o) {
    $("#main").innerHTML = head("did the work survive?") + `<div class="empty">${PX.idle()}Loading…</div>`;
    return;
  }
  if (!o.branches?.length) {
    $("#main").innerHTML = head("did the work survive?") + `<div class="empty">${PX.idle()}No agent branches yet${state.sel ? " in this project" : ""}.<br>Outcomes fill in as sessions work on branches and their PRs merge — or get reverted.</div>`;
    return;
  }
  const n = (k) => o.branches.filter((b) => b.outcome === k).length;
  const rev = n("reverted");
  $("#main").innerHTML =
    head(`${o.branches.length} branch${o.branches.length === 1 ? "" : "es"} · ${n("merged")} merged · ${rev ? `<b style="color:var(--bad)">${rev} reverted</b>` : "0 reverted"} · ${n("open")} open`) +
    `<h2 class="mt-sec">By model <span>who ships work that survives</span></h2>` +
    dataTable({ id: "outcomes-model", columns: scoreCols("model"), rows: o.byModel, rerender: touch }) +
    (o.byAgent.length > 1 ? `<h2 class="mt-sec">By agent</h2>${dataTable({ id: "outcomes-agent", columns: scoreCols("agent"), rows: o.byAgent, rerender: touch })}` : "") +
    `<h2 class="mt-sec">Branches <span>latest first</span></h2>` +
    dataTable({ id: "outcomes-branches", columns: BRANCH_COLS, rows: o.branches.slice(0, 100), rerender: touch });
}

// M9.5: where the context window goes. Character counts are exact (every tool response is stored);
// the token figures are a flat 4:1 estimate and say so. Re-reading a file is the waste metric —
// the first read is work, every copy after it is the price of having forgotten.
// `toolName` puts the server first, so four MCP tools all truncated to "claude-in-c…" and the
// half that tells them apart was the half cut off. Lead with the tool, keep a short server hint.
function ctxToolLabel(tool) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(tool);
  if (!m) return tool;
  const srv = m[1].replace(/[-_]/g, " ").split(" ").map((w) => w[0]).join("").toLowerCase();
  return `${m[2]} · ${srv}`;
}
function renderContext() {
  const c = state.context;
  const head = (sub) => `<h2>Context <span>${sub}</span></h2>`;
  if (!c) { $("#main").innerHTML = head("where the window goes") + `<div class="empty">${PX.clock()}Loading…</div>`; return; }
  if (!c.totals.sessions) {
    $("#main").innerHTML = head("where the window goes") + `<div class="empty">${PX.idle()}No tool results in the last 7 days${state.sel ? " in this project" : ""}.</div>`;
    return;
  }
  const t = c.totals;
  const chars = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  const kpi = (l, v, d, cls = "") => `<div class="kpi ${cls}"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
  const kpis = `<div class="kpis">${
    kpi("Returned by tools", `${chars(t.toolChars)}`, `characters · ≈${chars(t.toolTokens)} tokens`)
  }${kpi("Spent re-reading", chars(t.wastedChars), t.wasteShare ? `${Math.round(t.wasteShare * 100)}% of it · ${t.rereadFiles} file${t.rereadFiles === 1 ? "" : "s"}` : "nothing re-read", t.wasteShare > 0.1 ? "hot" : t.wasteShare > 0.03 ? "warm" : "")
  }${kpi("Cache hit", `${Math.round(t.cacheHit * 100)}%`, "of the window came back free")
  }${kpi("Sessions", t.sessions, "with tool activity")}</div>`;

  const worst = c.sessions.filter((s) => s.wastedChars > 0).slice(0, 10);
  const rows = worst.map((s) => `<tr${s.sessionId ? ` data-s="${esc(s.sessionId)}"` : ""}>
      <td>${esc(s.title ?? s.sessionId.slice(0, 8))}</td>
      <td class="num">${chars(s.toolChars)}</td>
      <td class="num"><b>${chars(s.wastedChars)}</b></td>
      <td class="num">${Math.round(s.wasteShare * 100)}%</td>
      <td class="clip">${s.worst.slice(0, 2).map((w) => `<span class="br" title="${esc(w.path)} — read ${w.reads}× · ${chars(w.wastedChars)} chars re-read">${esc(w.path.split("/").slice(-1)[0])} <b>${w.reads}×</b></span>`).join(" ")}</td>
    </tr>`).join("");

  $("#main").innerHTML = head(`last 7 days · ${chars(t.toolChars)} characters returned by tools`) + kpis +
    `<div class="cols">
       <div class="chart-card" style="margin:0"><h3>What fills the window <span>by tool · characters returned</span></h3>
         ${viz.hbars(c.byTool.map((x) => [ctxToolLabel(x.tool), x.chars, `${chars(x.chars)} · ${x.calls}`]))}</div>
       <div class="chart-card" style="margin:0"><h3>Re-read waste <span>the same file, read again</span></h3>
         ${worst.length ? `<table class="mini"><colgroup><col style="width:31%"><col style="width:15%"><col style="width:14%"><col style="width:11%"><col style="width:29%"></colgroup><thead><tr><th>session</th><th class="num">returned</th><th class="num">wasted</th><th class="num">share</th><th>worst files</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="dim">Nothing was read twice — no waste to report.</div>'}</div>
     </div>
     <p class="dim" style="margin-top:10px;font-size:var(--fs-sm)">Character counts are exact — every tool response is stored. Token figures are a flat 4:1 estimate. <b>MCP tool schemas and the system prompt are not included</b>: Swarm sees tool calls, never the schemas or the prompt preamble, so they are left out rather than guessed at.</p>`;
}

// M9.18: the same task run by N models side by side. An arm is its own task id, so each has its
// own claim and worktree and the ledger's one-holder rule is untouched — see core/abtrial.ts.
const VERDICT = { winner: ["ok", "Decided"], undecided: ["acc", "Running"], "all-failed": ["bad", "No winner"] };
function renderTrials() {
  const trials = state.trials;
  const head = (sub) => `<h2>Trials <span>${sub}</span>${state.sel ? `<span class="grow"></span><span class="chip" id="abNew">${ic("plus", 12)} New trial</span>` : ""}</h2>`;
  if (!trials) { $("#main").innerHTML = head("same task, different models") + `<div class="empty">${PX.clock()}Loading…</div>`; return; }
  if (!trials.length) {
    $("#main").innerHTML = head("same task, different models") + `<div class="empty">${PX.idle()}No trials yet${state.sel ? "" : " — pick a project to start one"}.<br>A trial runs one task on several models at once and compares what each produced: cost, wall time, gates, diff size.</div>`;
    return;
  }
  const secs = (v) => (v === null ? '<span class="dim">—</span>' : dur(v));
  const cols = [
    { key: "arm", label: "arm", width: 130, get: (a) => a.label, cell: (a) => `<b>${esc(a.label)}</b>${a.winner ? ' <span class="badge ok">Winner</span>' : ""}` },
    { key: "state", label: "state", width: 116, get: (a) => a.ineligibleFor ?? "", cell: (a) => (a.eligible ? '<span class="badge ok">Passed</span>' : `<span class="badge ${a.state === "running" ? "acc" : "warn"}" title="This arm cannot win: ${esc(a.ineligibleFor ?? "")}">${esc(a.ineligibleFor ?? "—")}</span>`) },
    { key: "cost", label: "cost", width: 74, num: true, get: (a) => a.costUsd, cell: (a) => usd(a.costUsd) },
    { key: "wall", label: "wall", width: 74, num: true, get: (a) => a.wallMs ?? -1, cell: (a) => secs(a.wallMs) },
    { key: "turns", label: "turns", width: 64, num: true, get: (a) => a.turns, cell: (a) => a.turns },
    { key: "gates", label: "gates", width: 84, num: true, get: (a) => a.gatesFailed * -1 + a.gatesPassed, cell: (a) => `${a.gatesPassed ? `<span class="badge ok">${a.gatesPassed}</span>` : ""}${a.gatesFailed ? ` <span class="badge bad">${a.gatesFailed}</span>` : ""}${!a.gatesPassed && !a.gatesFailed ? '<span class="dim">none</span>' : ""}` },
    { key: "diff", label: "diff", width: 108, num: true, get: (a) => a.churn ?? -1, cell: (a) => (a.churn === null ? '<span class="dim">measuring…</span>' : `<span title="${a.filesChanged} file${a.filesChanged === 1 ? "" : "s"} · +${a.insertions} −${a.deletions}">${a.churn} lines</span>`) },
    { key: "sess", label: "session", flex: true, get: (a) => a.sessionId ?? "", cell: (a) => (a.sessionId ? `<a href="#" data-s="${esc(a.sessionId)}">${esc(a.model ?? a.sessionId.slice(0, 8))}</a>` : '<span class="dim">—</span>') },
  ];
  const block = (t) => {
    const v = VERDICT[t.verdict] ?? VERDICT.undecided;
    const sub = `${t.totals.arms} arm${t.totals.arms === 1 ? "" : "s"} · ${t.totals.finished} finished · ${usd(t.totals.costUsd)} spent${t.winner ? ` · <b>${esc(t.winner)}</b> won${t.totals.savedUsd > 0.005 ? `, ${usd(t.totals.savedUsd)} cheaper than the dearest` : ""}` : ""}`;
    return `<h2 class="mt-sec">${esc(t.task)} <span class="badge ${v[0]}">${v[1]}</span> <span>${sub}</span></h2>` +
      dataTable({ id: `ab-${t.task}`, columns: cols, rows: t.arms, rerender: touch });
  };
  const running = trials.filter((t) => t.verdict === "undecided").length;
  $("#main").innerHTML = head(`${trials.length} trial${trials.length === 1 ? "" : "s"}${running ? ` · ${running} still running` : ""}`) +
    trials.map(block).join("") +
    `<p class="dim" style="margin-top:12px;font-size:var(--fs-sm)">An arm wins only if it finished and passed every gate it ran; among those, the cheapest wins and wall time breaks ties. A cheap arm that failed a gate never wins — the cheap wrong answer is not the answer. Each arm claims <code>task#arm</code>, so it gets its own worktree and the one-holder claim is never bent.</p>`;
}

// M9.14: issue → task → claim → session → branch → PR → merged, as one row per piece of work.
// The six link dots are the graph: a filled run that stops is exactly where the trail goes cold.
const LINK_ORDER = ["task", "claim", "session", "branch", "pr", "merged"];
const BREAK_LABEL = {
  "no-task": ["bad", "No task", "landed with no task behind it"],
  unclaimed: ["warn", "Unclaimed", "no claim was ever taken for this task"],
  "no-session": ["warn", "No session", "claimed, but no session did the work"],
  "no-branch": ["warn", "No branch", "worked on, but never reached a branch"],
  "no-pr": ["warn", "No PR", "a branch exists but no pull request"],
  "open-pr": ["acc", "Open PR", "the pull request has not merged yet"],
};
// Lead time spans minutes to months, and "889.4h" both overflows a numeric column and means
// nothing to a reader. Never wider than 5 characters.
function leadTime(h) {
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  const d = h / 24;
  return d < 100 ? `${d.toFixed(d < 10 ? 1 : 0)}d` : `${Math.round(d / 7)}w`;
}
function renderProvenance() {
  const p = state.provenance;
  const head = (sub) => `<h2>Provenance <span>${sub}</span></h2>`;
  if (!p) { $("#main").innerHTML = head("follow the work back") + `<div class="empty">${PX.clock()}Loading…</div>`; return; }
  if (!p.chains.length) {
    $("#main").innerHTML = head("follow the work back") + `<div class="empty">${PX.idle()}Nothing to trace${state.sel ? " in this project" : ""}.<br>Chains appear once a task source is configured or a branch reaches a pull request.</div>`;
    return;
  }
  const t = p.totals;
  const kpi = (l, v, d, cls = "") => `<div class="kpi ${cls}"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
  const kpis = `<div class="kpis">${
    kpi("Traced", `${t.complete}/${t.tasks}`, "reach a merged PR", t.complete ? "" : "warm")
  }${kpi("Untracked", t.untracked, t.untracked ? "landed with no task" : "all work has a task", t.untracked ? "hot" : "")
  }${kpi("Unclaimed", t.unclaimed, "tasks nobody claimed", t.unclaimed ? "warm" : "")
  }${kpi("Traced spend", usd(t.costUsd), "across every chain")}</div>`;

  const track = (c) => `<span class="track" title="${LINK_ORDER.map((k) => `${k}: ${c.links[k] ? "yes" : "no"}`).join(" · ")}">${
    LINK_ORDER.map((k) => `<i class="${c.links[k] ? "on" : ""}"></i>`).join("")}</span>`;
  const cols = [
    { key: "what", label: "task / branch", width: 190, get: (c) => c.task, cell: (c) => `<b title="${esc(c.task)}${c.fromTask ? "" : " — a branch with no task behind it"}">${esc(c.task)}</b>${c.fromTask ? "" : ' <span class="badge">branch</span>'}` },
    { key: "track", label: "chain", width: 92, sortable: false, filterable: false, get: (c) => c.depth, cell: track },
    { key: "gap", label: "trail ends at", width: 118, get: (c) => c.brokenAt ?? "", cell: (c) => { const b = BREAK_LABEL[c.brokenAt]; return b ? `<span class="badge ${b[0]}" title="${esc(b[2])}">${b[1]}</span>` : '<span class="badge ok">Merged</span>'; } },
    { key: "title", label: "what it was", flex: true, get: (c) => c.title, cell: (c) => `<span class="now" title="${esc(c.title)}">${esc(c.title)}</span>` },
    { key: "who", label: "held by", width: 120, get: (c) => c.holders.join(","), cell: (c) => (c.holders.length ? esc(c.holders.join(", ")) : '<span class="dim">—</span>') },
    { key: "sess", label: "sessions", width: 78, num: true, get: (c) => c.sessions.length, cell: (c) => (c.sessions.length ? `<a href="#" data-s="${esc(c.sessions[0].id)}" title="${esc(c.sessions.map((s) => s.title ?? s.id).join(" · "))}">${c.sessions.length}</a>` : '<span class="dim">0</span>') },
    { key: "pr", label: "PR", width: 74, num: true, get: (c) => c.prNumber ?? 0, cell: (c) => (c.prNumber ? `<a href="${esc(c.prUrl ?? "#")}" target="_blank" rel="noopener">#${c.prNumber}</a>` : '<span class="dim">—</span>') },
    { key: "cost", label: "cost", width: 74, num: true, get: (c) => c.costUsd, cell: (c) => usd(c.costUsd) },
    { key: "lead", label: "lead", width: 68, num: true, get: (c) => c.leadHours ?? -1, cell: (c) => (c.leadHours === null ? '<span class="dim">—</span>' : leadTime(c.leadHours)) },
  ];
  const pg = p.page ?? { limit: p.chains.length, offset: 0, total: p.chains.length };
  const from = pg.total ? pg.offset + 1 : 0;
  const to = Math.min(pg.offset + pg.limit, pg.total);
  const pager = pg.total > pg.limit
    ? `<div class="chips" style="margin-top:10px">
         <span class="chip ${pg.offset ? "" : "off"}" data-provpage="${Math.max(0, pg.offset - pg.limit)}">${ic("arrow-left", 12)} Newer</span>
         <span class="dim" style="align-self:center;font-size:var(--fs-sm)">${from}–${to} of ${pg.total}</span>
         <span class="chip ${to >= pg.total ? "off" : ""}" data-provpage="${pg.offset + pg.limit}">Older ${ic("arrow-right", 12)}</span>
       </div>`
    : "";
  // A cold start has no forge data yet, so PR columns would read as "no PR" for everything.
  const catching = p.stale
    ? `<p class="dim" style="margin-top:8px;font-size:var(--fs-sm)">${ic("arrows-clockwise", 12)} Pull request state is still loading from the forge — it fills in on the next refresh.</p>`
    : "";
  $("#main").innerHTML = head(`${pg.total} chain${pg.total === 1 ? "" : "s"} · ${t.untracked ? `<b class="navcount">${t.untracked} untracked</b>` : "every branch has a task"}`) + kpis +
    dataTable({ id: "provenance", columns: cols, rows: p.chains, rerender: touch }) + pager + catching +
    `<p class="dim" style="margin-top:10px;font-size:var(--fs-sm)">The six dots are task · claim · session · branch · PR · merged — a filled run that stops is where the trail goes cold. Chains are walked from both ends: from tasks forward, and from branches back, so <b>work that landed with no task behind it</b> shows up too. Task rows carry no issue link because the task source records ids and titles, not URLs.</p>`;
}

// M9.6: which MCP servers the fleet waits on. Latency is hook-to-hook — the wall-clock between
// PreToolUse and PostToolUse — so it is what the agent actually waited for, including any time a
// call spent behind a permission prompt. That is why the view leads with p50/p95, not max.
function renderMcpHealth() {
  const h = state.mcpHealth;
  const head = (sub) => `<h2>MCP <span>${sub}</span></h2>`;
  if (!h) { $("#main").innerHTML = head("server health") + `<div class="empty">${PX.clock()}Loading…</div>`; return; }
  if (!h.servers.length) {
    $("#main").innerHTML = head("server health") + `<div class="empty">${PX.idle()}No tool calls in the last 7 days${state.sel ? " in this project" : ""}.</div>`;
    return;
  }
  const t = h.totals;
  const ms = (v) => (v === null ? '<span class="dim">—</span>' : v < 1000 ? `${v}ms` : v < 60_000 ? `${(v / 1000).toFixed(1)}s` : dur(v));
  const cols = [
    { key: "server", label: "server", width: 170, get: (s) => s.server, cell: (s) => `<b>${esc(s.server)}</b>${s.mcp ? "" : ' <span class="badge">built-in</span>'}` },
    { key: "calls", label: "calls", width: 74, num: true, get: (s) => s.calls, cell: (s) => s.calls.toLocaleString() },
    { key: "sessions", label: "sessions", width: 78, num: true, get: (s) => s.sessions, cell: (s) => s.sessions },
    { key: "p50", label: "p50", width: 68, num: true, get: (s) => s.p50Ms ?? -1, cell: (s) => ms(s.p50Ms) },
    { key: "p95", label: "p95", width: 68, num: true, get: (s) => s.p95Ms ?? -1, cell: (s) => ms(s.p95Ms) },
    { key: "max", label: "slowest", width: 78, num: true, get: (s) => s.maxMs ?? -1, cell: (s) => `<span class="dim" title="Includes any time the call spent waiting on a person">${ms(s.maxMs)}</span>` },
    { key: "wait", label: "waited", width: 82, num: true, get: (s) => s.totalMs, cell: (s) => dur(s.totalMs) },
    { key: "unans", label: "no reply", width: 78, num: true, get: (s) => s.unanswered, cell: (s) => (s.unanswered ? `<b class="bad">${s.unanswered}</b>` : '<span class="dim">0</span>') },
    { key: "err", label: "errors", width: 74, num: true, get: (s) => s.errorRate, cell: (s) => (s.errors ? `<b class="bad">${Math.round(s.errorRate * 100)}%</b>` : '<span class="dim">0</span>') },
    { key: "tools", label: "busiest tools", flex: true, sortable: false, get: () => null, cell: (s) => s.tools.map((x) => `<span class="br" title="${esc(x.tool)} · ${x.calls} calls${x.p50Ms === null ? "" : ` · p50 ${x.p50Ms}ms`}">${esc(x.tool)} <b>${x.calls}</b></span>`).join(" ") },
  ];
  const share = t.totalMs ? Math.round((t.mcpMs / t.totalMs) * 100) : 0;
  const sub = `${t.servers} MCP server${t.servers === 1 ? "" : "s"} · ${t.calls.toLocaleString()} call${t.calls === 1 ? "" : "s"} · last 7 days · ${dur(t.mcpMs)} waiting on MCP (${share}% of all tool time)`;
  $("#main").innerHTML = head(sub) +
    dataTable({ id: "mcp-health", columns: cols, rows: h.servers, rerender: touch }) +
    `<p class="dim" style="margin-top:10px;font-size:var(--fs-sm)">Latency is measured hook to hook, so it is the wall-clock an agent actually waited — a call held behind a permission prompt carries that wait too, which is why <b>slowest</b> can be hours and p50/p95 are the numbers to read. <b>errors</b> counts only unambiguous failures: a command that merely prints the word "error" is not one.</p>`;
}

// M9.7: gate flakiness and cost. A gate that flips on the *same task* told you two different
// things about identical work — that is the number worth ranking on, not a raw fail count.
function renderGateHealth() {
  const h = state.gateHealth;
  const head = (sub) => `<h2>Gates <span>${sub}</span></h2>`;
  if (!h) { $("#main").innerHTML = head("flakiness and wall-clock") + `<div class="empty">${PX.clock()}Loading…</div>`; return; }
  if (!h.gates.length) {
    $("#main").innerHTML = head("flakiness and wall-clock") + `<div class="empty">${PX.idle()}No gate runs in the last 30 days${state.sel ? " in this project" : ""}.<br>Gates appear here once <code>swarm_gate_run</code> or a workflow's gate step records one.</div>`;
    return;
  }
  const t = h.totals;
  const secs = (v) => (v === null ? '<span class="dim">—</span>' : v < 1000 ? `${v}ms` : `${(v / 1000).toFixed(1)}s`);
  // Oldest-first strip, matching Recent gates on the Board.
  const strip = (g) => {
    const rs = [...g.history].reverse();
    return `<span class="gh" title="last ${rs.length} run${rs.length === 1 ? "" : "s"}, oldest first">${rs.map((r) => `<i class="${r.verdict === "pass" ? "ok" : "bad"}" title="${esc(r.task)} · ${esc(r.at)}${r.durationMs === null ? "" : ` · ${(r.durationMs / 1000).toFixed(1)}s`}"></i>`).join("")}</span>`;
  };
  const cols = [
    { key: "gate", label: "gate", width: 150, get: (g) => g.gate, cell: (g) => `<b>${esc(g.gate)}</b>${g.flaky ? ' <span class="badge bad" title="This gate returned both a pass and a fail on the same task">Flaky</span>' : ""}` },
    { key: "history", label: "history", width: 150, sortable: false, filterable: false, get: () => null, cell: strip },
    { key: "runs", label: "runs", width: 60, num: true, get: (g) => g.runs, cell: (g) => g.runs },
    { key: "pass", label: "pass rate", width: 84, num: true, get: (g) => g.passRate, cell: (g) => `${Math.round(g.passRate * 100)}%` },
    { key: "flips", label: "flips", width: 64, num: true, get: (g) => g.flips, cell: (g) => (g.flips ? `<b class="bad">${g.flips}</b>` : '<span class="dim">0</span>') },
    { key: "p50", label: "p50", width: 66, num: true, get: (g) => g.p50Ms ?? -1, cell: (g) => secs(g.p50Ms) },
    { key: "p95", label: "p95", width: 66, num: true, get: (g) => g.p95Ms ?? -1, cell: (g) => secs(g.p95Ms) },
    { key: "max", label: "slowest", width: 74, num: true, get: (g) => g.maxMs ?? -1, cell: (g) => secs(g.maxMs) },
    { key: "total", label: "total", width: 74, num: true, get: (g) => g.totalMs, cell: (g) => (g.timedRuns ? dur(g.totalMs) : '<span class="dim">—</span>') },
    { key: "last", label: "last", flex: true, get: (g) => g.lastAt ?? "", cell: (g) => (g.lastAt ? `${g.lastVerdict === "pass" ? '<span class="badge ok">Pass</span>' : '<span class="badge warn">Fail</span>'} <span class="dim">${ago(g.lastAt)}</span>` : '<span class="dim">—</span>') },
  ];
  const sub = `${t.gates} gate${t.gates === 1 ? "" : "s"} · ${t.runs} run${t.runs === 1 ? "" : "s"} · last 30 days${t.flakyGates ? ` · <b class="navcount">${t.flakyGates} flaky</b>` : " · none flaky"}${t.totalMs ? ` · ${dur(t.totalMs)} of wall-clock` : ""}`;
  $("#main").innerHTML = head(sub) +
    dataTable({ id: "gate-health", columns: cols, rows: h.gates, rerender: touch }) +
    `<p class="dim" style="margin-top:10px;font-size:var(--fs-sm)">Flaky = the same gate returned both a pass and a fail on one task. A gate that fails on one task and passes on another is doing its job, and is not counted. Durations cover executed gates only — a gate an agent simply recorded has no wall-clock.</p>`;
}

// M9.8: machine hygiene — what the fleet left behind. Observation plus the two actions that
// already exist (stop a process, remove a worktree); nothing here reclaims anything on its own,
// and a worktree with uncommitted or unpushed work is never offered as safe.
const ISSUE_BADGE = {
  dead: ["bad", "Dead"], orphaned: ["bad", "Orphaned"], hungry: ["warn", "Hungry"],
  stale: ["warn", "Stale"], abandoned: ["warn", "Abandoned"], heavy: ["", "Heavy"],
};
const mb = (kb) => (kb === null || kb === undefined ? '<span class="dim">—</span>' : kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`);
const issueBadge = (i) => { const b = ISSUE_BADGE[i]; return b ? `<span class="badge ${b[0]}">${b[1]}</span>` : '<span class="dim">ok</span>'; };
function renderHygiene() {
  const h = state.hygiene;
  const head = (sub) => `<h2>Hygiene <span>${sub}</span></h2>`;
  if (!h) { $("#main").innerHTML = head("what the fleet left behind") + `<div class="empty">${PX.clock()}Loading…</div>`; return; }
  const t = h.totals;
  if (!h.processes.length && !h.worktrees.length) {
    $("#main").innerHTML = head("what the fleet left behind") + `<div class="empty">${PX.idle()}Nothing tracked${state.sel ? " in this project" : ""}.<br>Processes started through <code>swarm serve</code> / <code>proc</code> and this machine's worktrees appear here.</div>`;
    return;
  }
  const kpi = (l, v, d, cls = "") => `<div class="kpi ${cls}"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
  const badge = (n, label, cls) => (n > 0 ? `<span class="badge ${cls}">${n} ${label}</span>` : "");
  // Disk is sampled in the background, so "0 MB" before the first sweep would be a lie — say so.
  const sampled = h.worktrees.filter((w) => w.diskKb !== null).length;
  const diskPending = h.worktrees.length > 0 && sampled === 0;
  const totalDisk = diskPending ? "measuring…" : mb(t.diskKb);
  const kpis = `<div class="kpis">${
    kpi("Needs a look", t.issues, t.issues ? "processes + worktrees" : "all clean", t.issues ? "hot" : "")
  }${kpi("Processes", t.processes, t.orphanedProcesses || t.deadProcesses ? `${t.orphanedProcesses} orphaned · ${t.deadProcesses} dead` : "all healthy", t.orphanedProcesses || t.deadProcesses ? "hot" : "")
  }${kpi("Worktrees", t.worktrees, t.staleWorktrees ? `${t.staleWorktrees} stale` : "none stale", t.staleWorktrees ? "warm" : "")
  }${kpi("Reclaimable", diskPending ? '<span class="dim">—</span>' : mb(t.reclaimableKb), diskPending ? `measuring ${h.worktrees.length} worktrees…` : `of ${mb(t.diskKb)} on disk`, !diskPending && t.reclaimableKb ? "warm" : "")}</div>`;

  const pcols = [
    { key: "issue", label: "state", width: 96, get: (p) => p.issue ?? "", cell: (p) => issueBadge(p.issue) },
    { key: "name", label: "name", width: 130, get: (p) => p.name, cell: (p) => `<b>${esc(p.name)}</b>` },
    { key: "kind", label: "kind", width: 64, get: (p) => p.kind, cell: (p) => `<span class="br">${esc(p.kind)}</span>` },
    { key: "pid", label: "pid", width: 64, num: true, get: (p) => p.pid, cell: (p) => p.pid },
    { key: "port", label: "port", width: 60, num: true, get: (p) => p.port ?? 0, cell: (p) => p.port ?? '<span class="dim">—</span>' },
    { key: "cpu", label: "cpu", width: 60, num: true, get: (p) => p.cpuPct ?? -1, cell: (p) => (p.cpuPct === null ? '<span class="dim">—</span>' : `${p.cpuPct.toFixed(0)}%`) },
    { key: "rss", label: "memory", width: 78, num: true, get: (p) => p.rssKb ?? -1, cell: (p) => mb(p.rssKb) },
    { key: "note", label: "why", flex: true, get: (p) => p.note ?? "", cell: (p) => (p.note ? `<span class="now" title="${esc(p.note)}">${esc(p.note)}</span>` : '<span class="dim">—</span>') },
    { key: "act", label: "", width: 70, sortable: false, filterable: false, get: () => null, cell: (p) => (p.reclaimable ? `<a href="#" class="mini-act" data-procstop="${esc(String(p.pid))}" data-procproj="${esc(p.projectId)}" title="Stop this process">Stop</a>` : "") },
  ];
  const wcols = [
    { key: "issue", label: "state", width: 106, get: (w) => w.issue ?? "", cell: (w) => issueBadge(w.issue) },
    { key: "branch", label: "branch", width: 190, get: (w) => w.branch ?? w.path, cell: (w) => `<b>${esc(w.branch ?? "(detached)")}</b>${w.main ? ' <span class="badge">main</span>' : ""}` },
    { key: "disk", label: "disk", width: 78, num: true, get: (w) => w.diskKb ?? -1, cell: (w) => mb(w.diskKb) },
    { key: "idle", label: "untouched", width: 88, num: true, get: (w) => w.idleMs ?? -1, cell: (w) => (w.idleMs === null ? '<span class="dim">—</span>' : dur(w.idleMs)) },
    { key: "state2", label: "work", width: 130, get: (w) => w.dirty * 1000 + w.ahead, cell: (w) => `${badge(w.dirty, "Dirty", "warn")}${badge(w.ahead, "Unpushed", "acc")}${w.dirty === 0 && w.ahead <= 0 ? (w.merged ? '<span class="badge ok">Merged</span>' : '<span class="badge">Clean</span>') : ""}` },
    { key: "held", label: "in use", width: 110, get: (w) => w.heldByClaim ?? "", cell: (w) => (w.heldByClaim ? `<span class="br" title="Claimed">${esc(w.heldByClaim)}</span>` : w.liveSessions ? `<span class="badge acc">${w.liveSessions} live</span>` : '<span class="dim">—</span>') },
    { key: "note", label: "why", flex: true, get: (w) => w.note ?? "", cell: (w) => (w.note ? `<span class="now" title="${esc(w.note)}">${esc(w.note)}</span>` : '<span class="dim">—</span>') },
    { key: "act", label: "", width: 80, sortable: false, filterable: false, get: () => null, cell: (w) => (w.reclaimable ? `<a href="#" class="mini-act bad" data-wtrm="${esc(w.projectId)}:${esc(w.path)}" title="Remove this worktree">Remove</a>` : "") },
  ];
  const sub = t.issues ? `<b class="navcount">${t.issues} need${t.issues === 1 ? "s" : ""} a look</b>` : "nothing to clean up";
  $("#main").innerHTML = head(sub) + kpis +
    `<h2 class="mt-sec">Processes <span>${h.processes.length} tracked · started through swarm, never matched by command pattern</span></h2>` +
    (h.processes.length ? dataTable({ id: "hyg-procs", columns: pcols, rows: h.processes, rerender: touch }) : `<div class="empty">${PX.idle()}No tracked processes.</div>`) +
    `<h2 class="mt-sec">Worktrees <span>${h.worktrees.length} on this machine · ${totalDisk}${diskPending ? "" : " on disk"}${sampled && sampled < h.worktrees.length ? ` · ${sampled}/${h.worktrees.length} measured` : ""}</span></h2>` +
    (h.worktrees.length ? dataTable({ id: "hyg-trees", columns: wcols, rows: h.worktrees, rerender: touch }) : `<div class="empty">${PX.idle()}No worktrees.</div>`) +
    `<p class="dim" style="margin-top:10px;font-size:var(--fs-sm)">Only merged worktrees with nothing uncommitted, nothing unpushed and nobody working in them are offered for removal. Anything unmerged is listed but never called safe. Disk is sampled in the background, so sizes fill in a moment after the view opens.</p>`;
}

// M9.12: live file-collision graph — which live sessions touch which files, contested files
// highlighted. Data from /v1/graphs/collisions (fetched by the poll while the view is open).
function renderGraphs() {
  const tab = state.graphTab ?? "collisions";
  const chip = (k, label, n) => `<span class="chip ${tab === k ? "on" : ""}" data-graphtab="${k}">${label}${n ? ` <b>${n}</b>` : ""}</span>`;
  const tabs = `<div class="chips">${chip("collisions", "Collisions", state.collisions?.contested ?? 0)}${chip("lineage", "Lineage", state.lineage?.edges?.length ?? 0)}</div>`;
  const head = (sub) => `<h2>Graphs <span>${sub}</span></h2>${tabs}`;
  if (tab === "lineage") return renderLineage(head);
  const g = state.collisions;
  const title = (s) => s.title ?? s.id.slice(0, 8);
  if (!g || !g.sessions.length) {
    $("#main").innerHTML = head("live file collisions") + `<div class="empty">${PX.idle()}No live sessions${state.sel ? " in this project" : ""}.<br>The collision graph shows who is touching what, the moment two agents run at once.</div>`;
    return;
  }
  if (!g.files.length) {
    $("#main").innerHTML = head(`${g.sessions.length} live session${g.sessions.length === 1 ? "" : "s"}`) + `<div class="empty">${PX.idle()}No file touches recorded yet — the graph fills in as agents read and edit.</div>`;
    return;
  }
  const sessions = g.sessions.map((s) => ({ ...s, label: title(s) }));
  const agents = [...new Set(sessions.map((s) => s.agent))].sort(viz.agentSort);
  const sub = `${sessions.length} live session${sessions.length === 1 ? "" : "s"} · ${g.files.length} file${g.files.length === 1 ? "" : "s"} · ${g.contested ? `<b class="navcount">${g.contested} contested</b>` : "no collisions"}`;
  $("#main").innerHTML = head(sub) +
    `<div class="card" style="padding:14px">${viz.bipartite(sessions, g.files)}</div>
     <div style="margin-top:10px;display:flex;gap:16px;align-items:center">${viz.legend(agents)}<span class="dim" style="font-size:var(--fs-sm)">solid edge = writing · faint edge = reading · <span style="color:var(--bad)">red file</span> = two sessions on it, at least one writing</span></div>`;
}

// M9.13: who started whom, who told whom, who picked up whose work. Every edge is a recorded
// relationship — nothing is inferred from timing.
const EDGE_LEGEND = [
  ["subagent", "spawned a subagent", "var(--acc)", ""],
  ["dispatch", "dispatched a run", "var(--c3,#5a9e6f)", ""],
  ["message", "sent a message", "var(--warn)", "3 3"],
  ["handoff", "handed the task on", "var(--dim)", "6 3"],
];
function renderLineage(head) {
  const g = state.lineage;
  if (!g) { $("#main").innerHTML = head("session lineage") + `<div class="empty">${PX.clock()}Loading…</div>`; return; }
  if (!g.nodes.length) {
    $("#main").innerHTML = head("session lineage") + `<div class="empty">${PX.idle()}No relationships between sessions${state.sel ? " in this project" : ""} in the last 14 days.<br>Edges appear when a session spawns a subagent, dispatches a run, messages another agent, or hands a task on.</div>`;
    return;
  }
  const key = EDGE_LEGEND.filter(([k]) => g.byKind[k]).map(([k, label, color, dash]) =>
    `<span style="display:inline-flex;align-items:center;gap:6px"><svg width="22" height="8" aria-hidden="true"><line x1="0" y1="4" x2="22" y2="4" stroke="${color}" stroke-width="2"${dash ? ` stroke-dasharray="${dash}"` : ""}/></svg><span class="dim" style="font-size:var(--fs-sm)">${label} <b>${g.byKind[k]}</b></span></span>`).join("");
  const sub = `${g.nodes.length} session${g.nodes.length === 1 ? "" : "s"} · ${g.edges.length} link${g.edges.length === 1 ? "" : "s"} · ${g.roots} root${g.roots === 1 ? "" : "s"} · last 14 days${g.truncated ? ` · <b class="navcount" title="The best-connected ${g.nodes.length} are drawn; the rest would be an unreadable column">${g.truncated} not drawn</b>` : ""}`;
  $("#main").innerHTML = head(sub) +
    `<div class="card" style="padding:14px;overflow:auto;max-height:72vh">${viz.dag(g)}</div>
     <div style="margin-top:10px;display:flex;gap:18px;align-items:center;flex-wrap:wrap">${key}
       <span class="dim" style="font-size:var(--fs-sm)">a green pill is a collapsed group — click to open it · ring = outcome · thicker dot = more links · a bowed edge closed a loop</span></div>`;
}

function renderTimeline() {
  loadTimelineDetail();
  const now = Date.now();
  const hours = state.tlHours ?? 12;
  const from = now - hours * 3.6e6, to = now + 0.25 * 3.6e6;
  const rows = state.sessions.filter((s) => (!state.sel || s.projectId === state.sel) && new Date(s.lastSeenAt).getTime() >= from && s.kind !== "subagent");
  const agents = [...new Set(rows.map((s) => s.agent))].sort(viz.agentSort);
  const chip = (h) => `<a href="#" class="nav ${hours === h ? "on" : ""}" data-tl="${h}">${h}h</a>`;
  $("#main").innerHTML =
    `<h2>Timeline <span>${rows.length} sessions · last ${hours}h · ${usd(sumBy(rows, (s) => s.costUsd))}</span><span style="margin-left:auto;display:flex;gap:2px">${[3, 6, 12, 24, 72].map(chip).join("")}</span></h2>
     ${rows.length ? viz.timeline(rows, { from, to, projName, now, detail: tlDetail.key === `${hours}:${state.sel ?? ""}` ? tlDetail.data : null }) : `<div class="empty">${PX.clock()}No sessions in the last ${hours}h.</div>`}
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
// The kind column showed raw hook names — "pretooluse", "subagentstop" — which are long, repeat on
// every row, and say nothing the row does not: a tool row already begins with the tool's name. Short
// labels here buy the transcript back ~70px of width per row; the full name stays in the title.
const EV_LABEL = {
  PreToolUse: "tool", PostToolUse: "result", UserPromptSubmit: "you", Stop: "stop",
  SubagentStart: "sub →", SubagentStop: "sub ←", Notification: "note",
  SessionStart: "start", SessionEnd: "end", PreCompact: "compact",
  assistant: "agent", subagent: "sub",
  // ledger events reach the transcript too, and their dotted type names are the longest of all
  "incident.opened": "rule", "question.asked": "asks", "question.answered": "answer",
  "message.sent": "msg", "gate.recorded": "gate", "session.stuck": "stuck",
  "permission.requested": "perm?", "permission.resolved": "perm",
  "claim.acquired": "claim", "claim.released": "release", "pr.opened": "pr",
};
// Anything unmapped keeps its last dotted segment rather than the whole `a.b` name.
const evLabel = (k) => EV_LABEL[k] ?? String(k).split(".").at(-1) ?? String(k);
const evRow = (i) => `<div class="ev ${i.cls}"><span class="t">${hhmm(i.ts)}</span><span class="k" title="${esc(i.kind)}">${esc(evLabel(i.kind))}</span><span class="m">${esc(i.text)}${i.out ? `<span class="dim"> · ${tok(i.out)} out${i.cost != null ? ` · $${i.cost.toFixed(3)}` : ""}</span>` : ""}</span></div>`;
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
// M7.6: the session's message thread (sent + received) and a compose box. Messages are never an
// interrupt: they ride along as context on the agent's next tool call, so the block says so.
function messageThread(s) {
  const ms = (state.msgs ?? []).filter((m) => m.sessionId === s.id || m.fromSession === s.id).slice().reverse();
  const queued = ms.filter((m) => m.fromSession !== s.id && !m.deliveredAt).length;
  const ended = s.state === "ended";
  const row = (m) => {
    const out = m.fromSession === s.id;
    return `<div class="msg ${out ? "out" : "in"}" title="${esc(m.createdAt)}${m.deliveredAt ? "" : " · not delivered yet"}">
      <span class="msg-f">${out ? `→ ${esc(m.task ?? m.toKind)}` : esc(m.from ?? "?")}${m.deliveredAt ? "" : ' <i class="dim">·queued</i>'}</span>${esc(m.text)}</div>`;
  };
  const hint = ended
    ? `${ic("warning", 12)} Session ended — there is nothing left to deliver to.`
    : queued
      ? `${ic("clock", 12)} <b>${queued} queued</b> · delivered the next time this agent calls a tool.`
      : `${ic("comment-text", 12)} Delivered as context on this agent's next tool call — never an interrupt.`;
  return `<h4>messages${ms.length ? ` <span class="badge">${ms.length}</span>` : ""}</h4>
    ${ms.length ? `<div class="msgs">${ms.map(row).join("")}</div>` : ""}
    <div class="msg-compose">
      <input id="msgText" placeholder="Message this agent…" aria-label="Message this agent" autocomplete="off"${ended ? " disabled" : ""}>
      <button id="msgSend" data-sid="${s.id}" data-pid="${s.projectId}" title="Send (Enter)"${ended ? " disabled" : ""}>${ic("arrow-right", 12)}Send</button>
    </div>
    <p class="msg-hint">${hint}</p>`;
}

// The transcript file, as one copyable row: the directory truncates, the file name always shows.
function transcriptRow(s) {
  if (!s.transcriptPath) return "";
  const p = short(s.transcriptPath);
  const cut = p.lastIndexOf("/");
  return `<h4>transcript</h4><button class="pathrow" data-copy="${esc(s.transcriptPath)}" title="Copy path · ${esc(p)}">${ic("file-text", 12)}<span class="dir">${esc(cut < 0 ? "" : p.slice(0, cut + 1))}</span><b>${esc(cut < 0 ? p : p.slice(cut + 1))}</b>${ic("copy", 12, "cp")}</button>`;
}

// M7.7: questions this session is waiting on a human for
function questionCards(s) {
  const qs = (state.questions ?? []).filter((q) => q.sessionId === s.id);
  if (!qs.length) return "";
  return `<h4>waiting on you</h4>${qs.map((q) => `<div class="perm"><div class="perm-t">${ic("warning", 13)} <b>Question #${q.id}</b>${q.task ? `<span class="dim"> · ${esc(q.task)}</span>` : ""}</div><div class="perm-c">${esc(q.text)}</div><div class="perm-b">${(q.options ?? []).map((o) => `<button class="ok" data-qanswer="${q.id}" data-text="${esc(o)}">${esc(o)}</button>`).join("")}<button data-qanswer="${q.id}">Answer…</button></div></div>`).join("")}`;
}
async function answerQuestion(id, preset) {
  const text = preset ?? prompt(`Answer to question #${id}:`);
  if (!text) return;
  const r = await fetch(`/v1/questions/${id}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, by: "dashboard" }) }).then((x) => x.json());
  if (!r.ok) alert(r.error);
  return refresh();
}
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
  const cp = ev.target.closest("[data-copy]");
  if (cp) { ev.preventDefault(); copy(cp.dataset.copy); cp.classList.add("copied"); setTimeout(() => cp.classList.remove("copied"), 1000); return; }
  const qa = ev.target.closest("[data-qanswer]");
  if (qa) { ev.preventDefault(); return answerQuestion(Number(qa.dataset.qanswer), qa.dataset.text); }
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
  const STAT_ICON = { cost: "coin", model: "robot", turns: "arrows-clockwise", "tool calls": "wrench", output: "chart-bar", processed: "rows", started: "clock", "last seen": "eye", "subagent turns": "tree-structure" };
  const stat = (k, v) => `<div class="stat"><span>${ic(STAT_ICON[k] ?? "list-bullets", 13)}${k}</span><b>${v}</b></div>`;
  const head = `<h2 class="hrow"><a class="back" href="#" id="back">${ic("arrow-left", 13)}back</a> ${esc(projName(s.projectId))} · <span class="s ${s.state}"></span> ${kindIcon(s)}${agentBadge(s.agent)}<b>${esc(s.title ?? s.id.slice(0, 8))}</b> <span>${esc(short(s.cwd))}${s.branch ? ` · ${esc(s.branch)}` : ""} · ${s.state}</span><a href="#" class="nav" id="replay" style="margin-left:auto" title="Step through this session's tool calls">${ic("play", 13)} Replay</a>${(state.worktrees[s.projectId] ?? []).some((w) => !w.main && (s.cwd === w.path || s.cwd.startsWith(`${w.path}/`))) ? `<a href="#" class="nav" id="sessDiff" title="What this session's worktree changed">${ic("folders", 13)} Diff</a>` : ""}${s.state === "ended" ? `<a href="#" class="nav" id="resumeDead" title="Spawn a run that picks up this session's task from its handoff + last actions">${ic("arrows-clockwise", 13)} Resume where it died</a>` : ""}</h2>`;
  const side = `<div class="stats">
    ${stat("cost", usd(s.costUsd))}${stat("model", esc(model(s.model)) || "—")}${stat("turns", s.turns)}${stat("tool calls", s.toolCalls)}
    ${stat("output", `${tok(t.output)}${t.thinking ? `<small> · ${tok(t.thinking)} thinking</small>` : ""}`)}${stat("processed", `${tok(ctx)}<small> · ${ctx ? ((100 * t.cacheRead) / ctx).toFixed(0) : 0}% cached</small>`)}
    ${stat("started", `${ago(s.startedAt)} ago`)}${stat("last seen", `${ago(s.lastSeenAt)} ago`)}
    ${subTurns.length ? stat("subagent turns", subTurns.length) : ""}
    </div>
    <h4>tokens</h4>${viz.compositionBar([{ label: "cache read", v: t.cacheRead }, { label: "cache write", v: t.cacheWrite }, { label: "input", v: t.input }, { label: "thinking", v: t.thinking }, { label: "output", v: t.output }])}
    ${state.turns.length > 1 ? `<h4>cost per turn</h4>${viz.turnStrip(state.turns, { height: 54 })}` : ""}
    <h4>tools</h4>${tools.length ? viz.hbars(tools.slice(0, 8).map(([k, v]) => [k.replace(/^mcp__[a-z0-9-]+__/i, ""), v])) : '<span class="dim">None yet</span>'}
    ${messageThread(s)}
    ${questionCards(s)}
    ${transcriptRow(s)}`;
  if (logEl && isAppend(rows)) {
    // Same session, rows only appended: patch header + sidebar, append the new rows — #log keeps its
    // scroll position (and its DOM) untouched.
    $("#main > h2").outerHTML = head;
    // The message compose box lives inside .side, and this fast-path runs on every event while the
    // agent works — carry the draft (and the caret) across the swap instead of wiping what is
    // being typed.
    const msg = $("#msgText");
    const draft = msg?.value ? { v: msg.value, focused: document.activeElement === msg, pos: msg.selectionStart } : null;
    $("#main .side").innerHTML = side;
    if (draft) {
      const el = $("#msgText");
      if (el) {
        el.value = draft.v;
        if (draft.focused) { el.focus(); el.setSelectionRange(draft.pos, draft.pos); }
      }
    }
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
// ---------- row actions (shared by the row menus, right-click, and any remaining links)
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
const act = {
  async wtOpen(projectId, worktree) { const r = await post("/v1/worktrees/open", { projectId, worktree }); if (!r.ok) alert(r.error); },
  wtDiff(projectId, worktree) { openDiffDrawer(projectId, worktree); },
  wtPr(projectId, worktree) { openPrDrawer(projectId, worktree); },
  async wtRemove(projectId, worktree) {
    const rm = (force) => post("/v1/worktrees/remove", { projectId, worktree, force });
    if (!confirm(`Remove worktree ${short(worktree)}?`)) return;
    const r = await rm(false);
    if (!r.ok && (r.refused === "dirty" || r.refused === "unpushed")) {
      if (confirm(`${r.error}\n\nRemove anyway (discards the work)?`)) await rm(true);
    } else if (!r.ok) alert(r.error);
    state.worktrees[projectId] = null;
    refresh();
  },
  async claimTask(task) {
    const r = await post("/v1/claims", { projectId: state.sel, task, owner: "dashboard" });
    if (!r.ok) alert(r.error); else state.tasks = null;
    refresh();
  },
  runTask(task) { openRunDrawer(task); },
  async gateRun(task) {
    const r = await post("/v1/gates/run", { projectId: state.sel, task });
    if (!r.started?.length) alert(r.error ?? r.skipped?.[0]?.reason ?? "nothing ran");
    else alert(`${task}: ${r.runs.map((x) => `${x.verdict === "pass" ? "✓" : "✗"} ${x.gate} — ${x.rubric}`).join("\n")}${r.skipped.length ? `\n\nskipped: ${r.skipped.map((x) => `${x.gate} (${x.reason})`).join(", ")}` : ""}`);
    state.tasks = null;
    refresh();
  },
  async releaseClaim(projectId, task, force) {
    if (force && !confirm(`Force-release ${task}? This permanently discards its worktree and any uncommitted work.`)) return;
    const r = await post("/v1/claims/release", { projectId, task, force });
    if (!r.ok && confirm(`${r.error}\n\nForce-release anyway (discards the work)?`)) await post("/v1/claims/release", { projectId, task, force: true });
    refresh();
  },
  async merge(projectId, number) {
    if (!confirm(`Squash-merge #${number}?`)) return;
    const r = await post("/v1/prs/merge", { projectId, number: Number(number) });
    if (r.ok === false || r.error) alert(r.error);
    refresh();
  },
  async procStop(pid, projectId) {
    if (!confirm(`Stop pid ${pid}?`)) return;
    const r = await fetch(`/v1/processes/${pid}?project=${encodeURIComponent(projectId)}`, { method: "DELETE" });
    if (!r.ok) alert((await r.json()).error);
    refresh();
  },
  resRelease(name, projectId) {
    const q = new URLSearchParams({ force: "1" }); if (projectId) q.set("project", projectId);
    return fetch(`/v1/resources/${encodeURIComponent(name)}?${q}`, { method: "DELETE" }).then(refresh);
  },
  ack(seq) { return fetch(`/v1/incidents/${seq}/ack`, { method: "POST" }).then(refresh); },
  codify(seq) { codifyIncident(seq); },
};
/** Hover kebab that opens the row menu `kind`; `attrs` are the data-* the menu needs. */
const more = (kind, attrs, title = "Actions") => `<span class="more" tabindex="0" role="button" data-menu="${kind}" ${attrs} title="${title}">${ic("dots-three", 15)}</span>`;

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
      { label: "Settings…", icon: "sliders", caption: "name · icon · color", run: () => openProjectSettings(p.id) },
      { label: "Copy path", icon: "copy", caption: tail(p.root, 16), run: () => copy(p.root) },
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
      { label: "Working directory", icon: "folder-simple", caption: tail(s.cwd, 16), run: () => copy(s.cwd) },
      ...(s.transcriptPath ? [{ label: "Transcript path", icon: "file-text", run: () => copy(s.transcriptPath) }] : []),
      ...(s.branch ? [{ label: "Branch", icon: "git-branch", caption: tail(s.branch, 16), run: () => copy(s.branch) }] : []),
    ] };
  }
  if (kind === "worktree") {
    const w = (state.worktrees[d.pid] ?? []).find((x) => x.path === d.path);
    if (!w) return null;
    const held = (state.claims ?? []).some((c) => c.state === "held" && c.worktree === w.path);
    const sess = state.sessions.filter((x) => x.state !== "ended" && (x.cwd === w.path || x.cwd.startsWith(`${w.path}/`)));
    return { title: w.branch ?? "(detached)", items: [
      { label: "Open", icon: "arrow-square-out", caption: "editor", run: () => act.wtOpen(d.pid, w.path) },
      ...(w.main ? [] : [{ label: "Diff", icon: "folders", caption: "vs main", run: () => act.wtDiff(d.pid, w.path) }]),
      ...(w.branch && !w.merged && !w.main ? [{ label: "Open PR", icon: "git-pull-request", run: () => act.wtPr(d.pid, w.path) }] : []),
      ...(sess.length ? [{ divider: true }, { section: "Sessions" }, ...sess.map((x) => ({ label: x.title ?? x.id.slice(0, 8), icon: "terminal-window", run: () => openSession(x.id) }))] : []),
      { divider: true },
      { label: "Copy path", icon: "copy", caption: tail(w.path, 14), run: () => copy(w.path) },
      ...(w.branch ? [{ label: "Copy branch", icon: "git-branch", caption: tail(w.branch, 14), run: () => copy(w.branch) }] : []),
      ...(w.main || held ? [] : [{ divider: true }, { label: "Remove", icon: "trash", danger: true, caption: w.dirty > 0 ? "dirty" : w.ahead > 0 ? "unpushed" : undefined, run: () => act.wtRemove(d.pid, w.path) }]),
    ] };
  }
  if (kind === "task") {
    const t = (state.tasks?.tasks ?? []).find((x) => x.id === d.task);
    if (!t) return null;
    const exec = state.gates?.executable ?? [];
    return { title: t.id, items: [
      ...(t.ready ? [
        { label: "Run", icon: "play", caption: "claim + claude -p", run: () => act.runTask(t.id) },
        { label: "Claim", icon: "folders", caption: "fresh worktree", run: () => act.claimTask(t.id) },
      ] : t.claimedBy ? [
        { label: "Run in worktree", icon: "play", run: () => act.runTask(t.id) },
        ...(exec.length ? [{ label: "Run gates", icon: "check", caption: exec.join(", "), run: () => act.gateRun(t.id) }] : []),
      ] : [{ label: t.status === "done" ? "Done" : "Blocked", disabled: true }]),
      { divider: true },
      { label: "Copy id", icon: "copy", caption: t.id, run: () => copy(t.id) },
      { label: "Copy title", icon: "file-text", run: () => copy(`${t.id} — ${t.title}`) },
    ] };
  }
  if (kind === "claim") {
    const c = (state.claims ?? []).find((x) => x.projectId === d.pid && x.task === d.task);
    if (!c) return null;
    const w = (state.worktrees[c.projectId] ?? []).find((x) => x.path === c.worktree);
    return { title: c.task, items: [
      ...(w ? [{ label: "Open worktree", icon: "arrow-square-out", run: () => act.wtOpen(c.projectId, c.worktree) }, { label: "Diff", icon: "folders", run: () => act.wtDiff(c.projectId, c.worktree) }] : []),
      { label: "Copy path", icon: "copy", caption: tail(c.worktree, 14), run: () => copy(c.worktree) },
      { divider: true },
      c.state === "orphaned"
        ? { label: "Force release", icon: "trash", danger: true, caption: "discards work", run: () => act.releaseClaim(c.projectId, c.task, true) }
        : { label: "Release claim", icon: "x", run: () => act.releaseClaim(c.projectId, c.task, false) },
    ] };
  }
  if (kind === "pr") {
    const p = (state.prs ?? []).find((x) => String(x.projectId) === d.pid && String(x.number) === d.num);
    if (!p) return null;
    const green = p.checks !== "fail" && p.mergeable && !p.draft;
    return { title: `#${p.number}`, items: [
      { label: "Open on " + (p.forge === "gitlab" ? "GitLab" : "GitHub"), icon: "arrow-square-out", run: () => openExternal(p.url) },
      { label: "Copy URL", icon: "copy", run: () => copy(p.url) },
      { divider: true },
      { label: "Squash-merge", icon: "git-pull-request", disabled: !green, caption: green ? (p.forge === "gitlab" ? "glab" : "gh") : p.draft ? "draft" : p.checks === "fail" ? "checks failing" : "not mergeable", run: () => act.merge(p.projectId, p.number) },
    ] };
  }
  if (kind === "process") {
    return { items: [
      { label: "Copy pid", icon: "copy", caption: d.pid, run: () => copy(d.pid) },
      ...(d.cwd ? [{ label: "Copy cwd", icon: "folder-simple", caption: tail(d.cwd, 16), run: () => copy(d.cwd) }] : []),
      { divider: true },
      { label: "Stop", icon: "stop", danger: true, caption: "SIGTERM → SIGKILL", run: () => act.procStop(d.pid, d.proj) },
    ] };
  }
  if (kind === "resource") {
    return { title: d.name, items: [
      { label: "Copy name", icon: "copy", run: () => copy(d.name) },
      { divider: true },
      { label: "Release", icon: "x", danger: true, caption: "force", run: () => act.resRelease(d.name, d.proj) },
    ] };
  }
  if (kind === "incident") {
    const i = [...(state.incidents ?? []), ...(state.allIncidents ?? [])].find((x) => String(x.seq) === d.seq);
    if (!i) return null;
    return { items: [
      ...(i.sessionId ? [{ label: "Open session", icon: "terminal-window", run: () => openSession(i.sessionId) }] : []),
      ...(i.suggestion ? [{ label: "Codify", icon: "shield", caption: "rule / lesson", run: () => act.codify(i.seq) }] : []),
      { label: "Copy command", icon: "copy", run: () => copy(i.command ?? "") },
      ...(i.acked ? [] : [{ divider: true }, { label: "Acknowledge", icon: "check", run: () => act.ack(i.seq) }]),
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
      { label: "Documentation", icon: "book-open", caption: "getswarm", run: () => openExternal("https://getswarm.vercel.app/docs/") },
      { label: "Send feedback", icon: "comment-text", caption: "GitHub issue", run: () => openExternal(feedbackUrl()) },
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
  if (!document.hidden && ev.type !== "permission.requested" && ev.type !== "question.asked") return; // only prompts that block an agent interrupt while you're looking
  const now = Date.now();
  if (now - lastNotifyAt < 1500) return; // don't stack
  const p = ev.payload || {};
  let title, body, onClick;
  if (ev.type === "permission.requested") {
    title = `Permission needed: ${p.tool ?? "tool"}`;
    body = `${p.display ?? ""}
${p.reason ?? ""}`.slice(0, 180);
    onClick = () => { if (ev.sessionId) openSession(ev.sessionId); };
  } else if (ev.type === "question.asked") {
    title = "An agent has a question";
    body = `${p.task ? `${p.task}: ` : ""}${p.text ?? ""}`.slice(0, 180);
    onClick = () => { if (ev.sessionId) openSession(ev.sessionId); };
  } else if (ev.type === "session.stuck") {
    title = "Session looks stuck";
    body = (p.reason ?? p.summary ?? "").slice(0, 180);
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
// `strict` matters: the automatic post-upgrade panel must never fall back. Falling back showed
// 0.10.0's notes under a "What's New" triggered by upgrading to 0.11.0 — the notes bundle was a
// stale cached copy that had no 0.11.0 in it, and the fallback quietly hid that.
function releaseNotesFor(version, { strict = false } = {}) {
  const all = window.RELEASE_NOTES || {};
  if (version && all[version]) return { version, ...all[version] };
  if (strict) return null;
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
// M-launch: after an update the running daemon is the old build until it restarts. The daemon
// reports the version on disk; when it differs, offer a one-click restart, then reload.
let updateNudged = false;
setInterval(() => { fetch("/v1/health").then((r) => r.json()).then(maybeUpdateNudge).catch(() => {}); }, 300_000);
function maybeUpdateNudge(h) {
  if (!h?.disk || !h.version || h.disk === h.version || updateNudged) return;
  updateNudged = true;
  const el = document.createElement("div");
  el.className = "nudge";
  el.innerHTML = `${ic("arrows-clockwise", 18, "ic")}<div><b>Swarm ${esc(h.disk)} is installed</b>The daemon is still running ${esc(h.version)} — restart it to switch. Sessions and history are unaffected.
    <div class="row"><button class="pri" id="updRestart">${ic("arrows-clockwise", 13)} Restart daemon</button><button id="updLater">Later</button></div></div>`;
  document.body.appendChild(el);
  el.addEventListener("click", async (e) => {
    // closest(), not e.target.id: the button holds an <svg> icon, so a click on the glyph itself
    // targets the svg/path and an id check would miss it.
    const btn = e.target.closest?.("button");
    if (btn?.id === "updLater") return el.remove();
    if (btn?.id !== "updRestart") return;
    btn.textContent = "restarting…";
    await fetch("/v1/daemon/restart", { method: "POST" }).catch(() => {});
    const t0 = Date.now();
    const wait = setInterval(async () => {
      try {
        const j = await (await fetch("/v1/health")).json();
        if (j.version === h.disk) { clearInterval(wait); location.reload(); }
      } catch {}
      if (Date.now() - t0 > 30_000) { clearInterval(wait); el.remove(); }
    }, 800);
  });
}
function maybeWhatsNew() {
  if (!state.version || !window.RELEASE_NOTES) return;
  let seen; try { seen = localStorage.getItem("swarm.seenVersion"); } catch {}
  if (seen === state.version) return;
  if (!seen) { try { localStorage.setItem("swarm.seenVersion", state.version); } catch {} return; }
  if (releaseNotesFor(state.version, { strict: true })) whatsNew(state.version);
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
    if (t.dataset.star === "go") { starSave({ done: now }); openExternal(REPO_URL); }
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
  // Once the menu is up the pointer is over *it*, not the row, so a :hover-only kebab vanishes
  // under its own menu. Mark the row (and the kebab) until menus:openchange reports the close.
  if (anchor?.closest) {
    for (const el of [anchor.closest(".proj"), anchor.closest("tr"), anchor.closest(".more")]) el?.classList.add("menu-open");
  }
  window.menus.open(anchor, spec);
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.id === "msgText") { e.preventDefault(); $("#msgSend")?.click(); }
});
// Enter / Space on a focused card, tile or kebab opens its menu like a click.
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" && ev.key !== " ") return;
  const t = ev.target.closest?.("[data-menu]");
  if (!t || t.tagName === "INPUT") return;
  ev.preventDefault();
  openMenu(t.dataset.menu, t, t.dataset);
});
document.addEventListener("contextmenu", (ev) => {
  const t = ev.target.closest("[data-ctx]");
  if (!t) return;
  ev.preventDefault();
  openMenu(t.dataset.ctx, { x: ev.clientX, y: ev.clientY }, t.dataset);
});

// ---------- events
// Every id / data-attr a branch below matches on MUST be in this selector, or the branch is
// unreachable (closest() returns null and the click dies silently) — that is how Replay,
// Resume-where-it-died and the dry-run Re-run button all shipped dead.
document.addEventListener("click", async (ev) => {
  const t = ev.target.closest("[data-menu],#settings,#feedback,[data-id],[data-s],#back,[data-view],.chip,[data-tl],[data-days],[data-sdays],[data-release],[data-forcerelease],[data-resrelease],[data-merge],[data-ack],[data-ackall],[data-inc],[data-graphtab],[data-group],[data-provpage],#abNew,[data-task-filter],[data-claim],[data-procstop],[data-run],[data-runstop],[data-wtopen],[data-wtrm],[data-wtdiff],[data-wtpr],[data-dffile],#prGo,#sessDiff,#replay,#resumeDead,#drRun,#wtnew,#wtgc,[data-gaterun],[data-codify],[data-wfstop],[data-bmode],[data-emoji],#psAllEmoji,.swatch,#psSave,#msgSend,#dispatch,#dispatchGo,#dispatchClear");
  if (!t) return;
  if (t.dataset.menu) { ev.preventDefault(); ev.stopPropagation(); return openMenu(t.dataset.menu, t, t.dataset); }
  if (t.id === "settings") { ev.preventDefault(); return openMenu("settings", t, {}); }
  if (t.id === "feedback") { ev.preventDefault(); return openExternal(feedbackUrl()); }
  if (t.dataset.view) { ev.preventDefault(); return showView(t.dataset.view); }
  if (t.dataset.tl) { ev.preventDefault(); state.tlHours = Number(t.dataset.tl); return touch(); }
  if (t.dataset.taskFilter) { state.taskFilter = t.dataset.taskFilter; return touch(); }
  if (t.dataset.emoji !== undefined) { $("#psIcon").value = t.dataset.emoji; $("#psImage").value = ""; setIconPreview(t.dataset.emoji); for (const e of $$(".emoji")) e.classList.toggle("on", e.dataset.emoji === t.dataset.emoji); return; }
  if (t.id === "psAllEmoji") { const all = $("#psEmojiAll"); if (all.hidden) { all.innerHTML = buildEmojiGrid(); all.hidden = false; } else all.hidden = true; return; }
  if (t.dataset.color !== undefined && t.classList.contains("swatch")) { for (const e of $$(".swatch")) e.classList.toggle("on", e === t); return; }
  if (t.id === "msgSend") {
    ev.preventDefault();
    const text = $("#msgText")?.value.trim();
    if (!text) return;
    const r = await post("/v1/messages", { projectId: t.dataset.pid, to: t.dataset.sid, text, from: "dashboard" });
    if (!r.ok) return alert(r.error);
    $("#msgText").value = "";
    state.msgs = null;
    return refresh();
  }
  if (t.id === "psSave") { ev.preventDefault(); return saveProjectSettings(t.dataset.pid); }
  if (t.dataset.wfstop !== undefined) {
    ev.preventDefault();
    if (!confirm(`Stop the workflow on ${t.dataset.wfstop}? A live step's run is stopped too.`)) return;
    const r = await post("/v1/workflows/stop", { projectId: state.sel, task: t.dataset.wfstop });
    if (!r.ok) alert(r.error);
    state.workflows = null;
    return refresh();
  }
  if (t.dataset.bmode) { ev.preventDefault(); const [k, v] = t.dataset.bmode.split(":"); localStorage.setItem(`swarm.board.${k}`, v); return touch(); }
  if (t.dataset.run) { ev.preventDefault(); return openRunDrawer(t.dataset.run); }
  if (t.dataset.runstop) {
    ev.preventDefault();
    if (!confirm("Stop this run? Its stdin is closed, then the process is signalled by pid.")) return;
    return fetch(`/v1/runs/${encodeURIComponent(t.dataset.runstop)}`, { method: "DELETE" }).then(async (r) => { if (!r.ok) alert((await r.json()).error); return refresh(); });
  }
  if (t.dataset.claim) { ev.preventDefault(); return act.claimTask(t.dataset.claim); }
  const split = (v) => { const i = v.indexOf(":"); return [v.slice(0, i), v.slice(i + 1)]; };
  if (t.dataset.wtopen) { ev.preventDefault(); return act.wtOpen(...split(t.dataset.wtopen)); }
  if (t.dataset.wtdiff) { ev.preventDefault(); return act.wtDiff(...split(t.dataset.wtdiff)); }
  if (t.dataset.wtpr) { ev.preventDefault(); return act.wtPr(...split(t.dataset.wtpr)); }
  if (t.dataset.dffile !== undefined) { ev.preventDefault(); return loadDiffFile(t.dataset.dffile); }
  if (t.id === "prGo") { ev.preventDefault(); return submitPr(); }
  if (t.id === "sessDiff") {
    ev.preventDefault();
    const s = state.sessions.find((x) => x.id === state.session);
    if (!s) return;
    const w = (state.worktrees[s.projectId] ?? []).find((x) => !x.main && (s.cwd === x.path || s.cwd.startsWith(`${x.path}/`)));
    return w ? openDiffDrawer(s.projectId, w.path) : null;
  }
  if (t.dataset.wtrm) { ev.preventDefault(); return act.wtRemove(...split(t.dataset.wtrm)); }
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
  if (t.id === "dispatch") { ev.preventDefault(); return openDispatchDrawer(); }
  if (t.id === "dispatchGo") { ev.preventDefault(); return submitDispatch(); }
  if (t.id === "dispatchClear") {
    ev.preventDefault();
    await fetch("/v1/dispatch", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: state.sel }) });
    state.dispatch = null;
    return refresh();
  }
  if (t.dataset.gaterun) { ev.preventDefault(); return act.gateRun(t.dataset.gaterun); }
  if (t.dataset.codify) { ev.preventDefault(); return codifyIncident(t.dataset.codify); }
  if (t.id === "dryrun") { ev.preventDefault(); return openDryRun(); }
  if (t.dataset.skind !== undefined) { ev.preventDefault(); srch.kind = t.dataset.skind; return runSearch().then(renderSearch); }
  if (t.id === "drRun") { ev.preventDefault(); return runDryRun(); }
  if (t.id === "abNew") {
    ev.preventDefault();
    if (!state.sel) return;
    const task = prompt("Task id to trial (each arm claims task#model, so each gets its own worktree):");
    if (!task) return;
    const models = prompt("Models to compare, comma separated:", "opus-5, sonnet-5");
    const arms = (models ?? "").split(",").map((m) => m.trim()).filter(Boolean).map((m) => ({ model: m, label: m }));
    if (arms.length < 2) { alert("A trial needs at least two models."); return; }
    const r = await fetch("/v1/ab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: state.sel, task: task.trim(), arms }),
    }).then((x) => x.json()).catch(() => null);
    if (!r) return alert("Could not reach the daemon.");
    if (r?.failed?.length) alert(`Started ${r.started.length}. Could not start: ${r.failed.map((f) => `${f.arm} — ${f.reason}`).join("; ")}`);
    return refresh();
  }
  if (t.dataset.provpage) {
    ev.preventDefault();
    if (t.classList.contains("off")) return;
    state.provOffset = Number(t.dataset.provpage);
    return refresh();
  }
  if (t.dataset.group) {
    ev.preventDefault();
    const open = new Set(state.lineageOpen ?? []);
    open.has(t.dataset.group) ? open.delete(t.dataset.group) : open.add(t.dataset.group);
    state.lineageOpen = [...open];
    return refresh();
  }
  if (t.dataset.graphtab) { state.graphTab = t.dataset.graphtab; localStorage.setItem("swarm.graphTab", state.graphTab); return refresh(); }
  if (t.dataset.inc) { state.incFilter = t.dataset.inc; state.allIncidents = null; return refresh(); }
  if (t.dataset.ack) { ev.preventDefault(); ev.stopPropagation(); return act.ack(t.dataset.ack); }
  if (t.dataset.ackall) {
    return fetch("/v1/incidents/ack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: state.sel || undefined }) }).then(refresh);
  }
  if (t.dataset.days) { ev.preventDefault(); state.spendDays = Number(t.dataset.days); return touch(); }
  if (t.dataset.sdays) { ev.preventDefault(); state.statsDays = Number(t.dataset.sdays); return touch(); }
  if (t.dataset.release || t.dataset.forcerelease) {
    ev.preventDefault();
    const [projectId, task] = (t.dataset.release || t.dataset.forcerelease).split(":");
    return act.releaseClaim(projectId, task, Boolean(t.dataset.forcerelease));
  }
  if (t.dataset.agent !== undefined && t.classList.contains("chip")) { state.agentFilter = t.dataset.agent || null; return touch(); }
  if (t.dataset.merge !== undefined) { ev.preventDefault(); return act.merge(...t.dataset.merge.split(":")); }
  if (t.dataset.procstop) { ev.preventDefault(); return act.procStop(t.dataset.procstop, t.dataset.procproj); }
  if (t.dataset.resrelease !== undefined) { ev.preventDefault(); return act.resRelease(t.dataset.resrelease, t.dataset.resproj); }
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

// ---------- ⌘K palette (M9.1): jump to any view, project or session; falls through to Search.
const pal = { items: [], view: [], q: "", i: 0 };
function palBuild() {
  const items = VIEW_DEFS.map((v) => ({ icon: v.icon, label: v.label, grp: v.group.toLowerCase(), run: () => showView(v.id) }));
  for (const p of state.projects) items.push({ icon: "folder-simple", label: p.name, grp: "project", run: () => { state.sel = p.id; localStorage.setItem("swarm.sel", p.id); state.session = null; state.dirty = true; refresh(); } });
  const pname = (id) => state.projects.find((p) => p.id === id)?.name ?? "";
  for (const s of state.sessions) items.push({ icon: "terminal-window", label: s.title || s.id.slice(0, 8), sub: pname(s.projectId), live: isLive(s), grp: "session", run: () => openSession(s.id) });
  return items;
}
function palFilter() {
  const q = pal.q.trim().toLowerCase();
  const rank = (x) => Math.min(...[x.label, x.sub ?? ""].map((t) => { const i = t.toLowerCase().indexOf(q); return i < 0 ? 1e9 : i; }));
  const out = q
    ? pal.items.map((x) => ({ x, r: rank(x) })).filter((h) => h.r < 1e9).sort((a, b) => a.r - b.r).map((h) => h.x).slice(0, 12)
    : pal.items.filter((x) => x.grp !== "session" || x.live).slice(0, 16); // idle: every view + project + live sessions
  if (q) out.push({ icon: "magnifying-glass", label: `Search Swarm for “${pal.q.trim()}”`, grp: "search", run: () => { srch.q = pal.q.trim(); state.view = "search"; localStorage.setItem("swarm.view", "search"); state.session = null; state.dirty = true; runSearch(); refresh(); } });
  return out;
}
function palRender() {
  pal.view = palFilter();
  if (pal.i >= pal.view.length) pal.i = Math.max(0, pal.view.length - 1);
  const row = (x, i) => `<div class="pk-row pal-row ${i === pal.i ? "on" : ""}" data-pal="${i}">${ic(x.icon, 14)}<span class="nm">${esc(x.label)}${x.sub ? ` <span class="dim">· ${esc(x.sub)}</span>` : ""}</span><span class="grp">${x.grp}</span></div>`;
  const el = $("#palList");
  if (el) el.innerHTML = pal.view.map(row).join("") || '<div class="empty" style="padding:16px">No matches.</div>';
}
function palRun(i) {
  const x = pal.view[i];
  if (!x) return;
  closePicker();
  x.run();
}
function openPalette() {
  pal.items = palBuild(); pal.q = ""; pal.i = 0;
  $("#picker").innerHTML = `<div class="pk pal" role="dialog" aria-modal="true">
    <div class="pk-h">${ic("magnifying-glass", 15)}<input id="palQ" placeholder="Jump to view, project or session…" spellcheck="false" autocomplete="off"></div>
    <div class="pk-list" id="palList"></div>
  </div>`;
  palRender();
  const inp = $("#palQ");
  inp.focus();
  inp.addEventListener("input", () => { pal.q = inp.value; pal.i = 0; palRender(); });
  inp.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); pal.i = Math.max(0, Math.min(pal.view.length - 1, pal.i + (ev.key === "ArrowDown" ? 1 : -1))); palRender(); }
    else if (ev.key === "Enter") { ev.preventDefault(); palRun(pal.i); }
  });
}
$("#palBtn")?.addEventListener("click", openPalette);
document.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") { ev.preventDefault(); if ($("#palQ")) closePicker(); else openPalette(); }
});

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
      <label>profile<select id="rnProfile" title="full: every tool · no-edits: commands but no file edits · read-only: read and search only">${["full", "no-edits", "read-only"].map((m) => opt(m, last.profile ?? "full")).join("")}</select></label>
      <div class="dim" style="font-size:var(--fs-sm)">Claims <b>${esc(taskId)}</b> (or reuses your held worktree) and spawns <code>claude -p</code> there. The session appears in Fleet; steer it from its page.</div>
    </div>
    <div class="pk-f"><span class="grow"></span><button id="rnCancel">Cancel</button><button class="primary" id="rnGo" data-task="${esc(taskId)}">${ic("play", 13)} Run</button></div>
  </div>`;
  $("#rnPrompt")?.focus();
}
async function submitRun(taskId) {
  const prompt = $("#rnPrompt")?.value.trim();
  if (!prompt) return alert("A prompt is required.");
  const mode = $("#rnMode")?.value, model = $("#rnModel")?.value.trim(), turns = $("#rnTurns")?.value, profile = $("#rnProfile")?.value;
  localStorage.setItem("swarm.runOpts", JSON.stringify({ mode, model, turns, profile }));
  closePicker();
  const r = await fetch("/v1/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    projectId: state.sel, task: taskId, prompt, owner: "dashboard", permissionMode: mode, model: model || undefined, maxTurns: turns ? Number(turns) : undefined, profile: profile && profile !== "full" ? profile : undefined,
  }) }).then((x) => x.json());
  if (!r.ok) return alert(r.error);
  state.tasks = null;
  await refresh();
  openSession(r.run.sessionId);
}

// ---------- project settings drawer
const PROJECT_EMOJI = ["🐝", "🚀", "🧪", "📦", "🛠️", "🌐", "📊", "🤖", "🧠", "🎨", "🔒", "📚", "💬", "🏗️", "🧩", "⚡"];
// Every emoji the platform font can draw, by Unicode block — no names, but browseable; the OS picker
// (⌃⌘Space on macOS, Win+. on Windows) covers search. Filtered by the font once, lazily.
const EMOJI_BLOCKS = [["Smileys & people", 0x1f600, 0x1f64f], ["Gestures & body", 0x1f440, 0x1f4ff], ["Animals & nature", 0x1f400, 0x1f43f], ["Food", 0x1f32d, 0x1f37f], ["Activity & travel", 0x1f680, 0x1f6ff], ["Objects", 0x1f4a0, 0x1f4ff], ["Symbols", 0x1f300, 0x1f32c], ["More", 0x1f900, 0x1f9ff], ["Extended", 0x1fa70, 0x1faff], ["Misc", 0x2600, 0x26ff], ["Dingbats", 0x2700, 0x27bf]];
let emojiGrid = null;
// Which code points the platform font actually draws in colour is a per-machine answer, so it is
// probed once and remembered. Two things made that probe cost ~150ms of blocked main thread:
// it called getImageData once per code point (1536 GPU->CPU readbacks), and the blocks overlap,
// so 96 code points were probed — and rendered — twice. Now it is one readback per block over a
// grid of glyphs, deduped, and the answer is cached across reloads.
const EMOJI_CACHE_KEY = "swarm.emoji.v1";
function detectEmoji(a, b) {
  const S = 20, COLS = 32, n = b - a + 1, rows = Math.ceil(n / COLS);
  const cv = document.createElement("canvas");
  cv.width = COLS * S; cv.height = rows * S;
  const c = cv.getContext("2d", { willReadFrequently: true });
  c.font = `${S - 4}px system-ui`; c.textBaseline = "top";
  for (let i = 0; i < n; i++) c.fillText(String.fromCodePoint(a + i), (i % COLS) * S, ((i / COLS) | 0) * S);
  const d = c.getImageData(0, 0, cv.width, cv.height).data, W = cv.width, out = [];
  // A code point counts as an emoji the platform can draw if its cell paints coloured pixels.
  for (let i = 0; i < n; i++) {
    const x0 = (i % COLS) * S, y0 = ((i / COLS) | 0) * S;
    let ok = false;
    for (let y = y0; y < y0 + S && !ok; y++)
      for (let x = x0; x < x0 + S; x++) {
        const p = (y * W + x) * 4;
        if (d[p + 3] > 40 && (Math.abs(d[p] - d[p + 1]) > 24 || Math.abs(d[p + 1] - d[p + 2]) > 24)) { ok = true; break; }
      }
    if (ok) out.push(String.fromCodePoint(a + i));
  }
  return out;
}
function buildEmojiGrid() {
  if (emojiGrid) return emojiGrid;
  // The cache is keyed by the UA (a font change is what would invalidate it) plus the block list.
  const sig = `${navigator.userAgent}|${EMOJI_BLOCKS.map((x) => x.join(":")).join(",")}`;
  let blocks = null;
  try {
    const hit = JSON.parse(localStorage.getItem(EMOJI_CACHE_KEY) ?? "null");
    if (hit?.sig === sig) blocks = hit.blocks;
  } catch { /* corrupt or unavailable cache: probe again */ }
  if (!blocks) {
    const seen = new Set();
    blocks = EMOJI_BLOCKS.map(([, a, b]) => detectEmoji(a, b).filter((e) => !seen.has(e) && seen.add(e)));
    try { localStorage.setItem(EMOJI_CACHE_KEY, JSON.stringify({ sig, blocks })); } catch { /* private mode / quota */ }
  }
  emojiGrid = EMOJI_BLOCKS.map(([name], i) => {
    const list = blocks[i] ?? [];
    return list.length ? `<div class="emoji-sec">${esc(name)}</div><div class="emoji-row">${list.map((e) => `<span class="emoji" data-emoji="${e}">${e}</span>`).join("")}</div>` : "";
  }).join("");
  return emojiGrid;
}
function openProjectSettings(pid) {
  const p = state.projects.find((x) => x.id === pid);
  if (!p) return;
  const slots = ["", "c1", "c2", "c3", "c4", "c5", "c6", "c7"];
  $("#picker").innerHTML = `<div class="pk" role="dialog" aria-modal="true">
    <div class="pk-h">${ic("sliders", 15)}<b>Project settings</b><span class="dim now" style="flex:1;margin-left:8px">${esc(p.root)}</span><button id="pkCancel" title="Close">${ic("x", 14)}</button></div>
    <div class="pk-b">
      <label>name<input id="psName" value="${esc(p.name)}" maxlength="60" spellcheck="false"></label>
      <label>icon<div class="icon-row"><span class="pg pg-lg" id="psPreview">${p.icon ? (p.icon.startsWith("data:image/") ? `<img class="pg-img" src="${esc(p.icon)}" alt="">` : esc(p.icon)) : ic("folder-simple", 16)}</span><input id="psIcon" value="${esc(p.icon?.startsWith("data:image/") ? "" : (p.icon ?? ""))}" maxlength="4" placeholder="emoji or 1–2 letters · ${navigator.platform.startsWith("Mac") ? "⌃⌘Space" : "Win+."} opens the OS emoji picker" spellcheck="false" autocomplete="off"><label class="btn" title="PNG / JPEG / SVG / WebP — downsized to 64px and stored with the project">${ic("file-text", 13)} Image…<input type="file" id="psFile" accept="image/*" hidden></label></div></label>
      <input type="hidden" id="psImage" value="${esc(p.icon?.startsWith("data:image/") ? p.icon : "")}">
      <div class="emoji-row">${PROJECT_EMOJI.map((e) => `<span class="emoji ${p.icon === e ? "on" : ""}" data-emoji="${e}">${e}</span>`).join("")}<span class="emoji ${!p.icon ? "on" : ""}" data-emoji="" title="No icon">${ic("folder-simple", 14)}</span><span class="emoji more-emoji" id="psAllEmoji" title="Browse every emoji">…</span></div>
      <div class="emoji-all" id="psEmojiAll" hidden></div>
      <label>color</label>
      <div class="swatches">${slots.map((c) => `<span class="swatch ${c ? `pg-${c}` : "none"} ${(p.color ?? "") === c ? "on" : ""}" data-color="${c}" title="${c || "none"}"></span>`).join("")}</div>
      <label class="chk"><input type="checkbox" id="psPinned" ${p.discovered ? "" : "checked"}> pinned — always in the sidebar, drag to reorder</label>
    </div>
    <div class="pk-f"><span class="grow"></span><button id="pkCancel">Cancel</button><button class="primary" id="psSave" data-pid="${esc(p.id)}">Save</button></div>
  </div>`;
  $("#psName").focus();
}
/** Downsize an image file to a square 64px PNG data URL (center-cropped). */
function fileToIconDataUrl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      // square: center-crop the shorter side (cover), never letterbox
      const S = 64, cv = document.createElement("canvas"); cv.width = S; cv.height = S;
      const side = Math.min(img.width, img.height), sx = (img.width - side) / 2, sy = (img.height - side) / 2;
      cv.getContext("2d").drawImage(img, sx, sy, side, side, 0, 0, S, S);
      URL.revokeObjectURL(url);
      resolve(cv.toDataURL("image/png"));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("not an image the browser can decode")); };
    img.src = url;
  });
}
function setIconPreview(icon) {
  const el = $("#psPreview");
  if (!el) return;
  el.innerHTML = icon ? (icon.startsWith("data:image/") ? `<img class="pg-img" src="${esc(icon)}" alt="">` : esc(icon)) : ic("folder-simple", 16);
}
async function saveProjectSettings(pid) {
  const body = {
    name: $("#psName").value.trim() || undefined,
    icon: $("#psImage").value || $("#psIcon").value.trim(),
    color: $(".swatch.on")?.dataset.color ?? "",
    pinned: $("#psPinned").checked,
  };
  const r = await fetch(`/v1/projects/${encodeURIComponent(pid)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) return alert((await r.json()).error ?? "could not save");
  closePicker();
  state.dirty = true;
  refresh();
}

// ---------- dispatch drawer (M7.5)
function openDispatchDrawer() {
  const ready = (state.tasks?.tasks ?? []).filter((t) => t.ready);
  const cfg = state.dispatch?.config ?? {};
  const last = (() => { try { return JSON.parse(localStorage.getItem("swarm.runOpts") || "{}"); } catch { return {}; } })();
  const opt = (v, cur) => `<option value="${v}" ${v === cur ? "selected" : ""}>${v || "default"}</option>`;
  $("#picker").innerHTML = `<div class="pk" role="dialog" aria-modal="true">
    <div class="pk-h">${ic("play", 15)}<b>Dispatch</b><span class="dim now" style="flex:1;margin-left:8px">${ready.length} ready task${ready.length === 1 ? "" : "s"}</span></div>
    <div class="pk-b">
      <div class="df-files" style="max-height:30vh">${ready.map((t) => `<label style="display:flex;gap:8px;padding:4px 8px;align-items:center"><input type="checkbox" class="dpTask" value="${esc(t.id)}" checked style="width:auto"><b>${esc(t.id)}</b><span class="pa dim">${esc(t.title)}</span></label>`).join("")}</div>
      <div class="row">
        <label>at a time<input id="dpPar" type="number" min="1" max="16" value="${cfg.max_parallel ?? 2}"></label>
        <label>permission mode<select id="dpMode">${["acceptEdits", "auto", "plan", "dontAsk", "manual", "bypassPermissions"].map((m) => opt(m, cfg.permission_mode ?? last.mode ?? "acceptEdits")).join("")}</select></label>
        <label>max turns<input id="dpTurns" type="number" min="1" placeholder="∞" value="${esc(cfg.max_turns ?? last.turns ?? "")}"></label>
      </div>
      <label>profile<select id="dpProfile">${["full", "no-edits", "read-only"].map((m) => opt(m, cfg.profile ?? "full")).join("")}</select></label>
      <div class="dim" style="font-size:var(--fs-sm)">Each task gets its own claim + worktree and a <code>claude -p</code> run told to work there, run the gates, hand off and open a PR. The rest queue until a slot frees. Swarm derives the outcome from gates and PRs — a task is never flipped done by an agent.</div>
    </div>
    <div class="pk-f"><span class="grow"></span><button id="pkClose">Cancel</button><button class="primary" id="dispatchGo">${ic("play", 13)} Dispatch</button></div>
  </div>`;
  $("#pkClose")?.addEventListener("click", closePicker);
}
async function submitDispatch() {
  const tasks = [...document.querySelectorAll(".dpTask:checked")].map((i) => i.value);
  if (!tasks.length) return alert("Pick at least one task.");
  const prof = $("#dpProfile")?.value;
  const body = { projectId: state.sel, tasks, maxParallel: Number($("#dpPar")?.value) || undefined, permissionMode: $("#dpMode")?.value, maxTurns: Number($("#dpTurns")?.value) || undefined, profile: prof && prof !== "full" ? prof : undefined, owner: "dashboard" };
  closePicker();
  const r = await fetch("/v1/dispatch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
  if (!r.ok) return alert(r.error);
  if (r.rejected?.length) alert(`Not dispatched:\n${r.rejected.map((x) => `${x.id} — ${x.reason}`).join("\n")}`);
  state.tasks = null; state.dispatch = null;
  return refresh();
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
  if (r.url) openExternal(r.url);
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
  const pr = ev.target.closest("[data-pal]");
  if (pr) return palRun(Number(pr.dataset.pal));
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
  const es = new EventSource(`/v1/events?since=${state.seq}${TOKEN ? `&token=${TOKEN}` : ""}`);
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
  for (const t of ["session.started", "session.ended", "prompt.submitted", "tool.requested", "tool.completed", "subagent.started", "subagent.stopped", "agent.text", "session.notification", "incident.opened", "claim.acquired", "claim.released", "resource.acquired", "resource.released", "resource.reaped", "process.started", "process.exited", "gate.recorded", "claim.orphaned", "claim.renewed", "worktree.bootstrapped", "worktree.created", "worktree.removed", "pr.opened", "question.asked", "question.answered", "message.sent", "dispatch.queued", "dispatch.started", "dispatch.finished", "workflow.started", "workflow.step", "workflow.finished", "permission.requested", "permission.resolved", "session.stuck"]) es.addEventListener(t, onAny);
}
refresh().then(() => {
  const sid = new URLSearchParams(location.search).get("session");
  if (sid) openSession(sid);
  connect();
});
setInterval(() => { if (!document.hidden) poll(); }, 5000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
