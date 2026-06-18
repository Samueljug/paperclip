# Glossary

Backlinks: [Wiki Home](README.md)

## Purpose

Define terms used across the wiki, implementation, and protocols.

## How It Works

Use these terms consistently in WorkOrders, ledger events, run reports, and protocol updates.

## Key Files And Commands

- `/Users/samuelimini/Development/dark-factory/12-glossary-and-appendix.md`
- [../README.md](../README.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/dark-factory-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/dark-factory-protocol.md)

## Source Files Inspected

- `/Users/samuelimini/Development/dark-factory/12-glossary-and-appendix.md`
- [../foreman.mjs](../foreman.mjs)
- [../../paperclip-board/README.md](../../paperclip-board/README.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/stage-gate-relay-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/stage-gate-relay-protocol.md)

## Terms

- AcceptanceContract: frozen criteria and intent-confirmation object that defines success before work starts.
- Browser QA: real browser/Webwright/Chrome validation with screenshot-backed evidence for UI/user-flow changes.
- Brief & Artifact Manifest: the issue document `brief-artifact-manifest` holding the verbatim brief + instructions, accepted plan, in/out scope, and every artifact (media transcribed to `extracted_text`). Carried from the PLAN token onward. See [Brief Coverage Gate](brief-coverage-gate.md).
- Brief Coverage Gate: the `darkfactory.brief-coverage-gate` Paperclip plugin that blocks an issue from advancing unless its manifest is complete and its coverage-matrix is clean, via host blocker semantics. See [Brief Coverage Gate](brief-coverage-gate.md).
- Coverage Matrix: the issue document `coverage-matrix` mapping every brief item / acceptance criterion / artifact to `covered`/`uncovered`/`off_track` with evidence; extended by Implementation, Verification, and Browser QA.
- EvidencePack: run artifact listing evidence items by kind, path or URL, summary, hash, and time.
- Conductor: the Paperclip-native pipeline driver (`tools/dark-factory/conductor`) that runs implement → gate → review → commit → No-Mistakes gate (push through the `no-mistakes` proxy, fail-closed) → PR → watched Paperclip review issue, using Paperclip agents as executors. Post-2026-06-13-cutover orchestration path for automated code work. See [Conductor](conductor.md).
- Factory cell: isolated project stream with its own namespace, work folder, run folder, repo clone, branch, evidence, and tool state.
- Foreman: a **per-run gate/evidence CLI utility** (`tools/dark-factory/foreman.mjs`) that owns typed run state, gates, No Mistakes, push, and PR for runs routed through it. **It is not the scheduler.** The (now-stopped) launchd Paperclip Todo foreman was a separate handoff daemon.
- GateResult: typed gate verdict file with PASS/FAIL/PARTIAL/BLOCKED, summary, details, and artifacts.
- Heartbeat: Paperclip's in-server scheduler loop (`server/src/services/heartbeat.ts`, ~30s) that wakes agents (timer/assignment/routine) and executes them via adapters. **This is the live factory orchestrator** since the 2026-06-13 cutover.
- No Mistakes: pre-GitHub push/review gate that must bind to exact current HEAD and routed base.
- Paperclip: the **live control plane and orchestrator** — board, issue/status model, agent roster, and the heartbeat scheduler that runs the factory team. (Pre-cutover it was "board only.")
- Plan adversarial review: one-shot pre-implementation challenge asking the planning team what was missed, what errors exist, and whether conflicts exist.
- RunManifest: single run state file holding current stage, status, paths, gates, loops, and repo info.
- WorkOrder: frozen machine-readable task input for Foreman.

## Invariants And Guardrails

- Do not use "Done" to mean "handoff delivered"; Done requires PR outcome and local factory eligibility when PR-backed.
- Do not use "Foreman" ambiguously when launchd handoff foreman and Dark Factory CLI Foreman differ.
- Do not call `not_configured` telemetry a pass.

## Failure Modes

- Vocabulary drift can hide missing evidence or an unenforced design target.
- Historical docs use target-design terms that may not exist in live code yet.

## When This Changes, Update

- Any page using a renamed term.
- [Source Map](source-map.md) if term ownership changes.
- [Change Maintenance Contract](change-maintenance-contract.md) if documentation vocabulary becomes a required gate.
