import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { routeLead, shouldAssign } from "./routing.js";

type AnyCtx = any;

// Assign an unassigned To-Do card to the right manager lead. Assigning fires
// Paperclip's native on-demand wakeup, so the lead starts working it immediately.
async function handle(ctx: AnyCtx, event: any): Promise<void> {
  try {
    const companyId: string | undefined = event?.companyId;
    const issueId: string | undefined =
      (event?.entityType === "issue" ? event?.entityId : undefined) ||
      event?.payload?.issueId ||
      event?.entityId;
    if (!companyId || !issueId) return;

    const issue = await ctx.issues.get(issueId, companyId).catch(() => null);
    if (!shouldAssign(issue)) return;

    const { agentId, label } = routeLead(issue.title, issue.description);
    await ctx.issues.update(issueId, { assigneeAgentId: agentId }, companyId);
    ctx.logger.info(
      `To-Do Auto-Assign: ${issue.identifier || issueId} -> ${label}`,
      { issueId, lead: label },
    );
  } catch (e) {
    ctx.logger.error("To-Do Auto-Assign handler error", { err: String(e) });
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    // Fires the instant a card is created in, or dragged into, To Do.
    ctx.events.on("issue.created", (event) => handle(ctx, event));
    ctx.events.on("issue.updated", (event) => handle(ctx, event));
  },

  async onHealth() {
    return { status: "ok", message: "To-Do Auto-Assign worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
