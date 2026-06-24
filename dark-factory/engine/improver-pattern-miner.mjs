#!/usr/bin/env node

/**
 * improver-pattern-miner.mjs
 *
 * Cross-run pattern detection for the Dark Factory improver subsystem.
 *
 * Samuel's intent: the improvers must WATCH everything moving through the factory
 * and, when the SAME problem recurs (an agent making the same mistake, a gate that
 * keeps failing, repeated timeouts/breakages, the same PR-review comment coming
 * back), file an improvement ticket with a suggested fix. The existing tooling
 * records per-run lessons and per-issue blockers but never COMPUTES recurrence
 * across distinct runs, so nothing ever notices "this keeps happening".
 *
 * This tool reads the factory run ledgers (the canonical, hash-chained event
 * record) plus captured PR-review-comment evidence, normalises failures into
 * stable classes, and clusters them across DISTINCT issues/PRs. When a class
 * recurs at or above the threshold it (optionally) files a deduplicated
 * `repeated_pattern` improvement report via create-improvement-report.mjs.
 *
 * Read-only by default. Use --file-tickets to actually create improvement
 * reports (deduplicated via a local state file). Folder-scoped: touches only
 * this factory's ledger/runs/state and the local Paperclip API. No global state.
 *
 * Usage:
 *   node tools/dark-factory/improver-pattern-miner.mjs --format text
 *   node tools/dark-factory/improver-pattern-miner.mjs --min-issues 3 --format json
 *   node tools/dark-factory/improver-pattern-miner.mjs --file-tickets
 */

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEDGER_ROOT = process.env.FACTORY_LEDGER_DIR || resolve(__dirname, "../paperclip-data/factory-run-ledgers");
const RUNS_ROOT = process.env.FACTORY_RUNS_DIR || resolve(__dirname, "../pi-vs-claude-code/.pi/openclaw-teams/runs");
const STATE_PATH = process.env.PATTERN_MINER_STATE || resolve(__dirname, "../paperclip-data/improver-pattern-miner-state.json");
const CREATE_REPORT = resolve(__dirname, "../paperclip-board/create-improvement-report.mjs");

// A failure class is a stable, human-readable bucket. Keyed first off structured
// gate results, then off the (sadly free-text) eventType taxonomy via keywords.
const KEYWORD_CLASSES = [
  [/no[_-]?mistakes/i, "gate:no_mistakes"],
  [/\b(coderabbit|reviewer|claude_review|review_failed|review_usage)\b/i, "review:reviewer-feedback"],
  [/\bsecurity\b/i, "gate:security"],
  [/\b(browser_qa|visual_qa|webwright|playwright)\b/i, "gate:browser_qa"],
  [/\b(test|regression|oracle)\b/i, "gate:tests"],
  [/\b(timeout|timed_out|unresponsive|did not become respon)\b/i, "infra:timeout"],
  [/\b(quota|capacity|rate.?limit|usage_blocked|model_capacity)\b/i, "infra:model-capacity"],
  [/\b(dependency|supply.?chain)\b/i, "blocker:dependency"],
  [/\b(pr_identity|pr32_merge|merge_permission|repo_ruleset|identity)\b/i, "blocker:pr-identity"],
  [/\b(evidence|missing evidence|logging gap)\b/i, "gate:evidence"],
  [/\b(publish|metadata|versioned_delivery|packaging)\b/i, "blocker:publish-metadata"],
  [/\b(disk|enospc|no space|runaway log)\b/i, "infra:disk"],
  [/\bplan(ning)?_(blocked|blocker|review)\b/i, "blocker:planning"],
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) { out[key] = "true"; continue; }
    out[key] = next; i += 1;
  }
  return out;
}

function readState() {
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { return { filed: {} }; }
}
function writeState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function listIssueDirs() {
  try {
    return readdirSync(LEDGER_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch { return []; }
}

function readEvents(issueDir) {
  const path = join(LEDGER_ROOT, issueDir, "events.jsonl");
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip malformed */ }
  }
  return out;
}

function isFailureEvent(eventType, details) {
  const et = String(eventType || "").toLowerCase();
  if (et === "gate_result") {
    const verdict = String((details && details.verdict) || "").toUpperCase();
    return verdict === "FAIL" || verdict === "BLOCKED" || verdict === "BLOCK";
  }
  // Real failure/blocker/timeout signals. Exclude the recovery/triage verbs so
  // routine unblocking activity is not counted as a fresh failure.
  if (/(unblock|resolved|cleared|repaired|restored|confirmed_pass|pass)/.test(et)) return false;
  return /(block|fail|timeout|timed_out|blocker|stuck|crash|error|quota|capacity)/.test(et);
}

function classify(eventType, details, summary) {
  const et = String(eventType || "");
  if (et.toLowerCase() === "gate_result" && details && details.gate) {
    return `gate:${String(details.gate).toLowerCase()}`;
  }
  const haystack = `${et} ${summary || ""}`;
  for (const [re, cls] of KEYWORD_CLASSES) {
    if (re.test(haystack)) return cls;
  }
  // Generic blocker fallback keyed by a cleaned eventType stem so unknown but
  // recurring blocker types still cluster instead of vanishing.
  if (/(block|blocker)/i.test(et)) return "blocker:other";
  if (/(fail|error|crash)/i.test(et)) return "failure:other";
  if (/(timeout|timed_out|unresponsive)/i.test(et)) return "infra:timeout";
  return null;
}

function mineLedgers() {
  const byClass = new Map(); // class -> { issues:Set, roles:Map(role->Set(issues)), samples:[] }
  for (const issueDir of listIssueDirs()) {
    const issue = issueDir;
    for (const e of readEvents(issueDir)) {
      const details = (e && typeof e.details === "object") ? e.details : {};
      if (!isFailureEvent(e.eventType, details)) continue;
      const cls = classify(e.eventType, details, e.summary);
      if (!cls) continue;
      const role = String(e.actorRole || "unknown");
      if (!byClass.has(cls)) byClass.set(cls, { issues: new Set(), roles: new Map(), samples: [] });
      const rec = byClass.get(cls);
      rec.issues.add(issue);
      if (!rec.roles.has(role)) rec.roles.set(role, new Set());
      rec.roles.get(role).add(issue);
      if (rec.samples.length < 5) {
        rec.samples.push({ issue, role, eventType: e.eventType, summary: String(e.summary || "").slice(0, 160) });
      }
    }
  }
  return byClass;
}

function walkFiles(root, depth, matcher, out = []) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) { if (depth > 0) walkFiles(full, depth - 1, matcher, out); }
    else if (entry.isFile() && matcher(entry.name)) out.push(full);
  }
  return out;
}

// Best-effort PR-review-comment recurrence from captured evidence files.
// Persistence of fresh comments is a separate fix; this mines what exists today.
function minePrComments() {
  const files = walkFiles(RUNS_ROOT, 5, (n) => /pr-.*comment.*\.txt$/i.test(n));
  const byTheme = new Map(); // normalizedTheme -> Set(prFile)
  for (const file of files) {
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    const prKey = file.split("/").slice(-3).join("/");
    const seenInThisPr = new Set();
    for (const line of text.split("\n")) {
      const norm = line
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, "")
        .replace(/[`'"]/g, "")
        .replace(/\b[0-9a-f]{7,40}\b/g, "")
        .replace(/\d+/g, "#")
        .replace(/\s+/g, " ")
        .trim();
      // Only consider substantive review-comment-like lines.
      if (norm.length < 25 || norm.length > 200) continue;
      if (!/(should|must|avoid|missing|consider|prefer|use |remove|rename|nit:|potential|vulnerab|inject|unsafe|null|undefined|type|lint)/.test(norm)) continue;
      if (seenInThisPr.has(norm)) continue;
      seenInThisPr.add(norm);
      if (!byTheme.has(norm)) byTheme.set(norm, new Set());
      byTheme.get(norm).add(prKey);
    }
  }
  return byTheme;
}

function suggestFix(cls) {
  const map = {
    "gate:no_mistakes": "The no-mistakes gate keeps failing pre-PR. Investigate the top recurring failure reason (daemon start/responsiveness, lint/type, or a specific rule) and either fix the upstream cause in the implementer prompt/skill or harden the gate runner so the same exit-1 stops recurring.",
    "gate:tests": "Tests/oracles keep failing. Add the recurring expected-vs-actual mismatch as a standing check in the test-engineer prompt or a pre-PR fixture so implementers catch it before the gate.",
    "gate:browser_qa": "Browser/visual QA keeps blocking. Capture the recurring cause (auth/session fixture, viewport, selector) into the browser-qa protocol so it stops repeating.",
    "gate:security": "Security review keeps blocking. Fold the recurring finding class into the security-scan checklist and the implementer prompt so it is prevented, not re-found.",
    "gate:evidence": "Evidence checks keep failing (often missing improver_review). Make the missing evidence item part of the standard run checklist so it is never omitted.",
    "infra:timeout": "Repeated timeouts. Add a bounded retry/timeout and a heartbeat so a hung subprocess is detected and retried instead of stalling the run.",
    "infra:model-capacity": "Repeated model quota/capacity blockers. Add a provider/model failover or backoff so capacity limits do not block runs.",
    "infra:disk": "Repeated disk/log pressure. Cap log writers at source and add proactive cleanup; do not pipe interactive TUIs to files.",
    "review:reviewer-feedback": "The same reviewer/CodeRabbit feedback recurs across PRs. Encode the rule as a pre-PR check or prompt guardrail so it is fixed before review.",
    "blocker:pr-identity": "Repeated PR identity/merge-permission blockers. Fix the git auth/identity routing once so pushes/merges stop blocking.",
    "blocker:dependency": "Repeated dependency blockers. Add a dependency pre-check to planning so the blocker is surfaced before implementation.",
  };
  return map[cls] || `The failure class "${cls}" recurs across multiple runs. Diagnose the shared root cause and apply a factory-level fix (prompt, gate, skill, or tooling) so it stops recurring.`;
}

function fileTicket(pattern, dryRun) {
  const args = [
    CREATE_REPORT,
    "--source", "OPE-279",
    "--title", `Recurring factory pattern: ${pattern.signatureTitle}`,
    "--pattern", "repeated_pattern",
    "--target", pattern.target,
    "--priority", "high",
    "--summary", pattern.summary,
    "--suggestion", pattern.suggestion,
    "--benefit", "Stops the same failure recurring across runs, moving the factory toward shipping clean PRs without repeat blockers.",
    "--next-action", "Improver/Samuel: triage this recurring pattern and apply the factory-level fix (prompt, gate, skill, or tooling).",
    "--approval", "skill_proposal",
  ];
  if (dryRun) args.push("--dry-run");
  const res = spawnSync(process.execPath, args, { encoding: "utf8" });
  return { status: res.status, stdout: (res.stdout || "").trim(), stderr: (res.stderr || "").trim() };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const minIssues = Number(args["min-issues"] || 3);
  const minRoleIssues = Number(args["min-role-issues"] || 3);
  const minPr = Number(args["min-pr"] || 2);
  const fileTickets = args["file-tickets"] === "true";
  const dryRun = args["dry-run"] === "true";
  const format = args.format || "text";

  const byClass = mineLedgers();
  const ledgerPatterns = [];
  for (const [cls, rec] of byClass.entries()) {
    const issueCount = rec.issues.size;
    // Strongest signal: a single role causing the same class across many runs.
    let worstRole = null; let worstRoleIssues = 0;
    for (const [role, issues] of rec.roles.entries()) {
      if (role !== "foreman" && role !== "unknown" && role !== "None" && issues.size > worstRoleIssues) {
        worstRole = role; worstRoleIssues = issues.size;
      }
    }
    const meetsClass = issueCount >= minIssues;
    const meetsRole = worstRole && worstRoleIssues >= minRoleIssues;
    if (!meetsClass && !meetsRole) continue;
    const target = cls.startsWith("gate:") ? "pipeline"
      : cls.startsWith("infra:") ? "tooling"
      : worstRole ? "agent" : "pipeline";
    ledgerPatterns.push({
      kind: "ledger",
      class: cls,
      issueCount,
      worstRole,
      worstRoleIssues,
      issues: [...rec.issues].sort(),
      samples: rec.samples,
      target,
      signatureTitle: worstRole && meetsRole
        ? `${cls} (esp. ${worstRole}: ${worstRoleIssues} runs)`
        : `${cls} across ${issueCount} runs`,
      summary: `Failure class "${cls}" recurred across ${issueCount} distinct factory runs`
        + (meetsRole ? `, with ${worstRole} hitting it in ${worstRoleIssues} of them` : "")
        + `. Example runs: ${[...rec.issues].sort().slice(0, 8).join(", ")}.`
        + ` Sample: ${rec.samples.map((s) => `[${s.issue}/${s.role}] ${s.summary}`).slice(0, 3).join("  ||  ")}`,
      suggestion: suggestFix(cls),
    });
  }
  ledgerPatterns.sort((a, b) => (b.worstRoleIssues - a.worstRoleIssues) || (b.issueCount - a.issueCount));

  const prThemes = minePrComments();
  const prPatterns = [];
  for (const [theme, prs] of prThemes.entries()) {
    if (prs.size < minPr) continue;
    prPatterns.push({
      kind: "pr-comment",
      class: "review:recurring-pr-comment",
      theme,
      prCount: prs.size,
      prs: [...prs],
      target: "pipeline",
      signatureTitle: `recurring PR comment x${prs.size}`,
      summary: `A PR-review comment theme recurred across ${prs.size} distinct PRs: "${theme.slice(0, 140)}". Example PRs: ${[...prs].slice(0, 5).join(", ")}.`,
      suggestion: suggestFix("review:reviewer-feedback"),
    });
  }
  prPatterns.sort((a, b) => b.prCount - a.prCount);

  const patterns = [...ledgerPatterns, ...prPatterns];

  // File tickets for new patterns (deduped by signature).
  const state = readState();
  const filed = [];
  if (fileTickets) {
    for (const p of patterns) {
      // Generic catch-all buckets are visible in the report but are not
      // actionable as a single ticket, so they are not auto-filed.
      if (/:(other)$/.test(p.class)) { filed.push({ sig: p.class, skipped: "catch-all-not-filed" }); continue; }
      const sig = `${p.class}::${p.signatureTitle}`;
      const prev = state.filed[sig];
      // Re-file only if the recurrence grew materially since last time.
      const magnitude = p.kind === "pr-comment" ? p.prCount : Math.max(p.issueCount, p.worstRoleIssues || 0);
      if (prev && magnitude <= (prev.magnitude || 0)) { filed.push({ sig, skipped: "already-filed", magnitude }); continue; }
      const result = fileTicket(p, dryRun);
      let identifier = null;
      try { identifier = JSON.parse(result.stdout).identifier || JSON.parse(result.stdout).payload?.title; } catch { /* ignore */ }
      if (result.status === 0) {
        state.filed[sig] = { magnitude, at: new Date().toISOString(), identifier, dryRun };
        filed.push({ sig, identifier, magnitude, dryRun });
      } else {
        filed.push({ sig, error: result.stderr || "create-report failed", magnitude });
      }
    }
    if (!dryRun) writeState(state);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    thresholds: { minIssues, minRoleIssues, minPr },
    ledgerPatternCount: ledgerPatterns.length,
    prPatternCount: prPatterns.length,
    patterns,
    filed: fileTickets ? filed : undefined,
  };

  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // text
  const lines = [];
  lines.push(`# Dark Factory recurring-pattern report (${report.generatedAt})`);
  lines.push(`Thresholds: >=${minIssues} runs per class, >=${minRoleIssues} runs per (class,role), >=${minPr} PRs per comment theme.`);
  lines.push("");
  lines.push(`## Recurring failure classes (${ledgerPatterns.length})`);
  if (!ledgerPatterns.length) lines.push("None above threshold.");
  for (const p of ledgerPatterns) {
    lines.push(`- [${p.class}] ${p.issueCount} runs` + (p.worstRole ? `; worst role ${p.worstRole} (${p.worstRoleIssues} runs)` : ""));
    lines.push(`    runs: ${p.issues.slice(0, 12).join(", ")}${p.issues.length > 12 ? " ..." : ""}`);
    lines.push(`    fix: ${p.suggestion}`);
  }
  lines.push("");
  lines.push(`## Recurring PR-comment themes (${prPatterns.length})`);
  if (!prPatterns.length) lines.push("None above threshold (note: fresh PR comments are not yet persisted — see roadmap).");
  for (const p of prPatterns) {
    lines.push(`- x${p.prCount} PRs: ${p.theme.slice(0, 120)}`);
  }
  if (fileTickets) {
    lines.push("");
    lines.push(`## Tickets ${dryRun ? "(dry-run) " : ""}filed this run`);
    for (const f of filed) lines.push(`- ${f.sig} -> ${f.identifier || f.skipped || f.error}`);
  }
  console.log(lines.join("\n"));
}

main();
