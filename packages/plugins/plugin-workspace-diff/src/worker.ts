import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { WorkspaceDiffQueryOptions } from "@paperclipai/plugin-sdk";

const PLUGIN_NAME = "workspace-diff";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    const trimmed = entry.trim();
    return trimmed ? [trimmed] : [];
  });
}

function readDiffOptions(params: Record<string, unknown>): Partial<WorkspaceDiffQueryOptions> {
  const view = params.view === "head" ? "head" : "working-tree";
  const baseRef = readString(params.baseRef) || null;
  const includeUntracked = typeof params.includeUntracked === "boolean"
    ? params.includeUntracked
    : true;
  return {
    view,
    baseRef,
    includeUntracked,
    paths: readPaths(params.paths),
  };
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} plugin setup`);

    ctx.data.register("workspace-diff", async (params: Record<string, unknown>) => {
      const workspaceId = readString(params.workspaceId);
      const companyId = readString(params.companyId);
      if (!workspaceId || !companyId) {
        throw new Error("workspaceId and companyId are required");
      }

      return ctx.executionWorkspaces.getDiff(
        workspaceId,
        companyId,
        readDiffOptions(params),
      );
    });
  },

  async onHealth() {
    return { status: "ok", message: `${PLUGIN_NAME} ready` };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
