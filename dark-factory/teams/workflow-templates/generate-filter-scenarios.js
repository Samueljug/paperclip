export const meta = {
  name: 'generate_filter_scenarios',
  description: 'Generate candidate business-flow scenarios and filter to the highest-value set',
  phases: [
    { title: 'Generate' },
    { title: 'Filter' },
  ],
}

const brief = args && args.brief ? String(args.brief) : ''
const productContext = args && args.productContext ? String(args.productContext) : ''
const count = args && args.count ? Number(args.count) : 8

phase('Generate')
const candidates = await parallel([
  () =>
    agent(
      'Generate frontend business-flow scenarios that validate user value, not just code logic. Include positive, negative, edge, and regression flows.\n\nBrief:\n' +
        brief +
        '\n\nProduct context:\n' +
        productContext,
      {
        label: 'business flows',
        schema: {
          type: 'object',
          properties: {
            scenarios: { type: 'array', items: { type: 'string' } },
          },
          required: ['scenarios'],
        },
      },
    ),
  () =>
    agent(
      'Generate UI/browser test scenarios that should produce screenshot or video evidence. Include responsive, error, loading, and form-state coverage where relevant.\n\nBrief:\n' +
        brief +
        '\n\nProduct context:\n' +
        productContext,
      {
        label: 'browser evidence',
        schema: {
          type: 'object',
          properties: {
            scenarios: { type: 'array', items: { type: 'string' } },
          },
          required: ['scenarios'],
        },
      },
    ),
  () =>
    agent(
      'Generate backend/data/business-rule scenarios that could break even if the UI looks correct. Include permissions, validation, persistence, and integration concerns.\n\nBrief:\n' +
        brief +
        '\n\nProduct context:\n' +
        productContext,
      {
        label: 'logic scenarios',
        schema: {
          type: 'object',
          properties: {
            scenarios: { type: 'array', items: { type: 'string' } },
          },
          required: ['scenarios'],
        },
      },
    ),
])

phase('Filter')
const selected = await agent(
  'Select the highest-value scenarios for this change. Prefer scenarios that catch real business failures and can produce clear automated evidence. Return at most ' +
    String(count) +
    ' scenarios.\n\nCandidates:\n' +
    JSON.stringify(candidates),
  {
    label: 'scenario filter',
    schema: {
      type: 'object',
      properties: {
        selected: { type: 'array', items: { type: 'string' } },
        rationale: { type: 'string' },
      },
      required: ['selected', 'rationale'],
    },
  },
)

return { candidates, selected }
