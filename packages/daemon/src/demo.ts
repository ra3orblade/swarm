/**
 * Demo seed (0.9 launch polish): fill an *empty* Swarm home with a believable afternoon of agent
 * work so the dashboard has something to show before any real session exists. Only ever used with
 * a dedicated demo home (`swarm demo` → ~/.swarm/demo); never touches real data. Everything here
 * goes through the same Store writes as production code — no special read paths in the UI.
 */
import type { Store } from "./store";

const H = 3_600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

export function isEmpty(store: Store): boolean {
  return !(store.db.query("SELECT 1 FROM sessions LIMIT 1").get() as unknown);
}

export function seedDemo(store: Store): void {
  const db = store.db;
  const project = (id: string, name: string, root: string, icon: string, color: string) =>
    db
      .query(
        "INSERT OR IGNORE INTO projects (id, root, common_dir, name, discovered, created_at, icon, color) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
      )
      .run(id, root, `${root}/.git`, name, iso(90 * 24 * H), icon, color);
  project("p_demo1", "acme-app", "/work/acme-app", "🛒", "c3");
  project("p_demo2", "acme-site", "/work/acme-site", "🌐", "c5");

  const session = (
    id: string,
    pid: string,
    agent: string,
    title: string,
    cwd: string,
    branch: string,
    startedAgo: number,
    lastAgo: number,
    state: string,
    model: string,
  ) => {
    db.query(
      `INSERT OR IGNORE INTO sessions (id, project_id, kind, agent, cwd, branch, title, model, started_at, last_seen_at, last, last_type, last_text, state, tool_calls)
       VALUES (?, ?, 'interactive', ?, ?, ?, ?, ?, ?, ?, ?, 'tool.completed', ?, ?, ?)`,
    ).run(
      id,
      pid,
      agent,
      cwd,
      branch,
      title,
      model,
      iso(startedAgo),
      iso(lastAgo),
      state === "active" ? "Bash bun test" : "session ended",
      state === "active"
        ? "Running the suite before handing off."
        : "Done — PR opened, gates green.",
      state,
      40 + Math.floor(Math.random() * 200),
    );
    let t = startedAgo;
    let i = 0;
    while (t > lastAgo) {
      const out = 300 + Math.floor(Math.random() * 4000);
      const read = 50_000 + Math.floor(Math.random() * 900_000);
      db.query(
        `INSERT OR IGNORE INTO turns (id, session_id, agent_id, ts, model, effort, sidechain, input, output, cache_write, cache_write_1h, cache_read, thinking, cost_usd, text, tools)
         VALUES (?, ?, NULL, ?, ?, NULL, 0, ?, ?, ?, 0, ?, ?, ?, ?, '["Bash","Edit"]')`,
      ).run(
        `${id}-t${i}`,
        id,
        iso(t),
        model,
        800 + ((i * 97) % 2000),
        out,
        12_000,
        read,
        i % 3 === 0 ? 900 : 0,
        0.02 + (out / 1e6) * 15 + (read / 1e6) * 0.3,
        i % 4 === 0 ? "Tests are green; tightening the error path next." : "",
      );
      t -= (8 + ((i * 13) % 30)) * 60_000; // 8–38 min between turns → visible idle gaps
      i++;
    }
  };
  session(
    "demo-s1",
    "p_demo1",
    "claude-code",
    "Checkout flow refactor",
    "/work/acme-app-wt/checkout",
    "task/checkout",
    5 * H,
    2 * 60_000,
    "active",
    "claude-fable-5",
  );
  session(
    "demo-s2",
    "p_demo1",
    "codex",
    "Fix flaky cart tests",
    "/work/acme-app",
    "main",
    7 * H,
    3 * H,
    "ended",
    "gpt-5.2-codex",
  );
  session(
    "demo-s3",
    "p_demo1",
    "gemini",
    "Payment webhook audit",
    "/work/acme-app",
    "main",
    26 * H,
    22 * H,
    "ended",
    "gemini-2.5-pro",
  );
  session(
    "demo-s4",
    "p_demo2",
    "grok",
    "Landing page rewrite",
    "/work/acme-site",
    "task/landing",
    30 * H,
    25 * H,
    "ended",
    "grok-4",
  );
  session(
    "demo-s5",
    "p_demo2",
    "claude-code",
    "SEO metadata sweep",
    "/work/acme-site",
    "main",
    50 * H,
    47 * H,
    "ended",
    "claude-sonnet-5",
  );

  db.query(
    `INSERT OR IGNORE INTO claims (project_id, task, owner, worktree, branch, acquired_at, expires_at, released_at, state, actor_kind, actor_id)
     VALUES ('p_demo1', 'checkout', 'demo-s1', '/work/acme-app-wt/checkout', 'task/checkout', ?, ?, NULL, 'held', 'agent', 'demo-s1')`,
  ).run(iso(5 * H), iso(-30 * 60_000));
  db.query(
    `INSERT OR IGNORE INTO claims (project_id, task, owner, worktree, branch, acquired_at, expires_at, released_at, state, actor_kind, actor_id)
     VALUES ('p_demo1', 'webhooks', 'alice', '/work/acme-app-wt/webhooks', 'task/webhooks', ?, ?, NULL, 'orphaned', 'human', 'alice')`,
  ).run(iso(26 * H), iso(20 * H));

  const gate = (
    task: string,
    gate: string,
    verdict: string,
    rubric: string,
    ago: number,
    sid: string | null,
  ) =>
    db
      .query(
        `INSERT OR IGNORE INTO gates (project_id, task, gate, verdict, rubric, evidence, session_id, created_at, actor_kind, actor_id)
       VALUES ('p_demo1', ?, ?, ?, ?, NULL, ?, ?, 'daemon', 'daemon')`,
      )
      .run(task, gate, verdict, rubric, sid, iso(ago));
  gate("checkout", "tests", "fail", "ran `bun test` — exit 1 in 41s", 3 * H, "demo-s1");
  gate("checkout", "tests", "pass", "ran `bun test` — exit 0 in 39s", 1 * H, "demo-s1");
  gate("checkout", "review", "pass", "review: no blocker/major findings", 40 * 60_000, null);
  gate("webhooks", "tests", "pass", "ran `bun test` — exit 0 in 22s", 22 * H, "demo-s3");

  const ev = (type: string, ago: number, sid: string | null, payload: Record<string, unknown>) =>
    store.append({
      ts: iso(ago),
      type: type as never,
      projectId: "p_demo1",
      sessionId: sid,
      payload,
    });
  ev("incident.opened", 4 * H, "demo-s1", {
    rule: "pattern_kill",
    action: "ask",
    command: "pkill -f vite",
    reason: "This kills processes by command pattern — other agents' dev servers match too.",
  });
  ev("incident.opened", 26 * H, "demo-s3", {
    rule: "shared_tree",
    action: "deny",
    command: "git reset --hard",
    reason: "Another session (demo-s2) is active in this same checkout.",
  });
  ev("claim.acquired", 5 * H, "demo-s1", {
    task: "checkout",
    owner: "demo-s1",
    summary: "claim checkout",
  });
  ev("pr.opened", 30 * 60_000, "demo-s1", {
    task: "checkout",
    url: "https://github.com/acme/app/pull/128",
    summary: "PR #128 opened for checkout",
  });
  ev("question.asked", 20 * 60_000, "demo-s1", {
    id: 1,
    task: "checkout",
    text: "Coupon codes: keep the legacy endpoint alive for one release, or cut over now?",
    options: ["Keep one release", "Cut over"],
    summary: "question #1",
  });
  db.query(
    `INSERT OR IGNORE INTO messages (project_id, session_id, task, kind, text, options, asked_by, created_at)
     VALUES ('p_demo1', 'demo-s1', 'checkout', 'question', 'Coupon codes: keep the legacy endpoint alive for one release, or cut over now?', '["Keep one release","Cut over"]', 'demo-s1', ?)`,
  ).run(iso(20 * 60_000));
  db.query(
    `INSERT OR IGNORE INTO messages (project_id, session_id, task, kind, text, asked_by, created_at, to_kind, from_session)
     VALUES ('p_demo1', 'demo-s1', 'checkout', 'message', 'Cart tests are green again — rebasing on main is safe now.', 'agent demo-s2', ?, 'task', 'demo-s2')`,
  ).run(iso(50 * 60_000));
  db.query(
    `INSERT OR IGNORE INTO handoffs (project_id, task, done, remaining, files, verify, by, session_id, created_at, actor_kind, actor_id)
     VALUES ('p_demo1', 'webhooks', 'Signature validation + retries done', 'Dead-letter queue wiring', '["src/webhooks.ts","src/queue.ts"]', 'bun test — 118 pass', 'auto:demo-s3', 'demo-s3', ?, 'daemon', 'daemon')`,
  ).run(iso(22 * H));
  db.query(
    `INSERT OR IGNORE INTO workflow_runs (project_id, task, workflow, step, step_label, steps, state, detail, started_at, updated_at, ended_at, actor_kind, actor_id)
     VALUES ('p_demo1', 'checkout', 'ship', 2, 'gate:review', '["implement","gate:tests","gate:review","pr"]', 'running', NULL, ?, ?, NULL, 'human', 'demo')`,
  ).run(iso(2 * H), iso(10 * 60_000));
}
