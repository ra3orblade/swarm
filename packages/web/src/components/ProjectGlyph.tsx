/**
 * A project's glyph: its emoji, its image, or the folder icon, tinted with its colour slot.
 *
 * Shared by the sidebar rows, the Fleet cells and the settings drawer's preview — the last one
 * renders it for a project that has not been saved yet.
 */
import type { Project } from "@swarm/core/types";
import { icon } from "../lib/icon";

export type GlyphSource = Pick<Project, "icon" | "color">;

export function ProjectGlyph({
  project,
  size = 14,
  large = false,
}: {
  project: GlyphSource;
  size?: number;
  /** The 34px preview tile in the settings drawer. */
  large?: boolean;
}) {
  const classes = ["pg"];
  if (large) classes.push("pg-lg");
  if (project.color) classes.push(`pg-${project.color}`);
  const className = classes.join(" ");
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
