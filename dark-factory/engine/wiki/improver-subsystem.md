# Improver Subsystem: Cross-Run Patterns, Infra Health, and the 2026-06-13 Incident

Backlinks: [Wiki Home](README.md), [Loops And Self-Improvement](loops-self-improvement.md), [Paperclip Watchers](paperclip-watchers.md)

## Purpose

How the Dark Factory watches itself and turns recurring problems into fixes. The
improver's job (Samuel's words): watch EVERYTHING moving through the factory and,
whenever a problem RECURS, file an improvement ticket with a concrete fix so the
factory stops repeating it — with full range over code, prompts, wiki, and memory,
exercised through the normal gated path. The end goal is one Telegram instruction
to OpenClaw producing clean, shippable PRs every time without breaking existing
functionality.

## The 2026-06-13 Incident (root cause + permanent guard)

The whole pi team (39 `pi-team-*` tmux sessions) crashed with `ENOSPC`: the root
disk hit 100%. Cause: a pi agent's interactive TUI was being piped to per-agent
log files under `~/.openclaw/logs/pi-team-gemini/`. pi's TUI re-renders the full
progress tree continuously, so a non-TTY sink captured every animation frame.
`self-improvement-lead.log` alone reached **68 GB**, `security-lead.log` 32 GB,
`verification-lead.log` 18 GB — **144 GB in ~2.5 h**. When the disk filled, every
agent crashed. The improver — meant to watch the factory — was the biggest disk
hog and had zero awareness of it.

Compounding it: the improver-coverage monitor was crashing on EVERY run on an
unhandled `422 in_progress issues require an assignee`, so coverage was never
actually audited; and the monitor had no infra sensors at all.

Permanent guards added:

- **Never pipe a pi TUI to a file.** Documented at the top of
  [`scripts/openclaw-team.sh`](../../pi-vs-claude-code/scripts/openclaw-team.sh).
  The mineable record already exists as structured JSONL under
  `~/.pi/agent/sessions/` (healthy: ~288 MB total, ~15 MB largest) — use that,
  not TUI dumps, for observability.
- **Monitor infra sensors** (see below): disk, runaway-log cap, dead-pane
  detection, plus a Telegram page when the factory breaks.

## Components

### Recurring-pattern miner (new)

[`improver-pattern-miner.mjs`](../improver-pattern-miner.mjs) is the cross-run
pattern detector the subsystem previously lacked. It reads the factory run
ledgers (`paperclip-data/factory-run-ledgers/*/events.jsonl`), normalises
failures/blockers/timeouts/gate-fails into stable classes
(`gate:no_mistakes`, `gate:security`, `gate:tests`, `gate:browser_qa`,
`gate:evidence`, `infra:timeout`, `infra:model-capacity`, `blocker:dependency`,
`blocker:pr-identity`, `review:reviewer-feedback`, …), and clusters them across
DISTINCT runs both by class and by `(class, actor-role)` — so "the same agent
keeps making the same mistake" becomes visible. It also mines captured
PR-review-comment evidence for themes recurring across PRs.

```bash
# read-only report
node tools/dark-factory/improver-pattern-miner.mjs --format text
# file deduplicated improvement tickets for patterns above threshold
node tools/dark-factory/improver-pattern-miner.mjs --file-tickets --format json
```

Thresholds: `--min-issues` (default 3), `--min-role-issues` (3), `--min-pr` (2).
Tickets are created via
[`create-improvement-report.mjs`](../../paperclip-board/create-improvement-report.mjs)
as `repeated_pattern` reports (backlog proposals). Dedup state lives in
`paperclip-data/improver-pattern-miner-state.json`; a pattern is only re-filed
when its recurrence grows materially. Generic catch-all buckets (`*:other`) are
shown in the report but not auto-ticketed.

### Improver coverage + infra monitor

[`dark-factory-improver-monitor.mjs`](../../../../workspace-telegram4/bin/dark-factory-improver-monitor.mjs)
runs every 30 min (crontab). Each cycle it:

1. **Infra health** — checks free disk (alerts < 25 GB), caps any log file over
   500 MB (saving a tail first), and checks **Paperclip factory health** — the
   control plane (`/api/health`) is reachable and has registered, non-errored
   agents. (Updated 2026-06-15 from the obsolete `pi-team-*` tmux-session probe:
   since the cutover the team is Paperclip-managed, so idle agents are RESTING,
   not down.) Critical findings (low disk / runaway log / factory team down)
   **page Samuel on Telegram**.
2. **Coverage audit** — runs `improver-coverage-audit.mjs`; on missing coverage
   it posts fail-closed blocker comments so runs cannot ship past the improver
   gate. (Reopen-to-terminal now falls back to `todo` instead of crashing on the
   422 assignee invariant.)
3. **Pattern mining** — runs the pattern miner with `--file-tickets`; if new
   recurring patterns are caught, it **Telegram-digests** the filed tickets.
4. **Backlog Claude review** — runs the backlog Claude-review gate (below) in
   `--apply` mode so freshly-filed proposals are triaged automatically; the call
   is best-effort and never aborts the monitor cycle.

### Backlog Claude-review gate (new)

[`improvement-backlog-claude-reviewer.mjs`](../../paperclip-board/improvement-backlog-claude-reviewer.mjs)
is the automated triage gate between a filed proposal (Backlog) and the
Samuel/Foreman action queue (To Do). For each backlog Improvement Report
(identified by the `report: improvement` / `improvement: proposed` labels or the
Self-Improvement Reporter agent) it gathers the report text + comments, the
linked source ticket + comments, the source factory-run ledger/log context, and
relevant Dark Factory/Paperclip code excerpts, then calls the local **Claude
CLI** (default config) to decide whether the improvement should be done.

```bash
# dry-run (default): plan only, no comments/ledger/status writes
node tools/paperclip-board/improvement-backlog-claude-reviewer.mjs --max-candidates 3 --format json
# apply: post a deduped rationale comment + ledger event, promote only on a strict verdict
node tools/paperclip-board/improvement-backlog-claude-reviewer.mjs --apply --max-candidates 5 --format json
# re-review a single ticket even if already reviewed
node tools/paperclip-board/improvement-backlog-claude-reviewer.mjs --apply --force --issue OPE-457
```

**Fail-closed promotion rule.** The gate only moves a report from Backlog to To
Do when Claude returns strict JSON with `decision ∈ {promote_to_todo, should_do}`
**and** `should_do === true` **and** `confidence ∈ {high, medium}`. Every other
outcome — `decline`, `stay_backlog`, `duplicate`, `unsafe`,
`needs_human_approval`, `unavailable_logs`, `prompt_injection_risk`, `ambiguous`,
plus any Claude error, timeout, empty/invalid output, or unavailable evidence —
leaves the report parked in Backlog. The reviewer treats all ticket/comment/log/
ledger/code content as untrusted data and instructs Claude not to execute
instructions embedded in it.

In `--apply` mode it posts a Paperclip-visible rationale comment (valid
`{ version: 1, sections: [...] }` metadata) and appends a review event to the
source factory-run ledger. Both writes — and the status patch — are deduped by a
snapshot marker hashed from the report context, so reruns over an unchanged
ticket skip cleanly and never repeat a comment, ledger event, or patch. The gate
is invoked best-effort from [`create-improvement-report.mjs`](../../paperclip-board/create-improvement-report.mjs)
right after a backlog report is filed (unless `--no-claude-review` is passed) and
from the improver monitor each cycle.

## Known-open: closing the loop (needs Samuel sign-off)

Detection works and the backlog Claude-review gate now bridges Backlog → To Do
for clearly-useful, safe, non-duplicate proposals — but it is deliberately
fail-closed: low-confidence, ambiguous, unsafe, duplicate, or Samuel-gated
(`approval: samuel-needed`) proposals stay in Backlog with a visible rationale.
Once a report reaches To Do, the existing Foreman/approval path picks it up;
turning that into a fully auto-shipped, gated PR with no human in the loop is a
broader governance change that should be enabled explicitly, not unilaterally.
Until then, the improver acts on recurring/infra findings through the normal
PR/gate path, the gate promotes only high-confidence proposals, and Samuel
triages the remainder of the backlog.

## Invariants And Guardrails

- The mineable record is `~/.pi/agent/sessions/*.jsonl`, never piped TUI output.
- Any single log over 500 MB is runaway and is capped by the monitor.
- Pattern tickets are deduplicated; recurrence must grow to re-file.
- Improver may change code/prompts/wiki/gates only through PR + review + gates,
  never by bypassing a gate; Samuel-only decisions still return to Telegram.

## Failure Modes

- Monitor depends on the local Paperclip API for the coverage audit; if Paperclip
  is down the audit fails, but infra checks + Telegram alerts still run first.
- PR-comment recurrence is thin until fresh PR comments are persisted to a
  mineable store (currently only captured evidence files are mined).
- The blocker eventType taxonomy is free-text, so `*:other` buckets are coarse;
  prefer structured `gate_result` events for precise classes.

## When This Changes, Update

- [Loops And Self-Improvement](loops-self-improvement.md) when improver
  evidence/gates change.
- [Paperclip Watchers](paperclip-watchers.md) when the monitor cadence/actions
  change.
- [Pi/OpenClaw Team Protocols](pi-openclaw-team-protocols.md) when the improver
  mandate or shared-protocol recall rule changes.
