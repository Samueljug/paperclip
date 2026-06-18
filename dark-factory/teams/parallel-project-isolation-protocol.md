# Parallel Project Isolation Protocol

Use this protocol when more than one Dark Factory or Pi team stream may run at
the same time, especially across Stage, Website, and Dev.

The target is not "one busy shared team with good intentions." The target is
separate factory cells that can run concurrently without cross-project state,
repo, prompt, memory, evidence, or tool bleed.

## Honest Claim

The system can be made parallel-safe by architecture, but not literally
"unlimited" in the physical sense. It is bounded by local CPU/RAM, model
budgets, ports, browser capacity, rate limits, GitHub checks, and human review
bandwidth.

So the desired property is:

- **unbounded-by-design:** adding another project stream creates another
  isolated cell rather than sharing mutable state
- **resource-bounded in practice:** the scheduler may throttle or queue streams
  when machine, model, browser, or GitHub capacity is saturated

## Isolation Unit

One project stream equals one factory cell:

```text
factory_cell_id = <work-area>-<repo-or-product>-<date-or-run-id>
```

Each cell must have its own:

- namespace / project id
- tmux session prefix
- coms-net hub session and port, unless the Foreman proves same-hub project
  isolation is sufficient for the task class
- top-level work folder under the correct `/Users/samuelimini/Development/*`
  parent
- repo clone(s), branch, and PR base
- `.factory/` control folder
- `.factory/runs/<run-id>/manifest.json`
- `.factory/runs/<run-id>/ledger.jsonl`
- `.factory/runs/<run-id>/evidence/`
- `.factory/no-mistakes-home`
- source/research dossier and architecture decision when used
- external-learning entries tagged with the cell id

No run may rely on a global mutable queue, daemon, shared scratch directory, or
ambient cwd.

## Launch Rule

Launch a separate Pi team for each project stream with a namespace:

```bash
OPENCLAW_PI_TEAM_NAMESPACE=stage-main-20260606 \\
  scripts/openclaw-team.sh full

OPENCLAW_PI_TEAM_NAMESPACE=website-20260606 \\
  scripts/openclaw-team.sh full

OPENCLAW_PI_TEAM_NAMESPACE=dev-legal-20260606 \\
  scripts/openclaw-team.sh full
```

The launcher derives separate defaults from the namespace:

- `PI_COMS_NET_PROJECT`
- tmux session prefix
- hub tmux session
- hub port

The normal default team remains `project=openclaw`, prefix `pi-team`, and port
`52965`.

For high-risk parallel work, prefer one hub per namespace. Same-hub,
different-project operation is allowed only after a conformance check proves
agent discovery, send, await, and logs cannot cross project ids.

## Work Folder Rule

Every coding task uses a fresh folder under the routed top-level parent:

```text
/Users/samuelimini/Development/Stage/<factory_cell_id>/
/Users/samuelimini/Development/Website/<factory_cell_id>/
/Users/samuelimini/Development/Dev/<factory_cell_id>/
```

Inside that folder:

```text
backend/ or frontend/ or website-repo/
.factory/
  manifest.json
  runs/<run-id>/
  no-mistakes-home/
  logs/
  evidence/
```

Do not put two independent project streams in the same work folder. Do not reuse
an older unrelated checkout for a new stream.

## Communication Rule

Every delegation prompt must include:

- `factory_cell_id`
- `task_id`
- work area: Stage | Website | Dev
- repo URL(s)
- branch and PR base
- absolute work folder path
- allowed write paths
- forbidden paths
- run folder path
- expected output artifact path

Any agent receiving a prompt without those fields must ask the orchestrator for
the missing cell metadata before acting.

## Memory And Evidence Rule

OpenClaw memory and Pi memory are separate. Pi memory is development-only.
Personal, general-assistant, reminder, life, or non-development facts must route
to OpenClaw memory instead of Pi role/project/run memory.

Shared role memory is allowed only for stable operating lessons. Task facts go
into the cell/run folder, not role memory.

Allowed shared memory:

- "Use task-scoped `NM_HOME` for no-mistakes."
- "Website PRs request `wdetcetera`."
- "GBrain captures for Pi team lessons use `pi-agent-teams` and
  `domain: development`."

Forbidden shared memory:

- "This task's PR is #123" unless tied to a task id.
- "Backend cwd is X" without a cell id.
- "Use the last branch" or "reuse the current clone."
- Any environment-specific assumption copied from another cell.
- Any personal or non-development memory about Samuel or OpenClaw.

Evidence must cite the cell/run folder. A verifier cannot accept evidence from a
different cell unless the evidence is explicitly imported and labelled.

## Tool Boundary Rule

No Mistakes:

- Set `NM_HOME` inside the cell's `.factory/no-mistakes-home`.
- Never use `~/.no-mistakes` or a shared daemon for parallel factory work.
- If no task-scoped mode is available, use the tested-direct-push fallback and
  record the degraded gate.

Claude Code:

- Pass the exact cell repo/work folder as `cwd`.
- Never run Claude from the OpenClaw workspace for product code decisions unless
  the task is explicitly about OpenClaw itself.

Browser/Webwright:

- Store screenshots, video, traces, and scripts under the cell evidence folder.
- Do not reuse browser state between cells unless the run explicitly creates and
  names an isolated browser profile.

External search/research:

- Store source matrices and architecture decisions under the cell run folder.
- If a source response mentions the wrong repo/product/environment, mark it
  contaminated and exclude it from evidence.

## Write-Scope Rule

Parallel writers are safe only when write scopes are disjoint.

Safe:

- one backend stream and one website stream in different cells
- read-only reviews across multiple cells
- backend and frontend workers in the same cell with explicit disjoint paths

Unsafe:

- two agents editing the same repo/file set
- one agent running cleanup commands in a parent `/Users/samuelimini/Development`
  folder
- one verifier using another cell's branch, PR, run folder, or evidence

## Conformance Checks

Before calling a multi-project run "watertight", implement and pass checks that
prove:

- two namespaced teams can run at once and see only their own project agents
- `stop` for one namespace does not stop another namespace
- no command writes outside the cell folder
- no No Mistakes state lands in `~/.no-mistakes`
- no evidence path from cell A appears in cell B's manifest
- no branch/PR/base from cell A appears in cell B's ledger
- GBrain captures include cell/task tags when they refer to task-specific facts
  and include `domain: development`, preferably in the `pi-development` source
- a verifier rejects evidence from the wrong cell
- a contaminated source/research result is excluded

Until these checks pass, concurrent multi-project operation remains supervised
and should not be described as fully autonomous.

## Stop Conditions

Stop the affected cell, not all cells, when:

- project id, namespace, cwd, repo, branch, or base branch is ambiguous
- an agent sees a task id or run folder that differs from its assigned cell
- a command touches another top-level work folder
- a shared daemon or global queue is detected
- a verifier finds cross-cell evidence contamination
- a tool cannot be scoped to the current cell

Escalate to OpenClaw with the cell id, exact command/output, and the smallest
safe next action.
