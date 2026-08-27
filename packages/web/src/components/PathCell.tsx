/** A path in a narrow column: filename first, then just enough directory to place it (M11.9). */
import { directoryHint, fileName } from "../lib/paths";

export function PathCell({ path, hint }: { path: string; hint?: string | undefined }) {
  return (
    <>
      <b>{fileName(path)}</b> <span className="dim">{hint ?? directoryHint(path)}</span>
    </>
  );
}
