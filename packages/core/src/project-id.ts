/**
 * Project identity (docs/02-architecture.md): the realpath of the git common dir,
 * so every worktree of a repository maps to the same project. Non-git folders use
 * their own realpath. Pure: callers pass the resolved paths in.
 */
export interface ProjectIdentity {
  id: string;
  root: string;
  commonDir: string | null;
  name: string;
}

function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function projectIdentity(opts: { root: string; commonDir: string | null }): ProjectIdentity {
  const key = opts.commonDir ?? opts.root;
  const parts = opts.root.split("/").filter(Boolean);
  const name = parts[parts.length - 1] ?? opts.root;
  return { id: `p_${fnv1a(key)}`, root: opts.root, commonDir: opts.commonDir, name };
}
