import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  fsyncSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_LEDGER_ROOT = process.env.FACTORY_LEDGER_DIR
  ? resolve(process.env.FACTORY_LEDGER_DIR)
  : resolve(__dirname, "../paperclip-data/factory-run-ledgers");

export function sanitizeIssueKey(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Missing issue identifier");
  const sanitized = raw.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (sanitized === "." || sanitized === ".." || sanitized.includes("..")) {
    throw new Error(`Invalid issue identifier: ${value}`);
  }
  return sanitized;
}

export function ledgerPaths(issue, root = DEFAULT_LEDGER_ROOT) {
  const issueKey = sanitizeIssueKey(issue);
  const resolvedRoot = resolve(root);
  const dir = resolve(resolvedRoot, issueKey);
  if (!dir.startsWith(resolvedRoot + "/") && dir !== resolvedRoot) {
    throw new Error(`Path traversal detected: ${dir}`);
  }
  return {
    dir,
    eventsPath: resolve(dir, "events.jsonl"),
    manifestPath: resolve(dir, "manifest.json"),
    issueKey,
  };
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeJsonAtomic(path, value) {
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

function appendLineFsync(path, line) {
  const fd = openSync(path, "a");
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function withLedgerLock(paths, fn) {
  const lockPath = resolve(paths.dir, ".ledger.lock");
  const deadline = Date.now() + 5000;
  let fd = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (err) {
      if (err?.code !== "EEXIST" || Date.now() > deadline) {
        throw new Error(`Could not acquire factory ledger lock: ${lockPath}`);
      }
      sleepMs(50);
    }
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    fsyncSync(fd);
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // If the lock has already gone away, the append already finished.
    }
  }
}

export function readLedgerEvents(issue, root = DEFAULT_LEDGER_ROOT) {
  const { eventsPath } = ledgerPaths(issue, root);
  if (!existsSync(eventsPath)) return [];
  const text = readFileSync(eventsPath, "utf8").trim();
  if (!text) return [];
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function readManifest(issue, root = DEFAULT_LEDGER_ROOT) {
  const { manifestPath } = ledgerPaths(issue, root);
  if (!existsSync(manifestPath)) return null;
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

export function appendLedgerEvent(input, options = {}) {
  const root = options.root || DEFAULT_LEDGER_ROOT;
  const issue = input.issue || input.identifier;
  const paths = ledgerPaths(issue, root);
  mkdirSync(paths.dir, { recursive: true });

  return withLedgerLock(paths, () => {
    const now = input.timestamp || new Date().toISOString();
    const existingEvents = readLedgerEvents(issue, root);
    const previous = existingEvents.at(-1) || null;
    const manifest = readManifest(issue, root) || {
      schemaVersion: 1,
      issue,
      issueId: input.issueId || null,
      issueUrl: input.issueUrl || null,
      title: input.title || null,
      createdAt: now,
      ledgerKind: "dark-factory-run-ledger",
      integrity: "events.jsonl is hash-chained with locked fsync appends; manifest is atomic mutable metadata",
    };

    const nextManifest = {
      ...manifest,
      issue,
      issueId: input.issueId || manifest.issueId || null,
      issueUrl: input.issueUrl || manifest.issueUrl || null,
      title: input.title || manifest.title || null,
      updatedAt: now,
      ledgerDir: paths.dir,
      eventsPath: paths.eventsPath,
    };
    if (!options.dryRun) {
      writeJsonAtomic(paths.manifestPath, nextManifest);
    }

    const event = {
      schemaVersion: 1,
      sequence: previous ? previous.sequence + 1 : 1,
      eventId: input.eventId || randomUUID(),
      timestamp: now,
      issue,
      issueId: input.issueId || nextManifest.issueId || null,
      eventType: input.eventType || "event",
      stage: input.stage || null,
      actor: input.actor || "unknown",
      actorRole: input.actorRole || null,
      summary: input.summary || "",
      details: input.details ?? null,
      decision: input.decision ?? null,
      handoff: input.handoff ?? null,
      artifacts: Array.isArray(input.artifacts) ? input.artifacts : [],
      sourceRefs: Array.isArray(input.sourceRefs) ? input.sourceRefs : [],
      visibility: input.visibility || "internal",
      redactionNote: input.redactionNote || "Do not store secrets or hidden model chain-of-thought; log observable events and reasoning summaries.",
      prevHash: previous?.hash || null,
    };
    const jsonParsed = JSON.parse(JSON.stringify(event));
    const hashInput = stableStringify(jsonParsed);
    const eventWithHash = { ...jsonParsed, hash: sha256(hashInput) };

    if (!options.dryRun) {
      appendLineFsync(paths.eventsPath, `${JSON.stringify(eventWithHash)}\n`);
    }

    return {
      event: eventWithHash,
      dryRun: Boolean(options.dryRun),
      ...paths,
    };
  });
}

export function verifyLedger(issue, root = DEFAULT_LEDGER_ROOT) {
  const { eventsPath } = ledgerPaths(issue, root);
  const exists = existsSync(eventsPath);
  let events = [];
  const failures = [];
  try {
    events = readLedgerEvents(issue, root);
  } catch (err) {
    failures.push({ sequence: 0, reason: "parse_error", message: err.message });
  }
  let previousHash = null;
  for (const event of events) {
    const { hash, ...withoutHash } = event;
    const expectedHash = sha256(stableStringify(withoutHash));
    if (hash !== expectedHash) {
      failures.push({ sequence: event.sequence, reason: "hash_mismatch", expectedHash, actualHash: hash });
    }
    if ((event.prevHash || null) !== previousHash) {
      failures.push({ sequence: event.sequence, reason: "prev_hash_mismatch", expectedPrevHash: previousHash, actualPrevHash: event.prevHash || null });
    }
    previousHash = hash;
  }
  return {
    exists,
    ok: exists && events.length > 0 && failures.length === 0,
    count: events.length,
    lastHash: events.at(-1)?.hash || null,
    failures,
  };
}

export function ledgerMarkdown(issue, root = DEFAULT_LEDGER_ROOT) {
  const manifest = readManifest(issue, root);
  const events = readLedgerEvents(issue, root);
  const verification = verifyLedger(issue, root);
  const lines = [
    `# Factory Run Ledger: ${issue}`,
    "",
    `- Events: ${events.length}`,
    `- Hash chain valid: ${verification.ok ? "yes" : "no"}`,
    `- Last hash: ${verification.lastHash || "none"}`,
  ];
  if (manifest?.issueUrl) lines.push(`- Paperclip: ${manifest.issueUrl}`);
  if (manifest?.title) lines.push(`- Title: ${manifest.title}`);
  lines.push("", "## Events", "");
  for (const event of events) {
    lines.push(`### ${event.sequence}. ${event.eventType} - ${event.timestamp}`);
    lines.push(`- Actor: ${event.actor}${event.actorRole ? ` (${event.actorRole})` : ""}`);
    if (event.stage) lines.push(`- Stage: ${event.stage}`);
    lines.push(`- Summary: ${event.summary || "No summary"}`);
    if (event.artifacts?.length) lines.push(`- Artifacts: ${event.artifacts.map((item) => item.path || item.url || item.summary || item.kind).join(", ")}`);
    if (event.sourceRefs?.length) lines.push(`- Sources: ${event.sourceRefs.map((item) => item.path || item.url || item.id || item.kind).join(", ")}`);
    lines.push(`- Hash: ${event.hash}`, "");
  }
  return lines.join("\n");
}
