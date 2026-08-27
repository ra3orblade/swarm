/**
 * Desktop notifications (M4.7, ported in M11.13).
 *
 * For the things worth walking away from the screen for: a spawned run blocked on a permission, an
 * agent with a question, a claim orphaned with unfinished work. Off until switched on from the
 * settings menu, which is also where the OS permission gets requested.
 *
 * Two backends, because the desktop shell has no web Notification API at all — WKWebView simply
 * does not expose it, so the toggle used to fail on "this browser doesn't support notifications"
 * and then fail to say so. Inside the app we go through Tauri's notification plugin; in a browser,
 * the web API.
 */
import type { SwarmEvent } from "@swarm/core/types";
import "./desktop";

const ENABLED = "swarm.notify";

export function notificationsOn(): boolean {
  try {
    return localStorage.getItem(ENABLED) === "on";
  } catch {
    return false;
  }
}

const tauri = () => window.__TAURI__?.notification ?? null;

/** Which backend is available, or null where neither is. */
export function notifyKind(): "desktop" | "web" | null {
  if (tauri()) return "desktop";
  return "Notification" in window ? "web" : null;
}

async function granted(): Promise<boolean> {
  const plugin = tauri();
  if (plugin) return plugin.isPermissionGranted();
  return "Notification" in window && Notification.permission === "granted";
}

async function request(): Promise<boolean> {
  const plugin = tauri();
  if (plugin) return (await plugin.requestPermission()) === "granted";
  if (!("Notification" in window)) return false;
  return (await Notification.requestPermission()) === "granted";
}

function send(title: string, body: string, onClick?: () => void, tag?: string): void {
  const plugin = tauri();
  // The plugin has no click callback, so a desktop notification informs rather than navigates.
  if (plugin) {
    plugin.sendNotification({ title, body });
    return;
  }
  const note = new Notification(title, tag ? { body, tag } : { body });
  if (onClick) {
    note.onclick = () => {
      onClick();
      note.close();
    };
  }
}

/** Set when enabling failed, so the menu can say why instead of silently staying off. */
let problem: string | null = null;

export function notifyProblem(): string | null {
  return problem;
}

/** Turn notifications on, asking the OS if it has not been asked. Returns whether it worked. */
export async function enableNotifications(): Promise<boolean> {
  const kind = notifyKind();
  if (!kind) {
    problem = "not available here";
    return false;
  }
  if (!(await granted()) && !(await request())) {
    problem = kind === "desktop" ? "blocked in System Settings" : "blocked by the browser";
    return false;
  }
  problem = null;
  try {
    localStorage.setItem(ENABLED, "on");
  } catch {
    // Nothing to do: the toggle simply will not stick, and the menu reflects that on next open.
  }
  send(
    "Swarm notifications on",
    "You'll be pinged when a run needs a permission or a claim is orphaned.",
  );
  return true;
}

export function disableNotifications(): void {
  problem = null;
  try {
    localStorage.setItem(ENABLED, "off");
  } catch {
    // Same as above.
  }
}

/** Notifications stack badly; one every second and a half is plenty. */
const MIN_GAP_MS = 1500;
const MAX_BODY = 180;
let lastAt = 0;

/** What an event should say, or null if it is not worth interrupting anyone for. */
function describe(event: SwarmEvent): { title: string; body: string } | null {
  const p = (event.payload ?? {}) as Record<string, string | undefined>;
  switch (event.type) {
    case "permission.requested":
      return {
        title: `Permission needed: ${p.tool ?? "tool"}`,
        body: `${p.display ?? ""}\n${p.reason ?? ""}`.slice(0, MAX_BODY),
      };
    case "question.asked":
      return {
        title: "An agent has a question",
        body: `${p.task ? `${p.task}: ` : ""}${p.text ?? ""}`.slice(0, MAX_BODY),
      };
    case "session.stuck":
      return {
        title: "Session looks stuck",
        body: (p.reason ?? p.summary ?? "").slice(0, MAX_BODY),
      };
    case "claim.orphaned":
      return {
        title: "Claim orphaned",
        body: `${p.task ?? "a task"} — its lease expired with unfinished work in the worktree.`,
      };
    default:
      return null;
  }
}

/**
 * Raise a notification for an event, if it warrants one.
 *
 * While the window has focus only the two prompts that actually *block an agent* interrupt — the
 * rest you can see on screen, and a notification for something already in front of you is noise.
 */
export function notifyForEvent(event: SwarmEvent, onOpen: (sessionId: string) => void): void {
  if (!notificationsOn() || !notifyKind()) return;
  const blocking = event.type === "permission.requested" || event.type === "question.asked";
  if (!document.hidden && !blocking) return;
  const now = Date.now();
  if (now - lastAt < MIN_GAP_MS) return;
  const said = describe(event);
  if (!said) return;
  lastAt = now;
  send(
    said.title,
    said.body,
    () => {
      window.focus();
      if (event.sessionId) onOpen(event.sessionId);
    },
    `swarm-${event.type}-${event.sessionId ?? event.seq}`,
  );
}
