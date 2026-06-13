import type { QuotaWindow } from "./quota.js";

export type OAuthAccountUsabilityStatus =
  | "usable"
  | "quota_exhausted"
  | "not_authenticated"
  | "configured"
  | "unknown"
  | "error";

export interface OAuthLocalUsageSummary {
  source: string;
  sessions: number;
  messages: number;
  dedupedRows: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  models: string[];
}

export interface OAuthAccountUsageReport {
  provider: string;
  tool: string;
  accountIdentifier: string | null;
  authSourceType: string;
  selectedModel: string | null;
  availableModelInfo: string | null;
  usabilityStatus: OAuthAccountUsabilityStatus;
  quotaState: "available" | "exhausted" | "unknown" | "not_exposed" | "error";
  quotaWindows: QuotaWindow[];
  quotaResetInfo: string | null;
  quotaDetail: string | null;
  recentLocalUsage: OAuthLocalUsageSummary | null;
  lastCheckedAt: string;
  evidenceSources: string[];
  notes: string[];
}

export interface OAuthAccountUsageResponse {
  checkedAt: string;
  accounts: OAuthAccountUsageReport[];
  limitations: string[];
}
