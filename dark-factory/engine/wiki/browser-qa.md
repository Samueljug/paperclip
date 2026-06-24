# Browser QA

Backlinks: [Wiki Home](README.md), [Evidence And Gates](evidence-gates.md)

## Purpose

Document the fail-closed browser, visual, responsive, and user-flow evidence contract.

## How It Works

Browser QA applies to UI, browser, visual, responsive, design, authenticated app-flow, and frontend/backend user-flow work. The QA lead should open a real Chromium/Webwright browser when the app can run, log in where required, test the exact changed workflow, capture screenshots proving the changed state, and capture video/trace for functional flows when feasible.

Foreman enforces the mechanical part:

- `browserEvidenceRequired()` returns true for `gates.browserQa`, `ui`, `fullstack`, or evidence requirements containing browser/screenshot/video.
- `record-gate --gate browser_qa` is rejected. Browser QA must be recorded using the dedicated `browser-qa` command so report, screenshot, and video requirements cannot be bypassed.
- `ready`, `push`, and `pr` repeat Browser QA evidence checks.

## Key Files And Commands

- [../foreman.mjs](../foreman.mjs)
- [../../pi-vs-claude-code/.pi/openclaw-teams/webwright-testing-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/webwright-testing-protocol.md)
- [../../paperclip-board/README.md](../../paperclip-board/README.md)

```bash
/Users/samuelimini/.openclaw/workspace/bin/webwright --help
node tools/dark-factory/foreman.mjs browser-qa --run RUN_DIR --report report.md --screenshot shot.png --summary "Browser QA passed"
```

## Source Files Inspected

- [../foreman.mjs](../foreman.mjs)
- [../../pi-vs-claude-code/.pi/openclaw-teams/webwright-testing-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/webwright-testing-protocol.md)
- [../../paperclip-board/README.md](../../paperclip-board/README.md)
- [../../paperclip-board/pr-task-sweeper.mjs](../../paperclip-board/pr-task-sweeper.mjs)
- `/Users/samuelimini/Development/dark-factory/05-verification-and-testing.md`

## Invariants And Guardrails

- Component tests, code inspection, and local harnesses are supporting evidence only; they do not replace browser evidence for app workflows.
- Screenshots are required for simple design/visual/responsive changes.
- Video plus tests/API evidence is required for functional frontend/backend/API or business-flow work.
- If browser, login, app reachability, credentials, or tenant/sandbox data are blocked, return BLOCKED with exact owner/action unless Samuel waives it.
- Do not put credentials into reports, comments, screenshots, prompts, or memory.

## Failure Modes

- Browser QA PASS can be blocked because screenshots exist but are not recorded in the Foreman evidence pack.
- A local harness can pass while the authenticated app flow is broken.
- Missing QA credentials or tenant data is a blocker, not a pass.
- Historical PRs may have Browser QA PARTIAL and still a PR gate PASS; readiness should remain blocked.

## When This Changes, Update

- [Evidence And Gates](evidence-gates.md) and [Gate Readiness Matrix](gate-readiness-matrix.md) for enforcement changes.
- [Pi/OpenClaw Team Protocols](pi-openclaw-team-protocols.md) for Webwright policy changes.
- [Runbooks](runbooks.md) for operator capture steps.

