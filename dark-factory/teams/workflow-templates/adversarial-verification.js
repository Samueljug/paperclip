export const meta = {
  name: 'adversarial_verification',
  description: 'Challenge claimed readiness with independent verifier, adversary, and judge',
  phases: [
    { title: 'Independent Checks' },
    { title: 'Judge' },
  ],
}

const brief = args && args.brief ? String(args.brief) : ''
const evidence = args && args.evidence ? JSON.stringify(args.evidence) : ''
const acceptance = args && args.acceptance ? JSON.stringify(args.acceptance) : ''

phase('Independent Checks')
const checks = await parallel([
  () =>
    agent(
      'Verify the claimed implementation against the original brief and acceptance criteria. Identify missing evidence and any tests that should be rerun.\n\nBrief:\n' +
        brief +
        '\n\nAcceptance:\n' +
        acceptance +
        '\n\nEvidence:\n' +
        evidence,
      {
        label: 'friendly verifier',
        schema: {
          type: 'object',
          properties: {
            passed: { type: 'boolean' },
            gaps: { type: 'array', items: { type: 'string' } },
            rerun: { type: 'array', items: { type: 'string' } },
          },
          required: ['passed', 'gaps', 'rerun'],
        },
      },
    ),
  () =>
    agent(
      'Act as an adversarial reviewer. Try to prove the work is not production-ready. Look for missing business-flow validation, weak screenshots, skipped tests, security holes, and policy violations.\n\nBrief:\n' +
        brief +
        '\n\nAcceptance:\n' +
        acceptance +
        '\n\nEvidence:\n' +
        evidence,
      {
        label: 'adversary',
        schema: {
          type: 'object',
          properties: {
            materialIssues: { type: 'array', items: { type: 'string' } },
            possibleIssues: { type: 'array', items: { type: 'string' } },
            strongestObjection: { type: 'string' },
          },
          required: ['materialIssues', 'possibleIssues', 'strongestObjection'],
        },
      },
    ),
])

phase('Judge')
const judge = await agent(
  'You are the judge. Decide whether the work can proceed, needs fixes, or needs Samuel. Base the decision only on the brief, acceptance criteria, evidence, verifier result, and adversary result.\n\nChecks:\n' +
    JSON.stringify(checks),
  {
    label: 'readiness judge',
    schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string' },
        requiredFixes: { type: 'array', items: { type: 'string' } },
        requiredEvidence: { type: 'array', items: { type: 'string' } },
        askSamuel: { type: 'array', items: { type: 'string' } },
      },
      required: ['verdict', 'requiredFixes', 'requiredEvidence', 'askSamuel'],
    },
  },
)

return { checks, judge }
