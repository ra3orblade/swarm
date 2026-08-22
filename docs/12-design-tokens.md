# 12 · Design tokens

Status: living. The dashboard's visual language.

The dashboard's entire visual language is defined as CSS custom properties in
`packages/web/public/index.html` (`:root` blocks at the top of the stylesheet).
**Rules never contain raw values** — no hex colors, no px font sizes, no
durations, no ad-hoc shadows. If a rule needs a value that doesn't exist yet,
extend the token set; don't inline a literal. That's what keeps the UI from
drifting as it grows.

## Inventory

| Group | Tokens | Notes |
|---|---|---|
| Surfaces | `--bg` `--panel` `--panel-2` `--line` `--line-2` | page, cards, table headers, borders |
| Text | `--fg` `--fg-2` `--dim` `--faint` | four-step foreground ramp |
| Accent | `--acc` `--acc-soft` `--acc-contrast` | brand green; soft = tinted fills (chips, pressed rows); contrast = text on a solid accent fill (theme-dependent) |
| Status | `--ok` `--warn` `--bad` + `-soft` pairs, `--violet` | states + assistant color |
| Charts | `--c0`…`--c7`, `--acc-1`…`--acc-5` | categorical (CVD-checked adjacent pairs) + one-hue ramp for heatmaps/part-to-whole |
| Type scale | `--fs-2xs`(10) `--fs-xs`(10.5) `--fs-sm`(11) `--fs-mono`(11.5) `--fs-md`(12) `--fs-menu`(12.5) `--fs-lg`(13) `--fs-xl`(14) `--fs-2xl`(22) | px sizes; `--mono`/`--sans` families |
| Elevation | `--shadow` `--shadow-pop` `--overlay` | card, popover/modal (theme-dependent), backdrop |
| Radii | `--r`(9) `--r-sm`(6) `--r-xs`(4) `--r-pill`(20) | |
| Motion | `--t-fast`(.12s) `--t-med`(.2s) `--t-in`(.32s) `--t-pulse`(2s) | hovers, dots, page fade-in, live pulse |
| Layout | `--hdr-h`(48) `--sb-w`(240) `--inset-tl`(96) | header height, sidebar width, macOS traffic-light inset |
| Spacing | `--pad-cell` `--pad-page` `--pad-ctl` `--pad-row` `--gap-sec` | recurring composites (table cells, page, buttons, list rows, section gap). One-off structural geometry (1px borders, tiny offsets) stays inline. |

Dark mode overrides only what differs, in two places (the `prefers-color-scheme`
block for the "system" theme and `[data-theme="dark"]` for the explicit toggle) —
keep them identical when editing.

Third-party surfaces bridge onto the same tokens: the fancy-menus theme
(`--fm-*`) is defined entirely in terms of Swarm tokens, so menus restyle
automatically with the theme.

## Checking for drift

```sh
# any raw hex / rgba / px font / duration outside token definitions is drift:
grep -nE '#[0-9a-fA-F]{3,8}|rgba?\(|font(-size)?:\s*[0-9]' packages/web/public/index.html \
  | grep -v -- '--[a-z-]*:'
```
