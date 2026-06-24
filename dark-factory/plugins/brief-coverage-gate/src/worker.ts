import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { evaluate, resolveIssueId } from "./gate.js";

// Document keys the dark-factory relay writes (see stage-gate-relay-protocol.md).
const MANIFEST_KEY = "brief-artifact-manifest";
const COVERAGE_KEY = "coverage-matrix";
const SENTINEL_TITLE = "Brief Coverage Gate — blocker (do not close)";

// Events that signal a stage may be about to advance.
const TRIGGER_EVENTS = [
  "issue.document.created",
  "issue.document.updated",
  "issue.updated",
  "agent.run.finished",
] as const;

type AnyCtx = any;

const companyScope = (scopeId: string, stateKey: string) => ({
  scopeKind: "company" as const,
  scopeId,
  stateKey,
});
const issueScope = (scopeId: string, stateKey: string) => ({
  scopeKind: "issue" as const,
  scopeId,
  stateKey,
});

async function readConfig(
  ctx: AnyCtx,
): Promise<{ enforce: boolean; comment: boolean }> {
  let cfg: any = {};
  try {
    cfg = (await ctx.config.get()) ?? {};
  } catch {
    /* config not set yet — use safe defaults */
  }
  // Safe default: DRY-RUN (observe only), comments on.
  return { enforce: cfg.enforce === true, comment: cfg.comment !== false };
}

async function ensureSentinel(ctx: AnyCtx, companyId: string): Promise<string> {
  const key = companyScope(companyId, "sentinelIssueId");
  const existingId = await ctx.state.get(key).catch(() => null);
  if (existingId) {
    const stillThere = await ctx.issues
      .get(existingId, companyId)
      .catch(() => null);
    if (stillThere) return existingId;
  }
  const created = await ctx.issues.create({
    companyId,
    title: SENTINEL_TITLE,
    description:
      "Auto-created marker used by the Brief Coverage Gate plugin. It is attached as a blocker to any issue whose brief-artifact-manifest is incomplete or whose coverage-matrix has uncovered/off-track items, and detached automatically once coverage clears. Do not close.",
  });
  await ctx.state.set(key, created.id);
  return created.id;
}

async function bumpCounter(
  ctx: AnyCtx,
  companyId: string,
  kind: "pass" | "block",
): Promise<void> {
  const key = companyScope(companyId, "counters");
  const cur: any = (await ctx.state.get(key).catch(() => null)) ?? {
    pass: 0,
    block: 0,
  };
  cur[kind] = (cur[kind] ?? 0) + 1;
  cur.updatedAt = new Date().toISOString();
  await ctx.state.set(key, cur).catch(() => {});
}

async function handleEvent(ctx: AnyCtx, event: any): Promise<void> {
  try {
    const companyId: string | undefined = event?.companyId;
    if (!companyId) return;
    const issueId = resolveIssueId(event);
    if (!issueId) return;

    // Never gate our own sentinel blocker issue.
    const sentinelId = await ctx.state
      .get(companyScope(companyId, "sentinelIssueId"))
      .catch(() => null);
    if (sentinelId && issueId === sentinelId) return;

    // Only gate issues that went through Planning's manifest step. No manifest
    // document => out of scope for this gate; leave the issue untouched.
    const manifestDoc = await ctx.issues.documents
      .get(issueId, MANIFEST_KEY, companyId)
      .catch(() => null);
    if (!manifestDoc?.body?.trim()) return;

    const coverageDoc = await ctx.issues.documents
      .get(issueId, COVERAGE_KEY, companyId)
      .catch(() => null);

    const { ok, reasons } = evaluate(
      manifestDoc.body,
      coverageDoc?.body ?? null,
    );

    // Only act when the verdict changes (avoid comment spam / blocker churn).
    const sig = JSON.stringify({ ok, reasons });
    const prev = await ctx.state
      .get(issueScope(issueId, "lastVerdict"))
      .catch(() => null);
    if (prev === sig) return;
    await ctx.state
      .set(issueScope(issueId, "lastVerdict"), sig)
      .catch(() => {});

    const cfg = await readConfig(ctx);
    const mode = cfg.enforce ? "ENFORCE" : "DRY-RUN";
    ctx.logger.info(`Brief Coverage Gate [${mode}] ${ok ? "PASS" : "BLOCK"}`, {
      issueId,
      reasons,
    });

    if (cfg.comment) {
      const body = ok
        ? "✅ **Brief Coverage Gate** — coverage clean. The brief-artifact-manifest is complete and every brief item / artifact is covered."
        : `🚧 **Brief Coverage Gate** — ${cfg.enforce ? "BLOCKING this issue" : "(dry-run — not blocking yet)"}\n\nNot ready to advance:\n${reasons
            .map((r) => `- ${r}`)
            .join(
              "\n",
            )}\n\nUpdate the \`brief-artifact-manifest\` / \`coverage-matrix\` documents; the gate clears automatically once these are resolved.`;
      await ctx.issues
        .createComment(issueId, body, companyId)
        .catch((e: unknown) =>
          ctx.logger.warn("Brief Coverage Gate: comment failed", {
            err: String(e),
          }),
        );
    }

    if (cfg.enforce) {
      const sid = await ensureSentinel(ctx, companyId);
      if (!ok) {
        await ctx.issues.relations
          .addBlockers(issueId, [sid], companyId)
          .catch((e: unknown) =>
            ctx.logger.warn("Brief Coverage Gate: addBlockers failed", {
              err: String(e),
            }),
          );
      } else {
        await ctx.issues.relations
          .removeBlockers(issueId, [sid], companyId)
          .catch((e: unknown) =>
            ctx.logger.warn("Brief Coverage Gate: removeBlockers failed", {
              err: String(e),
            }),
          );
      }
    }

    await bumpCounter(ctx, companyId, ok ? "pass" : "block");
  } catch (e) {
    ctx.logger.error("Brief Coverage Gate handler error", { err: String(e) });
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    for (const name of TRIGGER_EVENTS) {
      ctx.events.on(name, (event) => handleEvent(ctx, event));
    }

    // Dashboard widget data: current mode + pass/block counters.
    ctx.data.register("health", async (params: unknown) => {
      const companyId = (params as any)?.companyId;
      const cfg = await readConfig(ctx);
      let counters: any = { pass: 0, block: 0 };
      if (companyId) {
        counters =
          (await ctx.state
            .get(companyScope(companyId, "counters"))
            .catch(() => null)) ?? counters;
      }
      return {
        status: "ok",
        mode: cfg.enforce ? "enforce" : "dry-run",
        pass: counters.pass ?? 0,
        block: counters.block ?? 0,
        checkedAt: new Date().toISOString(),
      };
    });

    ctx.actions.register("ping", async () => ({
      pong: true,
      at: new Date().toISOString(),
    }));
  },

  async onHealth() {
    return { status: "ok", message: "Brief Coverage Gate worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
