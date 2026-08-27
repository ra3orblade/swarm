/**
 * The context every row menu needs (M11.8): how to open a session, select a project, and switch
 * views. Built once here so a view can pass it straight through to a menu.
 */
import { useMemo } from "react";
import { useUiStore } from "../state/ui";
import type { MenuContext } from "./rowMenus";

export function useMenuContext(reload?: () => void): MenuContext {
  const openSession = useUiStore((s) => s.openSession);
  const selectProject = useUiStore((s) => s.selectProject);
  const openView = useUiStore((s) => s.openView);
  return useMemo(
    () => ({
      openSession,
      selectProject,
      openView,
      ...(reload ? { reload } : {}),
    }),
    [openSession, selectProject, openView, reload],
  );
}
