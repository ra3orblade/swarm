/**
 * The overlay every drawer and dialog renders into (M11.11).
 *
 * It portals into `#picker`, which is already the backdrop — fixed, centred, and hidden by
 * `#picker:empty` when nothing is open. So the dialog goes in *directly*: wrapping it in another
 * element would leave `#picker` non-empty and the overlay permanently painted.
 *
 * Escape closes, a click on the backdrop closes, and focus moves into the dialog on open and back
 * to whatever opened it on close — none of which the vanilla did, and all of which a modal needs
 * to be usable without a mouse.
 */
import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { icon } from "../lib/icon";

/**
 * What every dialog in `#picker` needs, whatever its header looks like: Escape closes, a click on
 * the backdrop closes, focus moves to the first field on open and back to the opener on close.
 *
 * `Modal` uses it, and so does the folder picker, whose header is a path box rather than a title.
 * `onClose` is read through a ref so an inline arrow from the parent does not re-run the effect
 * every render — which would re-capture "the opener" as the field we just focused, and hand focus
 * back to a node that no longer exists.
 */
export function useDialog(
  dialog: RefObject<HTMLDivElement | null>,
  onClose: () => void,
  host: HTMLElement | null,
): void {
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const opener = document.activeElement;
    dialog.current?.querySelector<HTMLElement>("textarea, input, button")?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
    };
    // `#picker` lives outside the React tree, so its backdrop click is a plain listener.
    const onBackdrop = (e: MouseEvent) => {
      if (e.target === host) close.current();
    };
    document.addEventListener("keydown", onKey);
    host?.addEventListener("click", onBackdrop);
    return () => {
      document.removeEventListener("keydown", onKey);
      host?.removeEventListener("click", onBackdrop);
      // Returning focus is the half people notice only when it is missing.
      (opener as HTMLElement | null)?.focus?.();
    };
  }, [dialog, host]);
}

export interface ModalProps {
  title: string;
  /** Glyph beside the title, from the generated icon set. */
  glyph?: string;
  /** The grey line after the title. */
  subtitle?: ReactNode;
  /** Extra classes on the dialog: `wide`, `wn rp`, … */
  size?: string;
  children: ReactNode;
  /** Rendered in the footer, right-aligned after a spacer. */
  footer?: ReactNode;
  onClose: () => void;
}

export function Modal({
  title,
  glyph = "squares-four",
  subtitle,
  size,
  children,
  footer,
  onClose,
}: ModalProps) {
  const host = document.getElementById("picker");
  const dialog = useRef<HTMLDivElement>(null);
  useDialog(dialog, onClose, host);

  if (!host) return null;

  return createPortal(
    <div
      className={size ? `pk ${size}` : "pk"}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      ref={dialog}
    >
      <div className="pk-h">
        {icon(glyph, 15)}
        <b>{title}</b>
        {subtitle !== undefined && <span className="dim now pk-sub">{subtitle}</span>}
        <span className="grow" />
        <button type="button" title="Close" aria-label="Close" onClick={onClose}>
          {icon("x", 14)}
        </button>
      </div>
      <div className="pk-b">{children}</div>
      {footer !== undefined && (
        <div className="pk-f">
          <span className="grow" />
          {footer}
        </div>
      )}
    </div>,
    host,
  );
}
