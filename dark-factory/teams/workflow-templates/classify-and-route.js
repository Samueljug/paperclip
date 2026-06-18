export const meta = {
  name: 'classify_and_route',
  description: 'Classify an intake brief into repo routing, risk, and required gates',
  phases: [
    { title: 'Classify' },
    { title: 'Synthesize' },
  ],
}

const brief = args && args.brief ? String(args.brief) : ''
const knownRoutes = args && args.knownRoutes ? JSON.stringify(args.knownRoutes) : ''

phase('Classify')
const classification = await agent(
  'Classify this coding request. Return the target product, repo, branch, local work area, risk level, missing questions, and required verification gates. If anything is unclear, say what must be asked before coding.\n\nBrief:\n' +
    brief +
    '\n\nKnown route table:\n' +
    knownRoutes,
  {
    label: 'route classifier',
    schema: {
      type: 'object',
      properties: {
        canProceed: { type: 'boolean' },
        product: { type: 'string' },
        repo: { type: 'string' },
        branch: { type: 'string' },
        workArea: { type: 'string' },
        risk: { type: 'string' },
        requiredGates: { type: 'array', items: { type: 'string' } },
        questions: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string' },
      },
      required: ['canProceed', 'product', 'repo', 'branch', 'workArea', 'risk', 'requiredGates', 'questions', 'reason'],
    },
  },
)

phase('Synthesize')
const decision = await agent(
  'Review this classification for mistakes against Samuel routing rules. Return a concise decision and any correction needed.\n\nClassification:\n' +
    JSON.stringify(classification),
  {
    label: 'route judge',
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        decision: { type: 'string' },
        correction: { type: 'string' },
      },
      required: ['ok', 'decision', 'correction'],
    },
  },
)

return { classification, decision }
