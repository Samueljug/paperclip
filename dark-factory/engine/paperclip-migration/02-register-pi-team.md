# 02 — Register the Pi team as real Paperclip agents

**Workstream:** `register-agents`
**Artifacts:** this doc + `register-pi-team.mjs` (runnable, idempotent)
**Status:** SAFE / additive. `runnable_now = true`. It writes rows to the **live**
Paperclip board, but it starts nothing, restarts nothing, and reconfigures no
live runtime. The factory keeps running on pi + launchd exactly as before.

---

## 1. What this step does (and does not do)

Today the Paperclip board only knows about **3** agents, all `adapterType:
"process"` no-op markers:

| name                        | role       | adapterType |
| --------------------------- | ---------- | ----------- |
| `pi-orchestrator`           | devops     | process     |
| `Self-Improvement Reporter` | researcher | process     |
| `OpenClaw Coordinator`      | pm         | process     |

The **~36 real pi-team roles** (1 orchestrator + 8 leads + workers) are invisible
to Paperclip. This step registers each pi-team role as a first-class Paperclip
agent so the org tree, dashboard, and activity views reflect the actual factory.

**This step DOES:**

- POST one agent per pi-team role via `POST /api/companies/:id/agents`.
- Build the org tree `pi-orchestrator → leads → workers` using `reportsTo`.
- Map each pi role to a Paperclip built-in role (`AGENT_ROLES` in
  `packages/shared/src/constants.ts`).
- Register them with `adapterType: "openclaw_gateway"` pointing at the live
  gateway URL, **but with the heartbeat scheduler DISABLED**.
- Record the pi role name, model variable, and prompt-file path in `metadata`
  for operator traceability.

**This step does NOT (these are LATER, GATED steps — see §7):**

- Enable any heartbeat → Paperclip will **not** auto-invoke these agents.
- Touch the live OpenClaw gateway, any pi tmux session, the coms-net hub, the
  Foreman (`factory-watchdog.mjs`), launchd, or crontab.
- Modify or delete the 3 pre-existing agents.
- Restart the live Paperclip instance.

> **Why heartbeat is OFF.** With `runtimeConfig.heartbeat.enabled = false`, an
> `openclaw_gateway` agent is registered and visible but the Paperclip scheduler
> never wakes it. Registration is therefore pure visibility/org-structure. The
> actual cut-over — flipping one lane's heartbeat on so Paperclip starts driving
> that pi session through the gateway — is a separate, explicitly gated step.

---

## 2. Ground truth read from the real code

| Fact                                                                                                                                                                                                                                                                                                                                                              | Source                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Create endpoint: `POST /companies/:companyId/agents`, `validate(createAgentSchema)`                                                                                                                                                                                                                                                                               | `server/src/routes/agents.ts:2118`                                                                                                  |
| Create schema fields: `name, role, title, icon, reportsTo (uuid), adapterType, adapterConfig, instructionsBundle, runtimeConfig, budgetMonthlyCents, metadata, desiredSkills, capabilities, defaultEnvironmentId`                                                                                                                                                 | `packages/shared/src/validators/agent.ts:66`                                                                                        |
| `role` enum (12 built-ins): `ceo, cto, cmo, cfo, security, engineer, designer, pm, qa, devops, researcher, general`                                                                                                                                                                                                                                               | `packages/shared/src/constants.ts:45`                                                                                               |
| `reportsTo` is `z.string().uuid().nullable()` (org-tree parent)                                                                                                                                                                                                                                                                                                   | `agent.ts:71`                                                                                                                       |
| `openclaw_gateway` is a valid adapter type; its `models` array is empty (no Paperclip-side model field — model lives in the pi runtime)                                                                                                                                                                                                                           | `constants.ts:41`, `packages/adapters/openclaw-gateway/src/index.ts:4`                                                              |
| `openclaw_gateway` config keys: `url` (required, ws://), `authToken/password/headers`, `clientId/clientMode/role/scopes`, `disableDeviceAuth`, `devicePrivateKeyPem`, `sessionKeyStrategy=issue\|fixed\|run`, `sessionKey`, `payloadTemplate`, `timeoutSec` (default 120), `waitTimeoutMs`, `autoPairOnFirstConnect` (default true), `paperclipApiUrl`, `agentId` | `openclaw-gateway/src/index.ts:6-55`                                                                                                |
| On create, server auto-generates an Ed25519 `devicePrivateKeyPem` for `openclaw_gateway` (unless `disableDeviceAuth=true`)                                                                                                                                                                                                                                        | `agents.ts:979` (`ensureGatewayDeviceKey`)                                                                                          |
| `openclaw_gateway` does **not** use the managed instructions bundle (it is not in the bundle-adapter set), so no `AGENTS.md` is materialized                                                                                                                                                                                                                      | `agents.ts:125-152` (`DEFAULT_INSTRUCTIONS_PATH_KEYS`)                                                                              |
| List endpoint for idempotency: `GET /companies/:companyId/agents` (returns `id, name, role, reportsTo, adapterType, metadata, …`)                                                                                                                                                                                                                                 | `agents.ts:1594`                                                                                                                    |
| Update endpoint: `PATCH /agents/:id`, `validate(updateAgentSchema)` (partial; `permissions` is `z.never`)                                                                                                                                                                                                                                                         | `agents.ts:2540`, `agent.ts:93`                                                                                                     |
| Delete endpoint (rollback): `DELETE /agents/:id`                                                                                                                                                                                                                                                                                                                  | `agents.ts:2805`                                                                                                                    |
| Org-tree view: `GET /companies/:companyId/org`                                                                                                                                                                                                                                                                                                                    | `agents.ts:1676`                                                                                                                    |
| Instance is `local_trusted` — the API answers unauthenticated `GET`/`POST` on loopback (verified: `GET /agents` → 200)                                                                                                                                                                                                                                            | live probe                                                                                                                          |
| Pi role tree, model assignments, prompt paths, colors                                                                                                                                                                                                                                                                                                             | `pi-vs-claude-code/scripts/openclaw-team.sh` (`launch_core`, `launch_workers`, `launch_research_workers`, `launch_problem_workers`) |
| Model preset (informational): all roles `openai-codex/gpt-5.5:xhigh`, Opus-4.8 bridge for opus-required roles                                                                                                                                                                                                                                                     | `.pi/openclaw-teams/model-presets/codex-default.env`                                                                                |

---

## 3. Role → Paperclip mapping

Pi has more specialized roles than Paperclip's 12 built-ins, so several pi roles
collapse onto the nearest built-in. The pi role name is always preserved exactly
in `metadata.piRole` and in the agent's display name, so nothing is lost.

Org root is the **orchestrator**. By default the script creates its own managed
`PiTeam: pi-orchestrator` (mapped to `ceo`, the only role Paperclip auto-grants
task-assign + org authority) as the root. Pass `--reuse-existing-orchestrator`
to instead parent the leads under the **pre-existing** `pi-orchestrator` agent
(read-only; never modified).

| Pi role                       | Paperclip role | reports to            |
| ----------------------------- | -------------- | --------------------- |
| pi-orchestrator               | ceo            | — (root)              |
| planning-lead                 | pm             | pi-orchestrator       |
| implementation-lead           | engineer       | pi-orchestrator       |
| research-lead                 | researcher     | pi-orchestrator       |
| verification-lead             | qa             | pi-orchestrator       |
| browser-qa-lead               | qa             | pi-orchestrator       |
| security-lead                 | security       | pi-orchestrator       |
| self-improvement-lead         | general        | pi-orchestrator       |
| problem-solving-lead          | engineer       | pi-orchestrator       |
| docs-release-lead             | general        | pi-orchestrator       |
| product-planner               | pm             | planning-lead         |
| architecture-planner          | engineer       | planning-lead         |
| frontend-implementer          | engineer       | implementation-lead   |
| backend-implementer           | engineer       | implementation-lead   |
| test-engineer                 | qa             | verification-lead     |
| browser-tester                | qa             | browser-qa-lead       |
| visual-qa                     | designer       | browser-qa-lead       |
| security-reviewer             | security       | security-lead         |
| dependency-auditor            | security       | security-lead         |
| tenant-isolation-reviewer     | security       | security-lead         |
| data-sovereignty-reviewer     | security       | security-lead         |
| authz-reviewer                | security       | security-lead         |
| data-exposure-reviewer        | security       | security-lead         |
| injection-reviewer            | security       | security-lead         |
| memory-librarian              | general        | self-improvement-lead |
| research-source-cartographer  | researcher     | research-lead         |
| research-customer-revenue     | researcher     | research-lead         |
| research-technical-prober     | researcher     | research-lead         |
| research-risk-compliance      | researcher     | research-lead         |
| research-skeptic-red-team     | researcher     | research-lead         |
| research-synthesis-editor     | researcher     | research-lead         |
| problem-root-cause-solver     | engineer       | problem-solving-lead  |
| problem-implementation-solver | engineer       | problem-solving-lead  |
| problem-test-repro-solver     | qa             | problem-solving-lead  |
| problem-risk-skeptic          | security       | problem-solving-lead  |
| problem-synthesis-judge       | general        | problem-solving-lead  |

Total managed agents: **36** (or 35 with `--reuse-existing-orchestrator`).

---

## 4. The placeholder adapterConfig

Each agent is created with this `openclaw_gateway` config (gateway URL is live,
but heartbeat is off so it is never invoked):

```json
{
  "adapterType": "openclaw_gateway",
  "adapterConfig": {
    "url": "ws://127.0.0.1:18789",
    "agentId": "<pi-role-name>",
    "sessionKeyStrategy": "issue",
    "autoPairOnFirstConnect": true,
    "timeoutSec": 120,
    "paperclipApiUrl": "http://127.0.0.1:3101",
    "payloadTemplate": {
      "piRole": "<pi-role-name>",
      "promptFile": "<abs path>"
    }
  },
  "runtimeConfig": {
    "heartbeat": { "enabled": false, "intervalSec": 0, "maxConcurrentRuns": 0 }
  }
}
```

Notes:

- The server fills in `devicePrivateKeyPem` (Ed25519) automatically on create.
- `agentId` advertises the pi cname so a future cut-over can route to the live
  pi session without rewriting the record.
- `instructions` are intentionally NOT a managed bundle here — `openclaw_gateway`
  doesn't support one. The role's prompt file (the real instruction set) is
  recorded in `payloadTemplate.promptFile` and `metadata.promptFile` for the
  operator; the running pi session already loads it via `--append-system-prompt`.

---

## 5. Run it

```bash
cd <FORK>/dark-factory/engine/paperclip-migration

# 1) Preview — ZERO writes. Verifies endpoint reachability, role tree, prompts.
node register-pi-team.mjs --dry-run

# 2) Apply — writes 36 agents to the LIVE board (additive; heartbeat off).
node register-pi-team.mjs

# Variant: root the tree at the pre-existing 'pi-orchestrator' (read-only reuse)
node register-pi-team.mjs --reuse-existing-orchestrator
```

Environment overrides (all optional; defaults are the verified facts):

```bash
PAPERCLIP_API=http://127.0.0.1:3101/api \
PAPERCLIP_COMPANY_ID=1e8bc12a-f8fd-431c-9fbd-e47be79446a3 \
PAPERCLIP_GATEWAY_URL=ws://127.0.0.1:18789 \
PAPERCLIP_NAME_PREFIX="PiTeam: " \
PI_TEAM_ROOT=/Users/samuelimini/.openclaw/workspace/tools/pi-vs-claude-code \
node register-pi-team.mjs
# PAPERCLIP_TOKEN=<bearer>   # only if the instance is switched off local_trusted
```

Verified dry-run output: `created=36 patched=0 skipped=0`, all 36 prompt files
resolved, topo order correct (every manager created before its reports).

---

## 6. Idempotency, safety, and rollback

- **Match by exact name** (`PiTeam: <role>`). Re-running PATCHes existing
  managed agents (re-syncs role/title/icon/reportsTo/adapterConfig) instead of
  duplicating. Safe to run repeatedly.
- **The 3 pre-existing agents are protected** by name (`PROTECTED_NAMES`) and by
  the `PiTeam: ` prefix — they are never created, patched, or deleted.
- **No duplication** of the existing `pi-orchestrator`: the managed root is
  named `PiTeam: pi-orchestrator` (distinct), or with
  `--reuse-existing-orchestrator` the existing one is only _read_ for its id.
- **DB backups are on** (hourly + pre-delete), so even the rollback path is
  recoverable.

Rollback (deletes **only** agents this kit created — filtered by
`metadata.managedBy === "register-pi-team.mjs"` AND the name prefix, leaves-first):

```bash
node register-pi-team.mjs --rollback --dry-run   # preview deletions
node register-pi-team.mjs --rollback             # delete managed agents
```

---

## 7. What is explicitly OUT of scope here (GATED later steps)

These need the owner's explicit go because they touch LIVE shared infra. They
are NOT performed by this script:

1. **Enable a lane's heartbeat** (`PATCH /agents/:id` with
   `runtimeConfig.heartbeat.enabled=true`) so Paperclip starts driving that pi
   session through the gateway. Do this **one lane at a time**, watch it, and be
   ready to flip it back off.
2. **Pair the device** on the live OpenClaw gateway for the gateway adapter
   (the auto-pair path touches the live gateway's device list).
3. **Retire the external schedulers** (crontab `dark-factory-improver-monitor`,
   launchd `com.openclaw.dark-factory-foreman`) in favor of Paperclip routines —
   only after the equivalent Paperclip routines are proven on a lane.

Until a gated step (1) runs, registering these agents changes nothing about how
the factory executes — it only makes the factory **visible** in Paperclip.

---

## 8. Prerequisites

- Paperclip running and reachable at `http://127.0.0.1:3101/api` (verified live).
- Node ≥ 18 (uses global `fetch`; tested on v26.3.0).
- The pi-team prompts present under
  `…/pi-vs-claude-code/.pi/openclaw-teams/prompts/*.md` (verified: all 36 resolve).
  Missing prompts only produce a warning — the path is metadata, not an
  execution input for `openclaw_gateway`, so registration still completes.
- Instance in `local_trusted` mode (default here) OR a valid `PAPERCLIP_TOKEN`.
