/**
 * The "+" in the sidebar header (M11.6).
 *
 * The vanilla dashboard opened a folder browser over `/v1/fs/ls`. This is the same endpoint's
 * simpler half — type or paste a path — which is what the browser was mostly used for anyway, and
 * it is a real control rather than a button that does nothing.
 *
 * The daemon decides what is a project; this only reports what it said.
 */
import { useEffect, useRef, useState } from "react";
import { addProject } from "../api/actions";
import { icon } from "../lib/icon";

export function ProjectsHeading() {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const submit = async () => {
    const trimmed = path.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const result = await addProject(trimmed);
    setBusy(false);
    if (result.ok) {
      setPath("");
      setError(null);
      setOpen(false);
    } else {
      setError(result.error ?? "could not add that folder");
    }
  };

  // The heading is a flex row, so the input cannot be a child of it — it renders after, which is
  // why this component owns the whole heading rather than just the button.
  return (
    <>
      <h4>
        Projects
        <button
          type="button"
          className="h4-act"
          title="Add a project by path"
          aria-label="Add a project"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
        >
          {icon("plus", 14)}
        </button>
      </h4>

      {open && (
        <div className="addproj">
          <input
            ref={input}
            type="text"
            value={path}
            placeholder="~/code/my-repo"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              if (e.key === "Escape") setOpen(false);
            }}
          />
          {error && <div className="addproj-err">{error}</div>}
        </div>
      )}
    </>
  );
}
