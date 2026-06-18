#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LEDGER_ROOT, readLedgerEvents, verifyLedger } from "./ledger-lib.mjs";

const DEFAULT_API = process.env.PAPERCLIP_API_BASE || "http://127.0.0.1:3101/api";
const DEFAULT_COMPANY = process.env.PAPERCLIP_COMPANY_ID || "1e8bc12a-f8fd-431c-9fbd-e47be79446a3";
const DEFAULT_DARK_FACTORY_PROJECT_ID = process.env.PAPERCLIP_DARK_FACTORY_PROJECT_ID || "c4525f28-55d1-4378-864c-aec26d51fc37";
const DEFAULT_STATUSES = ["done", "in_review"];
const IMPROVER_EVENTS = new Set(["improvement_review", "improvement_noop", "improvement_not_applicable", "gate_result:self_improvement"]);
const REVIEW_EVENTS = new Set(["improvement_review", "gate_result:self_improvement"]);
const NOOP_EVENTS = new Set(["improvement_noop"]);
const NA_EVENTS = new Set(["improvement_not_applicable"]);
const ADVISORY_NOTE = "Improver coverage audit: Paperclip comments/attachments are visibility mirrors only. Canonical authority remains Foreman/run artifacts and the factory ledger; Option B attribution is advisory/display-only, not non-forgeable identity evidence.";

function usage() {
  return [
    "Usage:",
    "  improver-coverage-audit.mjs [--issue OPE-123] [--status done,in_review] [--project-id UUID]",
    "                              [--project NAME] [--include-active] [--all-statuses]",
    "                              [--require-ledger] [--format json|text] [--fail-closed]",
    "",
    "Examples:",
    "  node tools/paperclip-board/improver-coverage-audit.mjs --status done --format text",
    "  node tools/paperclip-board/improver-coverage-audit.mjs --issue OPE-278 --require-ledger --fail-closed --format json",
    "  node tools/paperclip-board/improver-coverage-audit.mjs --include-active --format json",
  ].join("\n");
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    let value = "true";
    if (next && !next.startsWith("--")) {
      value = next;
      i += 1;
    }
    if (out[key] === undefined) out[key] = value;
    else if (Array.isArray(out[key])) out[key].push(value);
    else out[key] = [out[key], value];
  }
  return out;
}

function values(args, key) {
  const raw = args[key];
  if (raw === undefined || raw === null || raw === "false") return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => item !== "true");
}

function boolArg(args, key) {
  const value = args[key];
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) throw new Error(`--${key} is a boolean flag and may only be provided once`);
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`--${key} is a boolean flag; do not provide a value`);
}

function normalizeToken(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "-");
}

function displayValue(value) {
  return String(value || "").trim();
}

function hasNonEmptyValue(value) {
  if (Array.isArray(value)) return value.some((item) => hasNonEmptyValue(item));
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return String(value || "").trim().length > 0;
}

function commentText(comment) {
  return [comment.body, comment.metadata, comment.presentation]
    .map((value) => {
      if (value === null || value === undefined) return "";
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join("\n");
}

function lowerCommentText(comment) {
  return commentText(comment).toLowerCase();
}

function rowsFromMetadata(metadata) {
  const rows = [];
  if (!metadata || typeof metadata !== "object") return rows;
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value !== "object" || value === null) rows.push({ label: key, value });
  }
  for (const section of Array.isArray(metadata.sections) ? metadata.sections : []) {
    for (const row of Array.isArray(section?.rows) ? section.rows : []) {
      if (row && row.label !== undefined && row.value !== undefined) rows.push({ label: row.label, value: row.value });
    }
  }
  return rows;
}

function metadataValue(comment, labels) {
  const wanted = new Set(labels.map((item) => normalizeToken(item).replace(/-/g, "_")));
  for (const row of rowsFromMetadata(comment.metadata)) {
    const label = normalizeToken(row.label).replace(/-/g, "_");
    if (wanted.has(label)) return displayValue(row.value);
  }
  return null;
}

function parseRole(comment) {
  const fromMetadata = metadataValue(comment, ["role", "actor_role", "actorRole", "coms_net_target"]);
  if (fromMetadata) return normalizeToken(fromMetadata);
  const body = String(comment.body || "");
  const prefix = body.match(/^\s*\[([^\]\n]+)\]/);
  if (prefix) return normalizeToken(prefix[1]);
  const title = String(comment.presentation?.title || "");
  const titleMatch = title.match(/role comment:\s*([^\n]+)/i);
  if (titleMatch) return normalizeToken(titleMatch[1]);
  return null;
}

function parseEventType(comment) {
  const fromMetadata = metadataValue(comment, ["event_type", "eventType", "event"]);
  if (fromMetadata) return normalizeToken(fromMetadata).replace(/-/g, "_");
  const body = String(comment.body || "");
  const explicit = body.match(/^\s*(?:[-*]\s*)?(?:Event type|Event|EVENT_TYPE)\s*[:=]\s*([A-Za-z0-9_.:-]+)/mi);
  if (explicit) return normalizeToken(explicit[1]).replace(/-/g, "_");
  return null;
}

function parseTaskId(comment) {
  const fromMetadata = metadataValue(comment, ["task_id", "taskId"]);
  if (fromMetadata) return displayValue(fromMetadata);
  const body = String(comment.body || "");
  const match = body.match(/^\s*Task:\s*(.+)$/mi);
  return match ? displayValue(match[1]) : null;
}

function parseRunFolder(comment) {
  const fromMetadata = metadataValue(comment, ["run_folder", "runFolder"]);
  if (fromMetadata) return displayValue(fromMetadata);
  const body = String(comment.body || "");
  const match = body.match(/^\s*Run:\s*(.+)$/mi);
  return match ? displayValue(match[1]) : null;
}

function parseOwner(comment) {
  const fromMetadata = metadataValue(comment, ["owner", "reviewer", "owner_reviewer", "ownerReviewer"]);
  if (fromMetadata) return displayValue(fromMetadata);
  const body = String(comment.body || "");
  const match = body.match(/^\s*Owner\/?reviewer:\s*(.+)$/mi) || body.match(/^\s*Reviewer:\s*(.+)$/mi);
  return match ? displayValue(match[1]) : null;
}

function parseNaReason(comment) {
  const fromMetadata = metadataValue(comment, ["not_applicable_reason", "notApplicableReason", "reason"]);
  if (fromMetadata) return displayValue(fromMetadata);
  const body = String(comment.body || "");
  const match = body.match(/^\s*(?:N\/A reason|Not-applicable reason|Not applicable reason|Reason):\s*(.+)$/mi);
  return match ? displayValue(match[1]) : null;
}

function isSweeperOrGenericBlocker(comment) {
  const text = lowerCommentText(comment);
  const title = String(comment.presentation?.title || "").toLowerCase();
  return text.includes("<!-- pr-task-sweeper") || title.includes("pr/task sweeper");
}

function classifyComment(comment) {
  if (isSweeperOrGenericBlocker(comment)) return null;
  const role = parseRole(comment);
  const eventType = parseEventType(comment);
  const body = String(comment.body || "").toLowerCase();
  const bodyRolePrefix = /^\s*\[(self-improvement-lead|improver)\]/.test(body);
  const isImproverRole = role === "self-improvement-lead" || role === "improver" || bodyRolePrefix;
  if (!isImproverRole || !IMPROVER_EVENTS.has(eventType)) return null;

  let coverageType = "unknown";
  if (NOOP_EVENTS.has(eventType)) coverageType = "noop";
  else if (NA_EVENTS.has(eventType)) coverageType = "not_applicable";
  else if (REVIEW_EVENTS.has(eventType)) coverageType = "review";

  const owner = parseOwner(comment) || role || null;
  const notApplicableReason = parseNaReason(comment);
  const isAuthorizedAgent = comment.authorAgentId === "123b94fa-8452-45c4-b47e-071011b3372a";
  const validAgent = (coverageType === "review" || coverageType === "noop") ? isAuthorizedAgent : true;

  const valid = coverageType === "not_applicable"
    ? hasNonEmptyValue(owner) && hasNonEmptyValue(notApplicableReason)
    : validAgent;

  return {
    commentId: comment.id || null,
    createdAt: comment.createdAt || null,
    role,
    eventType,
    coverageType,
    taskId: parseTaskId(comment),
    runFolder: parseRunFolder(comment),
    owner,
    notApplicableReason,
    valid,
    invalidReason: coverageType === "not_applicable" && !valid 
      ? "not_applicable requires non-empty owner/reviewer and reason" 
      : (!validAgent ? "unauthorized author agent for self-improvement review" : null),
  };
}

function classifyVisibleImproverCoverage(comments) {
  const improverComments = (comments || []).map(classifyComment).filter(Boolean);
  const byPrecedence = ["review", "noop", "not_applicable", "unknown"];
  const selected = improverComments
    .slice()
    .sort((a, b) => byPrecedence.indexOf(a.coverageType) - byPrecedence.indexOf(b.coverageType) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;
  return {
    present: Boolean(selected),
    coverageType: selected?.coverageType || "missing",
    selected,
    comments: improverComments,
    invalid: improverComments.filter((comment) => comment.valid === false),
  };
}

function ledgerCoverage(identifier, ledgerRoot) {
  const verification = verifyLedger(identifier, ledgerRoot);
  const events = readLedgerEvents(identifier, ledgerRoot);
  const improverEvents = events
    .filter((event) => ["improvement_review", "improvement_noop", "improvement_not_applicable", "gate_result"].includes(event.eventType))
    .filter((event) => event.eventType !== "gate_result" || String(event.summary || "").includes("self_improvement") || event.details?.gate === "self_improvement");
  const eventTypes = improverEvents.map((event) => event.eventType === "gate_result" ? "gate_result:self_improvement" : event.eventType);
  let coverageType = "missing";
  if (eventTypes.includes("improvement_review") || eventTypes.includes("gate_result:self_improvement")) coverageType = "review_or_gate";
  if (eventTypes.includes("improvement_noop")) coverageType = "noop";
  if (eventTypes.includes("improvement_not_applicable")) coverageType = "not_applicable";
  return {
    exists: verification.exists,
    ok: verification.ok,
    count: verification.count,
    lastHash: verification.lastHash,
    failures: verification.failures,
    improverEventCount: improverEvents.length,
    improverEventTypes: [...new Set(eventTypes)].sort(),
    coverageType,
  };
}

function projectName(issue) {
  return issue.project?.name || issue.projectName || issue.projectTitle || null;
}

function labelNames(issue) {
  return (issue.labels || []).map((label) => label.name || label).filter(Boolean).sort();
}

function issueUrl(issue, origin = "http://127.0.0.1:3101") {
  return issue.url || `${origin.replace(/\/$/, "")}/OPE/issues/${issue.identifier || issue.id}`;
}

function evaluateIssue({ issue, comments, ledger, requirements }) {
  const visible = classifyVisibleImproverCoverage(comments);
  const missing = [];
  if (!visible.present) {
    missing.push({ kind: "visible_improver_review", reason: "missing visible improver review/no-op/not-applicable Paperclip comment" });
  }
  for (const invalid of visible.invalid) {
    missing.push({ kind: "invalid_improver_comment", commentId: invalid.commentId, reason: invalid.invalidReason });
  }
  if (requirements.ledger && !ledger.ok) {
    missing.push({ kind: "factory_ledger", reason: "missing or invalid factory ledger", failures: ledger.failures });
  }
  if (requirements.ledger && ledger.ok && ledger.improverEventCount === 0) {
    missing.push({ kind: "ledger_improver_event", reason: "factory ledger has no improver/self_improvement event" });
  }
  if (visible.present && ledger.ok && ledger.improverEventCount === 0) {
    missing.push({ kind: "ledger_visibility_mismatch", reason: "visible improver comment exists but ledger has no improver/self_improvement event" });
  }
  if (!visible.present && ledger.improverEventCount > 0) {
    missing.push({ kind: "visible_mirror_missing", reason: "ledger has improver/self_improvement event but Paperclip visible mirror is missing" });
  }

  return {
    issue: {
      id: issue.id,
      identifier: issue.identifier || issue.id,
      title: issue.title || null,
      status: issue.status || null,
      projectId: issue.projectId || null,
      project: projectName(issue),
      labels: labelNames(issue),
      url: issueUrl(issue),
    },
    verdict: missing.length === 0 ? "PASS" : "FAIL",
    coverageType: visible.coverageType,
    visible,
    ledger,
    missing,
  };
}

function sortedUnique(items) {
  return [...new Set(items.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
}

function groupSummary(results, keyFn) {
  const groups = {};
  for (const result of results) {
    const key = keyFn(result) || "(none)";
    if (!groups[key]) groups[key] = { total: 0, pass: 0, fail: 0, review: 0, noop: 0, notApplicable: 0, missing: 0, issues: [] };
    const group = groups[key];
    group.total += 1;
    group.issues.push(result.issue.identifier);
    if (result.verdict === "PASS") group.pass += 1;
    else group.fail += 1;
    if (result.coverageType === "review") group.review += 1;
    else if (result.coverageType === "noop") group.noop += 1;
    else if (result.coverageType === "not_applicable") group.notApplicable += 1;
    else group.missing += 1;
  }
  for (const group of Object.values(groups)) group.issues.sort();
  return Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)));
}

function makeReport({ results, selectors, requirements, apiBase, companyId }) {
  const totals = {
    issues: results.length,
    pass: results.filter((result) => result.verdict === "PASS").length,
    fail: results.filter((result) => result.verdict === "FAIL").length,
    review: results.filter((result) => result.coverageType === "review").length,
    noop: results.filter((result) => result.coverageType === "noop").length,
    notApplicable: results.filter((result) => result.coverageType === "not_applicable").length,
    missing: results.filter((result) => result.coverageType === "missing").length,
    invalid: results.reduce((sum, result) => sum + result.visible.invalid.length, 0),
  };
  return {
    schemaVersion: 1,
    tool: "paperclip-board/improver-coverage-audit",
    advisoryNote: ADVISORY_NOTE,
    trigger: "OPE-248 exposed that self-improvement review could be skipped until Samuel asked; OPE-281 monitors for missing visible improver coverage.",
    apiBase,
    companyId,
    selectors,
    requirements,
    totals,
    verdict: totals.fail > 0 ? "FAIL" : "PASS",
    byStatus: groupSummary(results, (result) => result.issue.status),
    byCoverageType: groupSummary(results, (result) => result.coverageType),
    issues: results.sort((a, b) => String(a.issue.identifier).localeCompare(String(b.issue.identifier))),
  };
}

function textReport(report) {
  const lines = [];
  lines.push("# Improver Coverage Audit");
  lines.push("");
  lines.push(`Verdict: ${report.verdict}`);
  lines.push(`Issues: ${report.totals.issues} pass=${report.totals.pass} fail=${report.totals.fail}`);
  lines.push(`Coverage: review=${report.totals.review} noop=${report.totals.noop} not_applicable=${report.totals.notApplicable} missing=${report.totals.missing} invalid=${report.totals.invalid}`);
  lines.push(`Trust: ${report.advisoryNote}`);
  lines.push(`Trigger: ${report.trigger}`);
  lines.push("");
  lines.push("## Issues");
  for (const result of report.issues) {
    lines.push(`### ${result.issue.identifier} — ${result.verdict}`);
    lines.push(`- title/status: ${result.issue.title || "(none)"} / ${result.issue.status || "(none)"}`);
    lines.push(`- coverage: ${result.coverageType}`);
    if (result.visible.selected) {
      lines.push(`- visible comment: ${result.visible.selected.commentId || "(unknown)"} event=${result.visible.selected.eventType} owner=${result.visible.selected.owner || "(none)"}`);
      if (result.visible.selected.coverageType === "not_applicable") lines.push(`- not-applicable reason: ${result.visible.selected.notApplicableReason || "(missing)"}`);
    }
    lines.push(`- ledger: exists=${result.ledger.exists} ok=${result.ledger.ok} events=${result.ledger.count} improverEvents=${result.ledger.improverEventCount} improverEventTypes=${result.ledger.improverEventTypes.join(", ") || "(none)"}`);
    if (result.missing.length > 0) {
      lines.push("- missing:");
      for (const item of result.missing) lines.push(`  - ${item.kind}: ${item.reason}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function issueMatches(issue, selectors) {
  const id = String(issue.id || "").toLowerCase();
  const identifier = String(issue.identifier || "").toLowerCase();
  if (selectors.issues.length > 0 && !selectors.issues.map((item) => item.toLowerCase()).some((item) => item === id || item === identifier)) return false;
  if (selectors.statuses.length > 0 && !selectors.statuses.includes(String(issue.status || ""))) return false;
  if (selectors.projectIds.length > 0 && !selectors.projectIds.includes(String(issue.projectId || ""))) return false;
  if (selectors.projects.length > 0) {
    const project = String(projectName(issue) || issue.projectId || "").toLowerCase();
    if (!selectors.projects.some((needle) => project.includes(needle.toLowerCase()))) return false;
  }
  return true;
}

function urlJoin(apiBase, path, params = {}) {
  const url = new URL(path.replace(/^\//, ""), `${String(apiBase).replace(/\/$/, "")}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function requestJson(apiBase, path, params = {}) {
  const url = urlJoin(apiBase, path, params);
  let response;
  try {
    response = await fetch(url, { method: "GET", headers: { accept: "application/json" } });
  } catch (err) {
    return { ok: false, url, error: `request_failed: ${err.message}` };
  }
  const text = await response.text();
  if (!response.ok) return { ok: false, url, status: response.status, error: text || response.statusText };
  try {
    return { ok: true, url, json: JSON.parse(text || "null") };
  } catch (err) {
    return { ok: false, url, status: response.status, error: `invalid_json: ${err.message}` };
  }
}

async function audit(args) {
  if (boolArg(args, "help") || boolArg(args, "h")) {
    console.log(usage());
    return { exitCode: 0 };
  }
  const apiBase = String(args["api-base"] || DEFAULT_API).replace(/\/$/, "");
  const companyId = String(args["company-id"] || DEFAULT_COMPANY);
  const ledgerRoot = args["ledger-root"] || DEFAULT_LEDGER_ROOT;
  const format = String(args.format || "text").toLowerCase();
  if (!["json", "text", "human"].includes(format)) throw new Error("--format must be json or text");
  const statuses = boolArg(args, "all-statuses")
    ? []
    : sortedUnique([
      ...DEFAULT_STATUSES,
      ...(boolArg(args, "include-active") ? ["todo", "in_progress", "blocked"] : []),
      ...values(args, "status"),
    ]);
  const selectors = {
    issues: sortedUnique(values(args, "issue")),
    statuses,
    projectIds: sortedUnique(values(args, "project-id").concat(values(args, "issue").length === 0 && values(args, "project-id").length === 0 ? [DEFAULT_DARK_FACTORY_PROJECT_ID] : [])),
    projects: sortedUnique(values(args, "project")),
  };
  const requirements = {
    ledger: boolArg(args, "require-ledger"),
  };
  const limit = Number(args.limit || 1000);
  const issuesResponse = await requestJson(apiBase, `/companies/${encodeURIComponent(companyId)}/issues`, { limit });
  if (!issuesResponse.ok) {
    const report = { schemaVersion: 1, tool: "paperclip-board/improver-coverage-audit", verdict: "ERROR", auditErrors: [{ kind: "paperclip_api", reason: "could not list issues", error: issuesResponse.error, apiUrl: issuesResponse.url }] };
    process.stdout.write(format === "json" ? `${JSON.stringify(report, null, 2)}\n` : `# Improver Coverage Audit\n\nVerdict: ERROR\n- audit error: could not list Paperclip issues (${issuesResponse.error})\n`);
    return { exitCode: 2 };
  }
  if (!Array.isArray(issuesResponse.json)) throw new Error("Paperclip issue list response was not an array");
  const selected = issuesResponse.json.filter((issue) => issueMatches(issue, selectors));
  if (selected.length === 0) {
    const report = { schemaVersion: 1, tool: "paperclip-board/improver-coverage-audit", verdict: "ERROR", selectors, auditErrors: [{ kind: "selection", reason: "no Paperclip issues matched selectors" }] };
    process.stdout.write(format === "json" ? `${JSON.stringify(report, null, 2)}\n` : `# Improver Coverage Audit\n\nVerdict: ERROR\n- audit error: no Paperclip issues matched selectors\n`);
    return { exitCode: 2 };
  }

  const results = [];
  for (const issue of selected.sort((a, b) => String(a.identifier || a.id).localeCompare(String(b.identifier || b.id)))) {
    const commentsResponse = await requestJson(apiBase, `/issues/${encodeURIComponent(issue.id)}/comments`);
    let comments = [];
    if (commentsResponse.ok && Array.isArray(commentsResponse.json)) comments = commentsResponse.json;
    const ledger = ledgerCoverage(issue.identifier || issue.id, ledgerRoot);
    const result = evaluateIssue({ issue, comments, ledger, requirements });
    if (!commentsResponse.ok || !Array.isArray(commentsResponse.json)) {
      result.verdict = "FAIL";
      result.missing.push({ kind: "paperclip_comments", reason: "could not read Paperclip comments", apiUrl: commentsResponse.url, error: commentsResponse.error || "response was not an array" });
    }
    results.push(result);
  }

  const report = makeReport({ results, selectors, requirements, apiBase, companyId });
  process.stdout.write(format === "json" ? `${JSON.stringify(report, null, 2)}\n` : textReport(report));
  if (boolArg(args, "fail-closed") && report.verdict !== "PASS") return { exitCode: 1 };
  return { exitCode: 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await audit(args);
    process.exitCode = result.exitCode;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
  }
}

export {
  classifyComment,
  classifyVisibleImproverCoverage,
  evaluateIssue,
  hasNonEmptyValue,
  ledgerCoverage,
};
