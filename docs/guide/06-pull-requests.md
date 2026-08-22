# Pull requests

Status: current

The **PRs** view is one merge queue across every project Swarm knows about, GitHub and GitLab together. It reads through the forge CLIs you already have logged in, and it can squash-merge from the dashboard.

## Requirements

- For GitHub repos: the [`gh`](https://cli.github.com) CLI, authenticated (`gh auth status`).
- For GitLab repos: the [`glab`](https://gitlab.com/gitlab-org/cli) CLI, authenticated (`glab auth status`).
- The project's `origin` remote must point at a forge. Swarm recognises `github.com` and any `github.*` host as GitHub, and any host containing `gitlab` as GitLab, over SSH or HTTPS, including GitLab subgroups and self-hosted instances.

Projects whose remote is not a forge, or whose CLI is missing, simply contribute no rows. Swarm stores no tokens and makes no API calls of its own: every read is `gh pr list` or `glab mr list` run with the project root as its working directory, so `gh`/`glab` use whatever credentials they normally would.

## What's shown

One row per open PR or MR, newest first, across all projects (the sidebar selection does not filter this view):

| Column | Meaning |
|---|---|
| status dot | green when checks pass, amber when they fail, grey otherwise |
| repo | repository name, with a GitHub or GitLab icon |
| title | `#number title`, linking to the PR on the forge; a **Draft** badge when applicable |
| branch | the head branch |
| author | the author's login |
| checks | **Checks ✓**, **Checks ✗**, **Running…**, or `—` when the PR has no checks |
| review | **Approved**, **Changes** (changes requested), or `—` |
| age | time since the PR was opened |

On GitHub the check state is *fail* if any check failed, errored, timed out or was cancelled, *pending* if any is still queued or running, and *pass* otherwise. On GitLab it follows the head pipeline: `failed`/`canceled` is fail, `success` is pass, anything else is pending. GitLab rows show **Approved** when the MR has approvals; there is no "changes requested" state.

## Merging

A **Merge** link appears on rows that are:

- not failing checks (passing, pending or no checks at all),
- mergeable according to the forge (no conflicts), and
- not drafts.

Clicking it asks you to confirm, then runs `gh pr merge <n> --squash` or `glab mr merge <n> --squash --yes` in the project root. Merges are always squash merges. If the forge refuses — branch protection, a required review, a race with someone else — the CLI's error is shown in an alert and nothing else changes. After a successful merge the project is re-polled immediately so the row disappears.

Merging pending-checks rows is allowed on purpose: the forge enforces its own required checks, and you are the one confirming.

## Polling

PRs are polled per project with a **two-minute cache**: opening the view triggers a background refresh for any project whose data is older than that, and the view shows the cached queue meanwhile. A failed poll (CLI not installed, not authenticated, network down) keeps the previous rows rather than blanking the view. This keeps automated traffic far below anything rate-limit shaped, so leaving the dashboard open all day is fine.

Empty state: "No open pull requests. Agent branches land here the moment they're pushed."

## What leaves the machine

Only what `gh` and `glab` send on your behalf. Swarm never sees your forge tokens and never contacts GitHub or GitLab directly. See [Privacy and FAQ](10-privacy-and-faq.md).
