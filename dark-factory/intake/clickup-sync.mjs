#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendLedgerEvent } from "<FORK>/dark-factory/board/ledger-lib.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FACTORY_CONFIG_PATH = process.env.FACTORY_INTAKE_CONFIG || path.join(SCRIPT_DIR, "config.local.json");
const CLICKUP_CONFIG_PATH = process.env.CLICKUP_SYNC_CONFIG || path.join(SCRIPT_DIR, "clickup.local.json");
const CLICKUP_API = "https://api.clickup.com/api/v2";
const CLICKUP_OAUTH_AUTHORIZE_URL = "https://app.clickup.com/api";
const SOURCE_LABEL = "source: clickup";
const SOURCE_MARKER = "[clickup-sync:v1]";
const KEYCHAIN_SERVICE = "openclaw-clickup-api-token";
const KEYCHAIN_ACCOUNT = "bugfixer";
const DEFAULT_OAUTH_REDIRECT_URI = "http://127.0.0.1:17895";
const DEFAULT_LABELS = [
  SOURCE_LABEL,
  "stage: To Do",
  "gate: security-review-required",
  "gate: no-mistakes-required",
  "ledger: required",
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
  return value === true || value === "true" || value === "1" || value === "yes";
}

function usage() {
  return [
    "Usage: node clickup-sync.mjs <action> [options]",
    "",
    "Actions:",
    "  --setup-token        Store a ClickUp personal API token in macOS Keychain",
    "  --setup-oauth        Run the local ClickUp OAuth setup flow",
    "  --discover           Print visible ClickUp workspaces/spaces/lists",
    "  --import             Import matching ClickUp tasks, then sync Paperclip review/done back to ClickUp",
    "  --import-only        Import matching ClickUp tasks only",
    "  --backsync-only      Move imported ClickUp tasks to review when their Paperclip cards are review/done",
    "  --help, -h           Show this help",
    "",
    "Options:",
    "  --dry-run            Preview the selected action without writing",
    "  --max <n>            Maximum ClickUp tasks to import for this run",
    "",
    "Imports are intentionally opt-in. A bare command does not create Paperclip cards.",
  ].join("\n");
}

function wantsHelp(args) {
  return enabled(args.help) || enabled(args.h);
}

function wantsImport(args) {
  return enabled(args.import) || enabled(args["import-only"]);
}

function wantsReviewSync(args) {
  return enabled(args.import) || enabled(args["backsync-only"]);
}

function cleanText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
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

function loadFactoryConfig() {
  const fileConfig = readJson(FACTORY_CONFIG_PATH, {});
  const config = {
    paperclipApi: process.env.PAPERCLIP_API_BASE || fileConfig.paperclipApi,
    companyId: process.env.PAPERCLIP_COMPANY_ID || fileConfig.companyId,
    projectId: process.env.PAPERCLIP_PROJECT_ID || fileConfig.projectId,
    coordinatorAgentId: process.env.PAPERCLIP_COORDINATOR_AGENT_ID || fileConfig.coordinatorAgentId,
    boardUrl: process.env.PAPERCLIP_BOARD_URL || fileConfig.boardUrl || "http://127.0.0.1:3101",
    stateDir: process.env.FACTORY_INTAKE_STATE_DIR || fileConfig.stateDir || path.join(SCRIPT_DIR, "state"),
  };
  for (const key of ["paperclipApi", "companyId", "projectId", "coordinatorAgentId"]) {
    if (!config[key]) throw new Error(`Missing factory config: ${key}. Add ${FACTORY_CONFIG_PATH} or set env vars.`);
  }
  fs.mkdirSync(config.stateDir, { recursive: true });
  return config;
}

function loadClickUpConfig(factoryConfig) {
  const fileConfig = readJson(CLICKUP_CONFIG_PATH, {});
  const envListId = process.env.CLICKUP_LIST_ID;
  const config = {
    teamId: process.env.CLICKUP_TEAM_ID || fileConfig.teamId || null,
    sources: Array.isArray(fileConfig.sources) ? fileConfig.sources : [],
    maxPerRun: Number(process.env.CLICKUP_SYNC_MAX_PER_RUN || fileConfig.maxPerRun || 10),
    paperclipReviewStatuses: fileConfig.paperclipReviewStatuses || ["in_review", "done"],
    stateDir: process.env.CLICKUP_SYNC_STATE_DIR || fileConfig.stateDir || factoryConfig.stateDir,
  };
  if (envListId) {
    config.sources = [{
      name: process.env.CLICKUP_SOURCE_NAME || "ClickUp",
      listId: envListId,
      importStatuses: (process.env.CLICKUP_IMPORT_STATUSES || "to do,open,ready").split(",").map((item) => item.trim()).filter(Boolean),
      reviewStatus: process.env.CLICKUP_REVIEW_STATUS || "review",
    }];
  }
  fs.mkdirSync(config.stateDir, { recursive: true });
  return config;
}

function runQuiet(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function tokenFromKeychain() {
  if (process.platform !== "darwin") return null;
  const result = runQuiet("security", [
    "find-generic-password",
    "-a", KEYCHAIN_ACCOUNT,
    "-s", KEYCHAIN_SERVICE,
    "-w",
  ]);
  if (result.status !== 0) return null;
  return cleanText(result.stdout) || null;
}

function getToken() {
  const explicitAuth = sanitizeAuthHeader(process.env.CLICKUP_AUTHORIZATION || process.env.CLICKUP_AUTH_HEADER);
  const personalToken = sanitizeAuthHeader(process.env.CLICKUP_API_TOKEN || process.env.CLICKUP_TOKEN || process.env.CLICKUP_KEY);
  const oauthToken = sanitizeOAuthToken(process.env.CLICKUP_OAUTH_TOKEN || process.env.CLICKUP_ACCESS_TOKEN);
  return explicitAuth || personalToken || oauthToken || sanitizeAuthHeader(tokenFromKeychain());
}

function parseAppleScriptText(output) {
  const match = String(output || "").match(/text returned:([\s\S]*?)(?:,\s*gave up:|$)/);
  return match ? match[1].trim() : "";
}

function sanitizeAuthHeader(raw) {
  let token = cleanText(raw);
  if (!token) return "";
  token = token.replace(/^authorization:\s*/i, "").trim();
  token = token.replace(/^["']|["']$/g, "").trim();
  if (/^bearer\s+/i.test(token)) {
    return `Bearer ${token.replace(/^bearer\s+/i, "").trim()}`;
  }
  return token;
}

function sanitizePersonalToken(raw) {
  return sanitizeAuthHeader(raw);
}

function sanitizeOAuthToken(raw) {
  const token = sanitizeAuthHeader(raw);
  if (!token) return "";
  return /^bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

function promptForSecret(message, { hidden = true, timeoutSeconds = 300 } = {}) {
  if (process.platform !== "darwin") {
    throw new Error("Local secure prompts are macOS-only. Set the matching environment variables instead.");
  }
  const script = [
    `display dialog ${JSON.stringify(message)}`,
    'default answer ""',
    hidden ? "with hidden answer" : "",
    `buttons {"Cancel", "Save"} default button "Save" giving up after ${timeoutSeconds}`,
  ].filter(Boolean).join(" ");
  const prompt = runQuiet("osascript", ["-e", script]);
  if (prompt.status !== 0) throw new Error("ClickUp OAuth setup was cancelled.");
  return cleanText(parseAppleScriptText(prompt.stdout));
}

function storeAuthHeader(authHeader) {
  runQuiet("security", ["delete-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE]);
  const added = runQuiet("security", [
    "add-generic-password",
    "-a", KEYCHAIN_ACCOUNT,
    "-s", KEYCHAIN_SERVICE,
    "-w", authHeader,
    "-U",
  ]);
  if (added.status !== 0) {
    throw new Error(`Could not store ClickUp token in Keychain: ${cleanText(added.stderr)}`);
  }
}

async function setupToken() {
  if (process.platform !== "darwin") {
    throw new Error("Token setup prompt is macOS-only. Set CLICKUP_API_TOKEN in the environment instead.");
  }
  const script = [
    'display dialog "Paste your ClickUp API token. It will be stored in macOS Keychain for OpenClaw and will not be printed."',
    'default answer "" with hidden answer buttons {"Cancel", "Save"} default button "Save" giving up after 300',
  ].join(" ");
  const prompt = runQuiet("osascript", ["-e", script]);
  if (prompt.status !== 0) throw new Error("ClickUp token setup was cancelled.");
  const token = sanitizePersonalToken(parseAppleScriptText(prompt.stdout));
  if (!token) throw new Error("No ClickUp token entered.");
  if (!token.startsWith("pk_")) {
    throw new Error("That does not look like a ClickUp personal API token. In ClickUp Settings -> Apps, use the API Token value that starts with pk_.");
  }

  storeAuthHeader(token);

  const teams = await clickupRequest(token, "/team");
  return {
    stored: true,
    method: "personal-token",
    workspaces: (teams.teams || []).map((team) => ({ id: team.id, name: team.name })),
  };
}

function waitForOAuthCode(redirectUri, expectedState) {
  const redirect = new URL(redirectUri);
  if (!["127.0.0.1", "localhost"].includes(redirect.hostname)) {
    throw new Error("OAuth setup only supports localhost redirect URIs.");
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for ClickUp OAuth callback."));
    }, 5 * 60 * 1000);

    const server = http.createServer((req, res) => {
      try {
        const callbackUrl = new URL(req.url || "/", redirect.origin);
        if (callbackUrl.pathname !== redirect.pathname) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("Not found");
          return;
        }

        const error = callbackUrl.searchParams.get("error");
        const code = callbackUrl.searchParams.get("code");
        const state = callbackUrl.searchParams.get("state");
        if (error) throw new Error(`ClickUp OAuth returned error: ${error}`);
        if (!code) throw new Error("ClickUp OAuth callback did not include a code.");
        if (state !== expectedState) throw new Error("ClickUp OAuth state check failed.");

        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<!doctype html><title>ClickUp connected</title><p>ClickUp is connected. You can close this tab.</p>");
        clearTimeout(timeout);
        server.close();
        resolve(code);
      } catch (err) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end(err instanceof Error ? err.message : String(err));
        clearTimeout(timeout);
        server.close();
        reject(err);
      }
    });

    server.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    server.listen(Number(redirect.port || 80), redirect.hostname);
  });
}

async function exchangeOAuthCode(clientId, clientSecret, code) {
  const res = await fetch(`${CLICKUP_API}/oauth/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`POST /oauth/token -> ${res.status}: ${text}`);
  }
  if (!body?.access_token) {
    throw new Error("ClickUp OAuth token response did not include access_token.");
  }
  return sanitizeOAuthToken(body.access_token);
}

async function setupOAuth() {
  const redirectUri = cleanText(process.env.CLICKUP_OAUTH_REDIRECT_URI) || DEFAULT_OAUTH_REDIRECT_URI;
  const clientId = cleanText(process.env.CLICKUP_OAUTH_CLIENT_ID)
    || promptForSecret("Paste the ClickUp OAuth Client ID for OpenClaw.", { hidden: false });
  const clientSecret = cleanText(process.env.CLICKUP_OAUTH_CLIENT_SECRET)
    || promptForSecret("Paste the ClickUp OAuth Client Secret for OpenClaw. It will only be used to exchange the code.", { hidden: true });
  if (!clientId) throw new Error("No ClickUp OAuth client ID provided.");
  if (!clientSecret) throw new Error("No ClickUp OAuth client secret provided.");

  const state = crypto.randomBytes(16).toString("hex");
  const authUrl = new URL(CLICKUP_OAUTH_AUTHORIZE_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);

  const codePromise = waitForOAuthCode(redirectUri, state);
  const opened = runQuiet("open", [authUrl.toString()]);
  if (opened.status !== 0) {
    throw new Error(`Could not open ClickUp OAuth URL: ${cleanText(opened.stderr)}`);
  }

  const code = await codePromise;
  const authHeader = await exchangeOAuthCode(clientId, clientSecret, code);
  storeAuthHeader(authHeader);
  const teams = await clickupRequest(authHeader, "/team");
  return {
    stored: true,
    method: "oauth",
    redirectUri,
    workspaces: (teams.teams || []).map((team) => ({ id: team.id, name: team.name })),
  };
}

async function clickupRequest(token, pathName, options = {}) {
  const res = await fetch(`${CLICKUP_API}${pathName}`, {
    ...options,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: token,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${options.method || "GET"} ${pathName} -> ${res.status}: ${text}`);
  }
  return body;
}

async function paperclipRequest(config, pathName, options = {}) {
  const res = await fetch(`${config.paperclipApi}${pathName}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${options.method || "GET"} ${pathName} -> ${res.status}: ${text}`);
  }
  return body;
}

async function discoverClickUp(token, clickupConfig) {
  const teamsBody = await clickupRequest(token, "/team");
  const teams = [];
  for (const team of teamsBody.teams || []) {
    if (clickupConfig.teamId && String(team.id) !== String(clickupConfig.teamId)) continue;
    const spacesBody = await clickupRequest(token, `/team/${encodeURIComponent(team.id)}/space?archived=false`);
    const spaces = [];
    for (const space of spacesBody.spaces || []) {
      const folderlessBody = await clickupRequest(token, `/space/${encodeURIComponent(space.id)}/list?archived=false`);
      const folderlessLists = (folderlessBody.lists || []).map(compactList);
      const foldersBody = await clickupRequest(token, `/space/${encodeURIComponent(space.id)}/folder?archived=false`);
      const folders = [];
      for (const folder of foldersBody.folders || []) {
        const listsBody = await clickupRequest(token, `/folder/${encodeURIComponent(folder.id)}/list?archived=false`);
        folders.push({
          id: folder.id,
          name: folder.name,
          lists: (listsBody.lists || []).map(compactList),
        });
      }
      spaces.push({
        id: space.id,
        name: space.name,
        lists: folderlessLists,
        folders,
      });
    }
    teams.push({ id: team.id, name: team.name, spaces });
  }
  return { teams };
}

function compactList(list) {
  return {
    id: list.id,
    name: list.name,
    statuses: (list.statuses || []).map((status) => status.status || status.type || status.id).filter(Boolean),
  };
}

function statePath(config) {
  return path.join(config.stateDir, "clickup-sync-state.json");
}

function loadState(config) {
  return readJson(statePath(config), { tasks: {} });
}

function saveState(config, state) {
  writeJson(statePath(config), state);
}

function statusName(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.status || value.type || value.name || "";
}

function normal(value) {
  return String(value || "").trim().toLowerCase();
}

function taskPriority(task) {
  const id = Number(task.priority?.id || task.priority);
  if (id === 1) return "critical";
  if (id === 2) return "high";
  if (id === 4) return "low";
  return "medium";
}

function taskUrl(task) {
  return task.url || `https://app.clickup.com/t/${task.id}`;
}

function taskDescription(task) {
  return cleanText(task.markdown_description || task.markdown_content || task.text_content || task.description);
}

function buildPaperclipDescription(task, source) {
  const description = taskDescription(task) || "(No ClickUp description available.)";
  const metadata = [
    "- Source: ClickUp",
    `- Marker: ${SOURCE_MARKER}`,
    `- Source label: ${SOURCE_LABEL}`,
    `- ClickUp task id: ${task.id}`,
    task.custom_id ? `- ClickUp custom id: ${task.custom_id}` : null,
    `- ClickUp URL: ${taskUrl(task)}`,
    source.name ? `- ClickUp source: ${source.name}` : null,
    source.listId ? `- ClickUp list id: ${source.listId}` : null,
    `- ClickUp status at intake: ${statusName(task.status) || "(unknown)"}`,
    task.date_updated ? `- ClickUp updated at: ${new Date(Number(task.date_updated)).toISOString()}` : null,
    `- Imported at: ${new Date().toISOString()}`,
  ].filter(Boolean);

  return [
    "# Original ClickUp Ticket",
    task.name,
    "## ClickUp Metadata",
    metadata.join("\n"),
    "## ClickUp Description",
    description,
    "## Factory Handoff",
    [
      "- Paperclip is the internal execution and history surface for the factory.",
      "- The foreman should claim this card, then hand it to `pi-orchestrator` as a separate factory cell.",
      "- Treat the ClickUp ticket as the external source ticket and keep important final evidence on Paperclip.",
      "- Use a fresh clone/worktree and branch for repo work. Do not share dirty workspaces between tickets.",
      "- Log decisions, handoffs, blockers, evidence, verification, security review, PR links, self-improvement/improver review, and final disposition on this issue.",
      "- Every Dark Factory run must include an improver review before Ship to PR, Done, closed, or final disposition; if no reusable lesson exists, post a visible no-op review with run/ledger evidence.",
      "- When the Paperclip issue reaches review, the ClickUp sync will move the source ClickUp task to Review.",
    ].join("\n"),
  ].join("\n\n");
}

async function ensureLabel(apiConfig, name, color) {
  const labels = await paperclipRequest(apiConfig, `/companies/${apiConfig.companyId}/labels`);
  const existing = labels.find((label) => label.name === name);
  if (existing) return existing;
  return paperclipRequest(apiConfig, `/companies/${apiConfig.companyId}/labels`, {
    method: "POST",
    body: JSON.stringify({ name, color }),
  });
}

async function labelIdsFor(apiConfig) {
  await ensureLabel(apiConfig, SOURCE_LABEL, "#0ea5e9");
  const labels = await paperclipRequest(apiConfig, `/companies/${apiConfig.companyId}/labels`);
  return DEFAULT_LABELS.map((name) => {
    const label = labels.find((item) => item.name === name);
    if (!label) throw new Error(`Missing board label: ${name}`);
    return label.id;
  });
}

async function findExistingIssue(apiConfig, taskId) {
  const dedup = `ClickUp task id: ${taskId}`;
  const params = new URLSearchParams({
    projectId: apiConfig.projectId,
    q: taskId,
  });
  const issues = await paperclipRequest(apiConfig, `/companies/${apiConfig.companyId}/issues?${params.toString()}`);
  return issues.find((issue) => String(issue.description || "").includes(dedup)) || null;
}

async function createPaperclipIssue(apiConfig, task, source, args) {
  const existing = await findExistingIssue(apiConfig, task.id);
  if (existing) {
    return {
      deduped: true,
      id: existing.id,
      identifier: existing.identifier,
      title: existing.title,
      status: existing.status,
      url: `${apiConfig.boardUrl}/OPE/issues/${existing.identifier}`,
    };
  }

  const payload = {
    title: task.name,
    description: buildPaperclipDescription(task, source),
    status: "todo",
    priority: taskPriority(task),
    projectId: apiConfig.projectId,
    assigneeAgentId: apiConfig.coordinatorAgentId,
    labelIds: await labelIdsFor(apiConfig),
  };

  if (enabled(args["dry-run"])) return { dryRun: true, payload };

  const issue = await paperclipRequest(apiConfig, `/companies/${apiConfig.companyId}/issues`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  const url = `${apiConfig.boardUrl}/OPE/issues/${issue.identifier}`;
  const ledger = appendLedgerEvent({
    issue: issue.identifier,
    issueId: issue.id,
    issueUrl: url,
    title: issue.title,
    eventType: "clickup_task_imported",
    stage: "To Do",
    actor: "ClickUp Sync",
    actorRole: "intake-sync",
    summary: `ClickUp task imported to Paperclip: ${issue.title}`,
    details: {
      clickupTaskId: task.id,
      clickupTaskUrl: taskUrl(task),
      clickupSource: source.name || null,
      clickupListId: source.listId || null,
      clickupStatus: statusName(task.status) || null,
    },
    sourceRefs: [
      { kind: "clickup_task", id: task.id, url: taskUrl(task) },
      { kind: "paperclip_issue", id: issue.id, identifier: issue.identifier, url },
    ],
    visibility: "improver",
  });

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    url,
    ledgerDir: ledger.dir,
    ledgerEventHash: ledger.event.hash,
  };
}

async function listClickUpTasks(token, source) {
  const tasks = [];
  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams({
      archived: "false",
      include_closed: "false",
      subtasks: "true",
      page: String(page),
      include_markdown_description: "true",
    });
    const body = await clickupRequest(token, `/list/${encodeURIComponent(source.listId)}/task?${params.toString()}`);
    const batch = body.tasks || [];
    tasks.push(...batch);
    if (batch.length === 0 || batch.length < 100) break;
  }
  return tasks;
}

function shouldImport(task, source) {
  const allowed = new Set((source.importStatuses || ["to do", "open", "ready"]).map(normal));
  return allowed.has(normal(statusName(task.status)));
}

async function importClickUpTasks(token, apiConfig, clickupConfig, state, args) {
  const imported = [];
  const skipped = [];
  let remaining = Number(args.max || clickupConfig.maxPerRun || 10);
  if (!Array.isArray(clickupConfig.sources) || clickupConfig.sources.length === 0) {
    throw new Error(`No ClickUp sources configured. Add ${CLICKUP_CONFIG_PATH} or set CLICKUP_LIST_ID.`);
  }

  for (const source of clickupConfig.sources) {
    if (remaining <= 0) break;
    const tasks = await listClickUpTasks(token, source);
    for (const task of tasks) {
      if (remaining <= 0) break;
      const existing = state.tasks[task.id];
      if (existing?.paperclipIssueId) {
        skipped.push({ id: task.id, name: task.name, reason: "already_imported", paperclip: existing.paperclipIdentifier });
        continue;
      }
      if (!shouldImport(task, source)) {
        skipped.push({ id: task.id, name: task.name, reason: `status:${statusName(task.status)}` });
        continue;
      }
      const result = await createPaperclipIssue(apiConfig, task, source, args);
      imported.push({ clickupTaskId: task.id, clickupName: task.name, paperclip: result });
      if (!enabled(args["dry-run"])) {
        state.tasks[task.id] = {
          clickupTaskId: task.id,
          clickupTaskUrl: taskUrl(task),
          clickupListId: source.listId,
          clickupReviewStatus: source.reviewStatus || "review",
          sourceName: source.name || null,
          paperclipIssueId: result.id,
          paperclipIdentifier: result.identifier,
          paperclipUrl: result.url,
          importedAt: new Date().toISOString(),
          clickupStatusAtImport: statusName(task.status),
        };
        saveState(clickupConfig, state);
      }
      remaining -= 1;
    }
  }
  return { imported, skipped };
}

async function syncReviewStatuses(token, apiConfig, clickupConfig, state, args) {
  const moved = [];
  const skipped = [];
  const reviewStatuses = new Set((clickupConfig.paperclipReviewStatuses || ["in_review", "done"]).map(normal));

  for (const [clickupTaskId, entry] of Object.entries(state.tasks || {})) {
    if (!entry.paperclipIssueId || entry.clickupReviewMovedAt) {
      skipped.push({ clickupTaskId, reason: entry.clickupReviewMovedAt ? "already_moved" : "missing_paperclip" });
      continue;
    }
    const issue = await paperclipRequest(apiConfig, `/issues/${entry.paperclipIssueId}`);
    if (!reviewStatuses.has(normal(issue.status))) {
      skipped.push({ clickupTaskId, paperclip: issue.identifier, reason: `paperclip_status:${issue.status}` });
      continue;
    }
    const reviewStatus = entry.clickupReviewStatus || "review";
    if (!enabled(args["dry-run"])) {
      await clickupRequest(token, `/task/${encodeURIComponent(clickupTaskId)}`, {
        method: "PUT",
        body: JSON.stringify({ status: reviewStatus }),
      });
      entry.clickupReviewMovedAt = new Date().toISOString();
      entry.paperclipReviewStatus = issue.status;
      entry.updatedAt = new Date().toISOString();
      state.tasks[clickupTaskId] = entry;
      saveState(clickupConfig, state);
    }
    moved.push({
      clickupTaskId,
      reviewStatus,
      paperclip: issue.identifier,
      paperclipStatus: issue.status,
      dryRun: enabled(args["dry-run"]),
    });
  }

  return { moved, skipped };
}

function requireToken() {
  const token = getToken();
  if (!token) {
    throw new Error("No ClickUp token found. Run `node clickup-sync.mjs --setup-token`, `node clickup-sync.mjs --setup-oauth`, or set CLICKUP_API_TOKEN.");
  }
  return token;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (wantsHelp(args)) {
    console.log(usage());
    return;
  }

  const apiConfig = loadFactoryConfig();
  const clickupConfig = loadClickUpConfig(apiConfig);

  if (enabled(args["setup-token"])) {
    console.log(JSON.stringify(await setupToken(), null, 2));
    return;
  }

  if (enabled(args["setup-oauth"])) {
    console.log(JSON.stringify(await setupOAuth(), null, 2));
    return;
  }

  if (!enabled(args.discover) && !wantsImport(args) && !wantsReviewSync(args)) {
    throw new Error(`No ClickUp sync action specified.\n\n${usage()}`);
  }

  const token = requireToken();

  if (enabled(args.discover)) {
    console.log(JSON.stringify(await discoverClickUp(token, clickupConfig), null, 2));
    return;
  }

  const state = loadState(clickupConfig);
  const output = {};
  if (wantsImport(args)) {
    output.import = await importClickUpTasks(token, apiConfig, clickupConfig, state, args);
  }
  if (wantsReviewSync(args) && !enabled(args["import-only"])) {
    output.reviewSync = await syncReviewStatuses(token, apiConfig, clickupConfig, state, args);
  }
  console.log(JSON.stringify(output, null, 2));
}

export {
  buildPaperclipDescription,
  compactList,
  shouldImport,
  statusName,
  taskPriority,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
