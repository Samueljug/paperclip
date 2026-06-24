#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LEDGER_ROOT,
  appendLedgerEvent,
  readLedgerEvents,
  stableStringify,
} from "./ledger-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const WORKSPACE_ROOT = resolve(__dirname, "../..");
export const DEFAULT_API_BASE = process.env.PAPERCLIP_API_BASE || "http://127.0.0.1:3101/api";
export const DEFAULT_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "1e8bc12a-f8fd-431c-9fbd-e47be79446a3";
export const DEFAULT_DARK_FACTORY_PROJECT_ID = process.env.PAPERCLIP_DARK_FACTORY_PROJECT_ID || "c4525f28-55d1-4378-864c-aec26d51fc37";
export const DEFAULT_RUNS_DIR = process.env.DARK_FACTORY_RUN_DIR
  ? resolve(process.env.DARK_FACTORY_RUN_DIR)
  : resolve(WORKSPACE_ROOT, "tools/paperclip-data/factory-runs");
export const DEFAULT_NM_ROOT = process.env.DARK_FACTORY_NM_DIR || "/tmp/df-nm";

const DEFAULT_REVIEW_STEPS = ["review"];
const ACTIVE_STATUS_PARAMS = "backlog,todo,in_progress,in_review,blocked,done,cancelled";
const STAGE_LABEL_PREFIX = "stage:";
const TARGET_STAGE_LABEL = "stage: In Progress";
const DECISION_NEEDED_LABELS = ["blocked: needs owner", "gate: no-mistakes-required"];
const MAX_COMMENT_FINDINGS = 25;
const NO_MISTAKES_TRUST_MODEL = "Reviewer text is advisory; repair workers must verify in code.";
const WATCHER_SOURCE = "no-mistakes-review-watcher";
const DECISION_ISSUE_TITLE_PREFIX = "No Mistakes routing decision needed:";

function usage() {
  return [
    "Usage:",
    "  no-mistakes-review-watcher.mjs [--apply] [--issue OPE-123] [--state-db path]",
    "                                  [--runs-dir DIR] [--nm-root DIR] [--all-steps]",
    "                                  [--api-base URL] [--company-id UUID] [--project-id UUID]",
    "                                  [--ledger-root DIR] [--fail-closed]",
    "",
    "Defaults to dry-run. In --apply mode, all deterministically mapped issues",
    "(including done/cancelled) receive a deduped Paperclip comment, a factory",
    "ledger event, status=in_progress, and stage: In Progress label — actionable",
    "NM findings re-enter the repair loop regardless of prior issue status.",
  ].join("\n");
}

export function parseArgs(argv) {
  const out = {
    _: [],
    apply: false,
    failClosed: false,
    allSteps: false,
    includeDefaultStateDbs: true,
    scanNmRoot: true,
    scanRunManifests: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "help") {
      out.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === "apply") {
      out.apply = true;
      continue;
    }
    if (key === "dry-run") {
      out.apply = false;
      continue;
    }
    if (key === "fail-closed") {
      out.failClosed = true;
      continue;
    }
    if (key === "all-steps") {
      out.allSteps = true;
      continue;
    }
    if (key === "no-default-state-dbs") {
      out.includeDefaultStateDbs = false;
      continue;
    }
    if (key === "no-nm-root") {
      out.scanNmRoot = false;
      continue;
    }
    if (key === "no-run-manifests") {
      out.scanRunManifests = false;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "true";
      continue;
    }
    if (out[key] === undefined) out[key] = next;
    else if (Array.isArray(out[key])) out[key].push(next);
    else out[key] = [out[key], next];
    i += 1;
  }
  return out;
}

function values(value) {
  if (value === undefined || value === null || value === false || value === "false") return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => item !== "true");
}

function normalizeOptions(options = {}) {
  const cli = Array.isArray(options.argv) ? parseArgs(options.argv) : {};
  const merged = { ...cli, ...options };
  return {
    apply: Boolean(merged.apply),
    failClosed: Boolean(merged.failClosed || merged["fail-closed"]),
    apiBase: String(merged.apiBase || merged["api-base"] || DEFAULT_API_BASE).replace(/\/$/, ""),
    companyId: merged.companyId || merged["company-id"] || DEFAULT_COMPANY_ID,
    projectId: merged.projectId || merged["project-id"] || DEFAULT_DARK_FACTORY_PROJECT_ID,
    ledgerRoot: resolve(merged.ledgerRoot || merged["ledger-root"] || DEFAULT_LEDGER_ROOT),
    runsDirs: values(merged.runsDirs || merged.runsDir || merged["runs-dir"]).map((item) => resolve(item)),
    runManifestPaths: values(merged.runManifestPaths || merged.runManifest || merged["run-manifest"]).map((item) => resolve(item)),
    nmRoot: resolve(merged.nmRoot || merged["nm-root"] || DEFAULT_NM_ROOT),
    stateDbs: values(merged.stateDbs || merged.stateDb || merged["state-db"]).map((item) => resolveHome(item)),
    issues: new Set(values(merged.issue).map(normalizeIssueIdentifier)),
    allSteps: Boolean(merged.allSteps || merged["all-steps"]),
    steps: values(merged.step).map((item) => item.toLowerCase()),
    includeDefaultStateDbs: merged.includeDefaultStateDbs !== false,
    scanNmRoot: merged.scanNmRoot !== false,
    scanRunManifests: merged.scanRunManifests !== false,
    scanLedgers: merged.scanLedgers !== false,
    maxCommentFindings: Number(merged.maxCommentFindings || merged["max-comment-findings"] || MAX_COMMENT_FINDINGS),
    patchStageLabel: merged.patchStageLabel !== false && merged["no-stage-label"] !== "true",
  };
}

function resolveHome(path) {
  const raw = String(path || "");
  if (raw === "~") return process.env.HOME || raw;
  if (raw.startsWith("~/")) return resolve(process.env.HOME || "", raw.slice(2));
  return resolve(raw);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortedUnique(valuesList) {
  return [...new Set(valuesList.map((item) => String(item || "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readTextSafe(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

function listDirs(path) {
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(path, entry.name));
  } catch {
    return [];
  }
}

function listFilesRecursive(root, predicate, { maxDepth = 4 } = {}) {
  const output = [];
  function walk(dir, depth) {
    if (depth > maxDepth || !existsSync(dir)) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && predicate(full)) {
        output.push(full);
      }
    }
  }
  walk(root, 0);
  return output;
}

function manifestPathsFromRunDir(runsDir) {
  if (!runsDir || !existsSync(runsDir)) return [];
  return listFilesRecursive(runsDir, (path) => path.endsWith("/run-manifest.json"), { maxDepth: 3 });
}

function pathsFromLedgerEvent(event) {
  const paths = [];
  for (const item of [...(event.artifacts || []), ...(event.sourceRefs || [])]) {
    if (item?.path) paths.push(item.path);
  }
  if (event.details?.runDir) paths.push(resolve(String(event.details.runDir), "run-manifest.json"));
  if (event.details?.manifestPath) paths.push(event.details.manifestPath);
  if (event.details?.runManifestPath) paths.push(event.details.runManifestPath);
  return paths;
}

function manifestPathsFromLedgers(ledgerRoot) {
  if (!ledgerRoot || !existsSync(ledgerRoot)) return [];
  const paths = new Set();
  for (const dir of listDirs(ledgerRoot)) {
    const eventsPath = resolve(dir, "events.jsonl");
    if (!existsSync(eventsPath)) continue;
    const text = readTextSafe(eventsPath);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let event = null;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      for (const path of pathsFromLedgerEvent(event)) {
        if (String(path).endsWith("run-manifest.json") && existsSync(path)) paths.add(resolve(path));
      }
    }
  }
  return [...paths];
}

function readManifestEntry(manifestPath) {
  const manifest = readJsonSafe(manifestPath);
  if (!manifest) return null;
  const workOrderPath = manifest.paths?.workOrder;
  const workOrder = workOrderPath && existsSync(workOrderPath) ? readJsonSafe(workOrderPath) : null;
  return {
    manifestPath,
    runDir: manifest.paths?.runDir || dirname(manifestPath),
    manifest,
    workOrder,
  };
}

function loadRunManifests(options) {
  const paths = new Set();
  if (options.scanRunManifests !== false) {
    for (const runsDir of [DEFAULT_RUNS_DIR, ...(options.runsDirs || [])]) {
      for (const path of manifestPathsFromRunDir(runsDir)) paths.add(resolve(path));
    }
  }
  for (const path of options.runManifestPaths || []) paths.add(resolve(path));
  if (options.scanLedgers !== false) {
    for (const path of manifestPathsFromLedgers(options.ledgerRoot || DEFAULT_LEDGER_ROOT)) paths.add(resolve(path));
  }
  return [...paths].map(readManifestEntry).filter(Boolean);
}

function repoPathsFromManifest(entry) {
  return sortedUnique([
    entry.manifest?.repo?.workingDir,
    entry.manifest?.taskRoute?.localPath,
    entry.workOrder?.repo?.workingDir,
    entry.workOrder?.taskRoute?.localPath,
  ]);
}

function stateDbFromRepoPath(repoPath) {
  return resolve(repoPath, ".git/no-mistakes/state.sqlite");
}

function discoverInitialStateDbs(options, manifestEntries = []) {
  const dbs = new Set((options.stateDbs || []).map(resolveHome));
  if (options.includeDefaultStateDbs !== false) {
    const globalDb = resolve(process.env.HOME || "", ".no-mistakes/state.sqlite");
    if (existsSync(globalDb)) dbs.add(globalDb);
  }
  if (options.scanNmRoot !== false && existsSync(options.nmRoot || DEFAULT_NM_ROOT)) {
    for (const dir of listDirs(options.nmRoot || DEFAULT_NM_ROOT)) {
      const db = resolve(dir, "state.sqlite");
      if (existsSync(db)) dbs.add(db);
    }
  }
  for (const entry of manifestEntries) {
    const nmHome = entry.manifest?.paths?.noMistakesHome;
    if (nmHome && existsSync(resolve(nmHome, "state.sqlite"))) dbs.add(resolve(nmHome, "state.sqlite"));
    for (const repoPath of repoPathsFromManifest(entry)) {
      const repoDb = stateDbFromRepoPath(repoPath);
      if (existsSync(repoDb)) dbs.add(repoDb);
    }
  }
  return [...dbs].sort();
}

function discoverRepoScopedStateDbs(alerts, manifestEntries) {
  const dbs = new Set();
  for (const alert of alerts) {
    if (alert.repo?.workingPath) {
      const repoDb = stateDbFromRepoPath(alert.repo.workingPath);
      if (existsSync(repoDb)) dbs.add(repoDb);
    }
  }
  for (const entry of manifestEntries) {
    for (const repoPath of repoPathsFromManifest(entry)) {
      const repoDb = stateDbFromRepoPath(repoPath);
      if (existsSync(repoDb)) dbs.add(repoDb);
    }
  }
  return [...dbs].sort();
}

function sqliteJson(dbPath, sql) {
  const result = spawnSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `sqlite3 exited ${result.status}`).trim());
  }
  try {
    return JSON.parse(result.stdout || "[]");
  } catch (error) {
    throw new Error(`sqlite3 JSON parse failed for ${dbPath}: ${error.message}`);
  }
}

function sqliteColumns(dbPath, table) {
  const rows = sqliteJson(dbPath, `PRAGMA table_info(${table});`);
  return new Set(rows.map((row) => row.name));
}

function quoteSqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function reviewStepAllowed(stepName, options) {
  if (options.allSteps) return true;
  const steps = options.steps?.length ? options.steps : DEFAULT_REVIEW_STEPS;
  return steps.includes(String(stepName || "").toLowerCase());
}

function parseFindingsJson(raw) {
  const text = String(raw || "").trim();
  if (!text) return { parsed: null, findings: [], parseError: null };
  try {
    const parsed = JSON.parse(text);
    let findings = [];
    if (Array.isArray(parsed)) findings = parsed;
    else if (Array.isArray(parsed.findings)) findings = parsed.findings;
    else if (Array.isArray(parsed.results)) findings = parsed.results;
    else if (parsed && typeof parsed === "object") findings = [parsed];
    return { parsed, findings: findings.map(normalizeFinding), parseError: null };
  } catch (error) {
    return {
      parsed: null,
      findings: [{
        id: "unparseable-findings-json",
        severity: "error",
        action: "decision-needed",
        file: null,
        line: null,
        description: `findings_json could not be parsed: ${error.message}`,
        category: "watcher_parse_error",
        source: null,
        riskLevel: "unknown",
      }],
      parseError: error.message,
    };
  }
}

function normalizeFinding(finding) {
  const source = finding && typeof finding === "object" ? finding : {};
  return {
    id: String(source.id || source.finding_id || source.key || "").trim() || null,
    severity: String(source.severity || source.risk_level || source.riskLevel || "unknown").trim() || "unknown",
    action: String(source.action || source.next_action || source.nextAction || "").trim() || null,
    file: String(source.file || source.path || source.filename || "").trim() || null,
    line: source.line === undefined || source.line === null || source.line === "" ? null : Number(source.line),
    description: String(source.description || source.summary || source.message || source.title || "").trim() || "(no description)",
    category: String(source.category || source.kind || "").trim() || null,
    source: String(source.source || "").trim() || null,
    riskLevel: String(source.risk_level || source.riskLevel || "").trim() || null,
  };
}

function summarizeFindings(parsed, findings) {
  const severities = sortedUnique(findings.map((finding) => finding.severity));
  const actions = sortedUnique(findings.map((finding) => finding.action));
  const affected = findings
    .filter((finding) => finding.file)
    .map((finding) => ({
      file: finding.file,
      line: Number.isFinite(finding.line) ? finding.line : null,
      severity: finding.severity,
      action: finding.action,
      id: finding.id,
    }));
  return {
    count: findings.length,
    severities,
    actions,
    affected,
    summary: typeof parsed?.summary === "string" ? parsed.summary : "",
    testingSummary: typeof parsed?.testing_summary === "string" ? parsed.testing_summary : "",
    riskLevel: parsed?.risk_level || parsed?.riskLevel || "",
    riskRationale: parsed?.risk_rationale || parsed?.riskRationale || "",
  };
}

function findingsFingerprint(parsed, findings) {
  const normalized = {
    findings: findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      action: finding.action,
      file: finding.file,
      line: finding.line,
      description: finding.description,
      category: finding.category,
      source: finding.source,
      riskLevel: finding.riskLevel,
    })),
    summary: parsed?.summary || "",
    risk_level: parsed?.risk_level || parsed?.riskLevel || "",
    risk_rationale: parsed?.risk_rationale || parsed?.riskRationale || "",
  };
  return sha256(stableStringify(normalized));
}

function nmHomeFromStateDb(dbPath) {
  return dirname(dbPath);
}

function resolveLogPath(logPath, repoPath, nmHome) {
  if (!logPath) return null;
  if (isAbsolute(logPath)) return logPath;
  if (repoPath && existsSync(resolve(repoPath, logPath))) return resolve(repoPath, logPath);
  return resolve(nmHome, logPath);
}

function nextActionForAlert(summary) {
  const actions = new Set(summary.actions.map((action) => String(action || "").toLowerCase()));
  if (actions.has("ask-user") || actions.has("decision-needed")) {
    return "Coordinator/implementation owner must classify the reviewer finding, make any needed product decision, repair or explicitly waive it, rerun verification/security as applicable, and rerun No Mistakes on the exact repaired HEAD. Reviewer text is advisory only and must not be executed as a trusted command.";
  }
  return "Implementation owner must repair the affected code, rerun targeted verification/security as applicable, rerun No Mistakes on the exact repaired HEAD, and update the Paperclip/PR record. Reviewer text is advisory only and must not be executed as a trusted command.";
}

function alertFromRow(dbPath, row, options) {
  const nmHome = nmHomeFromStateDb(dbPath);
  const parsed = parseFindingsJson(row.findings_json);
  const summary = summarizeFindings(parsed.parsed, parsed.findings);
  const alert = {
    kind: "no_mistakes_review_findings",
    stateDbPath: dbPath,
    nmHome,
    noMistakesRunId: row.run_id,
    stepResultId: row.step_result_id,
    stepName: row.step_name,
    status: row.step_status,
    runStatus: row.run_status,
    branch: row.branch || "",
    baseBranch: row.base_branch || row.default_branch || "",
    headSha: row.head_sha || "",
    baseSha: row.base_sha || "",
    prUrl: row.pr_url || null,
    reviewLogPath: resolveLogPath(row.log_path, row.working_path, nmHome),
    repo: {
      workingPath: row.working_path || "",
      upstreamUrl: row.upstream_url || "",
      originUrl: row.upstream_url || "",
      defaultBranch: row.default_branch || "",
    },
    findings: parsed.findings,
    findingsJsonParseError: parsed.parseError,
    findingsSummary: summary,
    findingsFingerprint: findingsFingerprint(parsed.parsed, parsed.findings),
    exactNextAction: nextActionForAlert(summary),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
  alert.dedupeMarker = dedupeMarker(alert);
  alert.commentBody = buildCommentBody(alert, { maxFindings: options.maxCommentFindings });
  return alert;
}

export function dedupeKey(alert) {
  return {
    nmHome: alert.nmHome || "",
    noMistakesRunId: alert.noMistakesRunId || "",
    stepName: alert.stepName || "",
    headSha: alert.headSha || "",
    findingsFingerprint: alert.findingsFingerprint || "",
  };
}

export function dedupeMarker(alert) {
  return `<!-- no-mistakes-review-watcher:${sha256(stableStringify(dedupeKey(alert))).slice(0, 32)} -->`;
}

export function scanNoMistakesDb(dbPath, options = {}) {
  const normalized = {
    allSteps: Boolean(options.allSteps),
    steps: options.steps?.length ? options.steps : DEFAULT_REVIEW_STEPS,
    maxCommentFindings: options.maxCommentFindings || MAX_COMMENT_FINDINGS,
  };
  const runColumns = sqliteColumns(dbPath, "runs");
  sqliteColumns(dbPath, "repos");
  sqliteColumns(dbPath, "step_results");
  const optional = (column, expression, fallback = "NULL") => runColumns.has(column) ? expression : fallback;
  const sql = `
    SELECT
      ${quoteSqlString(dbPath)} AS state_db_path,
      runs.id AS run_id,
      runs.branch AS branch,
      runs.head_sha AS head_sha,
      runs.base_sha AS base_sha,
      runs.status AS run_status,
      runs.pr_url AS pr_url,
      ${optional("base_branch", "runs.base_branch", "''")} AS base_branch,
      ${optional("trigger", "runs.trigger")} AS trigger,
      repos.working_path AS working_path,
      repos.upstream_url AS upstream_url,
      repos.default_branch AS default_branch,
      step_results.id AS step_result_id,
      step_results.step_name AS step_name,
      step_results.step_order AS step_order,
      step_results.status AS step_status,
      step_results.exit_code AS exit_code,
      step_results.duration_ms AS duration_ms,
      step_results.log_path AS log_path,
      step_results.findings_json AS findings_json,
      step_results.error AS step_error,
      step_results.started_at AS started_at,
      step_results.completed_at AS completed_at,
      runs.created_at AS created_at,
      runs.updated_at AS updated_at
    FROM step_results
    JOIN runs ON runs.id = step_results.run_id
    JOIN repos ON repos.id = runs.repo_id
    WHERE step_results.status = 'awaiting_approval'
      AND length(trim(coalesce(step_results.findings_json, ''))) > 0
    ORDER BY runs.updated_at DESC, step_results.step_order ASC;
  `;
  return sqliteJson(dbPath, sql)
    .filter((row) => reviewStepAllowed(row.step_name, normalized))
    .map((row) => alertFromRow(dbPath, row, normalized))
    .filter((alert) => alert.findingsSummary.count > 0);
}

function normalizeIssueIdentifier(value) {
  const match = String(value || "").match(/(?:^|[^A-Za-z0-9])OPE[-_]?(\d+)(?:$|[^A-Za-z0-9])/i)
    || String(value || "").match(/(?:^|[^A-Za-z0-9])ope[-_]?(\d+)(?:$|[^A-Za-z0-9])/i);
  return match ? `OPE-${Number(match[1])}` : String(value || "").trim().toUpperCase();
}

function extractIssueIdentifiers(alert) {
  const values = [
    alert.branch,
    alert.repo?.workingPath,
    alert.repo?.upstreamUrl,
    alert.prUrl,
  ];
  if (isNonGenericNoMistakesPath(alert.nmHome)) values.push(alert.nmHome);
  if (isNonGenericNoMistakesPath(alert.stateDbPath)) values.push(alert.stateDbPath);
  const text = values.join("\n");
  const ids = new Set();
  for (const match of text.matchAll(/(?:^|[^A-Za-z0-9])OPE[-_]?(\d+)(?:$|[^A-Za-z0-9])/gi)) {
    ids.add(`OPE-${Number(match[1])}`);
  }
  for (const match of text.matchAll(/(?:^|[^A-Za-z0-9])ope[-_]?(\d+)(?:$|[^A-Za-z0-9])/gi)) {
    ids.add(`OPE-${Number(match[1])}`);
  }
  return [...ids];
}

function compactToken(value) {
  return String(value || "").trim().toLowerCase().replace(/\.git$/i, "").replace(/\/+$/, "");
}

function textIncludesToken(text, token) {
  const normalized = compactToken(token);
  if (!normalized) return false;
  return compactToken(text).includes(normalized);
}

function normalizePathToken(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const expanded = resolveHome(text);
  return (isAbsolute(expanded) ? resolve(expanded) : expanded).replace(/\/+$/, "");
}

function globalNoMistakesHome() {
  return process.env.HOME ? resolve(process.env.HOME, ".no-mistakes") : "";
}

function isGenericNoMistakesPath(value) {
  const normalized = normalizePathToken(value);
  const globalHome = globalNoMistakesHome();
  if (!normalized || !globalHome) return false;
  return normalized === globalHome || normalized === resolve(globalHome, "state.sqlite");
}

function isNonGenericNoMistakesPath(value) {
  return Boolean(String(value || "").trim()) && !isGenericNoMistakesPath(value);
}

const GENERIC_BRANCHES = new Set(["main", "master", "dev", "development", "stage", "staging", "test", "testing", "prod", "production"]);

function isGenericBranch(branch) {
  return GENERIC_BRANCHES.has(String(branch || "").trim().toLowerCase());
}

function issueSearchText(issue) {
  return [
    issue.identifier,
    issue.title,
    issue.description,
    issue.status,
    ...(issue.labels || []).map((label) => label.name || label),
  ].join("\n");
}

function issueCandidate(existing, issue, points, reason, authority = "fallback") {
  const key = issue.identifier || issue.id;
  const current = existing.get(key) || { issue, score: 0, reasons: [], authority };
  current.score += points;
  current.reasons.push(reason);
  if (authority === "authoritative") current.authority = authority;
  existing.set(key, current);
}

function manifestIssueIdentifier(entry) {
  return normalizeIssueIdentifier(
    entry.workOrder?.paperclip?.issueIdentifier
    || entry.workOrder?.issue
    || entry.manifest?.issue
    || entry.manifest?.workOrderId
    || entry.workOrder?.workOrderId
  );
}

function manifestMatchesAlert(entry, alert) {
  const scores = [];
  const nmHome = entry.manifest?.paths?.noMistakesHome;
  if (nmHome && isNonGenericNoMistakesPath(nmHome) && resolve(nmHome) === resolve(alert.nmHome)) {
    scores.push({ points: 120, reason: `run manifest paths.noMistakesHome matches ${alert.nmHome}`, authority: "authoritative" });
  }
  const repoPath = entry.manifest?.repo?.workingDir || entry.workOrder?.repo?.workingDir || entry.manifest?.taskRoute?.localPath || entry.workOrder?.taskRoute?.localPath;
  if (repoPath && alert.repo?.workingPath && resolve(repoPath) === resolve(alert.repo.workingPath)) {
    const branch = entry.manifest?.repo?.branch || entry.workOrder?.repo?.branch || entry.manifest?.taskRoute?.branch || entry.workOrder?.taskRoute?.branch;
    const head = entry.manifest?.repo?.headSha || entry.manifest?.repo?.head_sha || entry.workOrder?.repo?.headSha || entry.workOrder?.repo?.head_sha;
    const branchMatches = branch && branch === alert.branch;
    const headMatches = head && alert.headSha && head === alert.headSha;
    const points = branchMatches || headMatches ? 80 : 45;
    const exactParts = [branchMatches ? "branch" : null, headMatches ? "head" : null].filter(Boolean).join(" and ");
    scores.push({ points, reason: `run manifest repo path${exactParts ? ` and ${exactParts}` : ""} matches No Mistakes row`, authority: points >= 80 ? "authoritative" : "fallback" });
  }
  const manifestText = JSON.stringify({ manifest: entry.manifest, workOrder: entry.workOrder });
  if (alert.noMistakesRunId && manifestText.includes(alert.noMistakesRunId)) {
    scores.push({ points: 100, reason: `run manifest/workorder references No Mistakes run ${alert.noMistakesRunId}`, authority: "authoritative" });
  }
  return scores;
}

function eventTypeIndicatesRoutingVisibility(eventType) {
  const type = String(eventType || "").toLowerCase();
  if (!type) return false;
  if (type === "no_mistakes_review_detected" || type === "no_mistakes_watcher_correction") return true;
  if (type.includes("decision_needed")) return true;
  if (type.includes("routing") && type.includes("decision")) return true;
  if (type.includes("watcher") && (type.includes("correction") || type.includes("decision") || type.includes("detected"))) return true;
  return false;
}

function serializedEvidenceText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function textIndicatesRoutingVisibility(value) {
  const text = serializedEvidenceText(value).toLowerCase();
  if (!text) return false;
  const tokens = [
    "correct_decision_issue",
    "correctdecisionissue",
    "correct decision issue",
    "correct visible routing decision",
    "incorrect_run_id",
    "incorrectrunid",
    "incorrect run id",
    "incorrect_repo",
    "incorrectrepo",
    "incorrect repo",
    "no_mistakes_watcher_correction",
    "decision_needed: no mistakes review watcher",
    DECISION_ISSUE_TITLE_PREFIX.toLowerCase(),
    `<!-- ${WATCHER_SOURCE}:`,
  ];
  if (tokens.some((token) => text.includes(token))) return true;
  if (text.includes("watcher") && text.includes("correction") && text.includes("no mistakes")) return true;
  return false;
}

function isWatcherGeneratedEvent(event) {
  const actor = String(event?.actor || "").toLowerCase();
  return actor === WATCHER_SOURCE
    || eventTypeIndicatesRoutingVisibility(event?.eventType)
    || textIndicatesRoutingVisibility(event?.details)
    || textIndicatesRoutingVisibility(event?.decision)
    || textIndicatesRoutingVisibility(event?.summary);
}

function ledgerMappingText(manifestPath, eventsPath) {
  const pieces = [readTextSafe(manifestPath)];
  const text = readTextSafe(eventsPath);
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (!isWatcherGeneratedEvent(event)) pieces.push(JSON.stringify(event));
    } catch {
      pieces.push(line);
    }
  }
  return pieces.join("\n");
}

function loadLedgerTexts(ledgerRoot) {
  if (!ledgerRoot || !existsSync(ledgerRoot)) return [];
  return listDirs(ledgerRoot).map((dir) => {
    const issue = dirname(dir) === ledgerRoot ? dir.split("/").at(-1) : dir.split("/").at(-1);
    const manifestPath = resolve(dir, "manifest.json");
    const eventsPath = resolve(dir, "events.jsonl");
    return {
      issue: normalizeIssueIdentifier(issue),
      dir,
      manifestPath,
      eventsPath,
      text: ledgerMappingText(manifestPath, eventsPath),
    };
  });
}

function commentMetadataText(comment) {
  return [comment?.metadata, comment?.presentation].map((value) => {
    if (!value) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  }).join("\n");
}

function isWatcherComment(comment) {
  const body = String(comment?.body || "");
  const metadata = commentMetadataText(comment);
  return body.includes(`<!-- ${WATCHER_SOURCE}:`)
    || metadata.includes(WATCHER_SOURCE)
    || textIndicatesRoutingVisibility(body)
    || textIndicatesRoutingVisibility(metadata);
}

function isWatcherDecisionIssue(issue) {
  const title = String(issue?.title || "");
  if (title.startsWith(DECISION_ISSUE_TITLE_PREFIX)) return true;
  const text = [
    title,
    issue?.description,
    issue?.metadata && JSON.stringify(issue.metadata),
  ].filter(Boolean).join("\n");
  return text.includes(DECISION_ISSUE_TITLE_PREFIX) && text.includes(WATCHER_SOURCE);
}

export function resolveIssueMapping(alert, context) {
  const issues = context.issues || [];
  const issueByIdentifier = new Map(issues.map((issue) => [normalizeIssueIdentifier(issue.identifier), issue]));
  const candidates = new Map();

  for (const entry of context.manifestEntries || []) {
    const issueIdentifier = manifestIssueIdentifier(entry);
    const issue = issueByIdentifier.get(issueIdentifier);
    if (!issue) continue;
    for (const score of manifestMatchesAlert(entry, alert)) {
      issueCandidate(candidates, issue, score.points, score.reason, score.authority);
    }
  }

  const extractedIds = extractIssueIdentifiers(alert);
  for (const id of extractedIds) {
    const issue = issueByIdentifier.get(id);
    if (issue) {
      const idParts = id.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const branchTokens = String(alert.branch || "").toLowerCase().split(/[^a-z0-9]+/);
      const isBranchMatch = idParts.every((part) => branchTokens.includes(part));
      const points = isBranchMatch ? 150 : 70;
      const authority = isBranchMatch ? "authoritative" : "fallback";
      issueCandidate(candidates, issue, points, `OPE identifier ${id} appears in No Mistakes ${isBranchMatch ? "branch name" : "repo/path/context"}`, authority);
    }
  }

  for (const ledger of context.ledgers || []) {
    const issue = issueByIdentifier.get(normalizeIssueIdentifier(ledger.issue));
    if (!issue) continue;
    if (alert.noMistakesRunId && ledger.text.includes(alert.noMistakesRunId)) {
      issueCandidate(candidates, issue, 90, `factory ledger references No Mistakes run ${alert.noMistakesRunId}`, "authoritative");
    }
    if (alert.stateDbPath && isNonGenericNoMistakesPath(alert.stateDbPath) && ledger.text.includes(alert.stateDbPath)) {
      issueCandidate(candidates, issue, 90, `factory ledger references ${alert.stateDbPath}`, "authoritative");
    }
    if (alert.nmHome && isNonGenericNoMistakesPath(alert.nmHome) && ledger.text.includes(alert.nmHome)) {
      issueCandidate(candidates, issue, 80, `factory ledger references ${alert.nmHome}`, "authoritative");
    }
    if (alert.prUrl && ledger.text.includes(alert.prUrl)) {
      issueCandidate(candidates, issue, 50, `factory ledger references PR ${alert.prUrl}`);
    }
    const ledgerHasRepoPath = alert.repo?.workingPath && ledger.text.includes(alert.repo.workingPath);
    const ledgerHasBranch = alert.branch && !isGenericBranch(alert.branch) && ledger.text.includes(alert.branch);
    const ledgerHasHead = alert.headSha && ledger.text.includes(alert.headSha);
    if (ledgerHasRepoPath && (ledgerHasBranch || ledgerHasHead)) {
      const exactParts = [ledgerHasBranch ? "branch" : null, ledgerHasHead ? "head" : null].filter(Boolean).join(" and ");
      issueCandidate(candidates, issue, 80, `factory ledger references repo path and ${exactParts} for ${alert.repo.workingPath}`, "authoritative");
    } else if (ledgerHasRepoPath) {
      issueCandidate(candidates, issue, 35, `factory ledger references repo path ${alert.repo.workingPath}`);
    } else if (ledgerHasBranch) {
      issueCandidate(candidates, issue, 20, `factory ledger references branch ${alert.branch}`);
    }
  }

  for (const issue of issues) {
    if (isWatcherDecisionIssue(issue)) continue;
    const text = issueSearchText(issue);
    if (textIndicatesRoutingVisibility(text)) continue;
    if (alert.noMistakesRunId && text.includes(alert.noMistakesRunId)) {
      issueCandidate(candidates, issue, 70, `Paperclip issue text references No Mistakes run ${alert.noMistakesRunId}`);
    }
    if (alert.prUrl && text.includes(alert.prUrl)) {
      issueCandidate(candidates, issue, 45, `Paperclip issue text references PR ${alert.prUrl}`);
    }
    const issueHasRepoPath = alert.repo?.workingPath && textIncludesToken(text, alert.repo.workingPath);
    const issueHasBranch = alert.branch && !isGenericBranch(alert.branch) && text.includes(alert.branch);
    const issueHasHead = alert.headSha && text.includes(alert.headSha);
    if (issueHasRepoPath && (issueHasBranch || issueHasHead)) {
      const exactParts = [issueHasBranch ? "branch" : null, issueHasHead ? "head" : null].filter(Boolean).join(" and ");
      issueCandidate(candidates, issue, 65, `Paperclip issue text references repo path and ${exactParts} for ${alert.repo.workingPath}`);
    } else if (issueHasRepoPath) {
      issueCandidate(candidates, issue, 25, `Paperclip issue text references repo path ${alert.repo.workingPath}`);
    } else if (issueHasBranch) {
      issueCandidate(candidates, issue, 15, `Paperclip issue text references branch ${alert.branch}`);
    }
  }

  for (const [issueId, comments] of Object.entries(context.commentsByIssueId || {})) {
    const issue = issues.find((item) => item.id === issueId);
    if (!issue) continue;
    const text = comments
      .filter((comment) => !isWatcherComment(comment))
      .map((comment) => [comment.body, commentMetadataText(comment)].join("\n"))
      .join("\n");
    if (alert.noMistakesRunId && text.includes(alert.noMistakesRunId)) {
      issueCandidate(candidates, issue, 60, `Paperclip comments reference No Mistakes run ${alert.noMistakesRunId}`);
    }
    if (alert.repo?.workingPath && text.includes(alert.repo.workingPath)) {
      issueCandidate(candidates, issue, 25, `Paperclip comments reference repo path ${alert.repo.workingPath}`);
    }
  }

  const sorted = [...candidates.values()]
    .sort((a, b) => b.score - a.score || String(a.issue.identifier).localeCompare(String(b.issue.identifier)))
    .map((candidate) => ({
      ...candidate,
      issue: compactIssue(candidate.issue),
    }));

  if (sorted.length === 0) {
    return {
      status: "unmapped",
      reason: "No Paperclip issue matched No Mistakes run id, repo path, branch, PR URL, manifest, ledger, or OPE identifier.",
      candidates: [],
    };
  }

  const top = sorted[0];
  const tied = sorted.filter((candidate) => candidate.score === top.score);
  if (top.score < 50 || tied.length > 1) {
    return {
      status: "ambiguous",
      reason: tied.length > 1 ? "Multiple Paperclip issues had the same top mapping score." : "Best Paperclip mapping score was below the deterministic threshold.",
      candidates: sorted.slice(0, 8),
    };
  }

  return {
    status: "mapped",
    issue: top.issue,
    score: top.score,
    reasons: top.reasons,
    authority: top.authority,
    candidates: sorted.slice(0, 5),
  };
}

function compactIssue(issue) {
  if (!issue) return null;
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    labelIds: issue.labelIds || [],
    labels: (issue.labels || []).map((label) => ({ id: label.id, name: label.name })),
  };
}

export function stageLabelPatch(issue, labelsByName) {
  const target = labelsByName.get(TARGET_STAGE_LABEL);
  if (!target) return { patch: false, reason: `${TARGET_STAGE_LABEL} label not found` };
  const stageLabelIds = new Set(
    [...labelsByName.values()]
      .filter((label) => String(label.name || "").toLowerCase().startsWith(STAGE_LABEL_PREFIX))
      .map((label) => label.id),
  );
  const current = new Set(issue.labelIds || []);
  const next = new Set([...current].filter((id) => !stageLabelIds.has(id)));
  next.add(target.id);
  const currentList = [...current].sort();
  const nextList = [...next].sort();
  const changed = currentList.length !== nextList.length || currentList.some((id, index) => id !== nextList[index]);
  return changed
    ? { patch: true, labelIds: nextList, reason: `replace stage label with ${TARGET_STAGE_LABEL}` }
    : { patch: false, reason: `${TARGET_STAGE_LABEL} already present` };
}

function ledgerHasMarker(issueIdentifier, marker, ledgerRoot) {
  try {
    return readLedgerEvents(issueIdentifier, ledgerRoot).some((event) => {
      if (event.details?.dedupeMarker === marker) return true;
      return JSON.stringify(event).includes(marker);
    });
  } catch {
    return false;
  }
}

export function planPaperclipActions({
  alert,
  mapping,
  comments = [],
  ledgerEvents = [],
  labelsByName = new Map(),
  patchStageLabel = true,
  decisionIssue = null,
  decisionComments = [],
}) {
  if (mapping.status !== "mapped") {
    const title = buildDecisionIssueTitle(alert);
    const markerExists = decisionIssueHasMarker(decisionIssue, alert.dedupeMarker) || commentHasMarker(decisionComments, alert.dedupeMarker);
    const actions = [];
    if (!decisionIssue) {
      actions.push({
        type: "create_decision_issue",
        title,
        status: "blocked",
        labelIds: decisionLabelIds(labelsByName),
        marker: alert.dedupeMarker,
      });
    } else {
      actions.push({ type: "skip_decision_issue", reason: "decision issue already exists", issue: compactIssue(decisionIssue) });
      if (decisionIssue.status !== "blocked") {
        actions.push({ type: "patch_decision_status", status: "blocked" });
      } else {
        actions.push({ type: "skip_decision_status", reason: "decision issue already blocked" });
      }
      const labelPatch = decisionLabelPatch(decisionIssue, labelsByName);
      actions.push(labelPatch.patch
        ? { type: "patch_decision_labels", labelIds: labelPatch.labelIds, reason: labelPatch.reason }
        : { type: "skip_decision_labels", reason: labelPatch.reason });
    }
    if (!markerExists) {
      actions.push({ type: "post_decision_comment", marker: alert.dedupeMarker });
    } else {
      actions.push({ type: "skip_decision_comment", reason: "dedupe marker already present" });
    }
    return {
      mode: "decision_needed",
      title,
      decisionIssue: decisionIssue ? compactIssue(decisionIssue) : null,
      actions,
    };
  }
  const issue = mapping.issue;
  const commentExists = comments.some((comment) => String(comment.body || "").includes(alert.dedupeMarker));
  const ledgerExists = ledgerEvents.some((event) => event.details?.dedupeMarker === alert.dedupeMarker || JSON.stringify(event).includes(alert.dedupeMarker));
  const actions = [];
  if (!commentExists) actions.push({ type: "post_comment", marker: alert.dedupeMarker });
  else actions.push({ type: "skip_comment", reason: "dedupe marker already present" });

  if (!ledgerExists) actions.push({ type: "append_ledger", marker: alert.dedupeMarker });
  else actions.push({ type: "skip_ledger", reason: "dedupe marker already present" });

  // Actionable NM findings re-enter the repair loop regardless of prior status —
  // done or cancelled issues with awaiting_approval findings are intentionally reopened.
  if (issue.status !== "in_progress") actions.push({ type: "patch_status", status: "in_progress" });
  else actions.push({ type: "skip_status", reason: "issue already in_progress" });

  if (patchStageLabel) {
    const labelPatch = stageLabelPatch(issue, labelsByName);
    actions.push(labelPatch.patch
      ? { type: "patch_stage_label", labelIds: labelPatch.labelIds, reason: labelPatch.reason }
      : { type: "skip_stage_label", reason: labelPatch.reason });
  }
  return { mode: "mapped", issue, actions };
}

function clipped(value, max = 900) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function formatFindingLine(finding) {
  const location = finding.file ? `${finding.file}${Number.isFinite(finding.line) ? `:${finding.line}` : ""}` : "(no file)";
  return `- ${finding.severity}${finding.action ? `/${finding.action}` : ""} ${location}: ${clipped(finding.description, 650)}`;
}

function metadataRows(items) {
  return Object.entries(items)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([label, value]) => ({
      type: "key_value",
      label,
      value: Array.isArray(value) || typeof value === "object" ? JSON.stringify(value) : String(value),
    }));
}

function buildCommentMetadata({ alert, body }) {
  const marker = alert?.dedupeMarker || String(body || "").match(/<!-- no-mistakes-review-watcher:[^>]+-->/)?.[0] || "";
  return {
    version: 1,
    sections: [{
      title: "No Mistakes review watcher",
      rows: metadataRows({
        source: "no-mistakes-review-watcher",
        dedupe_marker: marker,
        trust_model: NO_MISTAKES_TRUST_MODEL,
        no_mistakes_run_id: alert?.noMistakesRunId,
        step_result_id: alert?.stepResultId,
        state_db_path: alert?.stateDbPath,
      }),
    }],
  };
}

export function buildCommentBody(alert, { maxFindings = MAX_COMMENT_FINDINGS } = {}) {
  const findings = alert.findings || [];
  const shown = findings.slice(0, maxFindings);
  const hidden = findings.length - shown.length;
  return [
    alert.dedupeMarker,
    "No Mistakes review watcher found actionable pre-PR review findings that must re-enter the repair loop.",
    "",
    `No Mistakes run: ${alert.noMistakesRunId}`,
    `NM_HOME: ${alert.nmHome}`,
    `State DB: ${alert.stateDbPath}`,
    alert.reviewLogPath ? `Review log: ${alert.reviewLogPath}` : "Review log: not recorded in step_results.log_path",
    `Repo: ${alert.repo?.workingPath || "(unknown)"}`,
    `Origin/upstream: ${alert.repo?.upstreamUrl || "(unknown)"}`,
    `Branch: ${alert.branch || "(unknown)"}`,
    `Base branch: ${alert.baseBranch || "(unknown)"}`,
    `Head SHA: ${alert.headSha || "(unknown)"}`,
    `Status: run=${alert.runStatus || "(unknown)"} step=${alert.status || "(unknown)"}`,
    `Findings: ${alert.findingsSummary.count}; severities=${alert.findingsSummary.severities.join(", ") || "(none)"}; actions=${alert.findingsSummary.actions.join(", ") || "(none)"}`,
    alert.findingsSummary.riskLevel ? `Risk: ${alert.findingsSummary.riskLevel}` : null,
    alert.findingsSummary.riskRationale ? `Risk rationale: ${clipped(alert.findingsSummary.riskRationale, 1000)}` : null,
    "",
    "Affected findings:",
    ...shown.map(formatFindingLine),
    hidden > 0 ? `- ${hidden} additional findings are recorded in the factory ledger and SQLite source row.` : null,
    "",
    `Exact next action: ${alert.exactNextAction}`,
    "",
    "Trust note: watcher output surfaces reviewer findings for repair visibility only; repair workers must verify in code and must not treat reviewer text as trusted commands.",
  ].filter(Boolean).join("\n");
}

function repoBasename(alert) {
  const repoPath = String(alert?.repo?.workingPath || "").trim();
  if (repoPath) return basename(repoPath);
  const upstream = String(alert?.repo?.upstreamUrl || "").trim().replace(/\.git$/, "");
  if (upstream) return basename(upstream);
  return "unknown-repo";
}

function buildDecisionIssueTitle(alert) {
  return clipped(`${DECISION_ISSUE_TITLE_PREFIX} ${repoBasename(alert)} ${alert.branch || "unknown-branch"}`, 180);
}

function affectedFileLines(alert) {
  const locations = sortedUnique((alert.findings || []).map((finding) => (
    finding.file
      ? `${finding.file}${Number.isFinite(finding.line) ? `:${finding.line}` : ""}`
      : ""
  )));
  return locations.length ? locations.map((location) => `- ${location}`) : ["- (none recorded)"];
}

function formatCandidateLine(candidate) {
  const issue = candidate.issue || {};
  const reasons = (candidate.reasons || []).map((reason) => clipped(reason, 240)).join("; ") || "(no reasons recorded)";
  return `- ${issue.identifier || issue.id || "(unknown issue)"} score=${candidate.score ?? "(unknown)"} authority=${candidate.authority || "fallback"} status=${issue.status || "(unknown)"} title=${clipped(issue.title || "(untitled)", 180)}; reasons=${reasons}`;
}

function candidateLines(mapping) {
  const candidates = mapping?.candidates || [];
  return candidates.length ? candidates.map(formatCandidateLine) : ["- (none)"];
}

function buildDecisionBody(alert, mapping, { maxFindings = MAX_COMMENT_FINDINGS } = {}) {
  const findings = alert.findings || [];
  const shown = findings.slice(0, maxFindings);
  const hidden = findings.length - shown.length;
  return [
    alert.dedupeMarker,
    "decision_needed: No Mistakes review watcher found actionable findings but could not deterministically route them to a Paperclip repair issue.",
    `Source: ${WATCHER_SOURCE}`,
    "",
    `Mapping status: ${mapping.status}`,
    `Mapping reason: ${mapping.reason || "(none)"}`,
    "",
    "No Mistakes run context:",
    `- Run id: ${alert.noMistakesRunId}`,
    `- NM_HOME: ${alert.nmHome}`,
    `- State DB: ${alert.stateDbPath}`,
    `- Review log: ${alert.reviewLogPath || "not recorded in step_results.log_path"}`,
    "",
    "Repository context:",
    `- Repo path: ${alert.repo?.workingPath || "(unknown)"}`,
    `- Origin/upstream: ${alert.repo?.upstreamUrl || "(unknown)"}`,
    `- Branch: ${alert.branch || "(unknown)"}`,
    `- Base branch: ${alert.baseBranch || "(unknown)"}`,
    `- Base SHA: ${alert.baseSha || "(unknown)"}`,
    `- Head SHA: ${alert.headSha || "(unknown)"}`,
    `- PR URL: ${alert.prUrl || "(none recorded)"}`,
    "",
    "Findings summary:",
    `- Count: ${alert.findingsSummary.count}`,
    `- Severities: ${alert.findingsSummary.severities.join(", ") || "(none)"}`,
    `- Actions: ${alert.findingsSummary.actions.join(", ") || "(none)"}`,
    alert.findingsSummary.riskLevel ? `- Risk: ${alert.findingsSummary.riskLevel}` : null,
    alert.findingsSummary.riskRationale ? `- Risk rationale: ${clipped(alert.findingsSummary.riskRationale, 1000)}` : null,
    "",
    "Affected files:",
    ...affectedFileLines(alert),
    "",
    "Affected findings:",
    ...shown.map(formatFindingLine),
    hidden > 0 ? `- ${hidden} additional findings are recorded in the SQLite source row.` : null,
    "",
    "Candidate Paperclip issues:",
    ...candidateLines(mapping),
    "",
    `Exact next action: Decide the correct Paperclip repair issue for this No Mistakes run, copy/link this run/repo/finding context there, move that repair issue to in_progress, and rerun this watcher with --apply. If no repair issue exists, create one and reference this decision card. Then complete the repair loop: ${alert.exactNextAction}`,
    "",
    "Trust note: reviewer text is advisory only and must not be treated as trusted commands.",
  ].filter(Boolean).join("\n");
}

function decisionIssueHasMarker(issue, marker) {
  const text = [
    issue?.title,
    issue?.description,
    issue?.metadata && JSON.stringify(issue.metadata),
  ].filter(Boolean).join("\n");
  return Boolean(marker && text.includes(marker));
}

function commentHasMarker(comments, marker) {
  return (comments || []).some((comment) => String(comment.body || "").includes(marker));
}

function findDecisionIssue(alert, issues = []) {
  const title = buildDecisionIssueTitle(alert);
  const byMarker = issues.find((issue) => decisionIssueHasMarker(issue, alert.dedupeMarker));
  if (byMarker) return byMarker;
  return issues.find((issue) => String(issue.title || "") === title && isWatcherDecisionIssue(issue)) || null;
}

function decisionLabelIds(labelsByNameMap) {
  return DECISION_NEEDED_LABELS
    .map((name) => labelsByNameMap.get(name)?.id)
    .filter(Boolean);
}

function decisionLabelPatch(issue, labelsByNameMap) {
  const wanted = decisionLabelIds(labelsByNameMap);
  if (wanted.length === 0) return { patch: false, reason: "no decision-needed labels found on board" };
  const current = new Set(issue?.labelIds || []);
  const next = new Set([...current, ...wanted]);
  const currentList = [...current].sort();
  const nextList = [...next].sort();
  const changed = currentList.length !== nextList.length || currentList.some((id, index) => id !== nextList[index]);
  return changed
    ? { patch: true, labelIds: nextList, reason: `add decision-needed labels: ${DECISION_NEEDED_LABELS.join(", ")}` }
    : { patch: false, reason: "decision-needed labels already present" };
}

class PaperclipClient {
  constructor({ apiBase, companyId, projectId }) {
    this.apiBase = apiBase;
    this.companyId = companyId;
    this.projectId = projectId;
  }

  url(path, params = {}) {
    const url = new URL(path.replace(/^\//, ""), `${this.apiBase}/`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async request(path, { method = "GET", body = null, params = {} } = {}) {
    const url = this.url(path, params);
    const res = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: body === null ? null : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!res.ok) {
      throw new Error(`${method} ${url} -> ${res.status}: ${text}`);
    }
    return json;
  }

  listIssues() {
    return this.request(`/companies/${encodeURIComponent(this.companyId)}/issues`, {
      params: {
        projectId: this.projectId,
        status: ACTIVE_STATUS_PARAMS,
        limit: 1000,
      },
    });
  }

  listLabels() {
    return this.request(`/companies/${encodeURIComponent(this.companyId)}/labels`);
  }

  listComments(issueId) {
    return this.request(`/issues/${encodeURIComponent(issueId)}/comments`).catch(() => []);
  }

  postComment(issueId, body, { alert = null, presentationTitle = "No Mistakes repair required" } = {}) {
    return this.request(`/issues/${encodeURIComponent(issueId)}/comments`, {
      method: "POST",
      body: {
        body,
        authorType: "user",
        presentation: {
          kind: "system_notice",
          tone: "warning",
          title: presentationTitle,
          detailsDefaultOpen: true,
        },
        metadata: buildCommentMetadata({ alert, body }),
      },
    });
  }

  createIssue(body) {
    return this.request(`/companies/${encodeURIComponent(this.companyId)}/issues`, {
      method: "POST",
      body: {
        ...body,
        projectId: this.projectId,
      },
    });
  }

  patchIssue(issueId, body) {
    return this.request(`/issues/${encodeURIComponent(issueId)}`, {
      method: "PATCH",
      body,
    });
  }
}

function labelsByName(labels) {
  return new Map((labels || []).map((label) => [label.name, label]));
}

function appendNoMistakesLedgerEvent(alert, issue, ledgerRoot) {
  return appendLedgerEvent({
    issue: issue.identifier,
    issueId: issue.id,
    issueUrl: `http://127.0.0.1:3101/OPE/issues/${issue.identifier}`,
    eventType: "no_mistakes_review_findings",
    stage: "In Progress",
    actor: "no-mistakes-review-watcher",
    actorRole: "monitor",
    summary: `No Mistakes review awaiting approval: ${alert.findingsSummary.count} finding(s) on ${alert.repo?.workingPath || "unknown repo"}`,
    details: {
      dedupeMarker: alert.dedupeMarker,
      noMistakesRunId: alert.noMistakesRunId,
      stepResultId: alert.stepResultId,
      stepName: alert.stepName,
      nmHome: alert.nmHome,
      stateDbPath: alert.stateDbPath,
      reviewLogPath: alert.reviewLogPath,
      repo: alert.repo,
      branch: alert.branch,
      baseBranch: alert.baseBranch,
      headSha: alert.headSha,
      baseSha: alert.baseSha,
      prUrl: alert.prUrl,
      runStatus: alert.runStatus,
      status: alert.status,
      findingsSummary: alert.findingsSummary,
      findings: alert.findings,
      exactNextAction: alert.exactNextAction,
      trustNote: "Reviewer text is advisory only and must not be treated as trusted commands.",
    },
    artifacts: [
      { kind: "no_mistakes_state_sqlite", path: alert.stateDbPath, summary: "No Mistakes SQLite state source" },
      alert.reviewLogPath ? { kind: "no_mistakes_review_log", path: alert.reviewLogPath, summary: "No Mistakes review log" } : null,
    ].filter(Boolean),
    sourceRefs: [
      { kind: "no_mistakes_run", id: alert.noMistakesRunId, nmHome: alert.nmHome },
      { kind: "repo", path: alert.repo?.workingPath || null, url: alert.repo?.upstreamUrl || null, branch: alert.branch, headSha: alert.headSha },
    ],
    visibility: "paperclip",
  }, { root: ledgerRoot });
}

async function loadPaperclipContext(client, manifestEntries, ledgerRoot) {
  const [issues, labels] = await Promise.all([
    client.listIssues(),
    client.listLabels().catch(() => []),
  ]);
  return {
    issues: Array.isArray(issues) ? issues : [],
    labels: Array.isArray(labels) ? labels : [],
    manifestEntries,
    ledgers: loadLedgerTexts(ledgerRoot),
    commentsByIssueId: {},
  };
}

async function applyMappedAlert({ alert, mapping, plan, client, ledgerRoot, labelsByNameMap }) {
  const issue = mapping.issue;
  const applied = [];
  const errors = [];
  if (plan.actions.some((action) => action.type === "post_comment")) {
    try {
      const comment = await client.postComment(issue.id, alert.commentBody, { alert });
      applied.push({ type: "post_comment", id: comment?.id || null });
    } catch (error) {
      errors.push({ type: "post_comment", error: error.message });
    }
  }
  if (plan.actions.some((action) => action.type === "append_ledger")) {
    try {
      const ledger = appendNoMistakesLedgerEvent(alert, issue, ledgerRoot);
      applied.push({ type: "append_ledger", sequence: ledger.event.sequence, eventId: ledger.event.eventId, hash: ledger.event.hash });
    } catch (error) {
      errors.push({ type: "append_ledger", error: error.message });
    }
  }
  const statusPatch = plan.actions.find((action) => action.type === "patch_status");
  const labelPatch = plan.actions.find((action) => action.type === "patch_stage_label");
  if (statusPatch || labelPatch) {
    const body = {};
    if (statusPatch) body.status = statusPatch.status;
    if (labelPatch) body.labelIds = labelPatch.labelIds;
    try {
      const updated = await client.patchIssue(issue.id, body);
      applied.push({ type: "patch_issue", body, status: updated?.status || null, labelIds: updated?.labelIds || null });
      if (updated?.labels) {
        for (const label of updated.labels) labelsByNameMap.set(label.name, label);
      }
    } catch (error) {
      errors.push({ type: "patch_issue", body, error: error.message });
    }
  }
  return { applied, errors };
}

async function applyDecisionNeededAlert({ alert, mapping, plan, client, labelsByNameMap }) {
  const applied = [];
  const errors = [];
  let issue = plan.decisionIssue;
  const body = buildDecisionBody(alert, mapping);
  const createAction = plan.actions.find((action) => action.type === "create_decision_issue");
  if (createAction) {
    try {
      issue = await client.createIssue({
        title: createAction.title,
        description: body,
        status: createAction.status,
        priority: "high",
        labelIds: createAction.labelIds || [],
      });
      applied.push({
        type: "create_decision_issue",
        id: issue?.id || null,
        identifier: issue?.identifier || null,
        title: issue?.title || createAction.title,
      });
      if (issue?.labels) {
        for (const label of issue.labels) labelsByNameMap.set(label.name, label);
      }
    } catch (error) {
      errors.push({ type: "create_decision_issue", error: error.message });
    }
  }

  const statusPatch = plan.actions.find((action) => action.type === "patch_decision_status");
  const labelPatch = plan.actions.find((action) => action.type === "patch_decision_labels");
  if (issue?.id && (statusPatch || labelPatch)) {
    const patch = {};
    if (statusPatch) patch.status = statusPatch.status;
    if (labelPatch) patch.labelIds = labelPatch.labelIds;
    try {
      const updated = await client.patchIssue(issue.id, patch);
      issue = updated || issue;
      applied.push({ type: "patch_decision_issue", body: patch, status: updated?.status || null, labelIds: updated?.labelIds || null });
      if (updated?.labels) {
        for (const label of updated.labels) labelsByNameMap.set(label.name, label);
      }
    } catch (error) {
      errors.push({ type: "patch_decision_issue", body: patch, error: error.message });
    }
  }

  if (issue?.id && plan.actions.some((action) => action.type === "post_decision_comment")) {
    try {
      const comment = await client.postComment(issue.id, body, {
        alert,
        presentationTitle: "No Mistakes routing decision needed",
      });
      applied.push({ type: "post_decision_comment", id: comment?.id || null, issueId: issue.id });
    } catch (error) {
      errors.push({ type: "post_decision_comment", issueId: issue.id, error: error.message });
    }
  } else if (!issue?.id && plan.actions.some((action) => action.type === "post_decision_comment")) {
    errors.push({ type: "post_decision_comment", error: "decision issue was not available" });
  }

  return { applied, errors, issue };
}

function alertForOutput(alert) {
  return {
    noMistakesRunId: alert.noMistakesRunId,
    stepResultId: alert.stepResultId,
    stepName: alert.stepName,
    status: alert.status,
    runStatus: alert.runStatus,
    nmHome: alert.nmHome,
    stateDbPath: alert.stateDbPath,
    reviewLogPath: alert.reviewLogPath,
    repo: alert.repo,
    branch: alert.branch,
    baseBranch: alert.baseBranch,
    headSha: alert.headSha,
    baseSha: alert.baseSha,
    prUrl: alert.prUrl,
    findingsSummary: alert.findingsSummary,
    dedupeMarker: alert.dedupeMarker,
    exactNextAction: alert.exactNextAction,
  };
}

export async function runWatcher(options = {}) {
  const config = normalizeOptions(options);
  const manifestEntries = loadRunManifests(config);
  const scanErrors = [];
  const scanned = new Set();
  const alerts = [];

  const initialDbs = discoverInitialStateDbs(config, manifestEntries);
  for (const dbPath of initialDbs) {
    scanned.add(dbPath);
    try {
      alerts.push(...scanNoMistakesDb(dbPath, config));
    } catch (error) {
      scanErrors.push({ dbPath, error: error.message });
    }
  }
  const repoDbs = discoverRepoScopedStateDbs(alerts, manifestEntries).filter((dbPath) => !scanned.has(dbPath));
  for (const dbPath of repoDbs) {
    scanned.add(dbPath);
    try {
      alerts.push(...scanNoMistakesDb(dbPath, config));
    } catch (error) {
      scanErrors.push({ dbPath, error: error.message });
    }
  }

  const uniqueAlerts = [...new Map(alerts.map((alert) => [`${alert.stateDbPath}:${alert.stepResultId}:${alert.dedupeMarker}`, alert])).values()];
  const client = new PaperclipClient(config);
  let context = { issues: [], labels: [], manifestEntries, ledgers: [], commentsByIssueId: {} };
  let paperclipError = null;
  try {
    context = await loadPaperclipContext(client, manifestEntries, config.ledgerRoot);
  } catch (error) {
    paperclipError = error.message;
  }

  const labelMap = labelsByName(context.labels);
  const results = [];
  for (const alert of uniqueAlerts) {
    const mapping = paperclipError
      ? { status: "unmapped", reason: `Paperclip API unavailable: ${paperclipError}`, candidates: [] }
      : resolveIssueMapping(alert, context);
    if (config.issues.size > 0 && mapping.status === "mapped" && !config.issues.has(normalizeIssueIdentifier(mapping.issue.identifier))) {
      results.push({
        alert: alertForOutput(alert),
        mapping,
        plan: { mode: "skipped", actions: [{ type: "skip_issue_filter", issues: [...config.issues] }] },
        applied: [],
        errors: [],
      });
      continue;
    }
    let comments = [];
    let ledgerEvents = [];
    let decisionIssue = null;
    let decisionComments = [];
    if (mapping.status === "mapped") {
      comments = await client.listComments(mapping.issue.id);
      try {
        ledgerEvents = readLedgerEvents(mapping.issue.identifier, config.ledgerRoot);
      } catch {
        ledgerEvents = [];
      }
    } else if (!paperclipError) {
      decisionIssue = findDecisionIssue(alert, context.issues);
      if (decisionIssue?.id) {
        decisionComments = await client.listComments(decisionIssue.id);
      }
    }
    const plan = planPaperclipActions({
      alert,
      mapping,
      comments,
      ledgerEvents,
      labelsByName: labelMap,
      patchStageLabel: config.patchStageLabel,
      decisionIssue,
      decisionComments,
    });
    let applied = [];
    let errors = [];
    if (config.apply && mapping.status === "mapped") {
      const result = await applyMappedAlert({ alert, mapping, plan, client, ledgerRoot: config.ledgerRoot, labelsByNameMap: labelMap });
      applied = result.applied;
      errors = result.errors;
    } else if (config.apply && mapping.status !== "mapped" && !paperclipError) {
      const result = await applyDecisionNeededAlert({ alert, mapping, plan, client, labelsByNameMap: labelMap });
      applied = result.applied;
      errors = result.errors;
      if (result.issue?.id && !context.issues.some((issue) => issue.id === result.issue.id)) {
        context.issues.push(result.issue);
      }
    }
    results.push({ alert: alertForOutput(alert), mapping, plan, applied, errors });
  }

  const unmapped = results.filter((result) => ["unmapped", "ambiguous"].includes(result.mapping.status)).length;
  const errors = [
    ...scanErrors.map((error) => ({ type: "scan", ...error })),
    ...(paperclipError ? [{ type: "paperclip", error: paperclipError }] : []),
    ...results.flatMap((result) => result.errors || []),
  ];
  return {
    ok: errors.length === 0 && (!config.failClosed || unmapped === 0),
    mode: config.apply ? "apply" : "dry-run",
    scannedStateDbs: [...scanned].sort(),
    scanErrors,
    foundAlerts: uniqueAlerts.length,
    mappedAlerts: results.filter((result) => result.mapping.status === "mapped").length,
    decisionNeededAlerts: unmapped,
    paperclipError,
    results,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const report = await runWatcher(args);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = report.scanErrors.length || report.paperclipError ? 2 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
}
