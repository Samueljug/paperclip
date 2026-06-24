// Team model templates. Each template maps teams -> a model spec (LLM + model + reasoning).
// Applying a template rewrites every agent in those teams to that LLM's CLI adapter.

import type { Llm, TeamKey } from "./teams.js";

export interface ModelSpec {
  llm: Llm;
  model: string;
  // codex: minimal|low|medium|high|xhigh ; claude: low|medium|high ; gemini: ignored
  reasoning?: string;
}

export interface TeamTemplate {
  key: string;
  label: string;
  description?: string;
  builtin?: boolean;
  // Per-team model. Teams omitted here are left unchanged when the template is applied.
  teams: Partial<Record<TeamKey, ModelSpec>>;
  // Optional per-WORKER overrides, keyed by agent role (metadata.piRole),
  // e.g. "implementation-lead". A worker with an override uses it instead of its
  // team spec. Built-ins leave this empty (uniform per team); editing a worker adds one.
  workers?: Record<string, ModelSpec>;
}

// Convenience: the same spec for every team.
function everyTeam(spec: ModelSpec): Partial<Record<TeamKey, ModelSpec>> {
  return {
    implementation: spec,
    review: spec,
    verification: spec,
    browserQa: spec,
    planning: spec,
    research: spec,
    problemSolving: spec,
    docsRelease: spec,
    selfImprovement: spec,
  };
}

// NOTE: model ids must match what the local CLI account actually has access to.
// This environment: claude-opus-4-8 / claude-sonnet-4-6 / claude-haiku-4-5-20251001,
// codex gpt-5.4 / gpt-5.5 / gpt-5.3-codex-spark. Gemini routes via Pi (pi_local) with
// provider-qualified ids: "google-antigravity/gemini-3.5-flash" (Antigravity / AI Ultra) or
// "google-gemini-cli/<id>" (Code Assist). The pi-gemini-extension makes gemini-3.5-flash work
// (the raw gemini CLI 404s on it).
export const BUILTIN_TEMPLATES: TeamTemplate[] = [
  {
    key: "all-codex",
    label: "All Codex (gpt-5.4 · high)",
    description: "Every team runs on Codex via the codex CLI.",
    builtin: true,
    teams: everyTeam({ llm: "codex", model: "gpt-5.4", reasoning: "high" }),
  },
  {
    key: "all-claude",
    label: "All Claude Code",
    description:
      "Implementation on Opus, everyone else on Sonnet — all via the claude CLI.",
    builtin: true,
    teams: {
      ...everyTeam({
        llm: "claude",
        model: "claude-sonnet-4-6",
        reasoning: "high",
      }),
      implementation: {
        llm: "claude",
        model: "claude-opus-4-8",
        reasoning: "high",
      },
      review: { llm: "claude", model: "claude-opus-4-8", reasoning: "high" },
    },
  },
  {
    key: "all-gemini",
    label: "All Gemini (3.5 Flash)",
    description: "Every team runs on Gemini 3.5 Flash via Pi (Antigravity backend).",
    builtin: true,
    teams: everyTeam({ llm: "gemini", model: "google-antigravity/gemini-3.5-flash" }),
  },
  {
    key: "claude-impl-codex-review",
    label: "Claude implementation · Codex review",
    description:
      "Implementation team on Claude Opus; Review/Security team on Codex; others on Sonnet.",
    builtin: true,
    teams: {
      ...everyTeam({
        llm: "claude",
        model: "claude-sonnet-4-6",
        reasoning: "medium",
      }),
      implementation: {
        llm: "claude",
        model: "claude-opus-4-8",
        reasoning: "high",
      },
      review: { llm: "codex", model: "gpt-5.4", reasoning: "high" },
    },
  },
  {
    key: "codex-impl-claude-review",
    label: "Codex implementation · Claude review",
    description:
      "Implementation team on Codex; Review/Security team on Claude Opus; others on Codex.",
    builtin: true,
    teams: {
      ...everyTeam({ llm: "codex", model: "gpt-5.4", reasoning: "medium" }),
      implementation: { llm: "codex", model: "gpt-5.4", reasoning: "high" },
      review: { llm: "claude", model: "claude-opus-4-8", reasoning: "high" },
    },
  },
];
