/**
 * The project sidebar (M11.6): pinned projects with a spend sparkline and a live-session count,
 * then the ones Swarm has seen but you have not pinned.
 */
import type { Project, SessionView } from "@swarm/core/types";
import { useMemo } from "react";
import { Sparkline } from "../components/Sparkline";
import { icon } from "../lib/icon";
import { useSnapshot } from "../state/snapshot";
import { useUiStore } from "../state/ui";

export function Sidebar() {
  const selected = useUiStore((s) => s.project);
  const selectProject = useUiStore((s) => s.selectProject);
  const projects = useSnapshot((s) => s?.projects ?? EMPTY_PROJECTS);
  const sparks = useSnapshot((s) => s?.spendSparks ?? EMPTY_SPARKS);
  const sessions = useSnapshot((s) => s?.sessions ?? EMPTY_SESSIONS);
  // Derived with useMemo, never inside the selector: a selector that builds a fresh object returns
  // a new reference every call, so the store's identity check always says "changed" and the render
  // loops forever (React #185). Selectors must return something already in the snapshot.
  const liveByProject = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const session of sessions) {
      if (session.state !== "ended") {
        counts[session.projectId] = (counts[session.projectId] ?? 0) + 1;
      }
    }
    return counts;
  }, [sessions]);

  const pinned = projects.filter((p) => !p.discovered);
  const unpinned = projects.filter((p) => p.discovered);
  const liveTotal = Object.values(liveByProject).reduce((a, b) => a + b, 0);

  return (
    <aside>
      <div id="projects">
        <div className="side-h">
          Projects
          <button
            type="button"
            className="icon-btn"
            title="Add a project"
            aria-label="Add a project"
          >
            {icon("plus", 14)}
          </button>
        </div>

        <button
          type="button"
          className={selected === null ? "proj on" : "proj"}
          onClick={() => selectProject(null)}
        >
          <span className="pg">{icon("folders", 14)}</span>
          <span className="proj-n">All projects</span>
          {liveTotal > 0 && <span className="proj-c">{liveTotal}</span>}
        </button>

        {pinned.map((project) => (
          <ProjectRow
            key={project.id}
            project={project}
            selected={selected === project.id}
            live={liveByProject[project.id] ?? 0}
            spark={sparks[project.id] ?? EMPTY_SPARK}
            onSelect={selectProject}
          />
        ))}

        {unpinned.length > 0 && (
          <>
            <div className="side-h side-h-sub">
              Unpinned <span>· seen, not pinned</span>
            </div>
            {unpinned.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                selected={selected === project.id}
                live={liveByProject[project.id] ?? 0}
                spark={EMPTY_SPARK}
                onSelect={selectProject}
              />
            ))}
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
  onSelect: (id: string) => void;
}

function ProjectRow({ project, selected, live, spark, onSelect }: ProjectRowProps) {
  return (
    <button
      type="button"
      className={selected ? "proj on" : "proj"}
      onClick={() => onSelect(project.id)}
      title={project.root}
    >
      <i className={live > 0 ? "dot on" : "dot"} />
      <ProjectGlyph project={project} />
      <span className="proj-n">{project.name}</span>
      {spark.length > 0 && <Sparkline points={spark} className="proj-spark" />}
      {live > 0 && <span className="proj-c">{live}</span>}
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
