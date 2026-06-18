#!/usr/bin/env node
// conductor.mjs — deterministic pipeline driver for the Paperclip-native dark factory.
// -----------------------------------------------------------------------------
// Drives the PROVEN execution primitives into a coordinated lane:
//   task -> shallow clone into an isolated temp dir + fresh branch
//        -> IMPLEMENT (Paperclip agent) -> GATE (tests) -> REVIEW (Paperclip agent)
//        -> commit + push + open a GitHub PR (gh)
//
// Paperclip agents are the executors (per-agent run history is captured); this
// Conductor is the orchestration brain (sequencing, context passing, gates, PR).
//
// HARDENED per adversarial audit:
//  - No shell-string interpolation of user input: git/gh run via execFileSync(argv).
//  - Prod guard checks the RESOLVED origin remote (after clone) + the PR destination,
//    not just the --repo argument; refuses quillio-* unless --allow-prod + DF_ALLOW_PROD=YES.
//  - Only drives allow-listed probe agents; REFUSES any agent carrying metadata.piRole
//    (the 35 live team agents); snapshots + restores each agent's status/config; per-agent lock.
//  - Run lifecycle: distinguishes terminal/timeout, requires a SUCCESS status before using output.
//  - Gate runs on the working tree FIRST, then stage -> diff -> review -> commit (gate fixes ship).
//  - Reviewer sees the exact diff that ships; oversized diffs fail CLOSED (no unreviewed code).
//  - Verdict validated against an allowlist, fails closed; secrets scrubbed from logs/report.
//  - Unique branch + report id; push/PR failures handled (existing-PR reconciled).
//
// USAGE:
//   node conductor.mjs --repo <git-url|local-path> --base <branch> --task "<what to build>" \
//     [--test "<gate command>"] [--title "<pr title>"] [--impl <agentId>] [--review <agentId>] \
//     [--no-pr] [--allow-prod] [--keep-worktree]
// ENV: PAPERCLIP_API, PAPERCLIP_COMPANY_ID, DF_ALLOW_PROD (must be "YES" for prod),
//      DF_IMPL_AGENT, DF_REVIEW_AGENT
// -----------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const API = (process.env.PAPERCLIP_API || "http://127.0.0.1:3101/api").replace(/\/+$/, "");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIFF_REVIEW_LIMIT = 24000; // bytes; larger diffs fail closed (must be human-reviewed)

// Production repos the factory may NOT touch without an explicit override.
const PROD_REPOS = new Set(["aila-quillio/quillio-backend", "aila-quillio/quillio-frontend"]);

// Run-state vocabularies (case-insensitive). Terminal-but-not-success => failure.
const SUCCESS = new Set(["succeeded", "completed", "done", "success", "ok", "finished", "passed"]);
const FAILURE = new Set(["failed", "errored", "error", "timed_out", "timedout", "cancelled", "canceled", "aborted"]);
const TERMINAL = new Set([...SUCCESS, ...FAILURE]);

// ---------- utils ----------
function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const n = argv[i + 1];
    if (n === undefined || n.startsWith("--")) { flags[k] = true; continue; }
    flags[k] = n; i += 1;
  }
  return flags;
}
const log = (...m) => console.log("[conductor]", ...m);
const die = (msg) => { console.error("[conductor] FATAL:", msg); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Secret scrubber — masks token-shaped strings before they hit logs/report.
const SECRET_RES = [
  /gh[posru]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /(?:bearer|authorization|token|password|secret)\s*[:=]?\s*[A-Za-z0-9._\-]{12,}/gi,
  /[a-z][a-z0-9+.\-]*:\/\/[^:@\s/]+:[^@\s/]+@/gi, // creds embedded in URLs
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
];
function scrub(s) { if (s == null) return s; let t = String(s); for (const re of SECRET_RES) t = t.replace(re, "«redacted»"); return t; }

// Exec a trusted binary with an ARGV array (no shell) — safe with user-controlled data.
function run(file, args, cwd) {
  return execFileSync(file, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}
function runTry(file, args, cwd) {
  try { return { ok: true, out: run(file, args, cwd) }; }
  catch (e) { return { ok: false, out: (e.stdout || "") + (e.stderr || ""), code: e.status ?? 1 }; }
}
// Gate command IS arbitrary code by design (operator-provided) — run via shell but with a
// SCRUBBED env (no tokens) and a hard timeout.
function runGate(cmd, cwd) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG || "", TMPDIR: process.env.TMPDIR || "/tmp" };
  try {
    const out = execFileSync("/bin/sh", ["-c", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, env, timeout: 10 * 60 * 1000 });
    return { ok: true, out };
  } catch (e) { return { ok: false, out: (e.stdout || "") + (e.stderr || ""), code: e.status ?? 1 }; }
}

async function api(method, p, body) {
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await fetch(`${API}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      if (attempt < 3) { await sleep(1000 * (attempt + 1)); continue; } // transient network blip -> retry
      throw e;
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    if (!res.ok) {
      if (res.status >= 500 && attempt < 3) { await sleep(1000 * (attempt + 1)); continue; } // transient server error -> retry
      throw new Error(`${method} ${p} -> ${res.status}: ${scrub(text).slice(0, 300)}`);
    }
    return json;
  }
}

// Normalise a git url / scp form / local path to a lowercase owner/repo (or path) id.
function normalizeRepoId(u) {
  let s = String(u).trim().toLowerCase().replace(/\.git$/, "");
  const scp = s.match(/^[^@/]+@[^:]+:(.+)$/); if (scp) s = scp[1];
  const url = s.match(/^[a-z][a-z0-9+.\-]*:\/\/[^/]+\/(.+)$/); if (url) s = url[1];
  return s.replace(/^\/+/, "");
}
function isProdRepo(idOrUrl) {
  const id = normalizeRepoId(idOrUrl);
  if (PROD_REPOS.has(id)) return true;
  const last = id.split("/").pop() || id;
  return /^quillio(-(backend|frontend))?$/i.test(last) || /quillio-(backend|frontend)/i.test(id);
}

// Per-agent lock so two runs never drive the same shared probe at once.
function acquireLock(agentId) {
  const dir = path.join(HERE, ".locks"); mkdirSync(dir, { recursive: true });
  const lf = path.join(dir, `${agentId}.lock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { writeFileSync(lf, String(process.pid), { flag: "wx" }); return () => { try { rmSync(lf, { force: true }); } catch { /* ignore */ } }; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      // lock exists — is the holder still alive? (crash-safe: reclaim stale locks)
      let holder = null; try { holder = parseInt(readFileSync(lf, "utf8").trim(), 10); } catch { /* ignore */ }
      let alive = false;
      if (holder) { try { process.kill(holder, 0); alive = true; } catch (err) { alive = err.code === "EPERM"; } }
      if (alive) die(`agent ${agentId} is busy (locked by live pid ${holder}: ${lf})`);
      try { rmSync(lf, { force: true }); } catch { /* ignore */ } // stale -> reclaim and retry
    }
  }
  die(`could not acquire lock for agent ${agentId}`);
}

// Run one Paperclip agent against a worktree; restores its prior status+config afterwards.
async function runAgent({ agentId, cwd, promptText, label, maxWaitMs = 12 * 60 * 1000 }) {
  const agent = await api("GET", `/agents/${agentId}`);
  if (agent?.metadata?.piRole) die(`refusing to drive agent ${agentId} — it is a live team agent (piRole=${agent.metadata.piRole})`);
  const release = acquireLock(agentId);
  const priorStatus = agent.status;
  const priorConfig = agent.adapterConfig || {};
  const promptDir = mkdtempSync(path.join(tmpdir(), `df-${label}-`));
  const promptFile = path.join(promptDir, "task.md");
  writeFileSync(promptFile, promptText);
  try {
    await api("PATCH", `/agents/${agentId}`, { adapterConfig: { ...priorConfig, cwd, workspace: cwd, instructionsFilePath: promptFile } });
    if (priorStatus !== "active") await api("PATCH", `/agents/${agentId}`, { status: "active" });
    const wake = await api("POST", `/agents/${agentId}/heartbeat/invoke`, { reason: `Conductor: ${label}`, triggerDetail: "manual" });
    const runId = wake && (wake.id || wake.runId);
    if (!runId) throw new Error(`${label}: wakeup returned no run id (${scrub(JSON.stringify(wake)).slice(0, 160)})`);
    log(`${label}: run ${runId} started (agent ${agentId.slice(0, 8)})`);
    const t0 = Date.now();
    let runRec = null, timedOut = true;
    while (Date.now() - t0 < maxWaitMs) {
      await sleep(5000);
      runRec = await api("GET", `/heartbeat-runs/${runId}`);
      const st = String(runRec.status || "").toLowerCase();
      if (runRec.finishedAt || TERMINAL.has(st) || runRec.exitCode != null) { timedOut = false; break; }
    }
    const status = String(runRec?.status || "unknown").toLowerCase();
    if (timedOut) throw new Error(`${label}: run ${runId} did not finish within ${Math.round(maxWaitMs / 60000)}min (last status ${status})`);
    if (!SUCCESS.has(status) || (runRec.exitCode != null && runRec.exitCode !== 0)) {
      throw new Error(`${label}: run ${runId} did not succeed (status ${status}, exit ${runRec.exitCode}): ${scrub(runRec.error || "")}`);
    }
    let resultText = "";
    try { const rj = runRec.resultJson ? (typeof runRec.resultJson === "string" ? JSON.parse(runRec.resultJson) : runRec.resultJson) : null; resultText = (rj && (rj.result || rj.text || rj.summary)) || runRec.stdoutExcerpt || ""; }
    catch { resultText = runRec.stdoutExcerpt || ""; }
    let costUsd = null;
    try { const u = runRec.usageJson ? (typeof runRec.usageJson === "string" ? JSON.parse(runRec.usageJson) : runRec.usageJson) : null; costUsd = u && (u.costUsd ?? u.cost ?? null); if (typeof costUsd === "string") costUsd = Number(costUsd); } catch { /* ignore */ }
    log(`${label}: run ${runId} -> ${status} (exit ${runRec.exitCode}, $${costUsd ?? "?"})`);
    return { runId, status, exitCode: runRec.exitCode, costUsd, resultText: scrub(resultText) };
  } finally {
    try { await api("PATCH", `/agents/${agentId}`, { adapterConfig: priorConfig, status: priorStatus }); } catch { /* best effort */ }
    try { rmSync(promptDir, { recursive: true, force: true }); } catch { /* ignore */ }
    release();
  }
}

// ---------- prompts ----------
function implementerPrompt({ task, branch }) {
  return `You are a senior software engineer running HEADLESS and NON-INTERACTIVELY. Never ask for permission or confirmation — make the changes directly.

Your current working directory is a git repository, already checked out on branch "${branch}".

TASK:
${task}

REQUIREMENTS:
- Implement the task with clean, minimal, correct code that matches the surrounding style.
- Add or update a test that verifies your change, and run it to confirm it passes.
- Do NOT run "git commit" or "git push" — leave your changes in the working tree; the orchestrator handles commits and the PR.
- When finished, print a short (2-4 sentence) summary of exactly what you changed and the test result, then stop.`;
}
function reviewerPrompt({ task, diff, verdictFile }) {
  return `You are a strict senior code reviewer running HEADLESS and NON-INTERACTIVELY. Never ask for permission.

A change was implemented for this TASK:
${task}

Here is the COMPLETE unified diff to review (this is exactly what will ship):
\`\`\`diff
${diff}
\`\`\`

Review it for correctness, security, and quality. Then do BOTH of these:
1. Write your verdict as JSON to the absolute path ${verdictFile} — exactly: {"verdict":"APPROVE"|"REQUEST_CHANGES","notes":"<one-paragraph justification and any required fixes>"}
2. Print a single line to stdout: "VERDICT: APPROVE" or "VERDICT: REQUEST_CHANGES" (matching the JSON).
Do not modify any source files. Then stop.`;
}

// Validate + normalise a reviewer verdict; fails CLOSED (unknown -> not approved).
function parseVerdict(verdictFile, resultText) {
  let v = null;
  if (existsSync(verdictFile)) { try { v = JSON.parse(readFileSync(verdictFile, "utf8")); } catch { v = null; } }
  let verdict = v && typeof v.verdict === "string" ? v.verdict.trim().toUpperCase() : null;
  let notes = v && typeof v.notes === "string" ? v.notes : "";
  if (verdict !== "APPROVE" && verdict !== "REQUEST_CHANGES") {
    const m = String(resultText || "").match(/^VERDICT:\s*(APPROVE|REQUEST_CHANGES)\s*$/im);
    verdict = m ? m[1].toUpperCase() : "UNKNOWN";
    if (!notes) notes = "(parsed from stdout)";
  }
  return { verdict, notes: scrub(notes).slice(0, 600) };
}

// ---------- main ----------
(async () => {
  const flags = parseArgs(process.argv.slice(2));
  const repo = flags.repo;
  const base = flags.base || "main";
  const task = flags.task;
  const testCmd = flags.test || null;
  const noPr = Boolean(flags["no-pr"]);
  const allowProd = Boolean(flags["allow-prod"]) && process.env.DF_ALLOW_PROD === "YES";
  const keepWorktree = Boolean(flags["keep-worktree"]);
  if (!repo || !task) die('required: --repo <url|path> --base <branch> --task "..."');

  // input validation (defence in depth even though we use argv-exec)
  if (typeof repo !== "string" || repo.startsWith("-")) die("invalid --repo (leading '-' not allowed)");
  if (!/^[A-Za-z0-9._/\-]+$/.test(base)) die(`invalid --base "${base}" (allowed: letters, digits, . _ / -)`);

  // SAFETY GUARD #1: the --repo argument
  if (isProdRepo(repo) && !allowProd) die(`refusing to operate on a production repo (${repo}). Pass --allow-prod AND set DF_ALLOW_PROD=YES.`);

  const cfg = (() => { try { return JSON.parse(readFileSync(path.join(HERE, "agents.json"), "utf8")); } catch { return {}; } })();
  const implAgent = flags.impl || process.env.DF_IMPL_AGENT || cfg.impl;
  const reviewAgent = flags.review || process.env.DF_REVIEW_AGENT || cfg.rev;
  if (!implAgent || !reviewAgent) die("need implementer + reviewer agent ids (--impl/--review, env, or conductor/agents.json)");

  const runId = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const runRoot = mkdtempSync(path.join(tmpdir(), "df-run-"));
  const repoDir = path.join(runRoot, "repo");
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32)
    || crypto.createHash("sha1").update(task).digest("hex").slice(0, 8);
  let branch = `factory/${slug}-${runId}`;
  const report = { runId, repo, base, task, branch, allowProd, impl: null, gate: null, review: null, pr: null, startedAt: new Date().toISOString() };

  try {
    // 1) clone (shallow) + create isolated branch (argv-exec, no shell injection)
    log(`cloning ${repo} (base ${base}) ...`);
    run("git", ["clone", "--depth", "1", "--branch", base, repo, repoDir]);

    // SAFETY GUARD #2: re-check the RESOLVED origin remote, not just the arg
    const originUrl = run("git", ["remote", "get-url", "origin"], repoDir).trim();
    if (isProdRepo(originUrl) && !allowProd) die(`resolved origin is a production repo (${scrub(originUrl)}). Refusing without --allow-prod + DF_ALLOW_PROD=YES.`);
    if (allowProd && isProdRepo(originUrl)) log(`⚠️  OPERATING ON PRODUCTION REPO: ${scrub(originUrl)}`);

    run("git", ["checkout", "-b", branch], repoDir);
    run("git", ["config", "user.email", "factory@local"], repoDir);
    run("git", ["config", "user.name", "Dark Factory"], repoDir);
    // never commit incidental tool artifacts (e.g. .claude/audit.log written by the CLI hook)
    appendFileSync(path.join(repoDir, ".git/info/exclude"), "\n.claude/\n");

    // 2) IMPLEMENT
    log("IMPLEMENT step ...");
    report.impl = await runAgent({ agentId: implAgent, cwd: repoDir, promptText: implementerPrompt({ task, branch }), label: "implement" });
    if (run("git", ["status", "--porcelain"], repoDir).trim() === "") throw new Error("implementer produced no changes in the worktree");

    // 3) GATE on the working tree FIRST (so any gate/formatter fixes are included downstream)
    if (testCmd) {
      log(`GATE: ${testCmd}`);
      const g = runGate(testCmd, repoDir);
      report.gate = { cmd: testCmd, passed: g.ok, code: g.code ?? 0, tail: scrub((g.out || "").slice(-500)) };
      if (!g.ok) throw new Error(`gate failed (${testCmd})\n${scrub((g.out || "").slice(-500))}`);
      log("GATE passed");
    } else { report.gate = { skipped: true }; }

    // 4) stage everything (post-gate) and capture the EXACT diff that will ship
    run("git", ["add", "-A"], repoDir);
    const diff = run("git", ["diff", "--cached"], repoDir);
    log(`staged ${run("git", ["diff", "--cached", "--name-only"], repoDir).trim().split("\n").filter(Boolean).length} file(s)`);

    // 5) REVIEW — oversized diffs fail CLOSED (never ship unreviewed code)
    if (diff.length > DIFF_REVIEW_LIMIT) {
      report.review = { verdict: "REQUEST_CHANGES", truncated: true, notes: `diff is ${diff.length} bytes (> ${DIFF_REVIEW_LIMIT}); requires human review` };
      throw new Error(`diff too large for autonomous review (${diff.length} bytes) — human review required`);
    }
    log("REVIEW step ...");
    const verdictFile = path.join(runRoot, "review.json");
    const rv = await runAgent({ agentId: reviewAgent, cwd: repoDir, promptText: reviewerPrompt({ task, diff, verdictFile }), label: "review" });
    const { verdict, notes } = parseVerdict(verdictFile, rv.resultText);
    report.review = { runId: rv.runId, verdict, notes };
    log(`REVIEW verdict: ${verdict}`);
    if (verdict !== "APPROVE") throw new Error(`review did not approve (${verdict}): ${notes}`);

    // 6) COMMIT + PR
    const title = (flags.title || `Factory: ${task}`).slice(0, 72);
    const bodyLines = [
      `Automated change produced by the dark factory Conductor.`, ``,
      `**Task:** ${task}`, ``,
      `- Implementer run: \`${report.impl.runId}\` (${report.impl.status})`,
      `- Gate: ${report.gate.skipped ? "skipped" : (report.gate.passed ? "passed" : "FAILED")}${testCmd ? ` (\`${testCmd}\`)` : ""}`,
      `- Reviewer run: \`${report.review.runId}\` — ${report.review.verdict}`,
      `  - ${report.review.notes}`, ``,
      `🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
    ];
    run("git", ["commit", "-m", title, "-m", bodyLines.join("\n"), "-m", "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"], repoDir);

    if (noPr) {
      report.pr = { skipped: true, branch };
      log("--no-pr set; committed locally, not pushing");
    } else {
      // resolve + re-guard the PR destination
      const dest = runTry("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], repoDir);
      const ownerRepo = dest.ok ? dest.out.trim() : null;
      if (ownerRepo && isProdRepo(ownerRepo) && !allowProd) die(`PR destination ${ownerRepo} is a production repo; refusing without override.`);
      // ensure branch is unique on the remote before pushing (no force-push)
      if (runTry("git", ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], repoDir).ok) {
        branch = `factory/${slug}-${runId}-${crypto.randomBytes(2).toString("hex")}`;
        run("git", ["branch", "-m", branch], repoDir);
        report.branch = branch;
      }
      // No-Mistakes gate (fail-closed): push through the `no-mistakes` proxy remote,
      // which validates the branch and only forwards to origin on pass. Any agent that
      // opens a PR via the Conductor therefore goes through No-Mistakes first.
      // Set DF_REQUIRE_NM=0 to bypass with a direct origin push (discouraged).
      const requireNm = process.env.DF_REQUIRE_NM !== "0";
      if (requireNm) {
        const nmBin = process.env.DF_NM_BIN || "no-mistakes";
        log("NO-MISTAKES: initializing gate");
        const nmInit = runTry(nmBin, ["init"], repoDir);
        if (!nmInit.ok) throw new Error(`no-mistakes init failed; refusing to open a PR (set DF_REQUIRE_NM=0 to bypass):\n${scrub(nmInit.out).slice(-300)}`);
        log("NO-MISTAKES: pushing through gate (validates, then forwards to origin)");
        const nmPush = runTry("git", ["push", "no-mistakes", branch], repoDir);
        report.noMistakes = { required: true, passed: nmPush.ok, tail: scrub((nmPush.out || "").slice(-500)) };
        if (!nmPush.ok) throw new Error(`No-Mistakes gate FAILED; refusing to open a PR:\n${report.noMistakes.tail}`);
        log("NO-MISTAKES gate passed (branch forwarded to origin)");
      } else {
        report.noMistakes = { required: false, bypassed: true };
        log("NO-MISTAKES: bypassed via DF_REQUIRE_NM=0 (direct origin push)");
        const push = runTry("git", ["push", "-u", "origin", branch], repoDir);
        if (!push.ok) throw new Error(`git push failed: ${scrub(push.out).slice(-300)}`);
      }
      const bodyFile = path.join(runRoot, "pr-body.md");
      writeFileSync(bodyFile, bodyLines.join("\n"));
      const ghArgs = ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body-file", bodyFile];
      if (ownerRepo) ghArgs.splice(2, 0, "--repo", ownerRepo);
      const pr = runTry("gh", ghArgs, repoDir);
      if (pr.ok) {
        const m = pr.out.match(/https?:\/\/\S+/);
        report.pr = { url: m ? m[0] : null, branch, ...(m ? {} : { warning: "no URL in gh output", raw: scrub(pr.out).slice(0, 200) }) };
        log(`PR opened: ${report.pr.url || "(url not parsed)"}`);
      } else if (/already exists/i.test(pr.out)) {
        const view = runTry("gh", ["pr", "view", branch, "--json", "url", "-q", ".url"], repoDir);
        report.pr = { url: view.ok ? view.out.trim() : null, branch, reused: true };
        log(`PR already existed, reused: ${report.pr.url}`);
      } else {
        report.pr = { pushed: true, branch, prError: scrub(pr.out).slice(0, 300) };
        throw new Error(`gh pr create failed (branch pushed): ${scrub(pr.out).slice(-300)}`);
      }

      // Watched Paperclip issue so the no-mistakes review-watcher also reviews this PR.
      // Fail-soft: a PR already gated by No-Mistakes must not be undone by an issue-API hiccup.
      if (report.pr?.url) {
        try {
          const companyId = process.env.PAPERCLIP_COMPANY_ID || "1e8bc12a-f8fd-431c-9fbd-e47be79446a3";
          const projectId = process.env.PAPERCLIP_DARK_FACTORY_PROJECT_ID || "c4525f28-55d1-4378-864c-aec26d51fc37";
          let labelIds = [];
          try {
            const labels = await api("GET", `/companies/${companyId}/labels`);
            const list = Array.isArray(labels) ? labels : (labels?.labels || labels?.data || []);
            const hit = list.find((l) => String(l?.name || "").toLowerCase() === "gate: no-mistakes-required");
            if (hit?.id) labelIds = [hit.id];
          } catch { /* label lookup is best-effort */ }
          const issue = await api("POST", `/companies/${companyId}/issues`, {
            projectId,
            title: `Review: ${title}`.slice(0, 120),
            description: `Conductor-opened PR awaiting No-Mistakes review.\n\nPR: ${report.pr.url}\nBranch: ${branch}\nTask: ${task}\nConductor run: ${runId}`,
            ...(labelIds.length ? { labelIds } : {}),
          });
          report.reviewIssue = { id: issue?.id || issue?.issue?.id || null, labelled: labelIds.length > 0 };
          log(`watched review issue created: ${report.reviewIssue.id || "(id not parsed)"}${labelIds.length ? "" : " (label not found - board-visible only)"}`);
        } catch (e) {
          report.reviewIssue = { error: scrub(e instanceof Error ? e.message : String(e)) };
          log(`WARN: watched review issue not created: ${report.reviewIssue.error}`);
        }
      }
    }
    report.status = "success";
  } catch (err) {
    report.status = "failed";
    report.error = scrub(err instanceof Error ? err.message : String(err));
    log("FAILED:", report.error);
  } finally {
    report.finishedAt = new Date().toISOString();
    if (!keepWorktree) { try { rmSync(runRoot, { recursive: true, force: true }); } catch { /* ignore */ } }
    const outDir = path.join(HERE, "runs"); mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `run-${runId}.json`);
    writeFileSync(outFile, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log("\n=== CONDUCTOR REPORT ===");
    console.log(JSON.stringify(report, null, 2));
    console.log("report saved:", outFile);
    process.exit(report.status === "success" ? 0 : 1);
  }
})();
