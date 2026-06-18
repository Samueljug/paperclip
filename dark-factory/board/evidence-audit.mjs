#!/usr/bin/env node

import { createHash } from "node:crypto";
import { DEFAULT_LEDGER_ROOT, readLedgerEvents, readManifest, verifyLedger } from "./ledger-lib.mjs";

const DEFAULT_API = process.env.PAPERCLIP_API_BASE || "http://127.0.0.1:3101/api";
const DEFAULT_COMPANY = process.env.PAPERCLIP_COMPANY_ID || "1e8bc12a-f8fd-431c-9fbd-e47be79446a3";
const ADVISORY_NOTE = "Option B visibility audit only: Paperclip comments/metadata/attachments are advisory and forgeable; PASS means required visible evidence is present, not non-forgeable identity proof, not a real gate pass, and not sufficient by itself for Ship-to-PR/Done.";

function usage() {
  return [
    "Usage:",
    "  evidence-audit.mjs [--issue OPE-123] [--status in_review] [--project-id UUID] [--project NAME]",
    "                     [--require-role ROLE] [--require-event EVENT] [--require-attachment]",
    "                     [--require-image] [--require-video] [--require-ledger]",
    "                     [--format json|text] [--fail-closed]",
    "",
    "Examples:",
    "  node tools/paperclip-board/evidence-audit.mjs --issue OPE-210 --format text",
    "  node tools/paperclip-board/evidence-audit.mjs --status in_review --require-event verification_pass --require-ledger --fail-closed --format json",
    "  node tools/paperclip-board/evidence-audit.mjs --project-id c4525f28-55d1-4378-864c-aec26d51fc37 --require-role security-lead --require-event security_pass --fail-closed",
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function normalizeToken(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "-");
}

function displayToken(value) {
  return String(value || "").trim();
}

function sortedUnique(items) {
  return [...new Set(items.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
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
  if (!response.ok) {
    return { ok: false, url, status: response.status, error: text || response.statusText };
  }
  try {
    return { ok: true, url, json: JSON.parse(text || "null") };
  } catch (err) {
    return { ok: false, url, status: response.status, error: `invalid_json: ${err.message}` };
  }
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
  const wanted = new Set(labels.map(normalizeToken));
  for (const row of rowsFromMetadata(comment.metadata)) {
    const label = normalizeToken(row.label).replace(/-/g, "_");
    const aliases = new Set([label, label.replace(/_/g, "-")]);
    for (const item of wanted) {
      if (aliases.has(item) || aliases.has(item.replace(/-/g, "_"))) return displayToken(row.value);
    }
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
  if (fromMetadata) return normalizeToken(fromMetadata);
  const body = String(comment.body || "");
  const factory = body.match(/^\s*Factory ledger event recorded:\s*([A-Za-z0-9_.:-]+)/mi);
  if (factory) return normalizeToken(factory[1]);
  const explicit = body.match(/^\s*(?:[-*]\s*)?(?:Event type|Event|EVENT_TYPE)\s*[:=]\s*([A-Za-z0-9_.:-]+)/mi);
  if (explicit) return normalizeToken(explicit[1]);
  return null;
}

function parseTaskId(comment) {
  const fromMetadata = metadataValue(comment, ["task_id", "taskId"]);
  if (fromMetadata) return displayToken(fromMetadata);
  const body = String(comment.body || "");
  const match = body.match(/^\s*Task:\s*(.+)$/mi);
  return match ? displayToken(match[1]) : null;
}

function parseRunFolder(comment) {
  const fromMetadata = metadataValue(comment, ["run_folder", "runFolder"]);
  if (fromMetadata) return displayToken(fromMetadata);
  const body = String(comment.body || "");
  const match = body.match(/^\s*Run:\s*(.+)$/mi);
  return match ? displayToken(match[1]) : null;
}

function parseTrustModel(comment) {
  const fromMetadata = metadataValue(comment, ["trust_model", "trustModel"]);
  if (fromMetadata) return displayToken(fromMetadata);
  const body = String(comment.body || "");
  const match = body.match(/^\s*Trust:\s*(.+)$/mi);
  return match ? displayToken(match[1]) : null;
}

function summarizeComments(comments) {
  const summaries = comments.map((comment) => {
    const role = parseRole(comment);
    const eventType = parseEventType(comment);
    const taskId = parseTaskId(comment);
    const runFolder = parseRunFolder(comment);
    const trustModel = parseTrustModel(comment);
    const bodyHash = sha256(String(comment.body || ""));
    const roleEventKey = role || eventType ? `${role || "(no-role)"}::${eventType || "(no-event)"}` : null;
    return {
      id: comment.id || null,
      createdAt: comment.createdAt || null,
      role,
      eventType,
      taskId,
      runFolder,
      trustModel,
      bodyHash,
      roleEventKey,
    };
  }).sort((a, b) => String(a.createdAt || a.id || "").localeCompare(String(b.createdAt || b.id || "")));

  const roleEventSeen = new Set();
  let duplicateRoleEventComments = 0;
  for (const item of summaries) {
    if (!item.roleEventKey) continue;
    if (roleEventSeen.has(item.roleEventKey)) duplicateRoleEventComments += 1;
    else roleEventSeen.add(item.roleEventKey);
  }

  return {
    total: comments.length,
    parsed: summaries,
    roles: sortedUnique(summaries.map((item) => item.role)),
    events: sortedUnique(summaries.map((item) => item.eventType)),
    roleEventPairs: sortedUnique(summaries.filter((item) => item.role && item.eventType).map((item) => `${item.role}::${item.eventType}`)),
    duplicateRoleEventComments,
    rawRoleEventCommentCount: summaries.filter((item) => item.roleEventKey).length,
    uniqueRoleEventCommentCount: roleEventSeen.size,
  };
}

function attachmentIsImage(attachment) {
  const type = String(attachment.contentType || "").toLowerCase();
  const name = String(attachment.originalFilename || attachment.filename || attachment.name || attachment.objectKey || "").toLowerCase();
  return type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name);
}

function attachmentIsVideo(attachment) {
  const type = String(attachment.contentType || "").toLowerCase();
  const name = String(attachment.originalFilename || attachment.filename || attachment.name || attachment.objectKey || "").toLowerCase();
  return type.startsWith("video/") || /\.(mp4|mov|m4v|webm|avi|mkv)$/.test(name);
}

function summarizeAttachments(attachments) {
  const parsed = attachments.map((attachment) => ({
    id: attachment.id || null,
    contentType: attachment.contentType || null,
    originalFilename: attachment.originalFilename || attachment.filename || attachment.name || null,
    byteSize: attachment.byteSize ?? null,
    sha256: attachment.sha256 || null,
    contentPath: attachment.contentPath || null,
    declaredImage: attachmentIsImage(attachment),
    declaredVideo: attachmentIsVideo(attachment),
    issueCommentId: attachment.issueCommentId || null,
  })).sort((a, b) => String(a.originalFilename || a.id || "").localeCompare(String(b.originalFilename || b.id || "")));
  return {
    total: attachments.length,
    declaredImages: parsed.filter((item) => item.declaredImage).length,
    declaredVideos: parsed.filter((item) => item.declaredVideo).length,
    other: parsed.filter((item) => !item.declaredImage && !item.declaredVideo).length,
    parsed,
    note: "Attachment image/video coverage is based on Paperclip API attachment records and declared contentType/originalFilename, not local run-folder files.",
  };
}

function labelNames(issue) {
  return (issue.labels || []).map((label) => label.name || label).filter(Boolean).sort();
}

function projectName(issue) {
  return issue.project?.name || issue.projectName || issue.projectTitle || null;
}

function auditLedger(identifier, ledgerRoot) {
  try {
    const verification = verifyLedger(identifier, ledgerRoot);
    const events = readLedgerEvents(identifier, ledgerRoot);
    const manifest = readManifest(identifier, ledgerRoot);
    return {
      exists: verification.exists,
      ok: verification.ok,
      count: verification.count,
      lastHash: verification.lastHash,
      failures: verification.failures,
      eventTypes: sortedUnique(events.map((event) => normalizeToken(event.eventType))),
      actorRoles: sortedUnique(events.map((event) => normalizeToken(event.actorRole || event.actor))),
      manifest: manifest ? {
        issue: manifest.issue || null,
        issueId: manifest.issueId || null,
        issueUrl: manifest.issueUrl || null,
        title: manifest.title || null,
      } : null,
    };
  } catch (err) {
    return {
      exists: false,
      ok: false,
      count: 0,
      lastHash: null,
      failures: [{ reason: "ledger_read_error", error: err.message }],
      eventTypes: [],
      actorRoles: [],
      manifest: null,
      auditError: true,
    };
  }
}

function requirementConfig(args) {
  return {
    roles: sortedUnique(values(args, "require-role").map(normalizeToken)),
    events: sortedUnique(values(args, "require-event").map(normalizeToken)),
    attachment: boolArg(args, "require-attachment"),
    image: boolArg(args, "require-image"),
    video: boolArg(args, "require-video"),
    ledger: boolArg(args, "require-ledger"),
  };
}

function evaluateIssue({ issue, comments, attachments, ledger, requirements }) {
  const commentSummary = summarizeComments(comments);
  const attachmentSummary = summarizeAttachments(attachments);
  const missing = [];
  const auditErrors = [];

  for (const role of requirements.roles) {
    if (!commentSummary.roles.includes(role)) missing.push({ kind: "role_comment", role, reason: "missing required visible role comment" });
  }
  for (const event of requirements.events) {
    if (!commentSummary.events.includes(event)) missing.push({ kind: "event_comment", event, reason: "missing required visible event comment" });
  }
  if (requirements.attachment && attachmentSummary.total === 0) {
    missing.push({ kind: "attachment", reason: "missing Paperclip-side attachment" });
  }
  if (requirements.image && attachmentSummary.declaredImages === 0) {
    missing.push({ kind: "image_attachment", reason: "missing declared Paperclip-side image attachment" });
  }
  if (requirements.video && attachmentSummary.declaredVideos === 0) {
    missing.push({ kind: "video_attachment", reason: "missing declared Paperclip-side video attachment" });
  }
  if (requirements.ledger && !ledger.ok) {
    missing.push({ kind: "factory_ledger", reason: "missing or invalid factory ledger", failures: ledger.failures });
  }
  if (ledger.auditError) {
    auditErrors.push({ kind: "factory_ledger", reason: "factory ledger could not be read deterministically", failures: ledger.failures });
  }

  return {
    issue: {
      id: issue.id,
      identifier: issue.identifier || issue.issue || issue.id,
      title: issue.title || null,
      status: issue.status || null,
      projectId: issue.projectId || null,
      project: projectName(issue),
      labels: labelNames(issue),
      url: issue.url || null,
    },
    verdict: auditErrors.length > 0 ? "ERROR" : (missing.length === 0 ? "PASS" : "FAIL"),
    advisoryNote: ADVISORY_NOTE,
    missing,
    auditErrors,
    comments: commentSummary,
    attachments: attachmentSummary,
    ledger,
  };
}

function groupSummary(results, keyFn) {
  const groups = {};
  for (const result of results) {
    const key = keyFn(result) || "(none)";
    if (!groups[key]) groups[key] = { total: 0, pass: 0, fail: 0, error: 0, issues: [] };
    groups[key].total += 1;
    groups[key].issues.push(result.issue.identifier);
    if (result.verdict === "PASS") groups[key].pass += 1;
    else if (result.verdict === "ERROR") groups[key].error += 1;
    else groups[key].fail += 1;
  }
  for (const group of Object.values(groups)) group.issues.sort();
  return Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)));
}

function makeReport({ results, requirements, selectors, apiBase, companyId }) {
  const totals = {
    issues: results.length,
    pass: results.filter((item) => item.verdict === "PASS").length,
    fail: results.filter((item) => item.verdict === "FAIL").length,
    error: results.filter((item) => item.verdict === "ERROR").length,
    missing: results.reduce((sum, item) => sum + item.missing.length, 0),
    auditErrors: results.reduce((sum, item) => sum + item.auditErrors.length, 0),
  };
  return {
    schemaVersion: 1,
    tool: "paperclip-board/evidence-audit",
    advisoryNote: ADVISORY_NOTE,
    apiBase,
    companyId,
    selectors,
    requirements,
    totals,
    verdict: totals.error > 0 ? "ERROR" : (totals.fail > 0 ? "FAIL" : "PASS"),
    byStatus: groupSummary(results, (result) => result.issue.status),
    byProject: groupSummary(results, (result) => result.issue.project || result.issue.projectId),
    issues: results.sort((a, b) => String(a.issue.identifier).localeCompare(String(b.issue.identifier))),
  };
}

function textReport(report) {
  const lines = [];
  lines.push("# Paperclip Evidence Audit");
  lines.push("");
  lines.push(`Verdict: ${report.verdict}`);
  lines.push(`Issues: ${report.totals.issues} pass=${report.totals.pass} fail=${report.totals.fail} error=${report.totals.error}`);
  lines.push(`Trust: ${report.advisoryNote}`);
  lines.push("");
  lines.push("## Requirements");
  lines.push(`- roles: ${report.requirements.roles.join(", ") || "(none)"}`);
  lines.push(`- events: ${report.requirements.events.join(", ") || "(none)"}`);
  lines.push(`- attachment: ${report.requirements.attachment ? "required" : "not required"}`);
  lines.push(`- image: ${report.requirements.image ? "required" : "not required"}`);
  lines.push(`- video: ${report.requirements.video ? "required" : "not required"}`);
  lines.push(`- ledger: ${report.requirements.ledger ? "required" : "not required"}`);
  lines.push("");
  lines.push("## Groups By Status");
  for (const [status, group] of Object.entries(report.byStatus)) {
    lines.push(`- ${status}: total=${group.total} pass=${group.pass} fail=${group.fail} error=${group.error}`);
  }
  lines.push("");
  lines.push("## Issues");
  for (const item of report.issues) {
    lines.push(`### ${item.issue.identifier} — ${item.verdict}`);
    lines.push(`- title: ${item.issue.title || "(none)"}`);
    lines.push(`- status/project: ${item.issue.status || "(none)"} / ${item.issue.project || item.issue.projectId || "(none)"}`);
    lines.push(`- roles: ${item.comments.roles.join(", ") || "(none)"}`);
    lines.push(`- events: ${item.comments.events.join(", ") || "(none)"}`);
    lines.push(`- comments: total=${item.comments.total} uniqueRoleEvent=${item.comments.uniqueRoleEventCommentCount} duplicateRoleEvent=${item.comments.duplicateRoleEventComments}`);
    lines.push(`- attachments: total=${item.attachments.total} declaredImages=${item.attachments.declaredImages} declaredVideos=${item.attachments.declaredVideos}`);
    lines.push(`- ledger: exists=${item.ledger.exists} ok=${item.ledger.ok} events=${item.ledger.count} eventTypes=${item.ledger.eventTypes.join(", ") || "(none)"}`);
    if (item.missing.length > 0) {
      lines.push("- missing:");
      for (const missing of item.missing) lines.push(`  - ${missing.kind}: ${missing.reason}${missing.role ? ` (${missing.role})` : ""}${missing.event ? ` (${missing.event})` : ""}`);
    }
    if (item.auditErrors.length > 0) {
      lines.push("- audit errors:");
      for (const error of item.auditErrors) lines.push(`  - ${error.kind}: ${error.reason}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function issueMatches(issue, selectors) {
  const issueNeedles = selectors.issues.map((item) => item.toLowerCase());
  if (issueNeedles.length > 0) {
    const id = String(issue.id || "").toLowerCase();
    const identifier = String(issue.identifier || "").toLowerCase();
    if (!issueNeedles.includes(id) && !issueNeedles.includes(identifier)) return false;
  }
  if (selectors.statuses.length > 0 && !selectors.statuses.includes(String(issue.status || ""))) return false;
  if (selectors.projectIds.length > 0 && !selectors.projectIds.includes(String(issue.projectId || ""))) return false;
  if (selectors.projects.length > 0) {
    const project = String(projectName(issue) || issue.projectId || "").toLowerCase();
    if (!selectors.projects.some((needle) => project.includes(needle.toLowerCase()))) return false;
  }
  return true;
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
  const selectors = {
    issues: sortedUnique(values(args, "issue")),
    statuses: sortedUnique(values(args, "status")),
    projectIds: sortedUnique(values(args, "project-id")),
    projects: sortedUnique(values(args, "project")),
  };
  const limit = Number(args.limit || 1000);
  const requirements = requirementConfig(args);

  const issuesResponse = await requestJson(apiBase, `/companies/${encodeURIComponent(companyId)}/issues`, { limit });
  if (!issuesResponse.ok) {
    const report = {
      schemaVersion: 1,
      tool: "paperclip-board/evidence-audit",
      advisoryNote: ADVISORY_NOTE,
      verdict: "ERROR",
      auditErrors: [{ kind: "paperclip_api", reason: "could not list Paperclip issues", apiUrl: issuesResponse.url, error: issuesResponse.error }],
    };
    process.stdout.write(format === "json" ? `${JSON.stringify(report, null, 2)}\n` : `# Paperclip Evidence Audit\n\nVerdict: ERROR\nTrust: ${ADVISORY_NOTE}\n- audit error: could not list Paperclip issues (${issuesResponse.error})\n`);
    return { exitCode: 2 };
  }
  if (!Array.isArray(issuesResponse.json)) throw new Error("Paperclip issue list response was not an array");
  const selected = issuesResponse.json
    .filter((issue) => issueMatches(issue, selectors))
    .sort((a, b) => String(a.identifier || a.id).localeCompare(String(b.identifier || b.id)));

  if (selected.length === 0) {
    const report = {
      schemaVersion: 1,
      tool: "paperclip-board/evidence-audit",
      advisoryNote: ADVISORY_NOTE,
      verdict: "ERROR",
      selectors,
      auditErrors: [{ kind: "selection", reason: "no Paperclip issues matched selectors" }],
    };
    process.stdout.write(format === "json" ? `${JSON.stringify(report, null, 2)}\n` : `# Paperclip Evidence Audit\n\nVerdict: ERROR\nTrust: ${ADVISORY_NOTE}\n- audit error: no Paperclip issues matched selectors\n`);
    return { exitCode: 2 };
  }

  const results = [];
  for (const issue of selected) {
    const commentsResponse = await requestJson(apiBase, `/issues/${encodeURIComponent(issue.id)}/comments`);
    const attachmentsResponse = await requestJson(apiBase, `/issues/${encodeURIComponent(issue.id)}/attachments`);
    const ledger = auditLedger(issue.identifier || issue.id, ledgerRoot);
    const auditErrors = [];
    let comments = [];
    let attachments = [];
    if (!commentsResponse.ok) {
      auditErrors.push({ kind: "paperclip_comments", reason: "could not read comments", apiUrl: commentsResponse.url, error: commentsResponse.error });
    } else if (!Array.isArray(commentsResponse.json)) {
      auditErrors.push({ kind: "paperclip_comments", reason: "comments response was not an array", apiUrl: commentsResponse.url });
    } else {
      comments = commentsResponse.json;
    }
    if (!attachmentsResponse.ok) {
      auditErrors.push({ kind: "paperclip_attachments", reason: "could not read attachments", apiUrl: attachmentsResponse.url, error: attachmentsResponse.error });
    } else if (!Array.isArray(attachmentsResponse.json)) {
      auditErrors.push({ kind: "paperclip_attachments", reason: "attachments response was not an array", apiUrl: attachmentsResponse.url });
    } else {
      attachments = attachmentsResponse.json;
    }
    const result = evaluateIssue({ issue, comments, attachments, ledger, requirements });
    result.auditErrors.push(...auditErrors);
    if (result.auditErrors.length > 0) result.verdict = "ERROR";
    results.push(result);
  }

  const report = makeReport({ results, requirements, selectors, apiBase, companyId });
  process.stdout.write(format === "json" ? `${JSON.stringify(report, null, 2)}\n` : textReport(report));

  if (report.totals.error > 0) return { exitCode: 2 };
  if (boolArg(args, "fail-closed") && report.totals.fail > 0) return { exitCode: 1 };
  return { exitCode: 0 };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = await audit(args);
  process.exitCode = result.exitCode;
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 2;
}
