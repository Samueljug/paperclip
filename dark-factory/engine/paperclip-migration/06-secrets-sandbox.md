# 06 — Secrets Vault + Sandboxed Execution

Workstream: **secrets-sandbox**. Make Paperclip the place the dark-factory's tokens
live, and define a sandbox environment that could contain a runaway (e.g. the
disk-fill crash). Staged and reversible. Every step that changes how live work runs
is flagged **GATED**.

Ground truth used here (all read from the real source):

- Secrets routes: `paperclip/server/src/routes/secrets.ts`
- Secrets service: `paperclip/server/src/services/secrets.ts`
- Local provider (default): `paperclip/server/src/secrets/local-encrypted-provider.ts`
- Secret schemas: `paperclip/packages/shared/src/validators/secret.ts`
- Environments routes: `paperclip/server/src/routes/environments.ts`
- Environment config: `paperclip/server/src/services/environment-config.ts`
- Execution workspaces: `paperclip/server/src/routes/execution-workspaces.ts`
- Sandbox plugins: `paperclip/packages/plugins/sandbox-providers/{e2b,modal,daytona,exe-dev,cloudflare}`
- pi-local execute: `paperclip/packages/adapters/pi-local/src/server/execute.ts`
- Execution target shape: `paperclip/packages/adapter-utils/src/execution-target.ts`

Constants:

- API base `http://127.0.0.1:3101/api`
- Company id `1e8bc12a-f8fd-431c-9fbd-e47be79446a3`
- Dark-factory project id `c4525f28-55d1-4378-864c-aec26d51fc37`

> Throughout, `$PC=http://127.0.0.1:3101/api`, `$CO=1e8bc12a-f8fd-431c-9fbd-e47be79446a3`,
> `$PROJ=c4525f28-55d1-4378-864c-aec26d51fc37`. Auth: the migration is run locally as
> board. If your instance requires a token, add `-H "Authorization: Bearer $PC_TOKEN"`
> to every call — all secret + environment routes call `assertBoard` /
> `environments:manage` and will 401/403 without it.

---

## Part 0 — How Paperclip secrets actually work (read this first)

Two facts decide the whole plan, and both are confirmed in code:

**(a) The default provider is `local_encrypted` and it is NOT a remote vault.**
`local-encrypted-provider.ts` encrypts each secret value with AES-256-GCM under a
**single master key**. The key comes from `PAPERCLIP_SECRETS_MASTER_KEY` (env) or a
key file (`PAPERCLIP_SECRETS_MASTER_KEY_FILE`, else the default home path), created
`0600` on first managed write. Consequence: **the DB backups alone cannot restore
secret values** — you must back up the master key file _separately_ from the DB.
The provider health check says exactly this ("Back up the key file together with
database backups. The database alone cannot restore local encrypted secret values.").

**(b) There is no separate "bind secret to agent" HTTP endpoint. Binding happens by
reference.** You make a secret reachable by an agent by putting a `secret_ref` in
that agent's `adapterConfig.env`. On agent create/update, `agents.ts` calls
`secretsSvc.normalizeAdapterConfigForPersistence(...)` (validates the refs) and the
binding rows in `company_secret_bindings` are written from the env map via
`syncEnvBindingsForTarget`. At run time, `resolveAdapterConfigForRuntime` decrypts
each `secret_ref` back into a plain string and the resolved `env` map is handed to
the adapter. For `pi-local`, `execute.ts` merges that into `envConfig` /`env` and
spawns the pi process with it (`mergedEnv = { ...process.env, ...env }`). So:

```
secret (local_encrypted)  ──ref──▶  agent.adapterConfig.env.GITHUB_TOKEN = {secret_ref}
        │                                          │
        ▼ (run time)                               ▼
 resolveAdapterConfigForRuntime ──▶ env.GITHUB_TOKEN = "<plaintext>" ──▶ spawned pi process
```

The same model applies to **environments** (`secret-ref` fields in the driver config,
e.g. the E2B `apiKey`) and to **routines** (env on the routine), via the same
`secret_ref` / binding plumbing. Provider-config metadata (region, prefixes) is stored
_unencrypted_ and the schema actively **rejects** persisting raw credential keys into
provider-config (`deniedProviderConfigKeyPattern`).

What this means for the factory: moving a token into Paperclip = (1) create one secret
holding the value, (2) reference it from each consumer's `env` (agent / routine /
environment). That is the entire "create + bind" loop. The audit trail is real:
`secret.created`, `secret.rotated`, `secret_access_events` (per-resolve, success/fail),
and `GET /secrets/:id/usage` shows every binding target.

---

## Part A — Move the factory's tokens into Paperclip secrets

### A.0 Where the tokens live today (so we know what we're migrating)

- **GitHub push token** — `gh` CLI keychain, account `Samueljug` (`gho_…`). Used by
  every implementer/foreman that pushes branches and opens PRs.
- **Model keys** — the factory's models run through the **OpenClaw gateway**, not via a
  raw key the agents hold. Gemini/Code-Assist + OpenAI/Codex auth live in OpenClaw's
  `auth-profiles.json` / `auth-state.json` and plugin config in `openclaw.json`
  (`plugins.entries.openai`, `plugins.entries.codex`). There is **not** a loose
  `OPENAI_API_KEY` the pi agents read directly today — flag this (see "Honest gaps").
- **Telegram bot tokens** — token files under `~/.openclaw/credentials/telegram-*-bot-token`
  (one per bot: default, overclawd, blackfix/silver/green/red/bluefixclaw…), plus one
  inline `botToken` for `bugfixer` in `openclaw.json`.

We migrate **values into the Paperclip vault** and reference them from the agents /
routines that need them. We do **not** delete the on-disk copies until a lane is fully
cut over and verified (reversibility).

### A.1 (Optional, recommended) Pin the master key BEFORE writing any secret — GATED

The first managed-secret write creates the master key file. If you want the key to be
backed up to a known location / injected by env (so DB backups + key are managed
together), set it first. This touches how the **live** Paperclip server reads secrets,
so it is **GATED** — it requires a server restart to take effect.

```bash
# generate a 32-byte key (base64)
openssl rand -base64 32 > ~/.openclaw/paperclip-secrets-master.key
chmod 600 ~/.openclaw/paperclip-secrets-master.key
# then, in the Paperclip server's launch env (GATED — owner restarts the live server):
#   PAPERCLIP_SECRETS_MASTER_KEY_FILE=/Users/samuelimini/.openclaw/paperclip-secrets-master.key
```

If you skip this, Paperclip auto-creates the key file at the default home path on the
first write — fine, but **add that file to your backup routine** (see A.6). Either way,
**confirm provider health is green before importing**:

```bash
curl -s "$PC/companies/$CO/secret-providers/health" | jq .
# expect local_encrypted status "ok" (or "warn" only about the key file not existing yet)
```

### A.2 Create the secrets (additive, reversible, safe to run now)

These are plain `POST /companies/:companyId/secrets` calls. `provider` defaults to the
configured default (`local_encrypted`), `managedMode` defaults to `paperclip_managed`,
so you only need `name` + `value`. Names must be unique; `key` is auto-derived if
omitted.

```bash
# 1) GitHub push token  (read it out of the gh keychain without echoing it to history)
GH_TOKEN_VALUE="$(gh auth token)"
curl -s -X POST "$PC/companies/$CO/secrets" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg v "$GH_TOKEN_VALUE" '{
        name:"dark-factory-github-token",
        key:"github_token",
        description:"GitHub push/PR token (account Samueljug) for factory implementers + foreman",
        value:$v }')"
unset GH_TOKEN_VALUE

# 2) Telegram bot token (example: the telegram4 / blackfixclaw bot the improver-monitor uses)
TG_VALUE="$(cat ~/.openclaw/credentials/telegram-blackfixclaw-bot-token)"
curl -s -X POST "$PC/companies/$CO/secrets" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg v "$TG_VALUE" '{
        name:"dark-factory-telegram-blackfixclaw",
        key:"telegram_blackfixclaw_token",
        description:"Telegram bot token for blackfixclaw_bot (factory notifications)",
        value:$v }')"
unset TG_VALUE

# 3) Model key — ONLY if/when a lane uses a direct key instead of the OpenClaw gateway.
#    Today the factory authenticates models through the gateway, so there is usually no
#    raw key to store. If a sandbox lane needs one (e.g. E2B/Modal worker calling an API
#    directly), create it the same way:
# curl -s -X POST "$PC/companies/$CO/secrets" -H 'Content-Type: application/json' \
#   -d '{"name":"dark-factory-model-key","key":"model_api_key","value":"<paste>"}'
```

Each call returns `{ id, name, key, provider, latestVersion, ... }`. Capture the `id`s
(e.g. `$GH_SECRET_ID`) — you reference them by id when binding.

`GET /companies/$CO/secrets` lists them all (values are never returned).

### A.3 Bind a secret to the dark-factory project (project-scoped reach)

Binding = put a `secret_ref` in the consumer's `env`. To bind at the **project** level,
patch the project's env (the project carries default env that flows to its issues/runs;
the same `secret_ref` shape applies). The binding row is written automatically on save.

```bash
# Bind the GitHub token to the project as GITHUB_TOKEN
curl -s -X PATCH "$PC/projects/$PROJ" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg sid "$GH_SECRET_ID" '{
        env: { GITHUB_TOKEN: { type:"secret_ref", secretId:$sid, version:"latest" } }
      }')"
```

> If your build does not expose project-level `env`, bind on the **agents** instead
> (A.4) — that is the path `agents.ts` definitely supports and is what `pi-local`
> actually reads. Project binding is a convenience; agent binding is the load-bearing one.

### A.4 Bind to the factory agents (the path pi-local actually reads) — GATED

This is the binding that changes what a **live** agent run sees, so it is **GATED**
(do one agent at a time; the agent picks it up on its _next_ run). Patch the agent's
`adapterConfig.env` to reference the secret. `agents.ts` validates the ref
(`normalizeAdapterConfigForPersistence`) and writes the binding; at run time
`resolveAdapterConfigForRuntime` decrypts it into the spawned pi process env.

```bash
# Find the agent id (only 3 are registered today: pi-orchestrator, Self-Improvement
# Reporter, OpenClaw Coordinator)
curl -s "$PC/companies/$CO/agents" | jq -r '.[] | "\(.id)\t\(.name)"'

# Patch pi-orchestrator to receive GITHUB_TOKEN from the vault (merge into existing env).
# IMPORTANT: send the FULL adapterConfig.env you want; the server replaces env bindings
# under the "env." prefix. Read the current config first, merge, then PATCH.
AID=<pi-orchestrator-id>
curl -s "$PC/agents/$AID" | jq '.adapterConfig.env' > /tmp/agent-env.json   # inspect
curl -s -X PATCH "$PC/agents/$AID" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg sid "$GH_SECRET_ID" '{
        adapterConfig: { env: {
          GITHUB_TOKEN: { type:"secret_ref", secretId:$sid, version:"latest" }
          # ...keep any existing plain/secret_ref entries here...
        } } }')"
```

Verify the binding landed and is reachable:

```bash
curl -s "$PC/secrets/$GH_SECRET_ID/usage" | jq '.bindings[] | {target:.target.label, configPath}'
# expect an entry like { target: "pi-orchestrator", configPath: "env.GITHUB_TOKEN" }
```

After the agent's next run, confirm a successful resolve in the audit log:

```bash
curl -s "$PC/secrets/$GH_SECRET_ID/access-events" | jq '.[0] | {outcome, configPath, consumerType, errorCount:.errorCode}'
```

### A.5 Strict mode (defence-in-depth, optional) — GATED

`normalizeEnvConfig(..., { strictMode:true })` _refuses to persist_ a plaintext value
for a sensitive-looking key (anything matching `api_key|token|secret|password|…`),
forcing it to be a `secret_ref`. This is the guardrail that stops an agent config from
silently carrying a raw token again. Enabling strict mode is a deployment-level setting
(authenticated deployments warn if it's off), so flipping it on the **live** instance is
**GATED**. Plan: migrate all sensitive env to `secret_ref` first (A.2–A.4), _then_ turn
strict mode on so future edits can't regress.

### A.6 Back up the master key alongside the DB (do this once secrets exist)

DB backups are already on (hourly + pre-delete, in `paperclip-data/.../backups/`). Add
the master key to the same backup discipline — **without it the encrypted secrets are
unrecoverable**. Folder-scoped, no daemon:

```bash
# copy the key next to the backups (or into your existing offline backup target)
cp ~/.claude/... # N/A — the key is whatever PAPERCLIP_SECRETS_MASTER_KEY_FILE points to,
# or the default home key file. Locate it via the health check details.keyFilePath:
KEYFILE="$(curl -s "$PC/companies/$CO/secret-providers/health" \
  | jq -r '.providers[] | select(.provider=="local_encrypted") | .details.keyFilePath // empty')"
[ -n "$KEYFILE" ] && cp -p "$KEYFILE" "$(dirname "$KEYFILE")/master.key.backup-$(date +%Y%m%d)"
```

### A.7 Reversibility

- Secrets: `DELETE /secrets/:id` (soft-deletes; logs `secret.deleted`). Bindings vanish
  when you remove the `secret_ref` from the consumer env (PATCH it back to the plain
  value or drop the key).
- Nothing here touches the on-disk `gh`/Telegram tokens — leave them until a lane is
  fully verified on Paperclip, then optionally rotate.

---

## Part B — A sandbox environment that could contain a runaway

### B.0 What "sandbox" means in Paperclip (and the honest limit)

A sandbox is an **environment** row with `driver:"sandbox"` and a `provider` key that
maps to one of the installed sandbox-provider **plugins**: `e2b`, `modal`, `daytona`,
`exe-dev`, `cloudflare`. (`provider:"fake"` is the built-in probe stub and
**cannot be saved** — `environment-config.ts` rejects it for persistence.) Each plugin
defines its own `configSchema`, including the resource caps it supports:

| provider                           | timeout                                         | cpu              | memory           | disk             | where it runs       | secret field                    |
| ---------------------------------- | ----------------------------------------------- | ---------------- | ---------------- | ---------------- | ------------------- | ------------------------------- |
| `e2b`                              | `timeoutMs` (default 1h, refreshed per command) | template-defined | template-defined | template-defined | E2B cloud           | `apiKey` (`format: secret-ref`) |
| `exe-dev`                          | `timeoutMs` (default 5m)                        | `cpu`            | `memory`         | `disk`           | exe.dev VM over SSH | `sshPrivateKey` / `EXE_API_KEY` |
| `modal` / `daytona` / `cloudflare` | per-plugin (see each `manifest.ts`)             | per-plugin       | per-plugin       | per-plugin       | provider cloud      | per-plugin                      |

**Honesty: which of these would have stopped the disk-fill crash?**

- A _cloud_ sandbox (E2B/Modal/Daytona/Cloudflare) contains a disk-fill because the
  runaway fills the **sandbox's** ephemeral disk, not the host — the host stays healthy
  and the lease is torn down. **But the E2B config schema only exposes `timeoutMs`** —
  disk/memory caps come from the **E2B template**, not Paperclip config. So with E2B you
  cap _time_ in Paperclip and must cap _disk/memory in the template_.
- `exe-dev` is the one provider whose Paperclip-visible config takes explicit
  `cpu` / `memory` / `disk` flags, so it's the cleanest "caps live in Paperclip" story —
  at the cost of needing exe.dev SSH onboarding on the host first.

### B.1 Recommended first sandbox: E2B (time-capped) — definition

E2B's `apiKey` is `format: secret-ref`, so we store the key as a Paperclip secret and
reference it (saving the environment auto-creates a company secret if you paste a raw
value — but creating it explicitly keeps it in the audited vault).

```bash
# 1) Store the E2B API key as a secret (skip if you'll paste it into the env directly)
curl -s -X POST "$PC/companies/$CO/secrets" -H 'Content-Type: application/json' \
  -d '{"name":"dark-factory-e2b-api-key","key":"e2b_api_key","value":"<E2B key>"}'
# -> capture $E2B_SECRET_ID

# 2) (optional but recommended) Probe the config BEFORE saving — validates the plugin is
#    ready and the key works, without persisting anything:
curl -s -X POST "$PC/companies/$CO/environments/probe-config" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg sid "$E2B_SECRET_ID" '{
        name:"df-sandbox-e2b",
        driver:"sandbox",
        config:{ provider:"e2b", template:"base", apiKey:$sid, timeoutMs:1800000, reuseLease:false }
      }')" | jq '{ok, summary}'

# 3) Create the sandbox environment (timeout = 30 min; tear down between runs)
curl -s -X POST "$PC/companies/$CO/environments" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg sid "$E2B_SECRET_ID" '{
        name:"df-sandbox-e2b",
        description:"Disposable E2B sandbox for dark-factory runs (time-capped, torn down per run).",
        driver:"sandbox",
        config:{
          provider:"e2b",
          template:"df-capped",        # ← an E2B template that pins disk + memory (see B.3)
          apiKey:$sid,                  # secret-ref to the vault
          timeoutMs:1800000,           # 30 min hard lifetime, refreshed per command
          reuseLease:false             # fresh sandbox each run = clean disk each run
        } }')" | jq '{id, name, driver, status}'
# -> capture $ENV_ID
```

On save, `environments.ts` runs `normalizeEnvironmentConfigForPersistence` →
`validatePluginSandboxProviderConfig` (needs the plugin worker manager running) and
`syncSecretRefsForTarget` writes the `apiKey` binding. Confirm:

```bash
curl -s "$PC/environments/$ENV_ID/probe" | jq '{ok, summary}'         # live probe
curl -s "$PC/secrets/$E2B_SECRET_ID/usage" | jq '.bindings[].configPath'  # expect "apiKey"
```

### B.2 Alternative: exe-dev (caps fully in Paperclip config)

If you want disk/memory/cpu caps that live in Paperclip (not in a cloud template), use
`exe-dev`. Caveat from the plugin code: the Paperclip **host** must have SSH access to
the created VM and its SSH key must be registered with exe.dev (one-time `ssh exe.dev`
onboarding) — the API token only covers provisioning.

```bash
curl -s -X POST "$PC/companies/$CO/environments" \
  -H 'Content-Type: application/json' \
  -d '{
        "name":"df-sandbox-exedev",
        "driver":"sandbox",
        "config":{
          "provider":"exe-dev",
          "cpu":2,
          "memory":"2g",
          "disk":"10g",          # ← the disk cap that contains a disk-fill runaway
          "timeoutMs":1800000,   # 30 min
          "reuseLease":false,
          "apiKey":"<EXE key or set EXE_API_KEY in server env>"
        } }'
```

A disk-fill inside this VM hits the 10g ceiling and the run fails; the **host** is
untouched, and `reuseLease:false` means the next run starts on a fresh VM.

### B.3 The resource caps, summarised (the "runaway containment" contract)

For the env definitions above, the containment guarantees are:

- **Time**: `timeoutMs` is a hard lifetime, refreshed per command. A hung/looping run
  is killed at the ceiling. (E2B + exe-dev both honor this.)
- **Disk**: contained either by the **E2B template** (`df-capped`, B.1) or by exe-dev's
  `disk:"10g"` (B.2). This is what would have stopped the disk-fill crash.
- **Memory / CPU**: exe-dev `memory`/`cpu`; E2B via template.
- **Blast radius**: cloud providers run off-host, so a runaway can't fill the Mac's
  disk or OOM the host. `reuseLease:false` guarantees a clean disk per run.
- **Egress / secrets**: only the secrets you bind into the env/agent are present; the
  host's `gh` keychain and `~/.openclaw/credentials` are **not** visible inside a cloud
  sandbox (they would be, on a host/local run — that's the whole point of moving off-host).

---

## Part C — The honest, load-bearing gap: nothing is contained until execution routes through Paperclip

This is the part that must not be glossed. **Defining a sandbox environment does not, by
itself, contain anything.** The pi-local adapter's `execute.ts` reads an
`executionTarget` that is one of `local` / `ssh` / `sandbox`
(`adapter-utils/src/execution-target.ts`). The sandbox caps only apply to a run whose
`executionTarget.transport === "sandbox"` and whose `environmentId` points at the env
you defined.

**Today the ~38 pi-team agents do NOT run through Paperclip at all.** They run as host
`tmux` sessions (`pi-team-*`) launched by `openclaw-team.sh`, coordinated by a coms-net
hub, and advanced by the launchd Foreman (`factory-watchdog.mjs`). Only 3 agents are
even _registered_ in Paperclip, all adapter type `process`. So a disk-fill in a pi-team
worker today fills the **host** disk — exactly the crash we're trying to contain — and a
Paperclip sandbox env sitting in the DB does nothing about it.

To make a sandbox actually contain the factory, a lane's execution path has to change so
that the work runs _inside_ the environment. Concretely, that requires **all** of:

1. **The lane's agent is registered in Paperclip on the `pi-local` adapter** (not just
   `process`), so Paperclip owns the pi process and can choose an execution target. The
   3 current agents are `process`; the 38 pi-team workers aren't registered at all.
   (See workstream 02/04 for agent registration; this workstream depends on it.)
2. **The agent / project / issue selects the sandbox environment** so the run resolves an
   `environmentId`. Environments can be selected at agent, project, or issue level
   (`clearExecutionWorkspaceEnvironmentSelection` exists on all three in
   `environments.ts`’s delete path, which confirms all three carry a selection).
3. **The plugin worker manager is running** (sandbox config validation + lease acquire
   both require it — `environment-config.ts` throws "requires a running plugin worker
   manager" otherwise), and the chosen provider's plugin is installed and healthy
   (`GET /companies/$CO/environments/capabilities` lists ready sandbox providers).
4. **The run goes through Paperclip's environment-run path** (`environment-run-orchestrator`)
   which acquires a lease, realizes the workspace, and executes via the plugin's
   `onEnvironmentExecute`. The host tmux/launchd path bypasses all of this — so until the
   lane is moved onto Paperclip's executor (control-plane cutover), the sandbox is inert.

**Therefore sandbox adoption is GATED and per-lane**, mirroring the rest of the
migration:

- **Safe now (no gate):** create the secrets (Part A.2), define the sandbox environment
  (Part B), probe it, confirm health/bindings. None of this changes a running lane.
- **GATED (owner go, one lane at a time):** registering a lane's agent on `pi-local`,
  selecting the sandbox env for it, and cutting that lane's execution over from the host
  tmux/launchd path to Paperclip's environment-run path. Start with a **single low-stakes
  lane** (e.g. a research-\* or dead-code-followup worker), verify a real run executes in
  the sandbox (check `secret_access_events` + the env lease + transcript), then expand.
  Keep the host path runnable for that lane until the sandbox run is proven, so it's
  instantly reversible (re-point the lane back to host).

### C.1 Verification checklist before declaring a lane "sandboxed"

```bash
# plugin provider is ready
curl -s "$PC/companies/$CO/environments/capabilities" | jq '.sandboxProviders | keys'
# env probes green
curl -s "$PC/environments/$ENV_ID/probe" | jq '{ok, summary}'
# a real run produced a lease against this env
curl -s "$PC/environments/$ENV_ID/leases?status=active" | jq 'length'
# the secret was resolved INTO the sandboxed run (audit proof)
curl -s "$PC/secrets/$GH_SECRET_ID/access-events" | jq '.[0] | {outcome, consumerType, configPath}'
```

If the lease count stays 0 and access-events show no sandbox consumer, the lane is still
running on the host — the cutover hasn't happened, and the sandbox is not yet protecting
anything.

---

## Summary of gates

| Step                                                      | Safe now | GATED (owner go) | Why                                        |
| --------------------------------------------------------- | -------- | ---------------- | ------------------------------------------ |
| Create secrets (A.2)                                      | ✅       |                  | Additive; values never leave the vault     |
| Bind secret to project (A.3)                              | ✅       |                  | Reference only; picked up on next run      |
| Pin master key + restart (A.1)                            |          | ✅               | Restarts live Paperclip server             |
| Bind secret to live agent (A.4)                           |          | ✅               | Changes what a live agent run sees         |
| Enable strict mode (A.5)                                  |          | ✅               | Deployment-level; affects all future edits |
| Back up master key (A.6)                                  | ✅       |                  | Read-only copy of a key file               |
| Define sandbox env + probe (B)                            | ✅       |                  | DB row + probe; no running lane changes    |
| Register lane agent on pi-local, select env, cut over (C) |          | ✅               | Changes how a live lane executes           |

## Honest gaps / prerequisites

- **No raw model key to migrate (usually).** The factory authenticates models through
  the OpenClaw gateway, not a loose `OPENAI_API_KEY` the pi agents read. Only create a
  model-key secret if a specific sandbox lane calls a provider API directly. Migrating
  the _gateway's_ own auth is a separate, GATED concern (workstream 05/openclaw-gateway).
- **E2B disk/memory caps are not in Paperclip config** — they come from the E2B template.
  Either build a capped template (`df-capped`) or use `exe-dev` whose `disk`/`memory`/`cpu`
  caps live in Paperclip config.
- **`exe-dev` needs host SSH onboarding** (`ssh exe.dev`) and host SSH reachability to the
  VM; the API token alone is insufficient (per the plugin's own validation warning).
- **Sandbox containment is inert until cutover.** This is the single most important
  caveat: a sandbox env in the DB protects nothing while the lane still runs as a host
  tmux/launchd process. Containment is real only after the per-lane, GATED cutover in
  Part C — which itself depends on the agent being registered on the `pi-local` adapter
  (other workstreams) and the plugin worker manager running.
- **Master key = single point of failure for secret recovery.** DB backups without the
  key cannot restore secret values. A.6 is not optional once real secrets exist.
