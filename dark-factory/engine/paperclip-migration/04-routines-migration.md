# 04 — Routines Migration (external schedulers → Paperclip routines)

**Workstream:** routines. **Goal:** make Paperclip the control plane for the recurring
schedulers that today run as **crontab** and **launchd** jobs, by re-creating them as
Paperclip **routines** with **schedule (cron) triggers** — _without_ the factory ever going
dark. Staged, reversible, one lane at a time. The external job and the Paperclip routine
**run in parallel first**; we compare; only then (a gated step) do we disable the external one.

This file is the routines half of the migration kit. Everything here is folder-scoped to
`<FORK>/dark-factory/engine/paperclip-migration`. No global
daemons are created. No destructive changes are made by the additive steps.

---

## 0. Ground truth (read from the real code, not assumed)

### 0.1 The external schedulers we are migrating

| #   | What                     | Mechanism                                                                    | Schedule                                            | Command (verbatim)                                                                                                                                                                                                                                          |
| --- | ------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | **improver-monitor**     | `crontab`                                                                    | `*/30 * * * *` (every 30 min)                       | `/bin/zsh -lc 'cd /Users/samuelimini/.openclaw/workspace-telegram4 && /opt/homebrew/Cellar/node/26.0.0/bin/node /Users/samuelimini/.openclaw/workspace-telegram4/bin/dark-factory-improver-monitor.mjs >> .../logs/dark-factory-improver-monitor.log 2>&1'` |
| B   | **dark-factory-foreman** | `launchd` (`~/Library/LaunchAgents/com.openclaw.dark-factory-foreman.plist`) | `StartInterval` `1800` (every 30 min) + `RunAtLoad` | `node <FORK>/dark-factory/intake/factory-watchdog.mjs --blocked-max 10 --foreman-max 10`                                                                                                                       |

**Important nuance — A is a bundle, not one task.** The improver-monitor
(`dark-factory-improver-monitor.mjs`, 641 lines) is an _orchestrator_ that, on every 30-min
tick, runs **three** distinct workloads in-process (verified in the file):

1. **Infra health** — `checkInfraHealth()`: low-disk check (<25 GB free), runaway-log capping
   (>500 MB → truncate + save tail), dead-tmux-pane scan. Sends Telegram alerts.
2. **Pattern-miner** — `runPatternMiner()` → `spawnSync(node, [improver-pattern-miner.mjs,
"--file-tickets", "--format", "json"])` (4-min timeout). This is the
   cross-run recurring-pattern detector that files deduplicated `repeated_pattern`
   improvement tickets via `create-improvement-report.mjs`.
3. **Improvement-backlog reviewer** — `runImprovementBacklogReviewer()` →
   `spawnSync(node, [improvement-backlog-claude-reviewer.mjs, "--apply",
"--max-candidates", "5", "--format", "json"])` (10-min timeout). This is the
   **PR/improvement sweeper** half — it reviews the improvement backlog and promotes
   candidates. Plus Telegram digests of newly-filed patterns.

So the prompt's "improver-monitor, pattern-miner, PR/improvement sweepers" are **the three
workloads inside job A** (the pattern-miner is _invoked by_ the monitor; it is not a separate
cron entry). We model them as **separate Paperclip routines** so each gets its own schedule,
assignee, transcript and run history — which is the whole point of moving to a control plane.

Exact paths (verified to exist):

- Monitor: `/Users/samuelimini/.openclaw/workspace-telegram4/bin/dark-factory-improver-monitor.mjs`
- Pattern-miner: `<FORK>/dark-factory/engine/improver-pattern-miner.mjs`
- Backlog reviewer / sweeper: `<FORK>/dark-factory/board/improvement-backlog-claude-reviewer.mjs`
- Foreman watchdog: `<FORK>/dark-factory/intake/factory-watchdog.mjs`

### 0.2 How Paperclip routines actually work (from the real code)

**Route handlers** — `server/src/routes/routines.ts`:

- `GET  /api/companies/:companyId/routines` — list (optional `?projectId=`).
- `POST /api/companies/:companyId/routines` — create a routine (body = `createRoutineSchema`).
- `GET  /api/routines/:id` — detail (includes triggers).
- `PATCH /api/routines/:id` — update (status, assignee, policies…).
- `POST /api/routines/:id/triggers` — add a trigger (`createRoutineTriggerSchema`).
- `PATCH /api/routine-triggers/:id` — enable/disable / change cron.
- `DELETE /api/routine-triggers/:id` — remove a trigger.
- `POST /api/routines/:id/run` — fire **once, now** (manual) — used for parallel-run smoke tests.
- `GET  /api/routines/:id/runs?limit=N` — run history (used for the comparison/cutover gate).
- `POST /api/routine-triggers/public/:publicId/fire` — webhook entrypoint (not needed for cron).

**Schemas** — `packages/shared/src/validators/routine.ts` + `constants.ts`:

`createRoutineSchema` fields:

```
projectId?            uuid | null
goalId?               uuid | null
parentIssueId?        uuid | null
title                 string (1..200)        # supports {{variable}} interpolation
description?          string | null          # also interpolated
assigneeAgentId?      uuid | null            # REQUIRED at dispatch time (see 0.3)
priority?             low|medium|high|urgent  (default medium)
status?               active|paused|archived  (default active)
concurrencyPolicy?    coalesce_if_active | always_enqueue | skip_if_active   (default coalesce_if_active)
catchUpPolicy?        skip_missed | enqueue_missed_with_cap                  (default skip_missed)
variables?            RoutineVariable[]       (default [])
env?                  envConfig | null
```

`createRoutineTriggerSchema` is a **discriminated union on `kind`**:

```
kind="schedule":  cronExpression  (required, non-empty)   timezone (default "UTC")   label?   enabled? (default true)
kind="webhook":   signingMode (default "bearer")   replayWindowSec (30..86400, default 300)   label?   enabled?
kind="api":       label?   enabled?
```

For our migration we only use **`kind="schedule"`**.

Enums (from `constants.ts`):

- `ROUTINE_CONCURRENCY_POLICIES = ["coalesce_if_active","always_enqueue","skip_if_active"]`
- `ROUTINE_CATCH_UP_POLICIES   = ["skip_missed","enqueue_missed_with_cap"]`
- `ROUTINE_TRIGGER_KINDS       = ["schedule","webhook","api"]`
- `ROUTINE_STATUSES            = ["active","paused","archived"]`

**Concurrency semantics** (what to pick, and why) — from `dispatchRoutineRun` /
`tickScheduledTriggers`:

- `coalesce_if_active` _(default)_ — if a run of this routine is still active when the next
  tick fires, **don't** start a second one; fold it in. **Best match for the foreman and the
  backlog reviewer**, which must never run two copies over the same git state.
- `skip_if_active` — drop the tick entirely if one is active. Good for the pattern-miner
  (a missed mining pass is harmless; double-mining wastes work).
- `always_enqueue` — queue every tick regardless. Avoid for these jobs (risks pile-up).

**Catch-up semantics:**

- `skip_missed` _(default)_ — if the server was down across several ticks, only run **once**
  on resume, not N times. This is what the old cron/launchd effectively did and is the safe
  choice for **all** of these routines.
- `enqueue_missed_with_cap` — replay each missed tick up to `MAX_CATCH_UP_RUNS`. **Do not
  use** here; it would fire a backlog burst of foreman/sweeper runs after any downtime.

### 0.3 A routine MUST have an assignee (hard requirement)

`dispatchRoutineRun()` throws `unprocessable("Default agent required")` when
`assigneeAgentId` (on the run **or** the routine) is null. So **every routine below must set
`assigneeAgentId`** to a real, registered Paperclip agent. Today only **3** agents are
registered in the dark-factory company (`adapterType: "process"`):

| Agent                     | id                                     | role       |
| ------------------------- | -------------------------------------- | ---------- |
| pi-orchestrator           | `be605938-5fa4-44ee-bea5-dcd5e624a871` | devops     |
| Self-Improvement Reporter | `9b8240f0-f0e8-4175-bd06-7534b8f43185` | researcher |
| OpenClaw Coordinator      | `ec2f4237-5d27-4675-a919-d4cbc45c55ca` | pm         |

Assignee mapping used below (best fit to existing agents — no new agents required for this lane):

| Routine                         | Assignee                                    | Why                                                                     |
| ------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| improver-monitor (infra health) | **OpenClaw Coordinator** (`ec2f4237…`)      | ops/coordination job; pm role owns factory health                       |
| pattern-miner                   | **Self-Improvement Reporter** (`9b8240f0…`) | this IS the self-improvement reporter's job (files improvement tickets) |
| improvement-backlog sweeper     | **Self-Improvement Reporter** (`9b8240f0…`) | same self-improvement lane; reviews + promotes the backlog              |
| foreman / factory-watchdog      | **pi-orchestrator** (`be605938…`)           | the foreman drives pi runs; orchestrator owns execution                 |

> If the `00-agents` workstream registers dedicated agents (e.g. a `factory-foreman` or
> `self-improvement-lead` process agent), swap the ids — these are the only coupling points.

### 0.4 The single-instance scheduler caveat (CRITICAL — read before doing anything)

The routine scheduler is **in-process inside the Paperclip server**, not a separate daemon.
In `server/src/index.ts` (~line 766) a single `setInterval(…, config.heartbeatSchedulerIntervalMs)`
loop calls `routines.tickScheduledTriggers(new Date())` every **30 s** (default; floor 10 s).
The whole block is gated by `config.heartbeatSchedulerEnabled`
(`HEARTBEAT_SCHEDULER_ENABLED !== "false"`).

Consequences:

1. **There is no separate scheduler process to install or supervise.** If the live Paperclip
   instance is already running (it is — `GET /api/health` returns `status: ok`,
   `version 0.3.1`), the cron engine for routines is _already running_. Creating a routine with
   an `active` schedule trigger is enough — the next 30-s tick picks it up.
2. **The scheduler assumes a single server process per database.** `tickScheduledTriggers`
   claims each due trigger with a **compare-and-swap UPDATE** (`WHERE nextRunAt = <old> …
RETURNING`), so within _one_ process double-dispatch is prevented. But there is **no
   cross-process leader lock / advisory lock**. If two Paperclip server processes point at the
   **same** database, both tick loops race and you can get **duplicate routine runs**. **Never
   run a second Paperclip server against the live DB.** (This is also why "restart the live
   instance" is a gated step — see §4.)
3. **`HEARTBEAT_SCHEDULER_ENABLED=false` disables ALL of it** — routine cron ticks _and_ the
   heartbeat recovery loop (orphan reaping, retries, etc.). So you cannot turn off routine
   scheduling alone via env; if you need to pause a single routine, set that routine's
   `status: "paused"` or disable its trigger — do **not** kill the global scheduler.
4. **No precision guarantee.** Cron resolution is "next tick at-or-after `nextRunAt`", and ticks
   are 30 s apart. A `*/30 * * * *` routine fires within ~30 s of the half-hour — fine for these
   jobs, identical in practice to cron/launchd.

---

## 1. What "migrate" means here (control plane vs runtime)

We are **not** rewriting the job logic. Each routine's job is still the _same .mjs script_; we
just change **who triggers it and where the run is recorded**:

- **Before:** crontab/launchd fires `node …script.mjs` directly. No transcript, no run history
  in Paperclip, no governance, no cost attribution.
- **After:** Paperclip's in-process cron fires a **routine run** → creates an **issue**
  assigned to the mapped agent → that agent (a `process` adapter) executes the same script.
  Now there is a routine, run history (`GET /routines/:id/runs`), an activity log entry, an
  approval surface, and dashboard visibility.

**The execution glue is the `process`-adapter agent's command** — i.e. _what the
pi-orchestrator / Coordinator / Reporter agent actually runs when handed a routine-execution
issue_. That binding lives in the **agents/adapters workstream (00/02)**, not here. This file's
job is to define the **schedules and assignment**; it explicitly flags the adapter-command
binding as a prerequisite (§5) so we don't pretend a routine "runs the script" by magic.

---

## 2. Routine definitions (exact API payloads)

Base: `http://127.0.0.1:3101/api` · Company: `1e8bc12a-f8fd-431c-9fbd-e47be79446a3` ·
Project (dark-factory): `c4525f28-55d1-4378-864c-aec26d51fc37`.

All four start **`status: "paused"`** so creating them is 100% safe and side-effect-free — the
scheduler ignores paused routines (`tickScheduledTriggers` filters `routines.status = "active"`).
We only flip a routine to `active` during its own parallel-run window (§3), one at a time.

> **Auth note:** these calls need a board/agent actor the local Paperclip accepts. In
> `local_trusted` deployment mode (confirmed via `/api/health` →
> `deploymentMode: local_trusted`) local board calls are implicitly trusted; if your instance
> requires a token, set `PAPERCLIP_TOKEN` and add `-H "authorization: Bearer $PAPERCLIP_TOKEN"`.
> The `paperclip` skill / MCP server already knows how to authenticate — prefer it if available.

### 2.1 Routine — improver-monitor (infra health)

```json
POST /api/companies/1e8bc12a-f8fd-431c-9fbd-e47be79446a3/routines
{
  "projectId": "c4525f28-55d1-4378-864c-aec26d51fc37",
  "title": "Dark Factory — improver monitor (infra health)",
  "description": "Every 30 min: disk/log/tmux health for the factory. Runs dark-factory-improver-monitor.mjs (health portion). Migrated from crontab '*/30 * * * *'. Folder-scoped; read-mostly except log capping.",
  "assigneeAgentId": "ec2f4237-5d27-4675-a919-d4cbc45c55ca",
  "priority": "high",
  "status": "paused",
  "concurrencyPolicy": "skip_if_active",
  "catchUpPolicy": "skip_missed"
}
```

Then add the schedule trigger (use the `id` returned above as `:id`):

```json
POST /api/routines/:id/triggers
{ "kind": "schedule", "label": "every-30-min", "cronExpression": "*/30 * * * *", "timezone": "Australia/Sydney", "enabled": true }
```

### 2.2 Routine — pattern-miner

```json
POST /api/companies/1e8bc12a-f8fd-431c-9fbd-e47be79446a3/routines
{
  "projectId": "c4525f28-55d1-4378-864c-aec26d51fc37",
  "title": "Dark Factory — cross-run pattern miner",
  "description": "Every 30 min: improver-pattern-miner.mjs --file-tickets. Detects failure classes recurring across distinct runs and files deduplicated repeated_pattern improvement tickets. Was invoked inside the improver-monitor cron.",
  "assigneeAgentId": "9b8240f0-f0e8-4175-bd06-7534b8f43185",
  "priority": "medium",
  "status": "paused",
  "concurrencyPolicy": "skip_if_active",
  "catchUpPolicy": "skip_missed"
}
```

```json
POST /api/routines/:id/triggers
{ "kind": "schedule", "label": "every-30-min", "cronExpression": "5,35 * * * *", "timezone": "Australia/Sydney", "enabled": true }
```

> Offset to `:05/:35` so it doesn't tick at the exact same instant as the monitor — purely to
> spread load; the scheduler can handle them simultaneously, but staggering keeps transcripts
> readable.

### 2.3 Routine — improvement-backlog sweeper (the PR/improvement sweeper)

```json
POST /api/companies/1e8bc12a-f8fd-431c-9fbd-e47be79446a3/routines
{
  "projectId": "c4525f28-55d1-4378-864c-aec26d51fc37",
  "title": "Dark Factory — improvement-backlog sweeper",
  "description": "Every 30 min: improvement-backlog-claude-reviewer.mjs --apply --max-candidates 5. Reviews the improvement backlog and promotes up to 5 candidates. Was invoked inside the improver-monitor cron. coalesce_if_active so two sweeps never run over the same backlog.",
  "assigneeAgentId": "9b8240f0-f0e8-4175-bd06-7534b8f43185",
  "priority": "medium",
  "status": "paused",
  "concurrencyPolicy": "coalesce_if_active",
  "catchUpPolicy": "skip_missed"
}
```

```json
POST /api/routines/:id/triggers
{ "kind": "schedule", "label": "every-30-min", "cronExpression": "10,40 * * * *", "timezone": "Australia/Sydney", "enabled": true }
```

### 2.4 Routine — factory foreman / watchdog

```json
POST /api/companies/1e8bc12a-f8fd-431c-9fbd-e47be79446a3/routines
{
  "projectId": "c4525f28-55d1-4378-864c-aec26d51fc37",
  "title": "Dark Factory — foreman (factory-watchdog)",
  "description": "Every 30 min: factory-watchdog.mjs --blocked-max 10 --foreman-max 10. Claims tickets and advances runs. Migrated from launchd com.openclaw.dark-factory-foreman (StartInterval 1800). coalesce_if_active so a long foreman pass is never double-run.",
  "assigneeAgentId": "be605938-5fa4-44ee-bea5-dcd5e624a871",
  "priority": "high",
  "status": "paused",
  "concurrencyPolicy": "coalesce_if_active",
  "catchUpPolicy": "skip_missed"
}
```

```json
POST /api/routines/:id/triggers
{ "kind": "schedule", "label": "every-30-min", "cronExpression": "15,45 * * * *", "timezone": "Australia/Sydney", "enabled": true }
```

> **Timezone choice:** the trigger `timezone` only matters for cron fields that reference
> wall-clock hour/day; `*/30 * * * *` is timezone-agnostic, but we set `Australia/Sydney`
> explicitly (matches the operator) so any later "business hours only" variant behaves
> intuitively. `nextCronTickInTimeZone(cronExpression, timezone, now)` is what the service uses.

---

## 3. Creation script (paused, reversible, dry-run-first)

This script **creates all four routines in `paused` state** and prints their ids + trigger ids
into a local mapping file so the parallel-run and rollback steps are deterministic. It is
**additive only** — paused routines never fire. Nothing external is touched.

Write it as a sibling of this doc. **Read-only by default; pass `--apply` to actually create.**

Path: `<FORK>/dark-factory/engine/paperclip-migration/create-routines.sh`

```bash
#!/usr/bin/env bash
# Create the 4 dark-factory routines in Paperclip, PAUSED. Additive + reversible.
# Dry-run by default; --apply to create. Writes id mapping to routines-map.json.
set -euo pipefail

API="${PAPERCLIP_API_BASE:-http://127.0.0.1:3101/api}"
COMPANY="${PAPERCLIP_COMPANY_ID:-1e8bc12a-f8fd-431c-9fbd-e47be79446a3}"
PROJECT="${PAPERCLIP_PROJECT_ID:-c4525f28-55d1-4378-864c-aec26d51fc37}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MAP="$HERE/routines-map.json"
APPLY="${1:-}"
AUTH=()
[ -n "${PAPERCLIP_TOKEN:-}" ] && AUTH=(-H "authorization: Bearer ${PAPERCLIP_TOKEN}")

# Agent ids (override via env if the agents workstream registers dedicated agents)
A_COORD="${A_COORD:-ec2f4237-5d27-4675-a919-d4cbc45c55ca}"   # OpenClaw Coordinator
A_REPORTER="${A_REPORTER:-9b8240f0-f0e8-4175-bd06-7534b8f43185}" # Self-Improvement Reporter
A_ORCH="${A_ORCH:-be605938-5fa4-44ee-bea5-dcd5e624a871}"     # pi-orchestrator

api() { # METHOD PATH [JSON]
  local m="$1" p="$2" body="${3:-}"
  if [ "$APPLY" != "--apply" ]; then
    echo "DRYRUN $m $API$p ${body:+--data $body}" >&2
    # emit a fake id so downstream steps don't choke in dry-run
    echo '{"id":"00000000-0000-0000-0000-000000000000","trigger":{"id":"00000000-0000-0000-0000-000000000000"}}'
    return 0
  fi
  if [ -n "$body" ]; then
    curl -fsS -X "$m" "$API$p" -H 'content-type: application/json' "${AUTH[@]}" --data "$body"
  else
    curl -fsS -X "$m" "$API$p" "${AUTH[@]}"
  fi
}

create_routine() { # title desc assignee priority concurrency
  local title="$1" desc="$2" assignee="$3" prio="$4" conc="$5"
  api POST "/companies/$COMPANY/routines" "$(cat <<JSON
{"projectId":"$PROJECT","title":"$title","description":"$desc","assigneeAgentId":"$assignee",
 "priority":"$prio","status":"paused","concurrencyPolicy":"$conc","catchUpPolicy":"skip_missed"}
JSON
)" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])"
}

add_trigger() { # routineId cron
  api POST "/routines/$1/triggers" "$(cat <<JSON
{"kind":"schedule","label":"every-30-min","cronExpression":"$2","timezone":"Australia/Sydney","enabled":true}
JSON
)" | python3 -c "import sys,json; d=json.load(sys.stdin); print((d.get('trigger') or d).get('id'))"
}

echo "Creating routines (PAUSED). APPLY=${APPLY:-dry-run}" >&2

R_MON=$(create_routine "Dark Factory — improver monitor (infra health)" \
  "Every 30 min: disk/log/tmux health. Migrated from crontab. Folder-scoped." \
  "$A_COORD" high skip_if_active)
T_MON=$(add_trigger "$R_MON" "*/30 * * * *")

R_PAT=$(create_routine "Dark Factory — cross-run pattern miner" \
  "Every 30 min: improver-pattern-miner.mjs --file-tickets. Files repeated_pattern tickets." \
  "$A_REPORTER" medium skip_if_active)
T_PAT=$(add_trigger "$R_PAT" "5,35 * * * *")

R_SWP=$(create_routine "Dark Factory — improvement-backlog sweeper" \
  "Every 30 min: improvement-backlog-claude-reviewer.mjs --apply --max-candidates 5." \
  "$A_REPORTER" medium coalesce_if_active)
T_SWP=$(add_trigger "$R_SWP" "10,40 * * * *")

R_FOR=$(create_routine "Dark Factory — foreman (factory-watchdog)" \
  "Every 30 min: factory-watchdog.mjs --blocked-max 10 --foreman-max 10. From launchd." \
  "$A_ORCH" high coalesce_if_active)
T_FOR=$(add_trigger "$R_FOR" "15,45 * * * *")

cat > "$MAP" <<JSON
{
  "createdAt": "$(date -u +%FT%TZ)",
  "apply": "${APPLY:-dry-run}",
  "routines": {
    "improver-monitor":  { "routineId": "$R_MON", "triggerId": "$T_MON", "external": "crontab:dark-factory-improver-monitor" },
    "pattern-miner":     { "routineId": "$R_PAT", "triggerId": "$T_PAT", "external": "crontab:improver-monitor(inner)" },
    "backlog-sweeper":   { "routineId": "$R_SWP", "triggerId": "$T_SWP", "external": "crontab:improver-monitor(inner)" },
    "foreman":           { "routineId": "$R_FOR", "triggerId": "$T_FOR", "external": "launchd:com.openclaw.dark-factory-foreman" }
  }
}
JSON
echo "Wrote $MAP" >&2
cat "$MAP"
```

Run:

```bash
# 1) dry-run — prints the calls, creates nothing
bash <FORK>/dark-factory/engine/paperclip-migration/create-routines.sh
# 2) actually create the 4 routines, PAUSED
bash <FORK>/dark-factory/engine/paperclip-migration/create-routines.sh --apply
```

---

## 4. Parallel-run plan (per lane: shadow → compare → cut over)

**Principle:** the external scheduler keeps running untouched while the Paperclip routine runs
**in shadow** for the same job, on the **same 30-min cadence**. We compare outputs over an
agreed window (recommend **≥ 4 ticks / ~2 hours**, ideally a full business day). Only when the
routine demonstrably does the same work do we disable the external one — and that disable is a
**gated step** (§4.4).

Do this **one lane at a time** in this order (lowest blast radius first):
`pattern-miner` → `backlog-sweeper` → `improver-monitor` → `foreman`.
(Foreman last: it actively advances runs, so a duplicate during shadow is the most disruptive —
which is exactly why `coalesce_if_active` and a careful idempotency check matter for it.)

### 4.1 Pre-flight (once)

- Confirm the instance is up and the scheduler is live: `curl -s $API/health` → `status: ok`.
- Confirm the adapter-command binding exists for the assignee agents (PREREQUISITE §5).
  Without it, a routine run creates an issue but the script never executes. **Verify this in a
  throwaway lane first** (see 4.2 step 1) before trusting any shadow comparison.

### 4.2 Activate ONE routine into shadow

```bash
# Read the id from routines-map.json
RID=$(python3 -c "import json;print(json.load(open('.../paperclip-migration/routines-map.json'))['routines']['pattern-miner']['routineId'])")

# Smoke test FIRST: fire once, now, manually — does the script actually run end-to-end?
curl -fsS -X POST "$API/routines/$RID/run" -H 'content-type: application/json' --data '{"source":"manual"}'
# inspect the run + its issue
curl -fsS "$API/routines/$RID/runs?limit=5" | python3 -m json.tool

# If the smoke run executed the script correctly, flip the routine to active (scheduler now ticks it)
curl -fsS -X PATCH "$API/routines/$RID" -H 'content-type: application/json' --data '{"status":"active"}'
```

The external crontab/launchd job is **still running** at this point — that is the shadow. Both
fire every 30 min.

### 4.3 Compare (the evidence gate)

For ~4+ ticks, compare the two paths. Use whichever signal each job emits:

| Lane             | External evidence                                                                                  | Paperclip evidence                                                            | "Equivalent" means                                    |
| ---------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------- |
| pattern-miner    | tickets filed via `create-improvement-report.mjs` + state file `improver-pattern-miner-state.json` | routine runs in `GET /routines/:id/runs` + same tickets appear in the backlog | same tickets get filed; dedupe state prevents doubles |
| backlog-sweeper  | reviewer JSON in monitor log (`promotedCount`)                                                     | routine runs + backlog promotions                                             | same candidates promoted, no double-promotion         |
| improver-monitor | monitor log: disk/log/tmux findings + Telegram alerts                                              | routine runs + activity log                                                   | same health findings surface                          |
| foreman          | foreman log: tickets claimed / runs advanced                                                       | routine runs + advanced runs                                                  | same tickets advanced, **no duplicate claims**        |

Helper checks (Paperclip side):

```bash
# routine run history with status + issue ids
curl -fsS "$API/routines/$RID/runs?limit=20" | python3 -m json.tool
# dashboard rollup (runActivity / pendingApprovals etc.)
curl -fsS "$API/companies/$COMPANY/dashboard" | python3 -m json.tool
# activity feed entries (routine.run_triggered, routine.created…)
curl -fsS "$API/companies/$COMPANY/activity?limit=50" | python3 -m json.tool
```

**Watch for double-work.** During shadow, _both_ paths run, so for idempotent jobs (pattern-miner
state file, sweeper backlog) you should see **no duplicate tickets** because the underlying
scripts dedupe via their own state. For the **foreman**, the risk is real: two claimants could
grab the same ticket. Mitigations during foreman shadow:

- Keep the routine `coalesce_if_active`.
- Stagger the cron offset (we used `:15/:45`, external launchd fires `:00/:30` + RunAtLoad) so
  they don't fire at the same instant.
- Watch the foreman log for "already claimed" / contention; if duplicate claims appear, **pause
  the routine immediately** (`PATCH status:paused`) and shorten the shadow — go straight to a
  brief cut-over instead (disable launchd, then activate routine), accepting a few-second gap.

### 4.4 Cut over (GATED — needs owner go)

Once a lane's evidence is equivalent for the agreed window, disable the external scheduler.
**These two commands touch live shared infra (crontab / launchd) and are GATED:**

**Disable the launchd foreman (GATED):**

```bash
# reversible: unload + keep the plist file on disk
launchctl bootout gui/$(id -u)/com.openclaw.dark-factory-foreman 2>/dev/null \
  || launchctl unload ~/Library/LaunchAgents/com.openclaw.dark-factory-foreman.plist
# verify it's gone from the loaded list
launchctl list | grep dark-factory-foreman || echo "foreman launchd disabled"
```

**Disable the improver-monitor crontab line (GATED):** removing one line from a shared crontab
also disables the pattern-miner and sweeper (they live _inside_ the monitor), so only do this
**after all three** of monitor/pattern-miner/sweeper routines have passed their shadow.

```bash
# Back up the current crontab first (reversible)
crontab -l > <FORK>/dark-factory/engine/paperclip-migration/crontab.backup.$(date +%Y%m%d-%H%M%S).txt
# Remove only the dark-factory-improver-monitor line, keep everything else
( crontab -l | grep -v 'dark-factory-improver-monitor.mjs' ) | crontab -
# verify
crontab -l | grep dark-factory-improver-monitor || echo "improver-monitor cron disabled"
```

### 4.5 Rollback (per lane, instant)

- **Paperclip side:** `PATCH /api/routines/:id {"status":"paused"}` — the scheduler stops
  ticking it immediately. (Or `PATCH /api/routine-triggers/:id {"enabled":false}`.)
- **External side:** re-add the crontab line from the backup, or
  `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.dark-factory-foreman.plist`
  (or `launchctl load …`). The `.plist` and crontab backup are never deleted, so re-enabling is
  one command.

Because both paths are idempotent (state files / dedupe), running **both** briefly during
rollback overlap is safe for everything except the foreman, where you should ensure only **one**
claimant is active at a time.

---

## 5. Prerequisites & honest gaps

1. **Adapter-command binding is REQUIRED and lives in another workstream.** A routine run only
   creates an _issue assigned to an agent_. For the script to actually execute, the assignee
   (`process` adapter) must be configured with the command that runs that .mjs. That binding is
   the **agents/adapters (00/02) workstream**. **This routines lane cannot be validated end-to-end
   until that exists.** The §4.2 manual smoke run (`POST /routines/:id/run`) is the gate that
   proves the binding works before any shadow comparison is trusted.
2. **Auth to the local API.** Calls assume `local_trusted` implicit board access (confirmed via
   `/health`). If the instance enforces tokens, export `PAPERCLIP_TOKEN`. Prefer the `paperclip`
   skill/MCP, which handles auth.
3. **Single Paperclip process only.** Per §0.4, never start a second server against the live DB,
   or routine ticks double-fire. This is why "restart the live instance / change
   `HEARTBEAT_SCHEDULER_*`" is a **GATED** step owned by the infra owner — toggling that env
   also disables the heartbeat recovery loop.
4. **The pattern-miner/sweeper are sub-tasks of the monitor cron today.** Splitting them into 3
   routines is an intentional improvement (separate schedules/transcripts/assignees), but it means
   the **single crontab line** can only be removed once **all three** routines pass shadow — don't
   disable cron after only the monitor lane is green.
5. **Foreman duplicate-claim risk during shadow.** The foreman is the one job where running the
   external + routine in parallel can collide on ticket claims. `coalesce_if_active` + staggered
   cron + a short shadow window mitigate it; if collisions appear, do a brief direct cut-over
   instead of a long shadow (§4.3).
6. **Timezone & cadence.** `*/30 * * * *` is tz-agnostic and matches both cron and launchd's
   30-min interval; routine ticks land within ~30 s of the half-hour (scheduler resolution), which
   is behaviourally identical to the external jobs.
7. **`RunAtLoad` has no routine equivalent.** The launchd foreman runs once at load/boot;
   routines have no "run on server start" trigger. If a boot-time foreman pass matters, fire it
   manually once after server start (`POST /routines/:id/run`) or accept the next :15/:45 tick.

---

## 6. Quick reference — endpoints used

| Action            | Call                                                                |
| ----------------- | ------------------------------------------------------------------- |
| Create routine    | `POST /api/companies/1e8bc12a-f8fd-431c-9fbd-e47be79446a3/routines` |
| Add cron trigger  | `POST /api/routines/:id/triggers` (`kind:"schedule"`)               |
| Activate (shadow) | `PATCH /api/routines/:id` `{"status":"active"}`                     |
| Pause (rollback)  | `PATCH /api/routines/:id` `{"status":"paused"}`                     |
| Disable trigger   | `PATCH /api/routine-triggers/:id` `{"enabled":false}`               |
| Fire once (smoke) | `POST /api/routines/:id/run` `{"source":"manual"}`                  |
| Run history       | `GET /api/routines/:id/runs?limit=N`                                |
| List routines     | `GET /api/companies/:companyId/routines`                            |
| Dashboard rollup  | `GET /api/companies/:companyId/dashboard`                           |

**GATED steps (need owner's explicit go):** disabling the launchd foreman (§4.4), removing the
improver-monitor crontab line (§4.4), restarting the live Paperclip instance or changing
`HEARTBEAT_SCHEDULER_ENABLED` / `HEARTBEAT_SCHEDULER_INTERVAL_MS` (§0.4, §5). Everything else
(creating paused routines, manual smoke runs, activating a single routine into shadow, pausing a
routine) is additive and reversible and can be run now.
