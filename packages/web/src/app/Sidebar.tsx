/**
 * The project sidebar (M11.6): pinned projects with a spend sparkline and a live-session count,
 * then the ones Swarm has seen but you have not pinned.
 *
 * The markup mirrors the vanilla one class for class — `.proj`, `.st`, `.nm` — because the
 * stylesheet is the original and every rule in it was arrived at by fixing a real defect. Rows are
 * `<button>`s so they can be tabbed to, which the old `<div>`s could not; `.proj` therefore also
 * resets the browser's button chrome (see dashboard.css).
 *
 * Pinned rows reorder by drag-and-drop, as the vanilla ones did. The vanilla moved DOM nodes
 * around during `dragover` as the drop preview; React owns these nodes, so the preview is state —
 * the id order being dragged into — and the list renders from it until the daemon has the new
 * order and the re-poll shows it.
 */
import type { Project, SessionView } from "@swarm/core/types";
import { type DragEvent, useMemo, useState } from "react";
import { reorderProjects } from "../api/actions";
import { Sparkline } from "../components/Sparkline";
import { sumBy } from "../lib/format";
import { icon } from "../lib/icon";
import { useSnapshot } from "../state/snapshot";
import { useUiStore } from "../state/ui";
import { ProjectsHeading } from "./AddProject";
import { projectMenu } from "./rowMenus";
import { useMenuContext } from "./useMenuContext";

export function Sidebar() {
  const selected = useUiStore((s) => s.project);
  const selectProject = useUiStore((s) => s.selectProject);
  const projects = useSnapshot((s) => s?.projects ?? EMPTY_PROJECTS);
  const sessions = useSnapshot((s) => s?.sessions ?? EMPTY_SESSIONS);
  const sparks = useSnapshot((s) => s?.spendSparks ?? EMPTY_SPARKS);
  const menu = useMenuContext();

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

  const pinned = useMemo(() => projects.filter((p) => !p.discovered), [projects]);
  const unpinned = useMemo(() => projects.filter((p) => p.discovered), [projects]);
  const liveAll = Object.values(live).reduce((a, b) => a + b, 0);

  const [drag, setDrag] = useState<Drag | null>(null);
  // The pinned list in the order being dragged into, else as the daemon sorted it.
  const shownPinned = useMemo(() => {
    if (!drag) return pinned;
    const byId = new Map(pinned.map((p) => [p.id, p]));
    return drag.order.flatMap((id) => byId.get(id) ?? []);
  }, [drag, pinned]);

  const dragHandlers: DragHandlers = {
    active: drag !== null,
    onStart: (id) => setDrag({ id, order: pinned.map((p) => p.id) }),
    onOver: (target, before) => setDrag((d) => (d ? moved(d, target, before) : d)),
    onEnd: () => {
      if (!drag) return;
      const changed = drag.order.some((id, i) => id !== pinned[i]?.id);
      // The preview stays up until the daemon has the order, so the list does not snap back and
      // forth between the drop and the re-poll.
      if (changed) void reorderProjects(drag.order).finally(() => setDrag(null));
      else setDrag(null);
    },
  };

  const row = (project: Project, draggable: boolean) => (
    <ProjectRow
      key={project.id}
      project={project}
      selected={selected === project.id}
      live={live[project.id] ?? 0}
      spark={sparks[project.id] ?? EMPTY_SPARK}
      ambiguous={(duplicated.get(project.name) ?? 0) > 1}
      onSelect={selectProject}
      onMenu={(anchor) => projectMenu(anchor, project, live[project.id] ?? 0, menu)}
      {...(draggable ? { drag: dragHandlers, dragging: drag?.id === project.id } : {})}
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

        <div id="pinned">{shownPinned.map((p) => row(p, true))}</div>

        {unpinned.length > 0 && (
          <>
            <h4>
              Unpinned <span className="faint h4-note">· seen, not pinned</span>
            </h4>
            {unpinned.map((p) => row(p, false))}
          </>
        )}
      </div>
    </aside>
  );
}

/** A drag in progress: which pinned project, and the id order it is being dropped into. */
interface Drag {
  id: string;
  order: string[];
}

/** `drag.order` with the dragged id moved before or after `target`. Unchanged if nothing moves. */
function moved(drag: Drag, target: string, before: boolean): Drag {
  if (target === drag.id) return drag;
  const rest = drag.order.filter((id) => id !== drag.id);
  const at = rest.indexOf(target);
  if (at < 0) return drag;
  rest.splice(before ? at : at + 1, 0, drag.id);
  return rest.every((id, i) => id === drag.order[i]) ? drag : { ...drag, order: rest };
}

/** What a pinned row needs to take part in reordering. */
interface DragHandlers {
  /** True while some pinned row is being dragged — a file from the desktop is not our drag. */
  active: boolean;
  onStart: (id: string) => void;
  onOver: (target: string, before: boolean) => void;
  onEnd: () => void;
}

interface ProjectRowProps {
  project: Project;
  selected: boolean;
  live: number;
  spark: readonly number[];
  ambiguous: boolean;
  onSelect: (id: string) => void;
  onMenu: (anchor: Element) => void;
  /** Present on pinned rows, which can be reordered. */
  drag?: DragHandlers;
  dragging?: boolean;
}

function ProjectRow({
  project,
  selected,
  live,
  spark,
  ambiguous,
  onSelect,
  onMenu,
  drag,
  dragging = false,
}: ProjectRowProps) {
  // Under half a dollar over a fortnight is a flat line pretending to be information.
  const spend = sumBy(spark, (n) => n);
  const parent = ambiguous ? project.root.split("/").filter(Boolean).at(-2) : undefined;
  const className = ["proj", selected && "sel", dragging && "dragging"].filter(Boolean).join(" ");

  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    if (!drag) return;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", project.id);
    // After the browser has captured the drag image, so the ghost is not the dimmed row.
    requestAnimationFrame(() => drag.onStart(project.id));
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!drag?.active) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const box = e.currentTarget.getBoundingClientRect();
    drag.onOver(project.id, e.clientY < box.top + box.height / 2);
  };

  // A <div role="button">, not a <button>: the row contains the `⋯` menu button, and nesting one
  // button inside another is invalid HTML — the browser hoists it out and the click is swallowed.
  return (
    <div
      className={className}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(project.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect(project.id);
      }}
      title={project.root}
      draggable={drag !== undefined}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={(e) => {
        if (drag?.active) e.preventDefault();
      }}
      onDragEnd={drag?.onEnd}
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
      <button
        type="button"
        className="act more"
        title="Project actions"
        aria-label="Project actions"
        aria-haspopup="menu"
        onClick={(e) => {
          e.stopPropagation();
          onMenu(e.currentTarget);
        }}
      >
        {icon("dots-three", 15)}
      </button>
    </div>
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
