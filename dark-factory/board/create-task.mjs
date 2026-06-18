#!/usr/bin/env node

import { appendLedgerEvent } from "./ledger-lib.mjs";

const DEFAULT_API = "http://127.0.0.1:3101/api";
const COMPANY_ID = "1e8bc12a-f8fd-431c-9fbd-e47be79446a3";
const PROJECT_ID = "c4525f28-55d1-4378-864c-aec26d51fc37";
const COORDINATOR_AGENT_ID = "ec2f4237-5d27-4675-a919-d4cbc45c55ca";
const DEFAULT_LABELS = [
  "stage: Planning",
  "gate: security-review-required",
  "gate: no-mistakes-required",
];

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

function isEnabled(value) {
  return value === "true" || value === "1" || value === "yes";
}

function hasDesignGate(args) {
  return Boolean(args.design?.trim() || args["design-reference"]?.trim() || isEnabled(args["design-verification"]));
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

function buildDescription(args) {
  const sections = [
    "# Original Brief",
    requireArg(args, "brief"),
  ];

  if (args.repo) {
    sections.push("## Target Repo / Area", args.repo);
  }

  if (args.acceptance) {
    sections.push("## Acceptance Criteria", args.acceptance);
  }

  if (args.evidence) {
    sections.push("## Required Evidence", args.evidence);
  }

  if (args.design || args["design-reference"]) {
    sections.push(
      "## Design Brief / Reference",
      [
        args.design?.trim() || null,
        args["design-reference"] ? `Reference: ${args["design-reference"]}` : null,
      ].filter(Boolean).join("\n\n"),
    );
  }

  if (isEnabled(args["research-architecture"]) || isEnabled(args["plan-approval"])) {
    sections.push(
      "## Plan Approval Gate",
      [
        "Research / Architecture may do the thinking first, but the full plan must be visible on this ticket before implementation starts.",
        "",
        "Required plan contents:",
        "- recommended approach",
        "- alternatives considered",
        "- key assumptions",
        "- affected repos/areas",
        "- risks and mitigations",
        "- testing/evidence plan",
        "- security and data/privacy considerations",
        "- rollout/PR plan",
        "",
        "Do not move this ticket from Planning to To Do until Samuel has approved the plan in a comment or explicit instruction.",
      ].join("\n"),
    );
  }

  sections.push(
    "## Board Instructions",
    [
      "- Paperclip is the communication board and history surface only.",
      "- Keep Pi/Dark Factory execution unchanged.",
      "- Use `node tools/paperclip-board/factory-log.mjs` to append every observable event, handoff, decision, artifact, approval, blocker, and gate result to the task ledger.",
      "- Move native status and stage labels as gates complete.",
      "- Leave comments for planning, implementation, verification, No Mistakes, PR URL, human final review, blockers, and final disposition.",
      "- PR-backed coding tickets are fail-closed: Planning lead intake, Implementation lead handoff, Verification lead gate, conditional Browser / Visual QA lead gate, Security lead gate, and No Mistakes / Foreman gate must be recorded before Ship to PR.",
      "- If a required lead/lane verdict, evidence artifact, or Samuel waiver is missing, keep the ticket blocked or in review instead of creating/reporting a PR.",
      "- Record ticket loops before implementation when applicable: trigger, owner, memory source, judge/oracle, max iterations, exit condition, escalation path, and visible output.",
      "- Use condition-triggered loops for intake clarification, adversarial plan review, implementation fix-test, Browser/Webwright user-flow QA, review/security/No Mistakes repair, PR review watching, post-merge telemetry, regression scenario memory, and factory meta-improvement.",
      "- Loops must be bounded. Exhausted loops become visible blockers and improvement findings, not silent retries.",
      "- Planning must name the allowed write scope before implementation starts. Developing, fixing, reviewing, and verifying agents may only edit files/areas explicitly authorized by this task or the approved plan.",
      "- If an agent finds unrelated bugs, cleanup, refactors, copy improvements, architecture ideas, or review findings, report them as a separate ticket recommendation instead of changing them in this task.",
      "- Security and self-improvement agents may inspect broadly within their role, but broad inspection does not authorize remediation or live policy/skill/prompt/product changes without Samuel or an approved follow-up task.",
      "- For Research / Architecture tasks, post the full plan on the ticket while it is still in Planning and get Samuel's approval before moving to To Do.",
      "- No Mistakes must pass before any GitHub push/PR unless Samuel explicitly waives it.",
      "- After No Mistakes, move to Ship to PR; after PR creation, move to Human Final Review, not Done.",
      "- Security Review is a standard visible gate for coding work in this pilot; for pure non-code/admin tickets, comment why it is not applicable.",
      "- Browser / Visual QA is required when UI, browser, visual, responsive, or user-facing flow validation is involved.",
      "- Browser / Visual QA is fail-closed for UI/browser/authenticated-flow work: the QA lead must open Chrome/Webwright, log in where required, test the exact changed workflow, record a Browser QA report plus screenshot artifacts, and post those evidence paths on this ticket.",
      "- Unit tests, component tests, code inspection, or local harnesses may support Browser QA but cannot replace login-backed screenshot evidence for app workflows.",
      "- If browser/login/environment evidence is blocked, keep this ticket blocked or in review with the exact owner/action; do not advance to No Mistakes, Ship to PR, Human Final Review, Done, or merge unless Samuel explicitly waives Browser QA evidence.",
      "- If a design brief/reference is supplied, Browser / Visual QA must compare the rendered result against that design source, attach screenshot/video or visual-diff evidence, and log the finding in the factory run ledger.",
      "- After each team-worked ticket, create an Improvement Reports ticket that reviews the whole factory run: brief, planning/research, conversations, reasoning/handoffs, work done, evidence, verification, security, browser QA, No Mistakes, PR/human feedback, issues, suggested improvements, approval needed, and applied outcome.",
      "- The improvement report must list source log coverage. Missing conversations, handoffs, tool outputs, evidence, or review logs are themselves improvement findings.",
    ].join("\n"),
  );

  return sections.join("\n\n");
}

function labelNames(args) {
  const names = [...DEFAULT_LABELS];
  if (isEnabled(args["research-architecture"])) {
    names.push("lane: Research / Architecture");
  }
  if (isEnabled(args["research-architecture"]) || isEnabled(args["plan-approval"])) {
    names.push("gate: plan-approval-required");
  }
  if (hasDesignGate(args)) {
    names.push("gate: design-verification-required");
    names.push("evidence: design-reference");
    names.push("evidence: screenshots");
  }
  return names;
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

  const payload = {
    title: requireArg(args, "title"),
    description: buildDescription(args),
    status: args.status || "todo",
    priority: args.priority || "medium",
    projectId: PROJECT_ID,
    assigneeAgentId: COORDINATOR_AGENT_ID,
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

  const url = `http://127.0.0.1:3101/OPE/issues/${issue.identifier}`;
  const ledger = appendLedgerEvent({
    issue: issue.identifier,
    issueId: issue.id,
    issueUrl: url,
    title: issue.title,
    eventType: "task_created",
    stage: "Planning",
    actor: "OpenClaw Coordinator",
    actorRole: "coordinator",
    summary: `Task created on Paperclip: ${issue.title}`,
    details: {
      brief: requireArg(args, "brief"),
      repo: args.repo || null,
      acceptance: args.acceptance || null,
      evidence: args.evidence || null,
      design: args.design || null,
      designReference: args["design-reference"] || null,
      labels: labelNames(args),
      status: issue.status,
      instructions: "Append every observable factory event, handoff, decision, artifact, approval, blocker, and gate result to this ledger.",
    },
    sourceRefs: [{ kind: "paperclip_issue", id: issue.id, identifier: issue.identifier, url }],
    visibility: "improver",
  });
  console.log(JSON.stringify({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    url,
    ledgerDir: ledger.dir,
    ledgerEventHash: ledger.event.hash,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
