/**
 * Project settings (M8): name, icon, colour slot, pinned.
 *
 * Opened from the project row's `⋯` menu. The icon is an emoji or a letter or two typed into the
 * box, one of the emoji tiles, any emoji the platform font draws (behind "…"), or an image file
 * downsized to 64px and stored with the project. The colour is a design token `c1`…`c7`, never a
 * raw colour — the daemon refuses anything else.
 *
 * The vanilla dashboard had this drawer (v0.8.0); the React port dropped it, which left no way to
 * change a project's icon or name from the dashboard at all.
 */
import type { Project } from "@swarm/core/types";
import { useRef, useState } from "react";
import { updateProject } from "../api/actions";
import { Modal } from "../components/Modal";
import { ProjectGlyph } from "../components/ProjectGlyph";
import { emojiBlocks, fileToIconDataUrl, PROJECT_EMOJI } from "../lib/emoji";
import { icon } from "../lib/icon";

const COLOR_SLOTS = ["", "c1", "c2", "c3", "c4", "c5", "c6", "c7"];

const isImage = (value: string | null | undefined) =>
  typeof value === "string" && value.startsWith("data:image/");

export function ProjectSettings({ project, onClose }: { project: Project; onClose: () => void }) {
  const [name, setName] = useState(project.name);
  // Text and image are separate fields so typing a letter clears an image and picking an image
  // clears the text — whichever is set last is the icon.
  const [text, setText] = useState(isImage(project.icon) ? "" : (project.icon ?? ""));
  const [image, setImage] = useState(isImage(project.icon) ? (project.icon as string) : "");
  const [color, setColor] = useState(project.color ?? "");
  const [pinned, setPinned] = useState(!project.discovered);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const iconValue = image || text.trim();
  const pickEmoji = (emoji: string) => {
    setText(emoji);
    setImage("");
  };
  const pickImage = async (picked: File | undefined) => {
    if (!picked) return;
    try {
      setImage(await fileToIconDataUrl(picked));
      setText("");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    setSaving(true);
    const r = await updateProject(project.id, {
      ...(name.trim() ? { name: name.trim() } : {}),
      icon: iconValue,
      color,
      pinned,
    });
    setSaving(false);
    if (!r.ok) {
      setError(r.error ?? "could not save");
      return;
    }
    onClose();
  };

  const mac = navigator.platform.startsWith("Mac");

  return (
    <Modal
      title="Project settings"
      glyph="sliders"
      subtitle={project.root}
      onClose={onClose}
      footer={
        <>
          {error && <span className="pk-err">{error}</span>}
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={saving} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <label>
        name
        <input
          value={name}
          maxLength={60}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
      </label>

      <label>
        icon
        <div className="icon-row">
          <ProjectGlyph
            project={{ icon: iconValue || null, color: color || null }}
            size={16}
            large
          />
          <input
            value={text}
            maxLength={4}
            placeholder={`emoji or 1–2 letters · ${mac ? "⌃⌘Space" : "Win+."} opens the OS emoji picker`}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setText(e.target.value);
              setImage("");
            }}
          />
          <button
            type="button"
            className="btn"
            title="PNG / JPEG / SVG / WebP — downsized to 64px and stored with the project"
            onClick={() => file.current?.click()}
          >
            {icon("file-text", 13)} Image…
          </button>
          <input
            ref={file}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              void pickImage(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
      </label>

      <div className="emoji-row">
        {PROJECT_EMOJI.map((e) => (
          <button
            type="button"
            key={e}
            className={iconValue === e ? "emoji on" : "emoji"}
            aria-pressed={iconValue === e}
            onClick={() => pickEmoji(e)}
          >
            {e}
          </button>
        ))}
        <button
          type="button"
          className={iconValue ? "emoji" : "emoji on"}
          aria-pressed={!iconValue}
          title="No icon"
          onClick={() => pickEmoji("")}
        >
          {icon("folder-simple", 14)}
        </button>
        <button
          type="button"
          className="emoji more-emoji"
          title="Browse every emoji"
          aria-expanded={showAll}
          onClick={() => setShowAll((v) => !v)}
        >
          …
        </button>
      </div>

      {showAll && (
        <div className="emoji-all">
          {emojiBlocks().map((block) => (
            <div key={block.name}>
              <div className="emoji-sec">{block.name}</div>
              <div className="emoji-row">
                {block.emoji.map((e) => (
                  <button
                    type="button"
                    key={e}
                    className={iconValue === e ? "emoji on" : "emoji"}
                    onClick={() => pickEmoji(e)}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="pk-lbl">
        color
        <div className="swatches">
          {COLOR_SLOTS.map((slot) => {
            const classes = ["swatch", slot ? `pg-${slot}` : "none"];
            if (color === slot) classes.push("on");
            return (
              <button
                type="button"
                key={slot || "none"}
                className={classes.join(" ")}
                title={slot || "none"}
                aria-label={slot ? `colour ${slot}` : "no colour"}
                aria-pressed={color === slot}
                onClick={() => setColor(slot)}
              />
            );
          })}
        </div>
      </div>

      <label className="chk">
        <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
        pinned — always in the sidebar, drag to reorder
      </label>
    </Modal>
  );
}
