// Team definitions + the LLM -> CLI adapter mapping.
// Every model call routes through the named LLM's local CLI adapter:
//   codex  -> codex_local  (codex CLI)
//   claude -> claude_local (claude CLI)
//   gemini -> gemini_local (gemini CLI)

export type Llm = "codex" | "claude" | "gemini";

export const LLM_ADAPTER: Record<
  Llm,
  {
    adapterType: string;
    command: string;
    reasoningField: string | null;
    label: string;
  }
> = {
  codex: {
    adapterType: "codex_local",
    command: "codex",
    reasoningField: "modelReasoningEffort",
    label: "Codex",
  },
  claude: {
    adapterType: "claude_local",
    command: "claude",
    reasoningField: "effort",
    label: "Claude Code",
  },
  gemini: {
    // Gemini routes through Pi (pi_local): the raw `gemini` CLI 404s on gemini-3.5-flash,
    // but `pi` + the pi-gemini-extension serve it via the Antigravity / Code Assist providers.
    // Model ids are stored provider-qualified (e.g. "google-antigravity/gemini-3.5-flash");
    // pi_local splits "provider/model" into `--provider <p> --model <m>`.
    adapterType: "pi_local",
    command: "pi",
    reasoningField: "thinking",
    label: "Gemini (via Pi)",
  },
};

export type TeamKey =
  | "implementation"
  | "review"
  | "verification"
  | "browserQa"
  | "planning"
  | "research"
  | "problemSolving"
  | "docsRelease"
  | "selfImprovement";

// A team = a lead + its members, identified by the agents' metadata.piRole.
export const TEAMS: Record<TeamKey, { label: string; roles: string[] }> = {
  implementation: {
    label: "Implementation",
    roles: [
      "implementation-lead",
      "backend-implementer",
      "frontend-implementer",
    ],
  },
  review: {
    label: "Review / Security",
    roles: [
      "security-lead",
      "security-reviewer",
      "dependency-auditor",
      "tenant-isolation-reviewer",
      "data-sovereignty-reviewer",
      "authz-reviewer",
      "data-exposure-reviewer",
      "injection-reviewer",
    ],
  },
  verification: {
    label: "Verification",
    roles: ["verification-lead", "test-engineer"],
  },
  browserQa: {
    label: "Browser QA",
    roles: ["browser-qa-lead", "browser-tester", "visual-qa"],
  },
  planning: {
    label: "Planning",
    roles: ["planning-lead", "product-planner", "architecture-planner"],
  },
  research: {
    label: "Research",
    roles: [
      "research-lead",
      "research-source-cartographer",
      "research-customer-revenue",
      "research-technical-prober",
      "research-risk-compliance",
      "research-skeptic-red-team",
      "research-synthesis-editor",
    ],
  },
  problemSolving: {
    label: "Problem Solving",
    roles: [
      "problem-solving-lead",
      "problem-root-cause-solver",
      "problem-implementation-solver",
      "problem-test-repro-solver",
      "problem-risk-skeptic",
      "problem-synthesis-judge",
    ],
  },
  docsRelease: { label: "Docs & Release", roles: ["docs-release-lead"] },
  selfImprovement: {
    label: "Self-Improvement",
    roles: ["self-improvement-lead", "memory-librarian"],
  },
};

export const TEAM_KEYS = Object.keys(TEAMS) as TeamKey[];

const ROLE_TO_TEAM: Record<string, TeamKey> = {};
for (const key of TEAM_KEYS)
  for (const role of TEAMS[key].roles) ROLE_TO_TEAM[role] = key;

// Resolve which team an agent belongs to from its metadata.piRole.
export function teamOfAgent(agent: {
  metadata?: Record<string, unknown> | null;
}): TeamKey | null {
  const role = agent?.metadata?.piRole;
  if (typeof role !== "string") return null;
  return ROLE_TO_TEAM[role] ?? null;
}
