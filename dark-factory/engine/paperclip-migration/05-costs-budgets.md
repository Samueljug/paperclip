# 05 — Costs & Budgets (Paperclip control plane for the dark factory)

**Workstream:** cost tracking + budget guardrails
**Goal:** make Paperclip the place where the dark factory's spend is _recorded_ and (eventually)
_guarded_, **without ever pausing the live factory by accident**.

> **The cardinal rule of this workstream:** a budget policy in Paperclip is not a passive
> report — when `hardStopEnabled` is true and observed spend crosses the cap, Paperclip
> **pauses the scope and cancels in-flight work** (`pauseAndCancelScopeForBudget`, see code refs
> below). So we **OBSERVE FIRST** (record cost events, learn the baseline) and only set a real
> cap once we know what "normal" looks like — and even then a generous one with hard-stop OFF
> at the start.

All of the following is verified against the **live** instance and the **real source**:

- API base: `http://127.0.0.1:3101/api`
- Company id (`$CID`): `1e8bc12a-f8fd-431c-9fbd-e47be79446a3`
- Dark-factory project id (`$PID`): `c4525f28-55d1-4378-864c-aec26d51fc37`
- Deployment mode (from `GET /api/health`): `local_trusted` → **every request is implicitly
  `board` with no token** (see Auth section). This is what makes the Foreman able to post cost
  events without minting agent keys.

Live state at time of writing (so you know the starting point):

```
GET /companies/$CID/costs/summary  → {"spendCents":0,"budgetCents":0,"utilizationPercent":0}
GET /companies/$CID/budgets/overview → {"policies":[],"activeIncidents":[],...}
GET /companies/$CID/costs/window-spend → []
```

**There is zero cost history and zero budget policy today.** That is the whole reason to
observe before capping — we have no baseline.

---

## 0. Source of truth (what I read)

| Concern                                     | File                                        |
| ------------------------------------------- | ------------------------------------------- |
| Cost routes (all endpoints)                 | `server/src/routes/costs.ts`                |
| Cost event create + summaries               | `server/src/services/costs.ts`              |
| Budget enforcement (pause/cancel/incidents) | `server/src/services/budgets.ts`            |
| Cost-event request schema                   | `packages/shared/src/validators/cost.ts`    |
| Budget policy / incident schema             | `packages/shared/src/validators/budget.ts`  |
| Finance-event schema                        | `packages/shared/src/validators/finance.ts` |
| Cost-event DB columns                       | `packages/db/src/schema/cost_events.ts`     |
| Quota windows (read-only)                   | `server/src/services/quota-windows.ts`      |
| Auth / actor resolution                     | `server/src/middleware/auth.ts`             |
| Allowed enum values                         | `packages/shared/src/constants.ts`          |

---

## 1. Auth — how the Foreman is allowed to POST a cost event

`server/src/middleware/auth.ts` (lines 24–34): when `deploymentMode === "local_trusted"`,
`req.actor` defaults to:

```
{ type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit" }
```

So **on this live local instance, a plain unauthenticated curl is already `board`.** No agent
API key, no JWT.

Why that matters for cost reporting (`costs.ts` lines 73–100):

```ts
router.post("/companies/:companyId/cost-events", validate(createCostEventSchema), ...
  if (req.actor.type === "agent" && req.actor.agentId !== req.body.agentId) { 403 }
```

The "agent can only report its own cost" check **only fires for agent-token callers**. A
board/trusted caller (the Foreman) may report a cost event **on behalf of any `agentId`** in the
company. This is exactly what a deterministic Foreman needs — it reports one event per run,
attributed to whichever pi-team agent did the work.

> If/when the instance is ever switched out of `local_trusted` (a GATED change owned by the
> Paperclip owner), the Foreman will instead need either a **board API key** (`Authorization:
Bearer <board key>`) or a **per-agent API key/JWT**. For the staged migration we assume
> `local_trusted` stays as-is; do **not** flip deployment mode as part of this workstream.

---

## 2. How the Foreman reports a cost event per run

### 2.1 Endpoint

```
POST /api/companies/{companyId}/cost-events
Content-Type: application/json
```

Validated by `createCostEventSchema` (`packages/shared/src/validators/cost.ts`).

### 2.2 Payload (exact schema)

| Field               | Type                     | Required                    | Notes                                                                                                 |
| ------------------- | ------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `agentId`           | uuid                     | **yes**                     | Must be a real agent in this company.                                                                 |
| `provider`          | string (min 1)           | **yes**                     | e.g. `"openai"`, `"anthropic"`, `"google"`.                                                           |
| `model`             | string (min 1)           | **yes**                     | e.g. `"gpt-5.3-codex"`, `"gemini-3-flash-preview"`.                                                   |
| `costCents`         | int ≥ 0                  | **yes**                     | Integer cents. `0` is legal (subscription-included runs).                                             |
| `occurredAt`        | ISO-8601 datetime string | **yes**                     | `z.string().datetime()` — must be a real timestamp string.                                            |
| `billingType`       | enum                     | no (default `"unknown"`)    | One of `metered_api`, `subscription_included`, `subscription_overage`, `credits`, `fixed`, `unknown`. |
| `biller`            | string                   | no (defaults to `provider`) | Who actually bills you (account owner).                                                               |
| `issueId`           | uuid \| null             | no                          | Link the cost to a Paperclip issue/ticket.                                                            |
| `projectId`         | uuid \| null             | no                          | Use `$PID` to attribute to the dark-factory project.                                                  |
| `goalId`            | uuid \| null             | no                          |                                                                                                       |
| `heartbeatRunId`    | uuid \| null             | no                          | Link to a Paperclip run if one exists; needed for `apiRunCount`/run-level rollups.                    |
| `billingCode`       | string \| null           | no                          | Free-form tag (e.g. lane / ticket code).                                                              |
| `inputTokens`       | int ≥ 0                  | no (default 0)              |                                                                                                       |
| `cachedInputTokens` | int ≥ 0                  | no (default 0)              |                                                                                                       |
| `outputTokens`      | int ≥ 0                  | no (default 0)              |                                                                                                       |

The route then writes the row, **recomputes** `agents.spentMonthlyCents` and
`companies.spentMonthlyCents` for the current UTC month, and calls
`budgets.evaluateCostEvent(event)` (`costs.ts` lines 78–99). **Evaluate only acts if an active
budget policy exists** — with no policy (today's state) it is a no-op. That is what makes
observe-first safe: you can flood cost events and nothing pauses.

### 2.3 Real curl (works against the live instance right now)

```bash
CID=1e8bc12a-f8fd-431c-9fbd-e47be79446a3
BASE=http://127.0.0.1:3101/api
# pi-orchestrator agent (real id, from GET /companies/$CID/agents)
AGENT=be605938-5fa4-44ee-bea5-dcd5e624a871

curl -s -X POST "$BASE/companies/$CID/cost-events" \
  -H 'Content-Type: application/json' \
  -d '{
    "agentId": "'"$AGENT"'",
    "projectId": "c4525f28-55d1-4378-864c-aec26d51fc37",
    "provider": "openai",
    "biller": "openai",
    "billingType": "subscription_included",
    "model": "gpt-5.3-codex",
    "inputTokens": 18420,
    "cachedInputTokens": 12000,
    "outputTokens": 3110,
    "costCents": 0,
    "billingCode": "lane:implementation/run-2026-06-13T16:02Z",
    "occurredAt": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"
  }'
```

Returns `201` with the created event. (Cost is `0` here because codex runs on an included
subscription — that is the honest value; see §2.5.)

### 2.4 Live agent ids you can attribute to today

Only **3** agents are registered (the ~38 pi-team agents are NOT registered yet — that is the
agents-registration workstream, not this one):

| Name                      | agentId                                | adapterType | status  |
| ------------------------- | -------------------------------------- | ----------- | ------- |
| pi-orchestrator           | `be605938-5fa4-44ee-bea5-dcd5e624a871` | process     | idle    |
| OpenClaw Coordinator      | `ec2f4237-5d27-4675-a919-d4cbc45c55ca` | process     | running |
| Self-Improvement Reporter | `9b8240f0-f0e8-4175-bd06-7534b8f43185` | process     | paused  |

**Until the real pi-team agents are registered, the honest move is to attribute every Foreman
cost event to `pi-orchestrator`** (it owns the run) and carry the _real_ pi role in `billingCode`
(e.g. `"role:backend-implementer"`). Once per-role agents are registered, switch `agentId` to
the matching role agent and you get true per-agent cost breakdowns from
`GET /costs/by-agent` for free. No payload shape change — just a different `agentId`.

### 2.5 Honest note on `costCents` (a real gap, not a bug)

Paperclip stores whatever `costCents` you give it; it does **not** price tokens for you. The dark
factory mostly runs on **subscriptions** (Codex via OpenAI sub, Gemini via Code Assist sub) where
the marginal $ per run is effectively `0`. Two honest options for the Foreman:

1. **Truthful $0 with billingType** — for subscription runs send `costCents: 0` and
   `billingType: "subscription_included"`, and record the _real_ signal in
   `inputTokens`/`outputTokens`. You still get token-volume baselines and run counts; you just
   don't get a fake dollar figure. **Recommended to start** — it never over- or under-states money.
2. **Estimated $ from a price table** — if/when you want dollar baselines, compute
   `costCents` from a tokens×price table at report time (the price table lives in the
   factory/Foreman, not in Paperclip). Mark it estimated by using `billingType:
"metered_api"` only when it's genuinely metered, otherwise keep `subscription_overage` for
   over-cap usage. **Do not invent metered dollars for subscription runs** — it will pollute the
   baseline and could trip a future budget for money you never actually spent.

> Token counts: the Foreman already has them per run (pi/openclaw emit usage). Map
> `input/cached_input/output` straight across. If a run's tokens aren't available, send the
> event with `costCents: 0` and tokens `0` — a run-count row is still better than nothing.

---

## 3. OBSERVE-FIRST plan (do this BEFORE any cap)

**Objective:** accumulate ~2–4 weeks of real cost events so the baseline (spend/day, tokens/day,
runs/day, per-provider split, per-role split) is known. **No budget policy exists during this
phase, so nothing can pause.** This is the safe, additive, fully reversible part.

### Phase O — instrument (additive, runnable now, no gate)

1. **Add a "report cost" step to the Foreman, do not gate runs on it.** After each run the
   Foreman already advances, append one `POST /cost-events` call (§2.3). Wrap it so a failure to
   report **never** blocks the run (log + continue). This is observation, not control.
2. **Attribute correctly:** `projectId = $PID`, `agentId = pi-orchestrator` (for now),
   `billingCode = "role:<pi-role>/lane:<lane>/run:<id>"`, plus `heartbeatRunId` if a Paperclip
   run row exists.
3. **Pick the billingType honestly** per §2.5 (subscription_included for sub runs).
4. **Backfill is optional** — if the Foreman has a log of recent runs, you can POST historical
   events with their true `occurredAt` to seed the baseline faster. Harmless (no policy to trip).

### Phase O — watch (read-only)

Run the dashboard/cost queries in §5 daily. After ~1–2 weeks you'll have:

- median + p95 **daily** company spend (or token volume if $0),
- per-provider split (`/costs/by-provider`),
- per-agent/role split (`/costs/by-agent`),
- short-window burn rate (`/costs/window-spend`: 5h / 24h / 7d).

**Exit criteria to leave observe-first:** at least 14 days of continuous events AND a stable
p95 daily figure (no single day > ~3× median that isn't explained by a known burst). Only then
move to §4.

> **Why not just set a big number now?** Because the very first policy you create with
> `hardStopEnabled` defaulting to `true` _will_ pause the company the instant cumulative
> month-to-date spend reaches it — and `upsertPolicy` evaluates immediately on creation
> (`budgets.ts` lines 589–604), so a too-low number pauses _retroactively_ against spend already
> booked this month. Observe-first removes that landmine.

---

## 4. Safe, generous company budget — only AFTER baseline is known (GATED)

Once you know the baseline, set **one company-scope policy**, generous, and **with the hard-stop
intentionally configured**. There are two sub-decisions and both are owner calls.

### 4.1 The math

- Let `P95_DAILY_CENTS` = observed p95 daily company spend (from §5).
- Monthly cap = `P95_DAILY_CENTS × 31 × SAFETY` where `SAFETY ≥ 2`. Round up generously.
- If the factory runs purely on subscriptions and real $ ≈ 0, **a dollar cap is meaningless** —
  in that case **do not set a money hard-stop at all**; rely on quota-windows (§6) + alerting,
  and only set a notify-only policy (below) so you get incidents/visibility without pausing.

### 4.2 Recommended first policy — **notify-only, NO hard stop** (least-risk first step)

`POST /api/companies/{companyId}/budgets/policies` — schema `upsertBudgetPolicySchema`:

```bash
CID=1e8bc12a-f8fd-431c-9fbd-e47be79446a3
BASE=http://127.0.0.1:3101/api
# EXAMPLE amount only — replace with (p95_daily × 31 × 2), rounded up. Cents.
curl -s -X POST "$BASE/companies/$CID/budgets/policies" \
  -H 'Content-Type: application/json' \
  -d '{
    "scopeType": "company",
    "scopeId": "'"$CID"'",
    "metric": "billed_cents",
    "windowKind": "calendar_month_utc",
    "amount": 5000000,
    "warnPercent": 80,
    "hardStopEnabled": false,
    "notifyEnabled": true,
    "isActive": true
  }'
```

With `hardStopEnabled: false`:

- crossing `warnPercent` (80%) raises a **soft** budget incident + activity log
  (`budget.soft_threshold_crossed`) — **visibility, no pause**;
- crossing 100% does **not** pause (the hard-stop branch in `evaluateCostEvent`,
  `budgets.ts` lines 691–712, is gated on `policy.hardStopEnabled`). You just keep seeing the
  incident/utilization climb.

This is the safe generous policy that **cannot take the factory dark**. It is the right end-state
for a subscription-driven factory.

### 4.3 If/when you DO want a real hard stop (fully GATED — owner go required)

Flip `hardStopEnabled: true` **only** once:

- the baseline is solid, the `amount` is ≥ 2× p95-month, AND
- the owner explicitly approves arming a control that can pause the live company.

Behaviour when armed and crossed (`budgets.ts`):

- `resolveOpenSoftIncidents` → `createIncidentIfNeeded(..., "hard")` (creates an **approval** of
  type `budget_override_required`) → `pauseAndCancelScopeForBudget(policy)` which sets
  `companies.status = "paused", pauseReason = "budget"` **and** calls the cancel-work hook.
- New work is then blocked by `getInvocationBlock` (lines 716–778) until resolved.
- **Resume path** (also board/owner, GATED):
  `POST /api/companies/{companyId}/budget-incidents/{incidentId}/resolve`
  ```json
  { "action": "raise_budget_and_resume", "amount": <new_cap_cents>, "decisionNote": "..." }
  ```
  `amount` must exceed current observed spend (`budgets.ts` lines 879–884) or you get a 422.
  Or `{ "action": "keep_paused" }` to leave it down.

> **Recommendation:** for a never-go-dark factory, prefer §4.2 (notify-only) indefinitely and
> treat §4.3 as a deliberate, owner-approved tripwire only — not a default. The whole point of
> the migration is that Paperclip _records and warns_; pausing is a human decision.

### 4.4 Agent/project scope (later, optional)

The same schema supports `scopeType: "agent"` (per-role caps once roles are registered) and
`scopeType: "project"` (default `windowKind` for project is `lifetime`). Same hard-stop semantics
and same "observe before you arm" rule apply. Don't set these until the company-level baseline is
trusted; a stray low per-agent cap will pause just that agent and silently starve a lane.

---

## 5. Dashboard / cost queries to watch (all read-only, run any time)

```bash
CID=1e8bc12a-f8fd-431c-9fbd-e47be79446a3
BASE=http://127.0.0.1:3101/api

# Headline: month-to-date spend vs budget + utilization%
curl -s "$BASE/companies/$CID/costs/summary"

# Per-agent (per-role once registered) spend + tokens + run counts
curl -s "$BASE/companies/$CID/costs/by-agent"

# Per agent × provider × model
curl -s "$BASE/companies/$CID/costs/by-agent-model"

# Per provider (openai / anthropic / google ...) and per biller
curl -s "$BASE/companies/$CID/costs/by-provider"
curl -s "$BASE/companies/$CID/costs/by-biller"

# Burn rate: rolling 5h / 24h / 7d per provider  <-- best early-warning signal
curl -s "$BASE/companies/$CID/costs/window-spend"

# Per dark-factory project
curl -s "$BASE/companies/$CID/costs/by-project"

# Budget state: policies, utilization, OPEN incidents, paused counts
curl -s "$BASE/companies/$CID/budgets/overview"

# Whole-company dashboard (agents/tasks/costs/pendingApprovals/budgets/runActivity)
curl -s "$BASE/companies/$CID/dashboard"

# Cost for one issue's whole subtree (when runs are linked to issues)
# curl -s "$BASE/issues/{issueId}/cost-summary?excludeRoot=false"
```

Date-ranged variants: append `?from=ISO&to=ISO` to any `/costs/*` summary/by-\* endpoint
(`parseCostDateRange`, `costs.ts` lines 27–35). Event list endpoints take `?limit=` (1–500,
default 100).

**For the daily observe-first watch, the two that matter most are:**
`/costs/window-spend` (is burn accelerating right now?) and `/costs/by-agent` (which role is
expensive?). `/costs/summary` is the single number to chart for the p95 baseline.

---

## 6. Quota-windows are READ-ONLY — they will NOT save you from a capacity blocker

`GET /api/companies/{companyId}/costs/quota-windows` (board-only; `costs.ts` lines 225–238) asks
each adapter for its provider quota via `fetchAllQuotaWindows`
(`server/src/services/quota-windows.ts`). **It is pure display.** It does **not** feed budgets,
does **not** auto-pause, and does **not** pre-empt a run before the provider rate-limits it.

Live proof (right now):

```json
[
 {"provider":"anthropic","ok":false,"error":"... Claude CLI /usage ... Command failed ..."},
 {"provider":"openai","ok":true,"windows":[
    {"label":"5h limit","usedPercent":80,"resetsAt":"2026-06-13T08:58:17Z"},
    {"label":"Weekly limit","usedPercent":13,...},
    {"label":"Credits","valueLabel":"$0.00 remaining"}, ...]}
]
```

Two honest takeaways:

1. **It can be broken/partial** (anthropic polling currently fails) — never gate factory health
   on it.
2. **80% of a 5h limit is a capacity risk the budget system cannot see.** When OpenAI's 5h
   window fills, runs will fail at the provider regardless of any Paperclip budget. The OpenClaw
   rate-limit failover (daemon restart / auth-profile rotation) is the real mitigation, **not**
   anything in costs/budgets.

**Implication for the migration:** treat quota-windows as a _monitoring_ panel only. Capacity
guardrails (provider rate limits) and money guardrails (budgets) are **separate systems**; do not
conflate them, and don't expect a Paperclip budget to prevent a "ran out of quota" stall.

---

## 7. Finance events (optional, board-only) — out of scope to wire now

`POST /api/companies/{companyId}/finance-events` (board-only, `assertBoard`) records richer
billing rows (platform fees, credit purchases/refunds, BYOK fees, etc.) via
`createFinanceEventSchema`. It is **separate** from `costCents` budget enforcement — finance
events do **not** drive the `billed_cents` budget metric and never pause anything. Useful later if
you want a true money ledger (currency-aware, `amountCents` + `currency`), but **not required**
for cost tracking or guardrails. Leave it for a later phase.

---

## 8. Staged, reversible rollout for THIS workstream

| Step                                                                                                 | Touches live shared infra?                                                                         | Reversible?                                                                             |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| O-1 Add non-blocking `POST /cost-events` to the Foreman (attribute to pi-orchestrator + billingCode) | No (additive instrumentation; folder-scoped Foreman change)                                        | Yes — remove the call                                                                   |
| O-2 (optional) Backfill recent runs as cost events                                                   | No (data only, no policy exists)                                                                   | Yes — events are additive; can be ignored                                               |
| O-3 Watch §5 queries daily for ≥14 days, compute p95 baseline                                        | No (read-only)                                                                                     | n/a                                                                                     |
| B-1 Create **notify-only** company policy (`hardStopEnabled:false`)                                  | **GATED** — creates a real policy object on the live company; `upsertPolicy` evaluates immediately | Yes — `PATCH .../budgets {budgetMonthlyCents:0}` or set `isActive:false` deactivates it |
| B-2 (only if owner wants a tripwire) Arm hard-stop (`hardStopEnabled:true`, amount ≥ 2× p95-month)   | **GATED, HIGH RISK** — can pause the live company + cancel work                                    | Yes — flip back to `false`, or resolve incident with `raise_budget_and_resume`          |

**Runnable now without any gate:** O-1, O-2, O-3 (instrument + observe). They cannot pause the
factory because no budget policy exists.

**Gated (needs owner go):** B-1 and B-2 — anything that creates/arms a budget policy on the live
company, because policy creation evaluates immediately and an armed hard-stop pauses + cancels.

---

## 9. Concrete next action (safe, do-now)

Wire the Foreman's per-run cost report exactly as §2.3, attributing to `pi-orchestrator`
(`be605938-5fa4-44ee-bea5-dcd5e624a871`), `projectId = c4525f28-55d1-4378-864c-aec26d51fc37`,
`billingType: subscription_included`, `costCents: 0` for sub runs (real tokens in the token
fields), failure-tolerant (never blocks a run). Then watch §5 for two weeks. **Set no budget
policy until the baseline is in and the owner approves.**
