# Claude Skill Evaluator Protocol

Use this protocol before creating a new Skill Workshop proposal, revising a
pending proposal, or updating an existing live skill.

The evaluator is a Claude Code review gate. It may use Claude Code CLI directly
or the Pi Claude Code bridge, depending on which path is available. If the
proposal is a project run skill, use `/run-skill-generator` when appropriate.
For general skill quality, use the rubric below as a bounded Claude Code prompt.

## Required Inputs

For a new skill:

- proposed skill or proposal content
- target users/agents
- trigger examples
- expected tools and permissions
- evidence or task ids that motivated the skill

For an update:

- current live skill or pending proposal content
- proposed updated content
- evidence or task ids that motivated the change
- explicit list of intended additions
- explicit list of intended removals, if Samuel approved any

## Preservation Rule For Updates

Skill updates are merge-preserving by default.

Do not remove, weaken, rename, or hide existing triggers, workflows, guardrails,
examples, references, tool restrictions, safety rules, output formats, or
operating boundaries unless Samuel explicitly asked for that removal.

When evaluating an update, compare old vs new and classify every loss:

- `preserved`: behavior remains intact
- `expanded`: behavior remains and is improved
- `changed`: behavior changed but is not obviously weaker
- `removed_or_weakened`: requires Samuel approval before proceeding
- `unclear`: requires follow-up before proceeding

Any `removed_or_weakened` or material `unclear` item blocks the update until
Samuel approves the loss or the proposal is revised to preserve it.

## Evaluator Prompt

Use this shape with Claude Code CLI or `claude_code_run`:

```text
You are evaluating a proposed Skill Workshop skill or skill update.

Goal:
- decide whether the skill is clear, useful, safe, and operationally complete
- for updates, ensure no existing capability is lost unless Samuel explicitly
  approved that removal

Evaluate:
1. Trigger clarity: will agents know when to use it?
2. Scope: is it focused, not a dumping ground?
3. Workflow: are steps concrete enough to execute?
4. Tooling: are required tools named, with safe fallbacks?
5. Safety: are permissions, external actions, secrets, and destructive actions
   handled correctly?
6. Evidence: does the skill say what proof or outputs are required?
7. Preservation: for updates, list every trigger, step, guardrail, example,
   reference, output contract, and boundary that existed before; mark preserved,
   expanded, changed, removed_or_weakened, or unclear.
8. Duplication: should this update an existing skill instead of creating a new
   one?
9. Minimality: what should be deleted or simplified without losing value?

Return:

Verdict: PASS | NEEDS_CHANGES | BLOCKED
Summary:
Must fix before proposal:
Preservation audit:
Suggested additions:
Suggested simplifications:
Questions for Samuel:
```

## Gate Rules

- Run the evaluator before `skill_workshop action=create`, `action=update`, or
  `action=revise` when the change is non-trivial.
- For tiny typo fixes, formatting, or metadata-only edits, record why the
  evaluator was skipped.
- Attach or summarize the evaluator output in the Skill Workshop proposal
  evidence field, task notes, or improvement report.
- Do not apply, install, or mutate a live skill from evaluator output alone.
  Evaluator findings become pending proposals unless Samuel explicitly approves
  applying them.
- If Claude Code is unavailable, block major skill changes or fall back to a
  second-model review and clearly record that Claude evaluation was unavailable.
