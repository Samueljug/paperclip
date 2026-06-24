# Conductor

Backlinks: [Wiki Home](README.md), [Architecture](architecture.md), [Source Map](source-map.md)

## Purpose

Document the **Conductor** — the Paperclip-native, end-to-end pipeline driver that
turns one task into a tested, reviewed GitHub PR using Paperclip agents as the
executors. It is the orchestration path that emerged from the 2026-06-13 cutover
to Paperclip-as-control-plane, replacing the old Foreman-CLI-schedules / coms-net
pi-orchestrator handoff for automated code work.

Status (verified 2026-06-15): **live-being-proven**. The most recently modified
orchestration file in the tree (`conductor/conductor.mjs`, 2026-06-14). It has
opened real GitHub PRs end-to-end, but only against a **named sandbox repo**
(`Samueljug/df-conductor-sandbox`), not yet the production `quillio-backend` /
`quillio-frontend` repos.

## How It Works

`tools/dark-factory/conductor/conductor.mjs` is a deterministic pipeline driver.
Given a task, a target repo, and a base branch it runs one coordinated lane:

1. **Clone + branch** — shallow-clone the repo, create an isolated work branch.
2. **Implement** — invoke a Paperclip agent via the heartbeat invoke API
   (`POST /agents/:id/heartbeat/invoke`) and poll `GET /heartbeat-runs/:runId`
   until the implement run finishes. The agent does the code change in the clone.
3. **Gate** — run an arbitrary gate/test command; non-zero fails the lane closed.
4. **Stage + capture diff** — `git add -A`, capture the diff. A hard size limit
   (diffs over ~24 kB) **fails closed** to keep changes reviewable.
5. **Review** — invoke a _second_ Paperclip agent (the reviewer) the same way;
   validate its verdict before proceeding.
6. **Commit -> No-Mistakes gate -> PR -> watched issue** — commit; push through
   the `no-mistakes` proxy remote, which validates and only forwards to origin on
   pass (**fails closed**: no PR if NM fails; `DF_REQUIRE_NM=0` bypasses to a
   direct push); `gh pr create`; then create a Paperclip review issue (label
   `gate: no-mistakes-required`) so the no-mistakes-review-watcher also reviews it.
   So any agent that opens a PR via the Conductor goes through No-Mistakes.
7. **Report** — write a structured run record to `conductor/runs/run-<id>.json`.

Key safety property: the Conductor **refuses to drive `piRole`-bearing live team
agents** — it is designed to use probe/worker-template agents, not the standing
PiTeam roster, so a pipeline run can never hijack a live factory cell.

This is the Paperclip-native replacement for the Foreman CLI's _pipeline_ role.
The Foreman CLI (`foreman.mjs`) still exists as a per-run gate/evidence utility
(see [Foreman CLI](foreman-cli.md)), but it is invoked on demand, not as the
scheduler.

## Key Files And Commands

- [../conductor/conductor.mjs](../conductor/conductor.mjs): the pipeline driver.
- `../conductor/runs/run-<id>.json`: per-run records (e.g. `run-mqcvxw2m-386d7b`,
  the 2026-06-14 success that opened sandbox PR #3).
- `../conductor/seed/`: the throwaway-sandbox seed used to prove the lane.
- Paperclip heartbeat-invoke API on the live server (`127.0.0.1:3101`):
  `POST /api/.../agents/:id/heartbeat/invoke`, `GET /api/.../heartbeat-runs/:runId`.

## Source Files Inspected

- [../conductor/conductor.mjs](../conductor/conductor.mjs)
- [../conductor/seed/README.md](../conductor/seed/README.md)
- `../conductor/runs/` (run records)
- [../../paperclip/server/src/services/heartbeat.ts](../../paperclip/server/src/services/heartbeat.ts)

## Invariants And Guardrails

- Paperclip agents are the executors; the Conductor is the orchestration brain.
- Diff size cap fails closed — oversized changes are rejected, not merged.
- The Conductor never drives live `piRole` team agents; it uses probe/template agents.
- Implement and review are **separate** agents — the implementer is not its own reviewer.
- Production target repos are gated: prove on the sandbox before pointing it at
  `quillio-*`.

## Failure Modes

- Network/transport failures during a heartbeat invoke fail the lane (see the
  failed run `run-mqcvt973-7a44f9`, 2026-06-13).
- If the gate command is weak or absent, a bad change can still reach PR — the
  gate is only as strong as the command supplied.
- It is sandbox-proven only; pointing it at a production repo before hardening
  the gate/review steps is an open risk.

## When This Changes, Update

- [Architecture](architecture.md) when the orchestration topology changes.
- [Source Map](source-map.md) with the conductor entry point and run-record path.
- [Wiki Home](README.md) banner if the production-repo gating status changes.
