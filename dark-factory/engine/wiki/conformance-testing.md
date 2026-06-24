# Conformance And Testing

Backlinks: [Wiki Home](README.md), [Foreman CLI](foreman-cli.md)

## Purpose

Document lightweight checks that verify the factory tooling itself.

## How It Works

`conformance.mjs` creates temporary WorkOrders from the minimal example, starts two Foreman runs, checks that run folders/evidence packs/gates/No Mistakes homes differ, verifies readiness fails before evidence, records evidence including `improver_review`, records the mandatory `self_improvement` no-op gate, rejects an invalid empty improver gate, checks readiness, and runs parallel evidence/gate writes to prove per-run mutation locking does not drop updates. It also runs a TestContract cell that proves manual `tests` gates are rejected, pre-fix expected-failure evidence records `oracle_baseline`, visible tests record `tests`, holdout tests record `oracle_holdout`, and the mandatory improver gate is present before readiness can pass.

Other checks:

- `prompt-lint.mjs`: checks Pi team prompts that can act on work load shared protocol or include strict task-scope boundary text.
- `worktree-health.mjs`: dirty-worktree checker. By default (with no parameters), it scans the predefined development/tool roots (`DEFAULT_SCAN_ROOTS`) and run working directories. Specifying `--path` switches it to check only those explicit repositories.
- `regression-scenario.mjs verify`: checks regression scenario JSONL integrity and evidence paths.
- `workspace-development/tools/factory-intake/*.test.mjs`: checks intake description/media shaping and Todo handoff source/idempotency rules.
- `wiki-drift-check.mjs`: deterministic drift detector for this wiki (broken links, code-newer-than-doc staleness, LaunchAgent load-state vs STOPPED/LIVE claims, undocumented orchestration tools, Paperclip agent count). conformance.mjs runs it as the `wikiNoHardDrift` cell — **HARD wiki drift fails conformance**; warnings are surfaced for review. It is also the detection engine for the [Wiki Maintainer](../wiki-maintainer/instructions.md) routine.

## Key Files And Commands

- [../conformance.mjs](../conformance.mjs)
- [../prompt-lint.mjs](../prompt-lint.mjs)
- [../worktree-health.mjs](../worktree-health.mjs)
- [../regression-scenario.mjs](../regression-scenario.mjs)
- `<FORK>/dark-factory/intake/factory-intake.test.mjs`
- `<FORK>/dark-factory/intake/factory-foreman.test.mjs`

```bash
node tools/dark-factory/conformance.mjs
node tools/dark-factory/prompt-lint.mjs
node tools/dark-factory/worktree-health.mjs check --markdown
node tools/dark-factory/regression-scenario.mjs verify
cd /Users/samuelimini/.openclaw/workspace-development && node --test tools/factory-intake/*.test.mjs
```

## Source Files Inspected

- [../conformance.mjs](../conformance.mjs)
- [../prompt-lint.mjs](../prompt-lint.mjs)
- [../worktree-health.mjs](../worktree-health.mjs)
- [../regression-scenario.mjs](../regression-scenario.mjs)
- [../examples/minimal-workorder.json](../examples/minimal-workorder.json)
- `<FORK>/dark-factory/intake/factory-intake.test.mjs`
- `<FORK>/dark-factory/intake/factory-foreman.test.mjs`

## Invariants And Guardrails

- Conformance should stay local and should not require external credentials.
- Conformance writes test runs and ledgers under local factory data; it is not purely read-only.
- Factory intake tests should stay local/unit-only and must not require ClickUp, Paperclip, coms-net, or tokens.
- Dirty worktree checks are intentional readiness inputs, so conformance can fail in a dirty workspace.
- Prompt lint should fail action-capable prompts that omit the shared protocol or strict scope boundary.

## Failure Modes

- `conformance.mjs` can fail if the workspace run repo is dirty, because `foreman ready` checks worktree health.
- Prompt lint coverage is heuristic and name/text based.
- Regression scenario verification only checks JSON shape, duplicates, required fields, and evidence path existence; it does not run scenarios.
- There is no full JSON Schema/Ajv conformance test currently wired.
- TestContract conformance uses a local temporary git repo and simple command oracle; it proves Foreman mechanics, not seeded full-stack product behavior.
- There is no scheduled LaunchAgent integration test currently wired; launchd behavior is documented by plist inspection and daemon unit tests.

## When This Changes, Update

- [Foreman CLI](foreman-cli.md) when conformance coverage changes command behavior.
- [Schemas And Artifacts](schemas-artifacts.md) when schema validation becomes mechanical.
- [Change Maintenance Contract](change-maintenance-contract.md) if docs checks become required CI.
- [Factory Intake And Foreman Scheduling](intake-foreman-scheduling.md) when intake/handoff tests change behavior.
