---
name: design-review
description: Review dashboard/UI changes for design-system and usability consistency. Trigger on "/design-review", "review the UI", or after editing packages/web. Reports findings; does not auto-fix.
---

# Design review

For changes under `packages/web`. **Report findings; don't edit** unless asked. Where possible, load the running dashboard in the browser (`swarm ui` / the daemon URL) and screenshot the affected view to check it for real.

## Checklist
1. **Theme tokens only** — colors/space via CSS custom properties (`--acc`, `--panel`, …); **no hardcoded hex** in new rules. Every color must resolve in **both light and dark** (test `data-theme` and `prefers-color-scheme`); no color defined only inside a media/`[data-theme]` block.
2. **Brand** — accent is grass-green/lime; the pixel mark stays crisp (`image-rendering: pixelated`); icons match the set already in use.
3. **Layout** — no horizontal body scroll; wide tables/charts scroll inside their own `overflow-x:auto`; relative units; the view holds up narrow.
4. **Legibility** — numbers tabular-aligned; truncation has a `title`; empty/loading/error states exist; status uses the established dot/badge vocabulary.
5. **Interaction & a11y** — keyboardable (focus states, `esc`/nav); destructive actions (force-release, delete) need a typed confirm; live updates don't steal scroll position.
6. **Truth** — the dashboard never shows state the CLI/`/v1` API can't; no invented data.

## Output
A ranked list of concrete issues (what, where, why it matters), most-impactful first, with a screenshot when you captured one. Note what's good briefly, then the fixes.
