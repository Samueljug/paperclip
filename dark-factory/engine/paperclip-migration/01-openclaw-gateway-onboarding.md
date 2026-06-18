# 01 — OpenClaw Gateway Adapter Onboarding (this machine)

**Workstream:** gateway-onboarding
**Goal:** Register a Paperclip agent that drives OpenClaw over the live Gateway WebSocket
(`ws://127.0.0.1:18789`), so Paperclip becomes the _control plane_ and OpenClaw stays the
_execution runtime_. Staged and reversible. Nothing here tears down the running factory.

> **Read this first:** every command below is read-only or additive **except** the two
> explicitly tagged **[GATED — LIVE INFRA]**. Those touch the live Paperclip instance or the
> live gateway pairing table and need the owner's explicit go before running.

---

## 0. Ground truth (verified on this machine, 2026-06-13)

| Thing                      | Value                                              | How verified                                                                                                                     |
| -------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Gateway WS URL             | `ws://127.0.0.1:18789`                             | `lsof` → node PID 40012 `openclaw gateway --port 18789` LISTEN on 127.0.0.1:18789                                                |
| Gateway auth mode          | **token**                                          | `openclaw.json` → `gateway.auth.mode = "token"`                                                                                  |
| Gateway token              | `5b22c837a4fc2f3b29221f178e07bd1921d7dfe32b643b86` | `openclaw.json` → `gateway.auth.token`                                                                                           |
| Gateway bind               | `loopback` (127.0.0.1 + ::1)                       | `openclaw.json` → `gateway.bind`                                                                                                 |
| Gateway health             | `OK (83ms)`, Telegram configured                   | `openclaw gateway health --url ws://127.0.0.1:18789 --token <token>`                                                             |
| **Device pairing**         | **ENFORCED for admin scopes**                      | `openclaw devices list ...` returned `pairing required: device is asking for more scopes than currently approved`                |
| Paperclip API base         | `http://127.0.0.1:3101/api`                        | `GET /api/health` → `{"status":"ok","version":"0.3.1","deploymentMode":"local_trusted","authReady":true}`                        |
| Company id                 | `1e8bc12a-f8fd-431c-9fbd-e47be79446a3`             | given + dashboard returns 200                                                                                                    |
| Dark-factory project id    | `c4525f28-55d1-4378-864c-aec26d51fc37`             | given                                                                                                                            |
| `openclaw_gateway` adapter | **registered + enabled** in this instance          | `GET /api/adapters` → lists `openclaw_gateway`, `disabled=false`                                                                 |
| Agents today               | 3, all `process` type                              | `GET /api/companies/<id>/agents` → `pi-orchestrator` (idle), `OpenClaw Coordinator` (idle), `Self-Improvement Reporter` (paused) |

**Auth posture:** Paperclip runs in `local_trusted` mode, so loopback API calls succeed without a
bearer token. The smoke commands below therefore omit `Authorization`. If this instance is ever
switched to a trusted/keyed mode, every `curl` needs `-H "Authorization: Bearer <key>"`.

---

## 1. What the adapter actually does (from the real code)

Source of truth read for this doc:

- `packages/adapters/openclaw-gateway/README.md`
- `packages/adapters/openclaw-gateway/doc/ONBOARDING_AND_TEST_PLAN.md`
- `packages/adapters/openclaw-gateway/src/server/execute.ts` (the live connect/auth/wake flow)
- `packages/adapters/openclaw-gateway/src/index.ts` (the config field doc)

Connect flow (`execute.ts`, protocol version **3**):

1. Open WS to `url` (must be `ws://` or `wss://`; anything else is rejected with
   `openclaw_gateway_url_protocol`).
2. Receive `event connect.challenge` → grab `nonce`.
3. Send `req connect` with: `minProtocol/maxProtocol=3`, `client {id,version,platform,mode}`,
   `role`, `scopes`, `auth {token|password|deviceToken}`, and (unless disabled) a signed
   **Ed25519 `device`** block `{id, publicKey, signature, signedAt, nonce}`.
4. Send `req agent` with the wake payload → gateway returns `{status, runId}`.
5. If status isn't `ok`, poll `req agent.wait {runId, timeoutMs}`.
6. Stream `event agent` frames (`stream=assistant|error|lifecycle`) into Paperclip logs/transcript
   as `[openclaw-gateway:event] run=<id> stream=<stream> data=<json>`.

Auth resolution order (`resolveAuthToken`): `config.authToken` → `config.token` →
`headers["x-openclaw-token"]` → `headers["x-openclaw-auth"]` → `headers.authorization` (Bearer
stripped). When a token is present and no `authorization` header is set, the adapter adds
`Authorization: Bearer <token>` to the handshake headers automatically.

Device auth (`resolveDeviceIdentity` + `buildDeviceAuthPayloadV3`):

- Default **on**. `disableDeviceAuth=true` omits the signed device block.
- With `devicePrivateKeyPem` set → a **stable** deviceId (sha256 of the raw pubkey). One pairing
  approval is reused forever.
- Without it → an **ephemeral** Ed25519 keypair per run → a _new_ deviceId every run → pairing is
  demanded on **every** run. **This is the trap on this machine** (see §2).
- `autoPairOnFirstConnect=true` (default): on the first `pairing required`, the adapter opens a
  second shared-auth connection and calls `device.pair.list` + `device.pair.approve` itself, then
  retries once. This only works if it can satisfy the pairing scope with the shared token.

Session strategy (`resolveSessionKey`): `issue` (default) → `agent:<agentId>:paperclip:issue:<issueId>`;
`run` → per-run key; `fixed` → uses `sessionKey`. We want **`issue`** so each dark-factory issue
maps to a stable OpenClaw session.

Timeouts: `timeoutSec` (default 120) is the adapter budget; `connectTimeoutMs` is derived as
`min(timeoutSec*1000, 15000)`; `waitTimeoutMs` (default `timeoutSec*1000`) caps `agent.wait`. A
wait timeout returns `openclaw_gateway_wait_timeout`.

---

## 2. The live pairing reality on THIS gateway (important)

A read-only probe (`openclaw devices list --url ws://127.0.0.1:18789 --token <token>`) returned:

```
gateway connect failed: scope upgrade pending approval (requestId: <id>)
gateway closed (1008): pairing required: device is asking for more scopes than currently approved
```

So token auth gets you in at a **base** scope, but **admin/pairing scopes require an approved,
paired device**. Consequences for onboarding:

- A **first** Paperclip run with device auth on will hit `pairing required` exactly once.
- `autoPairOnFirstConnect` may or may not be able to self-approve here, because self-approval
  itself needs `operator.pairing` scope, which is part of what the gateway is gating. **Plan for a
  one-time manual approval** (§5, Step C) and don't rely on auto-pair.
- You **must** pin `devicePrivateKeyPem` on the agent. Without it, every run re-pairs and the
  factory will stall on approvals. This is the single most important config field here.

> Note: the read-only `devices list` probe above _creates a pending pairing request_ on the live
> gateway each time it's denied. If you ran it, there may be a stray pending request in the table.
> Clearing it is a live-gateway mutation — leave it for the owner (`openclaw devices reject
--latest` or `openclaw devices list` to inspect). Don't approve unknown requests.

---

## 3. Generate the stable device key (do this once, off to the side)

This is a local, additive step — no live infra touched. It produces the PEM you'll pin into the
agent config so pairing is approved once and reused.

```bash
# Ed25519 private key in PKCS#8 PEM — exactly what resolveDeviceIdentity expects.
openssl genpkey -algorithm ed25519 -out /tmp/paperclip-openclaw-device.pem

# Sanity-check it loads and derive the deviceId the adapter will present (sha256 of raw pubkey).
node -e '
const crypto=require("crypto"),fs=require("fs");
const pem=fs.readFileSync("/tmp/paperclip-openclaw-device.pem","utf8");
const priv=crypto.createPrivateKey(pem);
const pub=crypto.createPublicKey(priv);
const der=pub.export({type:"spki",format:"der"});
const prefix=Buffer.from("302a300506032b6570032100","hex");
const raw=der.subarray(prefix.length);
console.log("deviceId =", crypto.createHash("sha256").update(raw).digest("hex"));
console.log("pubKeyB64Url =", raw.toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""));
'
```

Keep the PEM contents handy; you'll paste them as a single-line JSON string (`\n`-escaped) into
`devicePrivateKeyPem`. **Treat this PEM as a secret** — anyone with it can impersonate the device.
Prefer storing it via Paperclip secrets (`/api/.../secrets`) and referencing it, rather than
inlining, once you've validated the flow.

---

## 4. Exact Paperclip agent adapter config JSON

This is the `adapterConfig` body for an `openclaw_gateway` agent on this machine. Field names and
defaults are taken verbatim from `src/index.ts` (`agentConfigurationDoc`) and `src/server/execute.ts`.

```json
{
  "url": "ws://127.0.0.1:18789",
  "headers": {
    "x-openclaw-token": "5b22c837a4fc2f3b29221f178e07bd1921d7dfe32b643b86"
  },
  "authToken": "5b22c837a4fc2f3b29221f178e07bd1921d7dfe32b643b86",
  "role": "operator",
  "scopes": ["operator.admin"],
  "clientId": "paperclip-darkfactory",
  "clientMode": "backend",
  "disableDeviceAuth": false,
  "autoPairOnFirstConnect": true,
  "devicePrivateKeyPem": "-----BEGIN PRIVATE KEY-----\n<PASTE PKCS8 ED25519 BODY, \\n-ESCAPED>\n-----END PRIVATE KEY-----\n",
  "sessionKeyStrategy": "issue",
  "waitTimeoutMs": 120000,
  "timeoutSec": 180,
  "paperclipApiUrl": "http://127.0.0.1:3101"
}
```

Field rationale:

- `url` — the live loopback gateway. `ws://` is fine because it's loopback (the adapter only warns
  on plaintext `ws://` to _non_-loopback hosts).
- `headers["x-openclaw-token"]` **and** `authToken` — both set the same gateway token. Either alone
  works (`x-openclaw-token` header or `authToken`/`token` config); setting both is belt-and-braces
  and matches the onboarding doc's `agentDefaultsPayload` shape.
- `role: "operator"` / `scopes: ["operator.admin"]` — the adapter defaults. These are the scopes the
  live gateway is currently gating behind device pairing, which is why §5 Step C exists.
- `disableDeviceAuth: false` — **keep device auth on.** (Alternative: see §6.)
- `devicePrivateKeyPem` — **the critical field.** Pin it so the deviceId is stable and pairing is
  approved once. Without it the factory re-pairs every run.
- `autoPairOnFirstConnect: true` — leave the default on; it _may_ self-approve, but don't depend on
  it (see §2). Harmless if it can't.
- `sessionKeyStrategy: "issue"` — one stable OpenClaw session per Paperclip issue.
- `waitTimeoutMs` / `timeoutSec` — 120s wait inside a 180s adapter budget; bump for long agent turns.
- `paperclipApiUrl: "http://127.0.0.1:3101"` — advertised in the wake text so the woken OpenClaw
  agent calls back to the right Paperclip API. (The onboarding doc's `host.docker.internal:3100`
  example is for the Dockerized test image — **not** this native loopback install. Use 3101.)

> **Do NOT** set a `payloadTemplate.message`/`text` here unless you mean to prepend it to the wake
> text — the adapter concatenates it before the generated wake instructions.

---

## 5. Onboarding steps

### Step A — Generate the device key (local, safe)

Do §3. You now have `/tmp/paperclip-openclaw-device.pem` and its PEM body for the config.

### Step B — Create the gateway agent in Paperclip **[GATED — LIVE INFRA]**

This writes a new agent into the **live** Paperclip instance. Get the owner's go first.

Endpoint (from `server/src/routes/agents.ts:2118`, mounted under `/api/companies`):
`POST /api/companies/:companyId/agents`, validated by `createAgentSchema`
(`packages/shared` → `validators/agent`). Valid `role` values come from `AGENT_ROLES`; `devops` is
used by the existing `pi-orchestrator`, so reuse it here.

> If the company has `requireBoardApprovalForNewAgents=true`, this endpoint returns 409 and you must
> instead `POST /api/companies/:companyId/agent-hires` (same body) and approve the hire on the board.

```bash
# [GATED] creates a live agent. Replace DEVICE_PEM_JSON with the \n-escaped PEM string.
COMPANY=1e8bc12a-f8fd-431c-9fbd-e47be79446a3
GTOKEN=5b22c837a4fc2f3b29221f178e07bd1921d7dfe32b643b86

curl -fsS -X POST "http://127.0.0.1:3101/api/companies/$COMPANY/agents" \
  -H 'Content-Type: application/json' \
  -d @- <<JSON
{
  "name": "OpenClaw Gateway Runner",
  "role": "devops",
  "adapterType": "openclaw_gateway",
  "adapterConfig": {
    "url": "ws://127.0.0.1:18789",
    "headers": { "x-openclaw-token": "$GTOKEN" },
    "authToken": "$GTOKEN",
    "role": "operator",
    "scopes": ["operator.admin"],
    "clientId": "paperclip-darkfactory",
    "clientMode": "backend",
    "disableDeviceAuth": false,
    "autoPairOnFirstConnect": true,
    "devicePrivateKeyPem": "DEVICE_PEM_JSON",
    "sessionKeyStrategy": "issue",
    "waitTimeoutMs": 120000,
    "timeoutSec": 180,
    "paperclipApiUrl": "http://127.0.0.1:3101"
  }
}
JSON
```

The response is the created agent JSON (status `idle`); note its `id` as `$AGENT_ID`.

**Rollback:** `POST /api/agents/$AGENT_ID/terminate` (or pause via `POST /api/agents/$AGENT_ID/pause`).
This removes only the new agent; it touches nothing else. Backups are on (hourly + pre-delete).

### Step C — Approve the device pairing **once** (one-time) **[GATED — LIVE INFRA]**

The first wake (Step D) will register the agent's _stable_ deviceId as a pending pairing request on
the live gateway. Approve it once; because the key is pinned, you never re-approve.

```bash
GTOKEN=5b22c837a4fc2f3b29221f178e07bd1921d7dfe32b643b86

# Inspect pending requests FIRST — confirm the deviceId matches the one printed in §3.
openclaw devices list --url ws://127.0.0.1:18789 --token "$GTOKEN" --json

# Approve the specific request id (preferred — don't blindly --latest if other requests are pending).
openclaw devices approve <requestId> --url ws://127.0.0.1:18789 --token "$GTOKEN"
```

If `autoPairOnFirstConnect` already self-approved, `devices list` will show the device as paired and
you can skip the approve. **Approve only the deviceId you generated in §3** — never an unknown one.

### Step D — Smoke test: prove Paperclip can reach the gateway and wake the agent

See §7.

---

## 6. Fallback: skip device pairing entirely (only if §5 Step C is a blocker)

If the owner does not want to manage device pairing at all, set `disableDeviceAuth: true` in the
adapterConfig. Then the handshake sends **no** device block and relies purely on the gateway token.

- Pro: no pairing approval, ever.
- Con: the gateway is currently gating `operator.admin` behind paired devices, so with device auth
  off you may be limited to the base token scope. If wakes fail with `pairing required` / scope
  errors _even with `disableDeviceAuth:true`_, the gateway is enforcing device pairing for the
  requested scopes and you **must** use the pinned-key path in §4–§5 instead. Decide with the owner;
  don't loosen gateway scope config unilaterally (that's a live-gateway change).

---

## 7. Minimal connectivity smoke test

Run these in order. Steps 7.1–7.2 are **read-only / safe**. Step 7.3 wakes the live agent — it is
**[GATED — LIVE INFRA]** only because it issues a real run on the live gateway; it is otherwise
non-destructive (a single agent turn).

### 7.1 Gateway reachable (read-only)

```bash
openclaw gateway health --url ws://127.0.0.1:18789 \
  --token 5b22c837a4fc2f3b29221f178e07bd1921d7dfe32b643b86
# Expect: "Gateway Health\nOK (NNms)"  → confirms WS + token auth work.
```

### 7.2 Paperclip sees the agent and the adapter (read-only)

```bash
COMPANY=1e8bc12a-f8fd-431c-9fbd-e47be79446a3

# Adapter registered + enabled?
curl -fsS http://127.0.0.1:3101/api/adapters \
  | python3 -c 'import sys,json; print([a["type"] for a in json.load(sys.stdin) if a["type"]=="openclaw_gateway"])'
# Expect: ['openclaw_gateway']

# Agent present after Step B?
curl -fsS "http://127.0.0.1:3101/api/companies/$COMPANY/agents" \
  | python3 -c 'import sys,json; [print(a["name"],a["adapterType"],a["id"]) for a in json.load(sys.stdin) if a["adapterType"]=="openclaw_gateway"]'
```

### 7.3 Wake the agent end-to-end **[GATED — LIVE INFRA]**

Endpoint: `POST /api/agents/:id/wakeup` (`agents.ts:2968`), body validated by `wakeAgentSchema`
(`source` ∈ `timer|assignment|on_demand|automation`, default `on_demand`; optional `reason`).

```bash
AGENT_ID=<id from 7.2>

curl -fsS -X POST "http://127.0.0.1:3101/api/agents/$AGENT_ID/wakeup" \
  -H 'Content-Type: application/json' \
  -d '{"source":"on_demand","reason":"gateway connectivity smoke test"}'
```

**Where to read the result:** the wake spawns a Paperclip run; the gateway adapter streams lines
into that run's log. Watch the live server log for the adapter's own markers:

```bash
# the running Paperclip server is PID-tailable; or watch the run log under the data dir:
tail -f /Users/samuelimini/.openclaw/workspace/tools/paperclip-data/instances/default/data/**/run*.log 2>/dev/null \
  | grep -E '\[openclaw-gateway'
```

**Pass criteria (matching `execute.ts` output):**

- `[openclaw-gateway] connecting to ws://127.0.0.1:18789`
- `[openclaw-gateway] device auth enabled keySource=configured deviceId=<stable id>` ← confirms the
  pinned key (NOT `keySource=ephemeral`).
- `[openclaw-gateway] connected protocol=3`
- `[openclaw-gateway] agent accepted runId=<...> status=...`
- `[openclaw-gateway:event] run=<...> stream=assistant ...` frames
- `[openclaw-gateway] run completed runId=<...> status=ok`

**Failure signatures and meaning:**
| Log / errorCode | Meaning | Fix |
|---|---|---|
| `openclaw_gateway_pairing_required` | deviceId not yet approved | Do §5 Step C for that deviceId |
| `keySource=ephemeral` in logs | `devicePrivateKeyPem` not set/loaded | Fix the config (§4); you'll re-pair every run otherwise |
| `openclaw_gateway_wait_timeout` | agent turn exceeded `waitTimeoutMs` | Raise `waitTimeoutMs`/`timeoutSec` |
| `gateway closed (1008): pairing required ... more scopes` | token scope insufficient, device path needed | Use pinned device key + approve (§5); don't rely on `disableDeviceAuth` |
| `openclaw_gateway_url_protocol` | wrong URL scheme | Must be `ws://`/`wss://` |

---

## 8. What the owner MUST provide / decide (no one else can)

1. **Go-ahead to write the live agent** (§5 Step B) — it mutates the live Paperclip instance.
2. **Go-ahead + hands-on approval of the device pairing** (§5 Step C) — approving a device on the
   live gateway is a security action; the owner should eyeball the deviceId and approve it. Tooling
   can't safely auto-approve an unknown device.
3. **Device-auth posture decision** (§4 pinned-key vs §6 `disableDeviceAuth`) — both are viable; the
   pinned-key path is recommended given the gateway is gating admin scopes behind pairing.
4. **Secret-handling decision** — whether `devicePrivateKeyPem` and the gateway token live inline in
   `adapterConfig` (fine for a loopback single-tenant box) or are moved into Paperclip secrets.
   Recommend secrets once the flow is validated.

Everything the owner does **not** need to provide is already verified and pinned in §0 (gateway URL,
token, port, company id, adapter availability).

---

## 9. Reversibility summary

| Action                        | Reverse                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| Generate device PEM (§3)      | `rm /tmp/paperclip-openclaw-device.pem` — local file only                                          |
| Create gateway agent (§5 B)   | `POST /api/agents/<id>/terminate` or `/pause` — removes only this agent                            |
| Approve device pairing (§5 C) | `openclaw devices remove <deviceId>` / `openclaw devices revoke`                                   |
| Smoke wake (§7.3)             | nothing to undo (one agent turn); cancel a stuck run via `POST /api/heartbeat-runs/<runId>/cancel` |

No global daemons, no launchd changes, no gateway config edits. The 3 existing `process` agents and
the running Pi factory are untouched. DB backups (hourly + pre-delete) remain the safety net.
