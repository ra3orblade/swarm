# Runtime resources

Status: current

Claims cover *code*. Runtime resources cover the things agents fight over while the code runs: the dev server on port 3000, the Postgres on 5432, the one worker process that must not be started twice. A resource is a named singleton that exactly one owner can hold at a time.

## Acquire, list, release

```sh
swarm res acquire dev-server --port 3000 --pid 48213
swarm res acquire db --port 5432
swarm res acquire fixtures --owner alice
swarm res ls
swarm res release dev-server
```

`swarm res ls` (or just `swarm res`):

```
port     dev-server       you          :3000
port     db               you          :5432
custom   fixtures         alice
```

Resources are scoped to the project of the current directory. Every command accepts `--json`.

Flags for `acquire`:

| Flag | Meaning |
|---|---|
| `--owner <name>` | who holds it; defaults to your username |
| `--pid <n>` | track this process; the holding lives while the pid is alive |
| `--port <n>` | the port this resource occupies; it becomes a protected port |

The kind shown in listings is derived: `port` when a port was given, `process` when only a pid was given, otherwise `custom`.

## Liveness

A holding blocks other owners only while it is alive:

- **pid-tracked** (`--pid`): alive while that process exists. When it dies the holding is reaped, so a crashed dev server stops blocking within seconds.
- **lease-tracked** (no pid): alive until its lease expires — **60 minutes** by default. Over MCP, `leaseMinutes` sets a different lease; the CLI always uses the default.

Dead holdings are reaped on the daemon's 5-second tick and lazily whenever someone tries to acquire the same name. Reaps are recorded in the event stream as `resource.reaped`.

## Fail-closed

Acquiring a name another owner holds is refused:

```
REFUSED: Resource "dev-server" is held by alice (pid 48213). Pick another name, coordinate with the holder, or wait for release/reap.
```

The same owner re-acquiring refreshes the holding instead — new pid, new port, fresh lease — so a restarted server can just acquire again.

Release is fail-closed too. Only the holder may release:

```sh
swarm res release dev-server                 # as the holder
swarm res release dev-server --owner alice   # on alice's behalf, if you are alice
swarm res release dev-server --force         # take it away from whoever holds it
```

A forced release by someone other than the holder is recorded in the event stream with `forced: true`.

## Auto-protected ports

Any port held as a resource joins the [`protected_ports` rule](03-rules-and-config.md) automatically, for every session on the machine, with no config change. Example:

```sh
swarm res acquire db --port 5432
```

From now on, if any agent tries

```sh
lsof -ti:5432 | xargs kill
```

Claude Code asks for confirmation (or denies, if `protected_ports = "deny"`) with the reason *Port 5432 is protected in the Swarm config — something the owner relies on is listening there. Don't kill it.* When `db` is released or reaped, 5432 is protected only if it is also in `rules.protected.ports`.

## Servers and workers

`swarm res acquire` records a process you already started. `swarm serve` starts one for you and does the bookkeeping:

```sh
swarm serve start --name web -- npm run dev
```

```
started web on :3400 (pid 48213)
  log: /Users/you/.swarm/logs/my-app/web.log
  stop: swarm serve stop web
```

What happened:

- The daemon picked the first free port from 3400 (`--from-port` to start elsewhere, `--port` to insist) — free meaning not held as a resource, not in use by another registered process, and actually bindable right now.
- The command ran detached, in your current directory, with `PORT` set (so `$PORT` in the command or `process.env.PORT` in the app both work), stdout and stderr appended to a log under `~/.swarm/logs/<project>/`.
- The pid was registered, together with its start time, and the singleton `web` was acquired for it — so a second `swarm serve start --name web` by anyone else is refused, and `:3400` is protected from every other session's `kill`, with no config.

`swarm proc start -- <cmd>` does the same for a worker that has no port. `swarm serve ls` / `swarm proc ls` list what this project started; `stop` sends SIGTERM and, after three seconds, SIGKILL.

Stop only ever signals a pid from the registry, and only while its start time still matches the one recorded — a recycled pid is never mistaken for ours, and nothing is ever killed by command pattern. A process that exits on its own disappears from the list within five seconds, its resource with it. The registry is per project; `swarm serve stop` in another checkout can't see, let alone stop, this one.

## On the dashboard

The **Board** view has a **Processes** section for everything started through `swarm serve` / `swarm proc` — name, kind, pid, port (a link), owner, command, uptime — with a *Stop* per row. Below it, held resources with name, kind, project (or *global*), owner, pid, port, and how long they have been held — with the remaining lease, or *pid-tracked*. The *Release* link force-releases the row; it is the human override, the same as `--force`. `swarm status` also lists held resources under the live sessions.

## From an agent

The MCP server exposes `swarm_acquire_resource` (`name`, optional `owner`, `pid`, `port`, `leaseMinutes`), `swarm_release_resource` (`name`, optional `owner`, `force`) and `swarm_resources`. An agent starting a dev server should pass the server's pid so the holding dies with it. See [MCP](08-mcp.md).
