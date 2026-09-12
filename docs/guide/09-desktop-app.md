# Desktop app

Status: current

The desktop app is the same dashboard in a native window, with a tray icon, a bundled daemon and an updater. It is optional: the CLI and the browser dashboard do everything the app does.

## Download

Builds are published on [GitHub Releases](https://github.com/ra3orblade/swarm/releases). The website's download button picks the right one for your OS.

| OS | File | Notes |
|---|---|---|
| macOS (Apple silicon) | `.dmg` | Signed and notarized; opens without warnings |
| Windows (x86_64) | `.msi` or `.exe` | Not code-signed yet — SmartScreen will warn the first time |
| Linux (x86_64) | `.AppImage`, `.deb`, `.rpm` | Not signed. The AppImage auto-updates; the packages update through your package manager |

There is no Intel macOS build at the moment.

## Hooks still come from the CLI

The app bundles the daemon and the dashboard, not the Claude Code hook or the MCP server. To have sessions appear in it, install those once:

```sh
bunx @ra3orblade/swarm install
```

That writes the hook and MCP entries into `~/.claude/settings.json` exactly as `swarm setup` does. If you have already run `swarm setup`, nothing more is needed. See [Getting started](01-getting-started.md).

## What the app does on launch

1. If a daemon is already registered in `~/.swarm/daemon.json` and healthy — because you ran `swarm start`, or a clone's `bun run dev` is up — the app asks it to stop (over HTTP, the same clean path as `swarm stop`) and waits for it to go. The app **always runs its own daemon**: that is the only way it can promise the dashboard you see is the one this version shipped, not a stale bundle from wherever the other daemon was started.
2. It starts its bundled daemon as a sidecar. The daemon takes its preferred port (`[daemon] port` in your config, else 7777) and, if that is taken by anything else, **any free port** the OS hands out. The real port lands in `~/.swarm/daemon.json`, so the CLI, hook and MCP server all follow it; nothing ever needs 7777 to be free.
3. It shows a short splash, finds its daemon by pid in `daemon.json`, and loads the dashboard from it. If the bundled daemon failed to start, after a short grace period the window falls back to any healthy daemon on file rather than staying on the splash.

The CLI and the app see the same sessions, claims and resources because they read the same `daemon.json`. A daemon that refuses to stop (it requires a token, or predates the shutdown route) is left running; the app's daemon still registers, so hooks and the CLI follow the app's.

## Tray and window

The app lives in the tray (menu bar on macOS). The tray menu has three items:

- **Open Swarm** — show the window.
- **Check for Updates…** — see below.
- **Quit** — quit the app and stop the daemon it started.

**Closing the window hides it**; the app keeps running in the tray and the daemon keeps collecting. Bring the window back from the tray, or on macOS by clicking the dock icon. **Quit** (tray, or Cmd+Q on macOS) really quits, and takes the sidecar daemon down with it. The daemon also watches the app's pid on its own, so if the app crashes or is killed the daemon stops within a couple of seconds rather than living on invisibly.

On macOS the window uses an inset title bar: drag it by the dashboard header, double-click the header to maximise.

## Check for Updates…

The app asks GitHub Releases for a newer build, and every outcome shows a native dialog:

- **Update available** — "Swarm X is available (you have Y)". *Install & Restart* downloads it, verifies the signature, installs and relaunches; *Later* does nothing.
- **You're up to date**.
- **Update check failed** — with the error (usually: offline).

Updates are signed with Swarm's updater key and verified before install. This is the only time the app talks to the network on its own, and only when you click the item. On Linux only the AppImage can replace itself: a copy installed from `.deb`/`.rpm` says so and points you at Releases, because the package manager owns those files.

## Port behaviour and the CLI

With the app running, `swarm ui`, `swarm status` and the rest talk to the app's daemon through `daemon.json`, whatever port it landed on. `swarm stop` sends that daemon a SIGTERM; the app's window will show the daemon as disconnected until you quit and relaunch the app (which starts a fresh one). Starting a daemon by hand while the app runs — `swarm start`, or `bun run dev` in a clone — puts *that* daemon in `daemon.json`, and the app takes over again on its next launch. If you set `SWARM_HOME`, set it for the app's environment too, or it will look in `~/.swarm`.

## Feedback

The speech-bubble button in the header opens a GitHub issue form with the app version, OS and "desktop" prefilled.
