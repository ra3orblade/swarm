# Desktop app

Status: current

The desktop app is the same dashboard in a native window, with a tray icon, a bundled daemon and an updater. It is optional: the CLI and the browser dashboard do everything the app does.

## Download

Builds are published on [GitHub Releases](https://github.com/ra3orblade/swarm/releases). The website's download button picks the right one for your OS.

| OS | File | Notes |
|---|---|---|
| macOS (Apple silicon) | `.dmg` | Signed and notarized; opens without warnings |
| Windows (x86_64) | `.msi` or `.exe` | Not code-signed yet — SmartScreen will warn the first time |
| Linux (x86_64) | `.deb`, `.rpm` | Not signed. No AppImage yet |

There is no Intel macOS build at the moment.

## Hooks still come from the CLI

The app bundles the daemon and the dashboard, not the Claude Code hook or the MCP server. To have sessions appear in it, install those once:

```sh
bunx @ra3orblade/swarm install
```

That writes the hook and MCP entries into `~/.claude/settings.json` exactly as `swarm setup` does. If you have already run `swarm setup`, nothing more is needed. See [Getting started](01-getting-started.md).

## What the app does on launch

1. It looks for a daemon that is already running and healthy (via `~/.swarm/daemon.json`). If one is there — because you ran `swarm start`, or another copy of the app is open — it reuses it and does not start a second one.
2. Otherwise it starts its own daemon as a sidecar on a **free port** chosen by the OS. The port is recorded in `~/.swarm/daemon.json`, so the CLI, hook and MCP server all find it; nothing needs 7777 to be free.
3. It shows a short splash and then loads the dashboard from that daemon.

Because the daemon is shared, the CLI and the app always see the same sessions, claims and resources.

## Tray and window

The app lives in the tray (menu bar on macOS). The tray menu has three items:

- **Open Swarm** — show the window.
- **Check for Updates…** — see below.
- **Quit** — quit the app and stop the daemon it started.

**Closing the window hides it**; the app keeps running in the tray and the daemon keeps collecting. Bring the window back from the tray, or on macOS by clicking the dock icon. **Quit** (tray, or Cmd+Q on macOS) really quits, and takes the sidecar daemon down with it — only a daemon the app itself spawned; one you started with `swarm start` is left alone.

On macOS the window uses an inset title bar: drag it by the dashboard header, double-click the header to maximise.

## Check for Updates…

The app asks GitHub Releases for a newer build, and every outcome shows a native dialog:

- **Update available** — "Swarm X is available (you have Y)". *Install & Restart* downloads it, verifies the signature, installs and relaunches; *Later* does nothing.
- **You're up to date**.
- **Update check failed** — with the error (usually: offline).

Updates are signed with Swarm's updater key and verified before install. This is the only time the app talks to the network on its own, and only when you click the item. Linux builds do not receive updates through the app yet; download the new `.deb`/`.rpm` from Releases.

## Port behaviour and the CLI

With the app running, `swarm ui`, `swarm status` and the rest talk to the app's daemon through `daemon.json`, whatever port it landed on. `swarm stop` sends that daemon a SIGTERM; the app's window will show the daemon as disconnected until you quit and relaunch the app or run `swarm start`. If you set `SWARM_HOME`, set it for the app's environment too, or it will look in `~/.swarm`.

## Feedback

The speech-bubble button in the header opens a GitHub issue form with the app version, OS and "desktop" prefilled.
