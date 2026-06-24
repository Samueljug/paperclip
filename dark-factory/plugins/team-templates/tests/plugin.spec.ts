import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { teamOfAgent } from "../src/teams.js";
import { buildAdapterConfig } from "../src/apply.js";
import { BUILTIN_TEMPLATES } from "../src/templates.js";

describe("team-model-templates", () => {
  it("declares the right capabilities + slots", () => {
    expect(manifest.capabilities).toContain("plugin.state.read");
    expect(manifest.capabilities).toContain("plugin.state.write");
    expect(manifest.capabilities).toContain("ui.page.register");
    const slotTypes = (manifest.ui?.slots ?? []).map((s: any) => s.type);
    expect(slotTypes).toContain("page");
    expect(slotTypes).toContain("dashboardWidget");
  });

  it("maps agents to teams by piRole", () => {
    expect(teamOfAgent({ metadata: { piRole: "backend-implementer" } })).toBe("implementation");
    expect(teamOfAgent({ metadata: { piRole: "security-reviewer" } })).toBe("review");
    expect(teamOfAgent({ metadata: { piRole: "test-engineer" } })).toBe("verification");
    expect(teamOfAgent({ metadata: { piRole: "not-a-role" } })).toBeNull();
    expect(teamOfAgent({ metadata: {} })).toBeNull();
  });

  it("routes each LLM through its CLI adapter with the right reasoning field", () => {
    const codex = buildAdapterConfig({ llm: "codex", model: "gpt-5.4", reasoning: "high" });
    expect(codex.command).toBe("codex");
    expect(codex.model).toBe("gpt-5.4");
    expect(codex.modelReasoningEffort).toBe("high");

    const claude = buildAdapterConfig({ llm: "claude", model: "claude-opus-4-8", reasoning: "high" });
    expect(claude.command).toBe("claude");
    expect(claude.effort).toBe("high");

    const gemini = buildAdapterConfig({ llm: "gemini", model: "gemini-2.5-pro" });
    expect(gemini.command).toBe("gemini");
    expect(gemini.modelReasoningEffort).toBeUndefined();
  });

  it("ships built-in team templates", () => {
    const keys = BUILTIN_TEMPLATES.map((t) => t.key);
    expect(keys).toContain("all-codex");
    expect(keys).toContain("all-claude");
    expect(keys).toContain("claude-impl-codex-review");
    // a mixed template assigns different LLMs to different teams
    const mixed = BUILTIN_TEMPLATES.find((t) => t.key === "claude-impl-codex-review")!;
    expect(mixed.teams.implementation?.llm).toBe("claude");
    expect(mixed.teams.review?.llm).toBe("codex");
  });

  it("saves and lists custom templates via plugin state (no live API)", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
    await plugin.definition.setup(harness.ctx);
    const tmpl = { key: "my-mix", label: "My Mix", teams: { implementation: { llm: "claude", model: "claude-opus-4-8", reasoning: "high" } } };
    const res = await harness.performAction<{ saved: string }>("save-template", { companyId: "c1", template: tmpl });
    expect(res.saved).toBe("my-mix");
    const saved = harness.getState({ scopeKind: "company", scopeId: "c1", stateKey: "savedTemplates" });
    expect(Array.isArray(saved)).toBe(true);
    expect((saved as any[])[0].key).toBe("my-mix");
  });
});
