# Foreman CLI

Backlinks: [Wiki Home](README.md), [Foreman Command Reference](foreman-command-reference.md)

## Purpose

Document the live deterministic runner at `tools/dark-factory/foreman.mjs`.

## How It Works

`foreman.mjs` is a Node CLI. It parses flags, reads JSON WorkOrders, validates the v0 WorkOrder contract, creates run folders, writes atomic JSON files, serializes mutations with `.foreman-mutation.lock`, appends Paperclip ledger events, and uses typed gate results for readiness.

This is distinct from the scheduled intake foreman documented in [Factory Intake And Foreman Scheduling](intake-foreman-scheduling.md). The LaunchAgent watches Paperclip Todo and hands cards to `pi-orchestrator`; this CLI owns deterministic run artifacts only after a WorkOrder-backed run exists.

It has three major responsibilities:

- Run lifecycle: `validate`, `start`, `start-from-paperclip`, `handoff-watchdog`, `quarantine`, `status`, `advance`, `evidence`, `reproduction`, `evidence-check`, `left-aside`.
- Gates and loops: `record-gate`, `review-gate`, `claude-judge`, `stage-token`, `browser-qa`, `worktree-check`, `no-mistakes`, `ready`, `loop-summary`, `iterate`.
- Shipping: `push`, `pr`, `pr-status`.

Foreman does not implement the code change itself. It controls evidence and gate state around work done by other agents or humans.

## Key Files And Commands

- [../foreman.mjs](../foreman.mjs)
- [../README.md](../README.md)
- [foreman-command-reference.md](foreman-command-reference.md)
- [gate-readiness-matrix.md](gate-readiness-matrix.md)
- [intake-foreman-scheduling.md](intake-foreman-scheduling.md)

Smoke commands:

```bash
node tools/dark-factory/foreman.mjs validate --workorder tools/dark-factory/examples/minimal-workorder.json
node tools/dark-factory/foreman.mjs start --workorder tools/dark-factory/examples/minimal-workorder.json
node tools/dark-factory/foreman.mjs start-from-paperclip --issue-json issue.json --workorder-out workorder.json --start true
node tools/dark-factory/foreman.mjs quarantine --run RUN_DIR
node tools/dark-factory/foreman.mjs status --run RUN_DIR
node tools/dark-factory/foreman.mjs ready --run RUN_DIR
```

## Source Files Inspected

- [../foreman.mjs](../foreman.mjs)
- [../README.md](../README.md)
- [../examples/minimal-workorder.json](../examples/minimal-workorder.json)
- [../examples/development-code-workorder.json](../examples/development-code-workorder.json)
- [../../paperclip-board/ledger-lib.mjs](../../paperclip-board/ledger-lib.mjs)
- [../worktree-health.mjs](../worktree-health.mjs)

## Invariants And Guardrails

- WorkOrder `acceptanceContract.frozen` must be true before a run starts.
- Implementation-type WorkOrders must include exactly one one-shot `plan_adversarial_review` loop.
- `record-gate` refuses `no_mistakes`, `push`, `pr`, `browser_qa`, `tests`, `oracle_baseline`, and `oracle_holdout`; those must use dedicated commands (`no-mistakes`, `push`, `pr`, `browser-qa`, `run-tests` respectively).
- Browser QA PASS cannot be recorded without screenshot-backed browser evidence (using the `browser-qa` command) unless waiver details are recorded. Video is also required for fullstack, user-flow, or video-required work.
- Stage tokens: Advancing to next stages requires preceding stage tokens (`PLAN`, `BUILD`, `VERIFY`, `QA`, `SECURITY`, `NO_MISTAKES`, `PR`) to be in `PASS` state (either recorded via `stage-token` or inferred from the corresponding gate result).
- GitHub Identity Guard: The `push` and `pr` commands verify the active GitHub login is exactly `Samueljug` before executing writes.
- Quarantine: A run is quarantined (blocked) if the git worktree is dirty, if another active run shares the same worktree, or if the run remains active and exceeds its staleness lifetime.
- Self-improvement/improver PASS cannot be recorded without an accountable owner/reviewer, allowed improver verdict, non-empty source coverage, missing coverage, and report artifact path; readiness also requires `improver_review` evidence.
- `ready`, `push`, and `pr` run worktree/evidence/gate checks and fail closed.
- Passing model or judge reviews become stale when HEAD or reviewed diff changes.

## Failure Modes

- The validator is hand-rolled v0 logic; JSON schema files document the intended shape but are not wired through a full schema validator in `foreman.mjs`.
- Dedicated commands can only enforce gates when teams route shipping through Foreman.
- LaunchAgent handoff can create visible motion on a Paperclip card without any of this CLI's gates running.
- A technical gate chain can be green but still blocked if the mandatory improver review/no-op evidence or Paperclip comment is missing.
- `claude-judge` depends on the external `claude` binary and local auth.
- `pr-status` and `pr` depend on GitHub CLI auth.
- `no-mistakes` depends on the installed No Mistakes CLI and a clean worktree.

## When This Changes, Update

- [Foreman Command Reference](foreman-command-reference.md) for command or flag changes.
- [Schemas And Artifacts](schemas-artifacts.md) for output shape changes.
- [Evidence And Gates](evidence-gates.md) and [Gate Readiness Matrix](gate-readiness-matrix.md) for readiness logic changes.
- [Factory Intake And Foreman Scheduling](intake-foreman-scheduling.md) if this CLI starts consuming intake cards or the intake foreman starts writing run artifacts.
- [Source Map](source-map.md) for new implementation files.
