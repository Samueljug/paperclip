# 10 — Worker templates (selectable, CLI-routed)

Selectable worker templates in Paperclip. Each template is an agent whose every
call goes through the named LLM's CLI:
- `codex`  -> adapterType `codex_local`  -> `codex` CLI  (reasoning: minimal|low|medium|high|xhigh)
- `claude` -> adapterType `claude_local` -> `claude` CLI (reasoning/effort: low|medium|high)
- `gemini` -> adapterType `gemini_local` -> `gemini` CLI (reasoning: auto)

Templates are heartbeat-OFF: Paperclip does NOT auto-run them. You SELECT one on
demand — assign a task on the dashboard, or have OpenClaw wake it
(`POST /api/agents/:id/wakeup`). Each board agent name + title + metadata shows the
LLM, model, reasoning level, and CLI, e.g. "Tpl: Claude Opus 4.8 · high — via claude CLI".

## Files
- `worker-templates.json` — the registry. EDIT to make a new template (add a block);
  COPY a block + change `key` to duplicate by hand. Fields: key, llm, model, reasoning,
  fastMode(codex), label, note.
- `worker-templates.mjs` — the tool.

## Commands
    node worker-templates.mjs --list
    node worker-templates.mjs --sync [--dry-run]
    node worker-templates.mjs --duplicate <srcKey> <newKey> [--model M] [--reasoning R] [--label "..."]
    node worker-templates.mjs --new --key K --llm codex|claude|gemini --model M [--reasoning R] [--label "..."]
    node worker-templates.mjs --rollback [--key K]

## Tested 2026-06-13
- list / sync / idempotent re-sync (PATCH not duplicate) / --new / --duplicate / --rollback: all OK.
- Real CLI runs: Claude Haiku 4.5 -> `succeeded` exit 0 (real tokens); Gemini 2.5 Flash -> `succeeded` exit 0.
- Codex templates created+selectable but a green run is blocked by the OpenAI/Codex
  rate-limit (transient, resets ~2h) — adapter routing is identical, only the account is throttled.
- Model IDs must match the local CLI's account: this env uses claude-opus-4-8,
  claude-sonnet-4-6, claude-haiku-4-5-20251001 (the adapter's "known" 4-6/4-7 IDs were wrong here).
