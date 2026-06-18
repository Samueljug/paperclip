# OpenClaw And Pi Memory Boundary Protocol

Samuel wants OpenClaw/Dr Claw memory and Pi/Dark Factory memory to be separate.
OpenClaw is Samuel's general assistant memory. Pi memory is development-only.

## Ownership

OpenClaw / Dr Claw owns broad memory:

- Samuel's preferences, decisions, communication style, reminders, and personal
  context.
- OpenClaw global skills, tool setup, local machine setup, Apple Reminders,
  GBrain setup, and non-development operations.
- Big-picture ideas that are not yet routed into a concrete development task.
- Anything Samuel discusses that is about life, business direction, tools, or
  assistant behavior rather than a repo/run/PR.

Pi / Dark Factory owns development memory only:

- Repo routing, branch routing, reviewers, dev policy, design policy, and PR
  gates.
- Factory protocols, role lessons, project lessons, run folders, evidence,
  external-learning logs, verification results, and engineering lessons.
- Task-scoped facts tied to a factory cell, WorkOrder, repo, branch, run, PR,
  test, screenshot, video, or architecture decision.
- Development tooling behavior when it affects the factory, such as No Mistakes,
  Webwright, Claude Code bridge, Codex, Gemini, Firecrawl, X/Grok research
  adapters, or Pi launcher behavior.

## Hard Rule

Do not write personal, general-assistant, life, reminder, calendar, message,
health, finance, family, travel, or non-development memories into Pi role memory,
Pi project memory, Pi run folders, or Pi-side GBrain captures.

Even if Samuel explicitly says "remember this," route non-development memory to
OpenClaw memory. Pi may keep only a sanitized development pointer when needed,
for example: "OpenClaw owns the broader user preference; ask OpenClaw before
changing repo routing."

## Routing Test

Before writing memory, ask:

1. Is this fact directly useful for future development work, repo routing,
   verification, architecture, PRs, testing, security, or factory operations?
2. Can the fact be safely attached to a repo, project, task id, factory cell,
   protocol, tool gate, or engineering lesson?
3. Would a future Pi agent need this to avoid a development mistake?

If the answer is not clearly yes, do not put it in Pi memory. Put it in
OpenClaw memory instead.

## Storage Locations

OpenClaw memory locations:

- `/Users/samuelimini/.openclaw/workspace/memory/YYYY-MM-DD.md`
- `/Users/samuelimini/.openclaw/workspace/MEMORY.md`
- `/Users/samuelimini/.openclaw/workspace/TOOLS.md`
- OpenClaw memory search and the local GBrain instance for broad assistant
  context.

Pi development memory locations:

- `.pi/openclaw-teams/memory/roles/`
- `.pi/openclaw-teams/memory/projects/`
- `.pi/openclaw-teams/runs/<task-id>/`
- `.pi/openclaw-teams/logs/`
- Pi-side GBrain captures tagged and scoped as development memory.

## GBrain Scoping

GBrain has a dedicated non-federated Pi source:

```text
source: pi-development
path: /Users/samuelimini/.openclaw/workspace/tools/pi-vs-claude-code/.pi/openclaw-teams
```

Pi captures should use `--source pi-development` when available and must be
clearly namespaced:

```text
tag: pi-agent-teams
domain: development
factory_cell_id: <cell-id or none>
task_id: <task-id or none>
repo: <repo or none>
<short durable development lesson>
```

Never put broad personal context into a `pi-agent-teams` capture. If a Pi task
learns something non-development about Samuel, ask OpenClaw to store it instead.

Use the safe wrapper for local captures:

```bash
/Users/samuelimini/.openclaw/workspace/bin/gbrain-capture-safe --source pi-development "tag: pi-agent-teams
domain: development
factory_cell_id: <cell-id or none>
task_id: <task-id or none>
repo: <repo or none>
<short durable development lesson>"
```

The wrapper serializes local capture attempts, retries short PGLite lock stalls,
and queues failures to `memory/gbrain-capture-backlog.md` instead of blocking a
factory run.

## Task Facts

Task facts belong in the task or factory-cell run folder, not shared role memory.

Examples that must stay task-scoped:

- A branch name, PR number, failing test, cwd, evidence path, browser profile,
  No Mistakes home, or source result for one run.
- A temporary blocker, reviewer comment, environment variable, or credential
  availability note tied to one run.

Shared Pi memory may keep only stable development lessons, for example:

- "Website PRs into stage request `wdetcetera`."
- "Use task-scoped `NM_HOME` for parallel No Mistakes runs."
- "Research dossiers must separate verified facts from model opinions."

## Enforcement

- `self-improvement-lead` and `memory-librarian` enforce this boundary.
- If a proposed Pi memory update contains mixed personal and development
  content, split it. Store only the development part in Pi memory.
- If an external agent returns personal or irrelevant context, do not persist it
  in Pi memory or evidence. Summarize only the development-relevant part.
- Treat violations as memory contamination and record a correction in the
  relevant run notes.
