import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import {
  applyTemplate,
  getTeamState,
  listTeamMembers,
  setAgentModel,
  writeThrottleConfig,
  readThrottleConfig,
  DEFAULT_MAX_CONCURRENT,
} from "./apply.js";
import { BUILTIN_TEMPLATES, type TeamTemplate } from "./templates.js";

// Params may arrive top-level or nested under `params` depending on the host
// bridge (data vs action calls differ); read defensively.
function arg<T = unknown>(params: unknown, key: string): T | undefined {
  const p = (params ?? {}) as Record<string, unknown>;
  if (p[key] !== undefined) return p[key] as T;
  const nested = p.params as Record<string, unknown> | undefined;
  return nested?.[key] as T | undefined;
}
function companyIdOf(params: unknown): string {
  const c = arg<string>(params, "companyId");
  if (typeof c !== "string" || !c) throw new Error("companyId is required");
  return c;
}

const SCOPE = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId });

async function loadSaved(ctx: any, companyId: string): Promise<TeamTemplate[]> {
  const raw = await ctx.state.get({ ...SCOPE(companyId), stateKey: "savedTemplates" });
  return Array.isArray(raw) ? (raw as TeamTemplate[]) : [];
}
async function storeSaved(ctx: any, companyId: string, list: TeamTemplate[]): Promise<void> {
  await ctx.state.set({ ...SCOPE(companyId), stateKey: "savedTemplates" }, list);
}
async function loadHidden(ctx: any, companyId: string): Promise<string[]> {
  const raw = await ctx.state.get({ ...SCOPE(companyId), stateKey: "hiddenBuiltins" });
  return Array.isArray(raw) ? (raw as string[]) : [];
}
async function storeHidden(ctx: any, companyId: string, list: string[]): Promise<void> {
  await ctx.state.set({ ...SCOPE(companyId), stateKey: "hiddenBuiltins" }, list);
}
async function allTemplates(ctx: any, companyId: string): Promise<TeamTemplate[]> {
  const saved = await loadSaved(ctx, companyId);
  const savedKeys = new Set(saved.map((t) => t.key));
  const hidden = new Set(await loadHidden(ctx, companyId));
  return [
    ...BUILTIN_TEMPLATES.filter((t) => !savedKeys.has(t.key) && !hidden.has(t.key)),
    ...saved.filter((t) => !hidden.has(t.key)),
  ];
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register("state", async (params) => {
      const companyId = companyIdOf(params);
      const [teams, templates] = await Promise.all([getTeamState(companyId), allTemplates(ctx, companyId)]);
      const active = (await ctx.state.get({ ...SCOPE(companyId), stateKey: "activeTemplate" })) as string | null;
      const capRaw = (await ctx.state.get({ ...SCOPE(companyId), stateKey: "maxConcurrent" })) as number | null;
      const throttle =
        typeof capRaw === "number" && capRaw >= 1 ? capRaw : readThrottleConfig();
      return { teams, templates, activeTemplate: active ?? null, throttle };
    });

    ctx.data.register("active", async (params) => {
      const companyId = companyIdOf(params);
      const active = (await ctx.state.get({ ...SCOPE(companyId), stateKey: "activeTemplate" })) as string | null;
      const templates = await allTemplates(ctx, companyId);
      const t = templates.find((x) => x.key === active) ?? null;
      return {
        activeTemplate: active ?? null,
        label: t?.label ?? null,
        templates: templates.map((x) => ({ key: x.key, label: x.label })),
      };
    });

    // Per-agent ("individual team member") view: every team member + their current model.
    ctx.data.register("teams", async (params) => {
      const companyId = companyIdOf(params);
      return { teams: await listTeamMembers(companyId) };
    });

    // Apply a team template (rewrites team agents' model/CLI). OpenClaw can call this too.
    ctx.actions.register("apply", async (params) => {
      const companyId = companyIdOf(params);
      const key = arg<string>(params, "templateKey");
      if (!key) throw new Error("templateKey is required");
      const templates = await allTemplates(ctx, companyId);
      const template = templates.find((t) => t.key === key);
      if (!template) throw new Error(`template "${key}" not found`);
      const result = await applyTemplate(companyId, template);
      await ctx.state.set({ ...SCOPE(companyId), stateKey: "activeTemplate" }, key);
      const capRaw = (await ctx.state.get({ ...SCOPE(companyId), stateKey: "maxConcurrent" })) as number | null;
      writeThrottleConfig(
        typeof capRaw === "number" && capRaw >= 1 ? capRaw : DEFAULT_MAX_CONCURRENT,
      );
      ctx.logger.info("Applied team template", { key, patched: result.patched, errors: result.errors.length });
      return result;
    });

    // Set the global Pi concurrency cap (machine-wide max real `pi` processes, FIFO queue).
    ctx.actions.register("set-throttle", async (params) => {
      const companyId = companyIdOf(params);
      const raw = arg<number>(params, "maxConcurrent");
      const n = Math.max(1, Math.floor(Number(raw)));
      if (!Number.isFinite(n)) throw new Error("maxConcurrent must be a positive integer");
      const v = writeThrottleConfig(n);
      await ctx.state.set({ ...SCOPE(companyId), stateKey: "maxConcurrent" }, v);
      ctx.logger.info("Set Pi concurrency cap", { maxConcurrent: v });
      return { maxConcurrent: v };
    });

    ctx.actions.register("save-template", async (params) => {
      const companyId = companyIdOf(params);
      const template = arg<TeamTemplate>(params, "template");
      if (!template || !template.key || !template.teams) throw new Error("template {key, label, teams} is required");
      const saved = await loadSaved(ctx, companyId);
      const next = saved.filter((t) => t.key !== template.key);
      next.push({ ...template, builtin: false });
      await storeSaved(ctx, companyId, next);
      // Saving (re-creating) a template un-hides it if it was a deleted built-in.
      const hidden = await loadHidden(ctx, companyId);
      if (hidden.includes(template.key)) {
        await storeHidden(ctx, companyId, hidden.filter((k) => k !== template.key));
      }
      return { saved: template.key, total: next.length };
    });

    ctx.actions.register("delete-template", async (params) => {
      const companyId = companyIdOf(params);
      const key = arg<string>(params, "templateKey");
      if (!key) throw new Error("templateKey is required");
      const saved = await loadSaved(ctx, companyId);
      await storeSaved(ctx, companyId, saved.filter((t) => t.key !== key));
      // Built-ins live in code; "deleting" one suppresses it for this company.
      if (BUILTIN_TEMPLATES.some((t) => t.key === key)) {
        const hidden = await loadHidden(ctx, companyId);
        if (!hidden.includes(key)) await storeHidden(ctx, companyId, [...hidden, key]);
      }
      // If the deleted template was active, clear the active pointer.
      const active = (await ctx.state.get({ ...SCOPE(companyId), stateKey: "activeTemplate" })) as string | null;
      if (active === key) {
        await ctx.state.set({ ...SCOPE(companyId), stateKey: "activeTemplate" }, null);
      }
      return { deleted: key };
    });

    // Restore all built-in templates for a company (clears the deleted-built-in suppression).
    ctx.actions.register("restore-builtins", async (params) => {
      const companyId = companyIdOf(params);
      await storeHidden(ctx, companyId, []);
      return { ok: true, restored: BUILTIN_TEMPLATES.map((t) => t.key) };
    });

    // Set a single team member's model (LLM + model + reasoning), preserving its role prompt.
    ctx.actions.register("set-agent-model", async (params) => {
      const companyId = companyIdOf(params);
      const agentId = arg<string>(params, "agentId");
      const llm = arg<"codex" | "claude" | "gemini">(params, "llm");
      const model = arg<string>(params, "model");
      const reasoning = arg<string>(params, "reasoning");
      if (!agentId) throw new Error("agentId is required");
      if (!llm) throw new Error("llm is required");
      if (!model) throw new Error("model is required");
      const result = await setAgentModel(companyId, agentId, llm, model, reasoning);
      ctx.logger.info("Set agent model", {
        agentId,
        llm,
        model,
        adapterType: result.agent.adapterType,
      });
      return result;
    });
  },

  async onHealth() {
    return { status: "ok", message: "Team Model Templates worker running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
