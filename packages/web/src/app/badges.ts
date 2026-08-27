/**
 * The counts shown beside view names (M11.6).
 *
 * The vanilla registry attached a `badge()` thunk to each view that read a global. That meant every
 * view's data had to be loaded all the time for its badge to be right — which is a large part of
 * why `refresh()` fetched everything on every tick.
 *
 * Only badges derivable from the shared snapshot are computed here. A badge that would need a
 * view's own endpoint is deliberately absent: fetching nine reports on a five-second beat to
 * decorate a menu is not worth it, and the number is on the view itself.
 */
import { useSnapshot } from "../state/snapshot";
import type { ViewId } from "./views";

/** Counts shown beside view names, keyed by view id. Absent means no badge. */
export type ViewBadges = Partial<Record<ViewId, number>>;

/** The badges derivable from the shared snapshot. See the file header for why the others are deliberately absent. */
export function useViewBadges(): ViewBadges {
  const openIncidents = useSnapshot((s) => s?.openIncidents ?? 0);
  const questions = useSnapshot((s) => s?.questions.length ?? 0);
  return { incidents: openIncidents, board: questions };
}
