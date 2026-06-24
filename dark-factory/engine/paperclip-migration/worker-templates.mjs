#!/usr/bin/env node
// worker-templates.mjs
// -----------------------------------------------------------------------------
// Manage selectable WORKER TEMPLATES in Paperclip. Each template is an agent
// whose every call goes through the named LLM's CLI:
//   codex  -> adapterType "codex_local"  -> `codex` CLI
//   claude -> adapterType "claude_local" -> `claude` CLI
//   gemini -> adapterType "gemini_local" -> `gemini` CLI
// Templates are created heartbeat-OFF, so Paperclip does NOT auto-run them; you
// SELECT/activate one on demand (assign a task on the dashboard, or have OpenClaw
// wake it). Registry lives in worker-templates.json (edit to make new; copy a
// block to duplicate).
//
// USAGE:
//   node worker-templates.mjs --list                 # show registry + board status
//   node worker-templates.mjs --sync [--dry-run]     # create/update all templates on the board
//   node worker-templates.mjs --duplicate <srcKey> <newKey> [--model M] [--reasoning R] [--label "..."]
//   node worker-templates.mjs --new --key K --llm codex|claude|gemini --model M [--reasoning R] [--label "..."] [--note "..."]
//   node worker-templates.mjs --rollback [--key K]   # delete managed template agent(s)
//
// ENV: PAPERCLIP_API (default http://127.0.0.1:3101/api), PAPERCLIP_COMPANY_ID
// -----------------------------------------------------------------------------

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = path.join(__dirname, "worker-templates.json");
const API = (process.env.PAPERCLIP_API || "http://127.0.0.1:3101/api").replace(/\/+$/, "");
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "1e8bc12a-f8fd-431c-9fbd-e47be79446a3";
const TOKEN = process.env.PAPERCLIP_TOKEN || "";
const NAME_PREFIX = "Tpl: ";
const MANAGED_BY = "worker-templates.mjs";

// LLM -> CLI adapter wiring. This is the "all calls go through the LLM's CLI" guarantee.
const LLM = {
  codex:  { adapterType: "codex_local",  command: "codex",  reasoningField: "modelReasoningEffort", icon: "terminal",     reasoningValues: ["minimal", "low", "medium", "high", "xhigh"] },
  claude: { adapterType: "claude_local", command: "claude", reasoningField: "effort",               icon: "star",         reasoningValues: ["low", "medium", "high"] },
  gemini: { adapterType: "gemini_local", command: "gemini", reasoningField: null,                    icon: "circuit-board", reasoningValues: [] },
};

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const k = a.slice(2);
    const n = argv[i + 1];
    if (!n || n.startsWith("--")) { out[k] = true; continue; }
    out[k] = n; i += 1;
  }
  return out;
}

function loadRegistry() {
  return JSON.parse(readFileSync(REGISTRY, "utf8"));
}
function saveRegistry(reg) {
  writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + "\n");
}

async function api(method, p, body) {
  const headers = { "content-type": "application/json" };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${API}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = (json && (json.error || json.message)) || `HTTP ${res.status}`;
    const err = new Error(`${method} ${p} -> ${res.status}: ${msg}`);
    err.body = json; throw err;
  }
  return json;
}

function managedName(t) { return `${NAME_PREFIX}${t.label || t.key}`; }

function buildAdapterConfig(t, defaults) {
  const spec = LLM[t.llm];
  if (!spec) throw new Error(`Unknown llm "${t.llm}" for template ${t.key} (use codex|claude|gemini)`);
  const cfg = { command: spec.command, model: t.model };
  if (spec.reasoningField && t.reasoning && t.reasoning !== "auto") {
    if (spec.reasoningValues.length && !spec.reasoningValues.includes(t.reasoning)) {
      throw new Error(`Template ${t.key}: reasoning "${t.reasoning}" invalid for ${t.llm} (allowed: ${spec.reasoningValues.join("|")})`);
    }
    cfg[spec.reasoningField] = t.reasoning;
  }
  if (t.fastMode) cfg.fastMode = true;
  if (defaults && defaults.workspace) cfg.workspace = defaults.workspace;
  return cfg;
}

function buildCreateBody(t, defaults) {
  const spec = LLM[t.llm];
  const reasoning = spec.reasoningField ? (t.reasoning || "default") : "auto";
  return {
    name: managedName(t),
    role: "engineer",
    title: `${t.label || t.key} — via ${spec.command} CLI`,
    icon: spec.icon,
    adapterType: spec.adapterType,
    adapterConfig: buildAdapterConfig(t, defaults),
    runtimeConfig: { heartbeat: { enabled: Boolean(defaults && defaults.heartbeatEnabled), intervalSec: 0, maxConcurrentRuns: 0 } },
    budgetMonthlyCents: 0,
    metadata: {
      managedBy: MANAGED_BY, isWorkerTemplate: true,
      templateKey: t.key, llm: t.llm, cli: spec.command, model: t.model,
      reasoning, note: t.note || "",
    },
  };
}
function buildPatchBody(t, defaults) {
  const b = buildCreateBody(t, defaults);
  return { role: b.role, title: b.title, icon: b.icon, adapterType: b.adapterType, adapterConfig: b.adapterConfig, metadata: b.metadata };
}

async function boardAgents() {
  const a = await api("GET", `/companies/${COMPANY_ID}/agents`);
  if (!Array.isArray(a)) throw new Error("Unexpected /agents response");
  return a;
}

async function cmdList() {
  const reg = loadRegistry();
  const existing = new Map((await boardAgents()).map((a) => [a.name, a]));
  console.log(`Worker templates (${reg.templates.length}) — registry: ${REGISTRY}\n`);
  console.log("KEY".padEnd(18), "LLM".padEnd(7), "MODEL".padEnd(22), "REASON".padEnd(8), "ON BOARD");
  for (const t of reg.templates) {
    const on = existing.get(managedName(t));
    console.log(
      String(t.key).padEnd(18),
      String(t.llm).padEnd(7),
      String(t.model).padEnd(22),
      String(t.reasoning || "-").padEnd(8),
      on ? `yes (${on.id.slice(0, 8)})` : "no",
    );
  }
}

async function cmdSync(dryRun) {
  const reg = loadRegistry();
  const existing = new Map((await boardAgents()).map((a) => [a.name, a]));
  let created = 0, patched = 0;
  for (const t of reg.templates) {
    const name = managedName(t);
    const found = existing.get(name);
    if (dryRun) { console.log(found ? `~ would PATCH ${name}` : `+ would CREATE ${name} [${t.llm}/${t.model}/${t.reasoning}]`); found ? patched++ : created++; continue; }
    if (found) {
      await api("PATCH", `/agents/${found.id}`, buildPatchBody(t, reg.defaults));
      console.log(`~ PATCHed ${name} (${found.id.slice(0, 8)})`); patched++;
    } else {
      const a = await api("POST", `/companies/${COMPANY_ID}/agents`, buildCreateBody(t, reg.defaults));
      console.log(`+ CREATED ${name} (${a.id.slice(0, 8)}) [${t.llm} via ${LLM[t.llm].command}]`); created++;
    }
  }
  console.log(`\nDone. created=${created} patched=${patched} ${dryRun ? "(dry-run)" : ""}`);
}

function cmdDuplicate(args) {
  // --duplicate consumes the first positional as its value, so srcKey may land on args.duplicate.
  const srcKey = typeof args.duplicate === "string" ? args.duplicate : args._[0];
  const newKey = typeof args.duplicate === "string" ? args._[0] : args._[1];
  if (!srcKey || !newKey) throw new Error("usage: --duplicate <srcKey> <newKey> [--model M] [--reasoning R] [--label \"...\"]");
  const reg = loadRegistry();
  const src = reg.templates.find((t) => t.key === srcKey);
  if (!src) throw new Error(`source template "${srcKey}" not found`);
  if (reg.templates.some((t) => t.key === newKey)) throw new Error(`template "${newKey}" already exists`);
  const dup = { ...src, key: newKey };
  if (args.model) dup.model = args.model;
  if (args.reasoning) dup.reasoning = args.reasoning;
  if (args.llm) dup.llm = args.llm;
  dup.label = args.label || `${src.label} (copy)`;
  reg.templates.push(dup);
  saveRegistry(reg);
  console.log(`Duplicated ${srcKey} -> ${newKey}: ${JSON.stringify(dup)}\nRun: node worker-templates.mjs --sync`);
}

function cmdNew(args) {
  if (!args.key || !args.llm || !args.model) throw new Error("usage: --new --key K --llm codex|claude|gemini --model M [--reasoning R] [--label \"...\"] [--note \"...\"]");
  if (!LLM[args.llm]) throw new Error(`--llm must be codex|claude|gemini`);
  const reg = loadRegistry();
  if (reg.templates.some((t) => t.key === args.key)) throw new Error(`template "${args.key}" already exists`);
  const t = { key: args.key, llm: args.llm, model: args.model, reasoning: args.reasoning || (args.llm === "gemini" ? "auto" : "high"), label: args.label || args.key, note: args.note || "" };
  if (args.fastMode) t.fastMode = true;
  reg.templates.push(t);
  saveRegistry(reg);
  console.log(`Created template ${args.key}: ${JSON.stringify(t)}\nRun: node worker-templates.mjs --sync`);
}

async function cmdRollback(args, dryRun) {
  const agents = await boardAgents();
  const managed = agents.filter((a) => a?.metadata?.managedBy === MANAGED_BY && typeof a.name === "string" && a.name.startsWith(NAME_PREFIX));
  const target = args.key ? managed.filter((a) => a?.metadata?.templateKey === args.key) : managed;
  console.log(`Template agents to delete: ${target.length}`);
  for (const a of target) {
    if (dryRun) { console.log(`- would DELETE ${a.name}`); continue; }
    await api("DELETE", `/agents/${a.id}`);
    console.log(`- DELETED ${a.name}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args["dry-run"]);
  if (args.list) return cmdList();
  if (args.duplicate) return cmdDuplicate(args);
  if (args.new) return cmdNew(args);
  if (args.rollback) return cmdRollback(args, dryRun);
  if (args.sync) return cmdSync(dryRun);
  // default: list
  return cmdList();
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
