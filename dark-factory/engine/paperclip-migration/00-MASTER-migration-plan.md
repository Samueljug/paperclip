# 00 — MASTER: Making Paperclip the Control Plane for the Dark Factory

**Goal:** Make Paperclip the _control plane_ (governance, goals, dashboard, approvals,
routines, cost/budget) for an **already-running** multi-agent dark factory, while **Pi
stays the execution runtime**. The factory must **never go dark**. This is a **staged,
reversible, one-lane-at-a-time** migration. **No big-bang teardown.**

**Owner go required (GATED):** Anything that touches LIVE shared infrastructure —
restarting the live Paperclip instance, reconfiguring the live OpenClaw gateway,
re-pointing/loading/unloading launchd, disabling a live cron, or cutting a live lane
over — is a **GATED step** and needs the owner's explicit go before it runs. Gated steps
are marked **[GATED]** throughout.

---

## 0. Verified ground truth (confirmed live this session)

| Fact                           | Value / evidence                                                                                                                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paperclip API base             | `http://127.0.0.1:3101/api`                                                                                                                                                                                                        |
| Paperclip server               | **LIVE** — node PID `86476` listening on `127.0.0.1:3101`                                                                                                                                                                          |
| Company id                     | `1e8bc12a-f8fd-431c-9fbd-e47be79446a3`                                                                                                                                                                                             |
| Dark-factory project id        | `c4525f28-55d1-4378-864c-aec26d51fc37`                                                                                                                                                                                             |
| OpenClaw gateway               | **LIVE** — node PID `40012` listening on `127.0.0.1:18789` (and `[::1]:18789`)                                                                                                                                                     |
| Gateway config                 | `/Users/samuelimini/.openclaw/openclaw.json` → `"port": 18789`                                                                                                                                                                     |
| DB backups                     | **ON** — hourly + pre-delete in `…/paperclip-data/instances/default/data/backups/` (latest `paperclip-20260613-153136.sql.gz`; pre-delete files present)                                                                           |
| Agents registered today        | 3, all adapter type **process**: `pi-orchestrator`, `Self-Improvement Reporter`, `OpenClaw Coordinator`                                                                                                                            |
| Real pi-team agents            | ~38, **NOT registered** in Paperclip                                                                                                                                                                                               |
| Real OpenClaw gateway adapter  | `packages/adapters/openclaw-gateway/` — `type = "openclaw_gateway"`, `label = "OpenClaw Gateway"`, ws-only, connect-challenge → device-pair (Ed25519) → `req agent` → `agent.wait` → streams `event agent` frames into transcripts |
| Real pi-local adapter          | `packages/adapters/pi-local/src/server/execute.ts` — owns a pi process                                                                                                                                                             |
| Routine trigger kinds          | `["schedule","webhook","api"]` (`packages/shared/src/constants.ts:370`); `schedule` carries `cronExpression` + `timezone` (`validators/routine.ts:118-132`)                                                                        |
| External schedulers to fold in | crontab `dark-factory-improver-monitor` (\*/30m), launchd `com.openclaw.dark-factory-foreman` (factory-watchdog, StartInterval 1800s), plus pattern-miner (runs inside the monitor) and PR/improvement sweepers                    |

**Key architectural truth:** the foreman (`factory-watchdog.mjs`) **already calls the
Paperclip API** (`PAPERCLIP_API_BASE`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_PROJECT_ID` in
its config) and claims tickets/advances runs. So Paperclip is _already partly_ in the
loop — this migration formalises and completes that, it does not bolt on something alien.

**Companion workstream files** (read alongside this master):

- `01-phase0-additive-safe.md` — register agents, goals, dashboard, backup verification (zero-risk, additive).
- `02-openclaw-gateway-lane.md` — stand up the first gateway lane (Phase 1) without removing the tmux lane.
- `03-routines-scheduler-migration.md` — fold crontab + launchd schedulers into Paperclip routines.
- `04-lane-by-lane-cutover.md` — the per-lane cutover runbook (Phases 2..N).
- `05-rollback-and-backups.md` — backup/restore + per-phase rollback drills.
- `06-governance-approvals-budgets.md` — approvals, budgets, secrets, cost governance.
- `07-retire-old-launch-path.md` — final retirement of the old launch path (most gated phase).

> If a referenced file is not yet present, this master is still self-contained: each
> phase below lists its own concrete endpoints, commands, reversibility, gated steps,
> rollback, and success criteria.

---

## 1. Migration principles (non-negotiable)

1. **Factory stays up.** The tmux pi-team lanes + the deterministic Foreman keep running
   until a replacement lane is **proven** and the owner says cut over.
2. **Additive before subtractive.** Every phase first _adds_ the Paperclip-driven path
   and runs it **alongside** the old path. Removal is always a later, separate, gated step.
3. **One lane at a time.** Never migrate two lanes in the same change. A lane is a
   role/queue (e.g. planning, implementation, research, verification, security, browser-qa).
4. **Reversible by construction.** Every step has a named rollback that returns the
   system to the prior working state in minutes, using backups confirmed ON.
5. **Folder-scoped, no globals.** All new artifacts live under
   `…/tools/dark-factory/paperclip-migration/`. **No new global daemons, no global
   binaries, no cross-folder watchers.** (Respects CLAUDE.md rule 7.) The _existing_
   launchd/cron stay as-is until explicitly retired in Phase final.
6. **Gate the shared infra.** Live Paperclip restart, live gateway reconfig, launchd
   load/unload, live cron disable, and live lane cutover are **[GATED]** — owner go only.

---

## 2. Phase map (in order)

```
Phase 0  Additive baseline      (SAFE, no gate)   register agents, goals, dashboard, verify backups
Phase 1  First gateway lane     (1 GATED step)    stand up openclaw-gateway lane ALONGSIDE tmux lane
Phase 2  Routines/scheduler     (GATED disables)  mirror crontab+launchd as Paperclip routines, dual-run, then disable old
Phase 3..N  Lane-by-lane cutover (GATED per lane) cut each remaining lane: planning → implementation → research → verification → security → browser-qa
Phase final  Retire old path    (MOST GATED)      stop the old openclaw-team.sh launch path + remove stale schedulers
```

Each phase below: **What runs · Reversibility · Gated steps · Rollback · Success criteria.**

---

## Phase 0 — Additive baseline (SAFE — no gate)

**Detail file:** `01-phase0-additive-safe.md`

**What runs.** Pure reads + additive writes against the _running_ Paperclip; the factory
is untouched.

- Snapshot current state (no mutation):
  - `GET /api/companies/1e8bc12a-f8fd-431c-9fbd-e47be79446a3/dashboard`
    → returns agents/tasks/costs/pendingApprovals/budgets/runActivity (confirmed working;
    handler: `routes/dashboard.ts` → `dashboardService.summary`).
  - `GET /api/companies/:companyId/goals` (`routes/goals.ts`).
  - `GET /api/adapters` to confirm `openclaw_gateway` + `pi-local`/`process` are loaded
    (`routes/adapters.ts`).
- Register the ~38 real pi-team agents as Paperclip records (adapter type **process** to
  match the existing 3, OR pre-stage `openclaw_gateway` configs for the agents that will
  move to the gateway lane). Use the hire endpoint:
  `POST /api/companies/:companyId/agent-hires` (`routes/agents.ts:1945`). If the company
  has `requireBoardApprovalForNewAgents`, each lands as `pending_approval` and is a
  **board approval**, not a live-infra change — that is in-app governance, not a gated
  infra step.
- Create/confirm the goal tree under the dark-factory project so the dashboard reflects
  reality: `POST /api/companies/:companyId/goals`.
- **Verify backups** rather than create them — hourly + pre-delete already ON. Optionally
  take one **manual** snapshot before any later phase via
  `POST /api/instance/database-backups` (instance-admin; `routes/instance-database-backups.ts`).

**Reversibility.** Everything additive. Delete a goal: `DELETE /api/goals/:id`. Remove a
mistakenly-registered agent via the agents API. No process, no daemon, no launchd, no
cron touched.

**Gated steps.** **None.** Phase 0 does not touch live shared infra. (Agent registration
may require _board approval_ in-app, which is governance, not an infra gate.)

**Rollback.** Delete the added goals/agents. State returns to the original 3-agent view.

**Success criteria.**

- Dashboard shows the real agents/goals (not just 3 placeholders).
- `GET …/dashboard` still 200s; tmux lanes + Foreman still running (verify with
  `tmux ls | grep pi-team` and `launchctl list | grep dark-factory-foreman`).
- No change to factory throughput.

---

## Phase 1 — First gateway lane, ALONGSIDE the tmux lane (1 GATED step)

**Detail file:** `02-openclaw-gateway-lane.md`

**What runs.** Pick **one** low-risk lane (recommended: **research** or a dedicated
**canary** lane — read-only, no PR side-effects). Stand up a Paperclip→OpenClaw path for
that lane over the **already-live** gateway, **without removing** the tmux lane.

- The gateway is already listening (`:18789`), so **no gateway restart is required** for
  Phase 1 if the existing token/auth already admits a new operator client. Configure a
  Paperclip agent with adapter `openclaw_gateway` and `adapterConfig`:
  ```json
  {
    "url": "ws://127.0.0.1:18789",
    "headers": { "x-openclaw-token": "<gateway-token>" },
    "paperclipApiUrl": "http://127.0.0.1:3101",
    "sessionKeyStrategy": "issue",
    "role": "operator",
    "scopes": ["operator.admin"],
    "waitTimeoutMs": 120000,
    "autoPairOnFirstConnect": true
  }
  ```
  (Fields verified in `adapters/openclaw-gateway/src/index.ts` `agentConfigurationDoc` and
  `doc/ONBOARDING_AND_TEST_PLAN.md`.) On create, Paperclip auto-injects a stable
  `devicePrivateKeyPem` for `openclaw_gateway` when device auth is on
  (`routes/agents.ts:980` `ensureGatewayDeviceKey`).
- First run may return **`pairing required`** once; with `autoPairOnFirstConnect=true` the
  adapter self-pairs (`device.pair.list`/`device.pair.approve`) and retries — otherwise
  approve the device once in OpenClaw, then pairing persists via the stored device key.
- Drive **one canary task** end-to-end through this agent and confirm `event agent` frames
  stream into the Paperclip transcript (`[openclaw-gateway:event] run=… stream=…`).

**Reversibility.** The new gateway lane is one new agent + canary tasks. The tmux lane for
that same role is **still running and authoritative**. Disable the gateway agent (set
status, or simply stop assigning to it) and you are back to the pre-Phase-1 state with
zero downtime.

**Gated steps.**

- **[GATED] IF** the live gateway needs a new operator token / scope / device-pair policy
  change to admit the Paperclip client, that is a **live OpenClaw gateway reconfig** →
  owner go required before editing `/Users/samuelimini/.openclaw/openclaw.json` or
  restarting the gateway-supervisor. (If the existing token already admits the client,
  Phase 1 has **no** gated step.)

**Rollback.** Stop assigning to the gateway agent; delete the canary tasks. Tmux lane was
never interrupted. If a token was added under gate, revoke it and restart the
gateway-supervisor (also gated).

**Success criteria.**

- One canary task completes via `openclaw_gateway` with transcript frames visible in
  Paperclip.
- The tmux lane for the same role ran uninterrupted the whole time (`tmux ls`).
- No re-pairing required on a second canary run (device key persisted).
- Dashboard run-activity shows both paths producing work.

---

## Phase 2 — Routines / scheduler migration (GATED disables)

**Detail file:** `03-routines-scheduler-migration.md`

**What runs.** Recreate the external schedulers as **Paperclip routines** and **dual-run**
before disabling the originals. Targets:

- crontab `dark-factory-improver-monitor` (\*/30m) — and the pattern-miner that runs
  inside it.
- launchd `com.openclaw.dark-factory-foreman` (factory-watchdog, StartInterval 1800s).
- PR/improvement sweepers.

Mechanics (verified `routes/routines.ts` + `validators/routine.ts`):

1. `POST /api/companies/:companyId/routines` — create a routine assigned to the agent that
   owns the work (e.g. the orchestrator). Body: `{ title, description, assigneeAgentId,
projectId: "c4525f28-…", priority, status:"active" }`.
2. `POST /api/routines/:id/triggers` with a **schedule** trigger:
   ```json
   {
     "kind": "schedule",
     "cronExpression": "*/30 * * * *",
     "timezone": "UTC",
     "enabled": true
   }
   ```
   (Discriminated union requires `cronExpression`; `timezone` defaults to `"UTC"`.)
3. **Dual-run window:** Paperclip routine fires on its own schedule **while the original
   cron/launchd still runs**. Compare run-activity for ≥1 full cycle (≥30 min) to confirm
   the routine produces equivalent claims/advances. Use `concurrencyPolicy`
   (`coalesce_if_active` default) and `catchUpPolicy` (`skip_missed` default) so a routine
   never stampedes the foreman.
4. Only after parity is proven, **disable the original** scheduler.

**Reversibility.** A routine is data: `PATCH /api/routines/:id` (`status:"paused"`) or
delete its trigger (`DELETE /api/routine-triggers/:id`). Re-enabling the original cron/
launchd is a one-line restore.

**Gated steps.**

- **[GATED]** Disabling the live crontab line (`crontab -e` to comment
  `dark-factory-improver-monitor`) — owner go.
- **[GATED]** `launchctl bootout`/`unload` of `com.openclaw.dark-factory-foreman` — owner
  go. (Note a `.bak-codexenv` plist exists; keep it as the restore artifact.)
- Creating the routines themselves is **not** gated (in-app data).

**Rollback.** Re-add the crontab line; `launchctl bootstrap`/`load` the foreman plist
(backup plist already on disk). Pause the Paperclip routines. Both schedulers can run
again in <2 min.

**Success criteria.**

- For ≥1 cycle, the Paperclip routine and the original scheduler produced equivalent
  outcomes (tickets claimed, runs advanced) — verified in run-activity.
- After the gated disable, the routine alone keeps the cadence; no missed cycle.
- Foreman/monitor logs show no errors; backups still rolling.

---

## Phase 3..N — Lane-by-lane cutover (GATED per lane)

**Detail file:** `04-lane-by-lane-cutover.md`

**What runs.** Migrate the remaining lanes **one at a time**, in increasing blast-radius
order. Recommended order (lowest risk → highest):

```
research → verification → browser-qa → planning → implementation → security
```

Per lane, repeat the Phase-1 pattern but make the Paperclip path **authoritative** for
that lane only:

1. Stand up / confirm the `openclaw_gateway` (or `process`/pi-local) agent for the lane.
2. **Shadow window:** route a _copy_ of the lane's work through Paperclip while tmux still
   owns it. Compare outputs.
3. **[GATED] Cutover:** flip the lane so Paperclip assigns the real work and the tmux lane
   for that role stops being fed (but is **not deleted** — left idle as instant rollback).
4. Bake for an agreed window (e.g. 24h or N tasks). Only then proceed to the next lane.

**Reversibility.** Each lane keeps its idle tmux session as a hot standby. Re-feeding the
tmux lane and pausing the Paperclip agent restores the prior owner in minutes.

**Gated steps.**

- **[GATED]** The cutover flip for **each** lane (this re-points live work) — owner go,
  one lane at a time.
- **[GATED]** Any gateway token/scope change needed to widen the gateway lane's permissions.

**Rollback (per lane).** Pause the Paperclip agent for the lane; resume feeding the tmux
lane. No other lane is affected (one-lane-at-a-time guarantees isolation).

**Success criteria (per lane).**

- Shadow outputs matched for the agreed window.
- Post-cutover, the lane's throughput/quality ≥ baseline (dashboard run-activity + costs).
- All other lanes unaffected; backups rolling; no orphaned runs.

---

## Phase final — Retire the old launch path (MOST GATED)

**Detail file:** `07-retire-old-launch-path.md`

**What runs.** Only after **every** lane is cut over, baked, and stable:

- Stop launching new tmux pi-team sessions via
  `/Users/samuelimini/.openclaw/workspace/tools/pi-vs-claude-code/scripts/openclaw-team.sh`.
- Remove the now-superseded schedulers (already disabled in Phase 2): delete the crontab
  line and `rm`/archive the launchd plist (keep the `.bak` for one retention window).
- Keep the **live OpenClaw gateway and gateway-supervisor running** — Pi is still the
  execution runtime; only the _old orchestration/launch path_ retires.

**Reversibility.** Keep `openclaw-team.sh` and the backup plists archived (not deleted) for
one retention window so the entire old path can be relaunched in minutes if a regression
surfaces.

**Gated steps.**

- **[GATED]** Stopping/retiring the `openclaw-team.sh` launch path — owner go.
- **[GATED]** Permanently removing the launchd plist + crontab line — owner go.
- **[GATED]** Any final live Paperclip restart to bake config — owner go.

**Rollback.** Relaunch tmux lanes via `openclaw-team.sh`; restore the launchd plist from
`.bak`; re-add the crontab line. The owner can fall back to the original factory in one
command set.

**Success criteria.**

- Paperclip is the sole control plane: goals, assignment, approvals, budgets, routines,
  dashboard all driven through it; Pi runs the execution.
- No tmux pi-team session is required for steady-state throughput.
- One full retention window passes with throughput/quality ≥ baseline and backups intact.

---

## 3. Risk register (risk → mitigation)

| #   | Risk                                                                                 | Likelihood | Impact | Mitigation                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------ | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Factory goes dark** during a cutover                                               | Med        | High   | Additive-first; tmux lane kept as hot standby per lane; one lane at a time; instant pause-agent/resume-tmux rollback.                                                                          |
| R2  | **Two control loops fight** (foreman + Paperclip routine both claim the same ticket) | Med        | High   | Dual-run with `concurrencyPolicy=coalesce_if_active`; compare run-activity for a full cycle **before** disabling the old scheduler; only one loop authoritative per ticket source.             |
| R3  | **Global daemon hoovers another folder** (the prior `no-mistakes` deadlock)          | Low        | High   | Strict folder-scope (CLAUDE.md rule 7); no new global daemons/binaries/watchers; reuse the _existing_ gateway and launchd, never spawn cross-folder ones.                                      |
| R4  | **Live gateway reconfig breaks all OpenClaw lanes**                                  | Low        | High   | Gateway reconfig is **[GATED]**; prefer reusing the existing token so Phase 1 needs no gateway change; keep `openclaw.json` backup before any edit; gateway-supervisor restart owner-approved. |
| R5  | **Live Paperclip restart drops in-flight runs**                                      | Low        | High   | Restart is **[GATED]**; take a manual `POST /api/instance/database-backups` snapshot first; schedule restart in a quiet window; verify `GET /api/health` + dashboard after.                    |
| R6  | **launchd/cron disabled prematurely** → missed cycles                                | Med        | Med    | Disable only after proven parity; keep `.bak` plist + saved crontab line; `catchUpPolicy=skip_missed` avoids stampede on re-enable.                                                            |
| R7  | **Gateway pairing loops** (re-pairing every run)                                     | Low        | Med    | `devicePrivateKeyPem` auto-pinned on agent create (`agents.ts:980`); `autoPairOnFirstConnect=true`; success criterion requires no re-pair on 2nd run.                                          |
| R8  | **Approval bottleneck** if `requireBoardApprovalForNewAgents` is on for ~38 agents   | Med        | Low    | Batch-register in Phase 0; approve in-app; this is governance, not downtime — factory keeps running on tmux meanwhile.                                                                         |
| R9  | **Cost/budget runaway** once Paperclip drives runs                                   | Low        | Med    | Set per-agent `budgetMonthlyCents`; watch dashboard `costs`/`budgets`; see `06-governance-approvals-budgets.md`.                                                                               |
| R10 | **Backup gap** at a critical step                                                    | Low        | High   | Backups confirmed ON (hourly + pre-delete); take an extra manual snapshot before every **[GATED]** step; restore drill documented in `05-rollback-and-backups.md`.                             |
| R11 | **Secrets/tokens leak** in adapterConfig                                             | Low        | High   | Gateway token via `headers.x-openclaw-token` / Paperclip secrets, redacted in approval payloads (`redactEventPayload`, `agents.ts:2017`); never commit tokens to the migration folder.         |
| R12 | **Lane isolation breaks** (one cutover affects another)                              | Low        | Med    | One lane per change; each lane independent agent + standby; shadow-then-flip; no shared mutable launch step.                                                                                   |

---

## 4. Gated-step index (single source of truth for owner go)

Run these **only** with the owner's explicit go:

1. **[GATED]** Live OpenClaw gateway reconfig — editing `/Users/samuelimini/.openclaw/openclaw.json` or restarting the gateway-supervisor (Phase 1 if a new token/scope is needed; Phase 3..N for widened scopes).
2. **[GATED]** Disable live crontab `dark-factory-improver-monitor` (Phase 2).
3. **[GATED]** `launchctl bootout`/`unload` of `com.openclaw.dark-factory-foreman` (Phase 2).
4. **[GATED]** Per-lane **cutover flip** that re-points live work (Phase 3..N, one lane at a time).
5. **[GATED]** Retire the `openclaw-team.sh` launch path (Phase final).
6. **[GATED]** Permanently remove launchd plist + crontab line (Phase final).
7. **[GATED]** Any **live Paperclip restart** to bake config (any phase).

Everything else — registering agents, creating goals/routines/triggers, reading the
dashboard, taking a manual backup, driving canary/shadow tasks — is **additive and safe**
and runs without a gate.

---

## 5. Pre-flight before any GATED step (always)

1. `POST /api/instance/database-backups` (manual snapshot; instance-admin).
2. Confirm latest hourly backup `<60 min` old in the backups dir.
3. Confirm tmux standby for the affected lane is alive (`tmux ls | grep pi-team`).
4. Note the exact rollback command for the step (from the phase's Rollback section).
5. Get owner go. Execute. Re-verify `GET …/dashboard` + lane throughput after.
