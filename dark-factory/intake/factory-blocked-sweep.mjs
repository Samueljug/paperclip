#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  preferredHandoffTargets,
  targetInboxHasCapacity,
} from "./factory-foreman.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.FACTORY_INTAKE_CONFIG || path.join(SCRIPT_DIR, "config.local.json");
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
    lockTtlMs: Number(process.env.FACTORY_INTAKE_LOCK_TTL_MS || fileConfig.lockTtlMs || 180000),
    targetInboxSoftLimit: Number(process.env.FACTORY_INTAKE_TARGET_INBOX_SOFT_LIMIT || fileConfig.targetInboxSoftLimit || 80),
    blockedSweepCooldownMs: Number(process.env.FACTORY_BLOCKED_SWEEP_COOLDOWN_MS || fileConfig.blockedSweepCooldownMs || 1800000),
    handoffTargets: Array.isArray(fileConfig.handoffTargets) && fileConfig.handoffTargets.length > 0
      ? fileConfig.handoffTargets
      : DEFAULT_HANDOFF_TARGETS,
  };

  for (const key of ["paperclipApi", "companyId", "projectId", "comsUrl", "comsProject", "comsToken"]) {
    if (!config[key]) {
      throw new Error(`Missing factory blocked-sweep config: ${key}. Add ${CONFIG_PATH} or set env vars.`);
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
  const lockPath = path.join(config.stateDir, "blocked-sweep.lock");
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
  return path.join(config.stateDir, "blocked-sweep.json");
}

function loadState(config) {
  return readJson(stateFile(config), { issues: {} });
}

function saveState(config, state) {
  writeJson(stateFile(config), state);
}

async function listBlockedIssues(config) {
  const params = new URLSearchParams({
    projectId: config.projectId,
    status: "blocked",
  });
  return request(config.paperclipApi, `/companies/${config.companyId}/issues?${params.toString()}`);
}

async function patchIssue(config, issueId, body) {
  return request(config.paperclipApi, `/issues/${issueId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

function isProductivityReviewIssue(issue) {
  return issue.originKind === "issue_productivity_review" ||
    String(issue.title || "").toLowerCase().startsWith("review productivity for ");
}

async function registerSweeper(config) {
  const sessionId = `paperclip-blocked-sweep-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await comsRequest(config, "/v1/agents/register", {
    method: "POST",
    body: JSON.stringify({
      project: config.comsProject,
      session_id: sessionId,
      name: "paperclip-blocked-sweep",
      purpose: "Triages blocked Paperclip tasks and routes unblock actions",
      model: "automation",
      color: "#f97316",
      cwd: SCRIPT_DIR,
      explicit: true,
    }),
  });
  return sessionId;
}

async function deleteSweeper(config, sessionId) {
  try {
    await comsRequest(config, `/v1/agents/${encodeURIComponent(sessionId)}?project=${encodeURIComponent(config.comsProject)}`, {
      method: "DELETE",
    });
  } catch {
    // Best effort cleanup.
  }
}

async function heartbeatSweeper(config, sessionId) {
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

async function resolveHandoffTargets(config) {
  const agents = await comsRequest(config, `/v1/agents?project=${encodeURIComponent(config.comsProject)}`);
  const targetNames = new Set(config.handoffTargets || DEFAULT_HANDOFF_TARGETS);
  const byName = new Map();
  for (const agent of agents.agents || []) {
    if (!targetNames.has(agent.name) || agent.status !== "online") continue;
    if (!byName.has(agent.name)) byName.set(agent.name, agent);
  }
  return byName;
}

function chooseHandoffTarget(config, issue, targetsByName, plannedSlots = {}) {
  for (const name of preferredHandoffTargets(issue)) {
    const target = targetsByName.get(name);
    if (!target) continue;
    const requestedSlots = (plannedSlots[target.session_id] || 0) + 1;
    if (targetInboxHasCapacity(config, target, requestedSlots)) return target;
  }
  return null;
}

function readyFingerprint(issue) {
  return `blocked:${issue.id}`;
}

function recentlySwept(config, state, issue, now = Date.now()) {
  const entry = state.issues[issue.id];
  if (!entry || entry.readyFingerprint !== readyFingerprint(issue)) return false;
  const last = entry.lastSweepAt ? Date.parse(entry.lastSweepAt) : 0;
  return Number.isFinite(last) && now - last < config.blockedSweepCooldownMs;
}

function buildBlockedPrompt(config, issue, targetName, action) {
  const productivity = isProductivityReviewIssue(issue);
  return [
    `Blocked Paperclip Dark Factory ticket needs unblock triage: ${issue.identifier} - ${issue.title}`,
    "",
    `Paperclip URL: ${config.boardUrl}/OPE/issues/${issue.identifier}`,
    `Routed lane: ${targetName}`,
    `Sweep action: ${action}`,
    "",
    `You are ${targetName}. Treat this as a direct blocked-sweep handoff from Foreman automation.`,
    "",
    "Required action:",
    productivity
      ? "- Review whether the source issue is genuinely stalled, productive, duplicated, satisfied, or needs decomposition/reroute. Post the manager decision visibly, then move this productivity-review card to Done or keep it blocked only with a concrete owner/action."
      : "- Identify the real unblock owner/action, coordinate with peer leads/workers, and move the work forward if the blocker is process-only. Keep it blocked only when there is a real external owner/action.",
    "- If Samuel approval, waiver, credentials, scope change, identity/security tradeoff, PR/push decision, or other owner action is required, post a Paperclip decision_needed comment and notify Samuel visibly in Telegram.",
    "- Preserve the hourly follow-up rule: check source state at least hourly until complete, cancelled, superseded, or explicitly blocked on Samuel.",
    "- Every team-worked run still needs a visible self-improvement/improver review or no-op before Done/final.",
    "",
    "Issue brief:",
    issue.description || "(No description available.)",
  ].join("\n");
}

async function sendToTarget(config, senderSession, issue, target, action) {
  return comsRequest(config, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      project: config.comsProject,
      sender_session: senderSession,
      target: target.name,
      target_session: target.session_id,
      prompt: buildBlockedPrompt(config, issue, target.name, action),
      conversation_id: `paperclip-blocked:${issue.identifier}`,
      response_schema: null,
      hops: 0,
    }),
  });
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const max = Number(args.max || 20);
  const force = enabled(args.force);
  const dryRun = enabled(args["dry-run"]);
  const lockPath = acquireLock(config);
  if (!lockPath) {
    console.log(JSON.stringify({ swept: 0, skipped: true, message: "Blocked sweep already running." }, null, 2));
    return;
  }

  try {
    const state = loadState(config);
    const targetsByName = await resolveHandoffTargets(config);
    const plannedSlots = {};
    const now = Date.now();
    const blocked = (await listBlockedIssues(config))
      .filter((issue) => force || !recentlySwept(config, state, issue, now))
      .slice(0, max);

    if (blocked.length === 0) {
      console.log(JSON.stringify({ swept: 0, message: "No unswept blocked tasks." }, null, 2));
      return;
    }

    const results = [];
    let senderSession = null;
    try {
      senderSession = await registerSweeper(config);
      await heartbeatSweeper(config, senderSession);
      for (const issue of blocked) {
        const target = chooseHandoffTarget(config, issue, targetsByName, plannedSlots);
        if (!target) {
          results.push({ identifier: issue.identifier, skipped: true, backpressure: true, error: "No unblock lane has capacity." });
          continue;
        }
        plannedSlots[target.session_id] = (plannedSlots[target.session_id] || 0) + 1;
        const productivity = isProductivityReviewIssue(issue);
        const action = productivity ? "reactivate_productivity_review" : "blocked_triage_nudge";
        if (dryRun) {
          results.push({ identifier: issue.identifier, dryRun: true, target: target.name, action });
          continue;
        }

        const comment = productivity
          ? `Factory blocked sweep reactivated this productivity-review card and routed unblock triage to ${target.name}. This is no longer allowed to sit in Blocked unless the lane records a concrete owner/action or Samuel decision need.`
          : `Factory blocked sweep routed unblock triage to ${target.name}. Keep this card blocked only if the blocker is real and the owner/action is explicit; otherwise move it forward and record evidence.`;
        const patch = productivity
          ? {
              status: "in_progress",
              assigneeAgentId: issue.assigneeAgentId || config.coordinatorAgentId,
              comment,
            }
          : { comment };
        await patchIssue(config, issue.id, patch);
        await heartbeatSweeper(config, senderSession);
        const handoff = await sendToTarget(config, senderSession, issue, target, action);
        state.issues[issue.id] = {
          readyFingerprint: readyFingerprint(issue),
          lastSweepAt: new Date().toISOString(),
          target: target.name,
          targetSession: target.session_id,
          action,
          messageId: handoff.msg_id,
          handoffStatus: handoff.status,
        };
        saveState(config, state);
        results.push({
          identifier: issue.identifier,
          target: target.name,
          action,
          messageId: handoff.msg_id,
          handoffStatus: handoff.status,
        });
      }
    } finally {
      if (senderSession) await deleteSweeper(config, senderSession);
    }

    console.log(JSON.stringify({ swept: results.length, results }, null, 2));
  } finally {
    releaseLock(lockPath);
  }
}

export {
  buildBlockedPrompt,
  isProductivityReviewIssue,
  recentlySwept,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
