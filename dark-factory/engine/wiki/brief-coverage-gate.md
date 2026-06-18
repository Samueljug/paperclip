# Brief Coverage Gate

Backlinks: [Wiki Home](README.md), [Evidence And Gates](evidence-gates.md), [Pi/OpenClaw Team Protocols](pi-openclaw-team-protocols.md)

## Purpose

Guarantee that the **original user brief + accepted plan/scope + every artifact** (docs, files, images, and video/audio/PDF transcribed to text) reaches Implementation (phase 4), Verification (phase 5), and Browser QA (phase 6), and that each stage checks its work against **every** item — so the intended brief is fully covered and agents do not drift off-track.

## How It Works

Two layers — a protocol convention and an enforcing plugin.

**1. Carried context (protocol).** Planning builds a **Brief & Artifact Manifest** and the stages maintain a **Coverage Matrix**. Both are carried as **Paperclip issue documents** (not the run folder), so they survive Paperclip's siloed per-agent sessions and are board-visible:

- `brief-artifact-manifest` — verbatim brief + instructions, accepted plan, in/out scope, and every artifact with type/location plus a required `extracted_text` for each non-text medium. Written by Planning (`PUT /api/issues/{id}/documents/brief-artifact-manifest`), fetched by every downstream stage (`GET`).
- `coverage-matrix` — every brief item / acceptance criterion / artifact mapped to its implementation / verification / QA evidence with a `status` of `covered` / `uncovered` / `off_track`. Each stage extends it.

Both markdown documents must embed a fenced ```json block so the gate can check them deterministically (a markdown table alone is unreliable — its legend repeats the words `uncovered`/`off_track`):

```json
{
  "complete": true,
  "media_artifacts": [{ "id": "A1", "extracted_text_present": true }]
}
```

```json
{
  "rows": [
    { "item_id": "B1", "status": "covered", "required": true, "waived": false }
  ]
}
```

**2. Enforcement (plugin, no core edits).** The `darkfactory.brief-coverage-gate` Paperclip plugin subscribes to `issue.document.*`, `issue.updated`, and `agent.run.finished`. On each event it reads the two documents, parses the json blocks, and judges: the manifest must be `complete` with every media artifact transcribed; the coverage matrix must have no `uncovered` required row and no unwaived `off_track` row. The gate enforces by the host's own blocker invariant — in enforce mode it attaches a sentinel "Brief Coverage Gate — blocker" issue so the host's wakeup semantics refuse to advance, and detaches it when coverage clears. It never overrides Paperclip core (PLUGIN_SPEC §1 reserves hard gates for core; this plugin _uses_ the blocker→no-wakeup rule).

Modes (operator config):

- `enforce` (default **false** — DRY-RUN): observe + comment on a changed verdict, never block.
- `comment` (default true): post the verdict/reasons when they change.

The gate is **inert until manifest documents exist** — any issue without a `brief-artifact-manifest` document is skipped, so it never touches pre-existing work.

## Key Files And Commands

- [../../paperclip-plugins/brief-coverage-gate/src/gate.ts](../../paperclip-plugins/brief-coverage-gate/src/gate.ts) — pure manifest/coverage evaluation (unit-tested).
- [../../paperclip-plugins/brief-coverage-gate/src/worker.ts](../../paperclip-plugins/brief-coverage-gate/src/worker.ts) — event handlers, comment, sentinel blocker.
- [../../paperclip-plugins/brief-coverage-gate/src/manifest.ts](../../paperclip-plugins/brief-coverage-gate/src/manifest.ts) — capabilities + `instanceConfigSchema` (enforce/comment).
- [../../pi-vs-claude-code/.pi/openclaw-teams/stage-gate-relay-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/stage-gate-relay-protocol.md) — Manifest + Coverage Matrix definitions.

```bash
# Build + install into the factory instance (:3101), not the default :3100.
cd tools/paperclip-plugins/brief-coverage-gate && pnpm build
cd tools/paperclip && pnpm paperclipai plugin install \
  <FORK>/dark-factory/plugins/brief-coverage-gate \
  --api-base http://localhost:3101
pnpm paperclipai plugin inspect darkfactory.brief-coverage-gate --api-base http://localhost:3101
# Flip to enforcing only after validation: set plugin config { "enforce": true }.
```

## Source Files Inspected

- [../../paperclip-plugins/brief-coverage-gate/src/worker.ts](../../paperclip-plugins/brief-coverage-gate/src/worker.ts)
- [../../paperclip-plugins/brief-coverage-gate/src/gate.ts](../../paperclip-plugins/brief-coverage-gate/src/gate.ts)
- [../../paperclip/doc/plugins/PLUGIN_SPEC.md](../../paperclip/doc/plugins/PLUGIN_SPEC.md) — event catalog, `ctx.issues.relations`, blocker/wakeup semantics.
- [../../pi-vs-claude-code/.pi/openclaw-teams/stage-gate-relay-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/stage-gate-relay-protocol.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/verifier-contract-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/verifier-contract-protocol.md)

## Invariants And Guardrails

- The manifest + coverage carry as Paperclip issue documents; do not rely on the run folder for cross-stage context (sessions are siloed).
- The gate's verdict is derived from the documents' fenced ```json blocks, never from an agent's self-stated pass/fail.
- A media artifact without `extracted_text` is a blocking incomplete manifest — downstream models cannot read video/audio/raw blobs.
- Enforcement uses host blocker semantics only; the plugin does not edit Paperclip core or own the gate decision.
- Ships DRY-RUN; `enforce: true` is an explicit operator decision after the gate is seen judging correctly.
- The dev agents (35 `PiTeam:` agents, `pi_local`) load the relay/role prompts via `instructionsFilePath`, so protocol edits in `.pi/openclaw-teams/` govern the live Paperclip agents.

## Failure Modes

- If Planning never writes a `brief-artifact-manifest` document, the gate skips the issue (no enforcement) — coverage depends on Planning building the manifest.
- A manifest/coverage document without a parseable ```json block is treated as incomplete/unclean (blocking once enforce is on).
- Plugin edits hot-reload only while `pnpm dev` runs in the plugin dir; otherwise reinstall after a `pnpm build`.
- Enforce mode creates one sentinel blocker issue per company; do not close it (it is reused and detached automatically).

## When This Changes, Update

- [Evidence And Gates](evidence-gates.md) for gate/readiness changes.
- [Pi/OpenClaw Team Protocols](pi-openclaw-team-protocols.md) for manifest/coverage protocol changes.
- [Paperclip Integration](paperclip-integration.md) for plugin/board surface changes.
- [Glossary](glossary.md) for term changes.
- [Source Map](source-map.md) for new or moved files.
