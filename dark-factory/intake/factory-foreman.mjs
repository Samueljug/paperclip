#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendLedgerEvent } from "<FORK>/dark-factory/board/ledger-lib.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.FACTORY_INTAKE_CONFIG || path.join(SCRIPT_DIR, "config.local.json");
const SOURCE_LABEL = "source: telegram-dev-intake";
const SOURCE_MARKER = "[factory-intake:v1]";
const CLICKUP_SOURCE_LABEL = "source: clickup";
const CLICKUP_SOURCE_MARKER = "[clickup-sync:v1]";
const DEFAULT_HANDOFF_TARGETS = [
  "pi-orchestrator",
  "planning-lead",
  "implementation-lead",
  "research-lead",
  "verification-lead",
  "browser-qa-lead",
  "security-lead",
  "self-improvement-lead",
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

function enabled(value) {
  return value === "true" || value === "1" || value === "yes";
}

function loadConfig() {
  const fileConfig = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
    : {};
  const config = {
    paperclipApi: process.env.PAPERCLIP_API_BASE || fileConfig.paperclipApi,
    companyId: process.env.PAPERCLIP_COMPANY_ID || fileConfig.companyId,
    projectId: process.env.PAPERCLIP_PROJECT_ID || fileConfig.projectId,
    coordinatorAgentId: process.env.PAPERCLIP_COORDINATOR_AGENT_ID || fileConfig.coordinatorAgentId,
    boardUrl: process.env.PAPERCLIP_BOARD_URL || fileConfig.boardUrl || "http://127.0.0.1:3101",
    comsUrl: process.env.PI_COMS_NET_SERVER_URL || fileConfig.comsUrl,
    comsProject: process.env.PI_COMS_NET_PROJECT || fileConfig.comsProject,
    comsToken: process.env.PI_COMS_NET_AUTH_TOKEN || fileConfig.comsToken,
    stateDir: process.env.FACTORY_INTAKE_STATE_DIR || fileConfig.stateDir || path.join(SCRIPT_DIR, "state"),
    maxRetries: Number(process.env.FACTORY_INTAKE_MAX_RETRIES || fileConfig.maxRetries || 3),
    lockTtlMs: Number(process.env.FACTORY_INTAKE_LOCK_TTL_MS || fileConfig.lockTtlMs || 180000),
    targetInboxSoftLimit: Number(process.env.FACTORY_INTAKE_TARGET_INBOX_SOFT_LIMIT || fileConfig.targetInboxSoftLimit || 80),
    backpressureCommentCooldownMs: Number(process.env.FACTORY_INTAKE_BACKPRESSURE_COMMENT_COOLDOWN_MS || fileConfig.backpressureCommentCooldownMs || 1800000),
    handoffTargets: Array.isArray(fileConfig.handoffTargets) && fileConfig.handoffTargets.length > 0
      ? fileConfig.handoffTargets
      : DEFAULT_HANDOFF_TARGETS,
  };

  for (const key of ["paperclipApi", "companyId", "projectId", "coordinatorAgentId", "comsUrl", "comsProject", "comsToken"]) {
    if (!config[key]) {
      throw new Error(`Missing factory foreman config: ${key}. Add ${CONFIG_PATH} or set env vars.`);
    }
  }
  fs.mkdirSync(config.stateDir, { recursive: true });
  return config;
}

async function request(base, pathName, options = {}) {
  const res = await fetch(`${base}${pathName}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(`${options.method || "GET"} ${pathName} -> ${res.status}: ${text}`);
    err.status = res.status;
    err.body = body;
    err.errorCode = body?.error;
    err.details = body?.details;
    throw err;
  }
  return body;
}

async function comsRequest(config, pathName, options = {}) {
  return request(config.comsUrl, pathName, {
    ...options,
    headers: {
      authorization: `Bearer ${config.comsToken}`,
      ...(options.headers || {}),
    },
  });
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function acquireLock(config) {
  const lockPath = path.join(config.stateDir, "foreman.lock");
  const now = Date.now();
  if (fs.existsSync(lockPath)) {
    const current = readJson(lockPath, {});
    if (current.createdAtMs && now - current.createdAtMs < config.lockTtlMs) {
      return null;
    }
    fs.rmSync(lockPath, { force: true });
  }
  try {
    const fd = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAtMs: now }));
    fs.closeSync(fd);
    return lockPath;
  } catch (err) {
    if (err?.code === "EEXIST") return null;
    throw err;
  }
}

function releaseLock(lockPath) {
  if (lockPath) fs.rmSync(lockPath, { force: true });
}

function stateFile(config) {
  return path.join(config.stateDir, "handoffs.json");
}

function loadState(config) {
  return readJson(stateFile(config), { issues: {} });
}

function saveState(config, state) {
  writeJson(stateFile(config), state);
}

async function labelByName(config, name) {
  const labels = await request(config.paperclipApi, `/companies/${config.companyId}/labels`);
  return labels.find((item) => item.name === name) || null;
}

async function listTodoIssues(config) {
  const params = new URLSearchParams({
    projectId: config.projectId,
    status: "todo",
  });
  return request(config.paperclipApi, `/companies/${config.companyId}/issues?${params.toString()}`);
}

function isTelegramIntakeIssue(issue) {
  if (String(issue.description || "").includes(SOURCE_MARKER)) return true;
  return (issue.labels || []).some((label) => label.name === SOURCE_LABEL);
}

function isClickUpIssue(issue) {
  if (String(issue.description || "").includes(CLICKUP_SOURCE_MARKER)) return true;
  return (issue.labels || []).some((label) => label.name === CLICKUP_SOURCE_LABEL);
}

function issueSourceName(issue) {
  if (isClickUpIssue(issue)) return "ClickUp sync";
  return isTelegramIntakeIssue(issue) ? "Telegram factory intake" : "Paperclip Todo";
}

function isCodexOnlyIssue(issue) {
  const text = [
    issue.title,
    issue.description,
    ...(issue.labels || []).map((label) => label.name),
  ].map((item) => String(item || "").toLowerCase()).join("\n");
  return /\bcodex[- ]only\b/.test(text) || /\bno claude\b/.test(text) || /\bdo not use claude\b/.test(text);
}

function issueSearchText(issue) {
  return [
    issue.title,
    issue.description,
    ...(issue.labels || []).map((label) => label.name),
  ].map((item) => String(item || "").toLowerCase()).join("\n");
}

function preferredHandoffTargets(issue) {
  const text = issueSearchText(issue);
  const title = String(issue.title || "").toLowerCase();
  const preferred = [];

  if (/\breview productivity\b|\bself[- ]improvement\b|\bimprover\b|\bimprovement review\b|\bimprovement noop\b/.test(text)) {
    preferred.push("self-improvement-lead");
  }
  if (/\bsec\b|\bsecurity\b|\bidor\b|\bauthz\b|\bauthorization\b|\bunauthenticated\b|\bwebhook\b|\btenant\b|\bcross-tenant\b|\bssrf\b|\binjection\b|\bsecret\b|\bsupply[- ]chain\b/.test(text)) {
    preferred.push("security-lead");
  }
  if (/\bfrontend\b|\bfe\b|\bui\b|\bbrowser\b|\bvisual\b|\bcheckout\b|\bfree-trial\b|\blanding\b|\blayout\b|\bnuxt\b|\bvue\b|\b404\b/.test(text)) {
    preferred.push("browser-qa-lead", "implementation-lead");
  }
  if (/\bbackend\b|\bbve\b|\bapi\b|\bendpoint\b|\broute\b|\bdatabase\b|\bmongo\b|\bbilling\b|\bsubscription\b|\bstripe\b/.test(text)) {
    preferred.push("implementation-lead", "verification-lead");
  }
  if (/\bplanning\b|\bplan\b|\baudit\b|\breport\b|\bremediation\b|\bimplementation brief\b|\bdecompose\b/.test(text)) {
    preferred.push("planning-lead");
  }
  if (title.startsWith("review productivity for ")) {
    preferred.push("self-improvement-lead");
  }

  preferred.push("pi-orchestrator", "planning-lead", "implementation-lead", "verification-lead", "security-lead", "self-improvement-lead");
  return [...new Set(preferred)];
}

function readyFingerprint(issue) {
  return `todo:${issue.updatedAt || issue.id}`;
}

function alreadyHandedOffForCurrentTodoState(state, issue) {
  const entry = state.issues[issue.id];
  return ["handed_off", "active_execution"].includes(entry?.status) && entry.readyFingerprint === readyFingerprint(issue);
}

function replaceStageLabel(issue, nextStageLabelId) {
  const existing = Array.isArray(issue.labelIds) ? issue.labelIds : [];
  const withoutStage = existing.filter((id) => {
    const label = (issue.labels || []).find((item) => item.id === id);
    return !label || !String(label.name).startsWith("stage: ");
  });
  return [...new Set([...withoutStage, nextStageLabelId])];
}

async function patchIssue(config, issueId, body) {
  return request(config.paperclipApi, `/issues/${issueId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

async function checkoutIssue(config, issue) {
  return request(config.paperclipApi, `/issues/${issue.id}/checkout`, {
    method: "POST",
    body: JSON.stringify({
      agentId: config.coordinatorAgentId,
      expectedStatuses: ["todo"],
    }),
  });
}

async function releaseIssue(config, issueId) {
  try {
    await request(config.paperclipApi, `/issues/${issueId}/release`, { method: "POST" });
  } catch {
    // The retry/status patch below is more important than release success.
  }
}

function buildHandoffPrompt(config, issue, targetName = "pi-orchestrator", routingReason = null) {
  const sourceName = issueSourceName(issue);
  const reviewRule = isCodexOnlyIssue(issue)
    ? "- This ticket is explicitly Codex-only / no-Claude. Do not invoke Claude; use Codex-only planning, implementation, review, verification, and reconciliation."
    : "- If this is a substantial implementation, architecture, repository, privacy/security, customer-support, automation, or data-handling plan, require Codex and Claude review/reconciliation before the plan is presented as ready.";
  const isPrimaryOrchestrator = targetName === "pi-orchestrator";
  const roleLine = isPrimaryOrchestrator
    ? "You are the Pi-side orchestrator. Review this ticket, claim it as a separate factory cell, and assign the appropriate team leads/workers."
    : `You are ${targetName}. This is a direct lane handoff from the foreman because the normal orchestrator lane is saturated or this ticket maps strongly to your lane. Claim it as a separate factory cell, start the lane-owned triage/work you can own, coordinate with peer leads as needed, and keep Paperclip as the source of truth.`;
  const routingLine = routingReason
    ? [`Routing reason: ${routingReason}`, ""]
    : [];
  const ownershipRule = isPrimaryOrchestrator
    ? "- The foreman only hands work to you. You own routing to planning, implementation, research, verification, browser QA, security, and self-improvement leads."
    : "- The foreman may hand work directly to a lane lead when orchestrator backpressure is active. You own your lane's next action and should coordinate with peer leads directly instead of waiting for pi-orchestrator to drain.";
  return [
    `New Paperclip Todo-ready Dark Factory ticket: ${issue.identifier} - ${issue.title}`,
    "",
    `Paperclip URL: ${config.boardUrl}/OPE/issues/${issue.identifier}`,
    `Source: ${sourceName}`,
    ...routingLine,
    "",
    roleLine,
    "",
    "Rules:",
    "- Treat the Paperclip issue as the source of truth and keep it updated with comments, status, evidence, blockers, and final disposition.",
    ownershipRule,
    "- Every Dark Factory run must include a self-improvement/improver review before Ship to PR, Done, closed, or final disposition; if no reusable lesson exists, post a visible no-op review with run/ledger evidence.",
    "- Check active work at least every hour until it is complete, cancelled, superseded, or blocked by a concrete Samuel decision/action.",
    "- Use a separate factory cell identity for this issue. Do not share dirty clones, branches, run folders, or evidence across tickets.",
    reviewRule,
    "- If Samuel approval, a scope call, identity/security tradeoff, PR/push choice, credential, or other owner action is required, keep the ticket in Planning/blocked state, ask for it clearly on the board, and notify Samuel visibly in Telegram.",
    "- Do not send external emails/messages, push public changes, purchase services, or perform destructive operations without explicit approval.",
    "- Do not mark the task ready/done merely because this handoff was received.",
    "",
    "Issue brief:",
    issue.description || "(No description available.)",
  ].join("\n");
}

async function registerForeman(config) {
  const sessionId = `paperclip-todo-foreman-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await comsRequest(config, "/v1/agents/register", {
    method: "POST",
    body: JSON.stringify({
      project: config.comsProject,
      session_id: sessionId,
      name: "paperclip-todo-foreman",
      purpose: "Claims Todo-ready Paperclip tasks and hands them to pi-orchestrator",
      model: "automation",
      color: "#0d9488",
      cwd: SCRIPT_DIR,
      explicit: true,
    }),
  });
  return sessionId;
}

async function deleteForeman(config, sessionId) {
  try {
    await comsRequest(config, `/v1/agents/${encodeURIComponent(sessionId)}?project=${encodeURIComponent(config.comsProject)}`, {
      method: "DELETE",
    });
  } catch {
    // Best effort cleanup. The hub will also expire stale explicit senders.
  }
}

async function heartbeatForeman(config, sessionId) {
  await comsRequest(config, `/v1/agents/${encodeURIComponent(sessionId)}/heartbeat`, {
    method: "POST",
    body: JSON.stringify({
      project: config.comsProject,
      context_used_pct: 0,
      queue_depth: 0,
      status: "online",
    }),
  });
}

async function resolveOrchestrator(config) {
  const agents = await comsRequest(config, `/v1/agents?project=${encodeURIComponent(config.comsProject)}`);
  const matches = agents.agents.filter((agent) => agent.name === "pi-orchestrator" && agent.status === "online");
  if (matches.length === 0) throw new Error("pi-orchestrator is not online in coms-net");
  if (matches.length > 1) throw new Error(`pi-orchestrator target is ambiguous: ${matches.length} online matches`);
  return matches[0];
}

async function resolveHandoffTargets(config) {
  const agents = await comsRequest(config, `/v1/agents?project=${encodeURIComponent(config.comsProject)}`);
  const targetNames = new Set(config.handoffTargets || DEFAULT_HANDOFF_TARGETS);
  const byName = new Map();
  const ambiguous = new Map();
  for (const agent of agents.agents || []) {
    if (!targetNames.has(agent.name) || agent.status !== "online") continue;
    if (byName.has(agent.name)) {
      ambiguous.set(agent.name, [byName.get(agent.name), agent]);
      byName.delete(agent.name);
    } else if (!ambiguous.has(agent.name)) {
      byName.set(agent.name, agent);
    }
  }
  return { byName, ambiguous, agents: agents.agents || [] };
}

function targetInboxDepth(target) {
  return typeof target?.queue_depth === "number" ? target.queue_depth : 0;
}

function targetInboxHasCapacity(config, target, requestedSlots = 1) {
  const depth = targetInboxDepth(target);
  return depth + requestedSlots <= config.targetInboxSoftLimit;
}

function chooseHandoffTarget(config, issue, targetsByName, plannedSlots = {}) {
  for (const name of preferredHandoffTargets(issue)) {
    const target = targetsByName.get(name);
    if (!target) continue;
    const requestedSlots = (plannedSlots[target.session_id] || 0) + 1;
    if (targetInboxHasCapacity(config, target, requestedSlots)) {
      return {
        target,
        routingReason: name === "pi-orchestrator"
          ? "primary orchestrator lane has capacity"
          : `lane-aware route selected ${name}; pi-orchestrator can be bypassed while saturated`,
      };
    }
  }
  return null;
}

function isInboxFullError(err) {
  if (!err || typeof err !== "object") return false;
  const message = err instanceof Error ? err.message : String(err);
  return err.status === 429 && (
    err.errorCode === "inbox_full" ||
    err.body?.error === "inbox_full" ||
    /\binbox_full\b/.test(message)
  );
}

function activeWorkConflict(err) {
  if (!err || typeof err !== "object" || err.status !== 409) return null;
  const runId = err.details?.executionRunId || err.body?.details?.executionRunId;
  if (typeof runId === "string" && runId.length > 0) {
    return { kind: "execution", id: runId };
  }
  const checkoutRunId = err.details?.checkoutRunId || err.body?.details?.checkoutRunId;
  if (typeof checkoutRunId === "string" && checkoutRunId.length > 0) {
    return { kind: "checkout", id: checkoutRunId };
  }
  return null;
}

function activeExecutionConflictId(err) {
  const conflict = activeWorkConflict(err);
  return conflict?.kind === "execution" ? conflict.id : null;
}

async function sendToTarget(config, senderSession, issue, target, routingReason = null) {
  return comsRequest(config, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      project: config.comsProject,
      sender_session: senderSession,
      target: target.name,
      target_session: target.session_id,
      prompt: buildHandoffPrompt(config, issue, target.name, routingReason),
      conversation_id: `paperclip:${issue.identifier}`,
      response_schema: null,
      hops: 0,
    }),
  });
}

async function sendToOrchestrator(config, senderSession, issue, target = null) {
  const resolvedTarget = target || await resolveOrchestrator(config);
  return sendToTarget(config, senderSession, issue, resolvedTarget, "primary orchestrator lane has capacity");
}

function logLedger(config, issue, eventType, summary, details = {}) {
  return appendLedgerEvent({
    issue: issue.identifier,
    issueId: issue.id,
    issueUrl: `${config.boardUrl}/OPE/issues/${issue.identifier}`,
    title: issue.title,
    eventType,
    stage: issue.status,
    actor: "Paperclip Todo Foreman",
    actorRole: "foreman",
    summary,
    details,
    sourceRefs: [{ kind: "paperclip_issue", id: issue.id, identifier: issue.identifier, url: `${config.boardUrl}/OPE/issues/${issue.identifier}` }],
    visibility: "improver",
  });
}

async function markRetry(config, issue, todoStageLabelId, state, err) {
  const entry = state.issues[issue.id] || {};
  entry.status = "handoff_retry";
  entry.readyFingerprint = readyFingerprint(issue);
  entry.source = issueSourceName(issue);
  entry.attempts = (entry.attempts || 0) + 1;
  entry.lastError = err instanceof Error ? err.message : String(err);
  entry.updatedAt = new Date().toISOString();
  state.issues[issue.id] = entry;
  saveState(config, state);

  await releaseIssue(config, issue.id);
  if (entry.attempts >= config.maxRetries) {
    await patchIssue(config, issue.id, {
      status: "blocked",
      comment: `Factory foreman could not hand this to pi-orchestrator after ${entry.attempts} attempts. Last error: ${entry.lastError}`,
    });
  } else {
    await patchIssue(config, issue.id, {
      status: "todo",
      labelIds: replaceStageLabel(issue, todoStageLabelId),
      comment: `Factory foreman handoff attempt ${entry.attempts}/${config.maxRetries} failed and will retry. Last error: ${entry.lastError}`,
    });
  }
}

async function markBackpressure(config, issue, todoStageLabelId, state, err) {
  const entry = state.issues[issue.id] || {};
  const now = Date.now();
  const lastCommentedAt = entry.lastBackpressureCommentAt ? Date.parse(entry.lastBackpressureCommentAt) : 0;
  const shouldComment = !Number.isFinite(lastCommentedAt) || now - lastCommentedAt >= config.backpressureCommentCooldownMs;

  entry.status = "handoff_backpressure";
  entry.readyFingerprint = readyFingerprint(issue);
  entry.source = issueSourceName(issue);
  entry.lastError = err instanceof Error ? err.message : String(err);
  entry.lastBackpressureAt = new Date(now).toISOString();
  if (shouldComment) entry.lastBackpressureCommentAt = entry.lastBackpressureAt;
  state.issues[issue.id] = entry;
  saveState(config, state);

  await releaseIssue(config, issue.id);
  const patch = {
    status: "todo",
    labelIds: replaceStageLabel(issue, todoStageLabelId),
  };
  if (shouldComment) {
    patch.comment = `Factory foreman deferred this handoff because pi-orchestrator inbox backpressure is active. This is transient and does not count as a failed work attempt. Last error: ${entry.lastError}`;
  }
  await patchIssue(config, issue.id, patch);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const max = Number(args.max || 5);
  const lockPath = acquireLock(config);
  if (!lockPath) {
    console.log(JSON.stringify({ claimed: 0, skipped: true, message: "Foreman already running." }, null, 2));
    return;
  }

  try {
    const inProgressLabel = await labelByName(config, "stage: In Progress");
    if (!inProgressLabel) throw new Error("Missing board label: stage: In Progress");
    const todoLabel = await labelByName(config, "stage: To Do");
    if (!todoLabel) throw new Error("Missing board label: stage: To Do");

    const state = loadState(config);
    const targets = await resolveHandoffTargets(config);
    const plannedSlots = {};
    const probeIssue = { title: "capacity probe", description: "", labels: [] };
    const probeRoute = chooseHandoffTarget(config, probeIssue, targets.byName, plannedSlots);
    if (!probeRoute) {
      const targetDepths = [...targets.byName.values()].map((target) => ({
        name: target.name,
        session: target.session_id,
        queueDepth: targetInboxDepth(target),
        softLimit: config.targetInboxSoftLimit,
      }));
      if (!enabled(args["dry-run"])) {
        state.backpressure = {
          status: "active",
          target: "all-handoff-lanes",
          targetDepths,
          softLimit: config.targetInboxSoftLimit,
          updatedAt: new Date().toISOString(),
        };
        saveState(config, state);
      }
      console.log(JSON.stringify({
        claimed: 0,
        backpressure: true,
        target: "all-handoff-lanes",
        targetDepths,
        softLimit: config.targetInboxSoftLimit,
        message: "No online Dark Factory handoff lane has capacity; no Todo cards were claimed.",
      }, null, 2));
      return;
    }
    const issues = (await listTodoIssues(config))
      .filter((issue) => !alreadyHandedOffForCurrentTodoState(state, issue))
      .slice(0, max);

    if (issues.length === 0) {
      console.log(JSON.stringify({ claimed: 0, message: "No unclaimed Todo-ready tasks." }, null, 2));
      return;
    }

    const results = [];
    let senderSession = null;
    try {
      senderSession = await registerForeman(config);
      await heartbeatForeman(config, senderSession);
      for (const issue of issues) {
        const issueReadyFingerprint = readyFingerprint(issue);
        const issueSource = issueSourceName(issue);
        const route = chooseHandoffTarget(config, issue, targets.byName, plannedSlots);
        if (!route) {
          results.push({
            identifier: issue.identifier,
            issueId: issue.id,
            source: issueSource,
            skipped: true,
            backpressure: true,
            error: "No handoff lane currently has inbox capacity.",
          });
          continue;
        }
        const { target, routingReason } = route;
        plannedSlots[target.session_id] = (plannedSlots[target.session_id] || 0) + 1;
        if (enabled(args["dry-run"])) {
          results.push({ identifier: issue.identifier, source: issueSource, dryRun: true, target: target.name, targetSession: target.session_id });
          continue;
        }

        let checkedOut = issue;
        try {
          checkedOut = await checkoutIssue(config, issue);
          state.issues[issue.id] = {
            ...(state.issues[issue.id] || {}),
            status: "claimed",
            readyFingerprint: issueReadyFingerprint,
            source: issueSource,
            attempts: state.issues[issue.id]?.attempts || 0,
            claimedAt: new Date().toISOString(),
          };
          saveState(config, state);

          await patchIssue(config, checkedOut.id, {
            labelIds: replaceStageLabel(checkedOut, inProgressLabel.id),
            comment: `Factory foreman atomically claimed ${issue.identifier} from Todo and is handing it to ${target.name} for lane-aware review and team routing.`,
          });
          logLedger(config, checkedOut, "paperclip_todo_claimed", `Foreman claimed ${issue.identifier} from Todo`, {
            source: issueSource,
            target: target.name,
          });

          await heartbeatForeman(config, senderSession);
          const handoff = await sendToTarget(config, senderSession, checkedOut, target, routingReason);
          state.issues[issue.id] = {
            ...(state.issues[issue.id] || {}),
            status: "handed_off",
            readyFingerprint: issueReadyFingerprint,
            source: issueSource,
            target: target.name,
            targetSession: target.session_id,
            handoffMessageId: handoff.msg_id,
            handoffStatus: handoff.status,
            handedOffAt: new Date().toISOString(),
          };
          saveState(config, state);

          await patchIssue(config, checkedOut.id, {
            comment: `Handoff sent to ${target.name} over coms-net. message_id=${handoff.msg_id} status=${handoff.status}`,
          });
          logLedger(config, checkedOut, "paperclip_todo_handoff_sent", `Handoff sent to ${target.name} for ${issue.identifier}`, {
            msgId: handoff.msg_id,
            status: handoff.status,
            source: issueSource,
            target: target.name,
          });
          results.push({
            identifier: issue.identifier,
            issueId: issue.id,
            source: issueSource,
            target: target.name,
            targetSession: target.session_id,
            handoffMessageId: handoff.msg_id,
            handoffStatus: handoff.status,
          });
        } catch (err) {
          if (err?.status === 409) {
            const activeConflict = activeWorkConflict(err);
            if (activeConflict) {
              state.issues[issue.id] = {
                ...(state.issues[issue.id] || {}),
                status: "active_execution",
                readyFingerprint: issueReadyFingerprint,
                source: issueSource,
                activeWorkKind: activeConflict.kind,
                activeWorkId: activeConflict.id,
                updatedAt: new Date().toISOString(),
              };
              saveState(config, state);
              results.push({
                identifier: issue.identifier,
                skipped: true,
                activeExecution: activeConflict.kind === "execution",
                activeCheckout: activeConflict.kind === "checkout",
                activeWorkId: activeConflict.id,
              });
            } else {
              results.push({ identifier: issue.identifier, skipped: true, error: err.message });
            }
            continue;
          }
          if (isInboxFullError(err)) {
            await markBackpressure(config, checkedOut, todoLabel.id, state, err);
          } else {
            await markRetry(config, checkedOut, todoLabel.id, state, err);
          }
          results.push({
            identifier: issue.identifier,
            issueId: issue.id,
            source: issueSource,
            target: target.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      if (senderSession) await deleteForeman(config, senderSession);
    }

    console.log(JSON.stringify({ claimed: results.length, results }, null, 2));
  } finally {
    releaseLock(lockPath);
  }
}

export {
  alreadyHandedOffForCurrentTodoState,
  buildHandoffPrompt,
  chooseHandoffTarget,
  activeWorkConflict,
  activeExecutionConflictId,
  isCodexOnlyIssue,
  isInboxFullError,
  isTelegramIntakeIssue,
  issueSourceName,
  preferredHandoffTargets,
  readyFingerprint,
  targetInboxHasCapacity,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
