#!/usr/bin/env node
/**
 * wiki-drift-check.mjs — deterministic drift detector for the Dark Factory wiki.
 *
 * Compares the wiki's *mechanical* claims against live system state and source
 * file mtimes, so drift (like the 2026-06-13 Paperclip cutover sitting
 * undocumented for two days) is caught automatically instead of by convention.
 *
 * It is the detection engine for the Wiki-Maintainer routine and is also wired
 * into conformance.mjs. Findings are tiered:
 *   - hard : the wiki contradicts verifiable reality (broken link, missing page,
 *            LaunchAgent state mismatch, undocumented orchestration tool). Exit 1.
 *   - warn : a source file changed after the wiki page that documents it
 *            (candidate staleness — a human/agent should review). Exit 0.
 *   - info : ground-truth facts, for the maintainer's report.
 *
 * Usage:
 *   node tools/dark-factory/wiki-drift-check.mjs            # human report
 *   node tools/dark-factory/wiki-drift-check.mjs --json     # machine report
 *   node tools/dark-factory/wiki-drift-check.mjs --no-launchagent # run without host LaunchAgent checks
 *
 * Stdlib + global fetch only. No secrets, no writes.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DF = path.dirname(fileURLToPath(import.meta.url)); // tools/dark-factory
const WIKI = path.join(DF, "wiki");

const findings = [];
const add = (level, id, msg) => findings.push({ level, id, msg });

const mtime = (p) => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};
const read = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

// 1) Link integrity: every relative [..](x.md) link in the wiki resolves.
function linkCheck() {
  for (const f of readdirSync(WIKI).filter((x) => x.endsWith(".md"))) {
    const txt = read(path.join(WIKI, f));
    for (const m of txt.matchAll(/\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g)) {
      const target = m[1];
      if (/^https?:/.test(target)) continue;
      const resolvedTarget = path.resolve(WIKI, target);
      if (!existsSync(resolvedTarget)) {
        const isInternal = !path.relative(WIKI, resolvedTarget).startsWith("..");
        add(isInternal ? "hard" : "warn", "broken-link", `${f}: link -> ${target} (target missing)`);
      }
    }
  }
}

// 2) Code-newer-than-doc: curated map of wiki page -> dark-factory-local sources
//    that change rarely. If a source is newer than its page, flag for review.
//    (Intentionally excludes fast-churning core Paperclip files to avoid noise.)
const DOC_SOURCES = {
  "architecture.md": ["foreman.mjs", "conductor/conductor.mjs"],
  "conductor.md": ["conductor/conductor.mjs"],
  "foreman-cli.md": ["foreman.mjs", "foreman-command-reference.md"],
  "compliant-account-context-routing.md": ["account-context-gateway.mjs"],
  "improver-subsystem.md": ["improver-pattern-miner.mjs"],
  "conformance-testing.md": ["conformance.mjs", "prompt-lint.mjs", "worktree-health.mjs"],
  "telemetry.md": ["post-merge-telemetry.mjs", "loop-health-report.mjs"],
};
function stalenessCheck() {
  for (const [page, srcs] of Object.entries(DOC_SOURCES)) {
    const pagePath = path.join(WIKI, page);
    if (!existsSync(pagePath)) {
      add("hard", "missing-page", `documented page ${page} is missing`);
      continue;
    }
    const pm = mtime(pagePath);
    for (const s of srcs) {
      // sources live under tools/dark-factory (or wiki/ for sibling .md refs)
      const candidate = s.endsWith(".md") ? path.join(WIKI, s) : path.join(DF, s);
      if (!existsSync(candidate)) continue;
      if (mtime(candidate) > pm) {
        add("warn", "stale-doc", `${page} is older than ${s} (source changed after the doc — review)`);
      }
    }
  }
}

// 3) LaunchAgent load state vs the wiki's STOPPED/LIVE claims.
function launchctlLoaded(label) {
  try {
    execFileSync("launchctl", ["print", `gui/${process.getuid()}/${label}`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}
function launchAgentCheck() {
  const foreman = "com.openclaw.dark-factory-foreman";
  const loaded = launchctlLoaded(foreman);
  add("info", "launchagent-state", `${foreman}: ${loaded ? "LOADED" : "unloaded"}`);
  const wikiTxt =
    read(path.join(WIKI, "architecture.md")) +
    read(path.join(WIKI, "launchagent-foreman-daemon.md")) +
    read(path.join(WIKI, "intake-foreman-scheduling.md"));
  const saysStopped = /STOPPED|unloaded|not loaded/i.test(wikiTxt);
  if (loaded && saysStopped) {
    add("hard", "launchagent-drift", `${foreman} is LOADED but the wiki says STOPPED — it was re-loaded; the cutover banner is now wrong.`);
  }
  if (!loaded && !saysStopped) {
    add("hard", "launchagent-drift", `${foreman} is unloaded but the wiki still implies it runs.`);
  }
}

// 4) Orchestration tools must be documented.
function toolDocCheck() {
  if (existsSync(path.join(DF, "conductor", "conductor.mjs")) && !existsSync(path.join(WIKI, "conductor.md"))) {
    add("hard", "undocumented-tool", "conductor/conductor.mjs exists but wiki/conductor.md is missing");
  }
}

// 5) Paperclip orchestrator liveness (best-effort; wiki cites ~51 OPE agents).
async function paperclipCheck() {
  const company = "1e8bc12a-f8fd-431c-9fbd-e47be79446a3";
  try {
    const res = await fetch(`http://127.0.0.1:3101/api/companies/${company}/agents`, {
      signal: AbortSignal.timeout(6000),
    });
    const agents = await res.json();
    const n = Array.isArray(agents) ? agents.length : 0;
    add("info", "paperclip-agents", `OPE company live agents: ${n} (wiki cites ~51)`);
    if (n === 0) add("warn", "paperclip-agents", "OPE company has 0 agents — orchestrator roster empty?");
  } catch {
    add("info", "paperclip-agents", "Paperclip API not reachable — skipped agent-count check");
  }
}

await (async () => {
  linkCheck();
  stalenessCheck();
  if (!process.argv.includes("--no-launchagent")) {
    launchAgentCheck();
  }
  toolDocCheck();
  await paperclipCheck();

  const hard = findings.filter((f) => f.level === "hard");
  const warn = findings.filter((f) => f.level === "warn");

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ok: hard.length === 0, hard, warn, info: findings.filter((f) => f.level === "info") }, null, 2));
  } else {
    for (const f of findings) console.log(`[${f.level.toUpperCase()}] ${f.id}: ${f.msg}`);
    console.log(`\nwiki-drift-check: ${hard.length} hard, ${warn.length} warn`);
    if (hard.length === 0) console.log("OK — no hard drift.");
  }
  process.exit(hard.length > 0 ? 1 : 0);
})();
