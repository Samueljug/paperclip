# Second-Latest Update Policy

Samuel's update rule: when updating Pi, OpenClaw/Pi tooling, or repositories the
team uses, do not update to the newest release by default. Update only to the
second-latest stable/released version.

## Scope

This rule applies to:

- Pi itself.
- Pi extensions and packages.
- OpenClaw/Pi tool repositories used by the coding factory.
- Local helper tools such as Webwright, GBrain, no-mistakes, and observability
  tooling when they have clear stable releases.

Product repos and policy repos still follow Samuel's normal fresh-folder,
branch, test, PR, and review workflow. Do not silently mutate them as part of
maintenance.

## Version Selection

- Use registry or release metadata.
- Filter out prerelease, canary, nightly, beta, alpha, rc, and experimental
  versions unless Samuel explicitly asks.
- Sort stable versions semantically where possible.
- Select the second-latest stable version.
- If fewer than two stable versions exist, skip and report.
- If release ordering is ambiguous, skip and report.

## Pi

Do not use `pi update` for automatic maintenance because it can install the
latest release. Pin the exact second-latest package version instead.

As of 2026-06-06:

- Latest Pi package: `@mariozechner/pi-coding-agent@0.73.1`.
- Second-latest stable target: `@mariozechner/pi-coding-agent@0.73.0`.
- Current installed Pi version after maintenance: `0.73.0`.
- Nested runtime packages under Pi were also pinned to `0.73.0`:
  `@mariozechner/pi-ai`, `@mariozechner/pi-tui`, and
  `@mariozechner/pi-agent-core`.

After changing Pi, relaunch the OpenClaw Pi team and verify:

- `pi --version`
- `pi list`
- hub health
- live roster
- model split: `pi-orchestrator` GPT 5.5 xhigh, leads/workers GPT 5.4 high
- expected extensions/skills still load

## Git Repos

Only update a local tool repo when all are true:

- The repo is a tool repo, not a product or policy repo.
- The worktree is clean.
- A clear second-latest stable release/tag exists.
- The update can be pinned to that exact release/tag.
- Smoke checks are known or can be discovered.

If any condition is false or unclear, do not update. Report the blocker.

Dirty, tagless, or ambiguous repos are still audit targets. The maintenance
pass must check local dirty state, current HEAD, remote HEAD, releases/tags, and
whether a safe pinned update target exists. Do not collapse them into "skipped"
without saying what was checked and what would need approval or cleanup.

## CLI-First Tool Auth

For tools that support a local CLI, local OAuth, or plugin/skill bridge, prefer
that path by default. Missing standalone API keys such as `OPENAI_API_KEY` are
not update failures when the CLI or host-model path can perform the required
workflow. Report them as "standalone mode needs API key" instead.

If the CLI/plugin path is unavailable, broken, or lacks the required capability,
stop and report the exact key/credential Samuel needs to provide. Do not
silently downgrade, skip the tool, or pretend the standalone API mode passed.

## Scheduled Task

OpenClaw cron job:

- Name: `daily-second-latest-tool-updates`
- Job id: `1dcd2aa9-3d67-4036-b7d7-26cd59abb03c`
- Schedule: daily at `08:30` Australia/Sydney
- Behavior: isolated GPT 5.5 xhigh maintenance pass with announce delivery

The task should record meaningful changes in memory, update `TOOLS.md` when
installed versions change, and capture durable notes in GBrain when available.
