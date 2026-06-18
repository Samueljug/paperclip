#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  dedupeMarker,
  planPaperclipActions,
  resolveIssueMapping,
  runWatcher,
  scanNoMistakesDb,
  stageLabelPatch,
} from "./no-mistakes-review-watcher.mjs";
import { appendLedgerEvent, readLedgerEvents } from "./ledger-lib.mjs";

function tempRoot() {
  return mkdtempSync(resolve(tmpdir(), "nm-review-watcher-test-"));
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlite(dbPath, sql) {
  const result = spawnSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function createStateDb(dbPath, {
  issue = "777",
  runId = "NM-RUN-1",
  branch = "dark-factory/ope-777-repair",
  head = "abc123",
  baseBranch = "stage",
  workingPath = `/tmp/ope-${issue}/repo`,
  upstreamUrl = "https://github.com/example/repo.git",
  defaultBranch = "stage",
} = {}) {
  const findings = JSON.stringify({
    findings: [
      {
        id: "review-1",
        severity: "error",
        file: "app/service.rb",
        line: 42,
        description: "Internal marker can leak to customers through realtime broadcast.",
        action: "auto-fix",
      },
    ],
    summary: "Privacy-facing realtime leak",
    testing_summary: "Not run by reviewer.",
    risk_level: "high",
    risk_rationale: "The defect can expose internal diagnostic markers to customers.",
  });
  sqlite(dbPath, `
    CREATE TABLE repos (
      id TEXT PRIMARY KEY,
      working_path TEXT NOT NULL UNIQUE,
      upstream_url TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      pr_url TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      base_branch TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE step_results (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_name TEXT NOT NULL,
      step_order INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      exit_code INTEGER,
      duration_ms INTEGER,
      log_path TEXT,
      findings_json TEXT,
      error TEXT,
      started_at INTEGER,
      completed_at INTEGER
    );
    INSERT INTO repos VALUES ('repo-1', ${sqlString(workingPath)}, ${sqlString(upstreamUrl)}, ${sqlString(defaultBranch)}, 1);
    INSERT INTO runs VALUES (${sqlString(runId)}, 'repo-1', ${sqlString(branch)}, ${sqlString(head)}, 'base123', 'running', NULL, NULL, 1, 2, ${sqlString(baseBranch)});
    INSERT INTO step_results VALUES ('step-review', ${sqlString(runId)}, 'review', 4, 'awaiting_approval', NULL, 1234, 'review.log', ${sqlString(findings)}, NULL, 1, 2);
    INSERT INTO step_results VALUES ('step-ci', ${sqlString(runId)}, 'ci', 5, 'awaiting_approval', NULL, 1234, 'ci.log', ${sqlString(findings)}, NULL, 1, 2);
  `);
}

function readRequest(req) {
  return new Promise((resolveRead) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolveRead(Buffer.concat(chunks).toString("utf8")));
  });
}

function commentMetadataRows(metadata) {
  return new Map((metadata.sections || [])
    .flatMap((section) => section.rows || [])
    .map((row) => [row.label, row]));
}

function validatePaperclipCommentPayload(body) {
  const errors = [];
  const metadata = body?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    errors.push("metadata required object");
    return errors;
  }
  if (metadata.version !== 1) errors.push("metadata.version expected literal 1");
  if (!Array.isArray(metadata.sections)) errors.push("metadata.sections required array");
  for (const key of ["source", "dedupeMarker", "trustModel"]) {
    if (Object.prototype.hasOwnProperty.call(metadata, key)) {
      errors.push(`metadata.${key} unrecognized top-level key`);
    }
  }
  const marker = String(body?.body || "").match(/<!-- no-mistakes-review-watcher:[^>]+-->/)?.[0] || "";
  if (!marker) errors.push("body visible dedupe marker required");
  if (Array.isArray(metadata.sections)) {
    const rowsByLabel = commentMetadataRows(metadata);
    for (const label of ["source", "dedupe_marker", "trust_model", "no_mistakes_run_id"]) {
      if (!rowsByLabel.has(label)) errors.push(`metadata row ${label} required`);
    }
    if (rowsByLabel.get("source")?.value !== "no-mistakes-review-watcher") {
      errors.push("metadata source row must identify watcher");
    }
    if (rowsByLabel.get("dedupe_marker")?.value !== marker) {
      errors.push("metadata dedupe_marker row must match visible marker");
    }
    for (const row of rowsByLabel.values()) {
      if (row.type !== "key_value") errors.push(`metadata row ${row.label} must be key_value`);
      if (typeof row.label !== "string" || !row.label) errors.push("metadata row label required");
      if (typeof row.value !== "string" || !row.value) errors.push(`metadata row ${row.label} value required`);
    }
  }
  return errors;
}

function assertCommentMetadataShape(payload, alert) {
  assert.equal(payload.metadata.version, 1, "comment metadata version must be literal 1");
  assert(Array.isArray(payload.metadata.sections), "comment metadata sections must be an array");
  assert(!Object.prototype.hasOwnProperty.call(payload.metadata, "source"), "metadata must not use old top-level source");
  assert(!Object.prototype.hasOwnProperty.call(payload.metadata, "dedupeMarker"), "metadata must not use old top-level dedupeMarker");
  assert(!Object.prototype.hasOwnProperty.call(payload.metadata, "trustModel"), "metadata must not use old top-level trustModel");
  const rowsByLabel = commentMetadataRows(payload.metadata);
  assert.equal(rowsByLabel.get("source")?.value, "no-mistakes-review-watcher");
  assert.equal(rowsByLabel.get("dedupe_marker")?.value, alert.dedupeMarker);
  assert.equal(rowsByLabel.get("no_mistakes_run_id")?.value, alert.noMistakesRunId);
  assert.match(rowsByLabel.get("trust_model")?.value || "", /Reviewer text is advisory/);
}

async function withMockPaperclip(fn) {
  const state = {
    issues: [
      {
        id: "issue-777",
        identifier: "OPE-777",
        title: "Repair diagnostics leak",
        description: "Work for /tmp/ope-777/repo",
        status: "blocked",
        labelIds: ["stage-nm", "gate-nm"],
        labels: [
          { id: "stage-nm", name: "stage: No Mistakes Gate" },
          { id: "gate-nm", name: "gate: no-mistakes-required" },
        ],
      },
    ],
    labels: [
      { id: "stage-progress", name: "stage: In Progress" },
      { id: "stage-nm", name: "stage: No Mistakes Gate" },
      { id: "gate-nm", name: "gate: no-mistakes-required" },
      { id: "blocked-owner", name: "blocked: needs owner" },
    ],
    comments: { "issue-777": [] },
    issuePayloads: [],
    commentPayloads: [],
    commentValidationErrors: [],
    patches: [],
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (status, body) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && url.pathname === "/api/companies/company/issues") {
      json(200, state.issues);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/companies/company/labels") {
      json(200, state.labels);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/companies/company/issues") {
      let body = null;
      try {
        body = JSON.parse(await readRequest(req));
      } catch (error) {
        json(400, { error: "invalid json", detail: error.message });
        return;
      }
      state.issuePayloads.push(body);
      const sequence = state.issuePayloads.length;
      const issue = {
        id: `issue-created-${sequence}`,
        identifier: `OPE-DECISION-${sequence}`,
        title: body.title,
        description: body.description,
        status: body.status,
        priority: body.priority,
        projectId: body.projectId,
        labelIds: body.labelIds || [],
        labels: state.labels.filter((label) => (body.labelIds || []).includes(label.id)),
      };
      state.issues.push(issue);
      state.comments[issue.id] = [];
      json(200, issue);
      return;
    }
    const commentsMatch = url.pathname.match(/^\/api\/issues\/([^/]+)\/comments$/);
    if (commentsMatch && req.method === "GET") {
      json(200, state.comments[commentsMatch[1]] || []);
      return;
    }
    if (commentsMatch && req.method === "POST") {
      const issueId = commentsMatch[1];
      let body = null;
      try {
        body = JSON.parse(await readRequest(req));
      } catch (error) {
        json(400, { error: "invalid json", detail: error.message });
        return;
      }
      const validationErrors = validatePaperclipCommentPayload(body);
      if (validationErrors.length) {
        state.commentValidationErrors.push(...validationErrors);
        json(400, { error: "validation failed", validationErrors });
        return;
      }
      state.commentPayloads.push(body);
      if (!state.comments[issueId]) state.comments[issueId] = [];
      const comment = { id: `comment-${state.comments[issueId].length + 1}`, createdAt: new Date().toISOString(), ...body };
      state.comments[issueId].push(comment);
      json(200, comment);
      return;
    }
    const patchMatch = url.pathname.match(/^\/api\/issues\/([^/]+)$/);
    if (patchMatch && req.method === "PATCH") {
      const issueId = patchMatch[1];
      const body = JSON.parse(await readRequest(req));
      state.patches.push(body);
      const issue = state.issues.find((item) => item.id === issueId);
      if (!issue) {
        json(404, { error: "issue not found", issueId });
        return;
      }
      Object.assign(issue, body);
      if (Array.isArray(body.labelIds)) {
        issue.labels = state.labels.filter((label) => body.labelIds.includes(label.id));
      }
      json(200, issue);
      return;
    }
    json(404, { error: "not found", path: url.pathname });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    return await fn({ apiBase: `http://127.0.0.1:${server.address().port}/api`, state });
  } finally {
    server.close();
  }
}

const root = tempRoot();
const dbPath = resolve(root, "nm", "state.sqlite");
mkdirSync(resolve(root, "nm"), { recursive: true });
createStateDb(dbPath);

const alerts = scanNoMistakesDb(dbPath);
assert.equal(alerts.length, 1, "default scan should only include review step awaiting approval");
assert.equal(alerts[0].noMistakesRunId, "NM-RUN-1");
assert.equal(alerts[0].findingsSummary.count, 1);
assert.deepEqual(alerts[0].findingsSummary.severities, ["error"]);
assert.equal(alerts[0].repo.workingPath, "/tmp/ope-777/repo");
assert.match(alerts[0].commentBody, /Trust note:/);

const markerA = alerts[0].dedupeMarker;
assert.equal(dedupeMarker(alerts[0]), markerA, "dedupe marker should be stable for identical alert");
assert.notEqual(dedupeMarker({ ...alerts[0], headSha: "def456" }), markerA, "dedupe marker should change when HEAD changes");
assert.notEqual(dedupeMarker({ ...alerts[0], findingsFingerprint: "different" }), markerA, "dedupe marker should change when findings change");

const mapping = resolveIssueMapping(alerts[0], {
  issues: [{ id: "issue-777", identifier: "OPE-777", title: "Repair", status: "blocked", labels: [], labelIds: [] }],
  manifestEntries: [],
  ledgers: [],
  commentsByIssueId: {},
});
assert.equal(mapping.status, "mapped");
assert.equal(mapping.issue.identifier, "OPE-777");

const authoritativeMapping = resolveIssueMapping(alerts[0], {
  issues: [{ id: "issue-778", identifier: "OPE-778", title: "Manifest mapped", status: "in_review", labels: [], labelIds: [] }],
  manifestEntries: [{
    manifestPath: "/tmp/run/run-manifest.json",
    manifest: {
      issue: "OPE-778",
      paths: { noMistakesHome: alerts[0].nmHome },
      repo: { workingDir: "/elsewhere", branch: "other" },
    },
    workOrder: { issue: "OPE-778" },
  }],
  ledgers: [],
  commentsByIssueId: {},
});
assert.equal(authoritativeMapping.status, "mapped");
assert.equal(authoritativeMapping.issue.identifier, "OPE-778");
assert.equal(authoritativeMapping.authority, "authoritative");

const manifestRepoBranchMapping = resolveIssueMapping(alerts[0], {
  issues: [{ id: "issue-778", identifier: "OPE-778", title: "Manifest repo mapped", status: "in_review", labels: [], labelIds: [] }],
  manifestEntries: [{
    manifestPath: "/tmp/run/repo-branch-manifest.json",
    manifest: {
      issue: "OPE-778",
      paths: { noMistakesHome: "/tmp/df-nm/OPE-778-20260613T000000Z" },
      repo: { workingDir: alerts[0].repo.workingPath, branch: alerts[0].branch, headSha: alerts[0].headSha },
    },
    workOrder: { issue: "OPE-778" },
  }],
  ledgers: [],
  commentsByIssueId: {},
});
assert.equal(manifestRepoBranchMapping.status, "mapped");
assert.equal(manifestRepoBranchMapping.issue.identifier, "OPE-778");
assert.equal(manifestRepoBranchMapping.authority, "authoritative");

const tempNmHomeAlert = {
  ...alerts[0],
  nmHome: "/tmp/df-nm/OPE-779-20260613T000000Z",
  stateDbPath: "/tmp/df-nm/OPE-779-20260613T000000Z/state.sqlite",
  repo: {
    ...alerts[0].repo,
    workingPath: "/tmp/no-issue-token/repo",
  },
  branch: "feature/review-fix",
};
const tempNmHomeMapping = resolveIssueMapping(tempNmHomeAlert, {
  issues: [{ id: "issue-779", identifier: "OPE-779", title: "Temp NM_HOME mapped", status: "blocked", labels: [], labelIds: [] }],
  manifestEntries: [],
  ledgers: [{ issue: "OPE-779", text: `No Mistakes temp home: ${tempNmHomeAlert.nmHome}` }],
  commentsByIssueId: {},
});
assert.equal(tempNmHomeMapping.status, "mapped");
assert.equal(tempNmHomeMapping.issue.identifier, "OPE-779");
assert.equal(tempNmHomeMapping.authority, "authoritative");

const labelPlan = stageLabelPatch({
  labelIds: ["stage-nm", "gate-nm"],
}, new Map([
  ["stage: In Progress", { id: "stage-progress", name: "stage: In Progress" }],
  ["stage: No Mistakes Gate", { id: "stage-nm", name: "stage: No Mistakes Gate" }],
  ["gate: no-mistakes-required", { id: "gate-nm", name: "gate: no-mistakes-required" }],
]));
assert.equal(labelPlan.patch, true);
assert.deepEqual(labelPlan.labelIds, ["gate-nm", "stage-progress"]);

const donePlan = planPaperclipActions({
  alert: alerts[0],
  mapping: { status: "mapped", issue: { id: "issue-777", identifier: "OPE-777", status: "done", labels: [], labelIds: [] } },
  comments: [{ body: alerts[0].dedupeMarker }],
  ledgerEvents: [{ details: { dedupeMarker: alerts[0].dedupeMarker } }],
});
assert(donePlan.actions.some((action) => action.type === "skip_comment"), "dedupe: comment already posted must be skipped");
assert(donePlan.actions.some((action) => action.type === "skip_ledger"), "dedupe: ledger event already posted must be skipped");
// done issues must be reopened — no terminal skip
assert(donePlan.actions.some((action) => action.type === "patch_status" && action.status === "in_progress"), "done issue must be reopened to in_progress");
assert(!donePlan.actions.some((action) => action.type === "skip_status" && /terminal/.test(action.reason)), "done issue must not be skipped as terminal");

const ledgerOnlyPlan = planPaperclipActions({
  alert: alerts[0],
  mapping: { status: "mapped", issue: { id: "issue-777", identifier: "OPE-777", status: "in_progress", labels: [], labelIds: [] } },
  comments: [],
  ledgerEvents: [{ details: { dedupeMarker: alerts[0].dedupeMarker } }],
});
assert(ledgerOnlyPlan.actions.some((action) => action.type === "post_comment"), "ledger-only dedupe must still post missing Paperclip comment");
assert(ledgerOnlyPlan.actions.some((action) => action.type === "skip_ledger"), "ledger-only dedupe must not append duplicate ledger event");

{
  const originalHome = process.env.HOME;
  const testHome = resolve(root, "home-nmpr");
  process.env.HOME = testHome;
  try {
    const globalNmHome = resolve(testHome, ".no-mistakes");
    const globalStateDb = resolve(globalNmHome, "state.sqlite");
    mkdirSync(globalNmHome, { recursive: true });
    createStateDb(globalStateDb, {
      runId: "01KTXEN7Z1T09Y2TK1ZYJW9QN0",
      branch: "fix/rerun-base-no-default-fallback",
      head: "f68dcbf13365252aa4260bd3b11e7739d66f2c96",
      baseBranch: "main",
      workingPath: "/Users/samuelimini/Development/Stage/nm-pr",
      upstreamUrl: "https://github.com/Samueljug/no-mistakes.git",
      defaultBranch: "main",
    });
    const nmPrAlerts = scanNoMistakesDb(globalStateDb);
    assert.equal(nmPrAlerts.length, 1, "nm-pr fixture should expose one alert");
    const correctionComment = {
      body: [
        "Correction: pre-hardening watcher misrouted nm-pr No Mistakes alert to OPE-152.",
        "incorrect_run_id: 01KTXEN7Z1T09Y2TK1ZYJW9QN0",
        "incorrect_repo: /Users/samuelimini/Development/Stage/nm-pr",
        "correct_decision_issue: OPE-463",
      ].join("\n"),
      metadata: { source: "manual-correction-note" },
    };
    const correctionCommentMapping = resolveIssueMapping(nmPrAlerts[0], {
      issues: [{ id: "issue-152", identifier: "OPE-152", title: "Customer support diagnostics API", description: "Unrelated customer-support repair", status: "done", labels: [], labelIds: [] }],
      manifestEntries: [],
      ledgers: [],
      commentsByIssueId: { "issue-152": [correctionComment] },
    });
    assert.equal(correctionCommentMapping.status, "unmapped", "manual correction comments must not become future routing evidence");

    const ledgerRoot = resolve(root, "ledgers-nmpr-global");
    const ledgerDir = resolve(ledgerRoot, "OPE-152");
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(resolve(ledgerDir, "events.jsonl"), [
      JSON.stringify({
        eventType: "artifact",
        actor: "pi-orchestrator",
        summary: "Generic global No Mistakes state DB reference only.",
        artifacts: [{ kind: "no_mistakes_state_sqlite", path: globalStateDb }],
        sourceRefs: [{ kind: "no_mistakes_home", path: globalNmHome }],
      }),
      JSON.stringify({
        eventType: "no_mistakes_review_findings",
        actor: "no-mistakes-review-watcher",
        summary: "No Mistakes review awaiting approval: prior bad watcher event",
        details: {
          dedupeMarker: nmPrAlerts[0].dedupeMarker,
          noMistakesRunId: "01KTXEN7Z1T09Y2TK1ZYJW9QN0",
          nmHome: globalNmHome,
          stateDbPath: globalStateDb,
          repo: {
            workingPath: "/Users/samuelimini/Development/Stage/nm-pr",
            upstreamUrl: "https://github.com/Samueljug/no-mistakes.git",
          },
          branch: "fix/rerun-base-no-default-fallback",
          headSha: "f68dcbf13365252aa4260bd3b11e7739d66f2c96",
        },
      }),
      JSON.stringify({
        eventType: "no_mistakes_watcher_correction",
        actor: "OpenClaw",
        summary: "Correction: pre-hardening watcher misrouted nm-pr No Mistakes alert to OPE-152; correct visible routing decision is OPE-463.",
        details: {
          incorrect_comment_id: "comment-bad",
          incorrect_run_id: "01KTXEN7Z1T09Y2TK1ZYJW9QN0",
          incorrect_repo: "/Users/samuelimini/Development/Stage/nm-pr",
          correct_decision_issue: "OPE-463",
          mapping_fix_commit: "79961ed",
        },
      }),
    ].join("\n"));

    await withMockPaperclip(async ({ apiBase, state }) => {
      Object.assign(state.issues[0], {
        identifier: "OPE-152",
        title: "Customer support diagnostics API",
        description: `Only generic No Mistakes paths are mentioned: ${globalNmHome} and ${globalStateDb}`,
        status: "done",
      });
      const result = await runWatcher({
        apply: false,
        stateDbs: [globalStateDb],
        includeDefaultStateDbs: false,
        scanNmRoot: false,
        scanRunManifests: false,
        apiBase,
        companyId: "company",
        projectId: "project",
        ledgerRoot,
      });
      assert.equal(result.ok, true, JSON.stringify(result, null, 2));
      assert.equal(result.foundAlerts, 1);
      assert.equal(result.mappedAlerts, 0, "generic global NM evidence must not map nm-pr to OPE-152");
      assert.equal(result.decisionNeededAlerts, 1, "nm-pr alert should remain decision_needed");
      assert.equal(result.results[0].mapping.status, "unmapped", "nm-pr alert should have no deterministic issue mapping");
      assert.equal(result.results[0].plan.mode, "decision_needed");
    });

    await withMockPaperclip(async ({ apiBase, state }) => {
      Object.assign(state.issues[0], {
        identifier: "OPE-152",
        title: "Customer support diagnostics API",
        description: `Only generic No Mistakes paths are mentioned: ${globalNmHome} and ${globalStateDb}`,
        status: "done",
      });
      const runOptions = {
        apply: true,
        stateDbs: [globalStateDb],
        includeDefaultStateDbs: false,
        scanNmRoot: false,
        scanRunManifests: false,
        apiBase,
        companyId: "company",
        projectId: "project",
        ledgerRoot,
      };
      const first = await runWatcher(runOptions);
      assert.equal(first.ok, true, JSON.stringify(first, null, 2));
      assert.equal(first.foundAlerts, 1);
      assert.equal(first.mappedAlerts, 0, "decision apply must not map nm-pr to OPE-152");
      assert.equal(first.decisionNeededAlerts, 1);
      assert.equal(state.issuePayloads.length, 1, "decision apply should create one visible Paperclip decision issue");
      const payload = state.issuePayloads[0];
      assert.match(payload.title, /^No Mistakes routing decision needed: nm-pr fix\/rerun-base-no-default-fallback/);
      assert.equal(payload.status, "blocked");
      assert.equal(payload.priority, "high");
      assert.equal(payload.projectId, "project");
      assert(payload.labelIds.includes("blocked-owner"), "decision issue should use discovered blocked owner label");
      assert(payload.labelIds.includes("gate-nm"), "decision issue should use discovered No Mistakes gate label");
      for (const expected of [
        nmPrAlerts[0].dedupeMarker,
        "Source: no-mistakes-review-watcher",
        "Mapping status: unmapped",
        "01KTXEN7Z1T09Y2TK1ZYJW9QN0",
        globalNmHome,
        globalStateDb,
        "/Users/samuelimini/Development/Stage/nm-pr",
        "https://github.com/Samueljug/no-mistakes.git",
        "fix/rerun-base-no-default-fallback",
        "main",
        "f68dcbf13365252aa4260bd3b11e7739d66f2c96",
        "Affected files:",
        "app/service.rb:42",
        "Candidate Paperclip issues:",
        "Exact next action:",
      ]) {
        assert(payload.description.includes(expected), `decision issue description should include ${expected}`);
      }
      const decisionIssue = state.issues.find((issue) => issue.id === "issue-created-1");
      assert(decisionIssue, "created decision issue should be listed for future dedupe");
      assert.equal(state.comments[decisionIssue.id].length, 1, "decision apply should post one structured decision comment");
      assert.equal(state.commentPayloads.length, 1, "decision apply should submit one comment payload");
      assertCommentMetadataShape(state.commentPayloads[0], nmPrAlerts[0]);
      assert(state.commentPayloads[0].body.includes("Mapping status: unmapped"), "decision comment should include routing status");
      assert(first.results[0].applied.some((action) => action.type === "create_decision_issue"), "apply report should include decision issue creation");
      assert(first.results[0].applied.some((action) => action.type === "post_decision_comment"), "apply report should include decision comment creation");

      const second = await runWatcher(runOptions);
      assert.equal(second.ok, true, JSON.stringify(second, null, 2));
      assert.equal(second.mappedAlerts, 0, "created decision issue must not become repair-ticket mapping evidence");
      assert.equal(state.issuePayloads.length, 1, "decision rerun should not create another issue");
      assert.equal(state.comments[decisionIssue.id].length, 1, "decision rerun should not post another comment");
      assert.equal(state.commentPayloads.length, 1, "decision rerun should not submit another comment payload");
      const secondActions = second.results[0].plan.actions.map((action) => action.type);
      assert(secondActions.includes("skip_decision_issue"), "decision rerun should reuse existing decision issue");
      assert(secondActions.includes("skip_decision_comment"), "decision rerun should dedupe comment by marker");
      assert.equal(state.issues[0].status, "done", "decision apply must not mutate unrelated generic OPE-152 issue");
    });
  } finally {
    process.env.HOME = originalHome;
  }
}

const doneReopenPlan = planPaperclipActions({
  alert: alerts[0],
  mapping: { status: "mapped", issue: { id: "issue-done", identifier: "OPE-999", status: "done", labels: [], labelIds: ["stage-nm"] } },
  comments: [],
  ledgerEvents: [],
  labelsByName: new Map([
    ["stage: In Progress", { id: "stage-progress", name: "stage: In Progress" }],
    ["stage: No Mistakes Gate", { id: "stage-nm", name: "stage: No Mistakes Gate" }],
  ]),
  patchStageLabel: true,
});
assert(doneReopenPlan.actions.some((action) => action.type === "patch_status" && action.status === "in_progress"), "done issue reopen: must patch status to in_progress");
assert(doneReopenPlan.actions.some((action) => action.type === "patch_stage_label"), "done issue reopen: must receive stage: In Progress label");
assert(!doneReopenPlan.actions.some((action) => action.type === "skip_status" && /terminal/.test(action.reason)), "done issue reopen: must not be skipped as terminal");

await withMockPaperclip(async ({ apiBase, state }) => {
  const ledgerRoot = resolve(root, "ledgers");
  const first = await runWatcher({
    apply: true,
    stateDbs: [dbPath],
    includeDefaultStateDbs: false,
    scanNmRoot: false,
    scanRunManifests: false,
    scanLedgers: false,
    apiBase,
    companyId: "company",
    projectId: "project",
    ledgerRoot,
    issue: "OPE-777",
  });
  assert.equal(first.ok, true, JSON.stringify(first, null, 2));
  assert.equal(first.foundAlerts, 1);
  assert.equal(first.mappedAlerts, 1);
  assert.equal(state.comments["issue-777"].length, 1, "apply should post one comment");
  assert.equal(state.commentPayloads.length, 1, "apply should submit one comment payload");
  assertCommentMetadataShape(state.commentPayloads[0], alerts[0]);
  assert.equal(state.issues[0].status, "in_progress", "apply should move issue to in_progress");
  assert.deepEqual(state.issues[0].labelIds.sort(), ["gate-nm", "stage-progress"].sort(), "apply should preserve non-stage labels and set stage in progress");
  assert.equal(readLedgerEvents("OPE-777", ledgerRoot).length, 1, "apply should append one ledger event");

  const second = await runWatcher({
    apply: true,
    stateDbs: [dbPath],
    includeDefaultStateDbs: false,
    scanNmRoot: false,
    scanRunManifests: false,
    scanLedgers: false,
    apiBase,
    companyId: "company",
    projectId: "project",
    ledgerRoot,
    issue: "OPE-777",
  });
  assert.equal(second.ok, true, JSON.stringify(second, null, 2));
  assert.equal(state.comments["issue-777"].length, 1, "dedupe should not post a second comment");
  assert.equal(state.commentPayloads.length, 1, "dedupe should not submit a second comment payload");
  assert.equal(readLedgerEvents("OPE-777", ledgerRoot).length, 1, "dedupe should not append a second ledger event");
});

await withMockPaperclip(async ({ apiBase, state }) => {
  const ledgerRoot = resolve(root, "ledgers-comment-recovery");
  appendLedgerEvent({
    issue: "OPE-777",
    issueId: "issue-777",
    eventType: "no_mistakes_review_findings",
    actor: "no-mistakes-review-watcher",
    actorRole: "monitor",
    summary: "Preexisting ledger event from partial live apply",
    details: { dedupeMarker: alerts[0].dedupeMarker },
  }, { root: ledgerRoot });

  const first = await runWatcher({
    apply: true,
    stateDbs: [dbPath],
    includeDefaultStateDbs: false,
    scanNmRoot: false,
    scanRunManifests: false,
    scanLedgers: false,
    apiBase,
    companyId: "company",
    projectId: "project",
    ledgerRoot,
    issue: "OPE-777",
  });
  assert.equal(first.ok, true, JSON.stringify(first, null, 2));
  const firstActions = first.results[0].plan.actions.map((action) => action.type);
  assert(firstActions.includes("post_comment"), "ledger-only live recovery should still post the missing comment");
  assert(firstActions.includes("skip_ledger"), "ledger-only live recovery should not append another ledger event");
  assert.equal(state.comments["issue-777"].length, 1, "ledger-only live recovery should post one comment");
  assert.equal(state.commentPayloads.length, 1, "ledger-only live recovery should submit one comment payload");
  assertCommentMetadataShape(state.commentPayloads[0], alerts[0]);
  assert.equal(readLedgerEvents("OPE-777", ledgerRoot).length, 1, "ledger-only live recovery should preserve the existing single ledger event");

  const second = await runWatcher({
    apply: true,
    stateDbs: [dbPath],
    includeDefaultStateDbs: false,
    scanNmRoot: false,
    scanRunManifests: false,
    scanLedgers: false,
    apiBase,
    companyId: "company",
    projectId: "project",
    ledgerRoot,
    issue: "OPE-777",
  });
  assert.equal(second.ok, true, JSON.stringify(second, null, 2));
  const secondActions = second.results[0].plan.actions.map((action) => action.type);
  assert(secondActions.includes("skip_comment"), "comment marker should dedupe rerun after recovery comment exists");
  assert(secondActions.includes("skip_ledger"), "ledger marker should keep deduping reruns");
  assert.equal(state.comments["issue-777"].length, 1, "recovery rerun should not spam comments");
  assert.equal(state.commentPayloads.length, 1, "recovery rerun should not submit another comment payload");
  assert.equal(readLedgerEvents("OPE-777", ledgerRoot).length, 1, "recovery rerun should not append another ledger event");
});

await withMockPaperclip(async ({ apiBase, state }) => {
  // Start with a done issue — must be reopened when actionable NM findings exist.
  state.issues[0].status = "done";
  state.issues[0].labelIds = ["stage-nm", "gate-nm"];
  state.issues[0].labels = [
    { id: "stage-nm", name: "stage: No Mistakes Gate" },
    { id: "gate-nm", name: "gate: no-mistakes-required" },
  ];
  const ledgerRoot = resolve(root, "ledgers-done-reopen");
  const result = await runWatcher({
    apply: true,
    stateDbs: [dbPath],
    includeDefaultStateDbs: false,
    scanNmRoot: false,
    scanRunManifests: false,
    scanLedgers: false,
    apiBase,
    companyId: "company",
    projectId: "project",
    ledgerRoot,
    issue: "OPE-777",
  });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(state.comments["issue-777"].length, 1, "done-reopen: apply should post one comment");
  assert.equal(state.issues[0].status, "in_progress", "done-reopen: done issue must be reopened to in_progress");
  assert.deepEqual(state.issues[0].labelIds.sort(), ["gate-nm", "stage-progress"].sort(), "done-reopen: done issue must receive stage: In Progress label");
  assert.equal(readLedgerEvents("OPE-777", ledgerRoot).length, 1, "done-reopen: apply should append one ledger event");
});

console.log(JSON.stringify({
  ok: true,
  checks: [
    "SQLite scan filters review awaiting_approval rows and parses findings_json",
    "dedupe marker is stable and changes on HEAD/findings changes",
    "fallback and authoritative issue mapping work, including manifest repo+branch/head and temp NM_HOME evidence",
    "generic global No Mistakes home/state DB evidence plus watcher/correction visibility records leave unrelated nm-pr alerts decision_needed",
    "decision_needed apply creates one blocked Paperclip routing issue/comment with full NM context and dedupes reruns without mapping to the decision issue",
    "done/cancelled issues are reopened to in_progress with stage: In Progress label (not skipped as terminal)",
    "mock Paperclip apply validates accepted metadata shape, posts one comment, appends one ledger event, patches status/label, and dedupes reruns",
    "ledger-only dedupe still posts missing Paperclip comment, then dedupes after comment marker exists",
    "mock Paperclip apply reopens a done issue to in_progress and sets stage: In Progress label",
  ],
}, null, 2));
