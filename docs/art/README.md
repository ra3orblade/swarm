# Brand assets

The mark is a pixel robot. It is drawn once, as a character grid in
[`packages/core/src/art.ts`](../../packages/core/src/art.ts), and **every** icon Swarm ships is
rendered from that one grid — the desktop and store icons, the tray template, the favicons, the
site's hero and header marks, the share image, the desktop splash screen, and the two files here.

- `swarm-mark.svg` — the head alone, transparent, for light or dark backgrounds. This is what the
  repository README puts at the top.
- `swarm-icon.svg` — the app icon: the simplified head on a dark rounded tile, at the macOS corner.

Both are **generated**. Do not edit them, and never paste a copy of the drawing anywhere else:

```sh
bun tools/icons.ts
```

Change the robot in `art.ts`, run that, and every mark moves together. These two files were the
last hand-drawn copies in the repository — a different motif entirely, kept from an earlier brand —
and they sat on the README long after everything else had been redrawn. That is the failure the
generator exists to prevent.

Palette (`ART_PALETTE`): a seven-step ramp from the accent `#a3e635`, darkest to lightest —
`O #415b15`, `K #53751b`, `D #5f851f`, `S #73a325`, `E #89c12d`, `M #a3e635`, `L #d3f39f` — on
`#0e1013`. The SVGs carry `shape-rendering="crispEdges"`; scale them with
`image-rendering: pixelated` to keep the pixels sharp.

`screens/` holds the dashboard screenshots used by the README and the site's carousel, re-captured
by `bun tools/screens.ts` against a running daemon with real data.
