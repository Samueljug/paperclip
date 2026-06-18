// Pure routing: map a To-Do card to the manager lead that should own it.
// Lead ids are the dark-factory company's *-lead agents (now Claude/Paperclip agents).

export const PROJECT_ID = "c4525f28-55d1-4378-864c-aec26d51fc37";

export const LEADS = {
  planning: "c5d27df5-9708-4864-bbce-dd767be2790f", // planning-lead (default / decompose)
  implementation: "bc23520c-4774-4257-a667-8687bc539b72",
  docs: "1476459f-6217-45bb-9399-89bc585ad904", // docs-release-lead
  security: "19dd3bb9-15d8-4ecb-81de-cb8f3ffbbb21",
  verification: "055e7f14-e5c2-4086-a256-1d6e37b3c35c",
  browserQa: "8b2249ab-3d67-4572-8e6e-0401faee096e",
  research: "e4db3ff9-cc2c-4ae5-8533-f2a55a32c8ee",
} as const;

// Ordered keyword rules. First match wins; default = planning-lead (it decomposes/routes).
const RULES: Array<{ re: RegExp; lead: keyof typeof LEADS; label: string }> = [
  {
    re: /\b(security|privacy|authz|authn|auth|vuln|cve|tenant|isolation|sovereignty|secret|injection|xss|csrf)\b/i,
    lead: "security",
    label: "security-lead",
  },
  {
    re: /\b(docs?|wiki|readme|documentation|changelog|release notes?|guide)\b/i,
    lead: "docs",
    label: "docs-release-lead",
  },
  {
    re: /\b(browser|ui|ux|visual|css|layout|responsive|screenshot|frontend page|button|modal|page renders?)\b/i,
    lead: "browserQa",
    label: "browser-qa-lead",
  },
  {
    re: /\b(test|tests|verify|verification|regression|coverage|qa|acceptance criteria|repro)\b/i,
    lead: "verification",
    label: "verification-lead",
  },
  {
    re: /\b(research|investigate|investigation|spike|explore|compare options|feasibility)\b/i,
    lead: "research",
    label: "research-lead",
  },
  {
    re: /\b(backend|frontend|api|endpoint|code|bug|bugfix|fix|implement|refactor|migration|schema|build|feature|drift)\b/i,
    lead: "implementation",
    label: "implementation-lead",
  },
];

export function routeLead(
  title: string | null | undefined,
  description: string | null | undefined,
): { agentId: string; label: string } {
  const text = `${title || ""}\n${description || ""}`;
  for (const r of RULES) {
    if (r.re.test(text)) return { agentId: LEADS[r.lead], label: r.label };
  }
  return { agentId: LEADS.planning, label: "planning-lead (default)" };
}

// Decide whether this issue is an auto-assign candidate.
export function shouldAssign(
  issue: {
    projectId?: string | null;
    status?: string | null;
    assigneeAgentId?: string | null;
  } | null,
): boolean {
  if (!issue) return false;
  if (issue.projectId !== PROJECT_ID) return false;
  if (issue.status !== "todo") return false;
  if (issue.assigneeAgentId) return false;
  return true;
}
