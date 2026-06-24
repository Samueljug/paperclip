export const meta = {
  name: 'deep_research_architecture',
  description: 'Turn a large idea and source notes into an adversarial architecture decision',
  phases: [
    { title: 'Research Plan' },
    { title: 'Source Review' },
    { title: 'Architecture Council' },
    { title: 'Algorithm Pass' },
    { title: 'Decision' },
  ],
}

const brief = args && args.brief ? String(args.brief) : ''
const constraints = args && args.constraints ? String(args.constraints) : ''
const sourceNotes = args && args.sourceNotes ? JSON.stringify(args.sourceNotes) : ''
const criteria =
  args && args.criteria
    ? String(args.criteria)
    : 'correctness, simplicity, maintainability, security, cost, testability, cycle time, Samuel dev-policy alignment'

phase('Research Plan')
const researchPlan = await agent(
  'Create a bounded research plan for this large idea. Include exact source adapters to call: firecrawl/docs crawl, google/web search, X/Grok or xurl, Gemini CLI, Claude Code, Codex 5.5 extra-high, direct API probes, and repo inspection. Mark which adapters are required versus optional. Return queries/prompts and what evidence each source should prove or disprove.\n\nBrief:\n' +
    brief +
    '\n\nConstraints:\n' +
    constraints,
  {
    label: 'research plan',
    schema: {
      type: 'object',
      properties: {
        adapters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              adapter: { type: 'string' },
              required: { type: 'boolean' },
              queryOrPrompt: { type: 'string' },
              evidenceTarget: { type: 'string' },
            },
            required: ['adapter', 'required', 'queryOrPrompt', 'evidenceTarget'],
          },
        },
        risks: { type: 'array', items: { type: 'string' } },
        stopConditions: { type: 'array', items: { type: 'string' } },
      },
      required: ['adapters', 'risks', 'stopConditions'],
    },
  },
)

phase('Source Review')
const sourceRoles = [
  'source-quality reviewer',
  'product-market reviewer',
  'technical-docs reviewer',
  'repo-and-api reviewer',
]

const sourceReviews = await parallel(
  sourceRoles.map((role) => () =>
    agent(
      'You are the ' +
        role +
        '. Review the provided source notes and research plan. Separate verified facts, weak claims, contradictions, missing source calls, contaminated context, and questions that must be answered before architecture is accepted. If source notes are empty, focus on the missing external calls and do not invent facts.\n\nBrief:\n' +
        brief +
        '\n\nResearch plan:\n' +
        JSON.stringify(researchPlan) +
        '\n\nSource notes:\n' +
        sourceNotes,
      {
        label: role,
        schema: {
          type: 'object',
          properties: {
            role: { type: 'string' },
            verifiedFacts: { type: 'array', items: { type: 'string' } },
            weakClaims: { type: 'array', items: { type: 'string' } },
            contradictions: { type: 'array', items: { type: 'string' } },
            missingEvidence: { type: 'array', items: { type: 'string' } },
            architectureInputs: { type: 'array', items: { type: 'string' } },
          },
          required: ['role', 'verifiedFacts', 'weakClaims', 'contradictions', 'missingEvidence', 'architectureInputs'],
        },
      },
    ),
  ),
)

phase('Architecture Council')
const architectRoles = args && args.architects ? args.architects : ['claude-code architect', 'codex-5.5-xhigh architect', 'skeptic verifier']

const proposals = await parallel(
  architectRoles.map((role) => () =>
    agent(
      'You are the ' +
        String(role) +
        '. Produce or critique the architecture for this large idea. Do not agree for politeness. Question assumptions, delete unnecessary scope, identify failure modes, and make the plan testable. Use the research reviews; do not invent external facts.\n\nBrief:\n' +
        brief +
        '\n\nConstraints:\n' +
        constraints +
        '\n\nCriteria:\n' +
        criteria +
        '\n\nResearch reviews:\n' +
        JSON.stringify(sourceReviews),
      {
        label: String(role),
        schema: {
          type: 'object',
          properties: {
            role: { type: 'string' },
            proposal: { type: 'array', items: { type: 'string' } },
            deletedScope: { type: 'array', items: { type: 'string' } },
            objections: { type: 'array', items: { type: 'string' } },
            risks: { type: 'array', items: { type: 'string' } },
            testsAndEvidence: { type: 'array', items: { type: 'string' } },
          },
          required: ['role', 'proposal', 'deletedScope', 'objections', 'risks', 'testsAndEvidence'],
        },
      },
    ),
  ),
)

phase('Algorithm Pass')
const algorithmPass = await agent(
  'Apply the five-step algorithm in order to the architecture proposals: question every requirement, delete, simplify/optimize, accelerate cycle time, automate last. If nothing is deleted, say the deletion pass failed. Return concrete edits to the architecture.\n\nBrief:\n' +
    brief +
    '\n\nResearch reviews:\n' +
    JSON.stringify(sourceReviews) +
    '\n\nArchitecture proposals:\n' +
    JSON.stringify(proposals),
  {
    label: 'musk algorithm pass',
    schema: {
      type: 'object',
      properties: {
        questionedRequirements: { type: 'array', items: { type: 'string' } },
        deleted: { type: 'array', items: { type: 'string' } },
        simplified: { type: 'array', items: { type: 'string' } },
        cycleTimeImprovements: { type: 'array', items: { type: 'string' } },
        automationCandidates: { type: 'array', items: { type: 'string' } },
        deferredAutomation: { type: 'array', items: { type: 'string' } },
      },
      required: [
        'questionedRequirements',
        'deleted',
        'simplified',
        'cycleTimeImprovements',
        'automationCandidates',
        'deferredAutomation',
      ],
    },
  },
)

phase('Decision')
const decision = await agent(
  'Synthesize the research reviews, architecture council, and algorithm pass into one architecture decision. Include accepted architecture, rejected alternatives, assumptions, blockers, implementation sequence, test/evidence gates, and stop conditions. Resolve disagreements with evidence; mark unresolved questions honestly.\n\nCriteria:\n' +
    criteria +
    '\n\nResearch plan:\n' +
    JSON.stringify(researchPlan) +
    '\n\nSource reviews:\n' +
    JSON.stringify(sourceReviews) +
    '\n\nProposals:\n' +
    JSON.stringify(proposals) +
    '\n\nAlgorithm pass:\n' +
    JSON.stringify(algorithmPass),
  {
    label: 'architecture decision',
    schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string' },
        acceptedArchitecture: { type: 'array', items: { type: 'string' } },
        rejectedAlternatives: { type: 'array', items: { type: 'string' } },
        assumptions: { type: 'array', items: { type: 'string' } },
        blockers: { type: 'array', items: { type: 'string' } },
        implementationSequence: { type: 'array', items: { type: 'string' } },
        requiredGates: { type: 'array', items: { type: 'string' } },
        stopConditions: { type: 'array', items: { type: 'string' } },
      },
      required: [
        'verdict',
        'acceptedArchitecture',
        'rejectedAlternatives',
        'assumptions',
        'blockers',
        'implementationSequence',
        'requiredGates',
        'stopConditions',
      ],
    },
  },
)

return { researchPlan, sourceReviews, proposals, algorithmPass, decision }
