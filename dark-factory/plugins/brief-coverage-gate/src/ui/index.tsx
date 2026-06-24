import {
  usePluginData,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";

type HealthData = {
  status: "ok" | "degraded" | "error";
  mode: "enforce" | "dry-run";
  pass: number;
  block: number;
  checkedAt: string;
};

export function DashboardWidget(_props: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<HealthData>("health");

  if (loading) return <div>Loading Brief Coverage Gate…</div>;
  if (error) return <div>Plugin error: {error.message}</div>;

  const enforcing = data?.mode === "enforce";

  return (
    <div style={{ display: "grid", gap: "0.4rem" }}>
      <strong>Brief Coverage Gate</strong>
      <div>
        Mode:{" "}
        <span
          style={{ fontWeight: 600, color: enforcing ? "#b45309" : "#2563eb" }}
        >
          {enforcing ? "ENFORCING (blocks issues)" : "dry-run (observe only)"}
        </span>
      </div>
      <div>Clean passes: {data?.pass ?? 0}</div>
      <div>Coverage blocks: {data?.block ?? 0}</div>
      <div style={{ opacity: 0.6, fontSize: 11 }}>
        Checked: {data?.checkedAt ?? "never"}
      </div>
    </div>
  );
}
