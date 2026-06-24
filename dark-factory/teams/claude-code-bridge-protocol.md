# Claude Code Bridge Protocol

Pi agents use OpenAI Codex OAuth as their normal model path. Claude Code is not
a Pi model provider here. When Claude-native behavior is needed, Pi can call the
local Claude Code CLI through the `claude_code_run` tool exposed by
`extensions/claude-code-bridge.ts`.

## When To Use It

Use `claude_code_run` for tasks that benefit from Samuel's existing Claude Code
setup:

- Extensive planning that needs deeper decomposition, tradeoff analysis,
  architecture sequencing, or multi-repo coordination.
- Running or interpreting Claude slash commands such as `/pre-pr`,
  `/create-pr`, `/review-auto-resolve`, `/post-pr`, `/security-swarm`, or
  `/no-mistakes`.
- Reusing Claude agents in `/Users/samuelimini/.claude/agents/`, especially
  high-signal reviewers such as `pre-push-reviewer`, `tenant-checker`,
  `api-contract-reviewer`, or `migration-checker`.
- Getting a second opinion when Pi agents repeatedly fail or disagree.
- Running Claude-native skills, hooks, and settings that are already installed
  under `/Users/samuelimini/.claude/`.

Prefer normal Pi/OpenAI work for ordinary implementation, quick planning, or
quick questions. Do not use Claude just because it is available.

## Default Model And Effort

Claude bridge calls default to:

```text
model: claude-opus-4-8
effort: max
```

Do not override the model or effort unless Samuel explicitly asks. This is
especially important for extensive planning.

The bridge enforces those defaults even if an agent passes a different
`model` or `effort`. Per-call model/effort overrides are ignored unless
`OPENCLAW_CLAUDE_BRIDGE_ALLOW_CALL_MODEL_OVERRIDE=1` is set for a run Samuel
explicitly requested.

## Required Inputs

Always pass:

- `cwd`: the exact fresh repo/work folder for the task.
- `prompt`: a bounded Claude prompt or slash-command text.

Good examples:

```text
claude_code_run(
  cwd="/Users/samuelimini/Development/Dev/task-123/frontend-legal",
  prompt="/pre-pr"
)
```

```text
claude_code_run(
  cwd="/Users/samuelimini/Development/Stage/task-456/quillio-backend",
  agent="tenant-checker",
  prompt="Review the current diff for tenant-isolation regressions. Return findings with file paths and evidence only."
)
```

## Safety Rules

- The bridge only allows `cwd` under `/Users/samuelimini/Development` or
  `~/.openclaw/workspace` by default.
- The team launcher loads `CLAUDE_CODE_OAUTH_TOKEN` from the macOS Keychain
  service `openclaw-claude-code-oauth-token` when the variable is not already
  set. Never paste or commit the token into repo files, prompts, or logs.
- Claude bridge runs default to `permissionMode=bypassPermissions` because
  Samuel explicitly approved unattended Claude Code terminal operation on
  2026-06-06. This only bypasses Claude Code's local tool-approval prompts; it
  does not bypass authentication, subscription usage limits, repo routing, or
  external-action safeguards.
- Treat Claude output as a review result, not an unquestioned instruction.
  Verify findings against the code and tests before editing.
- Claude Code subscription/usage limits can still apply. If Claude reports
  usage exhaustion or auth problems, report that plainly and continue with Pi
  where possible.
- Do not use the bridge to bypass Samuel's repo routing, fresh-folder, pre-PR,
  no-mistakes, or PR review rules.

## Evidence

Every Claude bridge call is also an external-learning event. The bridge writes
bounded metadata to:

```text
.pi/openclaw-teams/logs/external-agent-calls.jsonl
```

When a Claude bridge call affects a PR, plan, review, or gate decision, record:

- Prompt/command summary.
- CWD/repo/branch.
- Claude exit code.
- Findings or result summary.
- Follow-up verification commands run by Pi/OpenClaw.
- External-learning categories and whether the result was useful, redundant,
  noisy, a false positive, a missed issue, or a reusable improvement.

Keep raw long transcripts in the task evidence folder when useful; do not paste
long logs into chat.
