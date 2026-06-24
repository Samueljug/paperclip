#!/usr/bin/env node

import { ledgerPaths, readManifest, verifyLedger } from "./ledger-lib.mjs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_API = "http://127.0.0.1:3101/api";
const COMPANY_ID = "1e8bc12a-f8fd-431c-9fbd-e47be79446a3";
const IMPROVEMENT_PROJECT_ID = "b999a19a-a5f3-4d41-9d65-f845fd7b7ee0";
const REPORTER_AGENT_ID = "9b8240f0-f0e8-4175-bd06-7534b8f43185";
const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKLOG_REVIEWER = resolve(__dirname, "improvement-backlog-claude-reviewer.mjs");

const BASE_LABELS = [
  "report: improvement",
  "report: task retro",
  "scope: whole-run",
  "improvement: proposed",
];

const PATTERN_LABELS = new Map([
  ["one_off", "improvement: one-off"],
  ["one-off", "improvement: one-off"],
  ["one off", "improvement: one-off"],
  ["possible_pattern", "improvement: possible pattern"],
  ["possible-pattern", "improvement: possible pattern"],
  ["possible pattern", "improvement: possible pattern"],
  ["repeated_pattern", "improvement: repeated pattern"],
  ["repeated-pattern", "improvement: repeated pattern"],
  ["repeated pattern", "improvement: repeated pattern"],
  ["major_improvement", "improvement: major improvement"],
  ["major-improvement", "improvement: major improvement"],
  ["major improvement", "improvement: major improvement"],
]);

const TARGET_LABELS = new Map([
  ["pipeline", "target: pipeline"],
  ["agent", "target: agent"],
  ["agents", "target: agent"],
  ["skill", "target: skill"],
  ["skills", "target: skill"],
  ["policy", "target: policy"],
  ["tooling", "target: tooling"],
  ["tools", "target: tooling"],
  ["memory", "target: memory"],
]);

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

function requireArg(args, key) {
  const value = args[key]?.trim();
  if (!value) {
    throw new Error(`Missing --${key}`);
  }
  return value;
}

function optional(args, key, fallback = "Not recorded yet.") {
  return args[key]?.trim() || fallback;
}

async function request(api, path, options = {}) {
  const res = await fetch(`${api}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${options.method || "GET"} ${path} -> ${res.status}: ${text}`);
  }
  return body;
}

function maybeRunClaudeBacklogReview(issue, args) {
  if (args["no-claude-review"] === "true") {
    return { skipped: true, reason: "disabled by --no-claude-review" };
  }
  if (String(issue.status || "").toLowerCase() !== "backlog") {
    return { skipped: true, reason: "report status is not backlog" };
  }
  const result = spawnSync(process.execPath, [
    BACKLOG_REVIEWER,
    "--apply",
    "--issue", issue.identifier,
    "--max-candidates", "1",
    "--format", "json",
  ], {
    cwd: resolve(__dirname, "../.."),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: Number(args["claude-review-timeout-ms"] || 5 * 60 * 1000),
    shell: false,
    env: {
      ...process.env,
      PAPERCLIP_API_BASE: process.env.PAPERCLIP_API_BASE || DEFAULT_API,
    },
  });
  if (result.status !== 0) {
    return {
      ok: false,
      status: result.status,
      signal: result.signal,
      error: result.error?.message || null,
      stdout: (result.stdout || "").trim().slice(0, 2000),
      stderr: (result.stderr || "").trim().slice(0, 2000),
    };
  }
  try {
    return JSON.parse(result.stdout || "{}");
  } catch (error) {
    return {
      ok: false,
      error: `Could not parse backlog reviewer JSON: ${error.message}`,
      stdout: (result.stdout || "").trim().slice(0, 2000),
    };
  }
}

function labelFor(map, raw, kind) {
  const key = (raw || "").trim().toLowerCase();
  const label = map.get(key);
  if (!label) {
    throw new Error(`Unknown ${kind}: ${raw}`);
  }
  return label;
}

function labelNames(args) {
  const names = [...BASE_LABELS];
  names.push(labelFor(PATTERN_LABELS, args.pattern || "one_off", "pattern"));
  names.push(labelFor(TARGET_LABELS, args.target || "pipeline", "target"));

  const approval = (args.approval || "skill_proposal").trim().toLowerCase();
  if (approval !== "none") {
    names.push("approval: samuel-needed");
  }
  if (args["design-verification"]?.trim()) {
    names.push("evidence: design-reference");
    names.push("evidence: screenshots");
  }

  return names;
}

function buildDescription(args) {
  const source = requireArg(args, "source");
  const approval = args.approval || "skill_proposal";
  const pattern = args.pattern || "one_off";
  const target = args.target || "pipeline";

  const sourceLines = [`- Source ticket: ${source}`];
  if (args["source-url"]) sourceLines.push(`- Source URL: ${args["source-url"]}`);
  if (args.pr) sourceLines.push(`- PR: ${args.pr}`);
  if (args.run) sourceLines.push(`- Run IDs: ${args.run}`);
  if (args.evidence) sourceLines.push(`- Evidence: ${args.evidence}`);
  const sourceManifest = readManifest(source);
  const sourceLedger = ledgerPaths(source);
  const sourceLedgerVerification = sourceManifest ? verifyLedger(source) : null;
  if (sourceManifest) sourceLines.push(`- Factory run ledger: ${sourceLedger.eventsPath}`);

  const sections = [
    "# Improvement Report",
    sourceLines.join("\n"),
    "## Outcome Summary",
    requireArg(args, "summary"),
    "## Factory Run Ledger",
    sourceManifest
      ? [
        `- Path: ${sourceLedger.eventsPath}`,
        `- Hash chain valid: ${sourceLedgerVerification.ok ? "yes" : "no"}`,
        `- Event count: ${sourceLedgerVerification.count}`,
        `- Last hash: ${sourceLedgerVerification.lastHash || "none"}`,
      ].join("\n")
      : "No source task ledger found. Treat this as a logging gap unless this report is for a legacy/non-task item.",
    "## Whole-Run Sources Reviewed",
    optional(
      args,
      "sources-reviewed",
      [
        "- Original brief / intake ticket",
        "- Factory run ledger when present",
        "- Planning notes and task decomposition",
        "- Agent conversations, handoffs, and decisions",
        "- Work performed and evidence artifacts",
        "- Verification, Browser / Visual QA, Security Review, No Mistakes, CI, PR, and human feedback where applicable",
      ].join("\n"),
    ),
    "## Source Log Coverage",
    optional(
      args,
      "log-coverage",
      [
        "- Paperclip ticket history/comments: not recorded",
        "- Pi/Dark Factory run folder or transcript: not recorded",
        "- Agent handoff/conversation logs: not recorded",
        "- Tool/evidence logs: not recorded",
        "- PR/CI/review logs: not recorded",
      ].join("\n"),
    ),
    "## Missing Logs / Logging Gaps",
    optional(
      args,
      "missing-logs",
      "If any expected conversation, handoff, run artifact, tool output, evidence, or review source is missing, list it here and treat it as an improvement finding.",
    ),
    "## Step-by-Step Factory Observations",
    optional(args, "step-observations"),
    "## Conversation / Thinking / Handoff Review",
    optional(args, "conversation-review"),
    "## What Worked",
    optional(args, "worked"),
    "## Issues Encountered / Blockers",
    optional(args, "issues"),
    "## Feedback From Agents / Reviewers / Gates",
    optional(args, "feedback"),
    "## Design / Visual Verification",
    optional(
      args,
      "design-verification",
      "If a design brief/reference was supplied, record whether Browser / Visual QA compared the rendered result against it, what screenshots/video/visual-diff evidence was produced, and any mismatches found.",
    ),
    "## Pattern Status",
    pattern,
    "## Suggested Improvement",
    optional(args, "suggestion"),
    "## Target",
    target,
    "## Expected Benefit",
    optional(args, "benefit"),
    "## Approval Needed",
    approval,
    "## Proposed Next Action",
    optional(args, "next-action"),
    "## Samuel Approval Status",
    optional(
      args,
      "approval-status",
      "Pending Samuel review. Move this report from Backlog to To Do to approve applying the improvement.",
    ),
    "## Result If Approved / Applied",
    optional(args, "result", "Not applied yet."),
    "## Boundary",
    [
      "- This report is an observation/proposal record.",
      "- Keep this report in Backlog while it is only a proposal.",
      "- Moving this report to To Do is Samuel's approval to action the proposed improvement.",
      "- Do not mutate Pi, Dark Factory, skills, policy, tools, or live agent behavior from this report unless Samuel approves the follow-up by moving it to To Do or by explicit instruction.",
      "- If approved, capture the applied outcome back on this ticket.",
    ].join("\n"),
  ];

  return sections.join("\n\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const api = process.env.PAPERCLIP_API_BASE || DEFAULT_API;
  const labels = await request(api, `/companies/${COMPANY_ID}/labels`);
  const labelIds = labelNames(args).map((name) => {
    const label = labels.find((item) => item.name === name);
    if (!label) throw new Error(`Missing board label: ${name}`);
    return label.id;
  });

  const source = requireArg(args, "source");
  const payload = {
    title: args.title?.trim() || `Improvement report for ${source}`,
    description: buildDescription(args),
    status: args.status || "backlog",
    priority: args.priority || "medium",
    projectId: IMPROVEMENT_PROJECT_ID,
    assigneeAgentId: REPORTER_AGENT_ID,
    labelIds,
  };

  if (args["dry-run"] === "true") {
    console.log(JSON.stringify({ dryRun: true, payload }, null, 2));
    return;
  }

  const issue = await request(api, `/companies/${COMPANY_ID}/issues`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const claudeReview = maybeRunClaudeBacklogReview(issue, args);

  const url = `http://127.0.0.1:3101/OPE/issues/${issue.identifier}`;
  console.log(JSON.stringify({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    url,
    claudeReview,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
