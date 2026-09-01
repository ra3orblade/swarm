/**
 * The "+" in the sidebar header (M11.6).
 *
 * A menu of the two ways to add a project, as the vanilla dashboard had: browse to the folder, or
 * type its path. Both open the same {@link FolderPicker}; "Add by path…" just lands in its path
 * box. The React port replaced this with an inline path input and lost the browser, which is the
 * one people reach for.
 */
import { useCallback, useState } from "react";
import { icon } from "../lib/icon";
import { openMenu } from "../lib/menus";
import { FolderPicker } from "./FolderPicker";

type Picker = "browse" | "path";

export function ProjectsHeading() {
  const [picker, setPicker] = useState<Picker | null>(null);
  const close = useCallback(() => setPicker(null), []);

  return (
    <>
      <h4>
        Projects
        <button
          type="button"
          className="h4-act"
          title="Add a project"
          aria-label="Add a project"
          aria-haspopup="menu"
          onClick={(e) =>
            openMenu(e.currentTarget, [
              { label: "Browse folders…", icon: "folder-simple", run: () => setPicker("browse") },
              { label: "Add by path…", icon: "terminal-window", run: () => setPicker("path") },
            ])
          }
        >
          {icon("plus", 14)}
        </button>
      </h4>

      {picker !== null && <FolderPicker focusPath={picker === "path"} onClose={close} />}
    </>
  );
}
