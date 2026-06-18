# 03 — Lane Bridge: Paperclip ⇄ live Pi / coms-net / tmux team

**Workstream:** lane-bridge
**Scope:** Make Paperclip the _control plane_ (board, governance, wakes) while the
**Pi team stays the execution runtime** (coms-net + tmux lanes). Map Paperclip
lane actions to the live team and back, one lane at a time, never going dark.

This document is the bridge spec. It is **descriptive + a staged plan**, not a
big-bang cutover. Every step that touches live shared infra is flagged
**[GATED]** and needs the owner's explicit go.

---

## 0. TL;DR (the honest answer)

- **The gateway alone does NOT suffice today**, and a thin shim is **not** what you
  should build either — because a working bridge _already exists_: the deterministic
  **Foreman** (`factory-foreman.mjs`, run by `factory-watchdog.mjs` on launchd every
  30m). It already does exactly "claim a Paperclip issue → dispatch to the right
  coms-net lane", and the Pi leads already mirror status/evidence back to the
  Paperclip issue (Option B comments). That is the live lane bridge **right now**.

- Two viable bridge paths exist. They are **not mutually exclusive** — the
  migration is to move lanes from Path A (poll) to Path B (native wake) one at a
  time, keeping Path A as the always-on backstop until a lane is proven on B.

  - **Path A — Foreman poll bridge (LIVE, deterministic).** External script polls
    Paperclip, checks out an issue with the Coordinator agent id, routes to a lane
    by keyword, sends a coms-net `POST /v1/messages` to that lane. Already running.

  - **Path B — Gateway native wake (the target).** Register a Paperclip agent whose
    adapter is `openclaw_gateway`. When Paperclip assigns/comments an issue to that
    agent, Paperclip itself opens the WebSocket, wakes an OpenClaw agent, and streams
    `event agent` frames back into the issue transcript. The woken OpenClaw agent
    then dispatches into coms-net. **This needs one piece of glue that does not exist
    yet** (see §5): the OpenClaw side that receives the gateway wake must forward it
    into coms-net and relay lane replies back. The gateway streams the _OpenClaw
    agent's_ output back automatically; it does **not** know about coms-net lanes.

- **Session strategy: `sessionKeyStrategy=issue`** so each Paperclip issue maps to
  exactly one OpenClaw session (`paperclip:issue:<issueId>`, agent-prefixed). This
  is already the gateway default and is correct for one-issue-one-conversation.

---

## 1. Verified ground truth (read from the real code)

### 1.1 The gateway adapter (Path B transport)

File: `…/paperclip/packages/adapters/openclaw-gateway/src/server/execute.ts`

What it actually does on a wake (confirmed in code):

1. Opens `ws://` / `wss://` to the gateway, waits for `event connect.challenge`
   (a `nonce`).
2. Sends `req connect` with protocol v3, `client`, `role` (default `operator`),
   `scopes` (default `["operator.admin"]`), `auth` (token/password/deviceToken),
   and a signed Ed25519 `device` payload (`buildDeviceAuthPayloadV3`, format
   `v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily`).
3. Sends `req agent` with `{ message, sessionKey, idempotencyKey: runId, paperclip:{…}, … }`.
4. If not immediately `ok`, polls `req agent.wait { runId, timeoutMs }`.
5. Streams `event agent` frames; only frames whose `payload.runId` is tracked are
   consumed. `stream=assistant` deltas/text → transcript summary; `stream=error` and
   `stream=lifecycle{phase:error|failed|cancelled}` → run error.
6. On `pairing required`: if `autoPairOnFirstConnect` (default true) and a shared
   token/password is present, it auto-runs `device.pair.list` + `device.pair.approve`
   and retries once. Persist `adapterConfig.devicePrivateKeyPem` so pairing is reused.

**The wake `message` it sends** (built in `buildWakeText`) is a full self-contained
runbook telling the woken agent to drive Paperclip's own `/api` issue endpoints:
`GET /api/agents/me` → `POST /api/issues/{id}/checkout` → read issue+comments →
do the work → `POST /api/issues/{id}/comments` → `PATCH /api/issues/{id}` to
`done`/`blocked`. It also passes `PAPERCLIP_RUN_ID`, `PAPERCLIP_TASK_ID`,
`PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`, etc.

**Critical:** the gateway has **no concept of coms-net or pi-team lanes.** It
delivers a wake to _one_ OpenClaw agent and streams _that agent's_ output back.
Fan-out to the 38-agent Pi team is entirely the responsibility of whatever the
woken OpenClaw agent does next. That is the glue gap for Path B.

### 1.2 coms-net (the live lane bus)

File: `…/pi-vs-claude-code/scripts/coms-net-server.ts` (Bun HTTP server)

Endpoints (all `/v1/*` require `Authorization: Bearer <PI_COMS_NET_AUTH_TOKEN>`):

- `GET  /health` (no auth)
- `POST /v1/agents/register` — agent joins by `name` (e.g. `pi-orchestrator`)
- `GET  /v1/events` — SSE stream; agents receive `prompt` events here
- `GET  /v1/agents?project=<p>` — lane roster + `status` + `queue_depth`
- `POST /v1/messages` — send a prompt to a target lane
- `POST /v1/agents/:session/heartbeat`, `DELETE /v1/agents/:session`
- `GET  /v1/messages/:id`, `GET …/await`, `POST …/response` — request/reply

**Message send shape** (`handleSendMessage`):

```json
{
  "project": "openclaw",
  "sender_session": "<the sender's coms-net session id>",
  "target": "implementation-lead", // resolved by agent NAME
  "target_session": "<optional explicit sid>",
  "prompt": "<the handoff text>",
  "conversation_id": "<optional>",
  "response_schema": {} // optional, for await/response
}
```

The server resolves `target` by name (ambiguous if 2+ online with same name),
enforces an inbox cap (`MAX_INBOX`) and hop limit (`MAX_HOPS`), and **pushes a
`prompt` SSE event to the target's open stream**. Replies flow back via
`GET /v1/messages/:id/await` (long-poll) and `POST /v1/messages/:id/response`.

Live coms-net for the team is at `comsUrl: http://127.0.0.1:52965`,
`comsProject: openclaw` (from `factory-intake/config.local.json`). The launcher
default port differs; **trust the config, not the launcher default.**

### 1.3 The Pi team launcher + lanes

File: `…/pi-vs-claude-code/scripts/openclaw-team.sh`

- `ensure_hub` starts the coms-net hub in tmux (`pi-coms-net-hub*`).
- `launch_agent` starts each role as its own `pi` process in tmux session
  `pi-team-<role>`, loaded with `-e extensions/coms-net.ts` (this is what makes the
  agent register on coms-net and listen for `prompt` events), `--cname <role>`,
  `--project "$PROJECT"`, `--server-url "$SERVER_URL"`, `--auth-token "$AUTH_TOKEN"`.
- Core lanes (`launch_core`): `pi-orchestrator`, `planning-lead`,
  `implementation-lead`, `research-lead`, `verification-lead`, `browser-qa-lead`,
  `security-lead`, `self-improvement-lead`. Workers launch under their leads.
- **So a "lane" = a coms-net agent name = a tmux `pi` process.** Dispatching to a
  lane is just `POST /v1/messages target:<lane-name>`. This is the unit the bridge
  targets.

### 1.4 The LIVE bridge today: the Foreman (Path A)

Files: `…/workspace-development/tools/factory-intake/factory-watchdog.mjs`
(launchd `com.openclaw.dark-factory-foreman`, every 30m) →
`factory-foreman.mjs` (the real dispatcher) + `factory-blocked-sweep.mjs`.

What `factory-foreman.mjs` actually does (confirmed in code):

1. `registerForeman` → `POST /v1/agents/register` so the Foreman has a coms-net
   `sender_session`.
2. Polls Paperclip `todo` issues for the project
   (`GET /api/companies/:companyId/issues?projectId=…&status=todo`).
3. `checkoutIssue` → `POST /api/issues/{id}/checkout`
   `{ agentId: coordinatorAgentId, expectedStatuses:[…] }` — the **OpenClaw
   Coordinator agent** (`coordinatorAgentId: ec2f4237-…`) is the claim identity.
4. Routes: keyword regex (`/frontend|ui|browser|checkout|vue|404…/` → FE lane, etc.)
   - lane-capacity check (`chooseHandoffTarget`, `targetInboxSoftLimit`). If the
     orchestrator lane has capacity it goes there; if saturated it hands directly to
     the strongest-matching lead.
5. `sendToTarget` → `POST /v1/messages { sender_session, target:<lane>, prompt }`
   where `prompt = buildHandoffPrompt(...)` instructs the lane to treat the
   Paperclip issue as source of truth and keep it updated.
6. On failure (`409 checkout conflict`, `429 inbox full`) it patches the issue back
   to `todo`/`blocked` with a comment and retries next tick.

The **reverse path (Pi → Paperclip)** is already handled by the Pi leads
themselves: per `pi-orchestrator.md` and `paperclip-option-b-evidence-protocol.md`,
leads post role comments / status / evidence to the Paperclip issue
(`POST /api/issues/{id}/comments`, `PATCH /api/issues/{id}`). The hardcoded
`post_paperclip_comments.js` is an _example_ of that comment shape (Option B:
`authorType:"user"`, `presentation.system_notice`, `metadata.sections`), not a
generic relay.

---

## 2. The bridge mapping (both directions)

### 2.1 Forward: Paperclip "wake agent on issue" → coms-net lane

| Paperclip event                            | Path A (LIVE, poll)                                       | Path B (target, native wake)                                                                                           |
| ------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Issue lands in `todo` for the project      | Foreman poll picks it up next tick (≤30m)                 | n/a — B is event-driven, not poll                                                                                      |
| Issue assigned to bridge agent / commented | n/a today                                                 | Paperclip emits `wakeReason:issue_assigned\|issue_commented` and runs the agent's adapter                              |
| Claim identity                             | `POST /issues/:id/checkout {agentId: coordinatorAgentId}` | gateway wake message tells the woken agent to `POST /issues/:id/checkout` itself; or the bridge does it before fan-out |
| Route to lane                              | keyword regex + capacity → lane name                      | the woken OpenClaw bridge agent runs the **same routing** and dispatches                                               |
| Dispatch                                   | `POST /v1/messages target:<lane>`                         | identical `POST /v1/messages target:<lane>`                                                                            |
| Session identity                           | n/a (stateless poll)                                      | `sessionKeyStrategy=issue` → `paperclip:issue:<issueId>` (one session per issue)                                       |

### 2.2 Reverse: Pi status / heartbeat / evidence → Paperclip issue

| Pi-side signal                 | How it gets to Paperclip today                           | Notes                                                                        |
| ------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Lane progress / decision       | Lead posts `POST /api/issues/{id}/comments` (Option B)   | Already done by leads per protocol                                           |
| Status change                  | Lead `PATCH /api/issues/{id} {status, comment}`          | `done` / `blocked` / `in_review`                                             |
| Evidence (runs, SHAs, logs)    | Comment `metadata.sections` + run-folder refs            | Option B advisory, **not** non-forgeable identity                            |
| Heartbeat / liveness           | coms-net `queue_depth` + agent `status` (online/stale)   | Foreman reads it via `GET /v1/agents`; **not** mirrored onto the issue today |
| Lane saturation / backpressure | Foreman patches issue back to `todo`/`blocked` + comment | Self-healing on next tick                                                    |

**Honest gap in the reverse path:** under **Path B**, the gateway streams the woken
_OpenClaw bridge agent's_ assistant text back into the issue transcript — but the
_real work_ happens in the **separate** pi-team lanes, whose output the gateway run
never sees. So for Path B the bridge agent must either (a) **block** on coms-net
`…/await` and relay the lane's reply as its own assistant output (so the gateway
streams it back), or (b) **fire-and-forget** and rely on the lanes posting their own
Paperclip comments (the current Path-A reverse behaviour). Option (b) is simpler and
matches today's behaviour; option (a) gives a tighter single-run transcript but
risks long gateway `agent.wait` timeouts. **Recommendation: start with (b).**

---

## 3. Does the gateway alone suffice? — decision

**No, the gateway alone is not enough for true lane fan-out — but it is enough as a
transport.** The missing capability is "wake → fan-out to the right coms-net lane →
keep the Paperclip issue as source of truth". That is exactly what the Foreman
already does deterministically. So:

- **Do NOT** try to replace the Foreman with the gateway. The Foreman is the
  battle-tested bridge and the always-on backstop.
- **DO** use the gateway as an _additional, native_ entry point that complements the
  Foreman, migrated one lane at a time, with the Foreman as fallback until proven.
- The only genuinely new code needed is a **thin coms-net dispatch shim** that the
  gateway-woken OpenClaw bridge agent calls (§5). It is ~one script that reuses the
  Foreman's routing + `POST /v1/messages` logic. It is **not** a daemon and is
  **folder-scoped**.

---

## 4. Session strategy (locked)

Set on the bridge agent's `adapterConfig`:

```json
{ "sessionKeyStrategy": "issue" }
```

Resolution (from `resolveSessionKey` in execute.ts): for an issue wake it produces
`agent:<agentId>:paperclip:issue:<issueId>`. Result: **one OpenClaw session per
Paperclip issue**, so all wakes for the same issue (initial assign, follow-up
comment) land in the same conversation and the bridge agent keeps lane context.
`run` would fragment one issue across many sessions; `fixed` would collapse all
issues into one. `issue` is correct. (`fixed` only for a singleton coordinator that
never needs per-issue memory — not our case.)

---

## 5. The glue: exactly what to write and where

Only **one** new piece of code is required for Path B, and it is folder-scoped,
reversible, and runs only inside an OpenClaw agent run (no daemon, no launchd).

### 5.1 `coms-net-dispatch.mjs` — the lane fan-out shim

**Where:** `…/workspace/tools/dark-factory/paperclip-migration/bin/coms-net-dispatch.mjs`
(folder-scoped to this migration; NOT global, NOT a daemon).

**What it does (single invocation, exits):**

1. Reads wake context from env (the gateway already exports these into the run):
   `PAPERCLIP_API_URL`, `PAPERCLIP_TASK_ID`/`PAPERCLIP_ISSUE_ID`, `PAPERCLIP_AGENT_ID`,
   `PAPERCLIP_RUN_ID`, `PAPERCLIP_WAKE_REASON`, plus coms-net config
   (`PI_COMS_NET_SERVER_URL`, `PI_COMS_NET_PROJECT`, `PI_COMS_NET_AUTH_TOKEN`).
2. `GET /api/issues/{id}` + `…/comments` to read the issue (reuse the wake runbook).
3. Routes to a lane using the **same routing table as the Foreman** (import/copy
   `chooseHandoffTarget` + the keyword regex from `factory-foreman.mjs` — do not
   re-invent; keep them in sync). Output: a lane name.
4. Registers a transient sender on coms-net (`POST /v1/agents/register`) to get a
   `sender_session`, then `POST /v1/messages { target:<lane>, prompt: handoff }`.
   Reuse `buildHandoffPrompt` so the handoff text is identical to Path A.
5. **Reverse-path mode (pick one, default fire-and-forget):**
   - _fire-and-forget (default):_ return immediately; the lane lead posts its own
     Paperclip comments (matches today). Gateway run ends quickly.
   - _block-and-relay (opt-in):_ `GET /v1/messages/:id/await` for the lane reply,
     print it as the agent's assistant output so the gateway streams it into the
     issue transcript, then exit. Cap the wait under `waitTimeoutMs`.
6. On any failure, `PATCH /api/issues/{id} {status:"blocked", comment:"…"}` so the
   issue never silently stalls — same self-heal contract as the Foreman.

The bridge OpenClaw agent's system prompt simply says: _"On a Paperclip wake, run
`coms-net-dispatch.mjs` and report its result."_ The gateway streams that back.

### 5.2 The Paperclip bridge agent (Path B registration) — **[GATED]**

Register **one** new Paperclip agent (do not touch the 3 existing process agents):

```json
{
  "name": "lane-bridge",
  "adapterType": "openclaw_gateway",
  "adapterConfig": {
    "url": "ws://127.0.0.1:18789",
    "headers": {
      "x-openclaw-token": "<gateway-token from openclaw.json gateway.auth>"
    },
    "sessionKeyStrategy": "issue",
    "role": "operator",
    "scopes": ["operator.admin"],
    "waitTimeoutMs": 120000,
    "autoPairOnFirstConnect": true,
    "devicePrivateKeyPem": "<generated on first pair; persist so pairing is reused>",
    "paperclipApiUrl": "http://127.0.0.1:3101"
  }
}
```

Registering an agent is **additive and reversible** (delete the agent to roll back),
but it points at the **LIVE gateway on `ws://127.0.0.1:18789`** and will, on first
wake, trigger a **device pairing approval** against the live OpenClaw. → **[GATED]:
owner go required before the first live wake / pairing approval.**

### 5.3 What you do NOT need to write

- No change to the gateway adapter (it already streams `event agent` back).
- No change to coms-net (the bus already does name-routing + SSE delivery).
- No change to the Pi launcher or the lanes.
- No new daemon, no launchd entry, no global hook (CLAUDE.md rule 7).

---

## 6. Staged, reversible migration plan (one lane at a time)

**Invariant:** the Foreman (Path A) stays ON for every lane until that lane is proven
on Path B. The factory never goes dark.

1. **[SAFE, runnable now]** Write `coms-net-dispatch.mjs` + the bridge agent prompt
   in this folder. Dry-run it against a throwaway test issue with
   `--dry-run` (route + handoff text only, **no** `POST /v1/messages`). No live infra
   touched.
2. **[SAFE]** Unit-mirror the Foreman routing in the shim and add a test that asserts
   the shim and `factory-foreman.mjs` pick the same lane for a fixed corpus, so they
   never diverge.
3. **[GATED]** Register the `lane-bridge` Paperclip agent (additive). Owner go needed
   because next step pairs against the live gateway.
4. **[GATED]** Pick **one** low-risk lane (suggest `self-improvement-lead` or
   `research-lead` — low blast radius). Wake the bridge agent on a single real issue
   assigned to `lane-bridge`. Confirm: pairing approved once, `event agent` streamed
   back, `POST /v1/messages` delivered to the lane, lane posted its Paperclip
   comment. **Foreman still running** as backstop the whole time.
5. **[GATED]** Per lane, once Path B is proven for that lane, optionally narrow the
   Foreman's routing to skip that lane (so you don't double-dispatch) — but keep the
   Foreman able to re-claim if a Path-B wake fails (issue falls back to `todo`).
   Cutting a live lane over is **[GATED]**.
6. **[GATED]** Only after _all_ lanes are proven on Path B and have run clean for a
   sustained window do you consider reducing the Foreman to a pure safety-net
   (blocked-sweep + heartbeat) instead of primary dispatcher. **Do not** delete it.

**Rollback at any step:** delete the `lane-bridge` agent (Path B off); the Foreman
already covers 100% of dispatch. No data migration, no destructive change.

---

## 7. Prerequisites & gaps (honest)

**Prerequisites**

- The live gateway token: `openclaw.json → gateway.auth` (port 18789, bind loopback).
  Needed for the bridge agent's `x-openclaw-token`. _(Secret — owner supplies; store
  via Paperclip `secrets` route, not in plaintext config.)_
- A persisted `devicePrivateKeyPem` for the bridge agent so pairing is approved once
  and reused (else every wake re-pairs).
- coms-net must be up at `http://127.0.0.1:52965` project `openclaw` with the bearer
  token (`factory-intake/config.local.json → comsToken`). The shim and Foreman must
  use the **same** coms-net instance, or dispatch lands nowhere.
- The 38 pi-team lanes must be launched (`openclaw-team.sh`) and registered on
  coms-net for `POST /v1/messages` to resolve a target.

**Gaps / risks**

- **Gateway has no lane awareness** — fan-out is 100% the shim's job (§5). Without
  the shim, a gateway wake only runs one OpenClaw agent and never reaches the team.
- **Routing duplication** — the keyword/capacity routing lives in
  `factory-foreman.mjs`; the shim must reuse it or they diverge and send the same
  issue to two different lanes. Mitigate with the shared-corpus test (§6.2).
- **Double-dispatch window** — while both Path A (poll) and Path B (wake) are live
  for the same lane, an issue could be claimed twice. The `POST /issues/:id/checkout`
  conflict (409) is the guard: whichever claims first wins; the other backs off.
  Confirmed: the Foreman already handles 409 by patching back to `todo`. The shim
  must do the same.
- **Coordinator vs bridge identity** — Path A checks out as `coordinatorAgentId`
  (`ec2f4237-…`). Path B's wake runbook checks out as the `lane-bridge` agent id.
  Keep them distinct so checkout conflicts are diagnosable; don't reuse one id for
  both paths.
- **Reverse-path liveness not on the issue** — coms-net `queue_depth`/`status` is
  the team's heartbeat but is **not** mirrored onto the Paperclip issue today. If you
  want board-visible lane liveness, that's a _separate_ small enhancement (a routine
  that reads `GET /v1/agents` and posts a dashboard comment) — out of scope for the
  bridge itself, noted here for honesty.
- **coms-net port drift** — the launcher's default port ≠ the live `52965` in config.
  Always read the live port from `factory-intake/config.local.json` /
  `server.json`, never assume.

---

## 8. Concrete commands / curls (for verification, not live cutover)

> All read-only or dry-run. The live wake/pairing is **[GATED]** (§6 step 3–4).

```bash
# 0) Confirm the live pieces are up (read-only)
curl -fsS http://127.0.0.1:3101/api/companies/1e8bc12a-f8fd-431c-9fbd-e47be79446a3/dashboard | jq '.agents|keys'
curl -fsS http://127.0.0.1:52965/health                       # coms-net hub alive
COMS_TOKEN=$(jq -r .comsToken <FORK>/dark-factory/intake/config.local.json)
curl -fsS -H "authorization: Bearer $COMS_TOKEN" \
  "http://127.0.0.1:52965/v1/agents?project=openclaw" | jq '.agents[]|{name,status,queue_depth}'

# 1) See what the Foreman already routes (dry, no dispatch) — the bridge mirrors this
node <FORK>/dark-factory/intake/factory-foreman.mjs --max 0  # inspect routing without flooding

# 2) [GATED] manual gateway wake test (after owner go + agent registered):
#    Assign one test issue to the `lane-bridge` agent in Paperclip; Paperclip opens
#    the ws://127.0.0.1:18789 wake itself. Watch the run transcript for:
#      [openclaw-gateway] connected protocol=3
#      [openclaw-gateway] agent accepted runId=… status=…
#      [openclaw-gateway:event] run=… stream=assistant …   (shim output relayed)
#    Then confirm a `prompt` landed on the target lane:
#      curl -H "authorization: Bearer $COMS_TOKEN" http://127.0.0.1:52965/v1/agents?project=openclaw  # queue_depth ++

# 3) Dispatch shim dry-run (after it's written; no live message sent):
node <FORK>/dark-factory/engine/paperclip-migration/bin/coms-net-dispatch.mjs \
  --issue <issueId> --dry-run   # prints chosen lane + handoff text only
```

---

## 9. One-paragraph summary for the migration lead

The lane bridge **already exists** as the deterministic Foreman (poll → checkout →
keyword route → `POST /v1/messages` to a coms-net lane; leads mirror status/evidence
back to the Paperclip issue). The OpenClaw **gateway** is a clean _native_ alternative
transport — Paperclip assigns/comments an issue, opens `ws://127.0.0.1:18789`, wakes
one OpenClaw agent with `sessionKeyStrategy=issue`, and streams its output back into
the issue — but the gateway has **no lane awareness**, so it needs **one** folder-
scoped, non-daemon glue script (`coms-net-dispatch.mjs`) that reuses the Foreman's
routing to fan a wake out to the right pi-team lane. Migrate **one lane at a time**,
keep the Foreman running as the always-on backstop, gate every step that touches the
live gateway/pairing or cuts a lane over, and roll back simply by deleting the bridge
agent. Nothing here is a big-bang teardown; the factory never goes dark.
