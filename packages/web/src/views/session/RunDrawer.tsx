/**
 * Spawn a run on a task (M3.3, ported in M11.11).
 *
 * The daemon claims the task (or reuses a worktree you already hold) and spawns `claude -p` inside
 * it. The prompt is pre-filled from the task and deliberately editable — the default tells the
 * agent to stay in its worktree and to record a handoff and its gates, which is the difference
 * between a run you can pick up later and one that leaves nothing behind.
 *
 * The options are remembered, because nobody picks a permission mode twice.
 */
import { useState } from "react";
import { send } from "../../api/client";
import { Modal } from "../../components/Modal";
import { icon } from "../../lib/icon";

const PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "plan",
  "dontAsk",
  "manual",
  "bypassPermissions",
] as const;

/** What the spawned agent may reach for. `full` is every tool. */
const PROFILES = ["full", "no-edits", "read-only"] as const;

interface RunOptions {
  mode: string;
  model: string;
  turns: string;
  profile: string;
}

const REMEMBERED = "swarm.runOpts";

function remembered(): RunOptions {
  try {
    const raw = JSON.parse(localStorage.getItem(REMEMBERED) || "{}") as Partial<RunOptions>;
    return {
      mode: raw.mode ?? "acceptEdits",
      model: raw.model ?? "",
      turns: raw.turns ?? "",
      profile: raw.profile ?? "full",
    };
  } catch {
    return { mode: "acceptEdits", model: "", turns: "", profile: "full" };
  }
}

/** What the daemon answers when a run starts. */
interface RunResponse {
  ok: boolean;
  error?: string;
  run?: { id: string; sessionId: string };
}

/** The request body, kept separate so the handler reads as intent rather than as field assembly. */
function runBody(projectId: string, taskId: string, prompt: string, options: RunOptions) {
  return {
    projectId,
    task: taskId,
    prompt: prompt.trim(),
    owner: "dashboard",
    permissionMode: options.mode,
    model: options.model.trim() || undefined,
    maxTurns: options.turns ? Number(options.turns) : undefined,
    // `full` is the default; sending it would pin a profile the daemon would otherwise leave open.
    profile: options.profile === "full" ? undefined : options.profile,
  };
}

/** Ask the daemon to start the run, reducing every way it can fail to one `error` string. */
async function startRun(
  body: ReturnType<typeof runBody>,
): Promise<{ kind: "started"; sessionId: string } | { kind: "failed"; error: string }> {
  try {
    const r = await send<RunResponse>("/v1/runs", "POST", body);
    if (!r.ok || !r.run) return { kind: "failed", error: r.error ?? "the run did not start" };
    return { kind: "started", sessionId: r.run.sessionId };
  } catch (cause) {
    return { kind: "failed", error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export interface RunDrawerProps {
  projectId: string;
  task: { id: string; title?: string };
  onClose: () => void;
  onStarted: (sessionId: string) => void;
}

export function RunDrawer({ projectId, task, onClose, onStarted }: RunDrawerProps) {
  const [options, setOptions] = useState(remembered);
  const [prompt, setPrompt] = useState(
    task.title
      ? `Task ${task.id}: ${task.title}\n\nWork only inside this worktree. When done: commit, push, then call swarm_handoff with what was done and what remains, and record the required gates with swarm_gate_record.`
      : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    if (!prompt.trim()) {
      setError("A prompt is required.");
      return;
    }
    setBusy(true);
    setError(null);
    localStorage.setItem(REMEMBERED, JSON.stringify(options));
    const started = await startRun(runBody(projectId, task.id, prompt, options));
    if (started.kind === "started") {
      onStarted(started.sessionId);
      return;
    }
    setError(started.error);
    setBusy(false);
  };

  const set = (patch: Partial<RunOptions>) => setOptions((o) => ({ ...o, ...patch }));

  return (
    <Modal
      title="Run"
      glyph="play"
      subtitle={task.title ? `${task.id} — ${task.title}` : task.id}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={busy} onClick={() => void start()}>
            {icon("play", 13)} {busy ? "starting…" : "Run"}
          </button>
        </>
      }
    >
      <label>
        prompt
        <textarea
          spellCheck={false}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            // ⌘⏎ / Ctrl+⏎ starts it, the way the rest of the app treats a primary action.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void start();
          }}
        />
      </label>

      <div className="row">
        <label>
          permission mode
          <select value={options.mode} onChange={(e) => set({ mode: e.target.value })}>
            {PERMISSION_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          model
          <input
            placeholder="default"
            value={options.model}
            onChange={(e) => set({ model: e.target.value })}
          />
        </label>
        <label>
          max turns
          <input
            type="number"
            min={1}
            placeholder="∞"
            value={options.turns}
            onChange={(e) => set({ turns: e.target.value })}
          />
        </label>
      </div>

      <label title="full: every tool · no-edits: commands but no file edits · read-only: read and search only">
        profile
        <select value={options.profile} onChange={(e) => set({ profile: e.target.value })}>
          {PROFILES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>

      {error && <div className="pk-err">{error}</div>}

      <div className="dim note">
        Claims <b>{task.id}</b> (or reuses your held worktree) and spawns <code>claude -p</code>{" "}
        there. The session appears in Fleet; steer it from its page.
      </div>
    </Modal>
  );
}
