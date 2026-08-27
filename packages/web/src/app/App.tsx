/**
 * The application shell (M11.6).
 *
 * Header, sidebar and one view. The router is the `view` field of the UI store — the dashboard is
 * a single page served by a local daemon, so a history-based router would buy nothing and cost a
 * dependency.
 *
 * Besides the views it also owns the app *chrome*: the ⌘K palette, What's New, the update and star
 * nudges, desktop-window dragging, zoom and external links. All of that lived in `app.js`; it is
 * mounted here because it is global by nature and has nowhere else to be.
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { get } from "../api/client";
import { useDesktopChrome } from "../lib/desktop";
import { useExternalLinks } from "../lib/external";
import { pendingUpgradeNotes, type ReleaseNote, releaseNotesFor } from "../lib/releaseNotes";
import { useZoom } from "../lib/zoom";
import { useClockTick } from "../state/clock";
import { startSnapshotFeed } from "../state/snapshot";
import { applyDeepLink, useUiStore } from "../state/ui";
import { Board } from "../views/board/Board";
import { Context } from "../views/Context";
import { Files } from "../views/Files";
import { Fleet } from "../views/Fleet";
import { Gates } from "../views/Gates";
import { Graphs } from "../views/Graphs";
import { Hygiene } from "../views/Hygiene";
import { Incidents } from "../views/Incidents";
import { Mcp } from "../views/Mcp";
import { Outcomes } from "../views/Outcomes";
import { PRs } from "../views/PRs";
import { Provenance } from "../views/Provenance";
import { Rules } from "../views/Rules";
import { Search } from "../views/Search";
import { Security } from "../views/Security";
import { Session } from "../views/Session";
import { Spend } from "../views/Spend";
import { Stats } from "../views/Stats";
import { TimelineView } from "../views/TimelineView";
import { Trials } from "../views/Trials";
import { ErrorBoundary } from "./ErrorBoundary";
import { Header } from "./Header";
import { NotPorted } from "./NotPorted";
import { Nudges } from "./Nudges";
import { Palette } from "./Palette";
import { Sidebar } from "./Sidebar";
import type { ViewId } from "./views";
import { WhatsNew } from "./WhatsNew";

/**
 * Views that have a React implementation; everything else falls through to `NotPorted`.
 * `| null` because a view may legitimately render nothing while its data is absent.
 */
const VIEWS: Partial<Record<ViewId, () => React.JSX.Element | null>> = {
  fleet: Fleet,
  prs: PRs,
  hygiene: Hygiene,
  outcomes: Outcomes,
  gates: Gates,
  mcp: Mcp,
  context: Context,
  heat: Files,
  security: Security,
  provenance: Provenance,
  rules: Rules,
  incidents: Incidents,
  trials: Trials,
  board: Board,
  spend: Spend,
  search: Search,
  stats: Stats,
  timeline: TimelineView,
  graphs: Graphs,
};

export function App() {
  const view = useUiStore((s) => s.view);
  const session = useUiStore((s) => s.session);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const [version, setVersion] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [notes, setNotes] = useState<ReleaseNote | null>(null);
  // Keeps every relative time on screen honest on an idle fleet. See state/clock.ts.
  useClockTick();
  useExternalLinks();
  useDesktopChrome();
  useZoom();

  useEffect(() => {
    applyDeepLink();
    return startSnapshotFeed();
  }, []);

  // The version drives the settings menu, the feedback template and the post-upgrade panel.
  useEffect(() => {
    void get<{ version?: string }>("/v1/health")
      .then((h) => {
        const running = h.version ?? null;
        setVersion(running);
        setNotes(pendingUpgradeNotes(running));
      })
      .catch(() => {
        // Offline is already shown by the daemon dot; the chrome just stays version-less.
      });
  }, []);

  const openWhatsNew = useCallback(() => setNotes(releaseNotesFor(version)), [version]);

  // The desktop app's Help menu reaches these two through the window object.
  useEffect(() => {
    window.swarmWhatsNew = (v?: string) => setNotes(releaseNotesFor(v ?? version));
    return () => {
      window.swarmWhatsNew = undefined;
    };
  }, [version]);

  // ⌘K toggles the palette; Escape closes it. Held while a dropdown is open so the two do not fight.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((open) => !open);
      } else if (e.key === "Escape") {
        setPalette(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // The collapsed rail is styled off `body.nosb`, which predates this shell and is also read by
  // rules that sit outside it (the update nudge). Setting the class keeps one source of truth.
  useEffect(() => {
    document.body.classList.toggle("nosb", collapsed);
  }, [collapsed]);

  const Ported = VIEWS[view];

  return (
    <>
      <Header
        version={version}
        onOpenPalette={() => setPalette(true)}
        onOpenWhatsNew={openWhatsNew}
      />
      <Sidebar />
      <main id="main">
        <ErrorBoundary resetKey={session ?? view}>
          {/* A session is a place you go to and come back from, so it takes over the main pane
              while the nav stays where it was — `back` restores the view underneath. */}
          {session ? <Session id={session} /> : Ported ? <Ported /> : <NotPorted view={view} />}
        </ErrorBoundary>
      </main>
      {palette && <PalettePortal onClose={() => setPalette(false)} />}
      {notes && <WhatsNew note={notes} onClose={() => setNotes(null)} />}
      <Nudges />
    </>
  );
}

/** The palette renders into `#picker`, the same backdrop every dialog uses. */
function PalettePortal({ onClose }: { onClose: () => void }) {
  const host = document.getElementById("picker");
  if (!host) return null;
  return createPortal(<Palette onClose={onClose} />, host);
}
