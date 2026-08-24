// Inline-SVG chart helpers. No dependencies, no build step.
// Colour rules: agents get a fixed categorical slot (never cycled); part-to-whole of one thing
// (token composition) uses one hue stepped light→dark; heatmap is one hue by opacity.

const AGENT_SLOT = { "claude-code": 1, codex: 2, gemini: 3, grok: 4, aider: 5, cline: 6, opencode: 7 };
const agentColor = (a) => `var(--c${AGENT_SLOT[a] ?? 0})`;
const agentName = (a) => ({ "claude-code": "Claude", codex: "Codex", gemini: "Gemini", grok: "Grok", aider: "Aider", cline: "Cline", opencode: "opencode" }[a] ?? a);
const AGENT_ORDER = Object.keys(AGENT_SLOT);
const agentSort = (a, b) => (AGENT_SLOT[a] ?? 99) - (AGENT_SLOT[b] ?? 99);

const fmtUsd = (n) => (n == null ? "—" : `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`);
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n | 0));
const p2 = (n) => (n < 10 ? `0${n}` : String(n));
const hm = (ts) => { const d = new Date(ts); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; }; // cheap "HH:MM" (toTimeString is slow)
const attr = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Legend: swatch + label per series, in fixed order. */
function legend(keys, name = agentName, color = agentColor) {
  return `<div class="legend">${keys.map((k) => `<span><i style="background:${color(k)}"></i>${attr(name(k))}</span>`).join("")}</div>`;
}

/**
 * Stacked column chart. days: ["2026-08-07", …]; series: { key: number[] } aligned to days.
 * Thin columns, 2px surface gaps between segments, baseline, hover tooltip per column.
 */
function stackedColumns(days, series, { height = 150, fmt = fmtUsd, color = agentColor, name = agentName, sort = agentSort, label = (d) => d.slice(5) } = {}) {
  const keys = Object.keys(series).sort(sort);
  const totals = days.map((_, i) => keys.reduce((a, k) => a + (series[k][i] ?? 0), 0));
  const max = Math.max(1e-9, ...totals);
  const W = 1000, H = height, padB = 18, padT = 6, plotH = H - padB - padT;
  const n = days.length, slot = W / n, bw = Math.min(26, slot * 0.6);
  const y = (v) => padT + plotH - (v / max) * plotH;
  const ticks = niceTicks(max, 3);
  const grid = ticks.map((t) => `<line x1="0" x2="${W}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="0" y="${y(t) - 3}" class="ax">${fmt(t)}</text>`).join("");
  const cols = days.map((d, i) => {
    let acc = 0;
    const x = i * slot + (slot - bw) / 2;
    const segs = keys
      .map((k) => {
        const v = series[k][i] ?? 0;
        if (!v) return "";
        const y1 = y(acc + v), y0 = y(acc);
        acc += v;
        const h = Math.max(0, y0 - y1 - (acc - v > 0 ? 2 : 0));
        const top = acc === totals[i] ? 3 : 0; // round only the topmost data-end
        return `<path d="${roundTop(x, y1, bw, h, top)}" fill="${color(k)}"/>`;
      })
      .join("");
    const tip = `<b>${d}</b><br>${keys.filter((k) => series[k][i]).map((k) => `<i style="background:${color(k)}"></i>${name(k)} ${fmt(series[k][i])}`).join("<br>")}${keys.length > 1 ? `<br><span>total ${fmt(totals[i])}</span>` : ""}`;
    const lbl = n <= 16 || i % Math.ceil(n / 16) === 0 ? `<text x="${x + bw / 2}" y="${H - 4}" class="ax mid">${label(d)}</text>` : "";
    return `<g class="col" data-tip="${attr(tip)}"><rect x="${i * slot}" y="0" width="${slot}" height="${H}" fill="transparent"/>${segs}${lbl}</g>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart" style="height:${H}px">${grid}<line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" class="base"/>${cols.join("")}</svg>`;
}

/** Weekday × hour heat grid, one hue by opacity. cells: [{dow, hour, v}] */
function heatmap(cells, { fmt = fmtUsd, label = "cost" } = {}) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const c of cells) grid[c.dow][c.hour] += c.v ?? 0;
  const max = Math.max(1e-9, ...grid.flat());
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const order = [1, 2, 3, 4, 5, 6, 0];
  const cw = 100 / 24;
  const rows = order.map(
    (d, r) =>
      `<div class="hm-lbl">${days[d]}</div><div class="hm-row">${grid[d]
        .map((v, h) => `<i data-tip="<b>${days[d]} ${String(h).padStart(2, "0")}:00</b><br>${label} ${fmt(v)}" style="opacity:${v ? 0.15 + 0.85 * Math.sqrt(v / max) : 0}"></i>`)
        .join("")}</div>`,
  );
  const hours = Array.from({ length: 24 }, (_, h) => (h % 3 === 0 ? `<span style="left:${h * cw}%">${String(h).padStart(2, "0")}</span>` : "")).join("");
  return `<div class="hm">${rows.join("")}<div></div><div class="hm-hours">${hours}</div></div>`;
}

/** Tiny line for a table cell. pts: number[]; 88×20. */
function sparkline(pts, color = "var(--acc)") {
  if (!pts || pts.length < 2) return `<svg viewBox="0 0 88 20" class="spark"></svg>`;
  const max = Math.max(1e-9, ...pts);
  const step = 88 / (pts.length - 1);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)},${(18 - (v / max) * 16).toFixed(1)}`).join("");
  const last = pts[pts.length - 1];
  return `<svg viewBox="0 0 88 20" class="spark" preserveAspectRatio="none"><path d="${d}" stroke="${color}"/><circle cx="88" cy="${(18 - (last / max) * 16).toFixed(1)}" r="2" fill="${color}"/></svg>`;
}

/** Horizontal part-to-whole bar, one hue stepped. parts: [{label, v}] in light→dark order. */
function compositionBar(parts, { fmt = fmtTok } = {}) {
  const total = parts.reduce((a, p) => a + p.v, 0) || 1;
  const steps = ["var(--acc-1)", "var(--acc-2)", "var(--acc-3)", "var(--acc-4)", "var(--acc-5)"];
  const segs = parts
    .map((p, i) => (p.v ? `<i data-tip="<b>${attr(p.label)}</b><br>${fmt(p.v)} · ${((100 * p.v) / total).toFixed(1)}%" style="flex:${p.v};background:${steps[i] ?? steps.at(-1)}"></i>` : ""))
    .join("");
  const lg = parts.filter((p) => p.v).map((p, i) => `<span><i style="background:${steps[parts.indexOf(p)] ?? steps.at(-1)}"></i>${attr(p.label)} <em>${(100 * p.v) / total < 1 ? "<1" : ((100 * p.v) / total).toFixed(0)}%</em></span>`).join("");
  return `<div class="comp">${segs}</div><div class="legend small">${lg}</div>`;
}

/** Horizontal bars for a ranked list (tool mix). rows: [[label, n]] */
function hbars(rows, color = "var(--acc)") {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return `<div class="hbars">${rows
    .map(([k, v]) => `<div class="hb"><span class="k">${attr(k)}</span><span class="t"><i style="width:${(100 * v) / max}%;background:${color}"></i></span><span class="n">${v}</span></div>`)
    .join("")}</div>`;
}

/** Per-turn column strip for a session: cost per turn over time. turns: [{ts, costUsd, output, model}] */
// Memoised on (count, last turn id, height): the session view re-renders on every event, the turns rarely change.
let stripMemo = { key: "", svg: "" };
function turnStrip(turns, { height = 64 } = {}) {
  const key = `${turns.length}|${turns[turns.length - 1]?.id ?? ""}|${turns[turns.length - 1]?.costUsd ?? ""}|${height}`;
  if (stripMemo.key === key) return stripMemo.svg;
  const svg = turnStripRender(turns, height);
  stripMemo = { key, svg };
  return svg;
}
function turnStripRender(turns, height) {
  const pts = turns.filter((t) => !t.sidechain && !t.agentId);
  if (!pts.length) return "";
  const vals = pts.map((t) => t.costUsd ?? 0);
  const max = Math.max(1e-9, ...vals);
  const W = 1000, H = height, n = pts.length, slot = W / n, bw = Math.max(1.5, Math.min(10, slot * 0.7));
  const bars = pts
    .map((t, i) => {
      const h = ((t.costUsd ?? 0) / max) * (H - 8);
      const x = i * slot + (slot - bw) / 2;
      const tip = `<b>turn ${i + 1}</b> · ${hm(t.ts)}<br>${fmtUsd(t.costUsd)} · ${fmtTok(t.output)} out${t.thinking ? ` · ${fmtTok(t.thinking)} thinking` : ""}<br><span>${attr(t.model ?? "")}</span>`;
      return `<g data-tip="${attr(tip)}"><rect x="${i * slot}" y="0" width="${slot}" height="${H}" fill="transparent"/><path d="${roundTop(x, H - 2 - h, bw, h, 2)}" fill="var(--acc)"/></g>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart" style="height:${H}px"><line x1="0" x2="${W}" y1="${H - 2}" y2="${H - 2}" class="base"/>${bars}</svg>`;
}

/**
 * Session lanes over a time window. sessions: [{id,title,agent,projectId,startedAt,lastSeenAt,state,costUsd}]
 * One row per session, grouped by project; bar from start to last-seen, coloured by agent.
 */
function timeline(sessions, { from, to, projName, now = Date.now(), detail = null } = {}) {
  const span = Math.max(1, to - from);
  const x = (t) => Math.min(100, Math.max(0, (100 * (t - from)) / span));
  const byProj = new Map();
  for (const s of sessions) (byProj.get(s.projectId) ?? byProj.set(s.projectId, []).get(s.projectId)).push(s);
  const hours = [];
  for (let t = Math.ceil(from / 3.6e6) * 3.6e6; t <= to; t += 3.6e6) hours.push(t);
  const stepEvery = Math.max(1, Math.round(hours.length / 12));
  const axis = `<div class="tl-axis">${hours.map((t, i) => (i % stepEvery ? "" : `<span style="left:${x(t)}%">${new Date(t).getHours().toString().padStart(2, "0")}:00</span>`)).join("")}</div>`;
  const gridLines = hours.map((t) => `<i style="left:${x(t)}%"></i>`).join("");
  const nowLine = now >= from && now <= to ? `<b class="tl-now" style="left:${x(now)}%"></b>` : "";
  const groups = [...byProj.entries()].map(([pid, list]) => {
    const rows = list
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))
      .map((s) => {
        const a = Math.max(from, new Date(s.startedAt).getTime());
        const b = Math.min(to, new Date(s.lastSeenAt).getTime());
        const live = s.state === "active" || s.state === "waiting";
        const tip = `<b>${attr(s.title ?? s.id.slice(0, 8))}</b><br><i style="background:${agentColor(s.agent)}"></i>${agentName(s.agent)} · ${s.state}<br>${hm(s.startedAt)} → ${hm(s.lastSeenAt)} · ${fmtUsd(s.costUsd)} · ${s.turns} turns`;
        // M5.7: with per-turn timestamps the bar is a faint base + a tick per turn — the blank
        // stretches between ticks are the idle gaps, visible instead of painted over.
        const ts = (detail?.turns?.[s.id] ?? []).filter((t) => t >= a && t <= b);
        const ticks = ts.map((t) => `<u style="left:${x(t)}%;background:${agentColor(s.agent)}"></u>`).join("");
        const barCls = `${live ? "live" : ""}${ts.length ? " thin" : ""}`;
        return `<div class="tl-row" data-s="${s.id}"><span class="tl-name">${attr(s.title ?? s.id.slice(0, 8))}</span><span class="tl-track">${gridLines}<i data-tip="${attr(tip)}" class="${barCls}" style="left:${x(a)}%;width:${Math.max(0.4, x(b) - x(a))}%;background:${agentColor(s.agent)};color:${agentColor(s.agent)}"></i>${ticks}</span></div>`;
      })
      .join("");
    // M5.7: claim & lease overlay — one thin lane per project when any claim overlaps the window
    const spans = (detail?.claims ?? []).filter((c) => c.projectId === pid && new Date(c.expiresAt).getTime() >= from && new Date(c.acquiredAt).getTime() <= to);
    const lane = spans.length
      ? `<div class="tl-row lane"><span class="tl-name dim">claims</span><span class="tl-track">${gridLines}${spans
          .map((c) => {
            const a = Math.max(from, new Date(c.acquiredAt).getTime());
            const b = Math.min(to, new Date(c.expiresAt).getTime());
            const tip = `<b>${attr(c.task)}</b><br>${c.state} · ${attr(c.owner || "?")}<br>lease ${hm(c.acquiredAt)} → ${hm(c.expiresAt)}`;
            return `<i data-tip="${attr(tip)}" class="claim ${c.state}" style="left:${x(a)}%;width:${Math.max(0.4, x(b) - x(a))}%"></i>`;
          })
          .join("")}</span></div>`
      : "";
    return `<div class="tl-group"><div class="tl-proj">${attr(projName(pid))}<small>${list.length}</small></div>${lane}${rows}</div>`;
  });
  return `<div class="tl"><div class="tl-row head"><span class="tl-name"></span><span class="tl-track">${axis}${nowLine}</span></div>${groups.join("")}</div>`;
}

// ---- helpers
/**
 * Single-series line with area fill (cumulative spend). days: string[]; values: number[] aligned.
 * Hover column per point, tooltip shows the value and its delta from the previous point.
 */
function line(days, values, { height = 150, fmt = fmtUsd, color = "var(--acc)", label = (d) => d.slice(5) } = {}) {
  const n = days.length;
  if (!n) return "";
  const max = Math.max(1e-9, ...values);
  const W = 1000, H = height, padB = 18, padT = 6, plotH = H - padB - padT;
  const slot = W / n;
  const x = (i) => i * slot + slot / 2, y = (v) => padT + plotH - (v / max) * plotH;
  const ticks = niceTicks(max, 3);
  const grid = ticks.map((t) => `<line x1="0" x2="${W}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="0" y="${y(t) - 3}" class="ax">${fmt(t)}</text>`).join("");
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = `${d}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
  const hover = days
    .map((day, i) => {
      const delta = i ? values[i] - values[i - 1] : values[0];
      const tip = `<b>${day}</b><br>${fmt(values[i])}<br><span>${delta >= 0 ? "+" : ""}${fmt(delta)} that day</span>`;
      const lbl = n <= 16 || i % Math.ceil(n / 16) === 0 ? `<text x="${x(i)}" y="${H - 4}" class="ax mid">${label(day)}</text>` : "";
      return `<g class="pt" data-tip="${attr(tip)}"><rect x="${i * slot}" y="0" width="${slot}" height="${H}" fill="transparent"/><circle cx="${x(i)}" cy="${y(values[i])}" r="3" fill="${color}"/>${lbl}</g>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart line" style="height:${H}px">${grid}<line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" class="base"/><path d="${area}" fill="${color}" opacity=".12"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>${hover}</svg>`;
}

/**
 * GitHub-style activity calendar: the last `weeks` weeks, one cell per day, one hue by opacity.
 * byDay: { "2026-08-20": number }. Returns markup plus the streak numbers it computed.
 */
function calendar(byDay, { weeks = 52, fmt = fmtUsd, label = "cost", today = new Date() } = {}) {
  const end = new Date(today); end.setHours(0, 0, 0, 0);
  const start = new Date(end); start.setDate(end.getDate() - (weeks * 7 - 1) - end.getDay());
  const iso = localDay;
  const vals = Object.values(byDay).filter((v) => v > 0);
  const max = Math.max(1e-9, ...vals);
  const cols = [], months = [];
  let lastMonth = -1;
  for (let c = 0, d = new Date(start); d <= end; c++) {
    const cells = [];
    for (let r = 0; r < 7 && d <= end; r++, d.setDate(d.getDate() + 1)) {
      if (r === 0 && d.getMonth() !== lastMonth) { lastMonth = d.getMonth(); months.push([c, d.toLocaleString(undefined, { month: "short" })]); }
      const k = iso(d), v = byDay[k] ?? 0;
      cells.push(`<i data-tip="<b>${k}</b><br>${v ? `${label} ${fmt(v)}` : "no activity"}" style="opacity:${v ? 0.18 + 0.82 * Math.sqrt(v / max) : 0}"></i>`);
    }
    cols.push(`<div class="cal-col">${cells.join("")}</div>`);
  }
  const mk = months.filter(([c], i) => i === 0 ? c < cols.length - 2 : true).map(([c, m]) => `<span style="left:${(100 * c) / cols.length}%">${m}</span>`).join("");
  return `<div class="cal"><div class="cal-months">${mk}</div><div class="cal-grid" style="grid-template-columns:repeat(${cols.length},1fr)">${cols.join("")}</div></div>`;
}

/** "YYYY-MM-DD" of a Date in the viewer's local zone (the daemon buckets days in localtime too). */
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Current + longest run of consecutive active days. days: sorted "YYYY-MM-DD" strings with activity. */
function streaks(days, today = new Date()) {
  const set = new Set(days);
  const iso = localDay;
  let longest = 0, run = 0, prev = null;
  for (const d of [...set].sort()) {
    const t = Date.parse(`${d}T00:00:00Z`); // UTC: exact 24h steps, immune to DST
    run = prev != null && t - prev === 86400e3 ? run + 1 : 1;
    prev = t;
    longest = Math.max(longest, run);
  }
  let current = 0;
  const d = new Date(today); d.setHours(0, 0, 0, 0);
  if (!set.has(iso(d))) d.setDate(d.getDate() - 1); // today may not have started yet
  while (set.has(iso(d))) { current++; d.setDate(d.getDate() - 1); }
  return { current, longest };
}

function roundTop(x, y, w, h, r) {
  if (h <= 0) return "";
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function niceTicks(max, n) {
  const raw = max / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const out = [];
  for (let v = step; v <= max; v += step) out.push(v);
  return out;
}

// ---- shared tooltip
(() => {
  const tip = document.createElement("div");
  tip.id = "tip";
  document.body.appendChild(tip);
  let cur = null, rect = null, raf = 0, last = null;
  const place = () => {
    raf = 0;
    if (!cur || !last) return;
    rect ??= tip.getBoundingClientRect(); // measured once per tooltip content, not per mouse move
    const left = Math.min(window.innerWidth - rect.width - 8, last.x + 14);
    const top = last.y + 16 + rect.height > window.innerHeight ? last.y - rect.height - 8 : last.y + 16;
    tip.style.transform = `translate(${left}px,${top}px)`;
  };
  document.addEventListener("mousemove", (e) => {
    const el = e.target.closest?.("[data-tip]");
    if (el !== cur) {
      cur = el;
      rect = null;
      if (el) { tip.innerHTML = el.dataset.tip; tip.style.display = "block"; } else tip.style.display = "none";
    }
    if (el) { last = { x: e.clientX, y: e.clientY }; if (!raf) raf = requestAnimationFrame(place); }
  });
})();

window.viz = { stackedColumns, line, calendar, streaks, localDay, heatmap, sparkline, compositionBar, hbars, turnStrip, timeline, legend, agentColor, agentName, AGENT_ORDER, agentSort };
