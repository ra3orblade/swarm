/**
 * The project sidebar (M11.6): pinned projects with a spend sparkline and a live-session count,
 * then the ones Swarm has seen but you have not pinned.
 *
 * The markup mirrors the vanilla one class for class — `.proj`, `.st`, `.nm` — because the
 * stylesheet is the original and every rule in it was arrived at by fixing a real defect. Rows are
 * `<button>`s so they can be tabbed to, which the old `<div>`s could not; `.proj` therefore also
 * resets the browser's button chrome (see dashboard.css).
 *
 * Pinned rows reorder by drag-and-drop, as the vanilla ones did — but with dnd-kit's pointer
 * sensor, not the HTML5 drag events the vanilla used. Native drag never delivered a `drop` inside
 * the desktop shell (Tauri's own drag-drop handler eats it), and it cannot animate; dnd-kit moves
 * the neighbours out of the way with transforms while the row is held. React owns the nodes, so
 * the dropped order is state — the list renders from it until the daemon has the new order and
 * the re-poll shows it, so nothing snaps back and forth in between.
 */
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Project, SessionView } from "@swarm/core/types";
import { type CSSProperties, useMemo, useState } from "react";
import { reorderProjects } from "../api/actions";
import { ProjectGlyph } from "../components/ProjectGlyph";
import { Sparkline } from "../components/Sparkline";
import { sumBy } from "../lib/format";
import { icon } from "../lib/icon";
import { useSnapshot } from "../state/snapshot";
import { useUiStore } from "../state/ui";
import { ProjectsHeading } from "./AddProject";
import { ProjectSettings } from "./ProjectSettings";
import { projectMenu } from "./rowMenus";
import { useMenuContext } from "./useMenuContext";

export function Sidebar() {
  const selected = useUiStore((s) => s.project);
  const selectProject = useUiStore((s) => s.selectProject);
  const projects = useSnapshot((s) => s?.projects ?? EMPTY_PROJECTS);
  const sessions = useSnapshot((s) => s?.sessions ?? EMPTY_SESSIONS);
  const sparks = useSnapshot((s) => s?.spendSparks ?? EMPTY_SPARKS);
  const [editing, setEditing] = useState<Project | null>(null);
  const menu = useMenuContext(undefined, undefined, setEditing);

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

  // Which pinned row is held, and the id order it was dropped into — kept until the daemon has
  // it and the re-poll shows the same thing.
  const [active, setActive] = useState<string | null>(null);
  const [dropped, setDropped] = useState<string[] | null>(null);
  const shownPinned = useMemo(() => {
    if (!dropped) return pinned;
    const byId = new Map(pinned.map((p) => [p.id, p]));
    const known = new Set(dropped);
    // A project pinned while the drop is in flight goes at the end rather than vanishing.
    return [
      ...dropped.flatMap((id) => byId.get(id) ?? []),
      ...pinned.filter((p) => !known.has(p.id)),
    ];
  }, [dropped, pinned]);

  // A few pixels of travel before a press counts as a drag, so clicks still select the project and
  // reach the `⋯` button.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const onDragStart = (e: DragStartEvent) => setActive(String(e.active.id));
  const onDragEnd = ({ active: held, over }: DragEndEvent) => {
    setActive(null);
    if (!over || held.id === over.id) return;
    const ids = shownPinned.map((p) => p.id);
    const next = arrayMove(ids, ids.indexOf(String(held.id)), ids.indexOf(String(over.id)));
    setDropped(next);
    void reorderProjects(next).finally(() => setDropped(null));
  };

  const rowProps = (project: Project): ProjectRowProps => ({
    project,
    selected: selected === project.id,
    live: live[project.id] ?? 0,
    spark: sparks[project.id] ?? EMPTY_SPARK,
    ambiguous: (duplicated.get(project.name) ?? 0) > 1,
    onSelect: selectProject,
    onMenu: (anchor) => projectMenu(anchor, project, live[project.id] ?? 0, menu),
  });

  return (
    <aside id="sidebar">
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

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setActive(null)}
        >
          <SortableContext
            items={shownPinned.map((p) => p.id)}
            strategy={verticalListSortingStrategy}
          >
            <div id="pinned">
              {shownPinned.map((p) => (
                <SortableProjectRow key={p.id} {...rowProps(p)} dragging={active === p.id} />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        {unpinned.length > 0 && (
          <>
            <h4>
              Unpinned <span className="faint h4-note">· seen, not pinned</span>
            </h4>
            {unpinned.map((p) => (
              <ProjectRow key={p.id} {...rowProps(p)} />
            ))}
          </>
        )}
      </div>
      {editing && <ProjectSettings project={editing} onClose={() => setEditing(null)} />}
    </aside>
  );
}

/** A pinned row: `ProjectRow` wired to dnd-kit, so it can be picked up and its neighbours slide. */
function SortableProjectRow(props: ProjectRowProps) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: props.project.id,
  });
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition };
  return (
    <ProjectRow
      {...props}
      dragging={isDragging || props.dragging === true}
      sortable={{ ref: setNodeRef, style, listeners: listeners ?? {} }}
    />
  );
}

interface ProjectRowProps {
  project: Project;
  selected: boolean;
  live: number;
  spark: readonly number[];
  ambiguous: boolean;
  onSelect: (id: string) => void;
  onMenu: (anchor: Element) => void;
  /** Present on pinned rows, which can be reordered: what dnd-kit needs on the node. */
  sortable?: {
    ref: (node: HTMLElement | null) => void;
    style: CSSProperties;
    listeners: Record<string, unknown>;
  };
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
  sortable,
  dragging = false,
}: ProjectRowProps) {
  // Under half a dollar over a fortnight is a flat line pretending to be information.
  const spend = sumBy(spark, (n) => n);
  const parent = ambiguous ? project.root.split("/").filter(Boolean).at(-2) : undefined;
  const className = ["proj", selected && "sel", sortable && "sortable", dragging && "dragging"]
    .filter(Boolean)
    .join(" ");

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
      ref={sortable?.ref}
      style={sortable?.style}
      {...sortable?.listeners}
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

const EMPTY_PROJECTS: Project[] = [];
const EMPTY_SESSIONS: SessionView[] = [];
const EMPTY_SPARKS: Record<string, number[]> = {};
const EMPTY_SPARK: readonly number[] = [];
