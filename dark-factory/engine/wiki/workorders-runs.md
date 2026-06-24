# WorkOrders And Runs

Backlinks: [Wiki Home](README.md), [Schemas And Artifacts](schemas-artifacts.md)

## Purpose

Explain how a WorkOrder becomes a run folder, how runs are inspected, and what representative current data shows.

## How It Works

A WorkOrder is the frozen input contract for a factory run. `foreman start` validates it, computes a stable hash, creates `tools/paperclip-data/factory-runs/<issue-or-workorder>-<timestamp>/`, copies the WorkOrder into that run, creates an empty EvidencePack, creates a RunManifest, and appends `foreman_run_started` to the Paperclip factory ledger.

Representative data inspected:

- `OPE-34-20260609T002457Z`: had tests/security/evidence/no_mistakes/pr PASS, Browser QA PARTIAL, current stage `Human Final Review`, and status `blocked`.
- `OPE-36-20260609T041237Z`: legacy run manifest with no gate results and status `blocked`.
- OPE-36 ledger coverage: 164 events, hash chain valid, many event types including stage, gates, PR, Browser QA, review, and improvement-report events.
- OPE-202 ledger coverage: 3 events, hash chain valid, showing task creation and foreman handoff only.

These examples show both rich runs and thin/handoff-only runs. Do not infer missing behavior from thin historical data.

## Key Files And Commands

- [../examples/minimal-workorder.json](../examples/minimal-workorder.json)
- [../examples/development-code-workorder.json](../examples/development-code-workorder.json)
- [../foreman.mjs](../foreman.mjs)
- [../../paperclip-data/factory-run-ledgers/README.md](../../paperclip-data/factory-run-ledgers/README.md)

```bash
node tools/dark-factory/foreman.mjs start --workorder path/to/workorder.json
node tools/dark-factory/foreman.mjs status --run RUN_DIR
jq '{runId, issue, status, currentStage, gates, loop, loops}' RUN_DIR/run-manifest.json
node tools/paperclip-board/factory-log.mjs coverage --issue OPE-123
```

## Source Files Inspected

- [../examples/minimal-workorder.json](../examples/minimal-workorder.json)
- [../examples/development-code-workorder.json](../examples/development-code-workorder.json)
- [../foreman.mjs](../foreman.mjs)
- [../../paperclip-data/factory-runs/OPE-34-20260609T002457Z/run-manifest.json](../../paperclip-data/factory-runs/OPE-34-20260609T002457Z/run-manifest.json)
- [../../paperclip-data/factory-runs/OPE-36-20260609T041237Z/run-manifest.json](../../paperclip-data/factory-runs/OPE-36-20260609T041237Z/run-manifest.json)
- [../../paperclip-data/factory-run-ledgers/README.md](../../paperclip-data/factory-run-ledgers/README.md)

## Invariants And Guardrails

- Copy the exact WorkOrder into the run folder; run state should not depend on the mutable source WorkOrder path.
- The WorkOrder hash is part of the manifest.
- Run IDs are timestamped and sanitized.
- Run evidence belongs under the run folder or in explicit external artifact paths/URLs.
- Thin ledgers are not success evidence; they only prove the logged events happened.

## Failure Modes

- Reusing a WorkOrder template without updating `repo.workingDir`, branch, scope, or criteria can send work to the wrong place.
- Minimal smoke WorkOrders disable code gates and are not safe as coding-ticket templates.
- Historical runs can predate current loop/gate rules.
- A run can be blocked because browser QA was partial even when other gates passed.

## When This Changes, Update

- [Schemas And Artifacts](schemas-artifacts.md) if WorkOrder or run artifact shapes change.
- [Runbooks](runbooks.md) if start/status inspection changes.
- [Source Map](source-map.md) if run root or ledger root changes.

