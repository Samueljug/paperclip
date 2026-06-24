#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ACCOUNT_KINDS = new Set([
  "consumer_oauth_subscription",
  "business_api",
  "commercial_api_pool",
]);

const INDIVIDUAL_KIND = "individual_oauth_subscription";
const POOL_KIND = "pool";
const CLIPROXYAPI_KIND = "cliproxyapi_sidecar";
const ALLOWED_EXHAUSTION_ACTIONS = new Set(["queue", "fail", "downgrade_same_account"]);
const SENSITIVE_KEY_PATTERN = /prompt|output|token|email|account[_-]?id|full[_-]?account/i;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
const SECRET_LITERAL_PATTERN = /(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})/;

function stableHash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}

function redactAccountRef(accountRef) {
  return accountRef ? `acct_${stableHash(accountRef)}` : null;
}

function redactText(value) {
  return String(value || "")
    .replace(EMAIL_PATTERN, "[redacted-email]")
    .replace(SECRET_LITERAL_PATTERN, "[redacted-secret]");
}

function sanitizeAuditValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeAuditValue);
  if (!value || typeof value !== "object") return redactText(value);
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : sanitizeAuditValue(nested),
  ]));
}

function nowMs(request) {
  const raw = request?.now || new Date().toISOString();
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) throw new Error(`Invalid request.now value: ${raw}`);
  return parsed;
}

function decisionBase(verdict, action, reasons, request, details = {}) {
  const reasonList = Array.isArray(reasons) ? reasons : [reasons];
  return {
    schemaVersion: 1,
    verdict,
    action,
    selectedAccountRef: details.selectedAccountRef ? redactAccountRef(details.selectedAccountRef) : null,
    selectedModel: details.selectedModel || null,
    reasonCodes: reasonList.map((reason) => reason.code),
    evidence: buildDecisionEvidence(reasonList, request, details),
  };
}

function buildDecisionEvidence(reasons, request = {}, details = {}) {
  const evidence = {
    routeKind: request.route_kind || null,
    ownerContext: request.owner_context ? `ctx_${stableHash(request.owner_context)}` : null,
    project: request.project ? redactText(request.project) : null,
    model: request.model || null,
    claudeConfigDir: request.claude_config_dir ? `cfg_${stableHash(request.claude_config_dir)}` : null,
    selectedAccountRef: details.selectedAccountRef ? redactAccountRef(details.selectedAccountRef) : null,
    selectedModel: details.selectedModel || null,
    checkedAccountRefs: (details.checkedAccountRefs || []).map(redactAccountRef),
    eligibleAccountRefs: (details.eligibleAccountRefs || []).map(redactAccountRef),
    decisionReasons: reasons.map((reason) => ({
      code: reason.code,
      message: reason.message,
      accountRef: reason.accountRef ? redactAccountRef(reason.accountRef) : null,
    })),
  };
  if (request.audit_context) evidence.auditContext = sanitizeAuditValue(request.audit_context);
  if (details.boundary) evidence.boundary = sanitizeAuditValue(details.boundary);
  return evidence;
}

function reason(code, message, accountRef = null) {
  return { code, message, accountRef };
}

function deny(reasons, request, details = {}) {
  return decisionBase("deny", "fail_closed", reasons, request, details);
}

function queue(reasons, request, details = {}) {
  return decisionBase("queue", "queue_same_account", reasons, request, details);
}

function allow(request, details = {}) {
  return decisionBase("allow", "route", [reason("eligible", "Selected one eligible account.")], request, details);
}

function accountRef(account) {
  return account?.account_ref || account?.ref || account?.id || "";
}

function includesValue(values, value) {
  return Array.isArray(values) && values.includes(value);
}

function capWindowApplies(window, model) {
  if (!Array.isArray(window.applies_to_models) || window.applies_to_models.length === 0) return true;
  return window.applies_to_models.includes(model);
}

function capWindowAvailable(account, request, model) {
  const windows = Array.isArray(account.cap_windows) ? account.cap_windows : [];
  const now = nowMs(request);
  const exhausted = windows.find((window) => {
    if (!capWindowApplies(window, model)) return false;
    if (window.reset_at && Date.parse(window.reset_at) <= now) return false;
    return Number(window.used || 0) >= Number(window.limit || 0);
  });
  return exhausted
    ? reason("cap_window_exhausted", `Cap window ${exhausted.key || "unnamed"} is exhausted.`, accountRef(account))
    : null;
}

function concurrencyAvailable(account) {
  const concurrency = account.concurrency || {};
  if (Number(concurrency.max || 0) <= 0) {
    return reason("concurrency_missing", "Account concurrency.max must be a positive number.", accountRef(account));
  }
  if (Number(concurrency.in_flight || 0) >= Number(concurrency.max || 0)) {
    return reason("concurrency_exhausted", "Account concurrency is exhausted.", accountRef(account));
  }
  return null;
}

function stateAvailable(account, request) {
  const state = account.state || {};
  const status = state.status || "disabled";
  if (status !== "active") {
    return reason("state_not_active", `Account state is ${status}.`, accountRef(account));
  }
  if (state.cooldown_until && Date.parse(state.cooldown_until) > nowMs(request)) {
    return reason("cooldown_active", "Account cooldown is still active.", accountRef(account));
  }
  return null;
}

function validateAccountShape(account) {
  const ref = accountRef(account);
  const failures = [];
  if (!ref) failures.push(reason("missing_account_ref", "Account must have account_ref."));
  if (!ACCOUNT_KINDS.has(account.account_kind)) failures.push(reason("invalid_account_kind", "Account kind is not supported.", ref));
  if (!account.permission_citation) failures.push(reason("missing_permission_citation", "Account must cite permission for automated access.", ref));
  if (account.automated_access_permitted !== true) failures.push(reason("automated_access_not_permitted", "Automated access is not permitted.", ref));
  if (account.seat_licensed !== true) failures.push(reason("seat_not_licensed", "Account seat is not licensed.", ref));
  if (!Array.isArray(account.model_allowlist) || account.model_allowlist.length === 0) failures.push(reason("missing_model_allowlist", "Account must define model_allowlist.", ref));
  if (!account.secret_ref) failures.push(reason("missing_secret_ref", "Account must use a secret_ref, not inline credentials.", ref));
  if (account.secret_ref && SECRET_LITERAL_PATTERN.test(account.secret_ref)) failures.push(reason("inline_secret_rejected", "secret_ref must be a reference, not a raw secret.", ref));
  return failures;
}

function validateContextBinding(account, request) {
  const ref = accountRef(account);
  const ownerBindings = Array.isArray(account.owner_context) ? account.owner_context : [account.owner_context].filter(Boolean);
  const projectBindings = Array.isArray(account.project_bindings) ? account.project_bindings : [];
  const failures = [];
  if (request.owner_context && !ownerBindings.includes(request.owner_context)) {
    failures.push(reason("owner_context_mismatch", "Account is not bound to this owner context.", ref));
  }
  if (request.project && !projectBindings.includes(request.project)) {
    failures.push(reason("project_binding_mismatch", "Account is not bound to this project.", ref));
  }
  return failures;
}

function accountEligibility(account, request, options = {}) {
  const model = options.model || request.model;
  const failures = [
    ...validateAccountShape(account),
    ...validateContextBinding(account, request),
  ];
  const ref = accountRef(account);
  if (model && !includesValue(account.model_allowlist, model)) {
    failures.push(reason("model_not_allowed", "Requested model is not in the account allowlist.", ref));
  }
  const state = stateAvailable(account, request);
  if (state) failures.push(state);
  const cap = capWindowAvailable(account, request, model);
  if (cap) failures.push(cap);
  const concurrency = concurrencyAvailable(account);
  if (concurrency) failures.push(concurrency);
  return failures;
}

function registryAccounts(registry) {
  return Array.isArray(registry?.accounts) ? registry.accounts : [];
}

function findAccount(registry, ref) {
  return registryAccounts(registry).find((account) => accountRef(account) === ref) || null;
}

function stableAccountSort(accounts) {
  return [...accounts].sort((a, b) => {
    const aPriority = Number.isFinite(a.routing_priority) ? a.routing_priority : 1000;
    const bPriority = Number.isFinite(b.routing_priority) ? b.routing_priority : 1000;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return accountRef(a).localeCompare(accountRef(b));
  });
}

function staticMappingRef(registry, request) {
  const mappings = Array.isArray(registry?.context_mappings) ? registry.context_mappings : [];
  const match = mappings.find((mapping) => (
    (!request.claude_config_dir || mapping.claude_config_dir === request.claude_config_dir)
    && (!request.owner_context || mapping.owner_context === request.owner_context)
    && (!request.project || mapping.project === request.project)
  ));
  return match?.account_ref || null;
}

function individualCandidates(registry, request) {
  const mappedRef = request.account_ref || staticMappingRef(registry, request);
  if (mappedRef) {
    const mapped = findAccount(registry, mappedRef);
    return mapped ? [mapped] : [];
  }
  return registryAccounts(registry).filter((account) => account.account_kind === "consumer_oauth_subscription");
}

function decideIndividual(registry, request, boundary = null) {
  const candidates = individualCandidates(registry, request);
  const checkedAccountRefs = candidates.map(accountRef);
  if (candidates.length === 0) {
    return deny(reason("no_static_account_mapping", "No account is statically mapped for this individual context."), request, { checkedAccountRefs, boundary });
  }
  if (candidates.length !== 1) {
    return deny(reason("ambiguous_individual_context", "Individual OAuth contexts must resolve to exactly one account."), request, { checkedAccountRefs, boundary });
  }

  const account = candidates[0];
  const ref = accountRef(account);
  const failures = accountEligibility(account, request);
  const nonCapFailures = failures.filter((failure) => failure.code !== "cap_window_exhausted");
  if (nonCapFailures.length > 0) {
    return deny(nonCapFailures, request, { checkedAccountRefs, selectedAccountRef: ref, boundary });
  }

  const capFailure = failures.find((failure) => failure.code === "cap_window_exhausted");
  if (capFailure) {
    const action = request.same_account_exhaustion_action || "queue";
    if (!ALLOWED_EXHAUSTION_ACTIONS.has(action)) {
      return deny(reason("invalid_exhaustion_action", "same_account_exhaustion_action must be queue, fail, or downgrade_same_account.", ref), request, { checkedAccountRefs, selectedAccountRef: ref, boundary });
    }
    if (action === "queue") {
      return queue(capFailure, request, { checkedAccountRefs, selectedAccountRef: ref, boundary });
    }
    if (action === "fail") {
      return deny(reason("cap_exhausted_no_fallback", "Selected account is capped; cross-account fallback is forbidden.", ref), request, { checkedAccountRefs, selectedAccountRef: ref, boundary });
    }
    const downgradeModel = request.downgrade_model;
    if (!downgradeModel || downgradeModel === request.model) {
      return deny(reason("downgrade_model_missing", "downgrade_same_account requires a different downgrade_model.", ref), request, { checkedAccountRefs, selectedAccountRef: ref, boundary });
    }
    const downgradeFailures = accountEligibility(account, request, { model: downgradeModel });
    if (downgradeFailures.length > 0) {
      return deny(downgradeFailures, request, { checkedAccountRefs, selectedAccountRef: ref, selectedModel: downgradeModel, boundary });
    }
    return decisionBase("allow", "downgrade_same_account", [reason("same_account_downgrade", "Selected same account with configured downgrade model.", ref)], request, {
      checkedAccountRefs,
      eligibleAccountRefs: [ref],
      selectedAccountRef: ref,
      selectedModel: downgradeModel,
      boundary,
    });
  }

  return allow(request, {
    checkedAccountRefs,
    eligibleAccountRefs: [ref],
    selectedAccountRef: ref,
    selectedModel: request.model,
    boundary,
  });
}

function validatePool(registry, request) {
  const poolId = request.pool_id;
  if (!poolId) return { accounts: [], failures: [reason("missing_pool_id", "Pool routing requires pool_id.")] };
  const accounts = registryAccounts(registry).filter((account) => account.pool_id === poolId);
  const poolShapeFailures = accounts.flatMap((account) => {
    const failures = [];
    const ref = accountRef(account);
    if (account.account_kind === "consumer_oauth_subscription") failures.push(reason("consumer_pool_forbidden", "Consumer OAuth subscription accounts cannot be pooled.", ref));
    if (account.pool_permitted !== true) failures.push(reason("pool_not_permitted", "Every pool account must set pool_permitted=true.", ref));
    if (!account.permission_citation) failures.push(reason("missing_permission_citation", "Every pool account must cite pool permission.", ref));
    return failures;
  });
  if (accounts.length === 0) poolShapeFailures.push(reason("pool_not_found", "No accounts found for pool_id."));
  return { accounts, failures: poolShapeFailures };
}

function decidePool(registry, request) {
  const { accounts, failures } = validatePool(registry, request);
  const checkedAccountRefs = accounts.map(accountRef);
  if (failures.length > 0) return deny(failures, request, { checkedAccountRefs });
  const eligible = stableAccountSort(accounts).filter((account) => accountEligibility(account, request).length === 0);
  if (eligible.length === 0) {
    const eligibilityFailures = accounts.flatMap((account) => accountEligibility(account, request));
    return deny(eligibilityFailures.length ? eligibilityFailures : reason("no_eligible_pool_account", "No eligible pool account found."), request, { checkedAccountRefs });
  }
  const selected = eligible[0];
  return allow(request, {
    checkedAccountRefs,
    eligibleAccountRefs: eligible.map(accountRef),
    selectedAccountRef: accountRef(selected),
    selectedModel: request.model,
  });
}

export function validateCliProxyApiBoundary(config = {}) {
  const errors = [];
  const nativeSwitching = config.native_switching_enabled === true
    || config.native_account_switching === true
    || config.enable_native_switching === true;
  if (nativeSwitching) errors.push("CLIProxyAPI native account switching must be disabled.");
  if (Array.isArray(config.account_refs) && config.account_refs.length !== 1) {
    errors.push("CLIProxyAPI sidecar must be bound to exactly one account_ref.");
  }
  if (!Array.isArray(config.account_refs) && config.account_ref === undefined) {
    errors.push("CLIProxyAPI sidecar must declare account_ref or account_refs with one entry.");
  }
  if (Array.isArray(config.fallback_account_refs) && config.fallback_account_refs.length > 0) {
    errors.push("CLIProxyAPI sidecar cannot define fallback_account_refs.");
  }
  return { ok: errors.length === 0, errors };
}

export function decideRoute(registry = {}, request = {}) {
  const routeKind = request.route_kind;
  if (routeKind === INDIVIDUAL_KIND) return decideIndividual(registry, request);
  if (routeKind === POOL_KIND) return decidePool(registry, request);
  if (routeKind === CLIPROXYAPI_KIND) {
    const boundary = validateCliProxyApiBoundary(request.cliproxyapi || {});
    if (!boundary.ok) return deny(boundary.errors.map((message) => reason("cliproxyapi_boundary_invalid", message)), request, { boundary });
    const configuredRef = Array.isArray(request.cliproxyapi.account_refs)
      ? request.cliproxyapi.account_refs[0]
      : request.cliproxyapi.account_ref;
    return decideIndividual(registry, { ...request, route_kind: INDIVIDUAL_KIND, account_ref: configuredRef }, boundary);
  }
  return deny(reason("unsupported_route_kind", "Unsupported route_kind."), request);
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function usage() {
  return [
    "Usage:",
    "  account-context-gateway.mjs decide --registry registry.json --request request.json",
    "  account-context-gateway.mjs validate-cliproxyapi --config config.json",
  ].join("\n");
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || args.includes("--help")) {
    console.log(usage());
    return;
  }
  if (command === "decide") {
    const registryPath = argValue(args, "--registry");
    const requestPath = argValue(args, "--request");
    if (!registryPath || !requestPath) throw new Error("--registry and --request are required");
    console.log(JSON.stringify(decideRoute(readJson(registryPath), readJson(requestPath)), null, 2));
    return;
  }
  if (command === "validate-cliproxyapi") {
    const configPath = argValue(args, "--config");
    if (!configPath) throw new Error("--config is required");
    const result = validateCliProxyApiBoundary(readJson(configPath));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown command: ${command}\n${usage()}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
