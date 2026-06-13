import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  OAuthAccountUsageReport,
  OAuthAccountUsageResponse,
  OAuthAccountUsabilityStatus,
  OAuthLocalUsageSummary,
  ProviderQuotaResult,
} from "@paperclipai/shared";
import { redactSensitiveText } from "../redaction.js";
import { fetchAllQuotaWindows } from "./quota-windows.js";

const RECENT_LOG_LIMIT = 30;
const READ_LIMIT_BYTES = 2 * 1024 * 1024;
const SECRET_FILE_RE = /(oauth_creds|auth\.json|credentials|token|secret|key)/i;

interface OAuthAccountUsageOptions {
  homeDir?: string;
  now?: Date;
  quotaResults?: ProviderQuotaResult[];
  skipLiveQuotaFetch?: boolean;
  readClaudeStatus?: () => Promise<LocalClaudeStatus | null>;
  readCodexInfo?: (codexDir: string) => Promise<LocalCodexInfo | null>;
}

interface LocalCodexInfo {
  accountId: string | null;
  email: string | null;
  planType: string | null;
}

interface LocalClaudeStatus {
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
}

type EvidenceLine = {
  path: string;
  line: string;
  mtimeMs: number;
};

type LogEvidence = {
  evidenceSources: string[];
  accountIdentifier: string | null;
  selectedModel: string | null;
  authSucceeded: boolean;
  notAuthenticated: boolean;
  quotaResetInfo: string | null;
  quotaDetail: string | null;
  quotaExhausted: boolean;
};

function defaultHomeDir() {
  return os.homedir();
}

function displayPath(absPath: string, homeDir: string) {
  const normalizedHome = path.resolve(homeDir);
  const normalizedPath = path.resolve(absPath);
  return normalizedPath === normalizedHome || normalizedPath.startsWith(`${normalizedHome}${path.sep}`)
    ? `~${normalizedPath.slice(normalizedHome.length)}`
    : normalizedPath;
}

async function exists(absPath: string) {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

async function statOrNull(absPath: string) {
  try {
    return await fs.stat(absPath);
  } catch {
    return null;
  }
}

async function readJsonFile<T = unknown>(absPath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(absPath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function base64UrlDecode(input: string): string | null {
  try {
    let normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const remainder = normalized.length % 4;
    if (remainder > 0) normalized += "=".repeat(4 - remainder);
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  if (typeof token !== "string" || token.trim().length === 0) return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  const decoded = base64UrlDecode(payload);
  if (!decoded) return null;
  try {
    return asRecord(JSON.parse(decoded));
  } catch {
    return null;
  }
}

async function readLocalCodexInfo(codexDir: string): Promise<LocalCodexInfo | null> {
  const parsed = asRecord(await readJsonFile(path.join(codexDir, "auth.json")));
  if (!parsed) return null;
  const tokens = asRecord(parsed.tokens);
  const accountId = readString(parsed, "accountId") ?? readString(tokens, "account_id");
  const idPayload = decodeJwtPayload(readString(tokens, "id_token"));
  const accessPayload = decodeJwtPayload(readString(tokens, "access_token"));
  const payloads = [idPayload, accessPayload].filter((value): value is Record<string, unknown> => value != null);
  for (const payload of payloads) {
    const auth = asRecord(payload["https://api.openai.com/auth"]);
    const profile = asRecord(payload["https://api.openai.com/profile"]);
    const email = readString(payload, "email") ?? readString(profile, "email") ?? readString(auth, "chatgpt_user_email");
    const planType = readString(auth, "chatgpt_plan_type");
    if (email || planType || accountId) return { accountId, email, planType };
  }
  return accountId ? { accountId, email: null, planType: null } : null;
}

async function readLocalClaudeStatus(): Promise<LocalClaudeStatus | null> {
  return null;
}

function sourceWithStat(absPath: string, homeDir: string, stat: { mtime: Date } | null) {
  const suffix = stat ? ` (mtime ${stat.mtime.toISOString()})` : "";
  return `${displayPath(absPath, homeDir)}${suffix}`;
}

async function readTextTail(absPath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(absPath);
    if (stat.size <= READ_LIMIT_BYTES) {
      return await fs.readFile(absPath, "utf8");
    }
    const handle = await fs.open(absPath, "r");
    try {
      const length = Math.min(stat.size, READ_LIMIT_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function recentFiles(files: string[], limit = RECENT_LOG_LIMIT): Promise<Array<{ path: string; mtimeMs: number }>> {
  const rows = await Promise.all(
    files.map(async (file) => ({ path: file, mtimeMs: (await statOrNull(file))?.mtimeMs ?? 0 })),
  );
  return rows.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

function safeEvidenceLine(line: string): string {
  return redactSensitiveText(line.replace(/\s+/g, " ").trim()).slice(0, 500);
}

function parseResetInfo(line: string): string | null {
  const match = line.match(/resets?\s+in\s+([0-9a-zA-Z\s]+?)(?:[.:]|$)/i);
  return match?.[1]?.trim() ? `Resets in ${match[1].trim()}` : null;
}

function extractModel(line: string): string | null {
  const labelMatch = line.match(/label="([^"]+)"/);
  if (labelMatch?.[1]) return labelMatch[1].trim();
  const modelMatch = line.match(/model="([^"]+)"/);
  if (modelMatch?.[1]) return modelMatch[1].trim();
  const resolvingMatch = line.match(/Resolving model\s+(.+)$/i);
  if (resolvingMatch?.[1]) return resolvingMatch[1].trim();
  return null;
}

function parseLogEvidence(lines: EvidenceLine[]): LogEvidence {
  const evidenceSources = new Set<string>();
  let accountIdentifier: string | null = null;
  let selectedModel: string | null = null;
  let authSucceeded = false;
  let notAuthenticated = false;
  let quotaResetInfo: string | null = null;
  let quotaDetail: string | null = null;
  let quotaExhausted = false;

  for (const item of lines) {
    const line = item.line;
    const accountMatch =
      line.match(/authenticated successfully as\s+([^\s,]+)/i)
      ?? line.match(/applyAuthResult:\s+email=([^,\s]+)/i);
    if (accountMatch?.[1]) {
      accountIdentifier = accountMatch[1].trim();
      authSucceeded = true;
      evidenceSources.add(`${item.path}: ${safeEvidenceLine(line)}`);
    }

    if (/not logged into Antigravity/i.test(line) || /not authenticated/i.test(line)) {
      notAuthenticated = true;
      evidenceSources.add(`${item.path}: ${safeEvidenceLine(line)}`);
    }

    const model = extractModel(line);
    if (model) {
      selectedModel = model;
      evidenceSources.add(`${item.path}: ${safeEvidenceLine(line)}`);
    }

    if (/RESOURCE_EXHAUSTED|quota reached|quota exhausted|rate limit/i.test(line)) {
      quotaExhausted = true;
      quotaResetInfo = parseResetInfo(line);
      quotaDetail = safeEvidenceLine(line);
      evidenceSources.add(`${item.path}: ${safeEvidenceLine(line)}`);
    }
  }

  return {
    evidenceSources: Array.from(evidenceSources).slice(-12),
    accountIdentifier,
    selectedModel,
    authSucceeded,
    notAuthenticated,
    quotaResetInfo,
    quotaDetail,
    quotaExhausted,
  };
}

async function readLogEvidence(logDir: string, homeDir: string): Promise<LogEvidence> {
  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = await fs.readdir(logDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const logFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
    .map((entry) => path.join(logDir, entry.name));
  const files = await recentFiles(logFiles);
  const rows: EvidenceLine[] = [];
  for (const file of files) {
    const raw = await readTextTail(file.path);
    if (!raw) continue;
    const stat = await statOrNull(file.path);
    const display = displayPath(file.path, homeDir);
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      rows.push({ path: display, line, mtimeMs: stat?.mtimeMs ?? 0 });
    }
  }
  rows.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return parseLogEvidence(rows);
}

function classifyFromQuota(
  quota: ProviderQuotaResult | null,
  fallback: OAuthAccountUsabilityStatus,
): Pick<OAuthAccountUsageReport, "quotaState" | "quotaWindows" | "quotaResetInfo" | "quotaDetail" | "usabilityStatus"> {
  if (!quota) {
    return {
      quotaState: "not_exposed",
      quotaWindows: [],
      quotaResetInfo: null,
      quotaDetail: "Exact remaining quota is not exposed locally.",
      usabilityStatus: fallback,
    };
  }
  if (!quota.ok) {
    const exhausted = /exhaust|rate limit|quota|429/i.test(quota.error ?? "");
    return {
      quotaState: exhausted ? "exhausted" : "error",
      quotaWindows: [],
      quotaResetInfo: null,
      quotaDetail: quota.error ?? "Quota fetch failed.",
      usabilityStatus: exhausted ? "quota_exhausted" : fallback,
    };
  }
  const exhaustedWindow = quota.windows.find((window) => window.usedPercent != null && window.usedPercent >= 100);
  return {
    quotaState: exhaustedWindow ? "exhausted" : quota.windows.length > 0 ? "available" : "not_exposed",
    quotaWindows: quota.windows,
    quotaResetInfo: exhaustedWindow?.resetsAt ?? null,
    quotaDetail: quota.windows.length > 0
      ? `Quota reported by ${quota.source ?? quota.provider}; exact remaining request count may still be unavailable.`
      : "Provider returned no quota windows.",
    usabilityStatus: exhaustedWindow ? "quota_exhausted" : fallback,
  };
}

async function summarizeGeminiLocalUsage(geminiDir: string, homeDir: string): Promise<OAuthLocalUsageSummary | null> {
  const tmpDir = path.join(geminiDir, "tmp");
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(tmpDir);
  } catch {
    return null;
  }

  const seen = new Set<string>();
  const sessions = new Set<string>();
  const models = new Set<string>();
  let messages = 0;
  let dedupedRows = 0;
  let firstSeenAt: string | null = null;
  let lastSeenAt: string | null = null;
  let sourceCount = 0;

  for (const projectDir of projectDirs) {
    const logsPath = path.join(tmpDir, projectDir, "logs.json");
    const parsed = await readJsonFile<unknown>(logsPath);
    if (!Array.isArray(parsed)) continue;
    sourceCount += 1;
    for (const row of parsed) {
      const record = asRecord(row);
      if (!record) continue;
      const sessionId = readString(record, "sessionId") ?? "unknown-session";
      const messageId = record.messageId == null ? "" : String(record.messageId);
      const timestamp = readString(record, "timestamp") ?? "";
      const type = readString(record, "type") ?? "";
      const key = `${sessionId}\0${messageId}\0${timestamp}\0${type}`;
      if (seen.has(key)) {
        dedupedRows += 1;
        continue;
      }
      seen.add(key);
      sessions.add(sessionId);
      messages += 1;
      const model = readString(record, "model");
      if (model) models.add(model);
      if (timestamp) {
        if (!firstSeenAt || timestamp < firstSeenAt) firstSeenAt = timestamp;
        if (!lastSeenAt || timestamp > lastSeenAt) lastSeenAt = timestamp;
      }
    }
  }

  if (messages === 0 && dedupedRows === 0 && sourceCount === 0) return null;
  return {
    source: `${displayPath(tmpDir, homeDir)}/*/logs.json (${sourceCount} file${sourceCount === 1 ? "" : "s"})`,
    sessions: sessions.size,
    messages,
    dedupedRows,
    firstSeenAt,
    lastSeenAt,
    models: Array.from(models).sort(),
  };
}

function limitedEvidenceSources(paths: Array<string | null>) {
  return paths.filter((value): value is string => value != null).slice(0, 12);
}

// Provider-specific report builders are appended below.

async function reportAntigravity(homeDir: string, checkedAt: string): Promise<OAuthAccountUsageReport> {
  const geminiDir = path.join(homeDir, ".gemini");
  const settingsPath = path.join(geminiDir, "antigravity-cli", "settings.json");
  const settings = asRecord(await readJsonFile(settingsPath));
  const configuredModel = readString(settings, "model");
  const settingsStat = await statOrNull(settingsPath);
  const logEvidence = await readLogEvidence(path.join(geminiDir, "antigravity-cli", "log"), homeDir);
  const selectedModel = configuredModel ?? logEvidence.selectedModel;
  const usabilityStatus: OAuthAccountUsabilityStatus = logEvidence.quotaExhausted
    ? "quota_exhausted"
    : logEvidence.authSucceeded
      ? "usable"
      : logEvidence.notAuthenticated
        ? "not_authenticated"
        : settings
          ? "configured"
          : "unknown";
  return {
    provider: "google",
    tool: "Antigravity agy",
    accountIdentifier: logEvidence.accountIdentifier,
    authSourceType: "Antigravity OAuth/keyring",
    selectedModel,
    availableModelInfo: selectedModel
      ? `Selected model evidence: ${selectedModel}`
      : "Available models are not stored in a stable local JSON cache.",
    usabilityStatus,
    quotaState: logEvidence.quotaExhausted ? "exhausted" : "not_exposed",
    quotaWindows: [],
    quotaResetInfo: logEvidence.quotaResetInfo,
    quotaDetail: logEvidence.quotaDetail ?? "Exact remaining quota is not exposed locally; using status/log evidence.",
    recentLocalUsage: null,
    lastCheckedAt: checkedAt,
    evidenceSources: limitedEvidenceSources([
      settings ? sourceWithStat(settingsPath, homeDir, settingsStat) : null,
      ...logEvidence.evidenceSources,
    ]),
    notes: [
      "Antigravity does not expose exact remaining OAuth quota locally.",
      "Quota state is inferred from RESOURCE_EXHAUSTED/reset log lines and auth/model status lines.",
    ],
  };
}

async function reportClassicGemini(homeDir: string, checkedAt: string): Promise<OAuthAccountUsageReport> {
  const geminiDir = path.join(homeDir, ".gemini");
  const settingsPath = path.join(geminiDir, "settings.json");
  const accountsPath = path.join(geminiDir, "google_accounts.json");
  const oauthPath = path.join(geminiDir, "oauth_creds.json");
  const [settings, accounts, oauthExists, usage] = await Promise.all([
    readJsonFile(settingsPath).then(asRecord),
    readJsonFile(accountsPath).then(asRecord),
    exists(oauthPath),
    summarizeGeminiLocalUsage(geminiDir, homeDir),
  ]);
  const auth = asRecord(settings?.security)?.auth;
  const selectedType = readString(asRecord(auth), "selectedType");
  const account = readString(accounts, "active");
  const selectedModel = usage?.models[0] ?? null;
  const configured = Boolean(settings || accounts || oauthExists);
  const oauthStat = await statOrNull(oauthPath);
  return {
    provider: "google",
    tool: "Gemini CLI",
    accountIdentifier: account,
    authSourceType: selectedType ? `Gemini config ${selectedType}` : oauthExists ? "Gemini OAuth credentials" : "Gemini local config",
    selectedModel,
    availableModelInfo: selectedModel
      ? `Recent local log model: ${selectedModel}`
      : "Classic Gemini CLI does not expose available/selected model quota in stable local metadata.",
    usabilityStatus: oauthExists || selectedType?.includes("oauth") ? "configured" : configured ? "unknown" : "not_authenticated",
    quotaState: "not_exposed",
    quotaWindows: [],
    quotaResetInfo: null,
    quotaDetail: "Exact remaining quota is not exposed locally; report uses OAuth/config presence and safe chat-log summaries.",
    recentLocalUsage: usage,
    lastCheckedAt: checkedAt,
    evidenceSources: limitedEvidenceSources([
      settings ? sourceWithStat(settingsPath, homeDir, await statOrNull(settingsPath)) : null,
      accounts ? sourceWithStat(accountsPath, homeDir, await statOrNull(accountsPath)) : null,
      oauthExists ? sourceWithStat(oauthPath, homeDir, oauthStat) : null,
      usage?.source ?? null,
    ]),
    notes: [
      "OAuth token values, refresh tokens, auth codes, and prompt/response text are never returned.",
      "Duplicate Gemini chat-log rows are deduped by session/message/timestamp/type.",
    ],
  };
}

async function reportCodex(
  homeDir: string,
  checkedAt: string,
  quota: ProviderQuotaResult | null,
  readInfo: (codexDir: string) => Promise<LocalCodexInfo | null>,
): Promise<OAuthAccountUsageReport> {
  const codexDir = path.join(homeDir, ".codex");
  const authPath = path.join(codexDir, "auth.json");
  const configPath = path.join(codexDir, "config.toml");
  const info = await readInfo(codexDir);
  const quotaClass = classifyFromQuota(quota, info ? "usable" : "not_authenticated");
  return {
    provider: "openai",
    tool: "Codex CLI",
    accountIdentifier: info?.email ?? info?.accountId ?? null,
    authSourceType: info ? `Codex OAuth${info.planType ? ` (${info.planType})` : ""}` : "Codex local config",
    selectedModel: null,
    availableModelInfo: "Codex model selection is read from runtime config/agent settings; account quota is reported separately when exposed.",
    ...quotaClass,
    recentLocalUsage: null,
    lastCheckedAt: checkedAt,
    evidenceSources: limitedEvidenceSources([
      await exists(authPath) ? sourceWithStat(authPath, homeDir, await statOrNull(authPath)) : null,
      await exists(configPath) ? sourceWithStat(configPath, homeDir, await statOrNull(configPath)) : null,
      quota ? `quota source: ${quota.source ?? quota.provider}` : null,
    ]),
    notes: [
      "Codex OAuth tokens are used only to call existing quota helpers and are never returned.",
      "Exact remaining request count may not be exposed even when usage windows are available.",
    ],
  };
}

async function reportClaude(
  homeDir: string,
  checkedAt: string,
  quota: ProviderQuotaResult | null,
  readStatus: () => Promise<LocalClaudeStatus | null>,
): Promise<OAuthAccountUsageReport> {
  const claudeDir = path.join(homeDir, ".claude");
  const credentialsPath = path.join(claudeDir, ".credentials.json");
  const settingsPath = path.join(claudeDir, "settings.json");
  const status = await readStatus();
  const fallback: OAuthAccountUsabilityStatus = status?.loggedIn ? "usable" : await exists(credentialsPath) ? "configured" : "unknown";
  const quotaClass = classifyFromQuota(quota, fallback);
  return {
    provider: "anthropic",
    tool: "Claude CLI",
    accountIdentifier: null,
    authSourceType: status?.authMethod
      ? `Claude ${status.authMethod}${status.subscriptionType ? ` (${status.subscriptionType})` : ""}`
      : "Claude local config",
    selectedModel: null,
    availableModelInfo: "Claude model choice is task/runtime dependent; subscription quota windows are reported when exposed.",
    ...quotaClass,
    recentLocalUsage: null,
    lastCheckedAt: checkedAt,
    evidenceSources: limitedEvidenceSources([
      await exists(credentialsPath) ? sourceWithStat(credentialsPath, homeDir, await statOrNull(credentialsPath)) : null,
      await exists(settingsPath) ? sourceWithStat(settingsPath, homeDir, await statOrNull(settingsPath)) : null,
      quota ? `quota source: ${quota.source ?? quota.provider}` : null,
    ]),
    notes: [
      "Claude OAuth credentials are never returned.",
      "When Anthropic OAuth usage is unavailable, the report falls back to CLI/status evidence.",
    ],
  };
}

function quotaForProvider(quotas: ProviderQuotaResult[], provider: string): ProviderQuotaResult | null {
  return quotas.find((quota) => quota.provider === provider) ?? null;
}

function scrubReport(report: OAuthAccountUsageReport): OAuthAccountUsageReport {
  const scrubbedSources = report.evidenceSources
    .filter((source) => !SECRET_FILE_RE.test(source) || !source.includes(": "))
    .map(redactSensitiveText);
  return {
    ...report,
    quotaDetail: report.quotaDetail ? redactSensitiveText(report.quotaDetail) : null,
    evidenceSources: scrubbedSources,
  };
}

export async function buildOAuthAccountUsageReport(
  options: OAuthAccountUsageOptions = {},
): Promise<OAuthAccountUsageResponse> {
  const homeDir = options.homeDir ?? defaultHomeDir();
  const now = options.now ?? new Date();
  const checkedAt = now.toISOString();
  const quotas = options.quotaResults ?? (
    options.skipLiveQuotaFetch ? [] : await fetchAllQuotaWindows()
  );
  const readClaudeStatus = options.readClaudeStatus ?? readLocalClaudeStatus;
  const readCodexInfo = options.readCodexInfo ?? readLocalCodexInfo;

  const reports = await Promise.all([
    reportAntigravity(homeDir, checkedAt),
    reportClassicGemini(homeDir, checkedAt),
    reportCodex(homeDir, checkedAt, quotaForProvider(quotas, "openai"), readCodexInfo),
    reportClaude(homeDir, checkedAt, quotaForProvider(quotas, "anthropic"), readClaudeStatus),
  ]);

  return {
    checkedAt,
    accounts: reports.map(scrubReport),
    limitations: [
      "Exact remaining OAuth quota is only shown when a provider exposes quota windows locally or through an existing OAuth usage endpoint.",
      "Google Gemini/Antigravity quota is inferred from local auth, model, quota-refresh, and RESOURCE_EXHAUSTED/reset evidence; remaining quota is not fabricated.",
      "Secret-bearing files are used only as presence/mtime evidence. Token values, refresh tokens, auth codes, API keys, bearer tokens, and raw logs are not returned.",
    ],
  };
}

export const oauthAccountUsageInternals = {
  parseLogEvidence,
  readLogEvidence,
  summarizeGeminiLocalUsage,
  classifyFromQuota,
  safeEvidenceLine,
};
