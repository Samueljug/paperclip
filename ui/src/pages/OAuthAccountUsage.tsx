import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OAuthAccountUsageReport, OAuthAccountUsageResponse, QuotaWindow } from "@paperclipai/shared";
import { AlertTriangle, RefreshCw, ShieldCheck } from "lucide-react";
import { oauthAccountUsageApi } from "@/api/oauthAccountUsage";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { QuotaBar } from "@/components/QuotaBar";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { cn, providerDisplayName } from "@/lib/utils";

const NO_COMPANY = "__none__";

function formatDate(value: string | null | undefined) {
  if (!value) return "Not reported";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function statusTone(status: OAuthAccountUsageReport["usabilityStatus"]) {
  if (status === "usable" || status === "configured") return "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300";
  if (status === "quota_exhausted" || status === "error") return "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300";
  return "bg-muted text-muted-foreground";
}

function statusLabel(status: OAuthAccountUsageReport["usabilityStatus"]) {
  return status.replace(/_/g, " ");
}

function quotaLabel(report: OAuthAccountUsageReport) {
  if (report.quotaState === "available") return "Quota reported";
  if (report.quotaState === "exhausted") return "Quota exhausted";
  if (report.quotaState === "error") return "Quota error";
  if (report.quotaState === "not_exposed") return "Not exposed";
  return "Unknown quota";
}

function Pill({ label, className }: { label: string; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium", className)}>
      {label}
    </span>
  );
}

function QuotaWindowRow({ window }: { window: QuotaWindow }) {
  return (
    <QuotaBar
      label={window.label}
      percentUsed={window.usedPercent ?? 0}
      leftLabel={window.valueLabel ?? (window.usedPercent == null ? "No percentage" : `${window.usedPercent}% used`)}
      rightLabel={window.resetsAt ? `Resets ${formatDate(window.resetsAt)}` : window.detail ?? "No reset"}
      showDeficitNotch={window.usedPercent != null && window.usedPercent >= 100}
    />
  );
}

function EvidenceList({ sources }: { sources: string[] }) {
  if (sources.length === 0) {
    return <div className="text-xs text-muted-foreground">No local evidence source found.</div>;
  }
  return (
    <div className="space-y-1.5">
      {sources.map((source, index) => (
        <div key={`${source}-${index}`} className="break-all font-mono text-[11px] leading-4 text-muted-foreground">
          {source}
        </div>
      ))}
    </div>
  );
}

function AccountCard({ report }: { report: OAuthAccountUsageReport }) {
  const usage = report.recentLocalUsage;
  const Icon = report.usabilityStatus === "quota_exhausted" || report.usabilityStatus === "error"
    ? AlertTriangle
    : ShieldCheck;
  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Icon className={cn(
                "h-4 w-4 shrink-0",
                report.usabilityStatus === "quota_exhausted" || report.usabilityStatus === "error"
                  ? "text-destructive"
                  : "text-muted-foreground",
              )} />
              <span className="truncate">{report.tool}</span>
            </CardTitle>
            <CardDescription className="mt-1">
              {providerDisplayName(report.provider)} · {report.accountIdentifier ?? "Account not exposed"}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Pill label={statusLabel(report.usabilityStatus)} className={statusTone(report.usabilityStatus)} />
            <Pill
              label={quotaLabel(report)}
              className={report.quotaState === "exhausted" || report.quotaState === "error"
                ? "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300"
                : "bg-muted text-muted-foreground"}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-4 pb-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Auth source</div>
            <div className="mt-1 text-sm">{report.authSourceType}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Model evidence</div>
            <div className="mt-1 text-sm">{report.selectedModel ?? report.availableModelInfo ?? "Not exposed"}</div>
          </div>
        </div>

        <div className="space-y-2">
          {report.quotaWindows.length > 0 ? (
            report.quotaWindows.map((window) => <QuotaWindowRow key={`${report.tool}-${window.label}`} window={window} />)
          ) : (
            <div className="rounded-md border border-border p-3 text-sm text-muted-foreground">
              {report.quotaDetail ?? "Exact remaining quota is not exposed."}
              {report.quotaResetInfo ? <div className="mt-1 text-foreground">{report.quotaResetInfo}</div> : null}
            </div>
          )}
        </div>

        {usage ? (
          <div className="grid gap-3 text-sm md:grid-cols-4">
            <div>
              <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Sessions</div>
              <div className="mt-1 font-mono">{usage.sessions}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Messages</div>
              <div className="mt-1 font-mono">{usage.messages}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Deduped</div>
              <div className="mt-1 font-mono">{usage.dedupedRows}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Last local use</div>
              <div className="mt-1">{formatDate(usage.lastSeenAt)}</div>
            </div>
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Evidence</div>
            <div className="mt-2"><EvidenceList sources={report.evidenceSources} /></div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Notes</div>
            <div className="mt-2 space-y-1.5 text-xs leading-5 text-muted-foreground">
              {report.notes.map((note) => <div key={note}>{note}</div>)}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function EmptyReport({ data }: { data: OAuthAccountUsageResponse | undefined }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>No OAuth account state found</CardTitle>
        <CardDescription>
          Checked {data?.checkedAt ? formatDate(data.checkedAt) : "local model account locations"}.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

export function OAuthAccountUsage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const companyId = selectedCompanyId ?? NO_COMPANY;

  useEffect(() => {
    setBreadcrumbs([{ label: "OAuth usage" }]);
  }, [setBreadcrumbs]);

  const query = useQuery({
    queryKey: queryKeys.oauthAccountUsage(companyId),
    queryFn: () => oauthAccountUsageApi.get(companyId),
    enabled: !!selectedCompanyId,
    staleTime: 10_000,
  });

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">OAuth account usage</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Local OAuth model account status, quota evidence, reset clues, and safe usage summaries.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>
          <RefreshCw className={cn("mr-2 h-4 w-4", query.isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {query.isLoading ? <LoadingState /> : null}
      {query.error ? (
        <Card>
          <CardHeader>
            <CardTitle>Unable to load OAuth report</CardTitle>
            <CardDescription>{query.error instanceof Error ? query.error.message : "Unknown error"}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}
      {query.data && query.data.accounts.length === 0 ? <EmptyReport data={query.data} /> : null}
      {query.data ? (
        <div className="space-y-4">
          <div className="text-xs text-muted-foreground">Checked {formatDate(query.data.checkedAt)}</div>
          {query.data.accounts.map((report) => <AccountCard key={`${report.provider}-${report.tool}`} report={report} />)}
          <div className="space-y-1.5 text-xs leading-5 text-muted-foreground">
            {query.data.limitations.map((limitation) => <div key={limitation}>{limitation}</div>)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
