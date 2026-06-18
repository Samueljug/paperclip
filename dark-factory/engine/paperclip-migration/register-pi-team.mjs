#!/usr/bin/env node
// register-pi-team.mjs
// -----------------------------------------------------------------------------
// Idempotent registration of the Pi dark-factory team as REAL Paperclip agents.
//
// WHAT THIS IS:
//   Additive control-plane data. It POSTs (or PATCHes) one Paperclip agent per
//   Pi-team role, building the org tree pi-orchestrator -> leads -> workers.
//   It does NOT start, stop, restart, or reconfigure any LIVE runtime
//   (no pi process, no OpenClaw gateway, no launchd). It only writes rows to the
//   Paperclip board via the documented HTTP API.
//
// WHY openclaw_gateway PLACEHOLDER CONFIG:
//   These agents are registered with adapterType="openclaw_gateway" pointing at
//   the live gateway URL, but with heartbeat DISABLED (runtimeConfig.heartbeat
//   .enabled=false). So Paperclip will NOT auto-invoke them. Registration is
//   pure visibility/org-structure until a later, GATED cut-over step flips a
//   single lane's heartbeat on. Nothing here makes the factory go dark and
//   nothing here makes Paperclip start driving the team.
//
// SAFETY / IDEMPOTENCY:
//   - Matches existing agents by exact name (GET /companies/:id/agents).
//   - Never touches the 3 pre-existing agents ("pi-orchestrator",
//     "Self-Improvement Reporter", "OpenClaw Coordinator") unless you opt in
//     with --reuse-existing-orchestrator (which only reads the existing
//     pi-orchestrator id to use as the org-tree root — it does not modify it).
//   - Re-running is safe: existing managed agents are PATCHed (config/reportsTo
//     re-synced) instead of duplicated. Use --dry-run to preview with zero writes.
//
// USAGE:
//   node register-pi-team.mjs --dry-run            # preview, no writes
//   node register-pi-team.mjs                      # apply (writes to live board)
//   node register-pi-team.mjs --reuse-existing-orchestrator
//                                                  # root the tree at the
//                                                  # existing "pi-orchestrator"
//   PAPERCLIP_API=http://127.0.0.1:3101/api \
//   PAPERCLIP_COMPANY_ID=1e8bc12a-f8fd-431c-9fbd-e47be79446a3 \
//   PAPERCLIP_NAME_PREFIX="PiTeam: " \
//   node register-pi-team.mjs
//
// ENV:
//   PAPERCLIP_API           default http://127.0.0.1:3101/api
//   PAPERCLIP_COMPANY_ID    default 1e8bc12a-f8fd-431c-9fbd-e47be79446a3
//   PAPERCLIP_TOKEN         optional Bearer token (instance runs local_trusted,
//                           so usually unset). If set, sent as Authorization.
//   PAPERCLIP_NAME_PREFIX   default "PiTeam: " — namespaces managed agent names
//                           so they never collide with the 3 existing markers.
//   PAPERCLIP_GATEWAY_URL   default ws://127.0.0.1:18789 — placeholder gateway
//                           URL stamped into each agent's adapterConfig.
//   PI_TEAM_ROOT            default repo root of the pi team, used to resolve
//                           the per-role prompt file paths.
// -----------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const API = (process.env.PAPERCLIP_API || "http://127.0.0.1:3101/api").replace(/\/+$/, "");
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "1e8bc12a-f8fd-431c-9fbd-e47be79446a3";
const TOKEN = process.env.PAPERCLIP_TOKEN || "";
const NAME_PREFIX = process.env.PAPERCLIP_NAME_PREFIX ?? "PiTeam: ";
const GATEWAY_URL = process.env.PAPERCLIP_GATEWAY_URL || "ws://127.0.0.1:18789";
const PI_TEAM_ROOT =
  process.env.PI_TEAM_ROOT ||
  "/Users/samuelimini/.openclaw/workspace/tools/pi-vs-claude-code";
const PROMPTS_DIR = path.join(PI_TEAM_ROOT, ".pi/openclaw-teams/prompts");

const DRY_RUN = process.argv.includes("--dry-run");
const REUSE_EXISTING_ORCH = process.argv.includes("--reuse-existing-orchestrator");

// Names of the 3 pre-existing agents the kit must NEVER duplicate or mutate.
const PROTECTED_NAMES = new Set([
  "pi-orchestrator",
  "Self-Improvement Reporter",
  "OpenClaw Coordinator",
]);

// ---------------------------------------------------------------------------
// Role map. Derived 1:1 from scripts/openclaw-team.sh (launch_* functions).
//   key        : pi role name (also the prompt file stem)
//   role       : mapped Paperclip built-in role (constants.ts AGENT_ROLES)
//   title      : human title shown on the board
//   icon       : a valid AGENT_ICON_NAMES value
//   reportsKey : pi role of the manager (org tree). null => tree root.
//   modelHint  : the launcher's model variable for this role, recorded into
//                metadata.piModelVar (informational; openclaw_gateway has no
//                Paperclip-side model field — the model lives in the pi runtime).
// ---------------------------------------------------------------------------
const ROOT = null;
const ROLES = [
  // --- root ---
  { key: "pi-orchestrator", role: "ceo", title: "Pi Orchestrator (dark-factory root)", icon: "radar", reportsKey: ROOT, modelHint: "MODEL_ORCH" },

  // --- leads (report to orchestrator) ---
  { key: "planning-lead", role: "pm", title: "Planning Lead", icon: "target", reportsKey: "pi-orchestrator", modelHint: "MODEL_PLANNING" },
  { key: "implementation-lead", role: "engineer", title: "Implementation Lead", icon: "code", reportsKey: "pi-orchestrator", modelHint: "MODEL_LEAD" },
  { key: "research-lead", role: "researcher", title: "Research Lead", icon: "telescope", reportsKey: "pi-orchestrator", modelHint: "MODEL_RESEARCH_LEAD" },
  { key: "verification-lead", role: "qa", title: "Verification Lead", icon: "shield", reportsKey: "pi-orchestrator", modelHint: "MODEL_LEAD" },
  { key: "browser-qa-lead", role: "qa", title: "Browser QA Lead", icon: "eye", reportsKey: "pi-orchestrator", modelHint: "MODEL_LEAD" },
  { key: "security-lead", role: "security", title: "Security Lead", icon: "lock", reportsKey: "pi-orchestrator", modelHint: "MODEL_SECURITY" },
  { key: "self-improvement-lead", role: "general", title: "Self-Improvement Lead", icon: "lightbulb", reportsKey: "pi-orchestrator", modelHint: "MODEL_SELF_IMPROVEMENT_LEAD" },
  { key: "problem-solving-lead", role: "engineer", title: "Problem-Solving Lead", icon: "puzzle", reportsKey: "pi-orchestrator", modelHint: "MODEL_PROBLEM_LEAD" },
  { key: "docs-release-lead", role: "general", title: "Docs & Release Lead", icon: "file-code", reportsKey: "pi-orchestrator", modelHint: "MODEL_DOCS_RELEASE_LEAD" },

  // --- planning workers (report to planning-lead) ---
  { key: "product-planner", role: "pm", title: "Product Planner", icon: "target", reportsKey: "planning-lead", modelHint: "MODEL_PLANNING" },
  { key: "architecture-planner", role: "engineer", title: "Architecture Planner", icon: "circuit-board", reportsKey: "planning-lead", modelHint: "MODEL_ARCHITECT" },

  // --- implementation workers (report to implementation-lead) ---
  { key: "frontend-implementer", role: "engineer", title: "Frontend Implementer", icon: "code", reportsKey: "implementation-lead", modelHint: "MODEL_WORKER" },
  { key: "backend-implementer", role: "engineer", title: "Backend Implementer", icon: "terminal", reportsKey: "implementation-lead", modelHint: "MODEL_WORKER" },

  // --- verification workers (report to verification-lead) ---
  { key: "test-engineer", role: "qa", title: "Test Engineer", icon: "bug", reportsKey: "verification-lead", modelHint: "MODEL_WORKER" },

  // --- browser QA workers (report to browser-qa-lead) ---
  { key: "browser-tester", role: "qa", title: "Browser Tester", icon: "eye", reportsKey: "browser-qa-lead", modelHint: "MODEL_WORKER" },
  { key: "visual-qa", role: "designer", title: "Visual QA", icon: "eye", reportsKey: "browser-qa-lead", modelHint: "MODEL_WORKER" },

  // --- security workers (report to security-lead) ---
  { key: "security-reviewer", role: "security", title: "Security Reviewer", icon: "lock", reportsKey: "security-lead", modelHint: "MODEL_SECURITY" },
  { key: "dependency-auditor", role: "security", title: "Dependency Auditor", icon: "package", reportsKey: "security-lead", modelHint: "MODEL_SECURITY" },
  { key: "tenant-isolation-reviewer", role: "security", title: "Tenant Isolation Reviewer", icon: "shield", reportsKey: "security-lead", modelHint: "MODEL_SECURITY" },
  { key: "data-sovereignty-reviewer", role: "security", title: "Data Sovereignty Reviewer", icon: "globe", reportsKey: "security-lead", modelHint: "MODEL_SECURITY" },
  { key: "authz-reviewer", role: "security", title: "AuthZ Reviewer", icon: "fingerprint", reportsKey: "security-lead", modelHint: "MODEL_SECURITY" },
  { key: "data-exposure-reviewer", role: "security", title: "Data Exposure Reviewer", icon: "eye", reportsKey: "security-lead", modelHint: "MODEL_SECURITY" },
  { key: "injection-reviewer", role: "security", title: "Injection Reviewer", icon: "swords", reportsKey: "security-lead", modelHint: "MODEL_SECURITY" },

  // --- self-improvement workers (report to self-improvement-lead) ---
  { key: "memory-librarian", role: "general", title: "Memory Librarian", icon: "database", reportsKey: "self-improvement-lead", modelHint: "MODEL_SELF_IMPROVEMENT_WORKER" },

  // --- research workers (report to research-lead) ---
  { key: "research-source-cartographer", role: "researcher", title: "Research: Source Cartographer", icon: "search", reportsKey: "research-lead", modelHint: "MODEL_RESEARCH_WORKER" },
  { key: "research-customer-revenue", role: "researcher", title: "Research: Customer & Revenue", icon: "search", reportsKey: "research-lead", modelHint: "MODEL_RESEARCH_WORKER" },
  { key: "research-technical-prober", role: "researcher", title: "Research: Technical Prober", icon: "microscope", reportsKey: "research-lead", modelHint: "MODEL_RESEARCH_WORKER" },
  { key: "research-risk-compliance", role: "researcher", title: "Research: Risk & Compliance", icon: "shield", reportsKey: "research-lead", modelHint: "MODEL_SECURITY" },
  { key: "research-skeptic-red-team", role: "researcher", title: "Research: Skeptic / Red Team", icon: "flame", reportsKey: "research-lead", modelHint: "MODEL_RESEARCH_WORKER" },
  { key: "research-synthesis-editor", role: "researcher", title: "Research: Synthesis Editor", icon: "lightbulb", reportsKey: "research-lead", modelHint: "MODEL_RESEARCH_WORKER" },

  // --- problem-solving workers (report to problem-solving-lead) ---
  { key: "problem-root-cause-solver", role: "engineer", title: "Problem: Root-Cause Solver", icon: "search", reportsKey: "problem-solving-lead", modelHint: "MODEL_PROBLEM_WORKER" },
  { key: "problem-implementation-solver", role: "engineer", title: "Problem: Implementation Solver", icon: "wrench", reportsKey: "problem-solving-lead", modelHint: "MODEL_PROBLEM_WORKER" },
  { key: "problem-test-repro-solver", role: "qa", title: "Problem: Test/Repro Solver", icon: "bug", reportsKey: "problem-solving-lead", modelHint: "MODEL_PROBLEM_WORKER" },
  { key: "problem-risk-skeptic", role: "security", title: "Problem: Risk Skeptic", icon: "flame", reportsKey: "problem-solving-lead", modelHint: "MODEL_PROBLEM_WORKER" },
  { key: "problem-synthesis-judge", role: "general", title: "Problem: Synthesis Judge", icon: "star", reportsKey: "problem-solving-lead", modelHint: "MODEL_PROBLEM_WORKER" },
];

// Sanity: every reportsKey must resolve to a known role key (or be the root).
const KEY_SET = new Set(ROLES.map((r) => r.key));
for (const r of ROLES) {
  if (r.reportsKey !== ROOT && !KEY_SET.has(r.reportsKey)) {
    throw new Error(`Role ${r.key} reportsKey ${r.reportsKey} is not a known role`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function managedName(key) {
  return `${NAME_PREFIX}${key}`;
}

function readPromptPath(key) {
  const p = path.join(PROMPTS_DIR, `${key}.md`);
  return { path: p, exists: existsSync(p) };
}

async function api(method, urlPath, body) {
  const headers = { "content-type": "application/json" };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg =
      (json && (json.error || json.message)) || `HTTP ${res.status}`;
    const err = new Error(`${method} ${urlPath} -> ${res.status}: ${msg}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// Build the openclaw_gateway placeholder adapterConfig for a role.
// IMPORTANT: heartbeat is DISABLED at create time, so Paperclip will NOT
// auto-invoke this agent. A later GATED step flips heartbeat on per-lane.
function buildAdapterConfig(role, promptPath) {
  return {
    url: GATEWAY_URL,
    // The pi runtime resolves the actual agent by its cname; we advertise the
    // pi role name as agentId so a future cut-over can route to the live pi
    // session without changing this record.
    agentId: role.key,
    sessionKeyStrategy: "issue",
    autoPairOnFirstConnect: true,
    timeoutSec: 120,
    paperclipApiUrl: API.replace(/\/api$/, ""),
    // Record where the human-readable role prompt lives. openclaw_gateway does
    // not own an instructions bundle, so this is metadata for operators, not an
    // execution input.
    payloadTemplate: {
      piRole: role.key,
      promptFile: promptPath,
    },
  };
}

function buildCreateBody(role, reportsToId, promptPath) {
  return {
    name: managedName(role.key),
    role: role.role,
    title: role.title,
    icon: role.icon,
    reportsTo: reportsToId ?? null,
    adapterType: "openclaw_gateway",
    adapterConfig: buildAdapterConfig(role, promptPath),
    // Disable the scheduler so registration is visibility-only. The factory
    // keeps running on pi/launchd; Paperclip just watches.
    runtimeConfig: {
      heartbeat: { enabled: false, intervalSec: 0, maxConcurrentRuns: 0 },
    },
    budgetMonthlyCents: 0,
    metadata: {
      managedBy: "register-pi-team.mjs",
      lane: "dark-factory-pi-team",
      piRole: role.key,
      piModelVar: role.modelHint,
      promptFile: promptPath,
      reportsKey: role.reportsKey ?? null,
    },
  };
}

// PATCH body re-syncs the mutable shape without clobbering anything sensitive.
function buildPatchBody(role, reportsToId, promptPath) {
  return {
    role: role.role,
    title: role.title,
    icon: role.icon,
    reportsTo: reportsToId ?? null,
    adapterType: "openclaw_gateway",
    adapterConfig: buildAdapterConfig(role, promptPath),
    metadata: {
      managedBy: "register-pi-team.mjs",
      lane: "dark-factory-pi-team",
      piRole: role.key,
      piModelVar: role.modelHint,
      promptFile: promptPath,
      reportsKey: role.reportsKey ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`# register-pi-team`);
  console.log(`API           = ${API}`);
  console.log(`COMPANY_ID    = ${COMPANY_ID}`);
  console.log(`NAME_PREFIX   = "${NAME_PREFIX}"`);
  console.log(`GATEWAY_URL   = ${GATEWAY_URL}`);
  console.log(`PROMPTS_DIR   = ${PROMPTS_DIR}`);
  console.log(`MODE          = ${DRY_RUN ? "DRY-RUN (no writes)" : "APPLY (writes to live board)"}`);
  console.log(`REUSE ORCH    = ${REUSE_EXISTING_ORCH}`);
  console.log("");

  // 1. Snapshot current board state.
  const existing = await api("GET", `/companies/${COMPANY_ID}/agents`);
  if (!Array.isArray(existing)) {
    throw new Error("Unexpected /agents response (not an array)");
  }
  const byName = new Map(existing.map((a) => [a.name, a]));
  console.log(`Found ${existing.length} existing agent(s) on the board.`);

  // 2. Warn on any missing prompt files (registration still proceeds; the
  //    prompt path is metadata, not an execution input for openclaw_gateway).
  let missingPrompts = 0;
  for (const r of ROLES) {
    const { exists } = readPromptPath(r.key);
    if (!exists) {
      missingPrompts++;
      console.warn(`  ! prompt missing for ${r.key} (path recorded as metadata anyway)`);
    }
  }
  if (missingPrompts === 0) console.log("All role prompt files resolved.");
  console.log("");

  // 3. Resolve the org-tree root id.
  //    Default: the script's own managed "PiTeam: pi-orchestrator" is the root
  //    (reportsTo=null). With --reuse-existing-orchestrator, child leads point
  //    at the PRE-EXISTING "pi-orchestrator" agent instead, and we skip
  //    creating a managed orchestrator. The pre-existing agent is never mutated.
  const idByKey = new Map(); // pi role key -> paperclip agent id

  if (REUSE_EXISTING_ORCH) {
    const existingOrch = byName.get("pi-orchestrator");
    if (!existingOrch) {
      throw new Error(
        "--reuse-existing-orchestrator was passed but no agent named 'pi-orchestrator' exists",
      );
    }
    idByKey.set("pi-orchestrator", existingOrch.id);
    console.log(`Reusing existing pi-orchestrator id=${existingOrch.id} as org root (not modified).`);
  }

  // 4. Process roles in dependency order so a manager exists before its reports.
  //    Topo order: root, then BFS over reportsKey edges.
  const ordered = topoOrder(ROLES);

  let created = 0;
  let patched = 0;
  let skipped = 0;

  for (const role of ordered) {
    // If reusing the existing orchestrator, do not create a managed duplicate.
    if (role.key === "pi-orchestrator" && REUSE_EXISTING_ORCH) {
      skipped++;
      continue;
    }

    const name = managedName(role.key);

    // Never collide with the 3 protected pre-existing markers. Our prefix makes
    // this practically impossible, but guard anyway.
    if (PROTECTED_NAMES.has(name)) {
      console.warn(`  - SKIP ${role.key}: managed name "${name}" collides with a protected agent`);
      skipped++;
      continue;
    }

    const reportsToId = resolveReportsTo(role, idByKey);
    const promptPath = readPromptPath(role.key).path;
    const found = byName.get(name);

    if (found) {
      // Idempotent PATCH: re-sync title/role/icon/reportsTo/adapterConfig.
      idByKey.set(role.key, found.id);
      if (DRY_RUN) {
        console.log(`  ~ would PATCH ${name} (id=${found.id}) reportsTo=${reportsToId ?? "null"}`);
        patched++;
        continue;
      }
      const body = buildPatchBody(role, reportsToId, promptPath);
      const updated = await api("PATCH", `/agents/${found.id}`, body);
      idByKey.set(role.key, updated.id ?? found.id);
      console.log(`  ~ PATCHed ${name} (id=${found.id})`);
      patched++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  + would CREATE ${name} role=${role.role} reportsTo=${reportsToId ?? "null"}`);
      // Use a synthetic id so downstream reports can resolve in dry-run.
      idByKey.set(role.key, `dry-${role.key}`);
      created++;
      continue;
    }

    const body = buildCreateBody(role, reportsToId, promptPath);
    const agent = await api("POST", `/companies/${COMPANY_ID}/agents`, body);
    idByKey.set(role.key, agent.id);
    console.log(`  + CREATED ${name} (id=${agent.id}) role=${role.role} reportsTo=${reportsToId ?? "null"}`);
    created++;
  }

  console.log("");
  console.log(`Done. created=${created} patched=${patched} skipped=${skipped} ${DRY_RUN ? "(dry-run)" : ""}`);
  if (!DRY_RUN) {
    console.log("");
    console.log("Verify the org tree:");
    console.log(`  curl -s ${API}/companies/${COMPANY_ID}/org | python3 -m json.tool`);
    console.log("To roll back (delete only the managed agents created by this kit):");
    console.log(`  node register-pi-team.mjs --rollback   # see ROLLBACK below`);
  }
}

// reportsTo resolution: root -> null; else the manager's resolved paperclip id.
function resolveReportsTo(role, idByKey) {
  if (role.reportsKey === ROOT) return null;
  const id = idByKey.get(role.reportsKey);
  if (!id) {
    throw new Error(
      `Cannot resolve reportsTo for ${role.key}: manager ${role.reportsKey} not registered yet`,
    );
  }
  // In dry-run the manager id may be synthetic ("dry-..."); Paperclip is never
  // called with it, so that's fine.
  return id;
}

// Topological order so every manager is processed before its reports.
function topoOrder(roles) {
  const byKey = new Map(roles.map((r) => [r.key, r]));
  const out = [];
  const seen = new Set();
  function visit(role, stack) {
    if (seen.has(role.key)) return;
    if (stack.has(role.key)) {
      throw new Error(`reportsTo cycle detected at ${role.key}`);
    }
    stack.add(role.key);
    if (role.reportsKey !== ROOT) {
      const mgr = byKey.get(role.reportsKey);
      if (mgr) visit(mgr, stack);
    }
    stack.delete(role.key);
    seen.add(role.key);
    out.push(role);
  }
  for (const r of roles) visit(r, new Set());
  return out;
}

// ---------------------------------------------------------------------------
// ROLLBACK: delete ONLY the managed agents this kit created.
//   node register-pi-team.mjs --rollback [--dry-run]
//   Matches by metadata.managedBy === "register-pi-team.mjs" AND name prefix,
//   so it can never delete the 3 protected agents.
// ---------------------------------------------------------------------------
async function rollback() {
  console.log(`# register-pi-team --rollback ${DRY_RUN ? "(dry-run)" : ""}`);
  const existing = await api("GET", `/companies/${COMPANY_ID}/agents`);
  const managed = existing.filter(
    (a) =>
      a?.metadata?.managedBy === "register-pi-team.mjs" &&
      typeof a.name === "string" &&
      a.name.startsWith(NAME_PREFIX) &&
      !PROTECTED_NAMES.has(a.name),
  );
  console.log(`Managed agents to delete: ${managed.length}`);
  // Delete leaves-first: reverse topo so reports go before managers.
  const orderKeys = topoOrder(ROLES).map((r) => managedName(r.key));
  managed.sort(
    (a, b) => orderKeys.indexOf(b.name) - orderKeys.indexOf(a.name),
  );
  for (const a of managed) {
    if (DRY_RUN) {
      console.log(`  - would DELETE ${a.name} (id=${a.id})`);
      continue;
    }
    await api("DELETE", `/agents/${a.id}`);
    console.log(`  - DELETED ${a.name} (id=${a.id})`);
  }
  console.log("Rollback complete.");
}

const isRollback = process.argv.includes("--rollback");
(isRollback ? rollback() : main()).catch((err) => {
  console.error("");
  console.error("FAILED:", err.message);
  if (err.body) console.error("Response body:", JSON.stringify(err.body, null, 2));
  process.exit(1);
});
