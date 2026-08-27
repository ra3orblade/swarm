/**
 * A view that still lives in the vanilla dashboard (M11.6).
 *
 * The React app is served alongside the original rather than replacing it view by view: the two
 * cannot share `#main`, since `app.js` owns that node and rewrites it wholesale. Running them side
 * by side keeps the working dashboard working while this one is reviewed, and each ported view
 * deletes one line from `App.tsx`.
 */
import { type ViewId, viewDef } from "./views";

export function NotPorted({ view }: { view: ViewId }) {
  const def = viewDef(view);
  return (
    <div className="empty">
      <b>{def.label}</b> has not been ported yet.
      <br />
      It is still on the original dashboard at{" "}
      <a href="/" className="link">
        /
      </a>
      .
    </div>
  );
}
