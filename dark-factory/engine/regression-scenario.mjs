#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
  fsyncSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(__dirname, "../..");
const DEFAULT_CORPUS = process.env.DARK_FACTORY_SCENARIO_CORPUS
  ? resolve(process.env.DARK_FACTORY_SCENARIO_CORPUS)
  : resolve(WORKSPACE_ROOT, "tools/paperclip-data/regression-scenarios/scenarios.jsonl");

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

function usage() {
  return [
    "Usage:",
    "  regression-scenario.mjs add --issue OPE-123 --kind webwright --summary \"...\" --trigger \"...\" --reproduction \"...\" --verification \"...\" [--evidence path] [--dry-run]",
    "  regression-scenario.mjs list [--issue OPE-123] [--kind test]",
    "  regression-scenario.mjs verify",
  ].join("\n");
}

function requireArg(args, key) {
  const value = args[key]?.trim();
  if (!value) throw new Error(`Missing --${key}\n\n${usage()}`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sanitize(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function readScenarios(path = DEFAULT_CORPUS) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  return text.split("\n").filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid scenario JSON on line ${index + 1}: ${error.message}`);
    }
  });
}

function appendLineFsync(path, line) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function addScenario(args) {
  const issue = requireArg(args, "issue");
  const evidencePath = args.evidence ? resolve(args.evidence) : null;
  const scenario = {
    schemaVersion: 1,
    id: `${sanitize(issue)}-${Date.now().toString(36)}-${sha256(`${issue}:${args.summary}:${args.trigger}`).slice(0, 10)}`,
    issue,
    kind: requireArg(args, "kind"),
    summary: requireArg(args, "summary"),
    trigger: requireArg(args, "trigger"),
    reproduction: requireArg(args, "reproduction"),
    verification: requireArg(args, "verification"),
    evidencePath,
    evidenceExists: evidencePath ? existsSync(evidencePath) : null,
    source: args.source || null,
    createdAt: new Date().toISOString(),
  };
  if (args["dry-run"] !== "true") {
    appendLineFsync(DEFAULT_CORPUS, `${JSON.stringify(scenario)}\n`);
  }
  console.log(JSON.stringify({ ok: true, dryRun: args["dry-run"] === "true", corpus: DEFAULT_CORPUS, scenario }, null, 2));
}

function listScenarios(args) {
  const scenarios = readScenarios().filter((scenario) => {
    if (args.issue && scenario.issue !== args.issue) return false;
    if (args.kind && scenario.kind !== args.kind) return false;
    return true;
  });
  console.log(JSON.stringify({ ok: true, corpus: DEFAULT_CORPUS, count: scenarios.length, scenarios }, null, 2));
}

function verifyScenarios() {
  const scenarios = readScenarios();
  const failures = [];
  const ids = new Set();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) failures.push({ id: scenario.id, reason: "duplicate id" });
    ids.add(scenario.id);
    for (const field of ["issue", "kind", "summary", "trigger", "reproduction", "verification"]) {
      if (!scenario[field]) failures.push({ id: scenario.id || null, reason: `missing ${field}` });
    }
    if (scenario.evidencePath && !existsSync(scenario.evidencePath)) {
      failures.push({ id: scenario.id, reason: "evidence path does not exist", path: scenario.evidencePath });
    }
  }
  console.log(JSON.stringify({ ok: failures.length === 0, corpus: DEFAULT_CORPUS, count: scenarios.length, failures }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }
  if (command === "add") return addScenario(args);
  if (command === "list") return listScenarios(args);
  if (command === "verify") return verifyScenarios(args);
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
