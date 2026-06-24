# Schemas And Artifacts

Backlinks: [Wiki Home](README.md), [Artifact Reference](artifact-reference.md)

## Purpose

Document the persisted objects that make a Dark Factory run navigable by a human or bot.

## How It Works

The schema files in `tools/dark-factory/schemas/` describe the intended JSON contracts. The live Foreman currently validates WorkOrders with local JavaScript checks instead of a generic JSON Schema engine, then writes the artifacts into `tools/paperclip-data/factory-runs/<runId>/`.

Core artifacts:

- WorkOrder: frozen task contract plus explicit task route, repo, branch, allowed write scope, gates, evidence requirements, and loops.
- TaskRouteContract: route kind and source-of-truth decision that binds a WorkOrder to the intended repo URL, base branch, optional work branch, and optional local path.
- AcceptanceContract: frozen success criteria and intent-confirmation status.
- TestContract: verification-owned oracle contract with visible and optional holdout suites, expected evidence, protected paths, and amendment history.
- RunManifest: current run state, paths, stages, gates, loop states, repo info, and hashes.
- EvidencePack: evidence items with kind, path or URL, summary, sha256, and timestamp.
- GateResult: typed PASS/FAIL/PARTIAL/BLOCKED verdict with details and artifacts.
- Plan: intended plan object for approach, write scope, risks, and verification plan.

## Key Files And Commands

- [../schemas/workorder.schema.json](../schemas/workorder.schema.json)
- [../schemas/task-route-contract.schema.json](../schemas/task-route-contract.schema.json)
- [../schemas/acceptance-contract.schema.json](../schemas/acceptance-contract.schema.json)
- [../schemas/test-contract.schema.json](../schemas/test-contract.schema.json)
- [../schemas/run-manifest.schema.json](../schemas/run-manifest.schema.json)
- [../schemas/evidence-pack.schema.json](../schemas/evidence-pack.schema.json)
- [../schemas/gate-result.schema.json](../schemas/gate-result.schema.json)
- [../schemas/plan.schema.json](../schemas/plan.schema.json)
- [artifact-reference.md](artifact-reference.md)

```bash
node tools/dark-factory/foreman.mjs validate --workorder path/to/workorder.json
node tools/dark-factory/foreman.mjs evidence --run RUN_DIR --kind test --path output.txt --summary "..."
node tools/dark-factory/foreman.mjs run-tests --run RUN_DIR --suite visible --phase post --expect pass
```

## Source Files Inspected

- [../schemas/workorder.schema.json](../schemas/workorder.schema.json)
- [../schemas/task-route-contract.schema.json](../schemas/task-route-contract.schema.json)
- [../schemas/acceptance-contract.schema.json](../schemas/acceptance-contract.schema.json)
- [../schemas/test-contract.schema.json](../schemas/test-contract.schema.json)
- [../schemas/run-manifest.schema.json](../schemas/run-manifest.schema.json)
- [../schemas/evidence-pack.schema.json](../schemas/evidence-pack.schema.json)
- [../schemas/gate-result.schema.json](../schemas/gate-result.schema.json)
- [../schemas/plan.schema.json](../schemas/plan.schema.json)
- [../foreman.mjs](../foreman.mjs)
- `/Users/samuelimini/Development/dark-factory/12-glossary-and-appendix.md`

## Invariants And Guardrails

- `schemaVersion` is `1` for current live artifacts.
- WorkOrder IDs and loop IDs must use letters, numbers, dot, underscore, or dash.
- WorkOrders must include `taskRoute`; its repo URL, base branch, branch, and local path references must match the WorkOrder's repo fields.
- `taskRoute.kind=ambiguous_stage` is not runnable. Main app stage must use the `aila-quillio` backend/frontend stage repos; `aila-code` stage repos must be explicitly routed as legal/dev app work.
- Code, API, and fullstack WorkOrders must enable tests, security review, No Mistakes, evidence, and PR gates; UI/fullstack WorkOrders must enable Browser QA.
- Acceptance contracts must be frozen before work starts.
- Required TestContracts must be frozen before implementation starts, and the run manifest hash must continue to match the copied `test-contract.json`.
- Evidence items should use real file paths or URLs when they are file-backed evidence kinds.
- Gate verdicts are limited to `PASS`, `FAIL`, `PARTIAL`, or `BLOCKED`.

## Failure Modes

- Schema files can drift from Foreman's hand-rolled validator unless both are updated together.
- A copied WorkOrder can carry stale route references after repo, branch, or clone-path edits; Foreman rejects those before starting a run.
- Historical run manifests may not include newer fields such as `loops[]`.
- Historical runs may not include `testContractHash` or `protectedPaths`; enforce them for new WorkOrders that opt into `testExpectation.required=true`.
- Evidence paths may point to files that moved or were deleted.
- A mutable manifest can be corrupted by manual editing; Foreman's atomic writes and mutation lock are the normal safe path.

## When This Changes, Update

- [Artifact Reference](artifact-reference.md) with field-level changes.
- [WorkOrders And Runs](workorders-runs.md) if run layout changes.
- [Source Map](source-map.md) with any new schema or artifact writer.
- [Conformance And Testing](conformance-testing.md) if schema validation coverage changes.
