#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, relative, sep } from "node:path";

const DEFAULT_API_BASE = process.env.PAPERCLIP_API_BASE || "http://127.0.0.1:3101/api";
const DEFAULT_ORIGIN = process.env.PAPERCLIP_ORIGIN || DEFAULT_API_BASE.replace(/\/api\/?$/, "");
const DEFAULT_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "1e8bc12a-f8fd-431c-9fbd-e47be79446a3";
const TRUST_MODEL = "Option B advisory/display-only; not non-forgeable identity evidence";

const MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  md: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  json: "application/json",
  csv: "text/csv",
  pdf: "application/pdf",
};

function usage() {
  return [
    "Usage:",
    "  option-b-bridge.mjs comment --issue OPE-123 --role planning-lead --stage Planning --event-type planning_pass --summary \"...\" [options]",
    "  option-b-bridge.mjs upload --issue OPE-123 --file evidence.png --evidence-root /abs/evidence [--issue-comment-id UUID] [options]",
    "",
    "Common options:",
    "  --api-base URL              Paperclip API base (default: PAPERCLIP_API_BASE or http://127.0.0.1:3101/api)",
    "  --origin URL                Paperclip origin for attachment contentPath downloads (default: PAPERCLIP_ORIGIN or api-base without /api)",
    "  --company-id UUID           Paperclip company id (default: PAPERCLIP_COMPANY_ID)",
    "  --format json|text          Output format (default: json)",
    "  --dry-run                   Print request payload/plan without posting or uploading",
    "",
    "Comment options:",
    "  --agent-name NAME           Local/Paperclip agent display name to resolve read-only",
    "  --coms-net-target NAME      coms-net fallback target/reference",
    "  --task-id ID                Dark Factory task/run id",
    "  --run-folder PATH           Local run folder path",
    "  --source-ref REF            Repeatable or comma-separated source reference",
    "  --details TEXT              Optional extra body details",
    "",
    "Upload options:",
    "  --evidence-root PATH        Required root; --file must realpath inside it",
    "  --issue-comment-id UUID     Attach file to an existing Paperclip comment when supported",
    "",
    "Trust/safety:",
    "  Option B comments and metadata are visibility mirrors only. This helper never sets authorAgentId, never mutates the DB, and never claims non-forgeable identity.",
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

function boolArg(args, key) {
  const value = args[key];
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) throw new Error(`--${key} may only be provided once`);
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`--${key} is a boolean flag; do not provide a value`);
}

function requireArg(args, key) {
  const raw = args[key];
  if (Array.isArray(raw)) throw new Error(`--${key} may only be provided once`);
  const value = String(raw || "").trim();
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

function optionalArg(args, key, fallback = null) {
  const raw = args[key];
  if (raw === undefined || raw === null) return fallback;
  if (Array.isArray(raw)) throw new Error(`--${key} may only be provided once`);
  const value = String(raw).trim();
  return value || fallback;
}

function values(args, key) {
  const raw = args[key];
  if (raw === undefined || raw === null || raw === "false") return [];
  const items = Array.isArray(raw) ? raw : [raw];
  return items.flatMap((item) => String(item).split(",")).map((item) => item.trim()).filter(Boolean).filter((item) => item !== "true");
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function urlJoin(apiBase, path, params = {}) {
  const url = new URL(path.replace(/^\//, ""), `${String(apiBase).replace(/\/$/, "")}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function requestJson(apiBase, path, { method = "GET", body = null, headers = {}, params = {} } = {}) {
  const url = urlJoin(apiBase, path, params);
  const res = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : null,
  });
  const text = await res.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); }
    catch { json = null; }
  }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text || res.statusText}`);
  return json;
}

async function resolveIssue(apiBase, companyId, issue) {
  if (isUuid(issue)) return { id: issue, identifier: null, resolvedBy: "uuid" };
  const issues = await requestJson(apiBase, `/companies/${companyId}/issues`, { params: { limit: 1000 } });
  const found = (Array.isArray(issues) ? issues : []).find((item) => item.identifier === issue || item.id === issue);
  if (!found) throw new Error(`Issue not found: ${issue}`);
  return { id: found.id, identifier: found.identifier || issue, title: found.title || null, resolvedBy: "identifier" };
}

async function resolveAgent(apiBase, companyId, agentName) {
  if (!agentName) return null;
  let agents = [];
  try {
    agents = await requestJson(apiBase, `/companies/${companyId}/agents`);
  } catch (err) {
    return { requested: agentName, found: false, lookupError: err.message };
  }
  const wanted = normalizeName(agentName);
  const found = (Array.isArray(agents) ? agents : []).find((agent) => {
    return [agent.name, agent.displayName, agent.slug, agent.identifier].some((candidate) => normalizeName(candidate) === wanted);
  });
  if (!found) return { requested: agentName, found: false };
  return { requested: agentName, found: true, id: found.id || null, name: found.name || found.displayName || agentName };
}

function metadataRows(items) {
  return Object.entries(items)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([label, value]) => ({ type: "key_value", label, value: Array.isArray(value) || typeof value === "object" ? JSON.stringify(value) : String(value) }));
}

function buildCommentPayload({ role, stage, eventType, summary, agentName, agentResolution, comsNetTarget, taskId, runFolder, sourceRefs, details }) {
  const agentLine = agentResolution?.found
    ? `Paperclip agent reference: ${agentResolution.name}${agentResolution.id ? ` (${agentResolution.id})` : ""}`
    : (agentName ? `Paperclip agent reference: not found for "${agentName}"; using coms-net target/reference.` : null);
  const fallbackTarget = comsNetTarget || role;
  const body = [
    `[${role}] ${summary}`,
    "",
    stage ? `Stage: ${stage}` : null,
    eventType ? `Event type: ${eventType}` : null,
    taskId ? `Task: ${taskId}` : null,
    runFolder ? `Run: ${runFolder}` : null,
    sourceRefs.length ? `Source refs:\n${sourceRefs.map((ref) => `- ${ref}`).join("\n")}` : null,
    agentLine,
    `coms-net target/reference: ${fallbackTarget}`,
    details ? `Details:\n${details}` : null,
    `Trust: ${TRUST_MODEL}.`,
  ].filter(Boolean).join("\n");

  return {
    body,
    authorType: "user",
    presentation: {
      kind: "system_notice",
      tone: eventType?.includes("failed") || eventType?.includes("blocked") ? "warning" : "info",
      title: `Dark Factory role comment: ${role}`,
      detailsDefaultOpen: false,
    },
    metadata: {
      version: 1,
      sections: [{
        title: "Dark Factory attribution (advisory/local trusted)",
        rows: metadataRows({
          role,
          agent_name: agentName || agentResolution?.name || "",
          paperclip_agent_id: agentResolution?.found ? agentResolution.id : "",
          paperclip_agent_found: agentResolution ? String(Boolean(agentResolution.found)) : "",
          stage,
          event_type: eventType,
          task_id: taskId,
          run_folder: runFolder,
          source_refs: sourceRefs,
          trust_model: TRUST_MODEL,
          coms_net_target: fallbackTarget,
        }),
      }],
    },
  };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function mimeFor(path) {
  const ext = String(path).toLowerCase().split(".").pop();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

async function safeEvidenceFile(filePath, evidenceRoot) {
  const root = await realpath(evidenceRoot);
  const file = await realpath(filePath);
  if (!(file === root || file.startsWith(`${root}${sep}`))) {
    throw new Error(`Refusing to upload file outside evidence root: ${file} not under ${root}`);
  }
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error(`Refusing to upload non-file path: ${file}`);
  return { root, file, relativePath: relative(root, file), stat };
}

function attachmentIdentity(item) {
  return item?.id || item?.attachmentId || item?.uuid || null;
}

function attachmentName(item) {
  return item?.originalFilename || item?.filename || item?.name || null;
}

function attachmentSize(item) {
  return item?.byteSize ?? item?.sizeBytes ?? item?.size ?? null;
}

function attachmentHash(item) {
  return item?.sha256 || item?.sha || item?.hash || null;
}

async function maybeDownloadVerify({ origin, attachment, sha256 }) {
  const contentPath = attachment?.contentPath;
  if (!contentPath) return { attempted: false, ok: null, reason: "attachment has no contentPath" };
  const url = new URL(contentPath, String(origin).replace(/\/$/, "/"));
  const res = await fetch(url);
  if (!res.ok) return { attempted: true, ok: false, status: res.status, url: url.toString() };
  const buffer = Buffer.from(await res.arrayBuffer());
  const downloadedSha256 = createHash("sha256").update(buffer).digest("hex");
  return { attempted: true, ok: downloadedSha256 === sha256, url: url.toString(), downloadedSha256 };
}

function printOutput(format, value) {
  if (format === "text") {
    if (value.command === "comment") {
      console.log(`${value.dryRun ? "DRY RUN " : ""}comment ${value.comment?.id || "(not posted)"} for ${value.issue.identifier || value.issue.id}`);
      console.log(`role=${value.role} event_type=${value.eventType}`);
    } else if (value.command === "upload") {
      console.log(`${value.dryRun ? "DRY RUN " : ""}upload ${value.file.relativePath} for ${value.issue.identifier || value.issue.id}`);
      console.log(`sha256=${value.file.sha256} bytes=${value.file.byteSize} verified=${value.verification?.ok}`);
    } else {
      console.log(JSON.stringify(value, null, 2));
    }
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

async function commentCommand(args) {
  const apiBase = optionalArg(args, "api-base", DEFAULT_API_BASE);
  const companyId = optionalArg(args, "company-id", DEFAULT_COMPANY_ID);
  const format = optionalArg(args, "format", "json");
  const dryRun = boolArg(args, "dry-run");
  const issue = await resolveIssue(apiBase, companyId, requireArg(args, "issue"));
  const role = requireArg(args, "role");
  const stage = requireArg(args, "stage");
  const eventType = requireArg(args, "event-type");
  const summary = requireArg(args, "summary");
  const agentName = optionalArg(args, "agent-name", null);
  const comsNetTarget = optionalArg(args, "coms-net-target", role);
  const taskId = optionalArg(args, "task-id", null);
  const runFolder = optionalArg(args, "run-folder", null);
  const sourceRefs = values(args, "source-ref");
  const details = optionalArg(args, "details", null);
  const agentResolution = await resolveAgent(apiBase, companyId, agentName);
  const payload = buildCommentPayload({ role, stage, eventType, summary, agentName, agentResolution, comsNetTarget, taskId, runFolder, sourceRefs, details });

  if (dryRun) {
    return printOutput(format, { command: "comment", dryRun: true, issue, role, eventType, payload, agentResolution, safety: { setsAuthorAgentId: false, trustModel: TRUST_MODEL } });
  }

  const comment = await requestJson(apiBase, `/issues/${issue.id}/comments`, { method: "POST", body: payload });
  return printOutput(format, { command: "comment", dryRun: false, issue, role, eventType, comment, payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), safety: { setsAuthorAgentId: false, trustModel: TRUST_MODEL } });
}

async function uploadCommand(args) {
  const apiBase = optionalArg(args, "api-base", DEFAULT_API_BASE);
  const origin = optionalArg(args, "origin", DEFAULT_ORIGIN);
  const companyId = optionalArg(args, "company-id", DEFAULT_COMPANY_ID);
  const format = optionalArg(args, "format", "json");
  const dryRun = boolArg(args, "dry-run");
  const issue = await resolveIssue(apiBase, companyId, requireArg(args, "issue"));
  const safe = await safeEvidenceFile(requireArg(args, "file"), requireArg(args, "evidence-root"));
  const sha256 = sha256File(safe.file);
  const mimeType = mimeFor(safe.file);
  const issueCommentId = optionalArg(args, "issue-comment-id", null);

  const fileSummary = {
    path: safe.file,
    evidenceRoot: safe.root,
    relativePath: safe.relativePath,
    byteSize: safe.stat.size,
    sha256,
    mimeType,
  };

  if (dryRun) {
    return printOutput(format, { command: "upload", dryRun: true, issue, file: fileSummary, issueCommentId, safety: { evidenceRootEnforced: true } });
  }

  const bytes = readFileSync(safe.file);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), basename(safe.file));
  if (issueCommentId) form.append("issueCommentId", issueCommentId);
  const uploadUrl = urlJoin(apiBase, `/companies/${companyId}/issues/${issue.id}/attachments`);
  const uploadRes = await fetch(uploadUrl, { method: "POST", body: form });
  const uploadText = await uploadRes.text();
  let uploadJson = null;
  try { uploadJson = uploadText ? JSON.parse(uploadText) : null; } catch { uploadJson = null; }
  if (!uploadRes.ok) throw new Error(`POST ${uploadUrl} -> ${uploadRes.status}: ${uploadText || uploadRes.statusText}`);

  const attachments = await requestJson(apiBase, `/issues/${issue.id}/attachments`);
  const uploadId = attachmentIdentity(uploadJson);
  const listed = (Array.isArray(attachments) ? attachments : []).find((item) => {
    if (uploadId && attachmentIdentity(item) === uploadId) return true;
    if (attachmentName(item) === basename(safe.file) && attachmentSize(item) === safe.stat.size) return true;
    if (attachmentHash(item) && attachmentHash(item) === sha256) return true;
    return false;
  });
  if (!listed) throw new Error(`Uploaded attachment was not listed by GET /issues/${issue.id}/attachments`);
  const sizeMatches = attachmentSize(listed) === null || attachmentSize(listed) === safe.stat.size;
  const hashMatches = !attachmentHash(listed) || attachmentHash(listed) === sha256;
  const contentVerification = await maybeDownloadVerify({ origin, attachment: listed, sha256 });
  const ok = Boolean(listed && sizeMatches && hashMatches && (contentVerification.ok !== false));
  if (!ok) throw new Error(`Attachment verification failed: ${JSON.stringify({ sizeMatches, hashMatches, contentVerification })}`);

  return printOutput(format, {
    command: "upload",
    dryRun: false,
    issue,
    file: fileSummary,
    issueCommentId,
    upload: uploadJson,
    verification: {
      ok,
      listedId: attachmentIdentity(listed),
      listedName: attachmentName(listed),
      sizeMatches,
      hashMatches,
      contentVerification,
    },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || command === "help" || command === "--help" || args.help === "true") {
    console.log(usage());
    return;
  }
  if (command === "comment") return commentCommand(args);
  if (command === "upload") return uploadCommand(args);
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(2);
});
