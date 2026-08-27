/** The `⋯` at the end of a row that has actions (M11.8). */
import { icon } from "../lib/icon";

export function RowMenuButton({
  onOpen,
  title,
}: {
  onOpen: (anchor: Element) => void;
  title: string;
}) {
  return (
    <button
      type="button"
      className="more"
      title={title}
      aria-label={title}
      aria-haspopup="menu"
      onClick={(e) => {
        // The menu anchors to this button, and the click must not also select the row.
        e.stopPropagation();
        onOpen(e.currentTarget);
      }}
    >
      {icon("dots-three", 15)}
    </button>
  );
}
