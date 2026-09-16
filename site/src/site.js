/**
 * The landing page's behaviour — one module, one concern per function, assembled into
 * site/site.js by tools/build-site.ts.
 *
 * The three constants below are filled in at build time — the install command from the npm
 * package name, the two rule messages from core/src/rules.ts. Nothing here is a second copy
 * of a string that lives somewhere else. (Their placeholders are not spelled out in this
 * comment, because the build would substitute them here too.)
 */
const INSTALL = "{{INSTALL}}";
const RULE_SHARED_TREE = "{{RULE_SHARED_TREE}}";
const RULE_NO_VERIFY = "{{RULE_NO_VERIFY}}";

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Both install boxes copy the same command and say so for a moment. */
function copyBoxes() {
  for (const el of document.querySelectorAll(".install")) {
    el.addEventListener("click", () => {
      navigator.clipboard?.writeText(INSTALL);
      const label = el.querySelector(".copy");
      if (!label) return;
      label.textContent = "Copied";
      el.classList.add("done");
      setTimeout(() => {
        label.textContent = "Copy";
        el.classList.remove("done");
      }, 1400);
    });
  }
}

/**
 * Latest release + download counters come from /api/releases — one cached call instead of
 * three cross-origin ones, so a visit costs GitHub nothing and never hits the 60/hr
 * unauthenticated limit. If the function is unavailable (a plain static preview), fall back
 * to the GitHub API so the Downloads section still fills in.
 */
function downloads() {
  const os = /Mac/i.test(navigator.platform)
    ? "mac"
    : /Win/i.test(navigator.platform)
      ? "win"
      : /Linux/i.test(navigator.platform)
        ? "linux"
        : null;
  if (os) document.querySelector(`.dl .row[data-os="${os}"]`)?.classList.add("mine");

  const fmt = (n) =>
    n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
  const mb = (b) => `${(b / 1048576).toFixed(0)} MB`;
  const ext = (n) => n.match(/(\.[a-z0-9]+)$/i)?.[1] ?? n;
  const BUCKETS = { mac: [/\.dmg$/], win: [/-setup\.exe$/, /\.msi$/], linux: [/\.AppImage$/, /\.deb$/, /\.rpm$/] };
  const NAMES = { mac: "macOS", win: "Windows", linux: "Linux" };

  const fromGitHub = () =>
    fetch("https://api.github.com/repos/ra3orblade/swarm/releases/latest")
      .then((r) => r.json())
      .then((rel) => ({
        tag: rel.tag_name,
        published_at: rel.published_at,
        assets: (rel.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
        downloads: { github: 0, npm: 0 },
      }));

  fetch("/api/releases")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`api/releases ${r.status}`))))
    .catch(fromGitHub)
    .then((rel) => {
      if (!rel?.assets?.length) return;
      const gh = rel.downloads?.github ?? 0;
      const npm = rel.downloads?.npm ?? 0;
      const count = gh + npm ? ` · ${fmt(gh + npm)} downloads${npm ? ` (${fmt(npm)} via npm, 30d)` : ""}` : "";
      const when = new Date(rel.published_at).toLocaleDateString();
      document.getElementById("ver").textContent = `${rel.tag} · ${when}${count}`;
      document.getElementById("rel").textContent = ` · ${rel.tag}`;

      let mine = null;
      for (const [key, pats] of Object.entries(BUCKETS)) {
        const links = document.querySelector(`.dl .row[data-os="${key}"] .links`);
        if (!links) continue;
        const found = pats.map((p) => rel.assets.find((a) => p.test(a.name))).filter(Boolean);
        found.forEach((a, i) => {
          const el = document.createElement("a");
          el.className = `pill${key === os && i === 0 ? " primary" : ""}`;
          el.href = a.url;
          el.innerHTML = `${ext(a.name)} <small>${mb(a.size)}</small>`;
          links.appendChild(el);
          if (key === os && i === 0) mine = a.url;
        });
      }
      if (mine && os) {
        const btn = document.getElementById("dlMain");
        btn.href = mine;
        btn.textContent = `Download for ${NAMES[os]}`;
      }
    })
    .catch(() => {});
}

/** The screenshot carousel and its lightbox. */
function gallery() {
  const gal = document.getElementById("gal");
  const track = gal?.querySelector(".track");
  if (!gal || !track) return;
  const figs = [...track.querySelectorAll("figure")];
  const dots = [...gal.querySelectorAll(".dots i")];
  let cur = 0;

  const go = (i, smooth = true) => {
    cur = (i + figs.length) % figs.length;
    track.scrollTo({ left: figs[cur].offsetLeft - track.offsetLeft, behavior: smooth ? "smooth" : "auto" });
  };
  const centre = (f) => f.offsetLeft + f.offsetWidth / 2 - track.offsetLeft;
  const sync = () => {
    const x = track.scrollLeft + track.clientWidth / 2;
    let best = 0;
    figs.forEach((f, i) => {
      if (Math.abs(centre(f) - x) < Math.abs(centre(figs[best]) - x)) best = i;
    });
    cur = best;
    for (const [i, d] of dots.entries()) d.classList.toggle("on", i === cur);
  };
  track.addEventListener("scroll", () => requestAnimationFrame(sync), { passive: true });
  for (const a of gal.querySelectorAll(".arr")) {
    a.addEventListener("click", () => go(cur + Number(a.dataset.dir)));
  }
  for (const d of dots) d.addEventListener("click", () => go(Number(d.dataset.i)));

  const lb = document.getElementById("lb");
  const img = document.getElementById("lbImg");
  const cap = document.getElementById("lbCap");
  let li = 0;
  const show = (i) => {
    li = (i + figs.length) % figs.length;
    const f = figs[li];
    const im = f.querySelector("img");
    img.src = im.dataset.full;
    img.alt = im.alt;
    cap.innerHTML = f.querySelector("figcaption").innerHTML;
    lb.classList.add("open");
    document.body.style.overflow = "hidden";
  };
  const hide = () => {
    lb.classList.remove("open");
    document.body.style.overflow = "";
  };
  for (const [i, f] of figs.entries()) f.addEventListener("click", () => show(i));
  lb.addEventListener("click", (e) => {
    const t = e.target.closest("[data-lb]");
    if (t) {
      e.stopPropagation();
      return t.dataset.lb === "close" ? hide() : show(li + Number(t.dataset.lb));
    }
    if (e.target === lb) hide();
  });
  document.addEventListener("keydown", (e) => {
    if (e.target.closest?.("input,textarea")) return;
    const open = lb.classList.contains("open");
    if (open && e.key === "Escape") return hide();
    if (e.key === "ArrowRight") return open ? show(li + 1) : go(cur + 1);
    if (e.key === "ArrowLeft") return open ? show(li - 1) : go(cur - 1);
  });
  let sx = null;
  lb.addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; }, { passive: true });
  lb.addEventListener("touchend", (e) => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 40) show(li + (dx < 0 ? 1 : -1));
    sx = null;
  });
}

/**
 * Matrix rain. Real rain is a dense character grid with long trails — a few thousand glyph
 * cells a second, which the DOM cannot carry — so it is one canvas and one rAF loop.
 */
function rain() {
  const cv = document.getElementById("rain");
  if (!cv || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const ctx = cv.getContext("2d", { alpha: true });
  // Half-width katakana and digits. Depth is what keeps this from reading as a copy of the
  // film — that grid is deliberately flat and uniform; these columns are not.
  const GLYPHS =
    "ｦｧｨｩｪｫｬｭｮｯｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾝ0123456789";
  const pick = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];
  const CELL = 18; // horizontal pitch only — vertical pitch is per depth
  const HEAD = "#f4ffe0";
  const BODY = "163,230,53";
  const MONO = "ui-monospace,SFMono-Regular,Menlo,monospace";

  let cols = [];
  let order = [];
  let w = 0;
  let h = 0;
  let raf = 0;

  function size() {
    const r = cv.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    w = r.width;
    h = r.height;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textBaseline = "top";
    cols = Array.from({ length: Math.ceil(w / CELL) }, () => {
      // Three depths. Far streams are smaller, dimmer and slower, which breaks up the flat
      // rigid grid the film used and gives the thing some parallax.
      const depth = (Math.random() * 3) | 0;
      return {
        // A column sits dark until its turn comes, which is what puts the gaps in.
        y: -((Math.random() * 60) | 0),
        row: [11, 15, 19][depth], // glyph pitch down the column
        px: [10, 13, 17][depth], // font size
        every: [4, 3, 2][depth] + ((Math.random() * 3) | 0), // frames per glyph
        dim: [0.4, 0.62, 0.9][depth] + Math.random() * 0.1,
        tick: 0,
        last: null,
        on: Math.random() > 0.1,
        rows: 0,
      };
    });
    for (const c of cols) c.rows = Math.ceil(h / c.row);
    // Walk the columns depth by depth so the font is set three times a frame, not fifty.
    order = cols.map((_, i) => i).sort((a, b) => cols[a].px - cols[b].px);
    return true;
  }

  function frame() {
    // Erase a little alpha everywhere: what is left behind each head becomes the trail.
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0,.062)";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";

    let font = "";
    for (const i of order) {
      const c = cols[i];
      if (!c.on || ++c.tick < c.every) continue;
      c.tick = 0;
      const x = i * CELL;
      const f = `${c.px}px ${MONO}`;
      if (f !== font) {
        ctx.font = f;
        font = f;
      }
      // Repaint the previous head in green so only the leading glyph stays bright.
      if (c.last !== null && c.y > 0) {
        ctx.fillStyle = `rgba(${BODY},${c.dim})`;
        ctx.fillText(c.last, x, (c.y - 1) * c.row);
      }
      if (c.y >= 0 && c.y < c.rows) {
        const g = pick();
        ctx.fillStyle = HEAD;
        ctx.fillText(g, x, c.y * c.row);
        c.last = g;
      }
      c.y++;
      if (c.y > c.rows && Math.random() > 0.96) {
        c.y = -((Math.random() * 20) | 0);
        c.last = null;
      }
    }
    raf = requestAnimationFrame(frame);
  }

  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };
  const start = () => {
    if (!raf && size()) raf = requestAnimationFrame(frame);
  };
  // Only run while the hero is actually on screen and the tab is in front.
  new IntersectionObserver(([e]) => (e.isIntersecting && !document.hidden ? start() : stop())).observe(cv.parentElement);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  let t = 0;
  addEventListener("resize", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      stop();
      start();
    }, 150);
  });
}

/** The typed replay of a session, and the four steps beside it. */
function replay() {
  const body = document.getElementById("termBody");
  const sl = document.getElementById("termSl");
  const button = document.getElementById("termReplay");
  if (!body || !sl || !button) return;
  const steps = [...document.querySelectorAll(".demo .step")];
  const side = document.querySelector(".demo .side");
  const calm = matchMedia("(prefers-reduced-motion: reduce)");

  // type: characters typed one by one · line: appears whole after a beat · sl: the footer
  const SCRIPT = [
    { s: 0, type: "u", text: "&gt; <em>tidy up and commit the parser fix</em>", pause: 520 },
    { s: 0, line: "t", text: '● <b>Bash</b>(git add -A &amp;&amp; git commit -m "parser fix")', pause: 420 },
    { s: 1, line: "sw deny", text: `<b>⨯ swarm · shared_tree</b>\n${esc(RULE_SHARED_TREE)}`, pause: 1600 },
    { s: 1, line: "t", text: "● <b>Bash</b>(git add src/parser.ts src/parser.test.ts)", pause: 380 },
    { s: 1, line: "ok", text: "  ✓ 2 files staged", pause: 620 },
    { s: 2, line: "t", text: '● <b>Bash</b>(git commit --no-verify -m "fix: parser drops trailing commas")', pause: 420 },
    { s: 2, line: "sw", text: `<b>✎ swarm · no_verify</b>\n${esc(RULE_NO_VERIFY)}`, pause: 1250 },
    { s: 2, line: "ok", text: "  ✓ pre-commit passed · 1 commit on wt/parser-fix", pause: 700 },
    { s: 3, sl: true, pause: 900 },
  ];
  const FOOT = [
    "<u>Opus 5</u>", "<s>·</s>", "<u>42%</u>", "<s>·</s>", "<u>$1.18</u>",
    "<s>│</s>", "<mark>PARSER-8</mark>", "<s>·</s>", "<u>38m left</u>",
    "<s>·</s>", '<mark class="warn">1 incident</mark>',
  ].join(" ");

  let timer = 0;
  let run = 0;
  const wait = (ms) => new Promise((r) => { timer = setTimeout(r, calm.matches ? Math.min(ms, 220) : ms); });
  const mark = (i) => { for (const [n, el] of steps.entries()) el.classList.toggle("on", n === i); };

  /** Type the visible characters, not the markup: walk the parsed nodes and reveal text. */
  async function typeInto(el, html) {
    el.innerHTML = html;
    const nodes = [];
    const walk = (n) => { for (const c of n.childNodes) c.nodeType === 3 ? nodes.push(c) : walk(c); };
    walk(el);
    const full = nodes.map((n) => n.data);
    for (const n of nodes) n.data = "";
    for (let i = 0; i < nodes.length; i++) {
      for (let c = 0; c <= full[i].length; c++) {
        nodes[i].data = full[i].slice(0, c);
        if (!calm.matches) await new Promise((r) => { timer = setTimeout(r, 16); });
      }
    }
  }

  async function play() {
    const me = ++run;
    clearTimeout(timer);
    body.innerHTML = "";
    sl.innerHTML = "";
    button.hidden = true;
    side.classList.add("running");
    mark(-1);
    for (const step of SCRIPT) {
      if (me !== run) return;
      mark(step.s);
      if (step.sl) {
        sl.innerHTML = FOOT;
      } else {
        const el = document.createElement("span");
        el.className = `ln ${step.type || step.line}`;
        body.append(el);
        if (step.type) await typeInto(el, step.text);
        else el.innerHTML = step.text;
      }
      await wait(step.pause);
      if (me !== run) return;
    }
    const cursor = document.createElement("span");
    cursor.className = "cur";
    body.append(cursor);
    mark(-1);
    side.classList.remove("running");
    button.hidden = false;
  }

  button.addEventListener("click", play);
  // Start it when it first scrolls into view, not on load: a replay nobody saw is wasted.
  const io = new IntersectionObserver(
    ([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      play();
    },
    { threshold: 0.3 },
  );
  io.observe(body);
}

/**
 * The dashboard clips: one <video>, three tabs. The captions come from the same
 * reel/captions.json that tools/reel.ts writes, so the page cannot caption a clip with
 * something it no longer shows.
 */
function clips() {
  const reel = document.getElementById("reel");
  const video = document.getElementById("reelV");
  const caption = document.getElementById("reelC");
  const tablist = reel?.querySelector(".tabs");
  if (!reel || !video || !caption || !tablist) return;
  const tabs = [...reel.querySelectorAll("[data-r]")];

  fetch("/reel/captions.json")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`captions ${r.status}`))))
    .then((captions) => {
      const pick = (name) => {
        for (const t of tabs) t.setAttribute("aria-selected", String(t.dataset.r === name));
        video.poster = `/reel/${name}.jpg`;
        video.innerHTML = `<source src="/reel/${name}.webm" type="video/webm"><source src="/reel/${name}.mp4" type="video/mp4">`;
        caption.textContent = captions[name] ?? "";
        video.load();
        // A rejected play() is normal (data saver, low power mode): the poster stays.
        video.play().catch(() => {});
      };
      for (const t of tabs) t.addEventListener("click", () => pick(t.dataset.r));
      // Arrow keys across a tablist, as the role promises.
      tablist.addEventListener("keydown", (e) => {
        const i = tabs.indexOf(document.activeElement);
        if (i < 0 || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
        e.preventDefault();
        const next = tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
        next.focus();
        pick(next.dataset.r);
      });
    })
    .catch(() => {});

  // Only decode while on screen — preload="none" keeps them off the critical path.
  new IntersectionObserver(
    ([e]) => {
      if (e.isIntersecting) video.play().catch(() => {});
      else video.pause();
    },
    { threshold: 0.25 },
  ).observe(video);
}

copyBoxes();
downloads();
gallery();
rain();
replay();
clips();
