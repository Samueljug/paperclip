#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendLedgerEvent } from "<FORK>/dark-factory/board/ledger-lib.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.FACTORY_INTAKE_CONFIG || path.join(SCRIPT_DIR, "config.local.json");
const SOURCE_MARKER = "[factory-intake:v1]";
const SOURCE_LABEL = "source: telegram-dev-intake";
const DEFAULT_LABELS = [
  SOURCE_LABEL,
  "stage: Planning",
  "gate: security-review-required",
  "gate: no-mistakes-required",
  "ledger: required",
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "true";
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function enabled(value) {
  return value === "true" || value === "1" || value === "yes";
}

function cleanText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function cleanOptionalText(value) {
  const text = cleanText(value);
  return text || null;
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function loadConfig() {
  const fileConfig = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
    : {};
  const config = {
    paperclipApi: process.env.PAPERCLIP_API_BASE || fileConfig.paperclipApi,
    companyId: process.env.PAPERCLIP_COMPANY_ID || fileConfig.companyId,
    projectId: process.env.PAPERCLIP_PROJECT_ID || fileConfig.projectId,
    coordinatorAgentId: process.env.PAPERCLIP_COORDINATOR_AGENT_ID || fileConfig.coordinatorAgentId,
    boardUrl: process.env.PAPERCLIP_BOARD_URL || fileConfig.boardUrl || "http://127.0.0.1:3101",
  };

  for (const key of ["paperclipApi", "companyId", "projectId", "coordinatorAgentId"]) {
    if (!config[key]) {
      throw new Error(`Missing factory intake config: ${key}. Add ${CONFIG_PATH} or set env vars.`);
    }
  }
  return config;
}

function intakePrefix(raw) {
  const text = cleanText(raw);
  const match = text.match(/^(?:\/?(task|ticket)|df|tasks)\s*[:\-]\s*/i);
  return match ? match[0] : null;
}

function stripIntakePrefix(raw) {
  const prefix = intakePrefix(raw);
  return prefix ? cleanText(raw).slice(prefix.length).trim() : cleanText(raw);
}

function splitRawTasks(raw, args) {
  const prefix = intakePrefix(raw);
  if (!prefix && !enabled(args.force)) {
    throw new Error("Factory intake requires an explicit TASK:, TICKET:, DF:, /task, /ticket, or tasks: prefix.");
  }

  const cleaned = stripIntakePrefix(raw);
  if (!cleaned) return [];

  const chunks = cleaned
    .split(/\n\s*(?:---|===)\s*\n/g)
    .map((item) => item.trim())
    .filter(Boolean);
  if (chunks.length > 1) return chunks;

  const nonEmptyLines = cleaned.split("\n").map((line) => line.trim()).filter(Boolean);
  const bulletTasks = nonEmptyLines
    .map((line) => line.match(/^(?:[-*+]|\d+[.)])\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean);

  if (bulletTasks.length >= 2 && bulletTasks.length === nonEmptyLines.length) {
    return bulletTasks;
  }

  return [cleaned];
}

function capTasks(tasks, args) {
  const maxTasks = Number(args["max-tasks"] || 20);
  if (!Number.isFinite(maxTasks) || maxTasks < 1) throw new Error("--max-tasks must be a positive number");
  if (tasks.length > maxTasks) {
    throw new Error(`Factory intake parsed ${tasks.length} tasks, above cap ${maxTasks}. Split the message or raise --max-tasks intentionally.`);
  }
  return tasks;
}

function titleFromBrief(brief) {
  const firstLine = brief.split("\n").find((line) => line.trim()) || brief;
  return firstLine
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 96);
}

function dedupKeyFor(args, index, brief) {
  const source = [
    args["chat-id"] || "no-chat",
    args["message-id"] || "no-message",
    String(index),
    args["message-id"] ? "" : brief,
  ].join("|");
  return `factory-intake:${hash(source).slice(0, 32)}`;
}

function needsPlanGate(brief, args) {
  if (enabled(args["plan-approval"]) || enabled(args["research-architecture"])) return true;
  const text = brief.toLowerCase();
  return [
    "architecture",
    "architect",
    "full plan",
    "detailed plan",
    "research",
    "privacy",
    "security",
    "automation",
    "payment",
    "customer support",
    "support system",
    "data-handling",
    "repository plan",
    "dark factory",
  ].some((term) => text.includes(term));
}

function isCodexOnly(brief, args = {}) {
  const text = [
    brief,
    args.raw,
    args.source,
    args["model-constraint"],
  ].map((item) => String(item || "").toLowerCase()).join("\n");
  return /\bcodex[- ]only\b/.test(text) || /\bno claude\b/.test(text) || /\bdo not use claude\b/.test(text);
}

function readJsonArg(value, name) {
  if (!value) return null;
  const text = String(value);
  const source = text.startsWith("@") ? text.slice(1) : text;
  const raw = fs.existsSync(source) ? fs.readFileSync(source, "utf8") : text;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid ${name} JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function normalizeStringArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
  return [cleanText(value)].filter(Boolean);
}

function normalizePathLike(value) {
  const text = cleanText(value);
  if (!text) return null;
  return text.startsWith("~")
    ? path.join(process.env.HOME || "", text.slice(1))
    : text;
}

function normalizeMediaArtifact(input, index = 0) {
  if (!input || typeof input !== "object") {
    throw new Error(`Media artifact ${index + 1} must be an object`);
  }
  const kind = cleanOptionalText(input.kind || input.type || input.mediaType) || "media";
  const label = cleanOptionalText(input.label || input.title || input.name) || `${kind} ${index + 1}`;
  const localPath = normalizePathLike(input.localPath || input.path || input.filePath || input.file);
  const attachments = normalizeStringArray(input.attachments || input.attachmentPaths)
    .map(normalizePathLike)
    .filter(Boolean);
  const transcriptPath = normalizePathLike(input.transcriptPath);
  const screenshots = (Array.isArray(input.screenshots) ? input.screenshots : input.frames || [])
    .map((frame, frameIndex) => {
      if (typeof frame === "string") {
        return { path: normalizePathLike(frame), label: `frame ${frameIndex + 1}` };
      }
      return {
        path: normalizePathLike(frame?.path || frame?.localPath || frame?.file),
        label: cleanOptionalText(frame?.label || frame?.title) || `frame ${frameIndex + 1}`,
        time: cleanOptionalText(frame?.time || frame?.timestamp || frame?.at),
        description: cleanOptionalText(frame?.description || frame?.summary || frame?.notes),
      };
    })
    .filter((frame) => frame.path || frame.description || frame.time);

  return {
    kind,
    label,
    source: cleanOptionalText(input.source || input.telegramFile || input.telegramFileId || input.url),
    localPath,
    mimeType: cleanOptionalText(input.mimeType || input.contentType),
    description: cleanOptionalText(input.description || input.summary || input.notes),
    transcript: cleanOptionalText(input.transcript),
    transcriptPath,
    ocr: cleanOptionalText(input.ocr || input.text),
    screenshots,
    attachments,
  };
}

function mediaArtifactsFromArgs(args) {
  const manifest = readJsonArg(args["media-manifest"] || args["media-json"], "--media-manifest");
  const rawArtifacts = manifest
    ? (Array.isArray(manifest) ? manifest : manifest.media || manifest.artifacts || manifest.items || [])
    : [];
  if (!Array.isArray(rawArtifacts)) {
    throw new Error("--media-manifest must be a JSON array or an object with media/artifacts/items");
  }
  const artifacts = rawArtifacts.map(normalizeMediaArtifact);
  const directPaths = normalizeStringArray(args["media-path"])
    .flatMap((item) => item.split(","))
    .map(normalizePathLike)
    .filter(Boolean)
    .map((item, index) => normalizeMediaArtifact({ kind: "media", label: `media ${index + 1}`, path: item }, artifacts.length + index));
  return [...artifacts, ...directPaths];
}

function fileSummary(filePath) {
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) return `${filePath} (missing locally)`;
  const stat = fs.statSync(filePath);
  return `${filePath} (${stat.size} bytes)`;
}

function readSmallTextFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (stat.size > 200000) return null;
  return cleanOptionalText(fs.readFileSync(filePath, "utf8"));
}

function buildMediaEvidenceSection(mediaArtifacts) {
  if (mediaArtifacts.length === 0) return null;
  const lines = [
    "## Media Evidence",
    "",
    "This task included media. Downstream agents should rely on this written evidence first, then inspect attached originals/artifacts as needed.",
  ];
  for (const [index, artifact] of mediaArtifacts.entries()) {
    lines.push("", `### ${index + 1}. ${artifact.label}`, `- Kind: ${artifact.kind}`);
    if (artifact.source) lines.push(`- Source: ${artifact.source}`);
    if (artifact.localPath) lines.push(`- Local source file: ${fileSummary(artifact.localPath)}`);
    if (artifact.mimeType) lines.push(`- MIME type: ${artifact.mimeType}`);
    if (artifact.description) lines.push("", "Summary / visual notes:", artifact.description);
    const transcript = artifact.transcript || readSmallTextFile(artifact.transcriptPath);
    if (transcript) lines.push("", "Transcript:", transcript);
    if (artifact.ocr) lines.push("", "OCR / visible text:", artifact.ocr);
    if (artifact.screenshots.length > 0) {
      lines.push("", "Key screenshots / frames:");
      for (const frame of artifact.screenshots) {
        const details = [
          frame.time ? `time ${frame.time}` : null,
          frame.path ? fileSummary(frame.path) : null,
          frame.description || null,
        ].filter(Boolean).join(" - ");
        lines.push(`- ${frame.label}: ${details}`);
      }
    }
    if (artifact.attachments.length > 0) {
      lines.push("", "Additional artifact files:");
      for (const attachmentPath of artifact.attachments) lines.push(`- ${fileSummary(attachmentPath)}`);
    }
  }
  return lines.join("\n");
}

async function request(api, pathName, options = {}) {
  const res = await fetch(`${api}${pathName}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${options.method || "GET"} ${pathName} -> ${res.status}: ${text}`);
  }
  return body;
}

function guessContentType(filePath, fallback = null) {
  if (fallback) return fallback;
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".apng": "image/apng",
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".m4a": "audio/mp4",
    ".md": "text/markdown",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".mpeg": "video/mpeg",
    ".mpg": "video/mpeg",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".txt": "text/plain",
    ".wav": "audio/wav",
    ".webm": "video/webm",
    ".webp": "image/webp",
  };
  return types[ext] || "application/octet-stream";
}

function collectAttachmentFiles(mediaArtifacts) {
  const files = [];
  for (const artifact of mediaArtifacts) {
    if (artifact.localPath) files.push({ path: artifact.localPath, mimeType: artifact.mimeType, label: artifact.label });
    if (artifact.transcriptPath) files.push({ path: artifact.transcriptPath, mimeType: "text/plain", label: `${artifact.label} transcript` });
    for (const frame of artifact.screenshots) {
      if (frame.path) files.push({ path: frame.path, mimeType: null, label: `${artifact.label} ${frame.label}` });
    }
    for (const attachmentPath of artifact.attachments) {
      files.push({ path: attachmentPath, mimeType: null, label: `${artifact.label} artifact` });
    }
  }
  const seen = new Set();
  return files.filter((file) => {
    if (!file.path) return false;
    const resolved = path.resolve(file.path);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

async function uploadIssueAttachment(api, config, issueId, file) {
  if (!fs.existsSync(file.path)) {
    return { path: file.path, skipped: true, reason: "missing" };
  }
  const bytes = fs.readFileSync(file.path);
  if (bytes.length === 0) {
    return { path: file.path, skipped: true, reason: "empty" };
  }
  const form = new FormData();
  const contentType = guessContentType(file.path, file.mimeType);
  form.append("file", new File([bytes], path.basename(file.path), { type: contentType }));
  const res = await fetch(`${api}/companies/${config.companyId}/issues/${issueId}/attachments`, {
    method: "POST",
    body: form,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    return { path: file.path, error: `${res.status}: ${text}` };
  }
  return { path: file.path, attachment: body };
}

async function ensureLabel(api, config, name, color) {
  const labels = await request(api, `/companies/${config.companyId}/labels`);
  const existing = labels.find((label) => label.name === name);
  if (existing) return existing;
  return request(api, `/companies/${config.companyId}/labels`, {
    method: "POST",
    body: JSON.stringify({ name, color }),
  });
}

async function labelIdsFor(api, config, task, args) {
  await ensureLabel(api, config, SOURCE_LABEL, "#0d9488");
  const names = [...DEFAULT_LABELS];
  if (needsPlanGate(task.brief, args)) {
    names.push("lane: Research / Architecture");
    names.push("gate: plan-approval-required");
  }

  const labels = await request(api, `/companies/${config.companyId}/labels`);
  return names.map((name) => {
    const label = labels.find((item) => item.name === name);
    if (!label) throw new Error(`Missing board label: ${name}`);
    return label.id;
  });
}

async function findExistingIssue(api, config, dedupKey) {
  const params = new URLSearchParams({
    projectId: config.projectId,
    q: dedupKey,
  });
  const issues = await request(api, `/companies/${config.companyId}/issues?${params.toString()}`);
  return issues.find((issue) => String(issue.description || "").includes(dedupKey)) || null;
}

function buildDescription(task, args, mediaArtifacts = []) {
  const metadata = [
    `- Source: Telegram factory intake`,
    `- Marker: ${SOURCE_MARKER}`,
    `- Source label: ${SOURCE_LABEL}`,
    `- Dedup key: ${task.dedupKey}`,
    `- Item index: ${task.index}`,
    `- Created at: ${new Date().toISOString()}`,
    args["chat-id"] ? `- Telegram chat id: ${args["chat-id"]}` : null,
    args["message-id"] ? `- Telegram message id: ${args["message-id"]}` : null,
    args.source ? `- Source note: ${args.source}` : null,
  ].filter(Boolean);

  const sections = [
    "# Original Brief",
    task.brief,
    "## Intake Metadata",
    metadata.join("\n"),
  ];

  if (args.raw) {
    sections.push("## Original Telegram Message", cleanText(args.raw));
  }

  if (args.repo) {
    sections.push("## Target Repo / Area", args.repo);
  }

  if (args.acceptance) {
    sections.push("## Acceptance Criteria", args.acceptance);
  }

  if (args.evidence) {
    sections.push("## Required Evidence", args.evidence);
  }

  const mediaSection = buildMediaEvidenceSection(mediaArtifacts);
  if (mediaSection) {
    sections.push(mediaSection);
  }

  if (needsPlanGate(task.brief, args)) {
    const reviewRule = isCodexOnly(task.brief, args)
      ? "This ticket is explicitly Codex-only / no-Claude. Do not involve Claude; use Codex-only review and reconciliation for substantial plans."
      : "Do not present a substantial plan as ready until Codex and Claude have both reviewed it and their findings have been reconciled.";
    sections.push(
      "## Plan Approval Gate",
      [
        "Research / architecture may run first, but a full plan must be visible on this ticket before implementation starts.",
        reviewRule,
        "Do not implement until Samuel explicitly approves the plan, unless the task is clearly a small low-risk implementation request.",
      ].join("\n"),
    );
  }

  sections.push(
    "## Factory Handoff",
    [
      "- Paperclip is the communication board and history surface.",
      "- The foreman should claim this card, then hand it to `pi-orchestrator` as a separate factory cell.",
      "- The foreman must only talk to `pi-orchestrator`, never directly to leads or workers.",
      "- Use a fresh clone/worktree and branch for repo work. Do not share dirty workspaces between tickets.",
      "- Log decisions, handoffs, blockers, evidence, verification, security review, PR links, self-improvement/improver review, and final disposition on this issue.",
      "- Every Dark Factory run must include an improver review before Ship to PR, Done, closed, or final disposition; if no reusable lesson exists, post a visible no-op review with run/ledger evidence.",
      "- If the task is ambiguous, unsafe, or needs external credentials/approval, mark it blocked and state the exact owner/action needed.",
    ].join("\n"),
  );

  return sections.join("\n\n");
}

async function createIssue(api, config, task, args) {
  const existing = await findExistingIssue(api, config, task.dedupKey);
  if (existing) {
    return {
      deduped: true,
      id: existing.id,
      identifier: existing.identifier,
      title: existing.title,
      status: existing.status,
      url: `${config.boardUrl}/OPE/issues/${existing.identifier}`,
    };
  }

  const labelIds = await labelIdsFor(api, config, task, args);
  const payload = {
    title: task.title,
    description: buildDescription(task, args, task.mediaArtifacts || []),
    status: args.status || "todo",
    priority: args.priority || "medium",
    projectId: config.projectId,
    assigneeAgentId: config.coordinatorAgentId,
    labelIds,
  };

  if (enabled(args["dry-run"])) {
    return { dryRun: true, payload };
  }

  const issue = await request(api, `/companies/${config.companyId}/issues`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  const url = `${config.boardUrl}/OPE/issues/${issue.identifier}`;
  const attachmentResults = [];
  for (const file of collectAttachmentFiles(task.mediaArtifacts || [])) {
    attachmentResults.push(await uploadIssueAttachment(api, config, issue.id, file));
  }

  if (attachmentResults.length > 0) {
    const uploaded = attachmentResults.filter((item) => item.attachment);
    const failed = attachmentResults.filter((item) => item.error || item.skipped);
    await request(api, `/issues/${issue.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        comment: [
          `Media intake processed ${attachmentResults.length} local artifact file(s).`,
          uploaded.length > 0
            ? `Attached: ${uploaded.map((item) => item.attachment.originalFilename || path.basename(item.path)).join(", ")}.`
            : null,
          failed.length > 0
            ? `Not attached: ${failed.map((item) => `${path.basename(item.path)} (${item.error || item.reason})`).join(", ")}.`
            : null,
        ].filter(Boolean).join("\n"),
      }),
    });
  }

  const ledger = appendLedgerEvent({
    issue: issue.identifier,
    issueId: issue.id,
    issueUrl: url,
    title: issue.title,
    eventType: "telegram_intake_task_created",
    stage: "Planning",
    actor: "Development OpenClaw",
    actorRole: "telegram-intake",
    summary: `Telegram intake task created on Paperclip: ${issue.title}`,
    details: {
      brief: task.brief,
      dedupKey: task.dedupKey,
      source: args.source || null,
      telegramChatId: args["chat-id"] || null,
      telegramMessageId: args["message-id"] || null,
      labels: DEFAULT_LABELS,
      mediaArtifacts: (task.mediaArtifacts || []).map((artifact) => ({
        kind: artifact.kind,
        label: artifact.label,
        source: artifact.source,
        localPath: artifact.localPath,
        screenshots: artifact.screenshots.length,
      })),
      mediaAttachmentResults: attachmentResults.map((item) => ({
        path: item.path,
        attachmentId: item.attachment?.id || null,
        skipped: item.skipped || false,
        error: item.error || null,
        reason: item.reason || null,
      })),
    },
    sourceRefs: [{ kind: "paperclip_issue", id: issue.id, identifier: issue.identifier, url }],
    visibility: "improver",
  });

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    url,
    ledgerDir: ledger.dir,
    ledgerEventHash: ledger.event.hash,
    mediaAttachments: attachmentResults,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const raw = args.raw || args.brief || args.title;
  const mediaArtifacts = mediaArtifactsFromArgs(args);
  const briefs = args.title && args.brief
    ? [cleanText(args.brief)]
    : capTasks(splitRawTasks(raw, args), args);

  if (briefs.length === 0) throw new Error("Missing --raw or --brief");

  const results = [];
  for (let index = 0; index < briefs.length; index += 1) {
    const brief = briefs[index];
    const title = args.title && briefs.length === 1 ? cleanText(args.title) : titleFromBrief(brief);
    const dedupKey = dedupKeyFor(args, index, brief);
    results.push(await createIssue(config.paperclipApi, config, { title, brief, dedupKey, index, mediaArtifacts }, args));
  }

  console.log(JSON.stringify({ count: results.length, results }, null, 2));
}

export {
  buildDescription,
  buildMediaEvidenceSection,
  collectAttachmentFiles,
  isCodexOnly,
  mediaArtifactsFromArgs,
  normalizeMediaArtifact,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
