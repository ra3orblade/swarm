/**
 * The application shell (M11.6).
 *
 * Header, sidebar and one view. The router is the `view` field of the UI store — the dashboard is
 * a single page served by a local daemon, so a history-based router would buy nothing and cost a
 * dependency.
 *
 * Views not yet ported render through `LegacyView`, which hands the old `app.js` renderer a plain
 * container. That is what lets this land incrementally: the dashboard is whole at every commit,
 * and each converted view deletes one entry from `LEGACY_VIEWS`.
 */
import { useEffect } from "react";
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
import { Sidebar } from "./Sidebar";
import type { ViewId } from "./views";

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
  // Keeps every relative time on screen honest on an idle fleet. See state/clock.ts.
  useClockTick();

  useEffect(() => {
    applyDeepLink();
    return startSnapshotFeed();
  }, []);

  // The collapsed rail is styled off `body.nosb`, which predates this shell and is also read by
  // rules that sit outside it (the update nudge). Setting the class keeps one source of truth.
  useEffect(() => {
    document.body.classList.toggle("nosb", collapsed);
  }, [collapsed]);

  const Ported = VIEWS[view];

  return (
    <>
      <Header />
      <Sidebar />
      <main id="main">
        <ErrorBoundary resetKey={session ?? view}>
          {/* A session is a place you go to and come back from, so it takes over the main pane
              while the nav stays where it was — `back` restores the view underneath. */}
          {session ? <Session id={session} /> : Ported ? <Ported /> : <NotPorted view={view} />}
        </ErrorBoundary>
      </main>
    </>
  );
}
