# Change Maintenance Contract

Backlinks: [Wiki Home](README.md), [Source Map](source-map.md)

## Purpose

Make documentation maintenance a required part of every Dark Factory change.

## How It Works

Every Dark Factory code, protocol, schema, prompt, runner, watcher, workorder behavior, gate, loop, artifact, Paperclip integration, intake bridge, scheduled handoff, or LaunchAgent behavior change must do one of these before it is considered complete:

- Update the relevant wiki page and [Source Map](source-map.md).
- Record a visible no-doc-needed reason in the PR body, commit message, Paperclip comment, Foreman evidence, or run ledger.

This is explicit because the live system is split across local code, `workspace-development/tools/factory-intake`, Paperclip helpers, Pi protocols, launchd, logs, and long-form design docs. Without this contract, bots cannot know which surface is authoritative.

## Key Files And Commands

Wiki root:

```text
tools/dark-factory/wiki/
```

Suggested checks:

```bash
find tools/dark-factory/wiki -name '*.md' -print
node tools/dark-factory/conformance.mjs
node tools/dark-factory/prompt-lint.mjs
```

## Source Files Inspected

- [../README.md](../README.md)
- [../foreman.mjs](../foreman.mjs)
- [../../paperclip-board/README.md](../../paperclip-board/README.md)
- `<FORK>/dark-factory/intake/README.md`
- `<FORK>/dark-factory/intake/factory-foreman.mjs`
- [../../pi-vs-claude-code/.pi/openclaw-teams/review-to-skill-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/review-to-skill-protocol.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/dev-policy-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/dev-policy-protocol.md)

## Invariants And Guardrails

- Behavior changes update docs or carry an explicit no-doc-needed reason.
- Source map updates are required when files move, new files own behavior, or old files stop being authoritative.
- `workspace-development/tools/factory-intake` behavior changes update [Factory Intake And Foreman Scheduling](intake-foreman-scheduling.md) or record a visible no-doc-needed reason.
- Do not document aspirational behavior as implemented.
- Mark current gaps honestly.
- Keep filenames lowercase/kebab-case for stable bot links.

## Failure Modes

- A protocol-only change can silently diverge from Foreman implementation.
- A schema change can leave the hand-rolled validator stale.
- A prompt change can affect agent behavior without a page explaining the new guardrail.
- LaunchAgent changes can alter live handoff behavior without touching `tools/dark-factory`.
- Intake changes can alter which tasks enter the factory without touching the deterministic Foreman CLI.

## When This Changes, Update

- This page first.
- [README.md](README.md) if the contract becomes stricter or looser.
- [Conformance And Testing](conformance-testing.md) if checks become mandatory.
