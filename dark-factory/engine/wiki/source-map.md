# Source Map

Backlinks: [Wiki Home](README.md), [Change Maintenance Contract](change-maintenance-contract.md)

## Purpose

Provide a bot-readable map from documented subsystem to the files that implement or govern it.

## How It Works

Each entry names the subsystem, wiki page, implementation or protocol files, key commands, authority, and current gaps. Paths are local to the workspace unless absolute.

## Key Files And Commands

```bash
rg --files tools/dark-factory tools/paperclip-board tools/pi-vs-claude-code/.pi/openclaw-teams
node tools/dark-factory/foreman.mjs status --run RUN_DIR
node tools/paperclip-board/factory-log.mjs coverage --issue OPE-123
node --test tools/dark-factory/account-context-gateway.test.mjs
```

## Source Files Inspected

- [../README.md](../README.md)
- [../foreman.mjs](../foreman.mjs)
- [../conformance.mjs](../conformance.mjs)
- [../account-context-gateway.mjs](../account-context-gateway.mjs)
- [../account-context-gateway.test.mjs](../account-context-gateway.test.mjs)
- [../worktree-health.mjs](../worktree-health.mjs)
- [../loop-health-report.mjs](../loop-health-report.mjs)
- [../post-merge-telemetry.mjs](../post-merge-telemetry.mjs)
- [../regression-scenario.mjs](../regression-scenario.mjs)
- [../prompt-lint.mjs](../prompt-lint.mjs)
- [../../paperclip-board/README.md](../../paperclip-board/README.md)
- [../../paperclip-board/ledger-lib.mjs](../../paperclip-board/ledger-lib.mjs)
- [../../paperclip-board/factory-log.mjs](../../paperclip-board/factory-log.mjs)
- [../../paperclip-board/create-task.mjs](../../paperclip-board/create-task.mjs)
- [../../paperclip-board/create-improvement-report.mjs](../../paperclip-board/create-improvement-report.mjs)
- [../../paperclip-board/pr-task-sweeper.mjs](../../paperclip-board/pr-task-sweeper.mjs)
- [../../paperclip-board/pr-review-watcher.mjs](../../paperclip-board/pr-review-watcher.mjs)
- [../../paperclip-data/factory-run-ledgers/README.md](../../paperclip-data/factory-run-ledgers/README.md)
- [../../../skills/dark-factory-loop-architecture/SKILL.md](../../../skills/dark-factory-loop-architecture/SKILL.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/dark-factory-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/dark-factory-protocol.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/prompts/shared-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/prompts/shared-protocol.md)
- `<FORK>/dark-factory/intake/README.md`
- `<FORK>/dark-factory/intake/factory-intake.mjs`
- `<FORK>/dark-factory/intake/process-media.mjs`
- `<FORK>/dark-factory/intake/clickup-sync.mjs`
- `<FORK>/dark-factory/intake/factory-foreman.mjs`
- `<FORK>/dark-factory/intake/factory-intake.test.mjs`
- `<FORK>/dark-factory/intake/factory-foreman.test.mjs`
- `<FORK>/dark-factory/intake/config.example.json`
- `<FORK>/dark-factory/intake/clickup.config.example.json`
- `/Users/samuelimini/Development/dark-factory/README.md`
- `/Users/samuelimini/Library/LaunchAgents/com.openclaw.dark-factory-foreman.plist`

## Bot-Readable Map

```yaml
subsystems:
  orchestration:
    wiki: tools/dark-factory/wiki/architecture.md
    status: "LIVE since the 2026-06-13 cutover; replaced the launchd intake-foreman + pi-orchestrator + Foreman-CLI-as-scheduler path."
    authority:
      - tools/paperclip/server/src/services/heartbeat.ts
      - tools/paperclip/server/src/services/routines.ts
      - tools/paperclip/server/src/services/issue-assignment-wakeup.ts
    note: "Paperclip's ~30s heartbeat scheduler wakes agents (timer/assignment/routine) and executes the ~51 OPE-company agents (41 claude_local, 3 codex_local, 3 gemini_local, 3 process, 1 openclaw_gateway) via local CLI adapters in-process. This is the live factory orchestrator."
    current_gap: "Human intake (factory-intake.mjs) and some gate watchers remain external; openclaw_gateway adapter blocked by a protocol-4 mismatch (patch staged at tools/dark-factory/paperclip-migration/, unapplied)."
  conductor:
    wiki: tools/dark-factory/wiki/conductor.md
    status: "LIVE-being-proven (2026-06-14); sandbox-only, not yet on quillio-* production repos."
    implementation:
      - tools/dark-factory/conductor/conductor.mjs
    data_roots:
      - tools/dark-factory/conductor/runs
    note: "Paperclip-native pipeline: clone -> branch -> implement (agent heartbeat-invoke) -> gate -> stage diff (>~24kb fails closed) -> review (2nd agent) -> commit -> No-Mistakes gate (push via `no-mistakes` proxy remote, fail-closed; DF_REQUIRE_NM=0 bypasses) -> gh pr create -> watched Paperclip review issue (label `gate: no-mistakes-required`). Refuses to drive piRole live team agents."
    boundary:
      - "Uses probe/worker-template agents, not the standing PiTeam roster."
    current_gap: "Proven on Samueljug/df-conductor-sandbox (PRs #2/#3) only; gate strength equals the supplied test command."
  brief_coverage_gate:
    wiki: tools/dark-factory/wiki/brief-coverage-gate.md
    status: "LIVE (2026-06-15); installed in factory :3101 as darkfactory.brief-coverage-gate; DRY-RUN default (enforce=false)."
    implementation:
      - tools/paperclip-plugins/brief-coverage-gate/src/gate.ts
      - tools/paperclip-plugins/brief-coverage-gate/src/worker.ts
      - tools/paperclip-plugins/brief-coverage-gate/src/manifest.ts
    authority:
      - tools/pi-vs-claude-code/.pi/openclaw-teams/stage-gate-relay-protocol.md
    note: "Carries the Brief & Artifact Manifest + Coverage Matrix as Paperclip issue documents (brief-artifact-manifest, coverage-matrix) to phases 4/5/6; plugin blocks advance via host blocker semantics when the manifest is incomplete or coverage is unclean. No Paperclip core edits."
    current_gap: "Ships DRY-RUN; enforce=true is an operator decision after validation. Inert until Planning writes a brief-artifact-manifest document."
  architecture:
    wiki: tools/dark-factory/wiki/architecture.md
    authority:
      - tools/paperclip/server/src/services/heartbeat.ts
      - tools/dark-factory/foreman.mjs
      - tools/paperclip-board/ledger-lib.mjs
      - tools/pi-vs-claude-code/.pi/openclaw-teams/dark-factory-protocol.md
      - /Users/samuelimini/Development/dark-factory/03-target-architecture.md
    current_gap: "Wiki architecture.md 'five load-bearing surfaces' describe the PRE-2026-06-13-cutover path (launchd foreman/pi-orchestrator) and are flagged stale; orchestration is now the Paperclip heartbeat (see orchestration entry). Target holdout judge and seeded full-stack verification remain design targets."
  operating_model:
    wiki: tools/dark-factory/wiki/operating-model.md
    authority:
      - <FORK>/dark-factory/intake/factory-foreman.mjs
      - tools/pi-vs-claude-code/.pi/openclaw-teams/dark-factory-protocol.md
      - tools/pi-vs-claude-code/.pi/openclaw-teams/stage-gate-relay-protocol.md
      - tools/paperclip-board/README.md
    current_gap: "Some lanes are protocol obligations unless run through Foreman or watcher scripts."
  foreman_cli:
    wiki: tools/dark-factory/wiki/foreman-cli.md
    implementation:
      - tools/dark-factory/foreman.mjs
      - tools/dark-factory/README.md
    boundary:
      - "Not the scheduled intake foreman at <FORK>/dark-factory/intake/factory-foreman.mjs"
    commands:
      - validate
      - start
      - start-from-paperclip
      - handoff-watchdog
      - status
      - advance
      - evidence
      - reproduction
      - stage-token
      - browser-qa
      - evidence-check
      - run-tests
      - record-gate
      - review-gate
      - claude-judge
      - left-aside
      - quarantine
      - worktree-check
      - no-mistakes
      - ready
      - push
      - pr
      - pr-status
      - loop-summary
      - iterate
  schemas_artifacts:
    wiki: tools/dark-factory/wiki/schemas-artifacts.md
    schemas:
      - tools/dark-factory/schemas/workorder.schema.json
      - tools/dark-factory/schemas/acceptance-contract.schema.json
      - tools/dark-factory/schemas/test-contract.schema.json
      - tools/dark-factory/schemas/run-manifest.schema.json
      - tools/dark-factory/schemas/evidence-pack.schema.json
      - tools/dark-factory/schemas/gate-result.schema.json
      - tools/dark-factory/schemas/plan.schema.json
    writers:
      - tools/dark-factory/foreman.mjs
      - tools/paperclip-board/ledger-lib.mjs
    current_gap: "Foreman uses hand-rolled validation rather than executing these JSON Schemas."
  compliant_account_context_routing:
    wiki: tools/dark-factory/wiki/compliant-account-context-routing.md
    implementation:
      - tools/dark-factory/account-context-gateway.mjs
    tests:
      - tools/dark-factory/account-context-gateway.test.mjs
    commands:
      - "node tools/dark-factory/account-context-gateway.mjs decide --registry registry.json --request request.json"
      - "node tools/dark-factory/account-context-gateway.mjs validate-cliproxyapi --config cliproxyapi.json"
      - "node --test tools/dark-factory/account-context-gateway.test.mjs"
    boundary:
      - "Safe OPE-179/OPE-413 slice only."
      - "No random traffic distribution, stealth, anti-detection, consumer OAuth pooling, or cross-account fallback."
      - "CLIProxyAPI is modeled only as a single-account sidecar with native switching disabled."
    current_gap: "No daemon/server is wired; this is a deterministic module plus CLI harness."
  workorders_runs:
    wiki: tools/dark-factory/wiki/workorders-runs.md
    examples:
      - tools/dark-factory/examples/minimal-workorder.json
      - tools/dark-factory/examples/development-code-workorder.json
    data_roots:
      - tools/paperclip-data/factory-runs
      - tools/paperclip-data/factory-run-ledgers
  evidence_gates:
    wiki: tools/dark-factory/wiki/evidence-gates.md
    implementation:
      - tools/dark-factory/foreman.mjs
      - tools/dark-factory/worktree-health.mjs
      - tools/paperclip-board/ledger-lib.mjs
    authoritative_gates:
      - tests via foreman run-tests
      - oracle_baseline via foreman run-tests --phase pre
      - oracle_holdout via foreman run-tests --suite holdout
      - self_improvement via foreman record-gate plus improver_review evidence
    protocols:
      - tools/pi-vs-claude-code/.pi/openclaw-teams/verifier-contract-protocol.md
      - tools/pi-vs-claude-code/.pi/openclaw-teams/stage-gate-relay-protocol.md
  loops_self_improvement:
    wiki: tools/dark-factory/wiki/loops-self-improvement.md
    implementation:
      - tools/dark-factory/foreman.mjs
      - tools/dark-factory/loop-health-report.mjs
      - tools/dark-factory/regression-scenario.mjs
      - tools/paperclip-board/create-improvement-report.mjs
    protocols:
      - skills/dark-factory-loop-architecture/SKILL.md
      - tools/pi-vs-claude-code/.pi/openclaw-teams/review-to-skill-protocol.md
    current_gap: "Regression scenarios file was absent at inspection time; regression-scenario.mjs will create it on first add."
  paperclip_integration:
    wiki: tools/dark-factory/wiki/paperclip-integration.md
    implementation:
      - tools/paperclip-board/create-task.mjs
      - tools/paperclip-board/factory-log.mjs
      - tools/paperclip-board/ledger-lib.mjs
      - tools/paperclip-board/create-improvement-report.mjs
      - tools/paperclip-board/pr-task-sweeper.mjs
      - tools/paperclip-board/pr-review-watcher.mjs
      - <FORK>/dark-factory/intake/factory-intake.mjs
      - <FORK>/dark-factory/intake/factory-foreman.mjs
      - <FORK>/dark-factory/intake/clickup-sync.mjs
    data:
      - tools/paperclip-data/factory-run-ledgers/README.md
  factory_intake_foreman_scheduling:
    wiki: tools/dark-factory/wiki/intake-foreman-scheduling.md
    status: "STOPPED at the 2026-06-13 cutover — the com.openclaw.dark-factory-foreman LaunchAgent is unloaded; the scheduled Todo->pi-orchestrator handoff no longer runs. factory-intake.mjs (ticket creator) may still be run by hand. Kept as restore reference."
    source_area:
      - <FORK>/dark-factory/intake
    implementation:
      - <FORK>/dark-factory/intake/factory-intake.mjs
      - <FORK>/dark-factory/intake/process-media.mjs
      - <FORK>/dark-factory/intake/clickup-sync.mjs
      - <FORK>/dark-factory/intake/factory-foreman.mjs
    config_templates:
      - <FORK>/dark-factory/intake/config.example.json
      - <FORK>/dark-factory/intake/clickup.config.example.json
    tests:
      - <FORK>/dark-factory/intake/factory-intake.test.mjs
      - <FORK>/dark-factory/intake/factory-foreman.test.mjs
    launchagent:
      - /Users/samuelimini/Library/LaunchAgents/com.openclaw.dark-factory-foreman.plist
    logs:
      - /Users/samuelimini/.openclaw/logs/dark-factory-foreman.out.log
      - /Users/samuelimini/.openclaw/logs/dark-factory-foreman.err.log
    commands:
      - 'node tools/factory-intake/factory-intake.mjs --raw "TASK: ..." --chat-id "telegram:508625244" --message-id "123"'
      - "node tools/factory-intake/process-media.mjs --input PATH --out-dir tools/factory-intake/state/media-artifacts"
      - "node tools/factory-intake/factory-foreman.mjs --max 5"
      - "node tools/factory-intake/clickup-sync.mjs --import --dry-run"
    boundary:
      - "Creates and hands off Paperclip work; does not create RunManifest, EvidencePack, GateResult, No Mistakes, push, or PR artifacts."
    current_gap: "No launchd integration test is wired; daemon behavior is verified by plist inspection and factory-intake unit tests."
  pi_openclaw_protocols:
    wiki: tools/dark-factory/wiki/pi-openclaw-team-protocols.md
    protocols:
      - tools/pi-vs-claude-code/.pi/openclaw-teams/prompts/shared-protocol.md
      - tools/pi-vs-claude-code/.pi/openclaw-teams/dark-factory-protocol.md
      - tools/pi-vs-claude-code/.pi/openclaw-teams/repo-routing.md
      - tools/pi-vs-claude-code/.pi/openclaw-teams/dev-policy-protocol.md
      - tools/pi-vs-claude-code/.pi/openclaw-teams/pre-pr-protocol.md
      - tools/pi-vs-claude-code/.pi/openclaw-teams/stage-gate-relay-protocol.md
      - tools/pi-vs-claude-code/.pi/openclaw-teams/dynamic-workflows-protocol.md
      - tools/pi-vs-claude-code/.pi/openclaw-teams/memory-boundary-protocol.md
      - tools/pi-vs-claude-code/.pi/openclaw-teams/review-to-skill-protocol.md
      - tools/pi-vs-claude-code/.pi/openclaw-teams/update-policy-protocol.md
      - tools/pi-vs-claude-code/.pi/openclaw-teams/webwright-testing-protocol.md
  worktree_no_mistakes_pr:
    wiki: tools/dark-factory/wiki/worktree-no-mistakes-pr-shipping.md
    implementation:
      - tools/dark-factory/worktree-health.mjs
      - tools/dark-factory/foreman.mjs
      - tools/paperclip-board/pr-task-sweeper.mjs
    protocols:
      - tools/pi-vs-claude-code/.pi/openclaw-teams/repo-routing.md
      - tools/pi-vs-claude-code/.pi/openclaw-teams/pre-pr-protocol.md
      - tools/pi-vs-claude-code/.pi/openclaw-teams/parallel-project-isolation-protocol.md
  browser_qa:
    wiki: tools/dark-factory/wiki/browser-qa.md
    implementation:
      - tools/dark-factory/foreman.mjs
      - tools/paperclip-board/pr-task-sweeper.mjs
    protocols:
      - tools/pi-vs-claude-code/.pi/openclaw-teams/webwright-testing-protocol.md
  telemetry:
    wiki: tools/dark-factory/wiki/telemetry.md
    implementation:
      - tools/dark-factory/post-merge-telemetry.mjs
      - tools/dark-factory/loop-health-report.mjs
    current_gap: "No production telemetry adapter is configured in the inspected script by default."
  conformance_testing:
    wiki: tools/dark-factory/wiki/conformance-testing.md
    implementation:
      - tools/dark-factory/conformance.mjs
      - tools/dark-factory/wiki-drift-check.mjs
      - tools/dark-factory/prompt-lint.mjs
      - tools/dark-factory/worktree-health.mjs
      - tools/dark-factory/regression-scenario.mjs
      - <FORK>/dark-factory/intake/factory-intake.test.mjs
      - <FORK>/dark-factory/intake/factory-foreman.test.mjs
  launchagent_handoff_foreman:
    wiki: tools/dark-factory/wiki/launchagent-foreman-daemon.md
    status: "STOPPED/UNLOADED at the 2026-06-13 cutover. The .plist still sits in ~/Library/LaunchAgents but launchctl list/print do not show it; only ai.openclaw.gateway runs. Scheduling moved into the Paperclip heartbeat. Restore reference only."
    launchagent:
      - /Users/samuelimini/Library/LaunchAgents/com.openclaw.dark-factory-foreman.plist
    implementation:
      - <FORK>/dark-factory/intake/factory-foreman.mjs
    source_area:
      - <FORK>/dark-factory/intake
    logs:
      - /Users/samuelimini/.openclaw/logs/dark-factory-foreman.out.log
      - /Users/samuelimini/.openclaw/logs/dark-factory-foreman.err.log
    current_gap: "When loaded it handed Paperclip Todo tasks to pi-orchestrator; it did not create Dark Factory run manifests. Now unloaded."
  change_maintenance_contract:
    wiki: tools/dark-factory/wiki/change-maintenance-contract.md
    authority:
      - tools/dark-factory/wiki/change-maintenance-contract.md
```

## Invariants And Guardrails

- Treat this map as required bot navigation, not prose-only documentation.
- Every new authoritative Dark Factory file should appear here.
- Keep gaps explicit.
- Do not link secrets or raw private logs.

## Failure Modes

- A subsystem can move without this map changing, causing agents to read stale policy or code.
- A file can be protocol-only while the wiki implies it is mechanically enforced.
- Large data directories can be over-linked; use representative data and root directories instead.

## When This Changes, Update

- [README.md](README.md) if a new category is added.
- Relevant category pages for subsystem-specific changes.
- [Change Maintenance Contract](change-maintenance-contract.md) if the update rule changes.
