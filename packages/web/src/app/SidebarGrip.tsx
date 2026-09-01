/**
 * The drag handle on the sidebar's right edge.
 *
 * The sidebar was a fixed 240px in every version before this, so a long project name was cut to
 * an ellipsis with no way to widen it. The width is the CSS variable the body grid already reads
 * (`--sb-w`); dragging sets it and the store persists the result. During the drag the variable is
 * written straight to the root — a store write per pointer event would persist to localStorage
 * on every frame for nothing — and the store hears about it once, on release. Double-click resets;
 * the arrow keys nudge it for anyone without a mouse.
 *
 * A `<button>` rather than a `role="separator"` div so it is focusable without a role — the README
 * keeps ARIA roles to the three files that cannot avoid them.
 */
import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect } from "react";
import { clampSidebarWidth, SIDEBAR_WIDTH, useUiStore } from "../state/ui";

const STEP = 16;

const applyWidth = (px: number) => document.documentElement.style.setProperty("--sb-w", `${px}px`);

export function SidebarGrip() {
  const width = useUiStore((s) => s.sidebarWidth);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const setWidth = useUiStore((s) => s.setSidebarWidth);

  useEffect(() => {
    applyWidth(width);
  }, [width]);

  if (collapsed) return null;

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add("col-resizing");
    // The sidebar starts at the viewport's left edge, so the pointer's x *is* the width.
    let last = width;
    const onMove = (ev: PointerEvent) => {
      last = clampSidebarWidth(ev.clientX);
      applyWidth(last);
    };
    const onUp = () => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("col-resizing");
      setWidth(last);
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
  };

  return (
    <button
      type="button"
      className="sb-grip"
      title="Drag to resize the sidebar · double-click to reset"
      aria-label="Resize sidebar"
      onPointerDown={onPointerDown}
      onDoubleClick={() => setWidth(SIDEBAR_WIDTH.default)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") setWidth(width - STEP);
        else if (e.key === "ArrowRight") setWidth(width + STEP);
      }}
    />
  );
}
