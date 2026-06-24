#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.FACTORY_INTAKE_CONFIG || path.join(SCRIPT_DIR, "config.local.json");

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

function loadConfig() {
  const fileConfig = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
    : {};
  return {
    paperclipApi: process.env.PAPERCLIP_API_BASE || fileConfig.paperclipApi,
    companyId: process.env.PAPERCLIP_COMPANY_ID || fileConfig.companyId,
    projectId: process.env.PAPERCLIP_PROJECT_ID || fileConfig.projectId,
    comsUrl: process.env.PI_COMS_NET_SERVER_URL || fileConfig.comsUrl,
    comsProject: process.env.PI_COMS_NET_PROJECT || fileConfig.comsProject,
    comsToken: process.env.PI_COMS_NET_AUTH_TOKEN || fileConfig.comsToken,
  };
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${options.method || "GET"} ${url} -> ${res.status}: ${text}`);
  return body;
}

async function boardCounts(config) {
  const out = {};
  for (const status of ["todo", "in_progress", "blocked", "review", "done"]) {
    const params = new URLSearchParams({ projectId: config.projectId, status });
    const data = await requestJson(`${config.paperclipApi}/companies/${config.companyId}/issues?${params.toString()}`);
    out[status] = Array.isArray(data) ? data.length : null;
  }
  return out;
}

async function laneDepths(config) {
  const data = await requestJson(`${config.comsUrl}/v1/agents?project=${encodeURIComponent(config.comsProject)}`, {
    headers: { authorization: `Bearer ${config.comsToken}` },
  });
  return (data.agents || [])
    .filter((agent) => [
      "pi-orchestrator",
      "planning-lead",
      "implementation-lead",
      "research-lead",
      "verification-lead",
      "browser-qa-lead",
      "security-lead",
      "self-improvement-lead",
    ].includes(agent.name))
    .map((agent) => ({
      name: agent.name,
      status: agent.status,
      queueDepth: agent.queue_depth,
    }));
}

function runNodeScript(scriptName, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SCRIPT_DIR, scriptName), ...args], {
      cwd: path.dirname(SCRIPT_DIR),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({ scriptName, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on("error", (err) => {
      resolve({ scriptName, code: 1, stdout: stdout.trim(), stderr: err.message });
    });
  });
}

const MONITOR_STATE = "/Users/samuelimini/.openclaw/workspace-telegram4/.openclaw/state/dark-factory-improver-monitor.json";
const TELEGRAM_TOKEN_FILE = "/Users/samuelimini/.openclaw/credentials/telegram-blackfixclaw-bot-token";
const TELEGRAM_CHAT_ID = process.env.OPENCLAW_TELEGRAM_CHAT_ID || "508625244";
const MONITOR_STALE_MS = 90 * 60 * 1000; // monitor runs every 30 min; 90 min late = dead.
const HEARTBEAT_STATE = path.join(path.dirname(MONITOR_STATE), "watchdog-heartbeat.json");

async function sendTelegram(text) {
  let token = "";
  try { token = fs.readFileSync(TELEGRAM_TOKEN_FILE, "utf8").trim(); } catch { return false; }
  if (!token) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
    return res.ok;
  } catch { return false; }
}

// Watch the watcher: the improver monitor (independent 30-min cron) writes
// lastRunAt to its state file each run. If that goes stale, the monitor is dead
// and the factory has lost its disk/log/coverage/pattern safety net — page Samuel.
async function checkImproverMonitorHeartbeat() {
  let lastRunMs = NaN;
  try {
    const state = JSON.parse(fs.readFileSync(MONITOR_STATE, "utf8"));
    lastRunMs = Date.parse(state.lastRunAt || state.lastInfraCheckAt || "");
  } catch {
    lastRunMs = NaN;
  }
  const now = Date.now();
  const ageMs = Number.isFinite(lastRunMs) ? now - lastRunMs : Infinity;
  if (ageMs < MONITOR_STALE_MS) return { ok: true, ageMin: Math.round(ageMs / 60000) };
  // Dedupe: only page once per 3h while stale.
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HEARTBEAT_STATE, "utf8")); } catch { hb = {}; }
  if (hb.lastPageAtMs && now - hb.lastPageAtMs < 3 * 60 * 60 * 1000) return { ok: false, ageMin: Math.round(ageMs / 60000), paged: false };
  const ageDesc = Number.isFinite(lastRunMs) ? `${Math.round(ageMs / 60000)} min ago` : "never / unreadable";
  const sent = await sendTelegram([
    "\u26a0\ufe0f Dark Factory: the improver MONITOR looks dead.",
    "",
    `Its last run was ${ageDesc} (expected every 30 min).`,
    "That means disk/log/coverage/pattern watching is currently OFF.",
    "Check the dark-factory-improver-monitor cron in workspace-telegram4.",
  ].join("\n"));
  try {
    fs.mkdirSync(path.dirname(HEARTBEAT_STATE), { recursive: true });
    fs.writeFileSync(HEARTBEAT_STATE, JSON.stringify({ lastPageAtMs: now, ageMin: Math.round(ageMs / 60000), sent }, null, 2));
  } catch { /* ignore */ }
  return { ok: false, ageMin: Math.round(ageMs / 60000), paged: sent };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const foremanMax = String(Number(args["foreman-max"] || 20));
  const blockedMax = String(Number(args["blocked-max"] || 20));
  const startedAt = new Date().toISOString();
  const before = await boardCounts(config).catch((err) => ({ error: err.message }));
  const beforeDepths = await laneDepths(config).catch((err) => ({ error: err.message }));

  const blockedSweep = await runNodeScript("factory-blocked-sweep.mjs", ["--max", blockedMax]);
  const foreman = await runNodeScript("factory-foreman.mjs", ["--max", foremanMax]);

  const after = await boardCounts(config).catch((err) => ({ error: err.message }));
  const afterDepths = await laneDepths(config).catch((err) => ({ error: err.message }));
  const improverMonitorHeartbeat = await checkImproverMonitorHeartbeat().catch((err) => ({ ok: null, error: err.message }));
  console.log(JSON.stringify({
    ok: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    before,
    after,
    beforeDepths,
    afterDepths,
    improverMonitorHeartbeat,
    runs: [blockedSweep, foreman],
  }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
    at: new Date().toISOString(),
  }, null, 2));
  process.exit(0);
});
