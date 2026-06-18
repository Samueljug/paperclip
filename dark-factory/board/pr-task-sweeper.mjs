#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyLedger, ledgerPaths, DEFAULT_LEDGER_ROOT } from "./ledger-lib.mjs";

const API = process.env.PAPERCLIP_API_BASE || "http://127.0.0.1:3101/api";
const COMPANY_ID = "1e8bc12a-f8fd-431c-9fbd-e47be79446a3";
const DARK_FACTORY_PROJECT_ID = "c4525f28-55d1-4378-864c-aec26d51fc37";
const WORKSPACE = resolve(fileURLToPath(import.meta.url), "../../..");
const RUNS_DIR = process.env.DARK_FACTORY_RUN_DIR
  ? resolve(process.env.DARK_FACTORY_RUN_DIR)
  : resolve(WORKSPACE, "tools/paperclip-data/factory-runs");
const LEDGERS_DIR = DEFAULT_LEDGER_ROOT;
const ACTIVE_STATUSES = new Set(["todo", "in_progress", "in_review", "blocked"]);

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
  if (!res.ok) {
    throw new Error(`${options.method || "GET"} ${path} -> ${res.status}: ${text}`);
  }
  return body;
}

function issueLabelNames(issue) {
  return new Set((issue.labels || []).map((label) => label.name).filter(Boolean));
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

async function issueComments(issue) {
  return request(`/issues/${issue.id}/comments`).catch(() => []);
}

async function issueText(issue, comments = null) {
  const resolvedComments = comments || await issueComments(issue);
  const cleanComments = (resolvedComments || []).filter((c) =>
    !String(c.body || "").includes("<!-- pr-task-sweeper") &&
    !(c.presentation?.title === "PR/task sweeper")
  );
  const paths = ledgerPaths(issue.identifier, LEDGERS_DIR);
  const ledgerText = readOptional(paths.eventsPath);
  return [
    issue.title,
    issue.description,
    ...cleanComments.map((comment) => comment.body || ""),
    ledgerText,
  ].join("\n");
}

function latestRunDir(identifier) {
  if (!existsSync(RUNS_DIR)) return null;
  const candidates = readdirSync(RUNS_DIR)
    .filter((name) => name.startsWith(`${identifier}-`))
    .map((name) => resolve(RUNS_DIR, name))
    .filter((dir) => existsSync(resolve(dir, "run-manifest.json")))
    .map((dir) => {
      try {
        const manifest = JSON.parse(readFileSync(resolve(dir, "run-manifest.json"), "utf8"));
        const timeStr = manifest.updatedAt || manifest.createdAt || "1970-01-01T00:00:00.000Z";
        return { dir, time: new Date(timeStr).getTime() };
      } catch {
        return { dir, time: 0 };
      }
    })
    .sort((a, b) => b.time - a.time);
  return candidates[0]?.dir || null;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function noMistakesHead(manifest) {
  const gatePath = manifest?.gates?.no_mistakes?.path;
  if (!gatePath || !existsSync(gatePath)) return null;
  try {
    const gate = readJson(gatePath);
    return gate.details?.headAfter || gate.details?.head || null;
  } catch {
    return null;
  }
}

function readWorkOrderForManifest(manifest) {
  const path = manifest?.paths?.workOrder;
  if (!path || !existsSync(path)) return null;
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

function evidenceItemHasUsableArtifact(item) {
  if (!item) return false;
  if (item.url) return true;
  if (!item.path) return false;
  return existsSync(item.path);
}

function browserEvidenceRequired(issue, pr, manifest) {
  const labels = issueLabelNames(issue);
  if (labels.has("evidence: screenshots") || labels.has("gate: design-verification-required")) return true;
  const workOrder = readWorkOrderForManifest(manifest);
  const requirements = new Set(Array.isArray(workOrder?.evidenceRequirements) ? workOrder.evidenceRequirements : []);
  if (
    workOrder?.gates?.browserQa === true
    || workOrder?.changeType === "ui"
    || workOrder?.changeType === "fullstack"
    || requirements.has("browser_qa")
    || requirements.has("screenshot")
    || requirements.has("video")
  ) {
    return true;
  }
  const prText = `${pr?.url || ""} ${pr?.title || ""}`.toLowerCase();
  return prText.includes("frontend") || prText.includes("aila-website");
}

function browserEvidenceBlockers(issue, pr, manifest) {
  if (!browserEvidenceRequired(issue, pr, manifest)) return [];
  if (!manifest) {
    return ["browser evidence missing: no Foreman run found for UI/browser PR"];
  }
  const blockers = [];
  const gate = manifest.gates?.browser_qa;
  if (!gate) {
    blockers.push("browser evidence missing: Browser QA gate is absent");
  } else if (gate.verdict !== "PASS") {
    blockers.push(`browser evidence missing: Browser QA gate verdict is ${gate.verdict}`);
  }
  const packPath = manifest.paths?.evidencePack;
  let pack = { items: [] };
  if (packPath && existsSync(packPath)) {
    try {
      pack = readJson(packPath);
    } catch {
      blockers.push("browser evidence missing: evidence pack could not be parsed");
    }
  }
  const hasBrowserReport = (pack.items || []).some((item) => (item.kind === "browser_qa" || item.kind === "browser_smoke") && evidenceItemHasUsableArtifact(item));
  const hasScreenshot = (pack.items || []).some((item) => item.kind === "screenshot" && evidenceItemHasUsableArtifact(item));
  if (!hasBrowserReport) {
    blockers.push("browser evidence missing: no usable Browser QA report artifact in evidence pack");
  }
  if (!hasScreenshot) {
    blockers.push("browser evidence missing: no screenshot artifact proving the tested browser state");
  }
  return blockers;
}

const IMPROVER_VERDICTS = new Set(["noop", "lesson_recorded", "skill_request", "policy_request", "monitoring_needed", "not_applicable"]);

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
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

function paperclipImproverCommentPresent(comments, agentsMap = null) {
  return (comments || []).some((comment) => {
    let isTrustedImprover = false;
    if (comment.authorType === "agent" && comment.authorAgentId && agentsMap && agentsMap.size > 0) {
      const agentName = String(agentsMap.get(comment.authorAgentId) || "").toLowerCase();
      if (agentName.includes("self-improvement-lead")) {
        isTrustedImprover = true;
      }
    }
    if (!isTrustedImprover) return false;

    const text = commentText(comment);
    if (text.includes("<!-- pr-task-sweeper")) return false;
    const presentationTitle = String(comment.presentation?.title || "").toLowerCase();
    if (presentationTitle.includes("pr/task sweeper")) return false;
    const structured = [comment.metadata, comment.presentation]
      .map((value) => commentText({ body: "", metadata: value, presentation: null }))
      .join("\n");
    const structuredRole = structured.includes("self-improvement-lead") || structured.includes("improver");
    const structuredEvent = /\b(improvement_review|improvement_noop|improvement_not_applicable|gate_result:self_improvement)\b/.test(structured);
    const body = String(comment.body || "").toLowerCase();
    const bodyRolePrefix = /^\s*\[(self-improvement-lead|improver)\]/.test(body);
    const bodyEvent = /\bevent type:\s*(improvement_review|improvement_noop|improvement_not_applicable|gate_result:self_improvement)\b/.test(body)
      || /\b(improvement_review|improvement_noop|improvement_not_applicable)\b/.test(body);
    return (structuredRole && structuredEvent) || (bodyRolePrefix && bodyEvent);
  });
}

function improverVerdictFromDetails(details = {}) {
  return details.improverVerdict || details.improvementVerdict || details.outcome || details.verdict || null;
}

function hasNonEmptyValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return String(value || "").trim().length > 0;
}

function selfImprovementBlockers(issue, manifest, comments, agentsMap = null) {
  const blockers = [];
  const ledger = verifyLedger(issue.identifier);
  if (!ledger.ok) {
    blockers.push("self-improvement evidence missing: factory ledger verification failed or has no events");
  }
  if (!manifest) {
    blockers.push("self-improvement evidence missing: no Foreman run found for mandatory improver gate");
  } else {
    const gate = manifest.gates?.self_improvement;
    if (!gate) {
      blockers.push("self-improvement evidence missing: self_improvement gate is absent");
    } else if (gate.verdict !== "PASS") {
      blockers.push(`self-improvement evidence missing: self_improvement gate verdict is ${gate.verdict}`);
    } else if (!gate.path || !existsSync(gate.path)) {
      blockers.push("self-improvement evidence missing: self_improvement gate artifact is absent");
    } else {
      try {
        const gateResult = readJson(gate.path);
        const details = gateResult.details || {};
        const improverVerdict = improverVerdictFromDetails(details);
        if (!IMPROVER_VERDICTS.has(improverVerdict)) {
          blockers.push("self-improvement evidence missing: self_improvement gate lacks a valid improver verdict");
        }
        const owner = details.owner || details.reviewer || details.improver || details.actor || details.notApplicableOwner || details.notApplicable?.owner;
        const sourceCoverage = details.sourceCoverage ?? details.sourceRefs ?? details.sources;
        if (!hasNonEmptyValue(owner)) {
          blockers.push("self-improvement evidence missing: self_improvement gate lacks accountable owner/reviewer");
        }
        if (!hasNonEmptyValue(sourceCoverage)) {
          blockers.push("self-improvement evidence missing: self_improvement gate lacks non-empty source coverage");
        }
        if (!hasNonEmptyValue(details.missingCoverage)) {
          blockers.push("self-improvement evidence missing: self_improvement gate lacks missing-coverage statement");
        }
        if (improverVerdict === "not_applicable") {
          const reason = details.notApplicableReason || details.reason || details.notApplicable?.reason;
          if (!hasNonEmptyValue(reason) || !hasNonEmptyValue(owner)) {
            blockers.push("self-improvement evidence missing: not_applicable lacks owner/reason");
          }
        }
      } catch {
        blockers.push("self-improvement evidence missing: self_improvement gate artifact could not be parsed");
      }
    }
    const packPath = manifest.paths?.evidencePack;
    let pack = { items: [] };
    if (packPath && existsSync(packPath)) {
      try {
        pack = readJson(packPath);
      } catch {
        blockers.push("self-improvement evidence missing: evidence pack could not be parsed");
      }
    }
    const hasImproverReport = (pack.items || []).some((item) => item.kind === "improver_review" && evidenceItemHasUsableArtifact(item));
    if (!hasImproverReport) {
      blockers.push("self-improvement evidence missing: no usable improver_review artifact in evidence pack");
    }
  }
  if (!paperclipImproverCommentPresent(comments, agentsMap)) {
    blockers.push("self-improvement evidence missing: no Paperclip-visible improver review/no-op/not-applicable comment");
  }
  return blockers;
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

function paperclipEvidenceBlockers(issue, comments, manifest, attachments) {
  if (!manifest) return [];
  const workOrder = readWorkOrderForManifest(manifest);
  if (!workOrder) return [];
  if (workOrder.gates?.paperclipEvidence === false || workOrder.paperclipEvidence === false) return [];
  
  const blockers = [];
  
  const cleanComments = comments.filter((c) =>
    !String(c.body || "").includes("<!-- pr-task-sweeper") &&
    !(c.presentation?.title === "PR/task sweeper")
  );
  
  // 1. Check implementation evidence comment
  if (workOrder.gates?.evidence !== false) {
    const spec = {
      roles: ["implementation-lead", "codex-builder", "builder", "implementer"],
      events: ["implementation_complete", "implementation_evidence", "evidence_recorded", "gate_result:evidence"],
      patterns: [/implementation[^\n]*(complete|pass|done)/i, /evidence[^\n]*(recorded|pass|complete)/i],
    };
    const hasComment = cleanComments.some((c) => (c.authorType === "agent" || c.authorType === "user") && commentMatchesSpec(c, spec));
    if (!hasComment) {
      blockers.push("paperclip evidence missing: implementation/evidence Paperclip comment is absent");
    }
  }
  
  // 2. Check verification comment
  if (workOrder.gates?.tests) {
    const spec = {
      roles: ["verification-lead", "test-engineer", "tester"],
      events: ["verification_pass", "tests_passed", "gate_result:tests", "gate_result:verification"],
      patterns: [/(verification|tests?)[^\n]*(pass|passed|verified|complete|done)/i],
    };
    const hasComment = cleanComments.some((c) => (c.authorType === "agent" || c.authorType === "user") && commentMatchesSpec(c, spec));
    if (!hasComment) {
      blockers.push("paperclip evidence missing: verification/tests Paperclip comment is absent");
    }
  }
  
  // 3. Check security review comment
  if (workOrder.gates?.securityReview) {
    const spec = {
      roles: ["security-lead", "security-reviewer"],
      events: ["security_pass", "security_review", "gate_result:security_review", "gate_result:security"],
      patterns: [/security[^\n]*(pass|passed|review|complete|done)/i],
    };
    const hasComment = cleanComments.some((c) => (c.authorType === "agent" || c.authorType === "user") && commentMatchesSpec(c, spec));
    if (!hasComment) {
      blockers.push("paperclip evidence missing: security review Paperclip comment is absent");
    }
  }
  
  // 4. Check browser QA comment & attachment
  const requirements = new Set(Array.isArray(workOrder.evidenceRequirements) ? workOrder.evidenceRequirements : []);
  const browserRequired = workOrder.gates?.browserQa === true || workOrder.changeType === "ui" || workOrder.changeType === "fullstack" || requirements.has("browser_qa");
  
  if (browserRequired) {
    const spec = {
      roles: ["browser-qa-lead", "visual-qa", "webwright", "qa"],
      events: ["browser_qa_pass", "visual_qa_pass", "gate_result:browser_qa"],
      patterns: [/(browser|visual|screenshot|video)[^\n]*(pass|passed|qa|verified|complete|done|ok)/i],
    };
    const hasComment = cleanComments.some((c) => (c.authorType === "agent" || c.authorType === "user") && commentMatchesSpec(c, spec));
    if (!hasComment) {
      blockers.push("paperclip evidence missing: browser QA Paperclip comment is absent");
    }
    
    const videoRequired = workOrder.changeType === "fullstack" || requirements.has("video");
    if (videoRequired) {
      const hasVideo = (attachments || []).some((a) => {
        const type = String(a.contentType || "").toLowerCase();
        const name = String(a.originalFilename || a.filename || "").toLowerCase();
        return type.startsWith("video/") || /\.(mp4|mov|m4v|webm|avi|mkv)$/.test(name);
      });
      if (!hasVideo) {
        blockers.push("paperclip evidence missing: Paperclip video attachment is absent");
      }
    } else {
      const hasImageOrVideo = (attachments || []).some((a) => {
        const type = String(a.contentType || "").toLowerCase();
        const name = String(a.originalFilename || a.filename || "").toLowerCase();
        return type.startsWith("image/") || type.startsWith("video/") || /\.(png|jpe?g|gif|webp|bmp|svg|mp4|mov|m4v|webm)$/.test(name);
      });
      if (!hasImageOrVideo) {
        blockers.push("paperclip evidence missing: Paperclip screenshot or video attachment is absent");
      }
    }
  }
  
  // 5. Check No Mistakes comment
  if (workOrder.gates?.noMistakes !== false) {
    const spec = {
      roles: ["no-mistakes-lead", "no-mistakes-reviewer"],
      events: ["no_mistakes_pass", "gate_result:no_mistakes"],
      patterns: [/no[ -]?mistakes[^\n]*pass/i],
    };
    const hasComment = cleanComments.some((c) => (c.authorType === "agent" || c.authorType === "user") && commentMatchesSpec(c, spec));
    if (!hasComment) {
      blockers.push("paperclip evidence missing: No Mistakes Paperclip comment is absent");
    }
  }
  
  return blockers;
}

function checkIsPassing(check) {
  const status = String(check.status || check.state || "").toUpperCase();
  const conclusion = String(check.conclusion || "").toUpperCase();
  if (check.conclusion === null || check.conclusion === undefined) {
    return ["SUCCESS", "PASSED"].includes(status);
  }
  return status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion);
}

function ghPrView(url) {
  const fields = [
    "number",
    "url",
    "title",
    "state",
    "isDraft",
    "baseRefName",
    "headRefName",
    "headRefOid",
    "mergedAt",
    "mergedBy",
    "statusCheckRollup",
    "reviewDecision",
    "mergeStateStatus",
    "reviewRequests",
    "latestReviews",
  ].join(",");
  const result = spawnSync("gh", ["pr", "view", url, "--json", fields], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return {
      ok: false,
      error: (result.stderr || result.stdout || `gh exited ${result.status}`).trim(),
    };
  }
  try {
    return { ok: true, body: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, error: `Could not parse gh output: ${error.message}` };
  }
}

function reviewLogin(reviewer) {
  return reviewer?.login || reviewer?.name || reviewer?.id || null;
}

function runReadinessReport(runDir, includePr = false) {
  const FOREMAN_PATH = resolve(WORKSPACE, "tools/dark-factory/foreman.mjs");
  const args = ["ready", "--run", runDir];
  if (includePr) {
    args.push("--include-pr");
  }
  const result = spawnSync("node", [FOREMAN_PATH, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0 && result.status !== 1) {
    return {
      ok: false,
      failures: [{ kind: "foreman_exec", reason: `Foreman execution failed: ${result.stderr || "unknown"}` }],
    };
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    return {
      ok: false,
      failures: [{ kind: "foreman_parse", reason: `Could not parse Foreman output: ${error.message}` }],
    };
  }
}

function blockersFor(issue, pr, manifest, comments = [], prRequired = true, attachments = [], agentsMap = null, runDir = null) {
  const labels = issueLabelNames(issue);
  const checks = pr?.statusCheckRollup || [];
  const blockers = [];
  const incompleteChecks = checks.filter((check) => !checkIsPassing(check));
  const reviewRequests = pr ? (pr.reviewRequests || []).map(reviewLogin).filter(Boolean) : [];
  const latestReviews = pr ? pr.latestReviews || [] : [];
  const changeRequests = latestReviews.filter((review) => String(review.state || "").toUpperCase() === "CHANGES_REQUESTED");
  
  const hasWaiver = comments
    .filter((c) => !String(c.body || "").includes("<!-- pr-task-sweeper") && !(c.presentation?.title === "PR/task sweeper"))
    .some((c) =>
      c.authorType === "user" &&
      c.authorUserId === "local-board" &&
      /samuel approved waiver/i.test(c.body || "")
    );
  const noMistakesRequired = prRequired && !hasWaiver;
  const gateHead = noMistakesHead(manifest);

  if (runDir) {
    const readiness = runReadinessReport(runDir, prRequired);
    if (!readiness.ok) {
      for (const fail of readiness.failures || []) {
        blockers.push(`Foreman gate failure: ${fail.reason || fail.gate || "unknown"}`);
      }
    }
  }

  if (incompleteChecks.length) {
    blockers.push(`checks not passing: ${incompleteChecks.map((check) => check.name || check.context || "unknown").join(", ")}`);
  }
  if (reviewRequests.length && (!pr || !pr.mergedAt)) {
    blockers.push(`review requests pending: ${reviewRequests.join(", ")}`);
  }
  if (changeRequests.length) {
    blockers.push(`changes requested by: ${changeRequests.map((review) => review.author?.login || "unknown").join(", ")}`);
  }
  if (noMistakesRequired && !gateHead) {
    blockers.push("typed Foreman No Mistakes gate is missing");
  } else if (noMistakesRequired && pr && pr.headRefOid && gateHead !== pr.headRefOid) {
    blockers.push(`typed Foreman No Mistakes gate is not bound to PR head ${pr.headRefOid}; gate head is ${gateHead}`);
  }
  blockers.push(...browserEvidenceBlockers(issue, pr, manifest));
  blockers.push(...selfImprovementBlockers(issue, manifest, comments, agentsMap));
  blockers.push(...paperclipEvidenceBlockers(issue, comments, manifest, attachments));
  if (pr && !pr.mergedAt && pr.reviewDecision && pr.reviewDecision !== "APPROVED") {
    blockers.push(`GitHub review decision is ${pr.reviewDecision}`);
  }
  if (pr && pr.state === "CLOSED" && !pr.mergedAt) {
    blockers.push("linked implementation PR is closed but not merged");
  }
  return [...new Set(blockers)];
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
        tone: "info",
        title: "PR/task sweeper",
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

function blockerOwnerAction(blocker) {
  if (blocker.includes("No Mistakes")) {
    return "Owner/action: implementation lead reruns No Mistakes against the exact PR head, or Samuel explicitly waives the gate.";
  }
  if (blocker.startsWith("review requests pending")) {
    return "Owner/action: requested reviewer(s) complete review, or Samuel explicitly authorizes proceeding without that review.";
  }
  if (blocker.startsWith("changes requested")) {
    return "Owner/action: implementation lead repairs the requested changes in a fresh checkout, then reruns verification gates.";
  }
  if (blocker.startsWith("checks not passing")) {
    return "Owner/action: implementation lead fixes failing checks in a fresh checkout, then reruns local/CI-equivalent verification.";
  }
  if (blocker.startsWith("GitHub review decision")) {
    return "Owner/action: resolve the GitHub review state or record Samuel's explicit disposition.";
  }
  if (blocker.startsWith("browser evidence missing")) {
    return "Owner/action: Browser QA lead must log into the app where required, test the exact changed flow in Chrome/Webwright, attach screenshot evidence to the ticket/evidence pack, and record a PASS gate; otherwise keep the card blocked with an explicit Samuel waiver needed.";
  }
  if (blocker.startsWith("self-improvement evidence missing")) {
    return "Owner/action: self-improvement-lead must review the run, record improver_review evidence and a self_improvement PASS/no-op/not-applicable gate, and post the Paperclip-visible improvement comment before Done/ship.";
  }
  return "Owner/action: assigned factory lead resolves or records the explicit waiver for this blocker.";
}

function blockerComment(marker, pr, prUrl, blockers, context) {
  const ownerActions = [...new Set(blockers.map(blockerOwnerAction))];
  return [
    marker,
    `${context}: ${pr?.url || prUrl || "(no PR)"}`,
    "",
    ...blockers.map((blocker) => `- ${blocker}`),
    "",
    ...ownerActions.map((line) => `- ${line}`),
    "",
    "Duplicate-blocker suppression: future sweeps with the same PR head/blocker set should leave this card parked instead of re-handing it off.",
  ].join("\n");
}

function isQaOrReportOnly(issue, comments, manifest, hasLinkedPr) {
  const title = String(issue.title || "").toLowerCase();
  const description = String(issue.description || "").toLowerCase();
  const labelNames = (issue.labels || []).map((l) => String(l.name || "").toLowerCase());

  const workOrder = manifest ? readWorkOrderForManifest(manifest) : null;
  const hasPlan = !!workOrder;

  const isQaTitleOrDesc = /qa\b|audit|report-only/i.test(title) ||
    /qa\b|audit|report-only/i.test(description);
  const isQaLabel = labelNames.some((name) => /qa|audit|report/i.test(name));

  const isFindingLabel = labelNames.some((name) => /finding|evidence/i.test(name));
  const isFindingTitleOrDesc = /\b(finding|evidence)\b/i.test(title) || /\b(finding|evidence)\b/i.test(description);
  const isFindingCard = isFindingLabel || isFindingTitleOrDesc;

  const isRemediationTitleOrDesc = /fix\b|remediat|resolve|patch|bug\b|issue\b|error\b|fail|miss|broken|correct/i.test(title) ||
    /fix\b|remediat|resolve|patch|bug\b|issue\b|error\b|fail|miss|broken|correct/i.test(description);

  const hasEvidenceRecordLabel = labelNames.some((name) => /evidence-record|finding-record/i.test(name));
  const hasEvidenceRecordComment = comments.some((c) =>
    c.authorType === "user" &&
    c.authorUserId === "local-board" &&
    /\b(evidence record|finding record|completed qa finding record|not new implementation|no implementation is approved|remediation is not approved)\b/i.test(c.body || "")
  );
  const isExplicitEvidenceRecord = hasEvidenceRecordLabel || hasEvidenceRecordComment;

  let isExplicitlyQaOrFinding = false;
  if (isExplicitEvidenceRecord) {
    isExplicitlyQaOrFinding = true;
  } else if (isFindingCard) {
    // Finding cards must be explicitly labelled/commented as evidence records to be bypassed
  } else if ((isQaTitleOrDesc || isQaLabel) && !isRemediationTitleOrDesc) {
    isExplicitlyQaOrFinding = true;
  }

  const hasUserOverride = comments.some((c) =>
    c.authorType === "user" &&
    c.authorUserId === "local-board" &&
    /\b(not new implementation|no implementation is approved|remediation is not approved|completed qa finding record)\b/i.test(c.body || "")
  );

  const hasAgentFixComment = comments.some((c) =>
    c.authorType === "agent" &&
    /\b(fixed|implemented|remediated|completed the fix|fix is complete)\b/i.test(c.body || "")
  );

  const isCompletedFix = (hasPlan || hasAgentFixComment) && !hasUserOverride;
  return isExplicitlyQaOrFinding && !isCompletedFix && !hasLinkedPr;
}

const ALLOWED_OWNERS = new Set(["samueljug", "aila-code", "aila-quillio", "paperclipai"]);

function parseGithubUrl(url) {
  const match = String(url || "").match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git|\/pull|\/|$)/i);
  if (!match) return null;
  return {
    owner: match[1].toLowerCase(),
    repo: match[2].toLowerCase(),
  };
}

function isPrMatchingRun(issue, pr, prUrl, manifest, workOrder) {
  const parsedPr = parseGithubUrl(prUrl);
  if (!parsedPr || !ALLOWED_OWNERS.has(parsedPr.owner)) {
    return false;
  }

  const prGatePath = manifest?.gates?.pr?.path;
  if (prGatePath && existsSync(prGatePath)) {
    try {
      const gate = JSON.parse(readFileSync(prGatePath, "utf8"));
      if (gate.details?.url) {
        return gate.details.url.toLowerCase() === prUrl.toLowerCase();
      }
    } catch {}
  }

  if (manifest?.repo || workOrder) {
    const expectedBase = manifest?.repo?.baseBranch || workOrder?.baseBranch || null;
    const expectedHead = manifest?.repo?.branch || workOrder?.branch || null;
    
    if (expectedBase && pr.baseRefName !== expectedBase) {
      return false;
    }
    if (expectedHead && pr.headRefName !== expectedHead) {
      return false;
    }
    
    const manifestRepoUrl = manifest?.repo?.url || workOrder?.repoUrl || null;
    if (manifestRepoUrl) {
      const parsedManifest = parseGithubUrl(manifestRepoUrl);
      if (parsedManifest && (parsedManifest.owner !== parsedPr.owner || parsedManifest.repo !== parsedPr.repo)) {
        return false;
      }
    }
    return true;
  }

  // Fallback if no manifest/workOrder: the branch name or title MUST contain the issue identifier (e.g. OPE-573)
  const idPattern = new RegExp(`\\b${issue.identifier}\\b`, "i");
  const matchesIdentifier = idPattern.test(pr.headRefName || "") || idPattern.test(pr.title || "") || idPattern.test(pr.body || "");
  if (!matchesIdentifier) {
    return false;
  }

  return true;
}

async function auditIssue(issue, apply, agentsMap = null) {
  const comments = await issueComments(issue);
  const attachments = await request(`/issues/${issue.id}/attachments`).catch(() => []);
  const text = await issueText(issue, comments);
  
  const runDir = latestRunDir(issue.identifier);
  const manifest = runDir ? readJson(resolve(runDir, "run-manifest.json")) : null;

  const prUrls = extractPrUrls(text);
  const hasLinkedPr = prUrls.length > 0;

  const qaOrReportOnly = isQaOrReportOnly(issue, comments, manifest, hasLinkedPr);
  const workOrder = manifest ? readWorkOrderForManifest(manifest) : null;
  let prRequired = workOrder ? (workOrder.taskRoute?.prBacked !== false && workOrder.gates?.pr !== false) : true;
  if (qaOrReportOnly) {
    prRequired = false;
  }

  if ((qaOrReportOnly || !prRequired) && !manifest) {
    return { issue: issue.identifier, action: "qa_report_only_allowed" };
  }

  const results = [];
  let hasFailingChecks = false;
  let allMergedAndClean = true;
  let anyPROpen = false;
  const totalBlockers = [];

  const matchedPrs = [];
  for (const prUrl of prUrls) {
    const prResult = ghPrView(prUrl);
    if (!prResult.ok) {
      const errorMsg = `GitHub PR lookup failed: ${prResult.error || "unknown error"}`;
      totalBlockers.push(errorMsg);
      results.push({ prUrl, action: "gh_error", error: prResult.error });
      allMergedAndClean = false;
      continue;
    }
    const pr = prResult.body;
    if (!isPrMatchingRun(issue, pr, prUrl, manifest, workOrder)) {
      continue;
    }
    matchedPrs.push({ prUrl, pr });
  }

  if (!matchedPrs.length) {
    if (prRequired) {
      const blockers = ["linked implementation PR/work product is missing"];
      const markerKey = `${issue.identifier}:nopr:missing_pr`;
      const marker = `<!-- pr-task-sweeper-v2:${Buffer.from(markerKey).toString("base64url")} -->`;
      
      if (apply) {
        const seen = await hasMarker(issue.id, marker);
        if (!seen) {
          const ownerActions = ["Owner/action: implementation lead must link the PR/work product, or Samuel explicitly approves a waiver."];
          const body = [
            marker,
            "PR is missing for a code-changing or remediation task.",
            "",
            "- linked implementation PR/work product is missing",
            "",
            ...ownerActions,
          ].join("\n");
          await postComment(issue.id, body);
        }
        if (issue.status !== "blocked") {
          await patchStatus(issue.id, "blocked");
        }
      }
      return { issue: issue.identifier, runDir, results: [{ prUrl: null, action: "missing_pr", blockers }] };
    } else {
      const blockers = blockersFor(issue, null, manifest, comments, prRequired, attachments, agentsMap, runDir);
      totalBlockers.push(...blockers);
      if (blockers.length > 0) {
        allMergedAndClean = false;
      }
      results.push({ prUrl: null, pr: null, blockers });
    }
  }

  for (const item of matchedPrs) {
    const pr = item.pr;
    const prUrl = item.prUrl;
    const blockers = blockersFor(issue, pr, manifest, comments, prRequired, attachments, agentsMap, runDir);
    totalBlockers.push(...blockers);

    if (!pr.mergedAt) {
      anyPROpen = true;
      allMergedAndClean = false;
      if (blockers.some((blocker) => blocker.startsWith("checks not passing") || blocker.startsWith("changes requested"))) {
        hasFailingChecks = true;
      }
    } else {
      if (blockers.length > 0) {
        allMergedAndClean = false;
      }
    }
    
    results.push({ prUrl, pr, blockers });
  }

  if (allMergedAndClean) {
    if (apply && issue.status !== "done") {
      const firstPr = results.find(r => r.pr)?.pr || {};
      const markerKey = `${issue.identifier}:allpr:done`;
      const marker = `<!-- pr-task-sweeper-v2:${Buffer.from(markerKey).toString("base64url")} -->`;
      const seen = await hasMarker(issue.id, marker);
      if (!seen) {
        await postComment(issue.id, [
          marker,
          `All linked PRs are merged and local gates are eligible.`,
          `- Merged at: ${firstPr.mergedAt || new Date().toISOString()}`,
          `- Run: ${runDir || "no Foreman run found"}`,
        ].join("\n"));
      }
      await patchStatus(issue.id, "done");
    }
    return { issue: issue.identifier, runDir, action: apply ? "moved_done_if_needed" : "would_move_done", results };
  }

  if (issue.status === "done") {
    if (apply) {
      await patchStatus(issue.id, "in_review");
    }
    return { issue: issue.identifier, runDir, action: apply ? "moved_in_review" : "would_move_in_review", results };
  }

  if (hasFailingChecks) {
    if (apply && issue.status !== "in_progress") {
      const markerKey = `${issue.identifier}:allpr:repair`;
      const marker = `<!-- pr-task-sweeper-v2:${Buffer.from(markerKey).toString("base64url")} -->`;
      const seen = await hasMarker(issue.id, marker);
      if (!seen) {
        await postComment(issue.id, [
          marker,
          `PR needs active repair before review can continue.`,
          "",
          ...totalBlockers.map((blocker) => `- ${blocker}`),
        ].join("\n"));
      }
      await patchStatus(issue.id, "in_progress");
    }
    return { issue: issue.identifier, runDir, action: "open_needs_repair", results };
  }

  if (totalBlockers.length > 0) {
    if (apply) {
      const markerKey = `${issue.identifier}:allpr:blocked:${totalBlockers.join("|").slice(0, 100)}`;
      const marker = `<!-- pr-task-sweeper-v2:${Buffer.from(markerKey).toString("base64url")} -->`;
      const seen = await hasMarker(issue.id, marker);
      if (!seen) {
        const firstPr = results.find(r => r.pr)?.pr || {};
        await postComment(issue.id, blockerComment(marker, firstPr, prUrls[0], totalBlockers, "PR is waiting on a non-repair gate blocker"));
      }
      if (issue.status !== "blocked") {
        await patchStatus(issue.id, "blocked");
      }
    }
    return { issue: issue.identifier, runDir, action: "open_waiting_blocked", results };
  }

  return { issue: issue.identifier, runDir, results };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const issues = await request(`/companies/${COMPANY_ID}/issues?projectId=${DARK_FACTORY_PROJECT_ID}`);
  const active = issues.filter((issue) => ACTIVE_STATUSES.has(issue.status) || issue.status === "done");
  const results = [];

  const agentsList = await request(`/companies/${COMPANY_ID}/agents`).catch(() => []);
  const agentsMap = new Map(agentsList.map((a) => [a.id, a.name]));

  for (const issue of active) {
    try {
      results.push(await auditIssue(issue, args.apply, agentsMap));
    } catch (error) {
      if (args.apply && issue.status === "done") {
        try {
          await patchStatus(issue.id, "blocked");
          const markerKey = `${issue.identifier}:sweeper_error`;
          const marker = `<!-- pr-task-sweeper-v2:${Buffer.from(markerKey).toString("base64url")} -->`;
          await postComment(issue.id, [
            marker,
            `PR/task sweeper failed to audit this Done card: ${error.message || "unknown error"}.`,
            "Transitioned card back to blocked status to fail closed.",
          ].join("\n"));
        } catch (patchError) {
          console.error(`Failed to fail-closed issue ${issue.identifier}:`, patchError);
        }
      }
      results.push({ issue: issue.identifier, action: "issue_error", error: error.message });
    }
  }

  console.log(JSON.stringify({
    ok: true,
    apply: args.apply,
    checked: active.length,
    changedOrBlocked: results.filter((item) => JSON.stringify(item).match(/moved|blocked|repair|error/)).length,
    results,
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  });
}

export {
  paperclipImproverCommentPresent,
  hasNonEmptyValue,
};
