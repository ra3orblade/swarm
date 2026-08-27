/**
 * The project sidebar (M11.6): pinned projects with a spend sparkline and a live-session count,
 * then the ones Swarm has seen but you have not pinned.
 *
 * The markup mirrors the vanilla one class for class — `.proj`, `.st`, `.nm` — because the
 * stylesheet is the original and every rule in it was arrived at by fixing a real defect. Rows are
 * `<button>`s so they can be tabbed to, which the old `<div>`s could not; `.proj` therefore also
 * resets the browser's button chrome (see dashboard.css).
 */
import type { Project, SessionView } from "@swarm/core/types";
import { useMemo } from "react";
import { Sparkline } from "../components/Sparkline";
import { sumBy } from "../lib/format";
import { icon } from "../lib/icon";
import { useSnapshot } from "../state/snapshot";
import { useUiStore } from "../state/ui";
import { ProjectsHeading } from "./AddProject";

export function Sidebar() {
  const selected = useUiStore((s) => s.project);
  const selectProject = useUiStore((s) => s.selectProject);
  const projects = useSnapshot((s) => s?.projects ?? EMPTY_PROJECTS);
  const sessions = useSnapshot((s) => s?.sessions ?? EMPTY_SESSIONS);
  const sparks = useSnapshot((s) => s?.spendSparks ?? EMPTY_SPARKS);

  // Derived with useMemo, never inside the selector: a selector that builds a fresh object returns
  // a new reference every call, so the store's identity check always says "changed" and the render
  // loops forever (React #185).
  const live = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const session of sessions) {
      if (session.state === "active" || session.state === "waiting") {
        counts[session.projectId] = (counts[session.projectId] ?? 0) + 1;
      }
    }
    return counts;
  }, [sessions]);

  /** Two projects can share a name; the parent directory is the cheapest way to tell them apart. */
  const duplicated = useMemo(() => {
    const seen = new Map<string, number>();
    for (const p of projects) seen.set(p.name, (seen.get(p.name) ?? 0) + 1);
    return seen;
  }, [projects]);

  const pinned = projects.filter((p) => !p.discovered);
  const unpinned = projects.filter((p) => p.discovered);
  const liveAll = Object.values(live).reduce((a, b) => a + b, 0);

  const row = (project: Project) => (
    <ProjectRow
      key={project.id}
      project={project}
      selected={selected === project.id}
      live={live[project.id] ?? 0}
      spark={sparks[project.id] ?? EMPTY_SPARK}
      ambiguous={(duplicated.get(project.name) ?? 0) > 1}
      onSelect={selectProject}
    />
  );

  return (
    <aside>
      <div id="projects">
        <ProjectsHeading />

        <button
          type="button"
          className={selected === null ? "proj sel" : "proj"}
          onClick={() => selectProject(null)}
        >
          <span className={liveAll > 0 ? "st live" : "st"} />
          {icon("folders", 14)}
          <span className="nm">All projects</span>
          <small>{liveAll || ""}</small>
        </button>

        <div id="pinned">{pinned.map(row)}</div>

        {unpinned.length > 0 && (
          <>
            <h4>
              Unpinned <span className="faint h4-note">· seen, not pinned</span>
            </h4>
            {unpinned.map(row)}
          </>
        )}
      </div>
    </aside>
  );
}

interface ProjectRowProps {
  project: Project;
  selected: boolean;
  live: number;
  spark: readonly number[];
  ambiguous: boolean;
  onSelect: (id: string) => void;
}

function ProjectRow({ project, selected, live, spark, ambiguous, onSelect }: ProjectRowProps) {
  // Under half a dollar over a fortnight is a flat line pretending to be information.
  const spend = sumBy(spark, (n) => n);
  const parent = ambiguous ? project.root.split("/").filter(Boolean).at(-2) : undefined;

  return (
    <button
      type="button"
      className={selected ? "proj sel" : "proj"}
      onClick={() => onSelect(project.id)}
      title={project.root}
    >
      <span className={live > 0 ? "st live" : "st"} />
      <ProjectGlyph project={project} />
      <span className="nm">
        {parent && <span className="pdir">{parent}/</span>}
        {project.name}
      </span>
      {spend >= 0.5 && (
        <span className="proj-spark" title={`last 14 days · $${spend.toFixed(0)}`}>
          <Sparkline points={spark} color="var(--c1)" />
        </span>
      )}
      <small>{live || ""}</small>
    </button>
  );
}

/** A project's emoji glyph, or the folder icon, tinted with its colour slot. */
export function ProjectGlyph({ project, size = 14 }: { project: Project; size?: number }) {
  const className = project.color ? `pg pg-${project.color}` : "pg";
  if (!project.icon) return <span className={className}>{icon("folder-simple", size)}</span>;
  if (project.icon.startsWith("data:image/")) {
    return (
      <span className={className}>
        <img className="pg-img" src={project.icon} alt="" />
      </span>
    );
  }
  return <span className={className}>{project.icon}</span>;
}

const EMPTY_PROJECTS: Project[] = [];
const EMPTY_SESSIONS: SessionView[] = [];
const EMPTY_SPARKS: Record<string, number[]> = {};
const EMPTY_SPARK: readonly number[] = [];
