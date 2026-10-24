# Security

Status: current

What your projects run, what of it is known to be bad, what is happening around it — and what Swarm does about it. Everything on this page is read from the lockfiles in your project roots and from public feeds; nothing is written into a repository, and the one thing that would send your dependency list anywhere is off until you turn it on.

## Stack — what each project runs

**Guard → Security → Stack.** Once a minute the daemon looks at every registered project for `bun.lock`, `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `uv.lock`, `poetry.lock` and pinned `requirements.txt` files — in the root and one level down, so a monorepo's `apps/api/requirements.txt` counts — and at the `uses:` lines of the workflows under `.github`. It re-reads a file only when its size or modification time moved, and lists every package with its version, its scope (runtime, development, or unknown for a transitive one) and the manifest it came from. A file it cannot parse is listed with the error instead of failing the scan.

Local, read-only, no network. `[security] stack = false` turns it off. An empty folder is an empty stack.

## Advisories — what of it is known to be bad

**Guard → Security → Advisories.** Off until you turn it on: press **Turn on advisories** on the tab (or run `swarm security advisories on`). That writes `~/.swarm/settings.toml`, the daemon's own file; it never edits `config.toml`. The other way is the config itself, which wins over the switch — if `config.toml` or the policy sets `advisories = false` outright, the tab says so and names the file:

```toml
# ~/.swarm/config.toml
[security]
advisories = true
```

With it on, every six hours and after a lockfile changes, the daemon asks [OSV](https://osv.dev) about the exact versions in the lockfiles and lists every advisory that applies: severity (the database's own word, or the CVSS 3.x base score banded), the advisory with its link, the package, the version you run and the first fixed one, the manifest, and when it was first seen. A version that leaves the lockfile resolves its row.

**What leaves the machine** is the query: the ecosystem, name and version of each dependency in the lockfiles — the project's dependency list — and nothing else. The tab says so while it is off, and gives the two lines to paste. `SWARM_OFFLINE=1` wins over the switch.

Three things happen once an advisory applies:

- **An incident.** At or above `advisory_min_severity` (default `high`), one `security.advisory` incident per advisory and project, with the fixed version in its reason. The webhook and the nav badge see it like any other incident.
- **The agent is told.** A session that starts in the project, or asks `swarm_context`, gets one line naming the open advisories with their fixed versions, so it avoids those versions and can upgrade when it touches the dependency.
- **Upgrade.** The row's **Upgrade** action dispatches an agent into its own worktree on the task `sec/<package>-<fixed>`. The prompt names the advisory, the manifest and the package manager the lockfile belongs to, asks for the gates, a commit naming the advisory and a pull request, and forbids unrelated changes. `[dispatch]` decides the profile and the sandbox as for any run; the Board shows it running.

## News — what is happening around it

**Guard → News.** The daemon reads a built-in list of public RSS / Atom sources every half hour — the projects' own security channels (Node.js, Python, PyPI, Django, PostgreSQL, GitHub, AWS, HashiCorp, Next.js), two authorities (CISA, CERT-Bund) and the security press — and matches every item against the packages your projects run. **The sidebar's project filter is the relevance filter**: a vendor's own channel is shown whole, the authorities and the press only when an item names something the selected project runs — a product (PostgreSQL, Next.js), an ecosystem (npm, PyPI), or a package by name. The words that matched sit on the row; *All items* shows what was fetched regardless.

**A paper, or a table.** By default the items set as a paper: a dateline per day, and under it the day's articles in tiers as a front page sets them — two heroes across the width, three features in a row, the rest as briefs — each card the link to the article, and a click marks it read. The heading switches to a table. A month calendar beside the items shades the days by how many articles they hold; a day narrows both views to itself. A picture comes from the feed, or from the article's own page, which the daemon reads once, head only; `[security] pictures = false` keeps it to the feeds.

The keywords come from the lockfiles, not from a list you maintain: products behind the packages, the ecosystems, and the declared runtime package names (transitive helpers are left out — a package called `which` would match every headline). `[security] keywords` adds your own words.

**Sources.** The **Sources** chip lists every source with its state and the last error. To add one, paste its URL there and press **Check**: the daemon fetches it once with the same reader it runs every round and says whether it parsed as RSS or Atom and how many items it holds — or the status and content type it got back, so a 403 is told from a page that is not a feed. A source that passes comes with the `[[security.feeds]]` block to paste. `kinds` picks which built-in kinds are read (the AI press is off by default), `feeds_off` skips a source by name. The request carries a `swarm/<version>` user agent and nothing about you; `news = false` or `SWARM_OFFLINE=1` stops it.

## Two more rules

Both `ask` by default; see [rules](03-rules-and-config.md).

- **`vulnerable_install`** — `npm i hono@4.6.3`, `pip install requests==2.19.0` and the pnpm / yarn / bun / uv / poetry forms, when that exact version has a known advisory. Answered from the advisory table on the machine, one local read, never a network call; silent until advisories are on.
- **`secret_commit`** — `git add .env`, a commit naming a credential file, or a `git commit` whose staged diff adds a token. The daemon reads `git diff --cached` at that moment, only then, and matches the added lines against vendor-prefixed shapes (AWS, GitHub, Anthropic, OpenAI, Slack, GitLab, Google, Stripe, npm, a private key block). The reason names the shape, never the value. A commit message that mentions `.env` is not a leak.

## From the terminal

```sh
swarm security stack
swarm security advisories [on|off] [--min high] [--all]
swarm security news [--kind vendor,press] [--days 7] [--unread] [--all]
swarm security feeds ls | feeds check [url]
swarm security report [--days 7]       # markdown per project, for an issue or a weekly note
swarm security refresh [stack|news|advisories]
```

Each takes `-p` (this project), `--project <name|path>` or nothing (every project), and `--json`. `swarm doctor` prints one `security:` line. See the [CLI guide](07-cli.md#security).

## Config

```toml
[security]
stack = true
advisories = false             # off until you set it; the query carries the dependency list and nothing else
advisory_min_severity = "high" # the incident threshold
news = true
news_days = 30
pictures = true                # the page of an article without a picture is read once for its Open Graph picture
refresh_minutes = 30
kinds = ["vendor", "authority", "press"]   # add "ai"
keywords = []
feeds_off = []
# [[security.feeds]]
# name = "Our vendor"
# url = "https://vendor.example/security.rss"
# kind = "vendor"              # vendor | authority | press | ai

[rules]
vulnerable_install = "ask"
secret_commit = "ask"
```

Global only (`~/.swarm/config.toml`, or `~/.swarm/settings.toml` for what the switch wrote): a repository's `.swarm.toml` cannot add a source or switch advisories on for the machine. The full reference is in [config](03-rules-and-config.md); what leaves the machine is spelled out in [privacy](10-privacy-and-faq.md).
