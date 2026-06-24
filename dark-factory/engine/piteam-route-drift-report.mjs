#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_ORIGIN = process.env.PAPERCLIP_ORIGIN || "http://127.0.0.1:3101";
const DEFAULT_API_BASE = process.env.PAPERCLIP_API_BASE || `${DEFAULT_ORIGIN}/api`;
const DEFAULT_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "1e8bc12a-f8fd-431c-9fbd-e47be79446a3";

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

function dateMs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : null;
}

function ageSeconds(value, nowMs = Date.now()) {
  const ms = dateMs(value);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((nowMs - ms) / 1000));
}

function recentEnough(value, days, nowMs = Date.now()) {
  const ms = dateMs(value);
  if (!Number.isFinite(ms)) return false;
  return nowMs - ms <= days * 24 * 60 * 60 * 1000;
}

function isOpenIssue(issue) {
  return new Set(["todo", "in_progress", "in_review", "blocked"]).has(String(issue?.status || "").toLowerCase());
}

function timedOutRun(run) {
  return String(run?.status || "").toLowerCase() === "timed_out"
    || run?.resultJson?.timeoutFired === true
    || /timed? ?out/i.test(String(run?.livenessReason || ""));
}

function hasVisibleImproverComment(comment) {
  const body = String(comment?.body || "");
  return /\[self-improvement-lead\]/i.test(body)
    || /\b(improvement_noop|improvement_not_applicable|improvement_review|improver)\b/i.test(body);
}

function routeMismatchReasons(agent, expected) {
  const reasons = [];
  if (String(agent?.adapterType || "") !== expected.adapterType) {
    reasons.push(`adapterType=${agent?.adapterType || "none"} expected ${expected.adapterType}`);
  }
  if (String(agent?.adapterConfig?.command || "") !== expected.command) {
    reasons.push(`command=${agent?.adapterConfig?.command || "none"} expected ${expected.command}`);
  }
  if (String(agent?.adapterConfig?.model || "") !== expected.model) {
    reasons.push(`model=${agent?.adapterConfig?.model || "none"} expected ${expected.model}`);
  }
  if (String(agent?.metadata?.teamTemplate || "") !== expected.template) {
    reasons.push(`teamTemplate=${agent?.metadata?.teamTemplate || "none"} expected ${expected.template}`);
  }
  if (String(agent?.metadata?.teamTemplateLlm || "") !== expected.templateLlm) {
    reasons.push(`teamTemplateLlm=${agent?.metadata?.teamTemplateLlm || "none"} expected ${expected.templateLlm}`);
  }
  if (String(agent?.metadata?.teamTemplateModel || "") !== expected.model) {
    reasons.push(`teamTemplateModel=${agent?.metadata?.teamTemplateModel || "none"} expected ${expected.model}`);
  }
  return reasons;
}

async function fetchJson(url, label) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${label} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function collectIssueDetails(apiBase, issue, includeComments) {
  const [runs, comments] = await Promise.all([
    fetchJson(`${apiBase}/issues/${issue.id}/runs`, `issue runs ${issue.identifier || issue.id}`),
    includeComments
      ? fetchJson(`${apiBase}/issues/${issue.id}/comments`, `issue comments ${issue.identifier || issue.id}`)
      : Promise.resolve([]),
  ]);
  return { runs, comments };
}

async function buildReport(options) {
  const nowMs = Date.now();
  const agents = await fetchJson(
    `${options.apiBase}/companies/${options.companyId}/agents`,
    "company agents",
  );
  const issues = await fetchJson(
    `${options.apiBase}/companies/${options.companyId}/issues?limit=1000`,
    "company issues",
  );

  const piAgents = agents.filter((agent) => String(agent?.metadata?.lane || "") === options.piLane);
  const driftedAgents = piAgents
    .map((agent) => {
      const reasons = routeMismatchReasons(agent, options.expected);
      return reasons.length ? {
        id: agent.id,
        name: agent.name,
        title: agent.title,
        status: agent.status,
        adapterType: agent.adapterType,
        command: agent.adapterConfig?.command || null,
        model: agent.adapterConfig?.model || null,
        teamTemplate: agent.metadata?.teamTemplate || null,
        teamTemplateLlm: agent.metadata?.teamTemplateLlm || null,
        teamTemplateModel: agent.metadata?.teamTemplateModel || null,
        reasons,
      } : null;
    })
    .filter(Boolean);
  const driftedAgentIds = new Set(driftedAgents.map((agent) => agent.id));

  const openIssues = issues.filter((issue) => isOpenIssue(issue));
  const selfImprovementAgents = piAgents.filter(
    (agent) => String(agent?.metadata?.piRole || "").toLowerCase() === options.selfImprovementRole.toLowerCase(),
  );
  const selfImprovementAgentIds = new Set(selfImprovementAgents.map((agent) => agent.id));
  const selfImprovementTimeoutSec = Number(selfImprovementAgents[0]?.adapterConfig?.timeoutSec || options.defaultTimeoutSec);

  const queuedWrongRouteIssues = openIssues
    .filter((issue) => issue.assigneeAgentId && driftedAgentIds.has(issue.assigneeAgentId) && !issue.activeRun)
    .map((issue) => ({
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      assigneeAgentId: issue.assigneeAgentId,
      updatedAt: issue.updatedAt,
    }));

  const issueNeedsInspection = issues.filter((issue) => {
    if (issue.activeRun) return true;
    if (driftedAgentIds.has(String(issue.assigneeAgentId || ""))) return true;
    if (selfImprovementAgentIds.has(String(issue.assigneeAgentId || ""))) return true;
    return recentEnough(issue.updatedAt, options.days, nowMs);
  });

  const inspectionMap = new Map();
  for (const issue of issueNeedsInspection) {
    const includeComments = recentEnough(issue.updatedAt, options.days, nowMs);
    inspectionMap.set(issue.id, await collectIssueDetails(options.apiBase, issue, includeComments));
  }

  const activeWrongRouteIssues = [];
  const nearTimeoutSelfImprovementRuns = [];
  const timeoutCoverageGaps = [];
  const erroredPiAgents = piAgents
    .filter((agent) => /error|failed/i.test(String(agent?.status || "")))
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      status: agent.status,
      adapterType: agent.adapterType,
    }));

  for (const issue of openIssues) {
    const details = inspectionMap.get(issue.id);
    const runs = Array.isArray(details?.runs) ? details.runs : [];
    if (issue.activeRun) {
      const activeRunEntry = runs.find((run) => run.runId === issue.activeRun.id) || null;
      const assigneeDrifted = driftedAgentIds.has(String(issue.activeRun.agentId || issue.assigneeAgentId || ""));
      const adapterMismatch = activeRunEntry && String(activeRunEntry.adapterType || "") !== options.expected.adapterType;
      if (assigneeDrifted || adapterMismatch) {
        activeWrongRouteIssues.push({
          identifier: issue.identifier,
          title: issue.title,
          status: issue.status,
          runId: issue.activeRun.id,
          agentId: issue.activeRun.agentId,
          adapterType: activeRunEntry?.adapterType || null,
          startedAt: issue.activeRun.startedAt,
          reasons: [
            assigneeDrifted ? "active run belongs to a drifted PiTeam agent" : null,
            adapterMismatch ? `run adapterType=${activeRunEntry?.adapterType || "none"} expected ${options.expected.adapterType}` : null,
          ].filter(Boolean),
        });
      }
      if (selfImprovementAgentIds.has(String(issue.activeRun.agentId || ""))) {
        const ageSec = ageSeconds(issue.activeRun.startedAt, nowMs);
        if (ageSec !== null && ageSec >= Math.max(0, selfImprovementTimeoutSec - options.timeoutBufferSec)) {
          nearTimeoutSelfImprovementRuns.push({
            identifier: issue.identifier,
            title: issue.title,
            runId: issue.activeRun.id,
            startedAt: issue.activeRun.startedAt,
            ageSec,
            timeoutSec: selfImprovementTimeoutSec,
          });
        }
      }
    }
  }

  const recentIssues = issues.filter((issue) => recentEnough(issue.updatedAt, options.days, nowMs));
  for (const issue of recentIssues) {
    const details = inspectionMap.get(issue.id);
    const runs = Array.isArray(details?.runs) ? details.runs : [];
    const comments = Array.isArray(details?.comments) ? details.comments : [];
    const timeoutRuns = runs.filter((run) => selfImprovementAgentIds.has(String(run.agentId || "")) && timedOutRun(run));
    for (const run of timeoutRuns) {
      const covered = comments.some((comment) => {
        const commentMs = dateMs(comment.createdAt);
        const startedMs = dateMs(run.startedAt);
        return hasVisibleImproverComment(comment) && Number.isFinite(commentMs) && Number.isFinite(startedMs) && commentMs >= startedMs;
      });
      if (!covered) {
        timeoutCoverageGaps.push({
          identifier: issue.identifier,
          title: issue.title,
          runId: run.runId,
          status: run.status,
          adapterType: run.adapterType,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          timeoutFired: run.resultJson?.timeoutFired === true,
          effectiveTimeoutSec: run.resultJson?.effectiveTimeoutSec || null,
        });
      }
    }
  }

  const sourceCoverage = [
    `Fetched ${piAgents.length} PiTeam agent records from /companies/${options.companyId}/agents.`,
    `Fetched ${issues.length} company issues from /companies/${options.companyId}/issues?limit=1000.`,
    `Fetched run history for ${inspectionMap.size} recent or live issues via /issues/:issueId/runs.`,
    `Fetched comments for ${recentIssues.length} recent issues via /issues/:issueId/comments to check timeout audit visibility.`,
  ];
  const missingCoverage = [
    "No single company-wide runs endpoint was available, so historical run inspection is bounded to recent or live issues.",
    "No explicit API field records when an agent's red/error status was manually cleared, so stale-red enforcement remains advisory in this report.",
    "The report infers visible self-improvement coverage from thread comments and improver markers; it cannot prove an unposted local artifact existed.",
  ];

  const recommendations = [
    driftedAgents.length > 0
      ? `PiTeam route drift detected; reapply ${options.expected.template}, then cancel or reroute any affected queued/active work before the next heartbeat cycle.`
      : null,
    activeWrongRouteIssues.length > 0 || queuedWrongRouteIssues.length > 0
      ? "Wrong-route live work detected; surface it as one factory-health item and avoid clearing agent errors until the incident audit is visible on the affected issue."
      : null,
    nearTimeoutSelfImprovementRuns.length > 0
      ? "Self-improvement runs are nearing timeout; intervene before 600s so coverage becomes a visible no-op/process finding instead of a red-agent toast."
      : null,
    timeoutCoverageGaps.length > 0
      ? "Timed-out self-improvement runs are missing visible improver coverage; record an improvement_noop, improvement_not_applicable, or process finding before clearing stale red status."
      : null,
    erroredPiAgents.length > 0
      ? "Errored PiTeam agents still exist; do not clear them silently. Confirm the route fix, link the affected issue, and leave an audit comment first."
      : null,
  ].filter(Boolean);

  return {
    ok: driftedAgents.length === 0
      && activeWrongRouteIssues.length === 0
      && queuedWrongRouteIssues.length === 0
      && nearTimeoutSelfImprovementRuns.length === 0
      && timeoutCoverageGaps.length === 0
      && erroredPiAgents.length === 0,
    generatedAt: new Date(nowMs).toISOString(),
    companyId: options.companyId,
    days: options.days,
    expectedRoute: options.expected,
    sourceCoverage,
    missingCoverage,
    summary: {
      piAgentsChecked: piAgents.length,
      driftedAgents: driftedAgents.length,
      queuedWrongRouteIssues: queuedWrongRouteIssues.length,
      activeWrongRouteIssues: activeWrongRouteIssues.length,
      nearTimeoutSelfImprovementRuns: nearTimeoutSelfImprovementRuns.length,
      timeoutCoverageGaps: timeoutCoverageGaps.length,
      erroredPiAgents: erroredPiAgents.length,
    },
    recommendations,
    sample: {
      driftedAgents: driftedAgents.slice(0, 20),
      queuedWrongRouteIssues: queuedWrongRouteIssues.slice(0, 20),
      activeWrongRouteIssues: activeWrongRouteIssues.slice(0, 20),
      nearTimeoutSelfImprovementRuns: nearTimeoutSelfImprovementRuns.slice(0, 20),
      timeoutCoverageGaps: timeoutCoverageGaps.slice(0, 20),
      erroredPiAgents: erroredPiAgents.slice(0, 20),
    },
  };
}

function markdown(report) {
  return [
    "# PiTeam Route Drift Report",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Company: ${report.companyId}`,
    `- Window: ${report.days} day(s)`,
    `- PiTeam agents checked: ${report.summary.piAgentsChecked}`,
    `- Drifted agents: ${report.summary.driftedAgents}`,
    `- Queued wrong-route issues: ${report.summary.queuedWrongRouteIssues}`,
    `- Active wrong-route issues: ${report.summary.activeWrongRouteIssues}`,
    `- Near-timeout self-improvement runs: ${report.summary.nearTimeoutSelfImprovementRuns}`,
    `- Timeout coverage gaps: ${report.summary.timeoutCoverageGaps}`,
    `- Errored PiTeam agents: ${report.summary.erroredPiAgents}`,
    "",
    "## Recommendations",
    "",
    ...(report.recommendations.length
      ? report.recommendations.map((item) => `- ${item}`)
      : ["- No route drift or self-improvement coverage gap was detected in the sampled live state."]),
    "",
    "## Source Coverage",
    "",
    ...report.sourceCoverage.map((item) => `- ${item}`),
    "",
    "## Missing Coverage",
    "",
    ...report.missingCoverage.map((item) => `- ${item}`),
    "",
    "## Drifted Agents",
    "",
    ...(report.sample.driftedAgents.length
      ? report.sample.driftedAgents.map((agent) => `- ${agent.name}: ${agent.reasons.join("; ")}`)
      : ["- None found."]),
    "",
    "## Queued Wrong-Route Issues",
    "",
    ...(report.sample.queuedWrongRouteIssues.length
      ? report.sample.queuedWrongRouteIssues.map((issue) => `- ${issue.identifier}: ${issue.title} (${issue.status})`)
      : ["- None found."]),
    "",
    "## Active Wrong-Route Issues",
    "",
    ...(report.sample.activeWrongRouteIssues.length
      ? report.sample.activeWrongRouteIssues.map((issue) => `- ${issue.identifier} run ${issue.runId}: ${issue.reasons.join("; ")}`)
      : ["- None found."]),
    "",
    "## Near-Timeout Self-Improvement Runs",
    "",
    ...(report.sample.nearTimeoutSelfImprovementRuns.length
      ? report.sample.nearTimeoutSelfImprovementRuns.map((run) => `- ${run.identifier} run ${run.runId}: ${run.ageSec}s / ${run.timeoutSec}s`)
      : ["- None found."]),
    "",
    "## Timeout Coverage Gaps",
    "",
    ...(report.sample.timeoutCoverageGaps.length
      ? report.sample.timeoutCoverageGaps.map((run) => `- ${run.identifier} run ${run.runId}: no visible self-improvement audit after timeout`)
      : ["- None found."]),
    "",
    "## Errored PiTeam Agents",
    "",
    ...(report.sample.erroredPiAgents.length
      ? report.sample.erroredPiAgents.map((agent) => `- ${agent.name}: ${agent.status}`)
      : ["- None found."]),
    "",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const expected = {
    adapterType: args["expected-adapter"] || "codex_local",
    command: args["expected-command"] || "codex",
    model: args["expected-model"] || "gpt-5.4",
    template: args["expected-template"] || "all-codex",
    templateLlm: args["expected-template-llm"] || "codex",
  };
  const options = {
    apiBase: args["api-base"] || DEFAULT_API_BASE,
    companyId: args["company-id"] || DEFAULT_COMPANY_ID,
    days: Number.parseFloat(args.days || "7"),
    piLane: args["pi-lane"] || "dark-factory-pi-team",
    selfImprovementRole: args["self-improvement-role"] || "self-improvement-lead",
    timeoutBufferSec: Number.parseInt(args["timeout-buffer-sec"] || "120", 10),
    defaultTimeoutSec: Number.parseInt(args["default-timeout-sec"] || "600", 10),
    expected,
  };
  const report = await buildReport(options);
  const rendered = args.format === "markdown" ? markdown(report) : `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) {
    const outputPath = resolve(args.output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, rendered);
  }
  process.stdout.write(rendered);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
