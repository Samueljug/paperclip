#!/usr/bin/env node

import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { appendLedgerEvent } from "./ledger-lib.mjs";

const root = mkdtempSync(resolve(tmpdir(), "paperclip-evidence-audit-test-"));
const ledgerRoot = resolve(root, "ledgers");
const auditTool = resolve(new URL("./evidence-audit.mjs", import.meta.url).pathname);
const companyId = "company-test";

const state = {
  issues: [
    { id: "issue-neg", identifier: "OPE-NEG", title: "negative missing coverage", status: "in_review", projectId: "project-a", labels: [{ name: "ledger: required" }] },
    { id: "issue-pos", identifier: "OPE-POS", title: "positive complete coverage", status: "in_review", projectId: "project-a", labels: [{ name: "ledger: required" }] },
    { id: "issue-dup", identifier: "OPE-DUP", title: "duplicate comments", status: "in_review", projectId: "project-b", labels: [] },
    { id: "issue-attach", identifier: "OPE-ATTACH", title: "attachment API only", status: "in_progress", projectId: "project-b", labels: [] },
  ],
  comments: {
    "issue-neg": [],
    "issue-pos": [
      {
        id: "comment-pos-plan",
        body: "[planning-lead] Planning pass\n\nTask: OPE-POS-TEST\nRun: /tmp/run-pos\nTrust: Option B advisory/display-only; not non-forgeable",
        metadata: {
          version: 1,
          sections: [{ title: "Dark Factory attribution", rows: [
            { label: "role", value: "planning-lead" },
            { label: "event_type", value: "planning_pass" },
            { label: "task_id", value: "OPE-POS-TEST" },
            { label: "run_folder", value: "/tmp/run-pos" },
          ] }],
        },
        presentation: { title: "Dark Factory role comment: planning-lead" },
        createdAt: "2026-06-10T00:00:00.000Z",
      },
      {
        id: "comment-pos-verify",
        body: "[verification-lead] Verification pass",
        metadata: { role: "verification-lead", event_type: "verification_pass" },
        presentation: null,
        createdAt: "2026-06-10T00:01:00.000Z",
      },
      {
        id: "comment-pos-factory-log",
        body: "Factory ledger event recorded: security_pass\n- Summary: Security PASS.\n- Actor: security-lead\n- Stage: Security Review",
        metadata: null,
        presentation: null,
        createdAt: "2026-06-10T00:02:00.000Z",
      },
    ],
    "issue-dup": [
      { id: "dup-1", body: "[planning-lead] Planning pass", metadata: { role: "planning-lead", event_type: "planning_pass" }, presentation: null, createdAt: "2026-06-10T00:00:00.000Z" },
      { id: "dup-2", body: "[planning-lead] Planning pass again", metadata: { role: "planning-lead", event_type: "planning_pass" }, presentation: null, createdAt: "2026-06-10T00:01:00.000Z" },
    ],
    "issue-attach": [
      { id: "attach-comment", body: "[browser-qa-lead] Screenshot is at /tmp/local-only-screen.png", metadata: { role: "browser-qa-lead", event_type: "browser_qa_pass" }, presentation: null, createdAt: "2026-06-10T00:00:00.000Z" },
    ],
  },
  attachments: {
    "issue-neg": [],
    "issue-pos": [
      { id: "attach-pos-image", contentType: "image/png", originalFilename: "screen.png", byteSize: 12, sha256: "abc", contentPath: "/api/attachments/attach-pos-image/content" },
    ],
    "issue-dup": [],
    "issue-attach": [],
  },
};

appendLedgerEvent({ issue: "OPE-POS", eventType: "planning_pass", actor: "planning-lead", actorRole: "planning-lead", summary: "Planning passed" }, { root: ledgerRoot });
appendLedgerEvent({ issue: "OPE-POS", eventType: "verification_pass", actor: "verification-lead", actorRole: "verification-lead", summary: "Verification passed" }, { root: ledgerRoot });
appendLedgerEvent({ issue: "OPE-DUP", eventType: "planning_pass", actor: "planning-lead", actorRole: "planning-lead", summary: "Planning passed" }, { root: ledgerRoot });

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json; charset=utf-8");
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === `/api/companies/${companyId}/issues`) {
    res.end(JSON.stringify(state.issues));
    return;
  }
  const match = url.pathname.match(/^\/api\/issues\/([^/]+)\/(comments|attachments)$/);
  if (req.method === "GET" && match) {
    const [, issueId, kind] = match;
    res.end(JSON.stringify(state[kind][issueId] || []));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found", url: req.url }));
});

await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
const apiBase = `http://127.0.0.1:${server.address().port}/api`;

function runAudit(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn("node", [auditTool, "--api-base", apiBase, "--company-id", companyId, "--ledger-root", ledgerRoot, ...args], {
      encoding: "utf8",
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
  const negative = await runAudit([
    "--issue", "OPE-NEG",
    "--require-role", "planning-lead",
    "--require-event", "planning_pass",
    "--require-image",
    "--require-ledger",
    "--fail-closed",
    "--format", "json",
  ]);
  assert(negative.status === 1, `negative expected exit 1, got ${negative.status}\n${negative.stdout}\n${negative.stderr}`);
  const negativeJson = JSON.parse(negative.stdout);
  assert(negativeJson.issues[0].missing.some((item) => item.kind === "role_comment"), "negative missing role_comment not reported");
  assert(negativeJson.issues[0].missing.some((item) => item.kind === "image_attachment"), "negative missing image_attachment not reported");

  const positive = await runAudit([
    "--issue", "OPE-POS",
    "--require-role", "planning-lead",
    "--require-event", "planning_pass",
    "--require-event", "verification_pass",
    "--require-event", "security_pass",
    "--require-image",
    "--require-ledger",
    "--fail-closed",
    "--format", "json",
  ]);
  assert(positive.status === 0, `positive expected exit 0, got ${positive.status}\n${positive.stdout}\n${positive.stderr}`);
  const positiveJson = JSON.parse(positive.stdout);
  assert(positiveJson.verdict === "PASS", "positive verdict was not PASS");
  assert(positiveJson.advisoryNote.includes("not non-forgeable identity proof"), "advisory note missing from JSON output");
  assert(positiveJson.issues[0].attachments.declaredImages === 1, "positive image attachment count wrong");

  const dedupe = await runAudit([
    "--issue", "OPE-DUP",
    "--require-role", "planning-lead",
    "--require-event", "planning_pass",
    "--format", "json",
  ]);
  assert(dedupe.status === 0, `dedupe expected exit 0, got ${dedupe.status}\n${dedupe.stdout}\n${dedupe.stderr}`);
  const dedupeJson = JSON.parse(dedupe.stdout);
  const dedupeIssue = dedupeJson.issues[0];
  assert(dedupeIssue.comments.rawRoleEventCommentCount === 2, "dedupe raw count should see two role/event comments");
  assert(dedupeIssue.comments.uniqueRoleEventCommentCount === 1, "dedupe unique role/event count should be one");
  assert(dedupeIssue.comments.duplicateRoleEventComments === 1, "dedupe duplicate count should be one");

  const attachmentApiOnly = await runAudit([
    "--issue", "OPE-ATTACH",
    "--require-role", "browser-qa-lead",
    "--require-event", "browser_qa_pass",
    "--require-image",
    "--fail-closed",
    "--format", "json",
  ]);
  assert(attachmentApiOnly.status === 1, `attachment API-only expected exit 1, got ${attachmentApiOnly.status}\n${attachmentApiOnly.stdout}\n${attachmentApiOnly.stderr}`);
  const attachmentJson = JSON.parse(attachmentApiOnly.stdout);
  assert(attachmentJson.issues[0].attachments.declaredImages === 0, "local path should not count as Paperclip-side image attachment");
  assert(attachmentJson.issues[0].missing.some((item) => item.kind === "image_attachment"), "missing API image attachment not reported");

  const text = await runAudit(["--issue", "OPE-POS", "--require-role", "planning-lead", "--format", "text"]);
  assert(text.status === 0, `text output expected exit 0, got ${text.status}`);
  assert(text.stdout.includes("Option B visibility audit only"), "text output missing advisory warning");
  assert(text.stdout.includes("### OPE-POS — PASS"), "text output missing issue PASS section");

  const directError = await new Promise((resolveRun, reject) => {
    const child = spawn("node", [auditTool, "--api-base", "http://127.0.0.1:9/api", "--company-id", companyId, "--ledger-root", ledgerRoot, "--issue", "OPE-POS", "--format", "json"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
  assert(directError.status === 2, `API error expected exit 2, got ${directError.status}\n${directError.stdout}\n${directError.stderr}`);

  const booleanFootgun = await runAudit(["--issue", "OPE-POS", "--require-image", "screen.png", "--format", "json"]);
  assert(booleanFootgun.status === 2, `boolean flag with value expected exit 2, got ${booleanFootgun.status}\n${booleanFootgun.stdout}\n${booleanFootgun.stderr}`);
  assert(booleanFootgun.stderr.includes("--require-image is a boolean flag"), "boolean flag misuse should produce a clear error");

  console.log(JSON.stringify({
    ok: true,
    root,
    apiBase,
    checks: [
      "negative missing required coverage exits 1",
      "positive complete coverage exits 0",
      "duplicate role/event comments do not inflate unique coverage",
      "attachment requirement uses Paperclip API attachments, not local paths",
      "text and JSON output include Option B advisory warning",
      "unreachable API exits 2",
      "boolean requirement flags reject accidental values"
    ],
  }, null, 2));
} finally {
  server.close();
}
