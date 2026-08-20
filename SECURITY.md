# Security Policy

## Scope and threat model

Swarm runs entirely on your machine. The daemon listens on `127.0.0.1` only, stores state in `~/.swarm/`, and — apart from an optional model-price fetch (disable with `SWARM_OFFLINE=1`) — makes no outbound requests. It runs `git` and (in future milestones) spawns `claude` on your behalf: the same trust boundary as Claude Code itself.

The daemon can create git worktrees and read transcript files. It does **not** store credentials or secrets. Transcript contents (which may include code and prompts) are summarized into the local database; they never leave the machine.

## Reporting a vulnerability

Please report suspected vulnerabilities privately rather than in a public issue. Open a [GitHub security advisory](https://docs.github.com/en/code-security/security-advisories) on the repository, or contact the maintainers directly. Include steps to reproduce and the impact you observed. We aim to acknowledge within a few days.

Things we especially care about:

- Any path by which the localhost daemon could be reached or driven by a remote page or another user on the machine.
- Any way observed content (a web page, a repo file, a transcript) could cause Swarm to take an action — the ingestion layer must treat all such content as data, never instructions.
- Leakage of transcript or repository contents off the machine.
