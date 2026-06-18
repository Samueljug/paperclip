# Dark Factory Wiki

Purpose: this wiki is the navigation layer for the live Dark Factory pilot. It connects the current runner code, Paperclip board tooling, Pi/OpenClaw protocols, design docs, launchd foreman, artifacts, gates, and current gaps.

> **⚠️ Orchestration cutover — 2026-06-13 (status verified 2026-06-15).**
> The factory was **cut over to Paperclip as the live control plane**. The old
> orchestration path described on several pages below — the launchd intake
> foreman (`com.openclaw.dark-factory-foreman`), the tmux pi-team lanes, the
> coms-net `pi-orchestrator` handoff, and the cron schedulers — is **STOPPED**
> (the LaunchAgents are not loaded; no tmux sessions; cron removed). See
> `paperclip-migration/cutover-backup/restore-notes.md`.
>
> **What orchestrates now:** Paperclip's own **heartbeat scheduler** (30s loop in
> `server/src/services/heartbeat.ts`) wakes and runs the factory team, which now
> lives as **~51 Paperclip agents** (mostly `claude_local`, plus
> `codex_local`/`gemini_local`/`process`/`openclaw_gateway`) executed via local
> CLI adapters. `pi-orchestrator` and `OpenClaw Coordinator` are now _Paperclip
> agents_, not external processes. The new end-to-end pipeline is the
> **[Conductor](conductor.md)** (implement → gate → review → PR via Paperclip
> agent invokes; sandbox-proven, not yet on production repos).
>
> **Still external / residual:** human intake (`factory-intake.mjs`), some gate
> watchers, and the openclaw **gateway** daemon (for `openclaw_gateway` agents;
> blocked by a known protocol-4 mismatch — patch staged, unapplied).
>
> Pages that still describe the old path as "live" are flagged stale inline:
> [Architecture](architecture.md), [Operating Model](operating-model.md),
> [Factory Intake And Foreman Scheduling](intake-foreman-scheduling.md),
> [LaunchAgent Foreman Daemon](launchagent-foreman-daemon.md), [Foreman CLI](foreman-cli.md).

## How It Works

Use this page as the category index, then follow backlinks and cross-links from each category page. Every category page keeps the same shape: purpose, how it works, key files/commands, source files inspected, invariants/guardrails, failure modes, and "When this changes, update..." notes.

The shortest route is:

1. [Architecture](architecture.md)
2. [Operating Model](operating-model.md)
3. [Factory Intake And Foreman Scheduling](intake-foreman-scheduling.md)
4. [Foreman CLI](foreman-cli.md)
5. [Evidence And Gates](evidence-gates.md)
6. [Worktree, No Mistakes, And PR Shipping](worktree-no-mistakes-pr-shipping.md)
7. [Change Maintenance Contract](change-maintenance-contract.md)
8. [Source Map](source-map.md)

## Category Index

- [Architecture](architecture.md): live topology, target topology, data flow, and current implementation gaps.
- [Conductor](conductor.md): the Paperclip-native end-to-end pipeline (implement → gate → review → commit → PR via Paperclip agent heartbeat invokes). The current orchestration path for automated code work.
- [Operating Model](operating-model.md): team activation, stage relay, ticket path, and how Foreman/Paperclip/Pi divide state.
- [Factory Intake And Foreman Scheduling](intake-foreman-scheduling.md): Telegram/ClickUp/manual intake, LaunchAgent schedule, Paperclip Todo claim/handoff, and the boundary with the deterministic Foreman CLI.
- [Foreman CLI](foreman-cli.md): deterministic run commands, command families, mutation locking, and shipping gates.
- [Schemas And Artifacts](schemas-artifacts.md): WorkOrder, AcceptanceContract, RunManifest, EvidencePack, GateResult, and Plan artifacts.
- [WorkOrders And Runs](workorders-runs.md): example WorkOrders, run directories, representative current run data, and run lifecycle.
- [Evidence And Gates](evidence-gates.md): readiness logic, required evidence by change type, gate results, and staleness rules.
- [Loops And Self-Improvement](loops-self-improvement.md): bounded loop architecture, loop state, improvement reports, regression scenarios, and review-to-skill.
- [Paperclip Integration](paperclip-integration.md): board statuses, ledgers, factory logging, task creation, improvement reports, and watchers.
- [Pi/OpenClaw Team Protocols](pi-openclaw-team-protocols.md): governing team protocols, memory boundary, dynamic workflows, and relay tokens.
- [Worktree, No Mistakes, And PR Shipping](worktree-no-mistakes-pr-shipping.md): fresh folder rule, dirty worktree checks, No Mistakes, PR reviewer routing, and PR status eligibility.
- [Browser QA](browser-qa.md): Webwright/Chrome evidence expectations and fail-closed browser gates.
- [Telemetry](telemetry.md): post-merge telemetry adapter shape, not-configured status, and loop health.
- [Conformance And Testing](conformance-testing.md): local conformance script, prompt lint, worktree health, and known test gaps.
- [Compliant Account Context Routing](compliant-account-context-routing.md): safe OPE-179/OPE-413 account registry, policy routing, static `CLAUDE_CONFIG_DIR` mapping, CLIProxyAPI boundary, and no-go examples.
- [Improver Subsystem](improver-subsystem.md): cross-run pattern mining, infra/disk health, the 2026-06-13 ENOSPC incident, and the open loop-closing step.
- [Brief Coverage Gate](brief-coverage-gate.md): brief/plan/artifact carry-through to phases 4/5/6, the manifest + coverage-matrix issue documents, and the enforcing Paperclip plugin (dry-run default).
- [Runbooks](runbooks.md): common operator flows for starting, advancing, gating, PR handoff, sweepers, and diagnosis.
- [Glossary](glossary.md): shared vocabulary.
- [Change Maintenance Contract](change-maintenance-contract.md): mandatory doc update/no-doc-needed policy for Dark Factory changes.
- [Source Map](source-map.md): bot-readable subsystem to file map.

## Key Files And Commands

- [../README.md](../README.md): concise project entry point.
- [../foreman.mjs](../foreman.mjs): live deterministic Foreman CLI.
- [../account-context-gateway.mjs](../account-context-gateway.mjs): safe account-context router for OPE-179/OPE-413.
- [source-map.md](source-map.md): bot-readable subsystem map.

```bash
find tools/dark-factory/wiki -name '*.md' -print
node tools/dark-factory/conformance.mjs
node --test tools/dark-factory/account-context-gateway.test.mjs
```

## Subpages

- [Foreman Command Reference](foreman-command-reference.md)
- [Artifact Reference](artifact-reference.md)
- [Gate Readiness Matrix](gate-readiness-matrix.md)
- [LaunchAgent Foreman Daemon](launchagent-foreman-daemon.md)
- [Factory Intake And Foreman Scheduling](intake-foreman-scheduling.md)
- [Paperclip Watchers](paperclip-watchers.md)
- [Loop Catalog](loop-catalog.md)

## Invariants

- Paperclip is the live control plane AND orchestrator: its heartbeat scheduler wakes and executes the agent team. (Historically it was "visible board only, not the runner" — that changed at the 2026-06-13 cutover; see the banner above.)
- The scheduled intake foreman in `workspace-development/tools/factory-intake` is **STOPPED** (LaunchAgent unloaded at the cutover). When it ran, it claimed and handed off Todo-ready Paperclip issues to coms-net; it was never the deterministic run/gate Foreman CLI.
- The Foreman CLI (`foreman.mjs`) is a **per-run gate/evidence utility invoked on demand**, not a scheduler or daemon. It owns typed run state, evidence packs, gate files, No Mistakes, push, and PR commands when a run is routed through it.
- Pi/OpenClaw protocols govern team behavior, but prompt compliance alone is not a hard mechanical gate.
- Browser/UI work is fail-closed without Browser QA report plus screenshot evidence unless Samuel explicitly waives it.
- No code/protocol/schema/prompt/runner/workorder behavior change is complete unless this wiki is updated or a no-doc-needed reason is recorded.

## Failure Modes

- A wiki page can drift from the live runner or protocol files; treat [Source Map](source-map.md) as the first place to update when authority changes.
- Target-design docs include behavior that is not fully wired into the live CLI. Category pages call out current gaps instead of presenting design targets as implemented.
- Large private logs and data directories are intentionally summarized, not pasted.

## Source Files Inspected

- [../README.md](../README.md)
- [../foreman.mjs](../foreman.mjs)
- [../conformance.mjs](../conformance.mjs)
- [../../paperclip-board/README.md](../../paperclip-board/README.md)
- [../../paperclip-data/factory-run-ledgers/README.md](../../paperclip-data/factory-run-ledgers/README.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/dark-factory-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/dark-factory-protocol.md)
- `<FORK>/dark-factory/intake/README.md`
- `/Users/samuelimini/Development/dark-factory/README.md`
- `/Users/samuelimini/Library/LaunchAgents/com.openclaw.dark-factory-foreman.plist`

When this page changes, update [Source Map](source-map.md) and [Change Maintenance Contract](change-maintenance-contract.md) if the navigation or documentation obligation changes.
