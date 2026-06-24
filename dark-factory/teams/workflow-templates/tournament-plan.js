export const meta = {
  name: 'tournament_plan',
  description: 'Generate competing plans and choose a winner by explicit criteria',
  phases: [
    { title: 'Contenders' },
    { title: 'Judge' },
  ],
}

const brief = args && args.brief ? String(args.brief) : ''
const criteria = args && args.criteria ? String(args.criteria) : 'correctness, maintainability, safety, testability, and Samuel dev-policy alignment'
const contenders = args && args.contenders ? args.contenders : ['simple', 'robust', 'minimal-risk']

phase('Contenders')
const plans = await parallel(
  contenders.map((contender) => () =>
    agent(
      'Create a ' +
        String(contender) +
        ' plan for this task. Include implementation steps, tests, browser/business-flow evidence, risks, and when to stop and ask Samuel.\n\nBrief:\n' +
        brief +
        '\n\nJudging criteria:\n' +
        criteria,
      {
        label: String(contender) + ' plan',
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            steps: { type: 'array', items: { type: 'string' } },
            tests: { type: 'array', items: { type: 'string' } },
            evidence: { type: 'array', items: { type: 'string' } },
            risks: { type: 'array', items: { type: 'string' } },
          },
          required: ['name', 'steps', 'tests', 'evidence', 'risks'],
        },
      },
    ),
  ),
)

phase('Judge')
const winner = await agent(
  'Judge these plans. Pick one winner or create a hybrid. Explain the decision using the criteria. Return the selected plan and rejected tradeoffs.\n\nCriteria:\n' +
    criteria +
    '\n\nPlans:\n' +
    JSON.stringify(plans),
  {
    label: 'plan judge',
    schema: {
      type: 'object',
      properties: {
        winner: { type: 'string' },
        finalPlan: { type: 'array', items: { type: 'string' } },
        rejectedTradeoffs: { type: 'array', items: { type: 'string' } },
        requiredGates: { type: 'array', items: { type: 'string' } },
      },
      required: ['winner', 'finalPlan', 'rejectedTradeoffs', 'requiredGates'],
    },
  },
)

return { plans, winner }
