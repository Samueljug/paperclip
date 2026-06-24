#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const WORKSPACE = resolve(import.meta.dirname, "../..");
const DEVELOPMENT = "/Users/samuelimini/Development";
const RUNS_DIR = resolve(WORKSPACE, "tools/paperclip-data/factory-runs");
const DEFAULT_SCAN_ROOTS = [
  resolve(DEVELOPMENT, "Dev"),
  resolve(DEVELOPMENT, "Stage"),
  resolve(DEVELOPMENT, "Website"),
  resolve(WORKSPACE, "tools"),
];
const SKIP_DIRS = new Set([
  ".git",
  ".audit-cache",
  ".next",
  ".openclaw",
  ".pi",
  ".turbo",
  ".venv",
  "backups",
  "build",
  "coverage",
  "data",
  "dist",
  "factory-run-ledgers",
  "factory-runs",
  "logs",
  "node_modules",
  "paperclip-data",
  "target",
  "vendor",
]);

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
    if (out[key] !== undefined) {
      out[key] = Array.isArray(out[key]) ? [...out[key], next] : [out[key], next];
    } else {
      out[key] = next;
    }
    i += 1;
  }
  return out;
}

function usage() {
  return [
    "Usage:",
    "  worktree-health.mjs check [--markdown] [--fail-on-dirty] [--include-defaults] [--include-run-workdirs] [--max-files 25]",
    "  worktree-health.mjs check --path /repo [--path /repo2] [--fail-on-dirty]",
    "  worktree-health.mjs check --root /search/root [--max-depth 4]",
  ].join("\n");
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function git(cwd, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error?.message || null,
  };
}

function isPathInside(path, parent) {
  const rel = relative(resolve(parent), resolve(path));
  return rel === "" || (rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function findGitRoot(path) {
  if (!path || !existsSync(path)) return null;
  const result = git(path, ["rev-parse", "--show-toplevel"]);
  return result.ok ? resolve(result.stdout.trim()) : null;
}

function addUnique(set, value) {
  if (value) set.add(resolve(value));
}

function scanForGitRoots(root, { maxDepth = 4, found = new Set(), depth = 0 } = {}) {
  const resolvedRoot = resolve(root);
  if (!existsSync(resolvedRoot)) return found;
  let entries;
  try {
    entries = readdirSync(resolvedRoot, { withFileTypes: true });
  } catch {
    return found;
  }

  if (entries.some((entry) => entry.name === ".git")) {
    const gitRoot = findGitRoot(resolvedRoot);
    if (gitRoot === resolvedRoot) found.add(resolvedRoot);
  }
  if (depth >= maxDepth) return found;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.endsWith(".app")) continue;
    scanForGitRoots(resolve(resolvedRoot, entry.name), { maxDepth, found, depth: depth + 1 });
  }
  return found;
}

function collectRunWorkingDirs({ runsDir = RUNS_DIR } = {}) {
  const byRoot = new Map();
  if (!existsSync(runsDir)) return byRoot;
  for (const name of readdirSync(runsDir)) {
    const manifestPath = resolve(runsDir, name, "run-manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = readJson(manifestPath);
      const workOrder = manifest.paths?.workOrder && existsSync(manifest.paths.workOrder)
        ? readJson(manifest.paths.workOrder)
        : null;
      const workingDir = workOrder?.repo?.workingDir || manifest.repo?.workingDir || null;
      const gitRoot = findGitRoot(workingDir);
      if (!gitRoot) continue;
      const refs = byRoot.get(gitRoot) || [];
      refs.push({
        issue: manifest.issue || workOrder?.issue || workOrder?.workOrderId || null,
        runId: manifest.runId || name,
        status: manifest.status || null,
        currentStage: manifest.currentStage || null,
        title: workOrder?.title || null,
      });
      byRoot.set(gitRoot, refs);
    } catch {
      // Ignore malformed historical runs; the scanner is best-effort inventory.
    }
  }
  return byRoot;
}

function classifyOwner(path, runWorkingDirs = new Map()) {
  const runRefs = runWorkingDirs.get(resolve(path)) || [];
  if (runRefs.length > 0) {
    return {
      category: "factory_run_repo",
      label: [...new Set(runRefs.map((ref) => ref.issue).filter(Boolean))].join(", ") || "factory run repo",
      runRefs,
    };
  }
  if (isPathInside(path, resolve(DEVELOPMENT, "Dev"))) {
    return { category: "development_dev", label: "Development/Dev", runRefs: [] };
  }
  if (isPathInside(path, resolve(DEVELOPMENT, "Stage"))) {
    return { category: "development_stage", label: "Development/Stage", runRefs: [] };
  }
  if (isPathInside(path, resolve(DEVELOPMENT, "Website"))) {
    return { category: "development_website", label: "Development/Website", runRefs: [] };
  }
  if (isPathInside(path, resolve(WORKSPACE, "tools"))) {
    return { category: "openclaw_tool_repo", label: "OpenClaw tool repo", runRefs: [] };
  }
  if (resolve(path) === WORKSPACE) {
    return { category: "openclaw_workspace", label: "OpenClaw workspace", runRefs: [] };
  }
  return { category: "unknown", label: basename(path) || path, runRefs: [] };
}

function parseBranchLine(line) {
  const match = String(line || "").match(/^##\s+(.+?)(?:\.\.\.(.+?))?(?:\s+\[(.+)\])?$/);
  if (!match) return { branch: null, upstream: null, aheadBehind: null };
  return {
    branch: match[1] || null,
    upstream: match[2] || null,
    aheadBehind: match[3] || null,
  };
}

function summarizeStatus(lines, maxFiles) {
  const files = [];
  const counts = {
    staged: 0,
    unstaged: 0,
    untracked: 0,
    ignored: 0,
    other: 0,
  };
  for (const line of lines) {
    if (!line || line.startsWith("## ")) continue;
    const xy = line.slice(0, 2);
    const filePath = line.slice(3);
    if (xy === "??") counts.untracked += 1;
    else if (xy === "!!") counts.ignored += 1;
    else {
      if (xy[0] && xy[0] !== " ") counts.staged += 1;
      if (xy[1] && xy[1] !== " ") counts.unstaged += 1;
      if (xy[0] === " " && xy[1] === " ") counts.other += 1;
    }
    if (files.length < maxFiles) files.push({ status: xy, path: filePath });
  }
  return { files, counts, fileCount: lines.filter((line) => line && !line.startsWith("## ")).length };
}

export function worktreeStatus(path, options = {}) {
  const maxFiles = options.maxFiles || 25;
  const gitRoot = findGitRoot(path);
  if (!gitRoot) {
    return {
      ok: false,
      path: resolve(path),
      error: "not inside a git worktree",
    };
  }
  const status = git(gitRoot, ["status", "--porcelain=v1", "--branch", "--untracked-files=all"]);
  if (!status.ok) {
    return {
      ok: false,
      path: gitRoot,
      error: (status.stderr || status.stdout || `git status exited ${status.status}`).trim(),
    };
  }
  const lines = status.stdout.split("\n").filter(Boolean);
  const branch = parseBranchLine(lines.find((line) => line.startsWith("## ")));
  const head = git(gitRoot, ["rev-parse", "HEAD"]);
  const summary = summarizeStatus(lines, maxFiles);
  return {
    ok: true,
    path: gitRoot,
    clean: summary.fileCount === 0,
    branch: branch.branch,
    upstream: branch.upstream,
    aheadBehind: branch.aheadBehind,
    head: head.ok ? head.stdout.trim() : null,
    fileCount: summary.fileCount,
    counts: summary.counts,
    files: summary.files,
  };
}

export function collectWorktreeHealth(options = {}) {
  const maxDepth = Number.parseInt(options.maxDepth || "4", 10);
  const maxFiles = options.maxFiles || 25;
  const runWorkingDirs = collectRunWorkingDirs();
  const roots = new Set();
  const searchRoots = options.roots || DEFAULT_SCAN_ROOTS;
  const extraPaths = options.paths || [];

  for (const path of extraPaths) addUnique(roots, findGitRoot(path));
  if (options.defaultRoots !== false) {
    for (const root of searchRoots) {
      for (const gitRoot of scanForGitRoots(root, { maxDepth })) {
        addUnique(roots, gitRoot);
      }
    }
  }
  if (options.includeRunWorkingDirs !== false) {
    for (const gitRoot of runWorkingDirs.keys()) addUnique(roots, gitRoot);
  }

  const worktrees = [...roots].sort().map((gitRoot) => {
    const status = worktreeStatus(gitRoot, { maxFiles });
    const owner = classifyOwner(gitRoot, runWorkingDirs);
    return { ...status, owner };
  });
  const errors = worktrees.filter((worktree) => !worktree.ok);
  const dirtyWorktrees = worktrees.filter((worktree) => worktree.ok && !worktree.clean);
  return {
    ok: dirtyWorktrees.length === 0 && errors.length === 0,
    generatedAt: new Date().toISOString(),
    scanRoots: searchRoots.map((root) => resolve(root)).filter((root) => existsSync(root)),
    worktreesChecked: worktrees.length,
    dirtyCount: dirtyWorktrees.length,
    errorCount: errors.length,
    dirtyWorktrees,
    errors,
    worktrees,
  };
}

export function collectSingleWorktreeHealth(path, options = {}) {
  return collectWorktreeHealth({
    ...options,
    defaultRoots: false,
    includeRunWorkingDirs: false,
    paths: [path],
  });
}

export function cleanWorktreeFailure(report) {
  const dirty = report.dirtyWorktrees || [];
  const errors = report.errors || [];
  if (dirty.length === 0 && errors.length === 0) return null;
  const lines = [
    `Dirty worktree preflight failed: ${dirty.length} dirty worktree(s), ${errors.length} scan error(s).`,
  ];
  for (const worktree of dirty.slice(0, 5)) {
    lines.push(`- ${worktree.path} (${worktree.owner?.label || "unknown owner"}): ${worktree.fileCount} changed file(s)`);
    for (const file of (worktree.files || []).slice(0, 8)) {
      lines.push(`  ${file.status} ${file.path}`);
    }
  }
  for (const error of errors.slice(0, 5)) {
    lines.push(`- ${error.path}: ${error.error}`);
  }
  return lines.join("\n");
}

export function assertCleanWorktree(path, options = {}) {
  const report = collectSingleWorktreeHealth(path, options);
  const failure = cleanWorktreeFailure(report);
  if (failure) throw new Error(`${options.label || "operation"} blocked.\n${failure}`);
  return report;
}

function compactOwner(owner) {
  if (!owner) return null;
  return {
    category: owner.category,
    label: owner.label,
    runRefCount: owner.runRefs?.length || 0,
    runRefs: (owner.runRefs || []).slice(0, 5),
  };
}

export function compactWorktreeHealth(report) {
  return {
    ok: report.ok,
    generatedAt: report.generatedAt,
    worktreesChecked: report.worktreesChecked,
    dirtyCount: report.dirtyCount,
    errorCount: report.errorCount,
    dirtyWorktrees: report.dirtyWorktrees.slice(0, 20).map((worktree) => ({
      path: worktree.path,
      owner: compactOwner(worktree.owner),
      branch: worktree.branch,
      upstream: worktree.upstream,
      aheadBehind: worktree.aheadBehind,
      head: worktree.head,
      fileCount: worktree.fileCount,
      counts: worktree.counts,
      files: worktree.files,
    })),
    errors: report.errors.slice(0, 20),
  };
}

export function worktreeHealthMarkdown(report) {
  const lines = [
    "# Dirty Worktree Health",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Worktrees checked: ${report.worktreesChecked}`,
    `- Dirty worktrees: ${report.dirtyCount}`,
    `- Scan errors: ${report.errorCount}`,
    "",
    "## Dirty Worktrees",
    "",
  ];
  if (report.dirtyWorktrees.length === 0) {
    lines.push("- None found.");
  } else {
    for (const worktree of report.dirtyWorktrees.slice(0, 20)) {
      lines.push(`- ${worktree.path} (${worktree.owner?.label || "unknown owner"}): ${worktree.fileCount} changed file(s), branch ${worktree.branch || "unknown"}`);
      for (const file of (worktree.files || []).slice(0, 8)) {
        lines.push(`  - ${file.status} ${file.path}`);
      }
      if ((worktree.files || []).length < worktree.fileCount) {
        lines.push(`  - ... ${worktree.fileCount - worktree.files.length} more`);
      }
    }
  }
  if (report.errors.length > 0) {
    lines.push("", "## Scan Errors", "");
    for (const error of report.errors.slice(0, 20)) {
      lines.push(`- ${error.path}: ${error.error}`);
    }
  }
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "check";
  if (command === "help" || command === "--help") {
    console.log(usage());
    return;
  }
  if (command !== "check") throw new Error(`Unknown command: ${command}\n\n${usage()}`);

  const paths = asArray(args.path);
  const report = collectWorktreeHealth({
    defaultRoots: paths.length === 0 || args["include-defaults"] === "true",
    includeRunWorkingDirs: paths.length === 0 || args["include-run-workdirs"] === "true",
    paths,
    roots: asArray(args.root).length ? asArray(args.root) : DEFAULT_SCAN_ROOTS,
    maxDepth: args["max-depth"] || "4",
    maxFiles: Number.parseInt(args["max-files"] || "25", 10),
  });
  if (args.markdown === "true") {
    console.log(worktreeHealthMarkdown(report));
  } else {
    console.log(JSON.stringify(compactWorktreeHealth(report), null, 2));
  }
  if (args["fail-on-dirty"] === "true" && !report.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
