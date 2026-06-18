#!/usr/bin/env node

const DEFAULT_API = "http://127.0.0.1:3101/api";
const DEFAULT_COMPANY_ID = "1e8bc12a-f8fd-431c-9fbd-e47be79446a3";
const DEFAULT_PROJECT = "Company Priorities";
const DEFAULT_TZ = "Australia/Sydney";

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

function isEnabled(value) {
  return value === "true" || value === "1" || value === "yes";
}

async function request(api, path) {
  const res = await fetch(`${api}${path}`, {
    headers: { "content-type": "application/json" },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status}: ${text}`);
  }
  return body;
}

function dateOnly(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function todayInTimeZone(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(Number(values.year), Number(values.month) - 1, Number(values.day));
}

function parseDateValue(raw) {
  const trimmed = raw.trim().replace(/^["']|["']$/g, "");
  if (!trimmed || /^tbd$/i.test(trimmed) || /^none$/i.test(trimmed)) {
    return { raw: trimmed || "TBD", state: "missing", date: null };
  }
  const match = trimmed.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (!match) return { raw: trimmed, state: "unparseable", date: null };
  const [year, month, day] = match[1].split("-").map(Number);
  return { raw: match[1], state: "dated", date: new Date(year, month - 1, day) };
}

function extractDueDate(description = "") {
  const lines = String(description).split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*(?:[-*]\s*)?(?:due date|due)\s*:\s*(.+?)\s*$/i);
    if (match) return parseDateValue(match[1]);
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*#{1,6}\s*due date\s*$/i.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j].trim();
      if (!next) continue;
      if (/^#{1,6}\s+/.test(next)) break;
      return parseDateValue(next);
    }
  }
  return { raw: "TBD", state: "missing", date: null };
}

function issueUrl(identifier) {
  return `http://127.0.0.1:3101/OPE/issues/${identifier}`;
}

function formatIssue(item, today) {
  const diffDays = Math.round((item.due.date.getTime() - today.getTime()) / 86400000);
  const prefix = diffDays < 0
    ? `${Math.abs(diffDays)}d overdue`
    : diffDays === 0
      ? "due today"
      : `due in ${diffDays}d`;
  return `- ${item.identifier} - ${item.title} (${prefix}, ${item.due.raw}) ${issueUrl(item.identifier)}`;
}

function formatMissing(item) {
  const reason = item.due.state === "unparseable" ? `unparseable: ${item.due.raw}` : "TBD";
  return `- ${item.identifier} - ${item.title} (${reason}) ${issueUrl(item.identifier)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const api = args.api || process.env.PAPERCLIP_API_BASE || DEFAULT_API;
  const companyId = args["company-id"] || process.env.PAPERCLIP_COMPANY_ID || DEFAULT_COMPANY_ID;
  const projectName = args.project || DEFAULT_PROJECT;
  const days = Number(args.days || 3);
  const timeZone = args.tz || DEFAULT_TZ;
  const quietEmpty = isEnabled(args["quiet-empty"]);
  const includeMissing = isEnabled(args["include-missing"]);

  const projects = await request(api, `/companies/${companyId}/projects`);
  const project = projects.find((item) => item.name === projectName || item.id === projectName || item.urlKey === projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const rawIssues = await request(api, `/companies/${companyId}/issues?projectId=${encodeURIComponent(project.id)}`);
  const issues = Array.isArray(rawIssues) ? rawIssues : rawIssues.issues || [];
  const activeIssues = issues.filter((issue) => !["done", "cancelled"].includes(issue.status));
  const today = todayInTimeZone(timeZone);

  const parsed = activeIssues.map((issue) => ({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    due: extractDueDate(issue.description),
  }));

  const dated = parsed
    .filter((item) => item.due.state === "dated")
    .map((item) => ({ ...item, diffDays: Math.round((item.due.date.getTime() - today.getTime()) / 86400000) }));
  const overdue = dated.filter((item) => item.diffDays < 0).sort((a, b) => a.diffDays - b.diffDays);
  const dueToday = dated.filter((item) => item.diffDays === 0);
  const upcoming = dated.filter((item) => item.diffDays > 0 && item.diffDays <= days).sort((a, b) => a.diffDays - b.diffDays);
  const missing = parsed.filter((item) => item.due.state !== "dated");

  if (!overdue.length && !dueToday.length && !upcoming.length && (!includeMissing || !missing.length)) {
    if (!quietEmpty) {
      console.log(`No Company Priorities due-date reminders for the next ${days} days.`);
    }
    return;
  }

  const todayLabel = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const lines = [`Company Priorities due-date check (${todayLabel}, ${timeZone})`];
  if (overdue.length) {
    lines.push("", "Overdue");
    overdue.forEach((item) => lines.push(formatIssue(item, today)));
  }
  if (dueToday.length) {
    lines.push("", "Due today");
    dueToday.forEach((item) => lines.push(formatIssue(item, today)));
  }
  if (upcoming.length) {
    lines.push("", `Due within ${days} days`);
    upcoming.forEach((item) => lines.push(formatIssue(item, today)));
  }
  if (includeMissing && missing.length) {
    lines.push("", "Missing due dates");
    missing.forEach((item) => lines.push(formatMissing(item)));
  }
  console.log(lines.join("\n"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
