# Artifact Reference

Backlinks: [Schemas And Artifacts](schemas-artifacts.md), [WorkOrders And Runs](workorders-runs.md)

## Purpose

Give bot-readable and human-readable notes for the core artifact shapes.

## How It Works

Artifacts are written as JSON files under the run directory. Foreman copies the input WorkOrder into the run, writes a manifest and evidence pack, and writes one JSON file per gate into `gates/`.

## Key Files And Commands

```text
tools/paperclip-data/factory-runs/<runId>/
  workorder.json
  run-manifest.json
  evidence-pack.json
  gates/<gate>.json
  evidence/
  left-aside/
  no-mistakes-output.txt
```

Commands:

```bash
node tools/dark-factory/foreman.mjs status --run RUN_DIR
node tools/dark-factory/foreman.mjs evidence-check --run RUN_DIR
node tools/dark-factory/foreman.mjs loop-summary --run RUN_DIR
```

Machine summary:

```yaml
workorder:
  owner: input author and Foreman validator
  current_writer: foreman start copies input to run folder
  must_include: schemaVersion, workOrderId, title, brief, repo, changeType, allowedWriteScope, acceptanceContract, coordination, gates, loop
run_manifest:
  owner: Foreman
  current_writer: foreman start, advance, gate, iterate, ready-adjacent commands
  single_source_for: currentStage, status, paths, gates, loops
evidence_pack:
  owner: Foreman
  current_writer: evidence, reproduction, evidence-check, pr-status
  query_by: item.kind
gate_result:
  owner: Foreman
  current_writer: record-gate, review-gate, claude-judge, evidence-check, no-mistakes, push, pr
ledger_event:
  owner: ledger-lib appendLedgerEvent
  current_writer: Foreman and Paperclip helpers
```

## Source Files Inspected

- [../foreman.mjs](../foreman.mjs)
- [../schemas/workorder.schema.json](../schemas/workorder.schema.json)
- [../schemas/run-manifest.schema.json](../schemas/run-manifest.schema.json)
- [../schemas/evidence-pack.schema.json](../schemas/evidence-pack.schema.json)
- [../schemas/gate-result.schema.json](../schemas/gate-result.schema.json)
- [../../paperclip-board/ledger-lib.mjs](../../paperclip-board/ledger-lib.mjs)

## Invariants And Guardrails

- Run manifest paths should be absolute paths to the run folder artifacts.
- Gate file path in `manifest.gates[gate].path` must point to a parseable GateResult file.
- Evidence hashes are computed when a file path exists and is a file.
- Ledger events are append-only JSONL and hash-chained.

## Failure Modes

- Manual edits can break ledger hash verification or gate/manifest consistency.
- A gate can show PASS in the manifest while its artifact path is missing if files were moved manually.
- Evidence kind strings are currently open strings, so typos can make required evidence appear missing.

## When This Changes, Update

- [Schemas And Artifacts](schemas-artifacts.md) for contract-level changes.
- [Source Map](source-map.md) if new artifact writers/readers are added.
- [Gate Readiness Matrix](gate-readiness-matrix.md) if artifact fields become readiness inputs.

