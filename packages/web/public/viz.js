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
const attr = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Legend: swatch + label per series, in fixed order. */
function legend(keys, name = agentName, color = agentColor) {
  return `<div class="legend">${keys.map((k) => `<span><i style="background:${color(k)}"></i>${attr(name(k))}</span>`).join("")}</div>`;
}

/**
 * Stacked column chart. days: ["2026-08-07", …]; series: { key: number[] } aligned to days.
 * Thin columns, 2px surface gaps between segments, baseline, hover tooltip per column.
 */
function stackedColumns(days, series, { height = 150, fmt = fmtUsd } = {}) {
  const keys = Object.keys(series).sort(agentSort);
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
        return `<path d="${roundTop(x, y1, bw, h, top)}" fill="${agentColor(k)}"/>`;
      })
      .join("");
    const tip = `<b>${d}</b><br>${keys.filter((k) => series[k][i]).map((k) => `<i style="background:${agentColor(k)}"></i>${agentName(k)} ${fmt(series[k][i])}`).join("<br>")}<br><span>total ${fmt(totals[i])}</span>`;
    const lbl = n <= 16 || i % Math.ceil(n / 16) === 0 ? `<text x="${x + bw / 2}" y="${H - 4}" class="ax mid">${d.slice(5)}</text>` : "";
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
  const lg = parts.filter((p) => p.v).map((p, i) => `<span><i style="background:${steps[parts.indexOf(p)] ?? steps.at(-1)}"></i>${attr(p.label)} <em>${((100 * p.v) / total).toFixed(0)}%</em></span>`).join("");
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
function turnStrip(turns, { height = 64 } = {}) {
  const pts = turns.filter((t) => !t.sidechain && !t.agentId);
  if (!pts.length) return "";
  const vals = pts.map((t) => t.costUsd ?? 0);
  const max = Math.max(1e-9, ...vals);
  const W = 1000, H = height, n = pts.length, slot = W / n, bw = Math.max(1.5, Math.min(10, slot * 0.7));
  const bars = pts
    .map((t, i) => {
      const h = ((t.costUsd ?? 0) / max) * (H - 8);
      const x = i * slot + (slot - bw) / 2;
      const tip = `<b>turn ${i + 1}</b> · ${new Date(t.ts).toTimeString().slice(0, 5)}<br>${fmtUsd(t.costUsd)} · ${fmtTok(t.output)} out${t.thinking ? ` · ${fmtTok(t.thinking)} thinking` : ""}<br><span>${attr(t.model ?? "")}</span>`;
      return `<g data-tip="${attr(tip)}"><rect x="${i * slot}" y="0" width="${slot}" height="${H}" fill="transparent"/><path d="${roundTop(x, H - 2 - h, bw, h, 2)}" fill="var(--acc)"/></g>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart" style="height:${H}px"><line x1="0" x2="${W}" y1="${H - 2}" y2="${H - 2}" class="base"/>${bars}</svg>`;
}

/**
 * Session lanes over a time window. sessions: [{id,title,agent,projectId,startedAt,lastSeenAt,state,costUsd}]
 * One row per session, grouped by project; bar from start to last-seen, coloured by agent.
 */
function timeline(sessions, { from, to, projName, now = Date.now() } = {}) {
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
        const tip = `<b>${attr(s.title ?? s.id.slice(0, 8))}</b><br><i style="background:${agentColor(s.agent)}"></i>${agentName(s.agent)} · ${s.state}<br>${new Date(s.startedAt).toTimeString().slice(0, 5)} → ${new Date(s.lastSeenAt).toTimeString().slice(0, 5)} · ${fmtUsd(s.costUsd)} · ${s.turns} turns`;
        return `<div class="tl-row" data-s="${s.id}"><span class="tl-name">${attr(s.title ?? s.id.slice(0, 8))}</span><span class="tl-track">${gridLines}<i data-tip="${attr(tip)}" class="${live ? "live" : ""}" style="left:${x(a)}%;width:${Math.max(0.4, x(b) - x(a))}%;background:${agentColor(s.agent)}"></i></span></div>`;
      })
      .join("");
    return `<div class="tl-group"><div class="tl-proj">${attr(projName(pid))}<small>${list.length}</small></div>${rows}</div>`;
  });
  return `<div class="tl"><div class="tl-row head"><span class="tl-name"></span><span class="tl-track">${axis}${nowLine}</span></div>${groups.join("")}</div>`;
}

// ---- helpers
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
  let cur = null;
  document.addEventListener("mousemove", (e) => {
    const el = e.target.closest?.("[data-tip]");
    if (el !== cur) {
      cur = el;
      if (el) { tip.innerHTML = el.dataset.tip; tip.style.display = "block"; } else tip.style.display = "none";
    }
    if (el) {
      const r = tip.getBoundingClientRect();
      const left = Math.min(window.innerWidth - r.width - 8, e.clientX + 14);
      const top = e.clientY + 16 + r.height > window.innerHeight ? e.clientY - r.height - 8 : e.clientY + 16;
      tip.style.transform = `translate(${left}px,${top}px)`;
    }
  });
})();

window.viz = { stackedColumns, heatmap, sparkline, compositionBar, hbars, turnStrip, timeline, legend, agentColor, agentName, AGENT_ORDER, agentSort };
