export const meta = {
  name: 'fanout_review',
  description: 'Run parallel specialist review and synthesize the result',
  phases: [
    { title: 'Specialist Review' },
    { title: 'Synthesis' },
  ],
}

const brief = args && args.brief ? String(args.brief) : ''
const paths = args && args.paths ? JSON.stringify(args.paths) : ''
const roles = args && args.roles ? args.roles : ['planning', 'implementation', 'verification', 'security']

phase('Specialist Review')
const reviews = await parallel(
  roles.map((role) => () =>
    agent(
      'You are the ' +
        String(role) +
        ' reviewer. Inspect the task from your perspective. Return findings, risks, missing evidence, and recommended next actions. Keep it concrete and cite files or commands when available.\n\nBrief:\n' +
        brief +
        '\n\nRelevant paths:\n' +
        paths,
      {
        label: String(role) + ' review',
        schema: {
          type: 'object',
          properties: {
            role: { type: 'string' },
            findings: { type: 'array', items: { type: 'string' } },
            risks: { type: 'array', items: { type: 'string' } },
            nextActions: { type: 'array', items: { type: 'string' } },
            confidence: { type: 'string' },
          },
          required: ['role', 'findings', 'risks', 'nextActions', 'confidence'],
        },
      },
    ),
  ),
)

phase('Synthesis')
const synthesis = await agent(
  'Synthesize these specialist reviews into one action plan. Resolve conflicts with evidence. Return blockers, required gates, and the recommended owner for each action.\n\nReviews:\n' +
    JSON.stringify(reviews),
  {
    label: 'review synthesis',
    schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string' },
        blockers: { type: 'array', items: { type: 'string' } },
        actions: { type: 'array', items: { type: 'string' } },
        requiredGates: { type: 'array', items: { type: 'string' } },
      },
      required: ['verdict', 'blockers', 'actions', 'requiredGates'],
    },
  },
)

return { reviews, synthesis }
