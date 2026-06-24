# Webwright Testing Protocol

Webwright is installed for Pi testing/browser agents at:

```text
/Users/samuelimini/.openclaw/workspace/tools/webwright
```

The stable wrapper command is:

```bash
/Users/samuelimini/.openclaw/workspace/bin/webwright
```

The Webwright skill loaded for testing agents is:

```text
/Users/samuelimini/.openclaw/workspace/tools/webwright/skills/webwright
```

## Auth Mode Rule

Use the local Webwright CLI/wrapper and Pi/OpenClaw-hosted skill mode by
default. `webwright doctor` may report missing standalone `OPENAI_API_KEY` or
Claude/Codex plugin manifests; treat that as "standalone LLM-loop mode needs
credentials/manifests," not as a blocker for CLI/skill-driven browser QA.

If a task specifically requires Webwright standalone LLM-loop mode and the
needed key or plugin manifest is missing, stop and report the exact missing
credential or manifest to Samuel. Do not silently skip browser QA.

## Installed Runtime

- Repo: `https://github.com/microsoft/Webwright`
- Local checkout: `tools/webwright`
- Python venv: `tools/webwright/.venv`
- Python: Homebrew Python 3.13
- Package: editable install of `webwright`
- Playwright browsers installed for this venv: Chromium and Firefox

## Who Gets It

The team launcher passes the Webwright skill to:

- `verification-lead`
- `browser-qa-lead`
- `test-engineer`
- `browser-tester`
- `visual-qa`

Use Webwright for long-horizon browser tasks, UI workflows, data extraction,
form filling, multi-step search/filter tasks, and cases where reusable scripts
plus screenshot evidence are more useful than one-off browser clicks.

## How To Use

Prefer the skill instructions when loaded. The wrapper exposes the package CLI:

```bash
/Users/samuelimini/.openclaw/workspace/bin/webwright --help
```

For coding-app QA, keep generated Webwright artifacts inside the task's fresh
repo clone or under `.pi/openclaw-teams/runs/<task-id>/webwright/` when the run
is not tied to a specific app repo.

Required evidence:

- `plan.md` or equivalent critical-point checklist.
- Final script or task script.
- Run log.
- Screenshots proving each critical point.
- Clear pass/fail summary linked to Samuel's original brief.

For UI, browser, visual, responsive, or authenticated user-flow work, Browser
QA is fail-closed:

- Open a real Chromium/Webwright browser session whenever the app can run.
- For authenticated app flows, use the restricted QA login note and log in to
  the app before testing. Do not copy credentials into reports, comments,
  screenshots, prompts, or memory.
- Test the exact workflow that changed, not only the surrounding page or a unit
  harness.
- Capture screenshots that prove the changed state after the interaction. For
  functional flows, capture video or a trace as well when feasible.
- Record evidence in the Foreman evidence pack, at minimum:
  `browser_qa` report plus one or more `screenshot` artifacts.
- Post the Browser QA result on the Paperclip ticket with the screenshot paths
  or URLs and the verdict. For Paperclip-backed Dark Factory tasks, use the
  Option B evidence protocol to create a `browser_qa_*` role comment and upload
  screenshots/videos as ticket attachments. Verify uploads with
  `GET $PAPERCLIP_API_BASE/issues/:issueId/attachments` and download content
  from `PAPERCLIP_ORIGIN + contentPath`.
- Do not mark Browser QA PASS from prose, code inspection, component tests, or
  a local harness alone. Do not treat Option B comment metadata as
  non-forgeable proof of who performed Browser QA; it is advisory/display-only
  board visibility.
- If Chrome cannot open, the app cannot be reached, login fails, credentials are
  missing, or the required tenant/sandbox data is unavailable, return BLOCKED
  with the exact owner/action. Do not let the task advance to No Mistakes, PR,
  merge, or Done unless Samuel explicitly waives the browser evidence.

Do not treat Webwright as a replacement for normal app test suites. It is an
additional browser automation and evidence tool. Still run the repo's lint,
typecheck, tests, build, and pre-PR/no-mistakes gates when relevant.
