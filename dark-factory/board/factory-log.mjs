#!/usr/bin/env node

import {
  appendLedgerEvent,
  ledgerMarkdown,
  ledgerPaths,
  readLedgerEvents,
  readManifest,
  verifyLedger,
} from "./ledger-lib.mjs";

const DEFAULT_API = "http://127.0.0.1:3101/api";

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
    "  factory-log.mjs init --issue OPE-123 --title \"...\" --summary \"...\" [--issue-id UUID] [--issue-url URL]",
    "  factory-log.mjs event --issue OPE-123 --type stage_changed --actor planner --summary \"...\" [--stage Planning] [--details \"...\"] [--comment]",
    "  factory-log.mjs handoff --issue OPE-123 --from planner --to implementer --summary \"...\" [--next-action \"...\"] [--comment]",
    "  factory-log.mjs decision --issue OPE-123 --actor architect --summary \"...\" --rationale \"...\" [--alternatives \"...\"] [--comment]",
    "  factory-log.mjs artifact --issue OPE-123 --actor tester --kind test --path path-or-url --summary \"...\" [--comment]",
    "  factory-log.mjs export --issue OPE-123",
    "  factory-log.mjs verify --issue OPE-123",
  ].join("\n");
}

function requireArg(args, key) {
  const value = args[key]?.trim();
  if (!value) throw new Error(`Missing --${key}\n\n${usage()}`);
  return value;
}

function optionalJson(raw, fallback = null) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function eventType(args, fallback) {
  return args.type || args["event-type"] || fallback;
}

function artifactFromArgs(args) {
  if (!args.kind && !args.path && !args.url) return [];
  return [{
    kind: args.kind || "artifact",
    path: args.path || null,
    url: args.url || null,
    sha256: args.sha256 || null,
    summary: args.summary || null,
  }];
}

function baseInput(args, fallbackType) {
  return {
    issue: requireArg(args, "issue"),
    issueId: args["issue-id"] || null,
    issueUrl: args["issue-url"] || null,
    title: args.title || null,
    eventType: eventType(args, fallbackType),
    stage: args.stage || null,
    actor: args.actor || "OpenClaw",
    actorRole: args.role || null,
    summary: requireArg(args, "summary"),
    details: optionalJson(args.details),
    artifacts: artifactFromArgs(args),
    sourceRefs: args.source ? [{ kind: "source", path: args.source }] : [],
    visibility: args.visibility || "internal",
  };
}

async function request(api, path, options = {}) {
  const res = await fetch(`${api}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${options.method || "GET"} ${path} -> ${res.status}: ${text}`);
  }
  return body;
}

async function maybePostComment(args, result) {
  if (args.comment !== "true" || result.dryRun) return null;
  const manifest = readManifest(result.event.issue);
  const issueId = args["issue-id"] || manifest?.issueId;
  if (!issueId) {
    throw new Error("Cannot post Paperclip comment without --issue-id or a ledger manifest issueId");
  }
  const api = process.env.PAPERCLIP_API_BASE || DEFAULT_API;
  const body = [
    `Factory ledger event recorded: ${result.event.eventType}`,
    "",
    `- Summary: ${result.event.summary}`,
    `- Actor: ${result.event.actor}`,
    result.event.stage ? `- Stage: ${result.event.stage}` : null,
    `- Ledger: ${result.eventsPath}`,
    `- Sequence: ${result.event.sequence}`,
    `- Hash: ${result.event.hash}`,
  ].filter(Boolean).join("\n");

  return request(api, `/issues/${issueId}/comments`, {
    method: "POST",
    body: JSON.stringify({
      body,
      authorType: "user",
      presentation: {
        kind: "system_notice",
        tone: "info",
        title: "Factory ledger event",
        detailsDefaultOpen: false,
      },
    }),
  });
}

function printResult(result, comment) {
  console.log(JSON.stringify({
    dryRun: result.dryRun,
    issue: result.event.issue,
    eventType: result.event.eventType,
    sequence: result.event.sequence,
    eventId: result.event.eventId,
    hash: result.event.hash,
    ledgerDir: result.dir,
    eventsPath: result.eventsPath,
    commentId: comment?.id || null,
  }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }

  if (command === "export") {
    console.log(ledgerMarkdown(requireArg(args, "issue")));
    return;
  }

  if (command === "verify") {
    console.log(JSON.stringify(verifyLedger(requireArg(args, "issue")), null, 2));
    return;
  }

  if (command === "path") {
    console.log(JSON.stringify(ledgerPaths(requireArg(args, "issue")), null, 2));
    return;
  }

  if (command === "coverage") {
    const issue = requireArg(args, "issue");
    const events = readLedgerEvents(issue);
    const eventTypes = [...new Set(events.map((event) => event.eventType))].sort();
    const artifacts = events.flatMap((event) => event.artifacts || []);
    const sourceRefs = events.flatMap((event) => event.sourceRefs || []);
    console.log(JSON.stringify({
      issue,
      eventCount: events.length,
      eventTypes,
      artifactCount: artifacts.length,
      sourceRefCount: sourceRefs.length,
      verification: verifyLedger(issue),
    }, null, 2));
    return;
  }

  let input;
  if (command === "init") {
    input = {
      ...baseInput({ ...args, summary: args.summary || `Initialized factory run ledger for ${requireArg(args, "issue")}` }, "ledger_initialized"),
      actor: args.actor || "OpenClaw Coordinator",
      actorRole: args.role || "coordinator",
      details: {
        title: args.title || null,
        brief: args.brief || null,
        note: "Ledger initialized. Agents should append observable events, handoffs, decisions, artifacts, approvals, blockers, and gate results.",
      },
    };
  } else if (command === "event") {
    input = baseInput(args, "event");
  } else if (command === "handoff") {
    input = {
      ...baseInput(args, "handoff"),
      handoff: {
        from: requireArg(args, "from"),
        to: requireArg(args, "to"),
        nextAction: args["next-action"] || null,
      },
    };
  } else if (command === "decision") {
    input = {
      ...baseInput(args, "decision"),
      decision: {
        rationale: requireArg(args, "rationale"),
        alternatives: args.alternatives || null,
      },
    };
  } else if (command === "artifact") {
    input = {
      ...baseInput(args, "artifact"),
      artifacts: [{
        kind: requireArg(args, "kind"),
        path: args.path || null,
        url: args.url || null,
        sha256: args.sha256 || null,
        summary: requireArg(args, "summary"),
      }],
    };
  } else {
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }

  const result = appendLedgerEvent(input, { dryRun: args["dry-run"] === "true" });
  const comment = await maybePostComment(args, result);
  printResult(result, comment);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
