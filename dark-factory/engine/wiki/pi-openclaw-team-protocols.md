# Pi/OpenClaw Team Protocols

Backlinks: [Wiki Home](README.md), [Operating Model](operating-model.md)

## Purpose

Document the Pi/OpenClaw protocol files that govern Dark Factory team behavior.

## How It Works

The team protocols are policy and process documents under `.pi/openclaw-teams/`. They tell agents which repo to use, how to choose activation mode, how to isolate factory cells, how to write memory, how to run research, how to handle PRs, when to use Webwright, when to run verifier passes, and how repeated lessons become Skill Workshop or dev-policy proposals.

These protocols are not equivalent to mechanical enforcement. Foreman and scripts enforce some rules; others remain prompt/protocol obligations until wired.

The stage-gate relay carries a **Brief & Artifact Manifest** (issue document `brief-artifact-manifest`) and a **Coverage Matrix** (`coverage-matrix`) from the PLAN token onward, so Implementation, Verification, and Browser QA each receive the original brief + plan/scope + transcribed artifacts and check their work against every item. The 35 `PiTeam:` dev agents load these prompt files via `instructionsFilePath`, so edits here govern the live Paperclip agents. See [Brief Coverage Gate](brief-coverage-gate.md).

## Key Files And Commands

- [../../pi-vs-claude-code/.pi/openclaw-teams/prompts/shared-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/prompts/shared-protocol.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/dark-factory-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/dark-factory-protocol.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/repo-routing.md](../../pi-vs-claude-code/.pi/openclaw-teams/repo-routing.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/pre-pr-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/pre-pr-protocol.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/paperclip-option-b-evidence-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/paperclip-option-b-evidence-protocol.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/webwright-testing-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/webwright-testing-protocol.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/memory-boundary-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/memory-boundary-protocol.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/review-to-skill-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/review-to-skill-protocol.md)

Validation helper:

```bash
node tools/dark-factory/prompt-lint.mjs
```

## Source Files Inspected

- [../../pi-vs-claude-code/.pi/openclaw-teams/prompts/shared-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/prompts/shared-protocol.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/dark-factory-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/dark-factory-protocol.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/repo-routing.md](../../pi-vs-claude-code/.pi/openclaw-teams/repo-routing.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/dev-policy-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/dev-policy-protocol.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/stage-gate-relay-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/stage-gate-relay-protocol.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/paperclip-option-b-evidence-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/paperclip-option-b-evidence-protocol.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/dynamic-workflows-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/dynamic-workflows-protocol.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/update-policy-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/update-policy-protocol.md)

## Invariants And Guardrails

- Load `repo-routing.md` before planning or changing code.
- Use a fresh folder under the correct Development parent for every code task.
- Keep OpenClaw broad memory separate from Pi development-only memory.
- Use dynamic workflows as short-lived swarms, not top-level runner state.
- Repeated failures become evidence-backed review-to-skill requests, not direct live skill mutations.
- Tool updates target the second-latest stable release unless Samuel overrides.
- Brief/plan/scope/artifacts carry as Paperclip issue documents (`brief-artifact-manifest`, `coverage-matrix`), not the run folder; Implementation/Verification/Browser QA refuse to start without the manifest and check against every item.
- Samuel-visible Telegram updates are phone-readable summaries: short status
  line, grouped bullets, no raw path/SHA/log dumps, and details in Paperclip or
  run artifacts.

## Failure Modes

- Agents can claim a protocol was followed without evidence unless the run folder/ledger shows it.
- Protocol conflicts with Samuel instructions must be paused and resolved.
- Memory contamination can happen if personal assistant context is written into Pi memory.
- Dynamic workflow hidden state can become unrecoverable if not saved into run artifacts.

## When This Changes, Update

- [Operating Model](operating-model.md) for activation and relay changes.
- [Worktree, No Mistakes, And PR Shipping](worktree-no-mistakes-pr-shipping.md) for repo/PR rules.
- [Browser QA](browser-qa.md) for Webwright policy changes.
- [Source Map](source-map.md) for new or moved protocols.
