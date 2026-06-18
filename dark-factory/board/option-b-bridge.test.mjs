#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = mkdtempSync(resolve(tmpdir(), "paperclip-option-b-bridge-test-"));
const evidenceRoot = resolve(root, "evidence");
const outsideRoot = resolve(root, "outside");
mkdirSync(evidenceRoot, { recursive: true });
mkdirSync(outsideRoot, { recursive: true });
const pngFile = resolve(evidenceRoot, "screen.png");
const outsideFile = resolve(outsideRoot, "outside.png");
const pngBytes = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
writeFileSync(pngFile, pngBytes);
writeFileSync(outsideFile, pngBytes);

const tool = resolve(new URL("./option-b-bridge.mjs", import.meta.url).pathname);
const companyId = "company-test";

const state = {
  issues: [
    { id: "issue-209", identifier: "OPE-209", title: "Option B helper", status: "in_progress" },
  ],
  agents: [
    { id: "agent-planning", name: "Planning Lead" },
    { id: "agent-security", name: "security-lead" },
  ],
  comments: { "issue-209": [] },
  attachments: { "issue-209": [] },
  attachmentContent: {},
};

function readRequest(req) {
  return new Promise((resolveRead) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolveRead(Buffer.concat(chunks)));
  });
}

function parseMultipartFile(req, body) {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(.+)$/);
  if (!boundaryMatch) throw new Error("missing multipart boundary");
  const boundary = `--${boundaryMatch[1]}`;
  const raw = body.toString("binary");
  const part = raw.split(boundary).find((item) => item.includes('name="file"'));
  if (!part) throw new Error("missing file part");
  const filename = part.match(/filename="([^"]+)"/)?.[1] || "upload.bin";
  const headerEnd = part.indexOf("\r\n\r\n");
  const dataStart = headerEnd + 4;
  let dataRaw = part.slice(dataStart);
  if (dataRaw.endsWith("\r\n")) dataRaw = dataRaw.slice(0, -2);
  return { filename, buffer: Buffer.from(dataRaw, "binary") };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const json = (status, body) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  };

  if (req.method === "GET" && url.pathname === `/api/companies/${companyId}/issues`) {
    json(200, state.issues);
    return;
  }
  if (req.method === "GET" && url.pathname === `/api/companies/${companyId}/agents`) {
    json(200, state.agents);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/issues/issue-209/comments") {
    const body = JSON.parse((await readRequest(req)).toString("utf8"));
    if (Object.prototype.hasOwnProperty.call(body, "authorAgentId")) {
      json(400, { error: "authorAgentId spoofing not allowed" });
      return;
    }
    const comment = { id: `comment-${state.comments["issue-209"].length + 1}`, createdAt: new Date().toISOString(), ...body };
    state.comments["issue-209"].push(comment);
    json(200, comment);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/issues/issue-209/comments") {
    json(200, state.comments["issue-209"]);
    return;
  }
  if (req.method === "POST" && url.pathname === `/api/companies/${companyId}/issues/issue-209/attachments`) {
    const body = await readRequest(req);
    const parsed = parseMultipartFile(req, body);
    const id = `attachment-${state.attachments["issue-209"].length + 1}`;
    const sha256 = createHash("sha256").update(parsed.buffer).digest("hex");
    const attachment = {
      id,
      originalFilename: parsed.filename,
      contentType: "image/png",
      byteSize: parsed.buffer.length,
      sha256,
      contentPath: `/api/attachments/${id}/content`,
    };
    state.attachments["issue-209"].push(attachment);
    state.attachmentContent[id] = parsed.buffer;
    json(200, attachment);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/issues/issue-209/attachments") {
    json(200, state.attachments["issue-209"]);
    return;
  }
  const contentMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)\/content$/);
  if (req.method === "GET" && contentMatch) {
    const content = state.attachmentContent[contentMatch[1]];
    if (!content) {
      json(404, { error: "not found" });
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "image/png");
    res.end(content);
    return;
  }
  json(404, { error: "not found", url: req.url });
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
const apiBase = `${origin}/api`;

function runBridge(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn("node", [tool, "--api-base", apiBase, "--origin", origin, "--company-id", companyId, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const help = await runBridge(["help"]);
  assert(help.status === 0, `help expected 0, got ${help.status}`);
  assert(help.stdout.includes("Option B"), "help must include Option B warning");

  const dryRun = await runBridge([
    "comment",
    "--issue", "OPE-209",
    "--role", "planning-lead",
    "--stage", "Planning",
    "--event-type", "planning_pass",
    "--summary", "Planning visible",
    "--agent-name", "Planning Lead",
    "--task-id", "OPE-209-TEST",
    "--run-folder", root,
    "--source-ref", "plan.md",
    "--dry-run",
  ]);
  assert(dryRun.status === 0, `dry-run expected 0, got ${dryRun.status}\n${dryRun.stderr}`);
  const dryJson = JSON.parse(dryRun.stdout);
  assert(dryJson.payload.body.includes("[planning-lead]"), "dry-run body missing role prefix");
  assert(dryJson.payload.authorAgentId === undefined, "dry-run payload must not spoof authorAgentId");
  assert(dryJson.agentResolution.found === true, "dry-run should resolve registered agent");

  const commentA = await runBridge([
    "comment",
    "--issue", "OPE-209",
    "--role", "planning-lead",
    "--stage", "Planning",
    "--event-type", "planning_pass",
    "--summary", "Planning pass visible",
    "--agent-name", "Planning Lead",
    "--task-id", "OPE-209-TEST",
    "--run-folder", root,
    "--source-ref", "plan.md",
  ]);
  assert(commentA.status === 0, `comment A expected 0, got ${commentA.status}\n${commentA.stderr}`);
  const commentAJson = JSON.parse(commentA.stdout);
  assert(commentAJson.comment.id === "comment-1", "comment A id mismatch");

  const commentB = await runBridge([
    "comment",
    "--issue", "OPE-209",
    "--role", "security-lead",
    "--stage", "Security Review",
    "--event-type", "security_pass",
    "--summary", "Security pass visible",
    "--agent-name", "security-lead",
    "--task-id", "OPE-209-TEST",
    "--run-folder", root,
  ]);
  assert(commentB.status === 0, `comment B expected 0, got ${commentB.status}\n${commentB.stderr}`);
  assert(state.comments["issue-209"].length === 2, "expected two comments");
  assert(state.comments["issue-209"].every((item) => item.body.startsWith("[")), "comments need visible role prefix");
  assert(state.comments["issue-209"].every((item) => item.metadata?.sections?.[0]?.rows?.some((row) => row.label === "trust_model")), "comments need trust metadata");

  const upload = await runBridge([
    "upload",
    "--issue", "OPE-209",
    "--file", pngFile,
    "--evidence-root", evidenceRoot,
    "--issue-comment-id", commentBJsonId(commentB.stdout),
  ]);
  assert(upload.status === 0, `upload expected 0, got ${upload.status}\n${upload.stdout}\n${upload.stderr}`);
  const uploadJson = JSON.parse(upload.stdout);
  assert(uploadJson.verification.ok === true, "upload verification should pass");
  assert(uploadJson.verification.contentVerification.ok === true, "contentPath hash verification should pass");
  assert(uploadJson.file.mimeType === "image/png", "MIME detection should see image/png");

  const unsafe = await runBridge([
    "upload",
    "--issue", "OPE-209",
    "--file", outsideFile,
    "--evidence-root", evidenceRoot,
  ]);
  assert(unsafe.status === 2, `unsafe upload should exit 2, got ${unsafe.status}`);
  assert(unsafe.stderr.includes("outside evidence root"), "unsafe upload error should mention evidence root");

  const comments = state.comments["issue-209"];
  assert(comments[0].metadata.sections[0].rows.some((row) => row.label === "paperclip_agent_id" && row.value === "agent-planning"), "registered agent id should be metadata only");
  assert(!comments.some((item) => Object.prototype.hasOwnProperty.call(item, "authorAgentId")), "comments must never set authorAgentId");

  console.log(JSON.stringify({
    ok: true,
    root,
    checks: [
      "help includes Option B warning",
      "dry-run builds visible role comment payload",
      "two different roles can post comments",
      "structured metadata includes trust caveat and agent/coms-net references",
      "PNG upload is constrained to evidence root and verified through GET attachments/contentPath",
      "outside evidence root upload is rejected",
      "authorAgentId is never sent",
    ],
  }, null, 2));
} finally {
  server.close();
}

function commentBJsonId(stdout) {
  return JSON.parse(stdout).comment.id;
}
