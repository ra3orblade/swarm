/**
 * The folder browser behind "Browse folders…" (M11.6, restored).
 *
 * The React port shipped a path box under the Projects heading and called it the picker's
 * "simpler half". It was the half nobody wanted: a folder you can *see* is one you do not have to
 * spell, and the daemon's `/v1/fs/ls` route exists because it already has the user's file access.
 * This is the vanilla picker again, class for class — a path box in the header that navigates on
 * Enter, one row per sub-folder with `git` badged, `..` to go up — with refusals shown in the
 * footer instead of an `alert`.
 *
 * The daemon decides what is a project; this only reports what it said.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { addProject } from "../api/actions";
import { ApiError, get } from "../api/client";
import { type DirListing, routes } from "../api/endpoints";
import { useDialog } from "../components/Modal";
import { icon } from "../lib/icon";

export interface FolderPickerProps {
  /** "Add by path…": land in the path box with its contents selected, so typing replaces it. */
  focusPath: boolean;
  onClose: () => void;
}

/** A listing that failed, in words a footer can hold. */
function explain(cause: unknown): string {
  if (cause instanceof ApiError) {
    return cause.status === 404 ? "no such folder" : "cannot read that folder";
  }
  return cause instanceof Error ? cause.message : "cannot read that folder";
}

export function FolderPicker({ focusPath, onClose }: FolderPickerProps) {
  const host = document.getElementById("picker");
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const inflight = useRef<AbortController | null>(null);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useDialog(dialog, onClose, host);

  // Each navigation cancels the one before it: two quick clicks must land on the second folder,
  // not on whichever answer arrived last. The opening listing of `~` is the one exception to
  // "the box shows where you are": someone who starts typing before it lands keeps what they typed.
  const go = useCallback(async (target: string, opening = false) => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    try {
      const next = await get<DirListing>(routes.fsList(target), controller.signal);
      setListing(next);
      if (!opening || !input.current?.value) setPath(next.path);
      setError(null);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(explain(cause));
    }
  }, []);

  useEffect(() => {
    void go("", true);
    return () => inflight.current?.abort();
  }, [go]);

  // Once the home path is in the box, "Add by path…" selects it so typing replaces it — unless
  // typing already started, in which case selecting would hand the next keystroke their text.
  const selected = useRef(false);
  useEffect(() => {
    if (!focusPath || !listing || selected.current) return;
    selected.current = true;
    if (input.current?.value === listing.path) input.current.select();
  }, [focusPath, listing]);

  const add = async () => {
    const target = path.trim() || listing?.path;
    if (!target || busy) return;
    setBusy(true);
    const result = await addProject(target);
    setBusy(false);
    if (result.ok) onClose();
    else setError(result.error ?? "could not add that folder");
  };

  if (!host) return null;

  const base = listing?.path.replace(/\/$/, "") ?? "";
  return createPortal(
    // `#picker` is the backdrop; the dialog goes in directly (see components/Modal).
    <div className="pk" role="dialog" aria-modal="true" aria-label="Add a project" ref={dialog}>
      <div className="pk-h">
        {icon("folders", 15)}
        <input
          ref={input}
          value={path}
          title="Type a path and press Enter"
          aria-label="Folder path"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void go(path.trim());
            }
          }}
        />
      </div>
      <div className="pk-list">
        {listing === null ? (
          <div className="empty pal-empty">Loading…</div>
        ) : (
          <>
            {listing.parent !== null && (
              <button
                type="button"
                className="pk-row up"
                onClick={() => void go(listing.parent ?? "")}
              >
                {icon("arrow-left", 14)}
                <span className="nm">..</span>
              </button>
            )}
            {listing.entries.length === 0 && <div className="empty pal-empty">No sub-folders.</div>}
            {listing.entries.map((entry) => (
              <button
                type="button"
                key={entry.name}
                className="pk-row"
                onClick={() => void go(`${base}/${entry.name}`)}
              >
                {icon(entry.repo ? "git-branch" : "folder-simple", 14)}
                <span className="nm">{entry.name}</span>
                {entry.repo && <span className="badge acc">git</span>}
              </button>
            ))}
          </>
        )}
      </div>
      <div className="pk-f">
        {error && <span className="pk-err">{error}</span>}
        <span className="grow" />
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => void add()}>
          Add this folder
        </button>
      </div>
    </div>,
    host,
  );
}
