#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectWorktreeHealth, compactWorktreeHealth } from "./worktree-health.mjs";
import { appendLedgerEvent } from "../paperclip-board/ledger-lib.mjs";

const WORKSPACE = resolve(import.meta.dirname, "../..");
const RUNS_DIR = resolve(WORKSPACE, "tools/paperclip-data/factory-runs");
const LEDGERS_DIR = resolve(WORKSPACE, "tools/paperclip-data/factory-run-ledgers");

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

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function recentEnough(path, days) {
  if (!Number.isFinite(days) || days <= 0) return true;
  return Date.now() - statSync(path).mtimeMs <= days * 24 * 60 * 60 * 1000;
}

function timestampMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function hoursSince(value, fallbackMs) {
  const ms = timestampMs(value) ?? fallbackMs;
  if (!Number.isFinite(ms)) return null;
  return (Date.now() - ms) / (60 * 60 * 1000);
}

function isTerminalStage(stage) {
  return /human final review|ship to pr|done|complete|closed/i.test(stage || "");
}

function staleReason(run, staleHours) {
  if (run.status !== "active") return null;
  if (/^DF-(SMOKE|CONFORMANCE)-/i.test(run.issue || "")) {
    return "smoke/conformance run left active";
  }
  if (isTerminalStage(run.currentStage)) {
    return `terminal-looking stage left active: ${run.currentStage}`;
  }
  if (run.inactiveHours !== null && run.inactiveHours >= staleHours) {
    return `active manifest has no update for ${run.inactiveHours.toFixed(1)}h`;
  }
  return null;
}

function collectRuns(days, staleHours) {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .map((name) => resolve(RUNS_DIR, name))
    .filter((dir) => existsSync(resolve(dir, "run-manifest.json")) && recentEnough(dir, days))
    .map((dir) => {
      const manifestPath = resolve(dir, "run-manifest.json");
      const manifest = readJson(manifestPath);
      const loops = [manifest.loop, ...(manifest.loops || [])].filter(Boolean);
      const stat = statSync(manifestPath);
      const run = {
        runDir: dir,
        manifestPath,
        runId: manifest.runId,
        issue: manifest.issue,
        status: manifest.status,
        currentStage: manifest.currentStage,
        updatedAt: manifest.updatedAt || null,
        inactiveHours: hoursSince(manifest.updatedAt, stat.mtimeMs),
        loops,
        exhaustedLoops: loops.filter((loop) => loop.exhausted).map((loop) => loop.id || "main"),
        activeLoops: loops.filter((loop) => loop.status === "active").map((loop) => loop.id || "main"),
      };
      run.staleReason = staleReason(run, staleHours);
      return run;
    });
}

function collectLedgerEvents(days) {
  if (!existsSync(LEDGERS_DIR)) return [];
  const events = [];
  for (const issue of readdirSync(LEDGERS_DIR)) {
    const path = resolve(LEDGERS_DIR, issue, "events.jsonl");
    if (!existsSync(path) || !recentEnough(path, days)) continue;
    for (const event of readJsonl(path)) {
      events.push(event);
    }
  }
  return events;
}

function blockerKind(event) {
  const text = `${event.eventType || ""} ${event.summary || ""} ${typeof event.details === "string" ? event.details : JSON.stringify(event.details || {})}`.toLowerCase();
  if (text.includes("no mistakes") || text.includes("no_mistakes")) return "no_mistakes";
  if (text.includes("browser") || text.includes("qa") || text.includes("credential") || text.includes("auth state") || text.includes("waiver")) return "browser_qa_environment";
  if (text.includes("duplicate") || text.includes("handoff")) return "duplicate_handoff";
  if (text.includes("review request") || text.includes("reviewer")) return "reviewer_gate";
  if (text.includes("security")) return "security";
  return "other";
}

function summarize(days, staleHours) {
  const runs = collectRuns(days, staleHours);
  const events = collectLedgerEvents(days);
  const worktreeHealth = compactWorktreeHealth(collectWorktreeHealth());
  const loopEvents = events.filter((event) => event.eventType === "loop_iteration");
  const gateFailures = events.filter((event) => event.eventType === "gate_result" && /FAIL|BLOCKED|PARTIAL/.test(event.summary || ""));
  const blockers = events.filter((event) => /blocked|blocker|exhaust/i.test(`${event.eventType} ${event.summary}`));
  const exhaustedRuns = runs.filter((run) => run.exhaustedLoops.length > 0);
  const staleActiveRuns = runs.filter((run) => run.staleReason);
  const issuesWithRepeatedBlockers = Object.entries(blockers.reduce((acc, event) => {
    acc[event.issue] = (acc[event.issue] || 0) + 1;
    return acc;
  }, {})).filter(([, count]) => count >= 2).map(([issue, count]) => ({ issue, count }));
  const blockerClusters = Object.entries(blockers.reduce((acc, event) => {
    const issue = event.issue || "unknown";
    const kind = blockerKind(event);
    const key = `${issue}:${kind}`;
    const current = acc[key] || { issue, kind, count: 0, latestAt: null, latestSummary: null };
    current.count += 1;
    if (!current.latestAt || String(event.timestamp || "") > current.latestAt) {
      current.latestAt = event.timestamp || null;
      current.latestSummary = event.summary || null;
    }
    acc[key] = current;
    return acc;
  }, {})).map(([, value]) => value).filter((item) => item.count >= 2).sort((a, b) => b.count - a.count);

  return {
    ok: true,
    days,
    staleHours,
    generatedAt: new Date().toISOString(),
    runsChecked: runs.length,
    activeRuns: runs.filter((run) => run.status === "active").length,
    blockedRuns: runs.filter((run) => run.status === "blocked").length,
    staleActiveRuns: staleActiveRuns.length,
    exhaustedRuns: exhaustedRuns.length,
    dirtyWorktrees: worktreeHealth.dirtyCount,
    worktreeScanErrors: worktreeHealth.errorCount,
    loopIterations: loopEvents.length,
    gateFailures: gateFailures.length,
    blockerEvents: blockers.length,
    issuesWithRepeatedBlockers,
    blockerClusters,
    recommendations: [
      staleActiveRuns.length > 0 ? "Stale active manifests found; run with --mark-stale-blocked after reviewing the sample." : null,
      exhaustedRuns.length > 0 ? "Review exhausted loops and create/claim improvement reports for repeated failure patterns." : null,
      worktreeHealth.dirtyCount > 0 ? "Dirty worktrees found; owner should commit, intentionally park, or move the work into a visible task before shipping gates run." : null,
      worktreeHealth.errorCount > 0 ? "One or more worktrees could not be scanned; fix the scan error before trusting hygiene reports." : null,
      issuesWithRepeatedBlockers.length > 0 ? "Repeated blockers found; route through self-improvement lead." : null,
      loopEvents.length === 0 ? "No loop iterations recorded in this window; verify active runs are using Foreman iterate for fix loops." : null,
    ].filter(Boolean),
    sample: {
      exhaustedRuns: exhaustedRuns.slice(0, 10).map((run) => ({
        issue: run.issue,
        runId: run.runId,
        exhaustedLoops: run.exhaustedLoops,
        runDir: run.runDir,
      })),
      staleActiveRuns: staleActiveRuns.slice(0, 20).map((run) => ({
        issue: run.issue,
        runId: run.runId,
        currentStage: run.currentStage,
        updatedAt: run.updatedAt,
        inactiveHours: run.inactiveHours === null ? null : Number(run.inactiveHours.toFixed(1)),
        reason: run.staleReason,
        runDir: run.runDir,
      })),
      recentLoopEvents: loopEvents.slice(-10).map((event) => ({
        issue: event.issue,
        timestamp: event.timestamp,
        summary: event.summary,
        details: event.details,
      })),
      dirtyWorktrees: worktreeHealth.dirtyWorktrees.slice(0, 20),
    },
    worktreeHealth,
  };
}

function markStaleBlocked(report) {
  const marked = [];
  const staleRuns = collectRuns(report.days, report.staleHours).filter((run) => run.staleReason);
  for (const run of staleRuns) {
    const manifest = readJson(run.manifestPath);
    if (manifest.status !== "active") continue;
    if (!manifest.issue) {
      marked.push({
        issue: run.issue || null,
        runId: run.runId,
        reason: "skipped stale active cleanup because manifest has no issue",
        manifestPath: run.manifestPath,
        skipped: true,
      });
      continue;
    }
    manifest.status = "blocked";
    manifest.blockedReason = `loop-health stale-active cleanup: ${run.staleReason}`;
    manifest.updatedAt = new Date().toISOString();
    writeJson(run.manifestPath, manifest);
    appendLedgerEvent({
      issue: manifest.issue,
      title: manifest.title || `Stale active run cleanup for ${manifest.issue}`,
      eventType: "blocker_recorded",
      stage: manifest.currentStage || "Unknown",
      actor: "Dark Factory Loop Health",
      actorRole: "loop-health",
      summary: `Marked stale active run blocked: ${run.staleReason}`,
      details: {
        runId: run.runId,
        manifestPath: run.manifestPath,
        staleReason: run.staleReason,
        staleHours: report.staleHours,
      },
      artifacts: [{ kind: "run_manifest", path: run.manifestPath, summary: "blocked stale active run manifest" }],
    });
    marked.push({
      issue: run.issue,
      runId: run.runId,
      reason: run.staleReason,
      manifestPath: run.manifestPath,
    });
  }
  return marked;
}

function markdown(report) {
  return [
    "# Dark Factory Loop Health",
    "",
    `- Window: ${report.days} day(s)`,
    `- Generated: ${report.generatedAt}`,
    `- Runs checked: ${report.runsChecked}`,
    `- Active runs: ${report.activeRuns}`,
    `- Blocked runs: ${report.blockedRuns}`,
    `- Stale active runs: ${report.staleActiveRuns}`,
    `- Exhausted runs: ${report.exhaustedRuns}`,
    `- Dirty worktrees: ${report.dirtyWorktrees}`,
    `- Worktree scan errors: ${report.worktreeScanErrors}`,
    `- Loop iterations: ${report.loopIterations}`,
    `- Gate failures: ${report.gateFailures}`,
    `- Blocker events: ${report.blockerEvents}`,
    "",
    "## Recommendations",
    "",
    ...(report.recommendations.length ? report.recommendations.map((item) => `- ${item}`) : ["- No loop-health action needed from the available local evidence."]),
    "",
    "## Repeated Blockers",
    "",
    ...(report.issuesWithRepeatedBlockers.length
      ? report.issuesWithRepeatedBlockers.map((item) => `- ${item.issue}: ${item.count}`)
      : ["- None found."]),
    "",
    "## Blocker Clusters",
    "",
    ...(report.blockerClusters.length
      ? report.blockerClusters.slice(0, 20).map((item) => `- ${item.issue} / ${item.kind}: ${item.count} (${item.latestSummary || "no summary"})`)
      : ["- None found."]),
    "",
    "## Stale Active Runs",
    "",
    ...(report.sample.staleActiveRuns.length
      ? report.sample.staleActiveRuns.map((run) => `- ${run.issue} ${run.runId}: ${run.reason}`)
      : ["- None found."]),
    "",
    ...(Array.isArray(report.markedStaleBlocked)
      ? [
          "## Stale Cleanup Applied",
          "",
          ...(report.markedStaleBlocked.length
            ? report.markedStaleBlocked.map((run) => `- ${run.issue || "unknown"} ${run.runId}: ${run.skipped ? "skipped" : "blocked"} - ${run.reason}`)
            : ["- No stale active runs were changed."]),
          "",
        ]
      : []),
    "",
    "## Dirty Worktrees",
    "",
    ...(report.sample.dirtyWorktrees.length
      ? report.sample.dirtyWorktrees.map((worktree) => `- ${worktree.path} (${worktree.owner?.label || "unknown owner"}): ${worktree.fileCount} changed file(s), branch ${worktree.branch || "unknown"}`)
      : ["- None found."]),
    "",
  ].join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const days = Number.parseFloat(args.days || "7");
  const staleHours = Number.parseFloat(args["stale-hours"] || "12");
  const report = summarize(days, staleHours);
  let markedStale = [];
  if (args["mark-stale-blocked"] === "true") {
    markedStale = markStaleBlocked(report);
    report.markedStaleBlocked = markedStale;
  }
  if (args.output) {
    const output = resolve(args.output);
    writeFileSync(output, args.markdown === "true" ? markdown(report) : `${JSON.stringify(report, null, 2)}\n`);
  }
  if (args.markdown === "true") {
    console.log(markdown(report));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
