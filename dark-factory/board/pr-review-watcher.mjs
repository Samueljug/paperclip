#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const API = process.env.PAPERCLIP_API_BASE || "http://127.0.0.1:3101/api";
const COMPANY_ID = "1e8bc12a-f8fd-431c-9fbd-e47be79446a3";
const DARK_FACTORY_PROJECT_ID = "c4525f28-55d1-4378-864c-aec26d51fc37";
const WORKSPACE = resolve(import.meta.dirname, "../..");
const LEDGERS_DIR = resolve(WORKSPACE, "tools/paperclip-data/factory-run-ledgers");
const ACTIVE_STATUSES = new Set(["in_review", "blocked", "in_progress"]);
const ACTIONABLE_RE = /\b(bug|broken|fail(?:s|ed|ing)?|error|security|vulnerab|missing test|regression|incorrect|does not work|doesn't work|crash|leak|tenant|auth|permission|blocker)\b/i;

function parseArgs(argv) {
  return {
    apply: argv.includes("--apply"),
  };
}

async function request(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${options.method || "GET"} ${path} -> ${res.status}: ${text}`);
  return body;
}

function extractPrUrls(text) {
  const urls = new Set();
  const pattern = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g;
  for (const match of String(text || "").matchAll(pattern)) {
    urls.add(match[0].replace(/[),.]+$/, ""));
  }
  return [...urls];
}

function readOptional(path) {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function issueText(issue) {
  const comments = await request(`/issues/${issue.id}/comments`).catch(() => []);
  const ledgerText = readOptional(resolve(LEDGERS_DIR, issue.identifier, "events.jsonl"));
  return [
    issue.title,
    issue.description,
    ...(comments || []).map((comment) => comment.body || ""),
    ledgerText,
  ].join("\n");
}

function ghJson(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || `gh exited ${result.status}`).trim() };
  }
  try {
    return { ok: true, body: JSON.parse(result.stdout || "null") };
  } catch (error) {
    return { ok: false, error: `Could not parse gh JSON: ${error.message}` };
  }
}

function parsePrUrl(url) {
  const match = String(url).match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: match[3], full: `${match[1]}/${match[2]}` };
}

function checkIsPassing(check) {
  const status = String(check.status || check.state || "").toUpperCase();
  const conclusion = String(check.conclusion || "").toUpperCase();
  if (check.conclusion === null || check.conclusion === undefined) {
    return ["SUCCESS", "PASSED"].includes(status);
  }
  return status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion);
}

function classifyPr(pr, inlineComments) {
  const findings = [];
  const checks = pr.statusCheckRollup || [];
  const failingChecks = checks.filter((check) => !checkIsPassing(check));
  if (failingChecks.length > 0) {
    findings.push({
      kind: "ci",
      severity: "blocker",
      summary: `Checks not passing: ${failingChecks.map((check) => check.name || check.context || "unknown").join(", ")}`,
    });
  }
  for (const review of pr.latestReviews || []) {
    const state = String(review.state || "").toUpperCase();
    if (state === "CHANGES_REQUESTED") {
      findings.push({
        kind: "review",
        severity: "blocker",
        summary: `Changes requested by ${review.author?.login || "unknown reviewer"}`,
      });
    }
  }
  for (const comment of [...(pr.comments || []), ...(inlineComments || [])]) {
    const body = comment.body || "";
    if (!ACTIONABLE_RE.test(body)) continue;
    findings.push({
      kind: "comment",
      severity: "needs_classification",
      summary: `Potential actionable comment by ${comment.author?.login || comment.user?.login || "unknown"}: ${body.slice(0, 180).replace(/\s+/g, " ")}`,
      url: comment.url || comment.html_url || null,
    });
  }
  if (pr.reviewDecision && !["APPROVED", "REVIEW_REQUIRED"].includes(pr.reviewDecision)) {
    findings.push({
      kind: "review_decision",
      severity: "blocker",
      summary: `GitHub review decision is ${pr.reviewDecision}`,
    });
  }
  return findings;
}

async function hasMarker(issueId, marker) {
  const comments = await request(`/issues/${issueId}/comments`).catch(() => []);
  return (comments || []).some((comment) => String(comment.body || "").includes(marker));
}

async function postComment(issueId, body) {
  return request(`/issues/${issueId}/comments`, {
    method: "POST",
    body: JSON.stringify({
      body,
      authorType: "user",
      presentation: {
        kind: "system_notice",
        tone: "warning",
        title: "PR review watcher",
        detailsDefaultOpen: false,
      },
    }),
  });
}

async function patchStatus(issueId, status) {
  return request(`/issues/${issueId}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

async function auditIssue(issue, apply) {
  const text = await issueText(issue);
  const prUrls = extractPrUrls(text);
  const results = [];
  for (const prUrl of prUrls) {
    const parsed = parsePrUrl(prUrl);
    if (!parsed) {
      results.push({ prUrl, action: "invalid_url" });
      continue;
    }
    const prResult = ghJson([
      "pr",
      "view",
      prUrl,
      "--json",
      "number,url,title,state,isDraft,baseRefName,headRefOid,mergedAt,statusCheckRollup,reviewDecision,mergeStateStatus,reviewRequests,latestReviews,comments",
    ]);
    if (!prResult.ok) {
      results.push({ prUrl, action: "gh_error", error: prResult.error });
      continue;
    }
    const pr = prResult.body;
    if (pr.mergedAt || pr.state === "CLOSED") {
      results.push({ prUrl, action: "not_open" });
      continue;
    }
    const inlineResult = ghJson(["api", `repos/${parsed.full}/pulls/${parsed.number}/comments`, "--paginate"]);
    const inlineComments = inlineResult.ok && Array.isArray(inlineResult.body) ? inlineResult.body : [];
    const findings = classifyPr(pr, inlineComments);
    if (findings.length === 0) {
      results.push({ prUrl, action: "open_clean" });
      continue;
    }
    const markerKey = `${issue.identifier}:${pr.headRefOid || prUrl}:${findings.map((finding) => finding.summary).join("|")}`;
    const marker = `<!-- pr-review-watcher:${Buffer.from(markerKey).toString("base64url")} -->`;
    if (apply) {
      const seen = await hasMarker(issue.id, marker);
      if (!seen) {
        await postComment(issue.id, [
          marker,
          `PR review watcher found feedback that should enter the repair loop: ${pr.url || prUrl}`,
          "",
          ...findings.map((finding) => `- ${finding.summary}${finding.url ? ` (${finding.url})` : ""}`),
          "",
          "Next action: implementation lead should repair actionable findings in a fresh checkout, rerun verification/security/No Mistakes as applicable, and update the PR.",
        ].join("\n"));
      }
      if (issue.status !== "in_progress") await patchStatus(issue.id, "in_progress");
    }
    results.push({ prUrl, action: apply ? "repair_loop_marked" : "would_mark_repair_loop", findings });
  }
  return { issue: issue.identifier, results };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const issues = await request(`/companies/${COMPANY_ID}/issues?projectId=${DARK_FACTORY_PROJECT_ID}`);
  const active = issues.filter((issue) => ACTIVE_STATUSES.has(issue.status));
  const results = [];
  for (const issue of active) {
    try {
      results.push(await auditIssue(issue, args.apply));
    } catch (error) {
      results.push({ issue: issue.identifier, action: "issue_error", error: error.message });
    }
  }
  console.log(JSON.stringify({
    ok: true,
    apply: args.apply,
    checked: active.length,
    changedOrBlocked: results.filter((item) => JSON.stringify(item).match(/repair_loop|error/)).length,
    results,
  }, null, 2));
}

main().catch((error) => {
  console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
