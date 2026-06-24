# Compliant Account Context Routing

Backlinks: [Wiki Home](README.md), [Source Map](source-map.md)

## Purpose

Document the safe OPE-179/OPE-413 account-context gateway slice for local AI routing.

This page covers the compliant implementation only. It explicitly does not implement random traffic distribution, anti-detection behavior, stealth, consumer OAuth subscription pooling, consumer subscription sharing, or cross-account fallback when a subscription context is at cap.

## How It Works

`tools/dark-factory/account-context-gateway.mjs` is a deterministic policy/router module and small CLI harness. It consumes an account registry plus a routing request and returns one redacted decision:

- `allow`: route to exactly one eligible account.
- `queue`: queue the same mapped account when cap exhaustion is configured to queue.
- `deny`: fail closed.

The router never mutates account state, never stores secrets, and never logs raw prompts, outputs, tokens, emails, or full account identifiers. Audit evidence is built from a small whitelist and account references are hashed before leaving the decision object.

## Account Registry

Each account record is modeled with only operational and compliance fields:

```json
{
  "account_ref": "opaque-local-alias",
  "account_kind": "consumer_oauth_subscription",
  "owner_context": "personal",
  "project_bindings": ["dark-factory"],
  "permission_citation": "OPE-179 safe-scope approval",
  "pool_permitted": false,
  "automated_access_permitted": true,
  "seat_licensed": true,
  "model_allowlist": ["claude-sonnet"],
  "state": { "status": "active" },
  "cap_windows": [
    { "key": "daily-sonnet", "limit": 10, "used": 0, "reset_at": "2026-06-13T00:00:00.000Z" }
  ],
  "concurrency": { "max": 1, "in_flight": 0 },
  "secret_ref": "op://dark-factory/account/oauth"
}
```

Use secret references only. Do not put raw OAuth refresh tokens, API keys, cookies, account emails, or provider account IDs in fixtures, docs, logs, or registry files.

Required eligibility checks fail closed:

- permission citation exists;
- automated access is permitted;
- seat is licensed;
- requested model is allowlisted;
- account state is active and outside cooldown;
- cap windows are available;
- concurrency is available;
- owner context and project bindings match;
- secret is a reference, not an inline credential.

## Routing Model

Individual OAuth subscription routing is static and single-account. A request may name `account_ref` directly, or it may resolve through `context_mappings`. If the mapped account is capped, disabled, cooling down, or over concurrency, the router queues or denies that same account according to `same_account_exhaustion_action`. It does not try another consumer subscription account.

Allowed cap-exhaustion actions:

- `queue`: return `queue_same_account`.
- `fail`: fail closed with no fallback.
- `downgrade_same_account`: route the same account only if a different `downgrade_model` is configured and eligible for that same account.

Pool routing is allowed only for explicit commercial/API/business pools. Every account in the pool must be non-consumer, have `pool_permitted=true`, and include a permission citation. If any pool member fails those pool-level checks, the whole pool decision denies.

Pool selection is deterministic: eligible accounts are ordered by `routing_priority`, then by account alias. There is no random distribution or traffic shaping.

## CLAUDE_CONFIG_DIR Usage

Use separate static Claude config directories as context boundaries:

```json
{
  "context_mappings": [
    {
      "claude_config_dir": "/safe/static/personal",
      "owner_context": "personal",
      "project": "dark-factory",
      "account_ref": "opaque-local-alias"
    }
  ]
}
```

When `claude_config_dir` is present, the router resolves to the mapped account only. If that account is not eligible, the request queues or fails closed. It does not randomly choose another account.

## CLIProxyAPI Boundary

CLIProxyAPI is modeled only as a single-account sidecar boundary. Native account switching must stay disabled.

Rejected config examples:

```json
{
  "native_switching_enabled": true,
  "account_refs": ["account-a", "account-b"],
  "fallback_account_refs": ["account-b"]
}
```

Accepted shape:

```json
{
  "native_switching_enabled": false,
  "account_ref": "opaque-local-alias"
}
```

The validation helper rejects native switching flags, multiple `account_refs`, and fallback account lists.

## No-Go Examples

Do not implement or configure:

- random traffic distribution to make usage look human;
- stealth, proxy, fingerprint, timing jitter, anti-ban, or terms-workaround logic;
- consumer OAuth subscription pooling;
- fallback from one consumer subscription to another when a limit is hit;
- raw prompts, outputs, tokens, emails, full account IDs, cookies, or secrets in audit logs;
- raw secret material in registry files.

## Key Files And Commands

- [../account-context-gateway.mjs](../account-context-gateway.mjs)
- [../account-context-gateway.test.mjs](../account-context-gateway.test.mjs)

```bash
node tools/dark-factory/account-context-gateway.mjs decide --registry registry.json --request request.json
node tools/dark-factory/account-context-gateway.mjs validate-cliproxyapi --config cliproxyapi.json
node --test tools/dark-factory/account-context-gateway.test.mjs
```

## Test Evidence

Verification run on 2026-06-12:

```bash
node --test tools/dark-factory/account-context-gateway.test.mjs
```

Result: 8 tests passed.

Covered cases:

- missing permission citation denies;
- `pool_permitted=false` denies pool selection;
- personal/work OAuth subscription A at cap does not fall back to B;
- same-account queue, fail, and downgrade behavior is explicit;
- CLIProxyAPI native switching flags are rejected;
- audit redaction blocks prompt, output, token, email, and full account ID leakage;
- cap window, state/cooldown, and concurrency reject eligibility;
- `CLAUDE_CONFIG_DIR` static mapping does not randomly choose accounts.

## Source Files Inspected

- [../README.md](../README.md)
- [README.md](README.md)
- [schemas-artifacts.md](schemas-artifacts.md)
- [source-map.md](source-map.md)
- [../schemas/task-route-contract.schema.json](../schemas/task-route-contract.schema.json)
- [../conformance.mjs](../conformance.mjs)

## When This Changes, Update

- [Source Map](source-map.md) with implementation, tests, and command changes.
- [Wiki Home](README.md) if navigation or operator commands change.
- This page's test evidence when safety cases or verification commands change.
