# Dynamic Workflow Templates

These templates are starting points for Pi's `workflow` tool from
`pi-dynamic-workflows`.

Use them by copying the raw JavaScript into the `workflow` tool and passing task
context through the tool's optional `args` value. Keep the task-specific state,
evidence, and final decisions in the run folder or PR evidence pack; workflow
runs are short-lived and not resumable.

## Strict Task Scope

Every workflow run must receive the accepted task scope and explicit
out-of-scope items in its brief. Workflow subagents may only recommend or edit
inside that scope. Related bugs, cleanup, refactors, design/copy issues,
architecture ideas, or security findings outside the accepted scope must be
reported as follow-up items for Samuel unless remediation was explicitly
approved.

Recommended use:

- `classify-and-route.js` for intake, repo routing, risk class, and required
  gates.
- `fanout-review.js` for multi-perspective planning, audit, or code review.
- `deep-research-architecture.js` for converting a large idea plus source notes
  into research questions, adversarial architecture proposals, a Musk-algorithm
  pass, and an architecture decision.
- `adversarial-verification.js` for evidence challenge and holdout-style
  verification.
- `generate-filter-scenarios.js` for business-flow, UI, and regression scenario
  generation.
- `tournament-plan.js` for choosing between competing implementation,
  architecture, or test strategies.
- `pr-comment-classifier.js` for classifying review comments before a post-PR
  fix loop.

Do not use these templates for simple edits, deterministic commands, destructive
operations, or PR merge decisions.
