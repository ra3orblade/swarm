/**
 * The two things the dashboard asks for unprompted (M11.13).
 *
 * Both are deliberately rare and both are dismissable, because a control plane that nags is one
 * people close.
 *
 * **Update.** After an upgrade the *running* daemon is still the old build until it restarts, and
 * nothing says so — the dashboard just quietly lacks the thing you upgraded for. `/v1/health`
 * reports both the version on disk and the one running; when they differ, offer the restart.
 *
 * **Star.** Once, two days in, then at most monthly, and never again if asked. Pure localStorage:
 * nothing leaves the machine, and the button just opens the repo.
 */
import { useEffect, useState } from "react";
import { get, send } from "../api/client";
import { openExternal, REPO_URL } from "../lib/external";
import { icon } from "../lib/icon";

interface Health {
  /** The version installed on disk. */
  disk?: string;
  /** The version the running daemon was started from. */
  version?: string;
}

const DAY_MS = 86_400_000;
const HEALTH_POLL_MS = 300_000;

export function Nudges() {
  return (
    <>
      <UpdateNudge />
      <StarNudge />
    </>
  );
}

function UpdateNudge() {
  const [health, setHealth] = useState<Health | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    const check = () =>
      void get<Health>("/v1/health")
        .then(setHealth)
        .catch(() => {
          // Offline is already reported by the daemon dot in the header.
        });
    check();
    const timer = setInterval(check, HEALTH_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const stale = health?.disk && health.version && health.disk !== health.version;
  if (!stale || dismissed) return null;

  const restart = async () => {
    setRestarting(true);
    await send("/v1/daemon/restart", "POST").catch(() => {
      // The daemon dies mid-request by design; the poll below is what confirms it came back.
    });
    const until = Date.now() + 30_000;
    const poll = setInterval(async () => {
      const now = await get<Health>("/v1/health").catch(() => null);
      if (now?.version === health.disk) {
        clearInterval(poll);
        location.reload();
      } else if (Date.now() > until) {
        clearInterval(poll);
        setDismissed(true);
      }
    }, 800);
  };

  return (
    <div className="nudge">
      {icon("arrows-clockwise", 18, "ic")}
      <div>
        <b>Swarm {health.disk} is installed</b>
        The daemon is still running {health.version} — restart it to switch. Sessions and history
        are unaffected.
        <div className="row">
          <button
            type="button"
            className="pri"
            disabled={restarting}
            onClick={() => void restart()}
          >
            {icon("arrows-clockwise", 13)} {restarting ? "restarting…" : "Restart daemon"}
          </button>
          <button type="button" onClick={() => setDismissed(true)}>
            Later
          </button>
        </div>
      </div>
    </div>
  );
}

interface StarState {
  /** When the dashboard was first opened — the clock the first ask waits on. */
  since?: number;
  last?: number;
  done?: number;
  never?: number;
}

const STAR_KEY = "swarm.star";
const FIRST_AFTER_MS = 2 * DAY_MS;
const EVERY_MS = 30 * DAY_MS;
/** Long enough that the nudge never lands while the page is still settling. */
const SETTLE_MS = 4000;

function starState(): StarState {
  try {
    return JSON.parse(localStorage.getItem(STAR_KEY) || "{}") as StarState;
  } catch {
    return {};
  }
}

function starSave(patch: StarState): void {
  try {
    localStorage.setItem(STAR_KEY, JSON.stringify({ ...starState(), ...patch }));
  } catch {
    // Without storage the nudge simply never becomes due; that is the quiet direction.
  }
}

/** Whether to ask now, recording "first seen" the first time it is called. */
function starDue(now: number): boolean {
  const state = starState();
  if (!state.since) {
    starSave({ since: now });
    return false;
  }
  if (state.done || state.never) return false;
  if (now - state.since < FIRST_AFTER_MS) return false;
  if (state.last && now - state.last < EVERY_MS) return false;
  return true;
}

function StarNudge() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      const now = Date.now();
      // Never two nudges at once — the update one is the more useful of the pair.
      if (!starDue(now) || document.querySelector(".nudge")) return;
      starSave({ last: now });
      setShow(true);
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, []);

  if (!show) return null;

  return (
    <div className="nudge">
      {icon("star", 18, "ic")}
      <div>
        <b>Enjoying Swarm?</b>A star on GitHub helps other people find it — and tells us it's worth
        the evenings.
        <div className="row">
          <button
            type="button"
            className="pri"
            onClick={() => {
              starSave({ done: Date.now() });
              setShow(false);
              openExternal(REPO_URL);
            }}
          >
            {icon("star", 13)} Star on GitHub
          </button>
          <button type="button" onClick={() => setShow(false)}>
            Later
          </button>
          <button
            type="button"
            className="dim linkish"
            onClick={() => {
              starSave({ never: Date.now() });
              setShow(false);
            }}
          >
            Don't ask again
          </button>
        </div>
      </div>
    </div>
  );
}
