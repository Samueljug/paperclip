#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import { decideRoute, validateCliProxyApiBoundary } from "./account-context-gateway.mjs";

const now = "2026-06-12T00:00:00.000Z";
const syntheticEmail = ["person", "example.invalid"].join("@");
const syntheticToken = ["synthetic", "token", "value"].join("-");
const syntheticFullAccountId = ["provider", "account", "123"].join("-");

function account(overrides = {}) {
  return {
    account_ref: "ctx-alpha",
    account_kind: "consumer_oauth_subscription",
    owner_context: "personal",
    project_bindings: ["dark-factory"],
    permission_citation: "OPE-179 safe-scope approval",
    pool_permitted: false,
    automated_access_permitted: true,
    seat_licensed: true,
    model_allowlist: ["claude-sonnet", "claude-haiku"],
    state: { status: "active" },
    cap_windows: [{ key: "daily-sonnet", limit: 10, used: 0, reset_at: "2026-06-13T00:00:00.000Z", applies_to_models: ["claude-sonnet"] }],
    concurrency: { max: 1, in_flight: 0 },
    secret_ref: "op://dark-factory/account-alpha/oauth",
    ...overrides,
  };
}

function individualRequest(overrides = {}) {
  return {
    route_kind: "individual_oauth_subscription",
    owner_context: "personal",
    project: "dark-factory",
    model: "claude-sonnet",
    now,
    account_ref: "ctx-alpha",
    ...overrides,
  };
}

function assertNoSensitiveLeak(decision) {
  const serialized = JSON.stringify(decision);
  assert.equal(serialized.includes("Write a secret prompt"), false);
  assert.equal(serialized.includes("raw model output"), false);
  assert.equal(serialized.includes(syntheticEmail), false);
  assert.equal(serialized.includes(syntheticToken), false);
  assert.equal(serialized.includes(syntheticFullAccountId), false);
  assert.equal(serialized.includes("ctx-alpha"), false);
  assert.equal(serialized.includes("ctx-beta"), false);
}

test("missing permission citation denies fail-closed", () => {
  const registry = { accounts: [account({ permission_citation: "" })] };
  const decision = decideRoute(registry, individualRequest());

  assert.equal(decision.verdict, "deny");
  assert.equal(decision.action, "fail_closed");
  assert.ok(decision.reasonCodes.includes("missing_permission_citation"));
});

test("pool_permitted=false denies pool selection", () => {
  const registry = {
    accounts: [
      account({
        account_ref: "biz-alpha",
        account_kind: "business_api",
        owner_context: "company",
        project_bindings: ["dark-factory"],
        pool_id: "approved-business-pool",
        pool_permitted: false,
      }),
    ],
  };

  const decision = decideRoute(registry, {
    route_kind: "pool",
    pool_id: "approved-business-pool",
    owner_context: "company",
    project: "dark-factory",
    model: "claude-sonnet",
    now,
  });

  assert.equal(decision.verdict, "deny");
  assert.ok(decision.reasonCodes.includes("pool_not_permitted"));
});

test("consumer OAuth subscription at cap does not fall back to another account", () => {
  const registry = {
    accounts: [
      account({ cap_windows: [{ key: "daily-sonnet", limit: 1, used: 1, reset_at: "2026-06-13T00:00:00.000Z", applies_to_models: ["claude-sonnet"] }] }),
      account({
        account_ref: "ctx-beta",
        owner_context: "work",
        cap_windows: [{ key: "daily-sonnet", limit: 10, used: 0, reset_at: "2026-06-13T00:00:00.000Z", applies_to_models: ["claude-sonnet"] }],
        secret_ref: "op://dark-factory/account-beta/oauth",
      }),
    ],
    context_mappings: [
      { claude_config_dir: "/safe/static/personal", owner_context: "personal", project: "dark-factory", account_ref: "ctx-alpha" },
      { claude_config_dir: "/safe/static/work", owner_context: "work", project: "dark-factory", account_ref: "ctx-beta" },
    ],
  };

  const decision = decideRoute(registry, individualRequest({
    claude_config_dir: "/safe/static/personal",
    same_account_exhaustion_action: "fail",
  }));

  assert.equal(decision.verdict, "deny");
  assert.ok(decision.reasonCodes.includes("cap_exhausted_no_fallback"));
  assert.equal(decision.evidence.checkedAccountRefs.length, 1);
  assert.equal(decision.selectedAccountRef, decision.evidence.checkedAccountRefs[0]);
});

test("same-account cap exhaustion action is explicit for queue, fail, and downgrade", () => {
  const capped = account({
    cap_windows: [{ key: "daily-sonnet", limit: 1, used: 1, reset_at: "2026-06-13T00:00:00.000Z", applies_to_models: ["claude-sonnet"] }],
  });
  const registry = { accounts: [capped] };

  const queued = decideRoute(registry, individualRequest({ same_account_exhaustion_action: "queue" }));
  assert.equal(queued.verdict, "queue");
  assert.equal(queued.action, "queue_same_account");

  const failed = decideRoute(registry, individualRequest({ same_account_exhaustion_action: "fail" }));
  assert.equal(failed.verdict, "deny");
  assert.ok(failed.reasonCodes.includes("cap_exhausted_no_fallback"));

  const downgraded = decideRoute(registry, individualRequest({
    same_account_exhaustion_action: "downgrade_same_account",
    downgrade_model: "claude-haiku",
  }));
  assert.equal(downgraded.verdict, "allow");
  assert.equal(downgraded.action, "downgrade_same_account");
  assert.equal(downgraded.selectedModel, "claude-haiku");
});

test("CLIProxyAPI native switching flags are rejected", () => {
  const boundary = validateCliProxyApiBoundary({
    account_refs: ["ctx-alpha", "ctx-beta"],
    native_switching_enabled: true,
    fallback_account_refs: ["ctx-beta"],
  });

  assert.equal(boundary.ok, false);
  assert.match(boundary.errors.join("\n"), /native account switching/i);
  assert.match(boundary.errors.join("\n"), /exactly one account_ref/i);
  assert.match(boundary.errors.join("\n"), /fallback_account_refs/i);
});

test("audit evidence redacts prompts, outputs, tokens, emails, and full account IDs", () => {
  const decision = decideRoute({ accounts: [account()] }, individualRequest({
    audit_context: {
      prompt: "Write a secret prompt",
      output: "raw model output",
      email: syntheticEmail,
      token: syntheticToken,
      full_account_id: syntheticFullAccountId,
      nested: { safe_note: `hello ${syntheticEmail}` },
    },
  }));

  assert.equal(decision.verdict, "allow");
  assertNoSensitiveLeak(decision);
  assert.equal(decision.evidence.auditContext.prompt, "[redacted]");
  assert.equal(decision.evidence.auditContext.nested.safe_note, "hello [redacted-email]");
});

test("cap window, state, cooldown, and concurrency reject eligibility", () => {
  const capDecision = decideRoute({ accounts: [account({
    cap_windows: [{ key: "daily-sonnet", limit: 1, used: 1, reset_at: "2026-06-13T00:00:00.000Z", applies_to_models: ["claude-sonnet"] }],
  })] }, individualRequest({ same_account_exhaustion_action: "fail" }));
  assert.ok(capDecision.reasonCodes.includes("cap_exhausted_no_fallback"));

  const disabledDecision = decideRoute({ accounts: [account({ state: { status: "disabled" } })] }, individualRequest());
  assert.ok(disabledDecision.reasonCodes.includes("state_not_active"));

  const cooldownDecision = decideRoute({ accounts: [account({ state: { status: "active", cooldown_until: "2026-06-12T01:00:00.000Z" } })] }, individualRequest());
  assert.ok(cooldownDecision.reasonCodes.includes("cooldown_active"));

  const concurrencyDecision = decideRoute({ accounts: [account({ concurrency: { max: 1, in_flight: 1 } })] }, individualRequest());
  assert.ok(concurrencyDecision.reasonCodes.includes("concurrency_exhausted"));
});

test("CLAUDE_CONFIG_DIR mapping selects statically and does not randomly choose accounts", () => {
  const registry = {
    accounts: [
      account({ account_ref: "ctx-beta", owner_context: "work", secret_ref: "op://dark-factory/account-beta/oauth" }),
      account({ account_ref: "ctx-alpha", routing_priority: 999 }),
    ],
    context_mappings: [
      { claude_config_dir: "/safe/static/personal", owner_context: "personal", project: "dark-factory", account_ref: "ctx-alpha" },
    ],
  };
  const request = individualRequest({ account_ref: undefined, claude_config_dir: "/safe/static/personal" });
  const first = decideRoute(registry, request);
  const second = decideRoute(registry, request);

  assert.equal(first.verdict, "allow");
  assert.equal(first.selectedAccountRef, second.selectedAccountRef);
  assert.equal(first.evidence.checkedAccountRefs.length, 1);
  assertNoSensitiveLeak(first);
});
