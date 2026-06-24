#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
  fsyncSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendLedgerEvent, readManifest as readLedgerManifest, verifyLedger } from "../paperclip-board/ledger-lib.mjs";
import {
  assertCleanWorktree,
  cleanWorktreeFailure,
  collectSingleWorktreeHealth,
  compactWorktreeHealth,
} from "./worktree-health.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(__dirname, "../..");
const DEFAULT_RUN_ROOT = process.env.DARK_FACTORY_RUN_DIR
  ? resolve(process.env.DARK_FACTORY_RUN_DIR)
  : resolve(WORKSPACE_ROOT, "tools/paperclip-data/factory-runs");
const DEFAULT_NO_MISTAKES_ROOT = process.env.DARK_FACTORY_NM_DIR
  ? resolve(process.env.DARK_FACTORY_NM_DIR)
  : "/tmp/df-nm";
const NO_MISTAKES_STABILIZE_LIMIT = 3;
const DEFAULT_PAPERCLIP_API_BASE = process.env.PAPERCLIP_API_BASE || "http://127.0.0.1:3101/api";
const DEFAULT_PAPERCLIP_ORIGIN = process.env.PAPERCLIP_ORIGIN || "http://127.0.0.1:3101";
const DEFAULT_PAPERCLIP_TIMEOUT_MS = Number(process.env.PAPERCLIP_AUDIT_TIMEOUT_MS || 5000);
const DEFAULT_PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || null;
const DEFAULT_HANDOFF_WATCHDOG_MINUTES = Number(process.env.DARK_FACTORY_HANDOFF_WATCHDOG_MINUTES || 15);
const DEFAULT_STALE_ACTIVE_MINUTES = Number(process.env.DARK_FACTORY_STALE_ACTIVE_MINUTES || 24 * 60);

const STAGES = [
  "Planning",
  "To Do",
  "In Progress",
  "Verification",
  "Security Review",
  "No Mistakes Gate",
  "Ship to PR",
  "Human Final Review",
  "Done",
];

const REQUIRED_WORKORDER_FIELDS = [
  "schemaVersion",
  "workOrderId",
  "title",
  "brief",
  "repo",
  "changeType",
  "allowedWriteScope",
  "acceptanceContract",
  "coordination",
  "gates",
  "loop",
];

const REQUIRED_COORDINATION_FIELDS = [
  "agentEndpoints",
  "messageTopology",
  "authorityDistribution",
  "syncMode",
  "aggregation",
  "termination",
  "failureHandling",
  "informationPolicy",
  "computeAccounting",
];

const CHANGE_TYPES = new Set(["code", "api", "ui", "fullstack", "test", "docs", "config", "process"]);
const WORKORDER_GATE_KEYS = new Set(["tests", "securityReview", "browserQa", "noMistakes", "evidence", "pr", "paperclipEvidence"]);
const ROUTE_KINDS = new Set(["main_app_stage", "legal_dev_app", "website", "core_policy", "ambiguous_stage", "other"]);
const ROUTE_DIFFICULTIES = new Set(["D0", "D1", "D2", "D3", "D4", "D5"]);
const ROUTE_MODES = new Set(["mode0", "mode1", "mode2", "mode3", "mode4"]);
const ROUTE_LANES = new Set(["planning", "research", "implementation", "verification", "browser_qa", "security", "no_mistakes", "pr", "self_improvement", "foreman"]);
const MAIN_APP_STAGE_REPO_URLS = new Set([
  "https://github.com/aila-quillio/quillio-backend",
  "https://github.com/aila-quillio/quillio-frontend",
]);
const MANDATORY_GATE_CHANGE_TYPES = new Set(["code", "api", "fullstack"]);
const MANDATORY_GATE_KEYS = ["tests", "securityReview", "noMistakes", "evidence"];
const BROWSER_REQUIRED_PROOF_EVIDENCE_KINDS = new Set(["screenshot"]);
const BROWSER_REPORT_EVIDENCE_KINDS = new Set(["browser_qa", "browser_smoke"]);
const IMPROVER_EVIDENCE_KIND = "improver_review";
const FILE_EVIDENCE_KINDS = new Set(["screenshot", "video", "browser_qa", "browser_smoke", "visual_qa", "webwright", IMPROVER_EVIDENCE_KIND]);
const PLAN_ADVERSARIAL_REVIEW_KIND = "plan_adversarial_review";
const PLAN_ADVERSARIAL_REVIEW_REQUIRED_CHANGE_TYPES = new Set(["code", "api", "ui", "fullstack", "test", "docs", "config"]);
const IMPLEMENTATION_START_STAGE = "In Progress";
const LOOP_KINDS = new Set([
  "primary",
  "intake_clarification",
  PLAN_ADVERSARIAL_REVIEW_KIND,
  "implementation_fix_test",
  "browser_webwright_user_flow",
  "review_security_no_mistakes_repair",
  "pr_review_watcher",
  "post_merge_telemetry",
  "regression_scenario_memory",
  "factory_meta_improvement",
  "loop_health_economics",
  "maintenance",
  "custom",
]);
const RECORDABLE_GATES = new Set([
  "plan",
  "build",
  "verify",
  "qa",
  "security",
  "tests",
  "oracle_baseline",
  "oracle_holdout",
  "security_review",
  "browser_qa",
  "no_mistakes",
  "evidence",
  "model_review",
  "judge_review",
  "push",
  "pr",
  "self_improvement",
]);
const IMPROVER_GATE = "self_improvement";
const STAGE_TOKEN_ORDER = ["PLAN", "BUILD", "VERIFY", "QA", "SECURITY", "NO_MISTAKES", "PR"];
const STAGE_TOKEN_REQUIREMENTS = new Map([
  ["In Progress", ["PLAN"]],
  ["Verification", ["PLAN", "BUILD"]],
  ["Security Review", ["PLAN", "BUILD", "VERIFY"]],
  ["No Mistakes Gate", ["PLAN", "BUILD", "VERIFY", "SECURITY"]],
  ["Ship to PR", ["PLAN", "BUILD", "VERIFY", "SECURITY", "NO_MISTAKES"]],
  ["Human Final Review", ["PLAN", "BUILD", "VERIFY", "SECURITY", "NO_MISTAKES", "PR"]],
  ["Done", ["PLAN", "BUILD", "VERIFY", "SECURITY", "NO_MISTAKES", "PR"]],
]);
const STAGE_TOKEN_GATE = new Map([
  ["PLAN", "plan"],
  ["BUILD", "build"],
  ["VERIFY", "verify"],
  ["QA", "qa"],
  ["SECURITY", "security"],
  ["NO_MISTAKES", "no_mistakes"],
  ["PR", "pr"],
]);
const IMPROVER_VERDICTS = new Set([
  "noop",
  "lesson_recorded",
  "skill_request",
  "policy_request",
  "monitoring_needed",
  "not_applicable",
]);

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
    if (!next || next.startsWith("--")) {
      out[key] = "true";
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function usage() {
  return [
    "Usage:",
    "  foreman.mjs validate --workorder workorder.json",
    "  foreman.mjs start --workorder workorder.json",
    "  foreman.mjs start-from-paperclip --issue-json issue.json --workorder-out workorder.json [--start true] [--repo-url URL] [--working-dir PATH]",
    "  foreman.mjs handoff-watchdog --issue-json issue.json [--runs-dir DIR] [--max-age-minutes 15] [--apply true]",
    "  foreman.mjs status --run RUN_DIR",
    "  foreman.mjs advance --run RUN_DIR --stage \"Verification\" --summary \"...\"",
    "  foreman.mjs evidence --run RUN_DIR --kind test --path path --summary \"...\"",
    "  foreman.mjs reproduction --run RUN_DIR --path path --summary \"pre-fix bug reproduced\"",
    "  foreman.mjs stage-token --run RUN_DIR --token PLAN --verdict PASS --summary \"...\"",
    "  foreman.mjs browser-qa --run RUN_DIR --report report.md --screenshot shot.png --summary \"...\" [--video flow.mp4] [--smoke true]",
    "  foreman.mjs evidence-check --run RUN_DIR",
    "  foreman.mjs paperclip-audit --run RUN_DIR [--mode ship_to_pr|done]",
    "  foreman.mjs run-tests --run RUN_DIR --suite visible|holdout --phase pre|post [--command-json '[\"npm\",\"test\"]'] [--expect pass|fail]",
    "  foreman.mjs record-gate --run RUN_DIR --gate tests --verdict PASS --summary \"...\" [--details-json '{...}']",
    "  foreman.mjs record-gate --run RUN_DIR --gate self_improvement --verdict PASS --summary \"improver review complete\" --details-json '{\"improverVerdict\":\"noop\",\"owner\":\"self-improvement-lead\",\"sourceCoverage\":[\"ledger\"],\"missingCoverage\":\"none\"}' --path reports/improver-noop-review.md",
    "  foreman.mjs review-gate --run RUN_DIR --type model_review --reviewer codex --verdict PASS --summary \"...\" [--model MODEL] [--path review.md]",
    "  foreman.mjs claude-judge --run RUN_DIR [--prompt-file prompt.md] [--model claude-opus-4-8]",
    "  foreman.mjs left-aside --run RUN_DIR --summary \"...\" [--details \"...\"]",
    "  foreman.mjs quarantine --run RUN_DIR [--max-active-minutes 1440] [--apply true] [--clear true]",
    "  foreman.mjs worktree-check --run RUN_DIR",
    "  foreman.mjs no-mistakes --run RUN_DIR",
    "  foreman.mjs ready --run RUN_DIR [--include-pr]",
    "  foreman.mjs push --run RUN_DIR --remote origin --branch branch",
    "  foreman.mjs pr --run RUN_DIR --title \"...\" --body \"...\" [--base stage] [--head branch] [--reviewers a,b]",
    "  foreman.mjs pr-status --run RUN_DIR [--url PR_URL]",
    "  foreman.mjs loop-summary --run RUN_DIR",
    "  foreman.mjs iterate --run RUN_DIR [--loop loop-id] --verdict FAIL --summary \"...\" [--feedback \"...\"]",
  ].join("\n");
}

function requireArg(args, key) {
  const value = args[key]?.trim();
  if (!value) throw new Error(`Missing --${key}\n\n${usage()}`);
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireRunMutationLock(runDir, { timeoutMs = 15_000, staleMs = 120_000 } = {}) {
  const lockDir = resolve(runDir, ".foreman-mutation.lock");
  const started = Date.now();
  while (true) {
    try {
      mkdirSync(lockDir);
      writeFileSync(resolve(lockDir, "owner.json"), JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }, null, 2));
      return () => {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // Best effort cleanup; stale locks are removed on the next acquire.
        }
      };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        const ageMs = Date.now() - statSync(lockDir).mtimeMs;
        if (ageMs > staleMs) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for Foreman mutation lock: ${lockDir}`);
      }
      sleepMs(25);
    }
  }
}

function withRunMutationLock(runDir, fn) {
  const release = acquireRunMutationLock(runDir);
  try {
    return fn();
  } finally {
    release();
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function sanitize(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function nowStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}

function noMistakesHomeForRun(runId) {
  return resolve(DEFAULT_NO_MISTAKES_ROOT, sanitize(runId));
}

function effectiveNoMistakesHome(manifest) {
  const existing = manifest.paths?.noMistakesHome || "";
  const runId = manifest.runId || sanitize(existing || "run");
  const preferred = noMistakesHomeForRun(runId);
  if (!existing || existing.length > 90 || !existing.startsWith(DEFAULT_NO_MISTAKES_ROOT)) {
    return preferred;
  }
  return existing;
}

function runDirFromArg(run) {
  if (!run) throw new Error("Missing --run");
  if (isAbsolute(run)) return run;
  const direct = resolve(run);
  if (existsSync(resolve(direct, "run-manifest.json"))) return direct;
  return resolve(DEFAULT_RUN_ROOT, run);
}

function readRun(run) {
  const runDir = runDirFromArg(run);
  const manifestPath = resolve(runDir, "run-manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`Missing run manifest: ${manifestPath}`);
  const manifest = readJson(manifestPath);
  const workOrder = readJson(manifest.paths.workOrder);
  return { runDir, manifestPath, manifest, workOrder };
}

function gitHead(cwd) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function repoCwd(workOrder) {
  return workOrder.repo.workingDir ? resolve(workOrder.repo.workingDir) : process.cwd();
}

function gitRoot(cwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.trim() ? resolve(result.stdout.trim()) : null;
}

function normalizeRepoUrl(url) {
  return String(url || "").trim().replace(/\.git$/i, "").replace(/\/+$/, "");
}

function repoUrlIsGithubOrg(url, org) {
  const normalized = normalizeRepoUrl(url).toLowerCase();
  return normalized === `https://github.com/${org}` || normalized.startsWith(`https://github.com/${org}/`);
}

function stableSet(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))].sort();
}

function sameStringSet(a, b) {
  const left = stableSet(a);
  const right = stableSet(b);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function boolFrom(value) {
  return value === true || value === "true" || value === "1" || value === 1 || value === "yes";
}

function routeText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function issueText(issue) {
  return [
    issue?.identifier,
    issue?.title,
    issue?.description,
    issue?.body,
    ...(Array.isArray(issue?.labels) ? issue.labels.map((label) => label.name || label) : []),
  ].map(routeText).join("\n");
}

function worktreeHealthForRun(workOrder) {
  return collectSingleWorktreeHealth(repoCwd(workOrder), { maxFiles: 25 });
}

function dateMs(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function ageMinutesSince(value, nowMs = Date.now()) {
  const ms = dateMs(value);
  if (!ms) return null;
  return Math.max(0, (nowMs - ms) / 60000);
}

function terminalIssueStatus(status) {
  return new Set(["done", "cancelled"]).has(String(status || "").toLowerCase());
}

function terminalRunStatus(status) {
  return new Set(["done", "failed", "shipped"]).has(String(status || "").toLowerCase());
}

function issueClaimedAt(issue) {
  return issue?.executionLockedAt || issue?.startedAt || issue?.updatedAt || issue?.createdAt || null;
}

function issueHasFactoryClaim(issue) {
  if (!issue || terminalIssueStatus(issue.status)) return false;
  return Boolean(
    ["todo", "in_progress", "in_review", "blocked"].includes(String(issue.status || "").toLowerCase())
    || issue.assigneeAgentId
    || issue.checkoutRunId
    || issue.executionRunId
    || issue.executionLockedAt
    || issue.startedAt
  );
}

function safeReadRunEntry(runDir) {
  const manifestPath = resolve(runDir, "run-manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = readJson(manifestPath);
    const workOrder = manifest.paths?.workOrder && existsSync(manifest.paths.workOrder)
      ? readJson(manifest.paths.workOrder)
      : null;
    return { runDir, manifestPath, manifest, workOrder };
  } catch {
    return null;
  }
}

function runEntries(runsDir = DEFAULT_RUN_ROOT) {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .map((name) => safeReadRunEntry(resolve(runsDir, name)))
    .filter(Boolean);
}

function issueRunKeys(issue) {
  return new Set([
    issue?.id,
    issue?.identifier,
    issue?.issue,
  ].map((value) => String(value || "").trim()).filter(Boolean));
}

function runMatchesIssue(entry, issue) {
  const keys = issueRunKeys(issue);
  if (keys.size === 0) return false;
  const values = [
    entry.manifest?.issue,
    entry.manifest?.workOrderId,
    entry.workOrder?.issue,
    entry.workOrder?.issueId,
    entry.workOrder?.workOrderId,
    entry.workOrder?.paperclip?.issueId,
    entry.workOrder?.paperclip?.issueIdentifier,
  ].map((value) => String(value || "").trim()).filter(Boolean);
  return values.some((value) => keys.has(value));
}

function canonicalRunsForIssue(issue, runsDir = DEFAULT_RUN_ROOT) {
  return runEntries(runsDir)
    .filter((entry) => runMatchesIssue(entry, issue))
    .filter((entry) => (
      entry.manifest?.schemaVersion === 1
      && entry.workOrder?.schemaVersion === 1
      && entry.workOrder?.taskRoute
      && existsSync(entry.manifest.paths?.workOrder || "")
    ))
    .map((entry) => ({
      runId: entry.manifest.runId,
      runDir: entry.runDir,
      status: entry.manifest.status || null,
      currentStage: entry.manifest.currentStage || null,
      createdAt: entry.manifest.createdAt || null,
      updatedAt: entry.manifest.updatedAt || null,
      workOrderId: entry.manifest.workOrderId || entry.workOrder.workOrderId || null,
    }));
}

function sharedWorktreeRefs(manifest, workOrder, runsDir = DEFAULT_RUN_ROOT) {
  const root = gitRoot(repoCwd(workOrder));
  if (!root) return [];
  return runEntries(runsDir)
    .filter((entry) => entry.manifest?.runId !== manifest.runId)
    .filter((entry) => !terminalRunStatus(entry.manifest?.status))
    .filter((entry) => {
      const otherCwd = entry.workOrder?.repo?.workingDir || entry.manifest?.repo?.workingDir;
      return otherCwd && gitRoot(resolve(otherCwd)) === root;
    })
    .map((entry) => ({
      runId: entry.manifest.runId,
      issue: entry.manifest.issue || entry.workOrder?.issue || null,
      status: entry.manifest.status || null,
      currentStage: entry.manifest.currentStage || null,
      runDir: entry.runDir,
    }));
}

function gitDiffHash(cwd, baseRef) {
  const primaryArgs = baseRef ? ["diff", "--binary", `${baseRef}...HEAD`] : ["diff", "--binary", "HEAD"];
  let result = spawnSync("git", primaryArgs, { cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  let commandArgs = primaryArgs;
  if (result.status !== 0 && baseRef) {
    commandArgs = ["diff", "--binary", "HEAD"];
    result = spawnSync("git", commandArgs, { cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  }
  if (result.status !== 0) {
    return {
      hash: null,
      commandArgs,
      error: result.stderr || result.stdout || `git diff exited ${result.status}`,
    };
  }
  return {
    hash: sha256(result.stdout || ""),
    commandArgs,
    error: null,
  };
}

function gitChangedFiles(cwd, baseRef) {
  const primaryArgs = baseRef ? ["diff", "--name-only", `${baseRef}...HEAD`] : ["diff", "--name-only", "HEAD"];
  let result = spawnSync("git", primaryArgs, { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  let commandArgs = primaryArgs;
  if (result.status !== 0 && baseRef) {
    commandArgs = ["diff", "--name-only", "HEAD"];
    result = spawnSync("git", commandArgs, { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  }
  if (result.status !== 0) {
    return {
      files: null,
      commandArgs,
      error: result.stderr || result.stdout || `git diff exited ${result.status}`,
    };
  }
  return {
    files: (result.stdout || "").split("\n").map((line) => line.trim()).filter(Boolean).sort(),
    commandArgs,
    error: null,
  };
}

function normalizeRepoPath(path) {
  return String(path || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern) {
  const normalized = normalizeRepoPath(pattern);
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function matchesPathPattern(file, pattern) {
  const normalizedFile = normalizeRepoPath(file);
  const normalizedPattern = normalizeRepoPath(pattern);
  if (!normalizedPattern) return false;
  if (!/[*?]/.test(normalizedPattern)) {
    return normalizedFile === normalizedPattern || normalizedFile.startsWith(`${normalizedPattern.replace(/\/+$/, "")}/`);
  }
  return globToRegExp(normalizedPattern).test(normalizedFile);
}

function matchesAnyPathPattern(file, patterns) {
  return (patterns || []).some((pattern) => matchesPathPattern(file, pattern));
}

function testContractRequired(workOrder) {
  return Boolean(
    workOrder.testExpectation?.required === true
    || workOrder.testContract?.required === true
    || workOrder.testContractRequired === true
  );
}

function testContractFromRun(runDir, manifest, workOrder) {
  if (manifest.paths?.testContract && existsSync(manifest.paths.testContract)) {
    return readJson(manifest.paths.testContract);
  }
  if (workOrder.testContract) return workOrder.testContract;
  const legacyPath = resolve(runDir, "test-contract.json");
  return existsSync(legacyPath) ? readJson(legacyPath) : null;
}

function testContractHash(contract) {
  return contract ? sha256(stableStringify(contract)) : null;
}

function suiteEntries(contract, suite) {
  const entries = contract?.suites?.[suite];
  return Array.isArray(entries) ? entries : [];
}

function hasHoldoutSuite(contract) {
  return suiteEntries(contract, "holdout").length > 0;
}

function commandFromTestEntry(entry) {
  if (Array.isArray(entry)) return entry;
  if (Array.isArray(entry?.command)) return entry.command;
  return null;
}

function testContractProtectedPaths(workOrder, contract) {
  return [
    ...(Array.isArray(workOrder.protectedPaths) ? workOrder.protectedPaths : []),
    ...(Array.isArray(contract?.protectedPaths) ? contract.protectedPaths : []),
  ];
}

function prepareNoMistakesHome(nmHome) {
  mkdirSync(nmHome, { recursive: true });
  const sourceConfig = resolve(process.env.HOME || "", ".no-mistakes/config.yaml");
  if (existsSync(sourceConfig)) {
    copyFileSync(sourceConfig, resolve(nmHome, "config.yaml"));
  }
}

function noMistakesSupportsRun(bin, cwd) {
  const result = spawnSync(bin, ["run", "--help"], { cwd, encoding: "utf8" });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status === 0) return true;
  return !/\bunknown command\b|\bunrecognized command\b|\binvalid command\b|No such command/i.test(output);
}

function noMistakesCommandArgs({ args, bin, cwd, base }) {
  if (args.command) {
    return String(args.command).split(/\s+/).filter(Boolean);
  }
  if (args["command-json"]) {
    const parsed = JSON.parse(args["command-json"]);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("--command-json must be a JSON array of strings");
    }
    return parsed;
  }
  return noMistakesSupportsRun(bin, cwd)
    ? ["run", "--base", base]
    : ["--base", base];
}

function saveRun(runDir, manifest) {
  writeJsonAtomic(resolve(runDir, "run-manifest.json"), manifest);
}

function validateWorkOrder(workOrder) {
  const errors = [];
  for (const field of REQUIRED_WORKORDER_FIELDS) {
    if (workOrder[field] === undefined || workOrder[field] === null) errors.push(`missing ${field}`);
  }
  if (workOrder.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!/^[A-Za-z0-9._-]+$/.test(workOrder.workOrderId || "")) {
    errors.push("workOrderId must use letters, numbers, dot, underscore, or dash only");
  }
  if (!workOrder.repo?.name) errors.push("missing repo.name");
  if (!workOrder.repo?.url) errors.push("missing repo.url");
  if (!workOrder.repo?.baseBranch) errors.push("missing repo.baseBranch");
  if (!CHANGE_TYPES.has(workOrder.changeType)) errors.push(`invalid changeType: ${workOrder.changeType}`);
  if (!Array.isArray(workOrder.allowedWriteScope) || workOrder.allowedWriteScope.length === 0) {
    errors.push("allowedWriteScope must name at least one path");
  }
  if (workOrder.protectedPaths !== undefined && !Array.isArray(workOrder.protectedPaths)) {
    errors.push("protectedPaths must be an array when present");
  }
  for (const key of Object.keys(workOrder.gates || {})) {
    if (!WORKORDER_GATE_KEYS.has(key)) errors.push(`unknown gates.${key}`);
  }
  for (const [key, value] of Object.entries(workOrder.gates || {})) {
    if (typeof value !== "boolean") errors.push(`gates.${key} must be boolean`);
  }
  if (workOrder.acceptanceContract?.frozen !== true) {
    errors.push("acceptanceContract.frozen must be true before work starts");
  }
  const intent = workOrder.acceptanceContract?.intentConfirmation;
  if (!intent) {
    errors.push("missing acceptanceContract.intentConfirmation");
  } else if (intent.required === true && intent.status !== "confirmed") {
    errors.push("intent confirmation is required and must be confirmed before work starts");
  }
  if (!Array.isArray(workOrder.acceptanceContract?.criteria) || workOrder.acceptanceContract.criteria.length === 0) {
    errors.push("acceptanceContract.criteria must contain at least one criterion");
  }
  if (browserEvidenceRequired(workOrder)) {
    if (workOrder.gates?.browserQa !== true) {
      errors.push("UI/fullstack/browser work must set gates.browserQa=true");
    }
    if (Array.isArray(workOrder.evidenceRequirements)) {
      const hasBrowserReport = [...BROWSER_REPORT_EVIDENCE_KINDS]
        .some((kind) => workOrder.evidenceRequirements.includes(kind));
      if (!hasBrowserReport) {
        errors.push("browser evidence work must include evidenceRequirements item: browser_qa or browser_smoke");
      }
      for (const kind of BROWSER_REQUIRED_PROOF_EVIDENCE_KINDS) {
        if (!workOrder.evidenceRequirements.includes(kind)) {
          errors.push(`browser evidence work must include evidenceRequirements item: ${kind}`);
        }
      }
      if (workOrder.changeType === "fullstack" && !workOrder.evidenceRequirements.includes("video")) {
        errors.push("fullstack browser-flow work must include evidenceRequirements item: video");
      }
    }
  }
  for (const field of REQUIRED_COORDINATION_FIELDS) {
    if (!workOrder.coordination?.[field]) errors.push(`missing coordination.${field}`);
  }
  validateLoopContract(workOrder.loop, "loop", errors, { requireId: false });
  if (workOrder.loops !== undefined) {
    if (!Array.isArray(workOrder.loops)) {
      errors.push("loops must be an array when present");
    } else {
      const ids = new Set();
      for (const [index, loop] of workOrder.loops.entries()) {
        validateLoopContract(loop, `loops[${index}]`, errors, { requireId: true });
        if (loop?.id) {
          if (ids.has(loop.id)) errors.push(`duplicate loop id: ${loop.id}`);
          ids.add(loop.id);
        }
      }
    }
  }
  validateTaskRouteContract(workOrder, errors);
  validateMandatoryGates(workOrder, errors);
  validateTestContract(workOrder, errors);
  validatePlanAdversarialReviewContract(workOrder, errors);
  return { ok: errors.length === 0, errors };
}

function validateTaskRouteContract(workOrder, errors) {
  const route = workOrder.taskRoute;
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    errors.push("missing taskRoute");
    return;
  }
  if (route.schemaVersion !== 1) errors.push("taskRoute.schemaVersion must be 1");
  if (!ROUTE_KINDS.has(route.kind)) {
    errors.push(`taskRoute.kind must be one of: ${[...ROUTE_KINDS].join(", ")}`);
  }
  if (route.kind === "ambiguous_stage") {
    errors.push("taskRoute.kind=ambiguous_stage must be resolved before Foreman can start work");
  }
  for (const field of ["source", "decision", "repoUrl", "baseBranch", "difficulty", "mode", "changeType"]) {
    if (!String(route[field] || "").trim()) errors.push(`missing taskRoute.${field}`);
  }
  if (!ROUTE_DIFFICULTIES.has(route.difficulty)) {
    errors.push(`taskRoute.difficulty must be one of: ${[...ROUTE_DIFFICULTIES].join(", ")}`);
  }
  if (!ROUTE_MODES.has(route.mode)) {
    errors.push(`taskRoute.mode must be one of: ${[...ROUTE_MODES].join(", ")}`);
  }
  if (route.changeType && route.changeType !== workOrder.changeType) {
    errors.push("taskRoute.changeType must match changeType");
  }
  for (const field of ["prBacked", "browserQa", "userFlow", "userVisible"]) {
    if (typeof route[field] !== "boolean") errors.push(`taskRoute.${field} must be boolean`);
  }
  if (!Array.isArray(route.requiredLanes) || route.requiredLanes.length === 0) {
    errors.push("taskRoute.requiredLanes must name at least one lane");
  } else {
    for (const lane of route.requiredLanes) {
      if (!ROUTE_LANES.has(lane)) errors.push(`taskRoute.requiredLanes includes unknown lane: ${lane}`);
    }
  }
  if (!Array.isArray(route.evidenceRequirements) || route.evidenceRequirements.length === 0) {
    errors.push("taskRoute.evidenceRequirements must name at least one evidence kind");
  } else if (Array.isArray(workOrder.evidenceRequirements) && !sameStringSet(route.evidenceRequirements, workOrder.evidenceRequirements)) {
    errors.push("taskRoute.evidenceRequirements must match evidenceRequirements");
  }

  const routeRepoUrl = normalizeRepoUrl(route.repoUrl);
  const workOrderRepoUrl = normalizeRepoUrl(workOrder.repo?.url);
  if (routeRepoUrl && workOrderRepoUrl && routeRepoUrl !== workOrderRepoUrl) {
    errors.push("taskRoute.repoUrl must match repo.url");
  }
  if (route.baseBranch && workOrder.repo?.baseBranch && route.baseBranch !== workOrder.repo.baseBranch) {
    errors.push("taskRoute.baseBranch must match repo.baseBranch");
  }
  if (route.branch && workOrder.repo?.branch && route.branch !== workOrder.repo.branch) {
    errors.push("taskRoute.branch must match repo.branch");
  }
  if (route.localPath && workOrder.repo?.workingDir && resolve(route.localPath) !== resolve(workOrder.repo.workingDir)) {
    errors.push("taskRoute.localPath must match repo.workingDir");
  }

  if (route.kind === "main_app_stage") {
    if (workOrder.repo?.baseBranch !== "stage") {
      errors.push("main_app_stage work must target repo.baseBranch=stage");
    }
    if (!MAIN_APP_STAGE_REPO_URLS.has(workOrderRepoUrl)) {
      errors.push(`main_app_stage work must use one of: ${[...MAIN_APP_STAGE_REPO_URLS].join(", ")}`);
    }
  }

  if (
    workOrder.repo?.baseBranch === "stage"
    && repoUrlIsGithubOrg(workOrder.repo?.url, "aila-code")
    && route.kind !== "legal_dev_app"
  ) {
    errors.push("stage work on github.com/aila-code must be explicitly routed as legal_dev_app; main app stage uses github.com/aila-quillio/quillio-backend or quillio-frontend");
  }
  if (route.prBacked === true && workOrder.gates?.pr !== true) {
    errors.push("taskRoute.prBacked=true requires gates.pr=true");
  }
  if (route.browserQa === true && workOrder.gates?.browserQa !== true) {
    errors.push("taskRoute.browserQa=true requires gates.browserQa=true");
  }
}

function browserSmokeRequired(workOrder) {
  return Boolean(
    workOrder.taskRoute?.prBacked === true
    && workOrder.taskRoute?.userVisible === true
    && ["api", "code", "fullstack"].includes(workOrder.changeType)
  );
}

function mandatoryGateKeys(workOrder) {
  const gates = new Set();
  if (MANDATORY_GATE_CHANGE_TYPES.has(workOrder.changeType)) {
    for (const key of MANDATORY_GATE_KEYS) gates.add(key);
  }
  if (
    workOrder.changeType === "ui"
    || workOrder.changeType === "fullstack"
    || workOrder.taskRoute?.browserQa === true
    || browserSmokeRequired(workOrder)
  ) {
    gates.add("browserQa");
  }
  if (workOrder.taskRoute?.prBacked === true) gates.add("pr");
  return gates;
}

function validateMandatoryGates(workOrder, errors) {
  for (const gate of mandatoryGateKeys(workOrder)) {
    if (workOrder.gates?.[gate] !== true) {
      errors.push(`changeType=${workOrder.changeType} requires gates.${gate}=true`);
    }
  }
}

function validateTestContract(workOrder, errors) {
  const required = testContractRequired(workOrder);
  const contract = workOrder.testContract;
  if (workOrder.testExpectation !== undefined && typeof workOrder.testExpectation !== "object") {
    errors.push("testExpectation must be an object when present");
  }
  if (workOrder.testExpectation?.required === true && workOrder.gates?.tests !== true) {
    errors.push("testExpectation.required=true requires gates.tests=true");
  }
  if (!required && !contract) return;
  if (!contract || typeof contract !== "object") {
    errors.push("testContract is required before implementation can start");
    return;
  }
  if (contract.frozen !== true) {
    errors.push("testContract.frozen must be true before implementation can start");
  }
  if (contract.suites === undefined || typeof contract.suites !== "object") {
    errors.push("testContract.suites must define at least one suite");
    return;
  }
  const visible = suiteEntries(contract, "visible");
  const holdout = suiteEntries(contract, "holdout");
  if (visible.length === 0 && holdout.length === 0) {
    errors.push("testContract.suites must include visible or holdout entries");
  }
  for (const suite of ["visible", "holdout"]) {
    for (const [index, entry] of suiteEntries(contract, suite).entries()) {
      const command = commandFromTestEntry(entry);
      if (!command || command.length === 0 || command.some((part) => typeof part !== "string" || !part.trim())) {
        errors.push(`testContract.suites.${suite}[${index}] must provide a non-empty command array`);
      }
    }
  }
  if (contract.protectedPaths !== undefined && !Array.isArray(contract.protectedPaths)) {
    errors.push("testContract.protectedPaths must be an array when present");
  }
}

function validateLoopContract(loop, prefix, errors, { requireId }) {
  if (!loop || typeof loop !== "object") {
    errors.push(`missing ${prefix}`);
    return;
  }
  if (requireId && !/^[A-Za-z0-9._-]+$/.test(loop.id || "")) {
    errors.push(`${prefix}.id must use letters, numbers, dot, underscore, or dash only`);
  }
  if (loop.kind !== undefined && !LOOP_KINDS.has(loop.kind)) {
    errors.push(`${prefix}.kind must be one of: ${[...LOOP_KINDS].join(", ")}`);
  }
  if (!Number.isInteger(loop.maxIterations) || loop.maxIterations < 1) {
    errors.push(`${prefix}.maxIterations must be a positive integer`);
  }
  if (!loop.judge) errors.push(`missing ${prefix}.judge`);
  if (loop.escalateOnExhaustion !== true) {
    errors.push(`${prefix}.escalateOnExhaustion must be true`);
  }
  for (const field of ["owner", "trigger", "memory", "exitCondition", "escalation"]) {
    if (loop[field] !== undefined && typeof loop[field] !== "string") {
      errors.push(`${prefix}.${field} must be a string when present`);
    }
  }
  if (loop.evidence !== undefined && !Array.isArray(loop.evidence)) {
    errors.push(`${prefix}.evidence must be an array when present`);
  }
}

function planAdversarialReviewRequired(workOrder) {
  return PLAN_ADVERSARIAL_REVIEW_REQUIRED_CHANGE_TYPES.has(workOrder.changeType);
}

function loopContractText(loop) {
  return [
    loop?.owner,
    loop?.trigger,
    loop?.judge,
    loop?.memory,
    loop?.exitCondition,
    loop?.escalation,
    ...(Array.isArray(loop?.evidence) ? loop.evidence : []),
  ].filter(Boolean).join(" ").toLowerCase();
}

function validatePlanAdversarialReviewContract(workOrder, errors) {
  if (!planAdversarialReviewRequired(workOrder)) return;
  const planLoops = Array.isArray(workOrder.loops)
    ? workOrder.loops.filter((loop) => loop?.kind === PLAN_ADVERSARIAL_REVIEW_KIND)
    : [];
  if (planLoops.length !== 1) {
    errors.push("implementation WorkOrders must include exactly one loops[] item with kind=plan_adversarial_review");
    return;
  }

  const [loop] = planLoops;
  if (loop.maxIterations !== 1) {
    errors.push("plan_adversarial_review loop must set maxIterations=1 so the planning team is challenged exactly once");
  }

  const text = loopContractText(loop);
  const missing = [
    ["planning team", /\bplanning team\b/],
    ["once", /\bonce\b/],
    ["missed", /\bmiss(?:ed|ing)\b/],
    ["errors", /\berrors?\b/],
    ["conflicts", /\bconflicts?\b/],
    ["response", /\bresponse\b/],
    ["lack of response", /\black of response\b|\bno response\b/],
    ["record", /\brecord(?:ed)?\b/],
  ].filter(([, pattern]) => !pattern.test(text)).map(([name]) => name);

  if (missing.length > 0) {
    errors.push(`plan_adversarial_review loop must explicitly require the one planning-team challenge and recorded response/lack of response; missing: ${missing.join(", ")}`);
  }
}

function loopStateFromContract(contract, id = "main") {
  return {
    id,
    kind: contract.kind || (id === "main" ? "primary" : "custom"),
    owner: contract.owner || null,
    trigger: contract.trigger || null,
    judge: contract.judge,
    memory: contract.memory || null,
    evidence: Array.isArray(contract.evidence) ? contract.evidence : [],
    exitCondition: contract.exitCondition || "judge passes, loop exhausts, or blocker requires escalation",
    escalation: contract.escalation || null,
    currentIteration: 0,
    maxIterations: contract.maxIterations,
    timeBudgetMinutes: contract.timeBudgetMinutes || null,
    exhausted: false,
    status: "active",
    lastVerdict: null,
    updatedAt: null,
  };
}

function additionalLoopStates(workOrder) {
  return (workOrder.loops || []).map((loop) => loopStateFromContract(loop, loop.id));
}

function planAdversarialReviewLoops(manifest) {
  return [manifest.loop, ...(manifest.loops || [])].filter((loop) => loop?.kind === PLAN_ADVERSARIAL_REVIEW_KIND);
}

function planAdversarialReviewFailures(manifest, workOrder) {
  if (!planAdversarialReviewRequired(workOrder)) return [];
  const loops = planAdversarialReviewLoops(manifest);
  if (loops.length !== 1) {
    return [{
      kind: "loop",
      loopId: "plan-adversarial-review",
      reason: "expected exactly one plan_adversarial_review loop before implementation",
    }];
  }
  const [loop] = loops;
  const loopId = loop.id || "plan-adversarial-review";
  const failures = [];
  if (loop.maxIterations !== 1) {
    failures.push({
      kind: "loop",
      loopId,
      reason: "plan_adversarial_review loop must have maxIterations=1",
    });
  }
  if (loop.currentIteration !== 1 || loop.status !== "passed" || loop.lastVerdict !== "PASS") {
    failures.push({
      kind: "loop",
      loopId,
      reason: "plan_adversarial_review must be recorded as PASS exactly once before implementation proceeds",
    });
  }
  return failures;
}

function assertPlanAdversarialReviewBeforeStage(manifest, workOrder, stage) {
  const targetIndex = STAGES.indexOf(stage);
  const implementationIndex = STAGES.indexOf(IMPLEMENTATION_START_STAGE);
  if (targetIndex === -1 || implementationIndex === -1 || targetIndex < implementationIndex) return;
  const failures = planAdversarialReviewFailures(manifest, workOrder);
  if (failures.length === 0) return;
  throw new Error([
    `Cannot advance to ${stage} before the one-shot adversarial plan challenge is recorded.`,
    ...failures.map((failure) => `- ${failure.loopId}: ${failure.reason}`),
    "Record it with `foreman iterate --loop plan-adversarial-review --verdict PASS --summary \"planning challenge recorded\" --feedback \"...\"` after asking the planning team whether anything was missed, whether there are errors, and whether there are conflicts in the plan.",
  ].join("\n"));
}

function assertTestContractBeforeStage(runDir, manifest, workOrder, stage) {
  const targetIndex = STAGES.indexOf(stage);
  const implementationIndex = STAGES.indexOf(IMPLEMENTATION_START_STAGE);
  if (targetIndex === -1 || implementationIndex === -1 || targetIndex < implementationIndex) return;
  if (!testContractRequired(workOrder)) return;
  const contract = testContractFromRun(runDir, manifest, workOrder);
  if (!contract || contract.frozen !== true) {
    throw new Error("Cannot advance to implementation before a frozen TestContract is attached to the Foreman run.");
  }
  const currentHash = testContractHash(contract);
  if (!manifest.testContractHash || currentHash !== manifest.testContractHash) {
    throw new Error("Cannot advance to implementation because the TestContract hash is missing or no longer matches the frozen manifest.");
  }
}

function assertSelfImprovementBeforeStage(runDir, manifest, workOrder, stage) {
  const targetIndex = STAGES.indexOf(stage);
  const shipIndex = STAGES.indexOf("Ship to PR");
  if (targetIndex === -1 || shipIndex === -1 || targetIndex < shipIndex) return;

  const gate = manifest.gates?.[IMPROVER_GATE];
  if (!gate) {
    throw new Error(`Cannot advance to ${stage} before mandatory self-improvement review/gate is PASS.`);
  }
  if (gate.verdict !== "PASS") {
    throw new Error(`Cannot advance to ${stage} before mandatory self-improvement review/gate is PASS (current verdict is ${gate.verdict}).`);
  }

  const packPath = manifest.paths?.evidencePack;
  let pack = { items: [] };
  if (packPath && existsSync(packPath)) {
    try {
      pack = readJson(packPath);
    } catch {
      throw new Error("Cannot advance to stage because evidence pack could not be parsed.");
    }
  }

  const failures = selfImprovementFailures(manifest, workOrder, pack);
  if (failures.length > 0) {
    throw new Error([
      `Cannot advance to ${stage} due to self-improvement failures:`,
      ...failures.map((f) => `- ${f.reason}`),
    ].join("\n"));
  }
}

function defaultEvidenceRequirements(workOrder) {
  if (Array.isArray(workOrder.evidenceRequirements) && workOrder.evidenceRequirements.length > 0) {
    return workOrder.evidenceRequirements;
  }
  if (browserSmokeRequired(workOrder)) {
    return ["test", "browser_smoke", "screenshot"];
  }
  switch (workOrder.changeType) {
    case "ui":
      return ["test", "browser_qa", "screenshot"];
    case "fullstack":
      return ["test", "api", "browser_qa", "screenshot", "video"];
    case "api":
      return ["test", "api"];
    case "code":
    case "test":
    case "config":
      return ["test"];
    case "docs":
    case "process":
      return ["review"];
    default:
      return ["test"];
  }
}

function requiredEvidenceRequirements(workOrder) {
  const requirements = new Set(defaultEvidenceRequirements(workOrder));
  requirements.add(IMPROVER_EVIDENCE_KIND);
  return [...requirements];
}

function browserEvidenceRequired(workOrder) {
  const requirements = new Set(Array.isArray(workOrder.evidenceRequirements) ? workOrder.evidenceRequirements : []);
  return Boolean(
    workOrder.gates?.browserQa === true
    || workOrder.taskRoute?.browserQa === true
    || workOrder.taskRoute?.userFlow === true
    || browserSmokeRequired(workOrder)
    || workOrder.changeType === "ui"
    || workOrder.changeType === "fullstack"
    || requirements.has("browser_qa")
    || requirements.has("browser_smoke")
    || requirements.has("screenshot")
    || requirements.has("video")
  );
}

function browserVideoRequired(workOrder) {
  const requirements = new Set(Array.isArray(workOrder.evidenceRequirements) ? workOrder.evidenceRequirements : []);
  return Boolean(
    workOrder.changeType === "fullstack"
    || workOrder.taskRoute?.userFlow === true
    || requirements.has("video")
  );
}

function requiredGates(workOrder, options = {}) {
  const mandatory = mandatoryGateKeys(workOrder);
  const gates = [];
  if (workOrder.gates?.tests || mandatory.has("tests")) gates.push("tests");
  if (testContractRequired(workOrder)) {
    if (workOrder.testExpectation?.baselineMustFail !== false) gates.push("oracle_baseline");
    if (hasHoldoutSuite(workOrder.testContract)) gates.push("oracle_holdout");
  }
  if (workOrder.gates?.securityReview || mandatory.has("securityReview")) gates.push("security_review");
  if (workOrder.gates?.browserQa || mandatory.has("browserQa") || browserEvidenceRequired(workOrder)) gates.push("browser_qa");
  if (workOrder.gates?.evidence !== false || mandatory.has("evidence")) gates.push("evidence");
  if (workOrder.gates?.noMistakes !== false || mandatory.has("noMistakes")) gates.push("no_mistakes");
  gates.push(IMPROVER_GATE);
  if (options.includePr && (workOrder.gates?.pr || mandatory.has("pr"))) gates.push("pr");
  return [...new Set(gates)];
}

function evidenceItemHasUsableArtifact(item) {
  if (!item) return false;
  if (item.url) return true;
  if (!item.path) return false;
  return existsSync(item.path);
}

function evidenceFailures(pack, required) {
  const present = new Set((pack.items || []).map((item) => item.kind));
  const failures = [];
  for (const kind of required) {
    if (!present.has(kind)) {
      failures.push({ kind: "evidence", evidenceKind: kind, reason: "missing evidence item" });
      continue;
    }
    if (FILE_EVIDENCE_KINDS.has(kind)) {
      const usable = (pack.items || []).some((item) => item.kind === kind && evidenceItemHasUsableArtifact(item));
      if (!usable) {
        failures.push({
          kind: "evidence",
          evidenceKind: kind,
          reason: "evidence item has no usable local file path or URL",
        });
      }
    }
  }
  return failures;
}

function browserEvidenceFailures(manifest, workOrder, pack) {
  if (!browserEvidenceRequired(workOrder)) return [];
  const failures = [];
  const gate = manifest.gates?.browser_qa;
  if (!gate) {
    failures.push({ kind: "gate", gate: "browser_qa", reason: "missing browser QA gate for UI/browser work" });
  } else if (gate.verdict !== "PASS") {
    failures.push({ kind: "gate", gate: "browser_qa", reason: `browser QA gate verdict is ${gate.verdict}` });
  } else if (gate.path && existsSync(gate.path)) {
    const gateResult = readJson(gate.path);
    const waiver = gateResult.details?.waiver || null;
    if (waiver?.owner && waiver?.reason) return failures;
  }
  const browserReport = (pack.items || []).find((item) => BROWSER_REPORT_EVIDENCE_KINDS.has(item.kind) && evidenceItemHasUsableArtifact(item));
  if (!browserReport) {
    failures.push({
      kind: "browser_evidence",
      evidenceKind: "browser_qa",
      reason: "missing usable Browser QA or browser smoke report artifact",
    });
  }
  const screenshot = (pack.items || []).find((item) => item.kind === "screenshot" && evidenceItemHasUsableArtifact(item));
  if (!screenshot) {
    failures.push({
      kind: "browser_evidence",
      evidenceKind: "screenshot",
      reason: "missing screenshot artifact proving the tested browser state",
    });
  }
  return failures;
}

function paperclipEvidenceAuditRequired(workOrder) {
  if (workOrder.gates?.paperclipEvidence === false || workOrder.paperclipEvidence === false) return false;
  if (workOrder.gates?.paperclipEvidence === true || workOrder.paperclipEvidence === true || workOrder.paperclip) return true;
  return /^OPE-\d+\b/i.test(String(workOrder.issue || workOrder.workOrderId || ""));
}

function paperclipDecisionFailure(reason, details = {}) {
  return {
    kind: "paperclip_evidence",
    reason,
    decisionNeeded: true,
    escalation: "Return visibly to Samuel/OpenClaw and add a Paperclip decision_needed comment; Foreman stays read-only and will not silently unblock this run.",
    ...details,
  };
}

function paperclipConfig(workOrder) {
  const issueKey = workOrder.issue || workOrder.workOrderId;
  const ledger = issueKey ? readLedgerManifest(issueKey) : null;
  const paperclip = workOrder.paperclip || {};
  return {
    enabled: paperclipEvidenceAuditRequired(workOrder),
    apiBase: String(paperclip.apiBase || workOrder.paperclipApiBase || DEFAULT_PAPERCLIP_API_BASE).replace(/\/$/, ""),
    origin: String(paperclip.origin || workOrder.paperclipOrigin || DEFAULT_PAPERCLIP_ORIGIN).replace(/\/$/, ""),
    companyId: paperclip.companyId || workOrder.paperclipCompanyId || DEFAULT_PAPERCLIP_COMPANY_ID || null,
    issueId: paperclip.issueId || workOrder.paperclipIssueId || workOrder.issueId || ledger?.issueId || null,
    issueIdentifier: paperclip.issueIdentifier || workOrder.issue || workOrder.workOrderId || null,
    issueUrl: paperclip.issueUrl || workOrder.paperclipIssueUrl || ledger?.issueUrl || null,
    timeoutMs: Number(paperclip.timeoutMs || workOrder.paperclipTimeoutMs || DEFAULT_PAPERCLIP_TIMEOUT_MS),
  };
}

function paperclipUrl(apiBase, path, params = {}) {
  const url = new URL(path.replace(/^\//, ""), `${apiBase}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function paperclipGetJsonSync(config, path, params = {}) {
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_PAPERCLIP_TIMEOUT_MS;
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const url = paperclipUrl(config.apiBase, path, params);
  const result = spawnSync("curl", ["-fsS", "--max-time", String(timeoutSeconds), "--connect-timeout", String(timeoutSeconds), url], {
    encoding: "utf8",
    timeout: timeoutMs + 1000,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      url,
      status: result.status,
      error: result.error?.message || result.stderr || result.stdout || "Paperclip API request failed",
    };
  }
  try {
    return { ok: true, url, json: JSON.parse(result.stdout || "null") };
  } catch (err) {
    return { ok: false, url, status: result.status, error: `Paperclip API returned invalid JSON: ${err.message}` };
  }
}

function paperclipSendJsonSync(config, path, { method = "PATCH", body = {} } = {}) {
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_PAPERCLIP_TIMEOUT_MS;
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const url = paperclipUrl(config.apiBase || DEFAULT_PAPERCLIP_API_BASE, path);
  const result = spawnSync("curl", [
    "-fsS",
    "--max-time",
    String(timeoutSeconds),
    "--connect-timeout",
    String(timeoutSeconds),
    "-X",
    method,
    "-H",
    "content-type: application/json",
    "--data-binary",
    JSON.stringify(body),
    url,
  ], {
    encoding: "utf8",
    timeout: timeoutMs + 1000,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      url,
      status: result.status,
      error: result.error?.message || result.stderr || result.stdout || "Paperclip API write failed",
    };
  }
  try {
    return { ok: true, url, json: result.stdout ? JSON.parse(result.stdout) : null };
  } catch (err) {
    return { ok: false, url, status: result.status, error: `Paperclip API returned invalid JSON: ${err.message}` };
  }
}

function handoffWatchdogReport(issue, args = {}) {
  const runsDir = resolve(args["runs-dir"] || DEFAULT_RUN_ROOT);
  const maxAgeMinutes = Number(args["max-age-minutes"] || DEFAULT_HANDOFF_WATCHDOG_MINUTES);
  const nowMs = dateMs(args.now) || Date.now();
  const claimed = issueHasFactoryClaim(issue);
  const claimedAt = issueClaimedAt(issue);
  const ageMinutes = ageMinutesSince(claimedAt, nowMs);
  const canonicalRuns = canonicalRunsForIssue(issue, runsDir);
  const overdue = Boolean(
    claimed
    && canonicalRuns.length === 0
    && ageMinutes !== null
    && ageMinutes >= maxAgeMinutes
  );
  const issueLabel = issue?.identifier || issue?.id || "unknown issue";
  const comment = [
    `decision_needed: Dark Factory handoff watchdog found no canonical Foreman run for ${issueLabel}.`,
    `Claim age: ${ageMinutes === null ? "unknown" : `${ageMinutes.toFixed(1)} minutes`}; threshold: ${maxAgeMinutes} minutes.`,
    "Next action: pi-orchestrator must create a canonical Foreman WorkOrder/run or explicitly park the card with owner/action evidence.",
  ].join("\n");
  return {
    ok: !overdue,
    status: overdue ? "decision_needed" : (canonicalRuns.length > 0 ? "covered" : (claimed ? "watching" : "not_claimed")),
    runsDir,
    maxAgeMinutes,
    issue: {
      id: issue?.id || null,
      identifier: issue?.identifier || null,
      status: issue?.status || null,
      claimedAt,
      ageMinutes,
    },
    canonicalRuns,
    action: overdue
      ? {
        paperclip: issue?.id
          ? { method: "PATCH", path: `/issues/${issue.id}`, body: { status: "blocked", comment } }
          : null,
        orchestratorPage: {
          target: "pi-orchestrator",
          event: "handoff_watchdog_missing_foreman_run",
          issue: issueLabel,
          summary: comment,
        },
      }
      : null,
  };
}

function applyHandoffWatchdogAction(report, args = {}) {
  if (!report.action?.paperclip) return null;
  const apiBase = String(args["api-base"] || DEFAULT_PAPERCLIP_API_BASE).replace(/\/$/, "");
  const timeoutMs = Number(args["timeout-ms"] || DEFAULT_PAPERCLIP_TIMEOUT_MS);
  const paperclip = report.action.paperclip;
  return paperclipSendJsonSync({ apiBase, timeoutMs }, paperclip.path, {
    method: paperclip.method,
    body: paperclip.body,
  });
}

function resolvePaperclipIssue(config) {
  if (config.issueId) return { ok: true, issue: { id: config.issueId, identifier: config.issueIdentifier, url: config.issueUrl } };
  if (!config.companyId) {
    return {
      ok: false,
      failures: [paperclipDecisionFailure("missing Paperclip issue id and PAPERCLIP_COMPANY_ID/companyId for issue lookup", {
        code: "paperclip_issue_lookup_missing_config",
        issueIdentifier: config.issueIdentifier,
      })],
    };
  }
  const response = paperclipGetJsonSync(config, `/companies/${encodeURIComponent(config.companyId)}/issues`, { limit: 1000 });
  if (!response.ok) {
    return {
      ok: false,
      failures: [paperclipDecisionFailure("could not query Paperclip issues for evidence audit", {
        code: "paperclip_issue_lookup_failed",
        issueIdentifier: config.issueIdentifier,
        apiUrl: response.url,
        apiError: response.error,
      })],
    };
  }
  const issues = Array.isArray(response.json) ? response.json : [];
  const matches = issues.filter((issue) => String(issue.identifier || "").toUpperCase() === String(config.issueIdentifier || "").toUpperCase());
  if (matches.length !== 1) {
    return {
      ok: false,
      failures: [paperclipDecisionFailure(matches.length === 0 ? "Paperclip issue identifier not found" : "Paperclip issue identifier matched multiple issues", {
        code: matches.length === 0 ? "paperclip_issue_not_found" : "paperclip_issue_ambiguous",
        issueIdentifier: config.issueIdentifier,
        matchCount: matches.length,
      })],
    };
  }
  return { ok: true, issue: matches[0] };
}

function normalizedText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.toLowerCase();
  try {
    return stableStringify(value).toLowerCase();
  } catch {
    return String(value).toLowerCase();
  }
}

function commentText(comment) {
  return [comment.body, comment.metadata, comment.presentation]
    .map(normalizedText)
    .filter(Boolean)
    .join("\n");
}

function commentHasRole(comment, roles) {
  const body = String(comment.body || "").toLowerCase();
  const structured = [comment.metadata, comment.presentation].map(normalizedText).join("\n");
  return roles.some((role) => {
    const token = String(role).toLowerCase();
    return structured.includes(token)
      || body.startsWith(`[${token}]`)
      || body.includes(`role: ${token}`)
      || body.includes(`role=${token}`);
  });
}

function commentHasEvent(comment, events) {
  const text = commentText(comment);
  return events.some((event) => {
    const token = String(event).toLowerCase();
    return text.includes(token) || text.includes(token.replace(/_/g, " "));
  });
}

function commentMatchesSpec(comment, spec) {
  const body = String(comment.body || "");
  const roleMatch = commentHasRole(comment, spec.roles || []);
  const eventMatch = commentHasEvent(comment, spec.events || []);
  const patternMatch = (spec.patterns || []).some((pattern) => pattern.test(body));
  return eventMatch || (roleMatch && patternMatch) || (spec.allowPatternOnly === true && patternMatch);
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

function paperclipRequiredCommentSpecs(workOrder, options = {}) {
  const specs = [];
  if (workOrder.gates?.evidence !== false) {
    specs.push({
      id: "implementation_evidence",
      label: "implementation/evidence Paperclip comment",
      roles: ["implementation-lead", "codex-builder", "builder", "implementer"],
      events: ["implementation_complete", "implementation_evidence", "evidence_recorded", "gate_result:evidence"],
      patterns: [/implementation[^\n]*(complete|pass|done)/i, /evidence[^\n]*(recorded|pass|complete)/i],
    });
  }
  if (workOrder.gates?.tests) {
    specs.push({
      id: "verification",
      label: "verification/tests Paperclip comment",
      roles: ["verification-lead", "test-engineer", "tester"],
      events: ["verification_pass", "tests_passed", "gate_result:tests"],
      patterns: [/(verification|tests?)[^\n]*(pass|passed|verified)/i],
    });
  }
  if (workOrder.gates?.securityReview) {
    specs.push({
      id: "security_review",
      label: "security review Paperclip comment",
      roles: ["security-lead", "security-reviewer"],
      events: ["security_pass", "security_review", "gate_result:security_review"],
      patterns: [/security[^\n]*(pass|passed|review)/i],
    });
  }
  if (browserEvidenceRequired(workOrder)) {
    specs.push({
      id: "browser_qa",
      label: "browser QA Paperclip comment",
      roles: ["browser-qa-lead", "visual-qa", "webwright", "qa"],
      events: ["browser_qa_pass", "visual_qa_pass", "gate_result:browser_qa"],
      patterns: [/(browser|visual|screenshot|video)[^\n]*(pass|passed|qa|verified)/i],
    });
  }
  if (workOrder.gates?.noMistakes !== false) {
    specs.push({
      id: "no_mistakes",
      label: "No Mistakes Paperclip comment",
      roles: ["no-mistakes", "review-lead", "foreman"],
      events: ["no_mistakes_pass", "gate_result:no_mistakes"],
      patterns: [/no[ -]?mistakes[^\n]*(pass|passed)/i],
    });
  }
  specs.push({
    id: "self_improvement",
    label: "self-improvement/improver Paperclip comment or no-op",
    roles: ["self-improvement-lead", "improver", "pi-orchestrator"],
    events: ["improvement_review", "improvement_noop", "improvement_not_applicable", "gate_result:self_improvement"],
    patterns: [/(self[- ]?improvement|improver|improvement)[^\n]*(review|noop|no-op|not applicable|complete|pass|passed)/i],
  });
  if (options.mode === "done" || options.includePr === true) {
    specs.push({
      id: "pr_status",
      label: "PR status Paperclip comment",
      roles: ["pr-review-watcher", "foreman", "verification-lead"],
      events: ["pr_status", "pr_created", "pr_review_status"],
      patterns: [/pr[^\n]*(status|created|ready|approved|merge)/i],
    });
    specs.push({
      id: "final_disposition",
      label: "final disposition Paperclip comment",
      roles: ["pi-orchestrator", "foreman", "self-improvement-lead"],
      events: ["final_disposition", "done", "closed"],
      patterns: [/(final disposition|done|closed|completed)/i],
    });
  }
  return specs;
}

function requiredPaperclipAttachments(workOrder) {
  if (!browserEvidenceRequired(workOrder)) return [];
  const requirements = new Set(Array.isArray(workOrder.evidenceRequirements) ? workOrder.evidenceRequirements : []);
  if (workOrder.changeType === "fullstack" || requirements.has("video")) {
    return [{ id: "video", label: "Paperclip video attachment", matcher: attachmentIsVideo }];
  }
  return [{ id: "image_or_video", label: "Paperclip screenshot/image/video attachment", matcher: (attachment) => attachmentIsImage(attachment) || attachmentIsVideo(attachment) }];
}

function paperclipEvidenceAudit(manifest, workOrder, options = {}) {
  const config = paperclipConfig(workOrder);
  const requiredComments = paperclipRequiredCommentSpecs(workOrder, options);
  const requiredAttachments = requiredPaperclipAttachments(workOrder);
  const cleanComments = requiredComments.map((spec) => ({ id: spec.id, label: spec.label, roles: spec.roles, events: spec.events }));
  const cleanAttachments = requiredAttachments.map((requirement) => ({ id: requirement.id, label: requirement.label }));
  if (!config.enabled) {
    return { ok: true, skipped: true, reason: "Paperclip evidence audit is not required for this work order", requiredComments: cleanComments, requiredAttachments: cleanAttachments, failures: [] };
  }
  const resolved = resolvePaperclipIssue(config);
  if (!resolved.ok) {
    return { ok: false, skipped: false, config: { ...config, apiBase: config.apiBase, origin: config.origin }, requiredComments: cleanComments, requiredAttachments: cleanAttachments, failures: resolved.failures };
  }
  const commentsResponse = paperclipGetJsonSync(config, `/issues/${encodeURIComponent(resolved.issue.id)}/comments`);
  const attachmentsResponse = paperclipGetJsonSync(config, `/issues/${encodeURIComponent(resolved.issue.id)}/attachments`);
  const failures = [];
  if (!commentsResponse.ok) {
    failures.push(paperclipDecisionFailure("could not read Paperclip comments for evidence audit", {
      code: "paperclip_comments_fetch_failed",
      apiUrl: commentsResponse.url,
      apiError: commentsResponse.error,
    }));
  }
  if (!attachmentsResponse.ok) {
    failures.push(paperclipDecisionFailure("could not read Paperclip attachments for evidence audit", {
      code: "paperclip_attachments_fetch_failed",
      apiUrl: attachmentsResponse.url,
      apiError: attachmentsResponse.error,
    }));
  }
  const comments = Array.isArray(commentsResponse.json) ? commentsResponse.json : [];
  const attachments = Array.isArray(attachmentsResponse.json) ? attachmentsResponse.json : [];
  for (const spec of requiredComments) {
    const matches = comments.filter((comment) => commentMatchesSpec(comment, spec));
    if (matches.length === 0) {
      failures.push({
        kind: "paperclip_evidence",
        evidenceKind: spec.id,
        reason: `missing ${spec.label}`,
        required: {
          roles: spec.roles,
          events: spec.events,
        },
      });
    }
  }
  for (const requirement of requiredAttachments) {
    const matches = attachments.filter((attachment) => requirement.matcher(attachment));
    if (matches.length === 0) {
      failures.push({
        kind: "paperclip_evidence",
        evidenceKind: requirement.id,
        reason: `missing ${requirement.label}; local run-folder evidence is supporting evidence only`,
      });
    }
  }
  return {
    ok: failures.length === 0,
    skipped: false,
    mode: options.mode || "ship_to_pr",
    issue: {
      id: resolved.issue.id,
      identifier: resolved.issue.identifier || config.issueIdentifier,
      url: config.issueUrl,
    },
    requiredComments: cleanComments,
    requiredAttachments: cleanAttachments,
    counts: {
      comments: comments.length,
      attachments: attachments.length,
      imageAttachments: attachments.filter(attachmentIsImage).length,
      videoAttachments: attachments.filter(attachmentIsVideo).length,
    },
    failures,
  };
}

function paperclipEvidenceFailures(manifest, workOrder, options = {}) {
  return paperclipEvidenceAudit(manifest, workOrder, options).failures || [];
}

function improverVerdictFromDetails(details = {}) {
  return details.improverVerdict || details.improvementVerdict || details.outcome || details.verdict || null;
}

function hasNonEmptyValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return String(value || "").trim().length > 0;
}

function validateSelfImprovementDetails(details = {}) {
  const failures = [];
  const improverVerdict = improverVerdictFromDetails(details);
  if (!IMPROVER_VERDICTS.has(improverVerdict)) {
    failures.push({
      kind: "self_improvement",
      gate: IMPROVER_GATE,
      reason: `self-improvement PASS must include details.improverVerdict/outcome/verdict one of: ${[...IMPROVER_VERDICTS].join(", ")}`,
      improverVerdict,
    });
  }
  const owner = details.owner || details.reviewer || details.improver || details.actor || details.notApplicableOwner || details.notApplicable?.owner;
  if (!hasNonEmptyValue(owner)) {
    failures.push({
      kind: "self_improvement",
      gate: IMPROVER_GATE,
      reason: "self-improvement details must name the accountable owner/reviewer",
    });
  }
  const sourceCoverage = details.sourceCoverage ?? details.sourceRefs ?? details.sources;
  if (!hasNonEmptyValue(sourceCoverage)) {
    failures.push({
      kind: "self_improvement",
      gate: IMPROVER_GATE,
      reason: "self-improvement details must describe non-empty sourceCoverage/sourceRefs/sources inspected",
    });
  }
  if (!hasNonEmptyValue(details.missingCoverage)) {
    failures.push({
      kind: "self_improvement",
      gate: IMPROVER_GATE,
      reason: "self-improvement details must explicitly state missingCoverage (use 'none' only when true)",
    });
  }
  if (improverVerdict === "not_applicable") {
    const reason = details.notApplicableReason || details.reason || details.notApplicable?.reason;
    if (!hasNonEmptyValue(reason) || !hasNonEmptyValue(owner)) {
      failures.push({
        kind: "self_improvement",
        gate: IMPROVER_GATE,
        reason: "self-improvement not_applicable requires an explicit owner and reason",
      });
    }
  }
  return failures;
}

function selfImprovementFailures(manifest, workOrder, pack) {
  const failures = [];
  const gate = manifest.gates?.[IMPROVER_GATE];
  if (!gate) return failures;
  if (!gate.path || !existsSync(gate.path)) {
    failures.push({ kind: "gate", gate: IMPROVER_GATE, reason: "self-improvement gate result artifact is missing" });
    return failures;
  }
  const gateResult = readJson(gate.path);
  if (gateResult.verdict === "PASS") {
    failures.push(...validateSelfImprovementDetails(gateResult.details || {}));
  }
  const report = (pack.items || []).find((item) => item.kind === IMPROVER_EVIDENCE_KIND && evidenceItemHasUsableArtifact(item));
  if (!report) {
    failures.push({
      kind: "self_improvement",
      gate: IMPROVER_GATE,
      evidenceKind: IMPROVER_EVIDENCE_KIND,
      reason: "missing usable improver review/no-op report evidence artifact",
    });
  }
  return failures;
}

function defaultReviewersForRepo(repo = {}) {
  const key = `${repo.url || ""} ${repo.name || ""}`.toLowerCase();
  if (key.includes("aila-code/backend-legal") || key.includes("aila-code/frontend-legal")) {
    return ["sabahatijaz", "MuhammadHassan92", "zawster"];
  }
  if (
    key.includes("aila-quillio/quillio-backend")
    || key.includes("aila-quillio/quillio-frontend")
    || key.includes("aila-code/aila-website")
  ) {
    return ["wdetcetera"];
  }
  return [];
}

function reviewerList(raw, repo) {
  if (raw === "none") return [];
  if (raw) {
    return raw.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return defaultReviewersForRepo(repo);
}

function normalizeReviewer(value) {
  return String(value || "").trim().toLowerCase();
}

function checkIsPassing(check) {
  const status = String(check.status || "").toUpperCase();
  const conclusion = String(check.conclusion || "").toUpperCase();
  if (check.conclusion === null || check.conclusion === undefined) {
    return ["SUCCESS", "PASSED"].includes(status);
  }
  return status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion);
}

function noMistakesHeadFromManifest(manifest) {
  const gatePath = manifest.gates?.no_mistakes?.path;
  if (!gatePath || !existsSync(gatePath)) return null;
  const gate = readJson(gatePath);
  return gate.details?.headAfter || gate.details?.head || null;
}

function mergeEligibility({ body, checks, reviewRequests, manifest, workOrder }) {
  const blockers = [];
  const headRefOid = body.headRefOid || null;
  const expectedReviewers = reviewerList(null, workOrder.repo);
  const pendingReviewers = new Set(reviewRequests.map(normalizeReviewer));
  const pendingExpectedReviewers = expectedReviewers.filter((reviewer) => pendingReviewers.has(normalizeReviewer(reviewer)));
  const latestReviews = body.latestReviews || [];
  const changeRequestReviews = latestReviews.filter((review) => String(review.state || "").toUpperCase() === "CHANGES_REQUESTED");
  const incompleteChecks = checks.filter((check) => !checkIsPassing(check));
  const noMistakesHead = noMistakesHeadFromManifest(manifest);

  if (incompleteChecks.length > 0) {
    blockers.push({
      kind: "checks",
      reason: "one or more GitHub checks are not passing",
      checks: incompleteChecks,
    });
  }
  if (pendingExpectedReviewers.length > 0) {
    blockers.push({
      kind: "review_requests",
      reason: "routed reviewer requests are still pending",
      reviewers: pendingExpectedReviewers,
    });
  }
  if (changeRequestReviews.length > 0) {
    blockers.push({
      kind: "reviews",
      reason: "one or more latest reviews requested changes",
      reviewers: changeRequestReviews.map((review) => review.author?.login || "unknown"),
    });
  }
  if (!noMistakesHead) {
    blockers.push({
      kind: "no_mistakes",
      reason: "typed Foreman No Mistakes gate is missing",
    });
  } else if (headRefOid && noMistakesHead !== headRefOid) {
    blockers.push({
      kind: "no_mistakes",
      reason: "typed Foreman No Mistakes gate is not bound to current PR head",
      prHead: headRefOid,
      noMistakesHead,
    });
  }
  if (!body.mergedAt && body.reviewDecision && body.reviewDecision !== "APPROVED") {
    blockers.push({
      kind: "review_decision",
      reason: "GitHub review decision is not approved",
      reviewDecision: body.reviewDecision,
    });
  }

  return {
    verdict: blockers.length === 0 ? "eligible" : "blocked",
    blockers,
    expectedReviewers,
    pendingExpectedReviewers,
    noMistakesHead,
    noMistakesMatchesPrHead: Boolean(noMistakesHead && headRefOid && noMistakesHead === headRefOid),
    mergedWithBlockers: Boolean(body.mergedAt && blockers.length > 0),
  };
}

function appendRunEvent({ manifest, workOrder, eventType, stage, summary, details, artifacts }) {
  appendLedgerEvent({
    issue: manifest.issue || workOrder.issue || workOrder.workOrderId,
    title: workOrder.title,
    eventType,
    stage: stage || manifest.currentStage,
    actor: "Dark Factory Foreman",
    actorRole: "foreman",
    summary,
    details: {
      runId: manifest.runId,
      workOrderId: manifest.workOrderId,
      ...(details || {}),
    },
    artifacts: artifacts || [],
    visibility: "internal",
  });
}

function normalizeStageToken(token) {
  return String(token || "").trim().toUpperCase().replace(/[-\s]+/g, "_");
}

function stageTokenRequirements(workOrder, stage) {
  const tokens = [...(STAGE_TOKEN_REQUIREMENTS.get(stage) || [])];
  if (stage === "No Mistakes Gate" || stage === "Ship to PR" || stage === "Human Final Review" || stage === "Done") {
    if (browserEvidenceRequired(workOrder) && !tokens.includes("QA")) tokens.splice(Math.max(tokens.indexOf("VERIFY") + 1, 0), 0, "QA");
  }
  return tokens;
}

function stageTokenFailures(manifest, workOrder, stage) {
  const failures = [];
  for (const token of stageTokenRequirements(workOrder, stage)) {
    const key = token.toLowerCase();
    const tokenRecord = manifest.stageTokens?.[key];
    const gateName = STAGE_TOKEN_GATE.get(token);
    const gateRecord = gateName ? manifest.gates?.[gateName] : null;
    const passed = tokenRecord?.verdict === "PASS" || gateRecord?.verdict === "PASS";
    if (!passed) {
      failures.push({
        kind: "stage_token",
        token,
        stage,
        reason: `missing ${token} PASS token before advancing to ${stage}`,
      });
    }
  }
  return failures;
}

function assertStageTokensBeforeStage(manifest, workOrder, stage) {
  const failures = stageTokenFailures(manifest, workOrder, stage);
  if (failures.length === 0) return;
  throw new Error([
    `Cannot advance to ${stage} before required typed stage tokens are PASS.`,
    ...failures.map((failure) => `- ${failure.token}: ${failure.reason}`),
    "Record tokens with `foreman stage-token --run RUN_DIR --token PLAN --verdict PASS --summary \"...\"` or the corresponding typed Foreman gate command.",
  ].join("\n"));
}

function classifyChangeType(text) {
  const lower = String(text || "").toLowerCase();
  if (/\b(fullstack|end[- ]to[- ]end|frontend.*backend|backend.*frontend)\b/.test(lower)) return "fullstack";
  if (/\b(ui|frontend|browser|visual|layout|responsive|vue|nuxt|react|screen|button|modal|form)\b/.test(lower)) return "ui";
  if (/\b(api|endpoint|route|webhook|backend|server|database|db|query|auth|billing|stripe)\b/.test(lower)) return "api";
  if (/\b(test|spec|regression)\b/.test(lower)) return "test";
  if (/\b(doc|readme|documentation)\b/.test(lower)) return "docs";
  if (/\bconfig|env|yaml|json|setting\b/.test(lower)) return "config";
  if (/\bplan|audit|architecture|process|workflow|factory|foreman|paperclip\b/.test(lower)) return "process";
  return "code";
}

function classifyDifficulty(text, changeType) {
  const lower = String(text || "").toLowerCase();
  if (/\bD[0-5]\b/.test(text)) return text.match(/\bD[0-5]\b/)[0];
  if (/\barchitecture|autonomy|pipeline|security|payment|billing|multi[- ]agent|factory\b/.test(lower)) return "D4";
  if (changeType === "fullstack" || /\bcross[- ]repo|migration|privacy|auth\b/.test(lower)) return "D3";
  if (changeType === "code" || changeType === "api" || changeType === "ui") return "D2";
  return "D1";
}

function classifyMode(text, difficulty) {
  const lower = String(text || "").toLowerCase();
  const explicit = lower.match(/\bmode\s*[-:]?\s*([0-4])\b/);
  if (explicit) return `mode${explicit[1]}`;
  if (difficulty === "D0") return "mode0";
  if (difficulty === "D4" || difficulty === "D5") return "mode3";
  if (difficulty === "D3") return "mode2";
  return "mode1";
}

function routeKindForRepo(repoUrl, text) {
  const normalized = normalizeRepoUrl(repoUrl);
  const lower = String(text || "").toLowerCase();
  if (MAIN_APP_STAGE_REPO_URLS.has(normalized)) return "main_app_stage";
  if (repoUrlIsGithubOrg(normalized, "aila-code")) return "legal_dev_app";
  if (/\bwebsite\b/.test(lower)) return "website";
  if (normalized === "local" || /\bdark factory|openclaw|foreman|paperclip|factory tooling\b/.test(lower)) return "core_policy";
  return /\bstage\b/.test(lower) ? "ambiguous_stage" : "other";
}

function routeLanesFor({ changeType, browserQa, prBacked, mode }) {
  const lanes = new Set(["planning", "foreman", "self_improvement"]);
  if (mode !== "mode0") lanes.add("implementation");
  if (["code", "api", "ui", "fullstack", "test", "config"].includes(changeType)) lanes.add("verification");
  if (browserQa) lanes.add("browser_qa");
  if (["code", "api", "ui", "fullstack", "config"].includes(changeType)) lanes.add("security");
  if (prBacked || MANDATORY_GATE_CHANGE_TYPES.has(changeType)) {
    lanes.add("no_mistakes");
  }
  if (prBacked) {
    lanes.add("pr");
  }
  return [...lanes];
}

function evidenceRequirementsForRoute({ changeType, browserQa, userFlow, userVisible, prBacked }) {
  const requirements = new Set();
  if (["code", "api", "ui", "fullstack", "test", "config"].includes(changeType)) requirements.add("test");
  if (["code", "api", "ui", "fullstack", "config"].includes(changeType)) requirements.add("security_review");
  if (browserQa) {
    requirements.add(userVisible && prBacked && ["api", "code"].includes(changeType) ? "browser_smoke" : "browser_qa");
    requirements.add("screenshot");
  }
  if (userFlow || changeType === "fullstack") requirements.add("video");
  if (requirements.size === 0) requirements.add("review");
  return [...requirements];
}

function defaultCoordination() {
  return {
    agentEndpoints: ["pi-orchestrator", "implementation-lead", "verification-lead", "security-lead"],
    messageTopology: "Foreman-mediated handoff; Paperclip, WorkOrder, run manifest, ledger events, and gate files are the source of truth.",
    authorityDistribution: "Foreman owns WorkOrder creation, stage advancement, evidence checks, gate recording, No Mistakes, push, and PR commands.",
    syncMode: "bounded async review with typed verdict files",
    aggregation: "typed PASS/FAIL/PARTIAL/BLOCKED verdicts with evidence refs",
    termination: "stop on PASS, budget exhaustion, or BLOCKED escalation",
    failureHandling: "retry inside loop budget, then escalate without pretending success",
    informationPolicy: "builders see the frozen contract; hidden holdouts stay with the independent judge",
    computeAccounting: "record model/tool usage estimates as evidence, not billing truth",
  };
}

function planAdversarialReviewLoop() {
  return {
    id: "plan-adversarial-review",
    kind: PLAN_ADVERSARIAL_REVIEW_KIND,
    owner: "orchestra, Foreman, and planning team",
    trigger: "Immediately after the planning team returns a plan and before implementation starts, ask the planning team exactly once what was missed, what errors exist, and what conflicts exist.",
    maxIterations: 1,
    timeBudgetMinutes: 10,
    judge: "Foreman verifies the one planning-team challenge was sent once and the response or lack of response was recorded before implementation proceeds.",
    memory: "Ticket comments, Foreman loop event, run manifest, and evidence/source of truth for the planning-team response or lack of response.",
    evidence: ["plan_adversarial_review"],
    exitCondition: "The one adversarial plan challenge is recorded with the planning team response or lack of response.",
    escalation: "If the challenge finds missed work, errors, or conflicts, return to the planning team for correction before implementation proceeds.",
    escalateOnExhaustion: true,
  };
}

function classifyPaperclipIssue(issue, args = {}) {
  const text = issueText(issue);
  const changeType = args["change-type"] || classifyChangeType(text);
  const difficulty = args.difficulty || classifyDifficulty(text, changeType);
  const mode = args.mode || classifyMode(text, difficulty);
  const repoUrl = args["repo-url"] || args.repo || "local";
  const baseBranch = args["base-branch"] || "stage";
  const branch = args.branch || `dark-factory/${sanitize(issue.identifier || issue.id || "paperclip-card").toLowerCase()}`;
  const localPath = args["working-dir"] || args.cwd || null;
  const prBacked = args["pr-backed"] !== undefined
    ? boolFrom(args["pr-backed"])
    : !["mode0"].includes(mode) && changeType !== "process" && repoUrl !== "local";
  const userFlow = args["user-flow"] !== undefined
    ? boolFrom(args["user-flow"])
    : /\b(user[- ]flow|checkout|login|signup|create|edit|delete|button|form|modal)\b/i.test(text);
  const userVisible = args["user-visible"] !== undefined
    ? boolFrom(args["user-visible"])
    : userFlow || ["ui", "fullstack"].includes(changeType) || /\buser[- ]visible|customer|screen|page|browser|visual\b/i.test(text);
  const browserQa = args["browser-qa"] !== undefined
    ? boolFrom(args["browser-qa"])
    : userFlow || ["ui", "fullstack"].includes(changeType) || (prBacked && userVisible && ["api", "code"].includes(changeType));
  const requiredLanes = routeLanesFor({ changeType, browserQa, prBacked, mode });
  const evidenceRequirements = evidenceRequirementsForRoute({ changeType, browserQa, userFlow, userVisible, prBacked });
  return {
    schemaVersion: 1,
    kind: args["route-kind"] || routeKindForRepo(repoUrl, text),
    source: args.source || `Paperclip ${issue.identifier || issue.id || "issue"}`,
    decision: args.decision || "Deterministic classifier generated route contract from Paperclip issue text and explicit CLI overrides.",
    repoUrl,
    baseBranch,
    branch,
    ...(localPath ? { localPath } : {}),
    difficulty,
    mode,
    changeType,
    prBacked,
    browserQa,
    userFlow,
    userVisible,
    requiredLanes,
    evidenceRequirements,
  };
}

function workOrderFromPaperclipIssue(issue, args = {}) {
  const taskRoute = classifyPaperclipIssue(issue, args);
  if (taskRoute.mode === "mode0" && args["allow-mode0"] !== "true") {
    return { skipped: true, reason: "Mode 0 card does not require a canonical Foreman WorkOrder", taskRoute };
  }
  const title = String(issue.title || issue.identifier || issue.id || "Paperclip WorkOrder").trim();
  const criteriaStatement = String(issue.description || issue.body || title || "Complete the Paperclip task.").trim();
  const gates = {
    tests: ["code", "api", "ui", "fullstack", "test", "config"].includes(taskRoute.changeType),
    securityReview: ["code", "api", "ui", "fullstack", "config"].includes(taskRoute.changeType),
    browserQa: taskRoute.browserQa,
    noMistakes: taskRoute.prBacked || MANDATORY_GATE_CHANGE_TYPES.has(taskRoute.changeType),
    evidence: true,
    pr: taskRoute.prBacked,
    paperclipEvidence: args["paperclip-evidence"] !== undefined ? boolFrom(args["paperclip-evidence"]) : true,
  };
  const repo = {
    name: args["repo-name"] || (taskRoute.repoUrl === "local" ? "local" : taskRoute.repoUrl.split("/").pop()),
    url: taskRoute.repoUrl,
    baseBranch: taskRoute.baseBranch,
    ...(taskRoute.localPath ? { workingDir: taskRoute.localPath } : {}),
    branch: taskRoute.branch,
  };
  const workOrder = {
    schemaVersion: 1,
    workOrderId: sanitize(issue.identifier || issue.id || `paperclip-${Date.now()}`),
    issue: issue.identifier || null,
    issueId: issue.id || null,
    paperclip: {
      issueId: issue.id || null,
      issueIdentifier: issue.identifier || null,
      issueUrl: args["issue-url"] || null,
    },
    title,
    brief: criteriaStatement,
    repo,
    taskRoute,
    changeType: taskRoute.changeType,
    allowedWriteScope: args["allowed-write-scope"]
      ? String(args["allowed-write-scope"]).split(",").map((item) => item.trim()).filter(Boolean)
      : ["**"],
    acceptanceContract: {
      frozen: true,
      intentConfirmation: {
        required: false,
        status: "not_required",
      },
      criteria: [{
        id: "AC1",
        statement: criteriaStatement.split("\n").find((line) => line.trim()) || title,
        verification: "Foreman gates and Paperclip evidence satisfy the WorkOrder.",
        holdout: false,
      }],
    },
    coordination: defaultCoordination(),
    gates,
    loop: {
      kind: "primary",
      owner: "implementation-lead",
      trigger: "A required gate or acceptance check fails during the ticket run.",
      maxIterations: 3,
      timeBudgetMinutes: 90,
      judge: "independent reviewer plus Foreman readiness",
      memory: "Foreman run manifest, Paperclip ledger, evidence pack, and PR comments",
      evidence: taskRoute.evidenceRequirements,
      exitCondition: "implementation passes required gates, or loop exhausts and escalates",
      escalation: "block the ticket with exact failing command/finding and next owner",
      escalateOnExhaustion: true,
    },
    loops: planAdversarialReviewRequired({ changeType: taskRoute.changeType })
      ? [planAdversarialReviewLoop()]
      : [],
    evidenceRequirements: taskRoute.evidenceRequirements,
  };
  return { skipped: false, workOrder };
}

function readPaperclipIssueFromArgs(args) {
  if (args["issue-json"]) {
    const raw = readFileSync(resolve(args["issue-json"]), "utf8");
    return JSON.parse(raw);
  }
  if (args["issue-json-inline"]) {
    return JSON.parse(args["issue-json-inline"]);
  }
  throw new Error("start-from-paperclip requires --issue-json or --issue-json-inline in this Foreman surface.");
}

function startFromPaperclip(args) {
  const issue = readPaperclipIssueFromArgs(args);
  const generated = workOrderFromPaperclipIssue(issue, args);
  if (generated.skipped) {
    console.log(JSON.stringify(generated, null, 2));
    return;
  }
  const workOrderPath = resolve(args["workorder-out"] || resolve(DEFAULT_RUN_ROOT, "workorders", `${generated.workOrder.workOrderId}.json`));
  const validation = validateWorkOrder(generated.workOrder);
  if (!validation.ok) {
    throw new Error(`Generated WorkOrder failed validation:\n- ${validation.errors.join("\n- ")}`);
  }
  writeJsonAtomic(workOrderPath, generated.workOrder);
  if (args.start === "true") {
    return start({ ...args, workorder: workOrderPath });
  }
  console.log(JSON.stringify({ workOrderPath, validation, workOrder: generated.workOrder }, null, 2));
}

function handoffWatchdog(args) {
  const issue = readPaperclipIssueFromArgs(args);
  const report = handoffWatchdogReport(issue, args);
  let applied = null;
  if (report.action && args.apply === "true") {
    applied = applyHandoffWatchdogAction(report, args);
  }
  console.log(JSON.stringify({ ...report, applied }, null, 2));
  if (!report.ok) process.exitCode = 1;
  if (applied && !applied.ok) process.exitCode = 1;
}

function start(args) {
  const workOrderPath = resolve(requireArg(args, "workorder"));
  const workOrder = readJson(workOrderPath);
  const validation = validateWorkOrder(workOrder);
  if (!validation.ok) {
    throw new Error(`WorkOrder failed validation:\n- ${validation.errors.join("\n- ")}`);
  }

  const runId = `${sanitize(workOrder.issue || workOrder.workOrderId)}-${nowStamp()}`;
  const runDir = resolve(DEFAULT_RUN_ROOT, runId);
  const paths = {
    runDir,
    workOrder: resolve(runDir, "workorder.json"),
    manifest: resolve(runDir, "run-manifest.json"),
    testContract: resolve(runDir, "test-contract.json"),
    holdoutDir: resolve(runDir, "holdouts"),
    evidencePack: resolve(runDir, "evidence-pack.json"),
    gatesDir: resolve(runDir, "gates"),
    evidenceDir: resolve(runDir, "evidence"),
    noMistakesHome: noMistakesHomeForRun(runId),
  };
  mkdirSync(paths.gatesDir, { recursive: true });
  mkdirSync(paths.evidenceDir, { recursive: true });
  mkdirSync(paths.holdoutDir, { recursive: true });
  mkdirSync(paths.noMistakesHome, { recursive: true });

  const workOrderHash = sha256(stableStringify(workOrder));
  const contract = workOrder.testContract || null;
  const contractHash = testContractHash(contract);
  const manifest = {
    schemaVersion: 1,
    runId,
    workOrderId: workOrder.workOrderId,
    issue: workOrder.issue || null,
    status: "active",
    currentStage: "Planning",
    stages: STAGES.map((name, index) => ({ index, name })),
    paths,
    repo: workOrder.repo,
    taskRoute: workOrder.taskRoute,
    workOrderHash,
    testContractHash: contractHash,
    protectedPaths: testContractProtectedPaths(workOrder, contract),
    gates: {},
    stageTokens: {},
    loop: loopStateFromContract(workOrder.loop, "main"),
    loops: additionalLoopStates(workOrder),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  writeJsonAtomic(paths.workOrder, workOrder);
  if (contract) writeJsonAtomic(paths.testContract, contract);
  writeJsonAtomic(paths.evidencePack, { schemaVersion: 1, runId, items: [] });
  writeJsonAtomic(paths.manifest, manifest);
  appendRunEvent({
    manifest,
    workOrder,
    eventType: "foreman_run_started",
    summary: `Foreman run started for ${workOrder.title}`,
    details: { workOrderHash, runDir },
    artifacts: [{ kind: "run_manifest", path: paths.manifest, summary: "RunManifest created" }],
  });
  console.log(JSON.stringify({ runId, runDir, manifestPath: paths.manifest, workOrderHash, testContractHash: contractHash }, null, 2));
}

function validate(args) {
  const workOrder = readJson(resolve(requireArg(args, "workorder")));
  const validation = validateWorkOrder(workOrder);
  console.log(JSON.stringify(validation, null, 2));
  if (!validation.ok) process.exitCode = 1;
}

function status(args) {
  const { runDir, manifest, workOrder } = readRun(requireArg(args, "run"));
  const readiness = readinessReport(manifest, workOrder, { includePr: args["include-pr"] === "true" });
  console.log(JSON.stringify({ runDir, manifest, readiness }, null, 2));
  if (!readiness.ok) process.exitCode = 1;
}

function quarantine(args) {
  const { runDir, manifestPath, manifest, workOrder } = readRun(requireArg(args, "run"));
  const options = {
    maxActiveMinutes: args["max-active-minutes"],
    now: args.now,
  };
  const report = quarantineFailures(manifest, workOrder, options);
  const existing = activeQuarantineFailure(manifest);
  let applied = false;
  let cleared = false;
  let currentManifest = manifest;

  if (args.clear === "true") {
    withRunMutationLock(runDir, () => {
      currentManifest = readJson(manifestPath);
      if (currentManifest.quarantine?.status === "active") {
        currentManifest.quarantine = {
          ...currentManifest.quarantine,
          status: "resolved",
          resolvedAt: new Date().toISOString(),
          resolution: args.summary || "quarantine cleared by Foreman operator",
        };
        currentManifest.status = "active";
        currentManifest.updatedAt = new Date().toISOString();
        saveRun(runDir, currentManifest);
        appendRunEvent({
          manifest: currentManifest,
          workOrder,
          eventType: "run_quarantine_resolved",
          summary: currentManifest.quarantine.resolution,
          details: currentManifest.quarantine,
        });
        cleared = true;
      }
    });
  } else if (args.apply === "true" && report.failures.length > 0) {
    withRunMutationLock(runDir, () => {
      currentManifest = readJson(manifestPath);
      const createdAt = new Date().toISOString();
      currentManifest.status = "blocked";
      currentManifest.quarantine = {
        status: "active",
        reason: args.reason || report.failures.map((failure) => failure.kind).join(", "),
        createdAt,
        updatedAt: createdAt,
        owner: args.owner || "Dark Factory Foreman",
        nextAction: args["next-action"] || "Clean or split the worktree, resolve stale run ownership, then clear quarantine with Foreman.",
        failures: report.failures,
      };
      currentManifest.updatedAt = createdAt;
      saveRun(runDir, currentManifest);
      appendRunEvent({
        manifest: currentManifest,
        workOrder,
        eventType: "run_quarantined",
        stage: currentManifest.currentStage,
        summary: `Run quarantined: ${currentManifest.quarantine.reason}`,
        details: currentManifest.quarantine,
      });
      applied = true;
    });
  }

  const output = {
    ok: cleared || (report.failures.length === 0 && !existing),
    runDir,
    applied,
    cleared,
    failures: report.failures,
    existingQuarantine: existing,
    quarantine: currentManifest.quarantine || null,
    worktreeHealth: compactWorktreeHealth(report.worktreeHealth),
  };
  console.log(JSON.stringify(output, null, 2));
  if (!output.ok) process.exitCode = 1;
}

function advance(args) {
  const { runDir, manifestPath, manifest, workOrder } = readRun(requireArg(args, "run"));
  const stage = requireArg(args, "stage");
  if (!STAGES.includes(stage)) throw new Error(`Unknown stage: ${stage}`);
  withRunMutationLock(runDir, () => {
    const currentManifest = readJson(manifestPath);
    const previousStage = currentManifest.currentStage;
    assertStageTokensBeforeStage(currentManifest, workOrder, stage);
    assertPlanAdversarialReviewBeforeStage(currentManifest, workOrder, stage);
    assertTestContractBeforeStage(runDir, currentManifest, workOrder, stage);
    assertSelfImprovementBeforeStage(runDir, currentManifest, workOrder, stage);
    currentManifest.currentStage = stage;
    currentManifest.updatedAt = new Date().toISOString();
    writeJsonAtomic(manifestPath, currentManifest);
    Object.assign(manifest, currentManifest);
    appendRunEvent({
      manifest: currentManifest,
      workOrder,
      eventType: "stage_advanced",
      stage,
      summary: args.summary || `Stage advanced from ${previousStage} to ${stage}`,
      details: { previousStage, nextStage: stage },
    });
    console.log(JSON.stringify({ runDir, previousStage, currentStage: stage }, null, 2));
  });
}

function evidence(args) {
  const { runDir, manifest, workOrder } = readRun(requireArg(args, "run"));
  withRunMutationLock(runDir, () => {
    const currentManifest = readJson(resolve(runDir, "run-manifest.json"));
    const packPath = currentManifest.paths.evidencePack;
    const pack = readJson(packPath);
    const path = args.path ? resolve(args.path) : null;
    const item = {
      kind: requireArg(args, "kind"),
      path,
      url: args.url || null,
      summary: requireArg(args, "summary"),
      sha256: path && existsSync(path) && statSync(path).isFile()
        ? sha256(readFileSync(path))
        : args.sha256 || null,
      createdAt: new Date().toISOString(),
    };
    pack.items.push(item);
    writeJsonAtomic(packPath, pack);
    Object.assign(manifest, currentManifest);
    appendRunEvent({
      manifest: currentManifest,
      workOrder,
      eventType: "evidence_recorded",
      summary: `Evidence recorded: ${item.kind}`,
      details: item,
      artifacts: [{ kind: item.kind, path: item.path, url: item.url, sha256: item.sha256, summary: item.summary }],
    });
    console.log(JSON.stringify({ runDir, item }, null, 2));
  });
}

function reproduction(args) {
  args.kind = args.kind || "pre_fix_reproduction";
  evidence(args);
}

function writeGateResult(runDir, manifest, workOrder, gate, verdict, summary, details = {}, artifacts = []) {
  if (!["PASS", "FAIL", "PARTIAL", "BLOCKED"].includes(verdict)) {
    throw new Error(`Invalid gate verdict: ${verdict}`);
  }
  return withRunMutationLock(runDir, () => {
    const currentManifest = readJson(resolve(runDir, "run-manifest.json"));
    const result = {
      schemaVersion: 1,
      gate,
      verdict,
      summary,
      createdAt: new Date().toISOString(),
      details,
      artifacts,
    };
    const path = resolve(currentManifest.paths.gatesDir, `${gate}.json`);
    writeJsonAtomic(path, result);
    currentManifest.gates[gate] = { verdict, path, updatedAt: result.createdAt };
    currentManifest.updatedAt = result.createdAt;
    saveRun(runDir, currentManifest);
    Object.assign(manifest, currentManifest);
    appendRunEvent({
      manifest: currentManifest,
      workOrder,
      eventType: "gate_result",
      stage: gate === "no_mistakes" ? "No Mistakes Gate" : currentManifest.currentStage,
      summary: `${gate}: ${verdict} - ${summary}`,
      details: result,
      artifacts: [{ kind: "gate_result", path, summary: `${gate} ${verdict}` }, ...artifacts],
    });
    return { path, result };
  });
}

function recordGate(args) {
  const { runDir, manifest, workOrder } = readRun(requireArg(args, "run"));
  const gate = requireArg(args, "gate");
  if (!RECORDABLE_GATES.has(gate)) {
    throw new Error(`Unknown gate: ${gate}. Expected one of: ${[...RECORDABLE_GATES].join(", ")}`);
  }
  if (gate === "browser_qa") {
    throw new Error("Use `foreman browser-qa` to record Browser QA so report, screenshot, and video requirements cannot be bypassed.");
  }
  if (gate === "no_mistakes") {
    throw new Error("Use `foreman no-mistakes` to record the no_mistakes gate so the exact HEAD is captured.");
  }
  if (gate === "tests" || gate === "oracle_baseline" || gate === "oracle_holdout") {
    throw new Error(`Use \`foreman run-tests\` to record the ${gate} gate so the command, HEAD, diff hash, and TestContract hash are captured.`);
  }
  if (gate === "push" || gate === "pr") {
    throw new Error(`Use \`foreman ${gate}\` to record the ${gate} gate so readiness, Browser QA, No Mistakes, and evidence preflights cannot be bypassed.`);
  }
  const verdict = requireArg(args, "verdict");
  const summary = requireArg(args, "summary");
  const details = args["details-json"] ? parseJsonObject(args["details-json"]) : {};
  if (args["details-json"] && !details) {
    throw new Error("--details-json must be a JSON object");
  }
  if (gate === IMPROVER_GATE && verdict === "PASS") {
    const failures = validateSelfImprovementDetails(details);
    if (failures.length > 0) {
      throw new Error(`Cannot record self_improvement PASS without improver review/no-op details:\n${JSON.stringify(failures, null, 2)}`);
    }
    if (!args.path) {
      throw new Error("Cannot record self_improvement PASS without --path to the improver review/no-op report artifact.");
    }
  }
  if (gate === "browser_qa") {
    if (args["waiver-owner"] || args["waiver-reason"]) {
      details.waiver = {
        owner: args["waiver-owner"] || null,
        reason: args["waiver-reason"] || null,
        recordedAt: new Date().toISOString(),
      };
    }
    if (args.environment) details.environment = args.environment;
    if (args["credential-state"]) details.credentialState = args["credential-state"];
    if (verdict === "PASS") {
      const pack = readJson(manifest.paths.evidencePack);
      const failures = browserEvidenceFailures(
        { ...manifest, gates: { ...manifest.gates, browser_qa: { verdict: "PASS", path: null } } },
        workOrder,
        pack,
      ).filter((failure) => failure.kind !== "gate");
      if (failures.length > 0 && !details.waiver) {
        throw new Error(`Cannot record browser_qa PASS without screenshot-backed browser evidence:\n${JSON.stringify(failures, null, 2)}`);
      }
    }
  }
  const artifacts = args.path ? [{ kind: "gate_artifact", path: resolve(args.path), summary }] : [];
  const written = writeGateResult(runDir, manifest, workOrder, gate, verdict, summary, details, artifacts);
  if (gate === IMPROVER_GATE && verdict === "PASS") {
    const improverVerdict = improverVerdictFromDetails(details);
    appendRunEvent({
      manifest,
      workOrder,
      eventType: improverVerdict === "noop"
        ? "improvement_noop"
        : (improverVerdict === "not_applicable" ? "improvement_not_applicable" : "improvement_review"),
      stage: "Self-Improvement Review",
      summary: `Self-improvement review recorded: ${improverVerdict}`,
      details: {
        gate: IMPROVER_GATE,
        improverVerdict,
        summary,
        sourceCoverage: details.sourceCoverage || details.sourceRefs || details.sources || null,
        missingCoverage: details.missingCoverage,
        proposalIds: details.proposalIds || null,
        followups: details.followups || null,
        trustModel: details.trustModel || "Option B advisory/display-only when mirrored to Paperclip; not non-forgeable identity evidence",
      },
      artifacts,
    });
  }
  console.log(JSON.stringify({ runDir, ...written }, null, 2));
}

function stageToken(args) {
  const { runDir, manifest, workOrder } = readRun(requireArg(args, "run"));
  const token = normalizeStageToken(requireArg(args, "token"));
  if (!STAGE_TOKEN_ORDER.includes(token)) {
    throw new Error(`Unknown stage token: ${token}. Expected one of: ${STAGE_TOKEN_ORDER.join(", ")}`);
  }
  const verdict = requireArg(args, "verdict");
  if (!["PASS", "FAIL", "PARTIAL", "BLOCKED"].includes(verdict)) {
    throw new Error(`Invalid stage token verdict: ${verdict}`);
  }
  const summary = requireArg(args, "summary");
  const details = args["details-json"] ? parseJsonObject(args["details-json"]) : {};
  if (args["details-json"] && !details) {
    throw new Error("--details-json must be a JSON object");
  }
  const tokenKey = token.toLowerCase();
  withRunMutationLock(runDir, () => {
    const currentManifest = readJson(resolve(runDir, "run-manifest.json"));
    const result = {
      schemaVersion: 1,
      token,
      verdict,
      summary,
      details,
      createdAt: new Date().toISOString(),
    };
    const tokenPath = resolve(currentManifest.paths.gatesDir, `stage-token-${tokenKey}.json`);
    writeJsonAtomic(tokenPath, result);
    currentManifest.stageTokens = {
      ...(currentManifest.stageTokens || {}),
      [tokenKey]: { verdict, path: tokenPath, updatedAt: result.createdAt },
    };
    currentManifest.updatedAt = result.createdAt;
    saveRun(runDir, currentManifest);
    Object.assign(manifest, currentManifest);
    appendRunEvent({
      manifest: currentManifest,
      workOrder,
      eventType: "stage_token",
      stage: currentManifest.currentStage,
      summary: `${token}: ${verdict} - ${summary}`,
      details: result,
      artifacts: [{ kind: "stage_token", path: tokenPath, summary: `${token} ${verdict}` }],
    });
    console.log(JSON.stringify({ runDir, token, verdict, path: tokenPath }, null, 2));
  });
  if (verdict !== "PASS") process.exitCode = 1;
}

function assertFileArg(args, key, label) {
  const value = requireArg(args, key);
  const filePath = resolve(value);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(`${label} file does not exist: ${filePath}`);
  }
  return filePath;
}

function browserQa(args) {
  const { runDir, manifest, workOrder } = readRun(requireArg(args, "run"));
  const summary = requireArg(args, "summary");
  const reportPath = assertFileArg(args, "report", "Browser QA report");
  const screenshotPath = assertFileArg(args, "screenshot", "Browser QA screenshot");
  const videoPath = args.video ? resolve(args.video) : null;
  if (videoPath && (!existsSync(videoPath) || !statSync(videoPath).isFile())) {
    throw new Error(`Browser QA video file does not exist: ${videoPath}`);
  }
  if (browserVideoRequired(workOrder) && !videoPath) {
    throw new Error("Browser QA video is required for fullstack, user-flow, or video-required work.");
  }
  const smoke = boolFrom(args.smoke) || browserSmokeRequired(workOrder);
  const reportKind = smoke ? "browser_smoke" : "browser_qa";
  const artifacts = [
    { kind: reportKind, path: reportPath, summary },
    { kind: "screenshot", path: screenshotPath, summary: "Browser QA screenshot" },
    ...(videoPath ? [{ kind: "video", path: videoPath, summary: "Browser QA video" }] : []),
  ];
  withRunMutationLock(runDir, () => {
    const currentManifest = readJson(resolve(runDir, "run-manifest.json"));
    const pack = readJson(currentManifest.paths.evidencePack);
    for (const artifact of artifacts) {
      pack.items.push({
        ...artifact,
        sha256: sha256(readFileSync(artifact.path)),
        createdAt: new Date().toISOString(),
      });
    }
    writeJsonAtomic(currentManifest.paths.evidencePack, pack);
  });
  const written = writeGateResult(runDir, manifest, workOrder, "browser_qa", "PASS", summary, {
    command: "browser-qa",
    smoke,
    reportPath,
    screenshotPath,
    videoPath,
    videoRequired: browserVideoRequired(workOrder),
  }, artifacts);
  console.log(JSON.stringify({ runDir, gate: "browser_qa", ...written }, null, 2));
}

function reviewGate(args) {
  const { runDir, manifest, workOrder } = readRun(requireArg(args, "run"));
  const type = args.type || args.gate || "model_review";
  if (!["model_review", "judge_review"].includes(type)) {
    throw new Error("review-gate --type must be model_review or judge_review");
  }
  const reviewer = requireArg(args, "reviewer");
  const verdict = requireArg(args, "verdict");
  const summary = requireArg(args, "summary");
  const cwd = workOrder.repo.workingDir ? resolve(workOrder.repo.workingDir) : process.cwd();
  const reviewedHead = gitHead(cwd);
  const diffBase = args["diff-base"] || workOrder.repo.baseBranch || null;
  const diff = gitDiffHash(cwd, diffBase);
  const evidencePath = args.path ? resolve(args.path) : null;
  const gate = `${type}_${sanitize(reviewer).toLowerCase()}`;
  const details = {
    type,
    reviewer,
    model: args.model || null,
    cwd,
    reviewedHead,
    diffBase,
    reviewedDiffHash: diff.hash,
    diffCommandArgs: diff.commandArgs,
    diffError: diff.error,
    evidencePath,
  };
  const artifacts = evidencePath
    ? [{ kind: type, path: evidencePath, summary: `${reviewer} ${type}` }]
    : [];
  const written = writeGateResult(runDir, manifest, workOrder, gate, verdict, summary, details, artifacts);
  console.log(JSON.stringify({ runDir, gate, ...written }, null, 2));
  if (verdict !== "PASS") process.exitCode = 1;
}

function parseJsonObject(value) {
  try {
    return JSON.parse(value);
  } catch {
    const match = String(value || "").match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function claudeJsonFromStdout(stdout) {
  const parsed = parseJsonObject(stdout);
  if (!parsed) return null;
  if (parsed.verdict) return parsed;
  if (typeof parsed.result === "string") return parseJsonObject(parsed.result);
  if (parsed.message?.content) {
    const text = parsed.message.content
      .map((part) => part.text || "")
      .join("\n");
    return parseJsonObject(text);
  }
  return null;
}

function defaultClaudeJudgePrompt(workOrder, cwd) {
  return [
    "You are the Dark Factory Claude judge.",
    "",
    "Rules:",
    "- Do not edit files.",
    "- Inspect only the accepted task scope and evidence.",
    "- Judge whether the current diff satisfies the frozen acceptance contract.",
    "- Treat unrelated cleanup or extra work as out of scope.",
    "- Return only JSON matching the requested schema.",
    "",
    "Work order:",
    JSON.stringify({
      workOrderId: workOrder.workOrderId,
      issue: workOrder.issue || null,
      title: workOrder.title,
      brief: workOrder.brief,
      repo: workOrder.repo,
      changeType: workOrder.changeType,
      allowedWriteScope: workOrder.allowedWriteScope,
      acceptanceContract: workOrder.acceptanceContract,
      evidenceRequirements: workOrder.evidenceRequirements || null,
    }, null, 2),
    "",
    `Repository working directory: ${cwd}`,
    "",
    "Use git status and git diff against the base branch to review the change.",
  ].join("\n");
}

function claudeJudge(args) {
  const { runDir, manifest, workOrder } = readRun(requireArg(args, "run"));
  const cwd = workOrder.repo.workingDir ? resolve(workOrder.repo.workingDir) : process.cwd();
  const reviewer = args.reviewer || "claude";
  const model = args.model || "claude-opus-4-8";
  const effort = args.effort || "max";
  const bin = args.bin || "claude";
  const allowedTools = args["allowed-tools"]
    || args.allowedTools
    || "Read,Grep,Glob,Bash(git *)";
  const prompt = args["prompt-file"]
    ? readFileSync(resolve(args["prompt-file"]), "utf8")
    : (args.prompt || defaultClaudeJudgePrompt(workOrder, cwd));
  const promptPath = resolve(runDir, "evidence", `claude-judge-prompt-${nowStamp()}.txt`);
  writeFileSync(promptPath, prompt);
  const outputPath = resolve(args.output || resolve(runDir, "evidence", `claude-judge-${nowStamp()}.json`));
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "summary", "findings"],
    properties: {
      verdict: { type: "string", enum: ["PASS", "FAIL", "PARTIAL", "BLOCKED"] },
      summary: { type: "string" },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["severity", "summary", "evidence"],
          properties: {
            severity: { type: "string", enum: ["P0", "P1", "P2", "P3", "info"] },
            summary: { type: "string" },
            evidence: { type: "string" },
          },
        },
      },
    },
  };
  const commandArgs = [
    "--print",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--model",
    model,
    "--effort",
    effort,
    "--permission-mode",
    "default",
    "--allowedTools",
    allowedTools,
    "--add-dir",
    cwd,
    "--json-schema",
    JSON.stringify(schema),
    prompt,
  ];
  const result = spawnSync(bin, commandArgs, { cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  const parsed = claudeJsonFromStdout(result.stdout);
  const verdict = parsed?.verdict && ["PASS", "FAIL", "PARTIAL", "BLOCKED"].includes(parsed.verdict)
    ? parsed.verdict
    : "FAIL";
  const summary = parsed?.summary
    || (result.status === 0
      ? "Claude judge completed but did not return a parseable verdict"
      : `Claude judge failed with exit ${result.status ?? "unknown"}`);
  const reviewedHead = gitHead(cwd);
  const diffBase = args["diff-base"] || workOrder.repo.baseBranch || null;
  const diff = gitDiffHash(cwd, diffBase);
  const artifact = {
    schemaVersion: 1,
    reviewer,
    model,
    effort,
    cwd,
    allowedTools,
    promptPath,
    promptSha256: sha256(readFileSync(promptPath)),
    outputFormat: "json",
    status: result.status,
    signal: result.signal,
    error: result.error?.message || null,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    parsed,
    verdict,
    summary,
    reviewedHead,
    diffBase,
    reviewedDiffHash: diff.hash,
    diffCommandArgs: diff.commandArgs,
    diffError: diff.error,
    createdAt: new Date().toISOString(),
  };
  writeJsonAtomic(outputPath, artifact);
  const verdictPath = args["verdict-file"] ? resolve(args["verdict-file"]) : null;
  if (verdictPath) {
    writeJsonAtomic(verdictPath, {
      schemaVersion: 1,
      reviewer,
      model,
      verdict,
      summary,
      findings: Array.isArray(parsed?.findings) ? parsed.findings : [],
      reviewedHead,
      reviewedDiffHash: diff.hash,
      sourceArtifact: outputPath,
      status: result.status,
      createdAt: artifact.createdAt,
    });
  }
  const gate = `judge_review_${sanitize(reviewer).toLowerCase()}`;
  const written = writeGateResult(runDir, manifest, workOrder, gate, verdict, summary, {
    type: "judge_review",
    reviewer,
    model,
    cwd,
    reviewedHead,
    diffBase,
    reviewedDiffHash: diff.hash,
    diffCommandArgs: diff.commandArgs,
    diffError: diff.error,
    evidencePath: outputPath,
    verdictPath,
    promptPath,
    allowedTools,
  }, [
    { kind: "judge_review", path: outputPath, summary },
    ...(verdictPath ? [{ kind: "judge_verdict", path: verdictPath, summary: `${reviewer} verdict file` }] : []),
    { kind: "judge_prompt", path: promptPath, summary: "Claude judge prompt" },
  ]);
  console.log(JSON.stringify({ runDir, gate, outputPath, ...written }, null, 2));
  if (verdict !== "PASS") process.exitCode = 1;
}

function evidenceCheck(args) {
  const { runDir, manifest, workOrder } = readRun(requireArg(args, "run"));
  const pack = readJson(manifest.paths.evidencePack);
  const required = requiredEvidenceRequirements(workOrder);
  const present = new Set((pack.items || []).map((item) => item.kind));
  const paperclipAudit = paperclipEvidenceAudit(manifest, workOrder, { mode: "ship_to_pr" });
  const failures = [
    ...evidenceFailures(pack, required),
    ...browserEvidenceFailures(manifest, workOrder, pack),
    ...(paperclipAudit.failures || []),
  ];
  const missing = failures.filter((failure) => failure.reason === "missing evidence item").map((failure) => failure.evidenceKind);
  const verdict = failures.length === 0 ? "PASS" : "FAIL";
  const summary = failures.length === 0
    ? "Required evidence is present"
    : `Evidence check failed: ${failures.map((failure) => `${failure.evidenceKind || failure.gate}: ${failure.reason}`).join("; ")}`;
  const written = writeGateResult(runDir, manifest, workOrder, "evidence", verdict, summary, {
    required,
    present: [...present].sort(),
    missing,
    failures,
    paperclipAudit,
  });
  console.log(JSON.stringify({ runDir, required, present: [...present], missing, failures, ...written }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

function testCommandFromArgs(args, contract, suite) {
  if (args["command-json"]) {
    const parsed = JSON.parse(args["command-json"]);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("--command-json must be a JSON array of strings");
    }
    return { command: parsed, entry: null };
  }
  const [entry] = suiteEntries(contract, suite);
  const command = commandFromTestEntry(entry);
  if (!command) {
    throw new Error(`No ${suite} test command found in TestContract; pass --command-json to run an explicit command`);
  }
  return { command, entry };
}

function expectedTestVerdict(exitCode, expect) {
  if (expect === "pass") return exitCode === 0 ? "PASS" : "FAIL";
  if (expect === "fail") return exitCode === 0 ? "FAIL" : "PASS";
  throw new Error("--expect must be pass or fail");
}

function runTests(args) {
  const { runDir, manifest, workOrder } = readRun(requireArg(args, "run"));
  const suite = args.suite || "visible";
  if (!["visible", "holdout"].includes(suite)) throw new Error("--suite must be visible or holdout");
  const phase = args.phase || "post";
  if (!["pre", "post"].includes(phase)) throw new Error("--phase must be pre or post");
  const expect = (args.expect || (phase === "pre" ? "fail" : "pass")).toLowerCase();
  if (!["pass", "fail"].includes(expect)) throw new Error("--expect must be pass or fail");
  const contract = testContractFromRun(runDir, manifest, workOrder);
  if (!contract && !args["command-json"]) {
    throw new Error("No TestContract found for this run; pass --command-json for a legacy structured test run");
  }
  const currentContractHash = testContractHash(contract);
  if (manifest.testContractHash && currentContractHash !== manifest.testContractHash) {
    throw new Error("Refusing to run tests because the TestContract hash no longer matches the frozen run manifest");
  }
  if (suite === "holdout" && !hasHoldoutSuite(contract)) {
    throw new Error("No holdout suite is defined in the TestContract");
  }
  const { command, entry } = testCommandFromArgs(args, contract, suite);
  const cwd = entry?.cwd
    ? (isAbsolute(entry.cwd) ? entry.cwd : resolve(repoCwd(workOrder), entry.cwd))
    : repoCwd(workOrder);
  const startedAt = new Date().toISOString();
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  const endedAt = new Date().toISOString();
  const outputPath = resolve(manifest.paths.evidenceDir, `tests-${suite}-${phase}-${nowStamp()}.txt`);
  writeFileSync(outputPath, [
    `$ ${command.join(" ")}`,
    `cwd: ${cwd}`,
    `suite: ${suite}`,
    `phase: ${phase}`,
    `expect: ${expect}`,
    `status: ${result.status ?? "null"}`,
    "",
    "stdout:",
    result.stdout || "",
    "",
    "stderr:",
    result.stderr || "",
    result.error ? `\nerror:\n${result.error.message}` : "",
  ].join("\n"));
  const cwdForDiff = repoCwd(workOrder);
  const head = gitHead(cwdForDiff);
  const diffBase = args["diff-base"] || workOrder.repo.baseBranch || null;
  const diff = gitDiffHash(cwdForDiff, diffBase);
  const verdict = expectedTestVerdict(result.status ?? 1, expect);
  const gate = phase === "pre" ? "oracle_baseline" : (suite === "holdout" ? "oracle_holdout" : "tests");
  const summary = verdict === "PASS"
    ? `${suite} ${phase} test oracle matched expected ${expect}`
    : `${suite} ${phase} test oracle did not match expected ${expect}`;
  const details = {
    suite,
    phase,
    expect,
    command,
    cwd,
    status: result.status,
    signal: result.signal,
    error: result.error?.message || null,
    startedAt,
    endedAt,
    head,
    diffBase,
    diffHash: diff.hash,
    diffCommandArgs: diff.commandArgs,
    diffError: diff.error,
    testContractHash: currentContractHash,
    testId: entry?.id || null,
  };
  const artifact = { kind: "test_output", path: outputPath, summary };
  withRunMutationLock(runDir, () => {
    const currentManifest = readJson(resolve(runDir, "run-manifest.json"));
    const pack = readJson(currentManifest.paths.evidencePack);
    const evidenceKind = suite === "holdout" ? "holdout_test" : "test";
    const item = {
      kind: evidenceKind,
      path: outputPath,
      url: null,
      summary,
      sha256: sha256(readFileSync(outputPath)),
      createdAt: endedAt,
    };
    pack.items.push(item);
    writeJsonAtomic(currentManifest.paths.evidencePack, pack);
    appendRunEvent({
      manifest: currentManifest,
      workOrder,
      eventType: "test_evidence_recorded",
      summary,
      details: { ...details, evidenceKind },
      artifacts: [{ kind: evidenceKind, path: outputPath, sha256: item.sha256, summary }],
    });
  });
  const written = writeGateResult(runDir, manifest, workOrder, gate, verdict, summary, details, [artifact]);
  console.log(JSON.stringify({ runDir, gate, outputPath, ...written }, null, 2));
  if (verdict !== "PASS") process.exitCode = 1;
}

function paperclipAuditCommand(args) {
  const { manifest, workOrder } = readRun(requireArg(args, "run"));
  const mode = args.mode || "ship_to_pr";
  if (!["ship_to_pr", "done"].includes(mode)) {
    throw new Error("paperclip-audit --mode must be ship_to_pr or done");
  }
  const audit = paperclipEvidenceAudit(manifest, workOrder, { mode, includePr: mode === "done" });
  console.log(JSON.stringify(audit, null, 2));
  if (!audit.ok) process.exitCode = 1;
}

function worktreeCheck(args) {
  const { runDir, workOrder } = readRun(requireArg(args, "run"));
  const report = worktreeHealthForRun(workOrder);
  const compact = compactWorktreeHealth(report);
  console.log(JSON.stringify({ runDir, ...compact }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

function noMistakes(args) {
  const { runDir, manifest, workOrder } = readRun(requireArg(args, "run"));
  const cwd = repoCwd(workOrder);
  assertCleanWorktree(cwd, { label: "No Mistakes gate" });
  const base = args.base || workOrder.repo.baseBranch || "stage";
  const bin = args.bin || process.env.NO_MISTAKES_BIN || "no-mistakes";
  const commandArgs = noMistakesCommandArgs({ args, bin, cwd, base });
  let headBefore = gitHead(cwd);
  if (!headBefore) {
    throw new Error(`No Mistakes gate requires a git HEAD in ${cwd}`);
  }
  const noMistakesHome = effectiveNoMistakesHome(manifest);
  if (manifest.paths.noMistakesHome !== noMistakesHome) {
    manifest.paths.noMistakesHome = noMistakesHome;
    saveRun(runDir, manifest);
  }
  prepareNoMistakesHome(noMistakesHome);
  const env = {
    ...process.env,
    NM_HOME: noMistakesHome,
    NO_MISTAKES_AUTO_MERGE: "0",
    NO_MISTAKES_PR_MERGE: "0",
    NM_AUTO_MERGE: "0",
  };
  const attempts = [];
  let result = null;
  let headAfter = headBefore;
  const stabilize = args.stabilize !== "false";
  const limit = stabilize ? NO_MISTAKES_STABILIZE_LIMIT : 1;
  for (let attempt = 1; attempt <= limit; attempt += 1) {
    result = spawnSync(bin, commandArgs, { cwd, env, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
    headAfter = gitHead(cwd);
    attempts.push({
      attempt,
      status: result.status,
      signal: result.signal,
      error: result.error?.message || null,
      headBefore,
      headAfter,
    });
    if (result.status !== 0 || headAfter === headBefore) break;
    if (attempt < limit) {
      headBefore = headAfter;
      assertCleanWorktree(cwd, { label: "No Mistakes gate after agent changes" });
    }
  }
  const combinedOutput = attempts.map((attempt, index) => [
    `# No Mistakes attempt ${attempt.attempt}`,
    index === attempts.length - 1 ? [result.stdout, result.stderr].filter(Boolean).join("\n").trim() : "",
  ].filter(Boolean).join("\n")).join("\n\n");
  const outputPath = resolve(runDir, "no-mistakes-output.txt");
  writeFileSync(outputPath, `${combinedOutput}\n`);
  const verdict = result.status === 0 && headAfter === headBefore ? "PASS" : "FAIL";
  const summary = result.status === 0
    ? (headAfter === headBefore ? "No Mistakes passed for exact HEAD" : "No Mistakes changed HEAD during run")
    : `No Mistakes failed with exit ${result.status ?? "unknown"}`;
  const written = writeGateResult(runDir, manifest, workOrder, "no_mistakes", verdict, summary, {
    cwd,
    base,
    bin,
    commandArgs,
    noMistakesHome,
    head: headBefore,
    headAfter,
    status: result.status,
    signal: result.signal,
    error: result.error?.message || null,
    attempts,
    autoMergeDisabled: true,
  }, [{ kind: "no_mistakes_output", path: outputPath, summary }]);
  console.log(JSON.stringify({ runDir, cwd, base, ...written }, null, 2));
  if (result.status !== 0) process.exitCode = 1;
}

function scopeFailures(manifest, workOrder) {
  const cwd = repoCwd(workOrder);
  const changed = gitChangedFiles(cwd, workOrder.repo.baseBranch || null);
  if (changed.error) {
    return [{
      kind: "scope",
      reason: "could not determine changed files for scope enforcement",
      commandArgs: changed.commandArgs,
      error: changed.error,
    }];
  }
  const allowed = workOrder.allowedWriteScope || [];
  const protectedPaths = manifest.protectedPaths || testContractProtectedPaths(
    workOrder,
    testContractFromRun(manifest.paths?.runDir || ".", manifest, workOrder),
  );
  const failures = [];
  for (const file of changed.files || []) {
    if (!matchesAnyPathPattern(file, allowed)) {
      failures.push({
        kind: "scope",
        file,
        reason: "changed file is outside allowedWriteScope",
        allowedWriteScope: allowed,
      });
    }
    if (matchesAnyPathPattern(file, protectedPaths)) {
      failures.push({
        kind: "protected_path",
        file,
        reason: "changed file matches a protected test/oracle path",
        protectedPaths,
      });
    }
  }
  return failures;
}

function testContractFailures(runDir, manifest, workOrder) {
  if (!testContractRequired(workOrder)) return [];
  const contract = testContractFromRun(runDir, manifest, workOrder);
  if (!contract) {
    return [{ kind: "test_contract", reason: "required TestContract is missing from the run" }];
  }
  const failures = [];
  if (contract.frozen !== true) {
    failures.push({ kind: "test_contract", reason: "TestContract is not frozen" });
  }
  const currentHash = testContractHash(contract);
  if (!manifest.testContractHash) {
    failures.push({ kind: "test_contract", reason: "run manifest is missing testContractHash" });
  } else if (currentHash !== manifest.testContractHash) {
    failures.push({
      kind: "test_contract",
      reason: "TestContract hash changed after the run was started",
      currentHash,
      frozenHash: manifest.testContractHash,
    });
  }
  return failures;
}

function boundTestGateFailures(manifest, workOrder) {
  const failures = [];
  for (const gate of ["tests", "oracle_holdout"]) {
    const result = manifest.gates?.[gate];
    if (result?.verdict !== "PASS" || !result.path || !existsSync(result.path)) continue;
    const gateResult = readJson(result.path);
    const details = gateResult.details || {};
    const cwd = repoCwd(workOrder);
    const currentHead = gitHead(cwd);
    if (details.head && currentHead && details.head !== currentHead) {
      failures.push({
        kind: "gate",
        gate,
        reason: "test PASS is stale because HEAD changed after the test run",
        currentHead,
        testedHead: details.head,
      });
    }
    if (details.diffHash) {
      const currentDiff = gitDiffHash(cwd, details.diffBase || workOrder.repo.baseBranch || null);
      if (currentDiff.hash && currentDiff.hash !== details.diffHash) {
        failures.push({
          kind: "gate",
          gate,
          reason: "test PASS is stale because diff changed after the test run",
          currentDiffHash: currentDiff.hash,
          testedDiffHash: details.diffHash,
        });
      }
    }
    if (details.testContractHash && manifest.testContractHash && details.testContractHash !== manifest.testContractHash) {
      failures.push({
        kind: "gate",
        gate,
        reason: "test PASS is stale because the TestContract hash changed",
        gateTestContractHash: details.testContractHash,
        manifestTestContractHash: manifest.testContractHash,
      });
    }
  }
  return failures;
}

function activeQuarantineFailure(manifest) {
  if (manifest.quarantine?.status !== "active") return null;
  return {
    kind: "quarantine",
    reason: manifest.quarantine.reason || "run is quarantined",
    quarantine: manifest.quarantine,
  };
}

function staleActiveRunFailure(manifest, options = {}) {
  if (terminalRunStatus(manifest.status) || manifest.status !== "active") return null;
  const maxAgeMinutes = Number(options.maxActiveMinutes || DEFAULT_STALE_ACTIVE_MINUTES);
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes < 0) return null;
  const nowMs = dateMs(options.now) || Date.now();
  const ageMinutes = ageMinutesSince(manifest.createdAt, nowMs);
  if (ageMinutes === null || ageMinutes < maxAgeMinutes) return null;
  return {
    kind: "stale_active_run",
    reason: `active Foreman run is older than ${maxAgeMinutes} minutes`,
    runId: manifest.runId,
    createdAt: manifest.createdAt || null,
    ageMinutes,
    maxAgeMinutes,
  };
}

function sharedWorktreeFailure(manifest, workOrder) {
  const refs = sharedWorktreeRefs(manifest, workOrder);
  if (refs.length === 0) return null;
  return {
    kind: "shared_worktree",
    reason: "repo workingDir is shared by another unresolved Foreman run",
    refs,
  };
}

function quarantineFailures(manifest, workOrder, options = {}) {
  const failures = [];
  const worktreeHealth = worktreeHealthForRun(workOrder);
  const worktreeFailure = cleanWorktreeFailure(worktreeHealth);
  if (worktreeFailure) {
    failures.push({
      kind: "dirty_worktree",
      reason: "repo has uncommitted changes or could not be checked",
      details: compactWorktreeHealth(worktreeHealth),
    });
  }
  const shared = sharedWorktreeFailure(manifest, workOrder);
  if (shared) failures.push(shared);
  const stale = staleActiveRunFailure(manifest, options);
  if (stale) failures.push(stale);
  return { failures, worktreeHealth };
}

function readinessReport(manifest, workOrder, options = {}) {
  const failures = [];
  const workOrderValidation = validateWorkOrder(workOrder);
  if (!workOrderValidation.ok) {
    failures.push({
      kind: "workorder_contract",
      reason: "WorkOrder no longer satisfies Foreman contract",
      errors: workOrderValidation.errors,
    });
  }
  const ledger = verifyLedger(manifest.issue || workOrder.issue || workOrder.workOrderId);
  if (!ledger.ok) failures.push({ kind: "ledger", reason: "ledger hash-chain verification failed or has no events", ledger });
  const worktreeHealth = worktreeHealthForRun(workOrder);
  const worktreeFailure = cleanWorktreeFailure(worktreeHealth);
  if (worktreeFailure) {
    failures.push({
      kind: "worktree",
      reason: "repo has uncommitted changes or could not be checked",
      details: compactWorktreeHealth(worktreeHealth),
    });
  }
  const activeQuarantine = activeQuarantineFailure(manifest);
  if (activeQuarantine) failures.push(activeQuarantine);
  if (!worktreeFailure && !activeQuarantine) {
    const shared = sharedWorktreeFailure(manifest, workOrder);
    if (shared) failures.push(shared);
    const stale = staleActiveRunFailure(manifest, options);
    if (stale) failures.push(stale);
  }
  failures.push(...planAdversarialReviewFailures(manifest, workOrder));
  failures.push(...testContractFailures(manifest.paths?.runDir || ".", manifest, workOrder));
  failures.push(...scopeFailures(manifest, workOrder));
  failures.push(...boundTestGateFailures(manifest, workOrder));
  if (manifest.loop?.exhausted) {
    failures.push({ kind: "loop", loopId: manifest.loop.id || "main", reason: "primary loop exhausted before PASS" });
  }
  for (const loop of manifest.loops || []) {
    if (loop.exhausted) {
      failures.push({ kind: "loop", loopId: loop.id, reason: "conditional loop exhausted before PASS" });
    }
  }
  for (const gate of requiredGates(workOrder, options)) {
    const result = manifest.gates[gate];
    if (!result) {
      failures.push({ kind: "gate", gate, reason: "missing gate result" });
    } else if (result.verdict !== "PASS") {
      failures.push({ kind: "gate", gate, reason: `gate verdict is ${result.verdict}` });
    } else if (gate === "browser_qa") {
      const gateResult = readJson(result.path);
      const details = gateResult.details || {};
      const waiver = details.waiver || null;
      if (waiver && (!waiver.owner || !waiver.reason)) {
        failures.push({
          kind: "gate",
          gate,
          reason: "Browser QA waiver must name the owner and reason",
          waiver,
        });
      }
    } else if (gate === "no_mistakes") {
      const gateResult = readJson(result.path);
      const cwd = workOrder.repo.workingDir ? resolve(workOrder.repo.workingDir) : process.cwd();
      const currentHead = gitHead(cwd);
      const approvedHead = gateResult.details?.head || null;
      if (!currentHead || !approvedHead || currentHead !== approvedHead) {
        failures.push({
          kind: "gate",
          gate,
          reason: "No Mistakes PASS is not for the current HEAD",
          currentHead,
          approvedHead,
        });
      }
    }
  }
  for (const [gate, result] of Object.entries(manifest.gates || {})) {
    if (!gate.startsWith("model_review_") && !gate.startsWith("judge_review_")) continue;
    if (result?.verdict !== "PASS" || !result.path || !existsSync(result.path)) continue;
    const gateResult = readJson(result.path);
    const details = gateResult.details || {};
    const cwd = details.cwd || (workOrder.repo.workingDir ? resolve(workOrder.repo.workingDir) : process.cwd());
    const currentHead = gitHead(cwd);
    if (details.reviewedHead && currentHead && currentHead !== details.reviewedHead) {
      failures.push({
        kind: "gate",
        gate,
        reason: "review PASS is stale because HEAD changed after review",
        currentHead,
        reviewedHead: details.reviewedHead,
      });
      continue;
    }
    if (details.reviewedDiffHash) {
      const currentDiff = gitDiffHash(cwd, details.diffBase || workOrder.repo.baseBranch || null);
      if (currentDiff.hash && currentDiff.hash !== details.reviewedDiffHash) {
        failures.push({
          kind: "gate",
          gate,
          reason: "review PASS is stale because diff changed after review",
          currentDiffHash: currentDiff.hash,
          reviewedDiffHash: details.reviewedDiffHash,
        });
      }
    }
  }
  const pack = readJson(manifest.paths.evidencePack);
  const requiredEvidence = requiredEvidenceRequirements(workOrder);
  const paperclipAudit = paperclipEvidenceAudit(manifest, workOrder, {
    mode: options.includePr ? "done" : "ship_to_pr",
    includePr: options.includePr,
  });
  failures.push(...evidenceFailures(pack, requiredEvidence));
  failures.push(...browserEvidenceFailures(manifest, workOrder, pack));
  failures.push(...selfImprovementFailures(manifest, workOrder, pack));
  failures.push(...(paperclipAudit.failures || []));
  return {
    ok: failures.length === 0,
    failures,
    requiredGates: requiredGates(workOrder, options),
    requiredEvidence,
    paperclipAudit,
    worktreeHealth: compactWorktreeHealth(worktreeHealth),
  };
}

function extractGithubPrUrl(text) {
  const match = String(text || "").match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  return match ? match[0] : null;
}

function prUrlFromGate(manifest) {
  const prGatePath = manifest.gates?.pr?.path;
  if (!prGatePath || !existsSync(prGatePath)) return null;
  const gate = readJson(prGatePath);
  return gate.details?.url || null;
}

function githubLogin(cwd) {
  if (process.env.DARK_FACTORY_GH_LOGIN) return process.env.DARK_FACTORY_GH_LOGIN;
  const result = spawnSync("gh", ["api", "user", "--jq", ".login"], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

function assertSamuelJugGithubIdentity(cwd, gateName) {
  const login = githubLogin(cwd);
  if (login !== "Samueljug") {
    throw new Error([
      `Foreman blocked ${gateName} because GitHub publish identity is not Samueljug.`,
      `Resolved login: ${login || "(unavailable)"}`,
      "Do not push, create PRs, or publish code until `gh api user --jq .login` resolves to Samueljug for this environment.",
    ].join("\n"));
  }
  return login;
}

function ready(args) {
  const { manifest, workOrder } = readRun(requireArg(args, "run"));
  const report = readinessReport(manifest, workOrder, { includePr: args["include-pr"] === "true" });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

function runCheckedCommand({ runDir, manifest, workOrder, command, commandArgs, cwd, gateName }) {
  if (gateName === "push" || gateName === "pr") {
    assertSamuelJugGithubIdentity(cwd, gateName);
  }
  const report = readinessReport(manifest, workOrder, { includePr: false });
  if (!report.ok) {
    throw new Error(`Foreman blocked ${gateName} because the run is not ready:\n${JSON.stringify(report.failures, null, 2)}`);
  }
  const fakePublish = process.env.DARK_FACTORY_CONFORMANCE_FAKE_PUBLISH === "true";
  const result = fakePublish && gateName === "pr"
    ? {
      status: 0,
      signal: null,
      stdout: `${process.env.DARK_FACTORY_FAKE_PR_URL || "https://github.com/dark-factory/conformance/pull/1"}\n`,
      stderr: "",
    }
    : (fakePublish && gateName === "push"
      ? { status: 0, signal: null, stdout: "fake push completed\n", stderr: "" }
      : spawnSync(command, commandArgs, { cwd, encoding: "utf8" }));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const verdict = result.status === 0 ? "PASS" : "FAIL";
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const prUrl = gateName === "pr" ? extractGithubPrUrl(output) : null;
  writeGateResult(runDir, manifest, workOrder, gateName, verdict, `${gateName} command exited ${result.status}`, {
    command,
    commandArgs,
    cwd,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    url: prUrl,
  });
  if (gateName === "pr" && verdict === "PASS" && prUrl) {
    appendRunEvent({
      manifest,
      workOrder,
      eventType: "pr_created",
      stage: "Human Final Review",
      summary: `PR created through Foreman: ${prUrl}`,
      details: {
        url: prUrl,
        command,
        commandArgs,
        cwd,
      },
    });
  }
  if (result.status !== 0) process.exitCode = result.status || 1;
}

function push(args) {
  const { runDir, manifest, workOrder } = readRun(requireArg(args, "run"));
  const cwd = workOrder.repo.workingDir ? resolve(workOrder.repo.workingDir) : process.cwd();
  const remote = args.remote || "origin";
  const branch = args.branch || workOrder.repo.branch;
  if (!branch) throw new Error("Missing --branch and workOrder.repo.branch");
  runCheckedCommand({
    runDir,
    manifest,
    workOrder,
    command: "git",
    commandArgs: ["push", remote, branch],
    cwd,
    gateName: "push",
  });
}

function pr(args) {
  const { runDir, manifest, workOrder } = readRun(requireArg(args, "run"));
  const cwd = workOrder.repo.workingDir ? resolve(workOrder.repo.workingDir) : process.cwd();
  const title = requireArg(args, "title");
  const body = requireArg(args, "body");
  const base = args.base || workOrder.repo.baseBranch;
  const head = args.head || workOrder.repo.branch;
  const commandArgs = ["pr", "create", "--title", title, "--body", body, "--base", base];
  if (head) commandArgs.push("--head", head);
  const reviewers = reviewerList(args.reviewers, workOrder.repo);
  if (reviewers.length > 0) commandArgs.push("--reviewer", reviewers.join(","));
  runCheckedCommand({
    runDir,
    manifest,
    workOrder,
    command: "gh",
    commandArgs,
    cwd,
    gateName: "pr",
  });
}

function prStatus(args) {
  const { runDir, manifest, workOrder } = readRun(requireArg(args, "run"));
  const url = args.url || prUrlFromGate(manifest);
  if (!url) throw new Error("Missing --url and no PR URL found in pr gate");
  const result = spawnSync("gh", [
    "pr",
    "view",
    url,
    "--json",
    "number,url,title,state,isDraft,baseRefName,headRefOid,mergedAt,mergedBy,statusCheckRollup,reviewDecision,mergeStateStatus,reviewRequests,latestReviews",
  ], { encoding: "utf8" });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`gh pr view failed with exit ${result.status}: ${result.stderr || result.stdout}`);
  }
  const body = JSON.parse(result.stdout);
  const checks = (body.statusCheckRollup || []).map((check) => ({
    name: check.name || check.context || null,
    status: check.status || check.state || null,
    conclusion: check.conclusion || null,
  }));
  const reviewRequests = (body.reviewRequests || []).map((reviewer) => reviewer.login || reviewer.name || reviewer.id || null).filter(Boolean);
  const summary = `PR status checked: ${url}`;
  const details = {
    number: body.number,
    url: body.url || url,
    title: body.title,
    state: body.state || null,
    isDraft: Boolean(body.isDraft),
    baseRefName: body.baseRefName || null,
    headRefOid: body.headRefOid || null,
    mergedAt: body.mergedAt || null,
    mergedBy: body.mergedBy?.login || null,
    checks,
    reviewDecision: body.reviewDecision || "",
    mergeStateStatus: body.mergeStateStatus || "",
    reviewRequests,
    latestReviews: (body.latestReviews || []).map((review) => ({
      author: review.author?.login || null,
      state: review.state || null,
      submittedAt: review.submittedAt || null,
      commit: review.commit?.oid || null,
    })),
  };
  details.mergeEligibility = mergeEligibility({ body, checks, reviewRequests, manifest, workOrder });
  details.paperclipAudit = paperclipEvidenceAudit(manifest, workOrder, { mode: "done", includePr: true });
  if ((details.paperclipAudit.failures || []).length > 0) {
    details.mergeEligibility.blockers.push({
      kind: "paperclip_evidence",
      reason: "Paperclip evidence audit failed for Done eligibility",
      failures: details.paperclipAudit.failures,
    });
    details.mergeEligibility.verdict = "blocked";
  }
  withRunMutationLock(runDir, () => {
    const currentManifest = readJson(resolve(runDir, "run-manifest.json"));
    const statusPath = resolve(runDir, "evidence", `pr-status-${nowStamp()}.json`);
    writeJsonAtomic(statusPath, details);
    const pack = readJson(currentManifest.paths.evidencePack);
    const item = {
      kind: "pr_status",
      path: statusPath,
      url: details.url,
      summary,
      sha256: sha256(readFileSync(statusPath)),
      createdAt: new Date().toISOString(),
    };
    pack.items.push(item);
    writeJsonAtomic(currentManifest.paths.evidencePack, pack);
    appendRunEvent({
      manifest: currentManifest,
      workOrder,
      eventType: "pr_status_checked",
      stage: currentManifest.currentStage,
      summary,
      details,
      artifacts: [{ kind: "pr_status", path: statusPath, url: details.url, sha256: item.sha256, summary }],
    });
  });
  console.log(JSON.stringify(details, null, 2));
  if (args["require-eligible"] === "true" && details.mergeEligibility.verdict !== "eligible") {
    process.exitCode = 1;
  }
}

function leftAside(args) {
  const { runDir, manifest, workOrder } = readRun(requireArg(args, "run"));
  const summary = requireArg(args, "summary");
  withRunMutationLock(runDir, () => {
    const currentManifest = readJson(resolve(runDir, "run-manifest.json"));
    const dir = resolve(runDir, "left-aside");
    mkdirSync(dir, { recursive: true });
    const path = resolve(dir, `${nowStamp()}-${sanitize(summary).slice(0, 64)}.json`);
    const note = {
      schemaVersion: 1,
      summary,
      details: args.details || null,
      source: args.source || null,
      createdAt: new Date().toISOString(),
    };
    writeJsonAtomic(path, note);
    appendRunEvent({
      manifest: currentManifest,
      workOrder,
      eventType: "left_aside_recorded",
      stage: currentManifest.currentStage,
      summary,
      details: note,
      artifacts: [{ kind: "left_aside", path, summary }],
    });
    console.log(JSON.stringify({ runDir, path, note }, null, 2));
  });
}

function loopTarget(manifest, loopId) {
  const id = loopId || "main";
  if (id === "main") return { id, loop: manifest.loop, collection: "primary" };
  const index = (manifest.loops || []).findIndex((loop) => loop.id === id);
  if (index === -1) {
    throw new Error(`Unknown loop id: ${id}`);
  }
  return { id, loop: manifest.loops[index], collection: "additional", index };
}

function loopSummary(args) {
  const { runDir, manifest } = readRun(requireArg(args, "run"));
  const loops = [manifest.loop, ...(manifest.loops || [])].filter(Boolean);
  const exhausted = loops.filter((loop) => loop.exhausted);
  console.log(JSON.stringify({
    runDir,
    status: manifest.status,
    currentStage: manifest.currentStage,
    loops,
    exhausted: exhausted.map((loop) => loop.id || "main"),
  }, null, 2));
  if (exhausted.length > 0) process.exitCode = 1;
}

function iterate(args) {
  const { runDir, manifest, workOrder } = readRun(requireArg(args, "run"));
  const verdict = requireArg(args, "verdict");
  const summary = requireArg(args, "summary");
  if (!["PASS", "FAIL", "PARTIAL", "BLOCKED"].includes(verdict)) throw new Error(`Invalid verdict: ${verdict}`);
  const loopId = args.loop || args["loop-id"] || "main";
  withRunMutationLock(runDir, () => {
    const currentManifest = readJson(resolve(runDir, "run-manifest.json"));
    const target = loopTarget(currentManifest, loopId);
    if (target.loop.kind === PLAN_ADVERSARIAL_REVIEW_KIND && target.loop.currentIteration >= 1) {
      throw new Error("plan_adversarial_review is a one-shot challenge; create a new plan/run or escalate instead of iterating it again");
    }
    target.loop.currentIteration += 1;
    target.loop.lastVerdict = verdict;
    target.loop.updatedAt = new Date().toISOString();
    if (verdict === "PASS") {
      target.loop.status = "passed";
      target.loop.exhausted = false;
    } else if (verdict === "BLOCKED") {
      target.loop.status = "blocked";
      currentManifest.status = "blocked";
    } else {
      target.loop.status = "active";
    }
    if (target.loop.currentIteration >= target.loop.maxIterations && verdict !== "PASS") {
      target.loop.exhausted = true;
      target.loop.status = "blocked";
      currentManifest.status = "blocked";
    }
    currentManifest.updatedAt = new Date().toISOString();
    saveRun(runDir, currentManifest);
    Object.assign(manifest, currentManifest);
    appendRunEvent({
      manifest: currentManifest,
      workOrder,
      eventType: "loop_iteration",
      summary: `Loop ${target.id} iteration ${target.loop.currentIteration}: ${verdict} - ${summary}`,
      details: {
        loopId: target.id,
        kind: target.loop.kind || null,
        owner: target.loop.owner || null,
        trigger: target.loop.trigger || null,
        judge: target.loop.judge || null,
        verdict,
        feedback: args.feedback || null,
        currentIteration: target.loop.currentIteration,
        maxIterations: target.loop.maxIterations,
        exhausted: target.loop.exhausted,
        status: target.loop.status,
      },
    });
  });
  const target = loopTarget(manifest, loopId);
  console.log(JSON.stringify({ runDir, loop: target.loop, status: manifest.status }, null, 2));
  if (target.loop.exhausted) process.exitCode = 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }
  if (command === "validate") return validate(args);
  if (command === "start") return start(args);
  if (command === "start-from-paperclip") return startFromPaperclip(args);
  if (command === "handoff-watchdog") return handoffWatchdog(args);
  if (command === "status") return status(args);
  if (command === "advance") return advance(args);
  if (command === "evidence") return evidence(args);
  if (command === "reproduction") return reproduction(args);
  if (command === "stage-token") return stageToken(args);
  if (command === "browser-qa") return browserQa(args);
  if (command === "evidence-check") return evidenceCheck(args);
  if (command === "paperclip-audit") return paperclipAuditCommand(args);
  if (command === "run-tests") return runTests(args);
  if (command === "record-gate") return recordGate(args);
  if (command === "review-gate") return reviewGate(args);
  if (command === "model-review") {
    args.type = args.type || "model_review";
    return reviewGate(args);
  }
  if (command === "judge-review") {
    args.type = args.type || "judge_review";
    return reviewGate(args);
  }
  if (command === "claude-judge") return claudeJudge(args);
  if (command === "left-aside") return leftAside(args);
  if (command === "quarantine") return quarantine(args);
  if (command === "worktree-check") return worktreeCheck(args);
  if (command === "no-mistakes") return noMistakes(args);
  if (command === "ready") return ready(args);
  if (command === "push") return push(args);
  if (command === "pr") return pr(args);
  if (command === "pr-status") return prStatus(args);
  if (command === "loop-summary") return loopSummary(args);
  if (command === "iterate") return iterate(args);
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
