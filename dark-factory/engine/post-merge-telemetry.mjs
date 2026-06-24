#!/usr/bin/env node

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
  fsyncSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

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
    "  post-merge-telemetry.mjs check --pr-url URL [--issue OPE-123] [--error-log path] [--baseline-log path] [--threshold-count 1] [--threshold-ratio 2] [--output report.json] [--fail-on-alert]",
    "",
    "Without --error-log or a configured telemetry adapter, the command exits ok with status=not_configured.",
  ].join("\n");
}

function readLines(path) {
  if (!path) return [];
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`Missing log file: ${resolved}`);
  return readFileSync(resolved, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path);
}

function check(args) {
  const prUrl = args["pr-url"] || args.pr || null;
  const thresholdCount = Number.parseInt(args["threshold-count"] || "1", 10);
  const thresholdRatio = Number.parseFloat(args["threshold-ratio"] || "2");
  const hasAdapter = Boolean(args["error-log"] || process.env.SENTRY_AUTH_TOKEN || process.env.DARK_FACTORY_TELEMETRY_LOG);
  if (!hasAdapter) {
    const report = {
      ok: true,
      status: "not_configured",
      verdict: "SKIPPED",
      reason: "No error log or telemetry adapter is configured for this run.",
      prUrl,
      issue: args.issue || null,
      createdAt: new Date().toISOString(),
    };
    if (args.output) writeJsonAtomic(resolve(args.output), report);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const errorLog = args["error-log"] || process.env.DARK_FACTORY_TELEMETRY_LOG;
  const errors = readLines(errorLog);
  const baseline = readLines(args["baseline-log"]);
  const baselineCount = baseline.length;
  const errorCount = errors.length;
  const ratio = baselineCount === 0 ? (errorCount > 0 ? Infinity : 0) : errorCount / baselineCount;
  const alert = errorCount >= thresholdCount && ratio >= thresholdRatio;
  const report = {
    ok: true,
    status: "checked",
    verdict: alert ? "ALERT" : "HEALTHY",
    prUrl,
    issue: args.issue || null,
    errorLog: resolve(errorLog),
    baselineLog: args["baseline-log"] ? resolve(args["baseline-log"]) : null,
    errorCount,
    baselineCount,
    thresholdCount,
    thresholdRatio,
    ratio: Number.isFinite(ratio) ? ratio : "Infinity",
    sampleErrors: errors.slice(0, 10),
    nextAction: alert
      ? "Create or claim a repair ticket and run the implementation fix-test loop."
      : "Record post-merge healthy evidence if this was a high-risk merge.",
    createdAt: new Date().toISOString(),
  };
  if (args.output) writeJsonAtomic(resolve(args.output), report);
  console.log(JSON.stringify(report, null, 2));
  if (alert && args["fail-on-alert"] === "true") process.exitCode = 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }
  if (command === "check") return check(args);
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
