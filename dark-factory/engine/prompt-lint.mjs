#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const workspaceRoot = resolve(__dirname, "../..");
const defaultPromptsDir = resolve(workspaceRoot, "tools/pi-vs-claude-code/.pi/openclaw-teams/prompts");

const ACTION_PROMPT_PATTERN = /(?:implement|developer|review|verif|qa|test|security|browser|visual|release|architect|planner|improvement|dependency|orchestrator)/i;
const STRICT_SCOPE_PATTERN = /(?:shared-protocol\.md|strict task[- ]scope|task[- ]scope boundary|only edit files|accepted task explicitly authorizes)/i;

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

function markdownFiles(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => resolve(dir, name))
    .filter((path) => statSync(path).isFile());
}

function lintPrompt(path) {
  const name = basename(path);
  const text = readFileSync(path, "utf8");
  if (name === "shared-protocol.md") return null;
  const inScope = ACTION_PROMPT_PATTERN.test(name) || ACTION_PROMPT_PATTERN.test(text);
  if (!inScope) return null;
  const ok = STRICT_SCOPE_PATTERN.test(text);
  return {
    path,
    ok,
    reason: ok
      ? "loads shared protocol or includes strict task-scope boundary"
      : "missing shared-protocol.md or strict task-scope boundary text",
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const promptsDir = resolve(args.dir || defaultPromptsDir);
  const results = markdownFiles(promptsDir).map(lintPrompt).filter(Boolean);
  const failures = results.filter((result) => !result.ok);
  const report = {
    ok: failures.length === 0,
    promptsDir,
    checked: results.length,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
