# The dashboard (M11)

React + TypeScript, bundled by `Bun.build` into `public/dashboard.js` and `public/dashboard.css`.
No Vite: the daemon already serves static files, and a dev server would buy nothing.

Run `bun run build:web` after changing anything here. It is also wired to `postinstall`.

## Layout

```
api/       talking to swarmd — one fetch path, typed routes, polling
state/     zustand stores: the snapshot, what the user is looking at, grid layouts
app/       the shell — header, sidebar, view registry, error boundary
components/ reusable pieces: DataGrid, charts, ui primitives
lib/       pure helpers — formatting, paths, the agent palette, icons
views/      one directory or file per view
```

A view that outgrows one file gets a directory beside it (`views/board/`,
`views/hygiene/`), holding its sections, its columns and its derivation hook.

## Conventions

These are the rules the code follows. They are not style preferences — each one is here because
breaking it produced a bug.

**Selectors return what the snapshot already holds.** `useSnapshot(s => s.sessions)` is fine;
`useSnapshot(s => new Set(...))` is not. The store compares by identity, so a freshly built value
always looks changed and the render loops forever (React #185). Derive with `useMemo` from a slice.

**Columns live at module scope**, as a `const` or a small factory taking the callbacks a cell needs.
Defining them inside a component makes the component's cognitive complexity climb past anything
readable — every view that broke the lint limit broke it this way.

**A view is composition.** Data comes from a hook, tables come from their column module, sections
come from components. If a view reads as a list of elements, it is right.

**Never wrap an `<svg>` in an element to inject it.** In a flex row the wrapper becomes the flex
item, so `align-items: center` centres the wrapper while the drawing sits on its baseline inside.
It also breaks every direct-child rule (`td:not(.td-tools) > svg.ph[width="14"]`,
`header .logo svg`), which is where the icon-alignment fixes live. Build a real element: `icon()`
does it from `window.ICON_PATHS`, `Mark` does it by lifting the viewBox out of what `artSvg`
generates.

**Reuse the stylesheet's class names; do not invent.** `styles/dashboard.css` came over verbatim
from the vanilla dashboard and is the spec. The sidebar wants `.proj` / `.st` / `.nm` / `.sel`,
stat cards want `.kpi` with `.l` / `.v` / `.d`. `bun tools/check-classes.ts` fails on a class with
no rule behind it.

**A control that was a `<div>` and is now a `<button>` needs its chrome reset** — border,
background, font, text-align, and `width: 100%` for a full-width row.

**No optimistic updates.** Every write in `api/actions.ts` re-polls and shows what the daemon did.
The ledger is the truth, and a claim the daemon refused must not flicker as held.

## Style

Google's TypeScript style guide, enforced by Biome where a rule exists — named exports only, no
`any`, no non-null assertions, `const` by default, `import type`, shorthand array types — and by
review where it does not. Exported symbols carry JSDoc, except a view component whose file header
already documents it; repeating it there would be noise.
