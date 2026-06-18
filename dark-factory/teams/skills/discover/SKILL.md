---
name: discover
description: "Analyse a ticket or task before writing any code. Use this skill whenever a developer mentions starting a new ticket, beginning work on a feature, picking up a task, or asks what they should build. Also trigger when someone pastes in a Jira/Linear/Asana ticket description and asks about it, says 'I need to build X', 'what does this ticket mean', 'where do I start with this', or references a task they're about to work on. This skill forces thorough analysis of requirements, codebase impact, risks, and blockers BEFORE implementation begins — catching misunderstandings and missing requirements when they're cheap to fix."
allowed-tools: Read, Glob, Grep, Bash, WebFetch
---

# Discover: Pre-Implementation Ticket Analysis

## Purpose

This skill exists because the most expensive bugs aren't coding mistakes — they're misunderstandings. A developer reads a ticket, assumes they understand it, and starts building. Days later they discover they missed a requirement, built against the wrong pattern, or didn't realise the ticket touches a high-risk area like auth or billing. By then, the cost of fixing it is 10x what it would have been on day one.

This skill forces a structured analysis of the ticket and codebase BEFORE any code is written. The output is a document the developer reviews and shares with their team lead. If there are unanswered questions, they stop and clarify before proceeding.

## When to Use This Skill

- A developer has just been assigned a ticket and is about to start work
- Someone pastes a ticket description and asks what's involved
- A developer asks "where do I start?" or "what files will I need to change?"
- Before any implementation work begins on a new feature, bug fix, or refactor
- When a developer says something like "I need to build X" or "I'm picking up ticket Y"

## Inputs

The developer provides one of:

- A ticket description (pasted text, Jira/Linear/Asana export, or verbal description)
- A brief description of what needs to be built
- A reference to a task (e.g., "the template selection feature" or "the billing integration")

If the input is vague, ask the developer to provide more detail about what they're building before proceeding. You need enough context to analyse the requirements — a single sentence like "fix the bug" is not enough.

## Analysis Process

Work through each phase in order. Use the tools available to you (Bash, Read, Grep, Glob, Task) to explore the codebase thoroughly. Do not guess — search the code and verify.

**Before starting analysis:** Check if `docs/decisions/INDEX.md` exists. If it does:

1. Read INDEX.md to get the summary of all decisions with their area tags and statuses
2. Identify which ADRs have area tags relevant to this ticket's affected areas
3. Read ONLY those specific ADR files — skip superseded and deprecated ones
4. Throughout the analysis, reference these decisions to avoid flagging settled matters as "ambiguous" and to identify when a ticket might conflict with an existing decision

### Phase 1: Requirements Analysis

Read the ticket description carefully and extract:

**Explicit requirements** — What the ticket directly asks for. List each one as a discrete, testable statement. If the ticket says "users should be able to filter templates by jurisdiction," that's one requirement. If it also says "and the default should be their firm's jurisdiction," that's a second requirement.

**Implicit requirements** — Things the ticket doesn't say but obviously needs. These are the ones developers miss most often. For every explicit requirement, ask yourself:

- Does this need error handling? (What happens when the input is invalid, the API is down, the data is missing?)
- Does this need a loading state? (If it hits an API, the user needs feedback while waiting)
- Does this need permissions/authorisation? (Should every user be able to do this, or only admins/certain roles?)
- Does this need audit logging? (For a legal platform, changes to documents, permissions, and billing almost always need an audit trail)
- Does this need to work on mobile? (Check if the project has responsive requirements)
- Does this affect other tenants? (Multi-tenant isolation is critical)

**Ambiguities and gaps** — Things the ticket doesn't specify that have multiple valid interpretations. For each one, write the specific question the developer should ask. Don't guess the answer — surface the question.

Read `references/implicit-requirements.md` for the full checklist of commonly missed implicit requirements for legal AI platforms.

### Phase 2: Codebase Impact Analysis

Use the available tools to map exactly what will need to change:

1. **Find existing patterns.** Use Grep and Glob to search for similar features already implemented in the codebase. If the ticket asks for "template filtering," search for how other filtering is already done. The developer should follow existing patterns, not invent new ones.

2. **Map the change surface.** Identify every file, module, and service that will likely need to change. Be specific — list file paths, not just module names.

3. **Identify high-risk shared code.** Use Grep to check if any of the files you've identified are imported or used by other features. Changes to shared utilities, middleware, base classes, or common components affect everything that depends on them. Flag these explicitly.

4. **Check for existing tests.** Use Glob to find test files for the affected modules. If there are no tests, that's a risk — the developer will be changing code with no safety net.

5. **Identify the data flow.** Trace the path from user action → API endpoint → service layer → database (and back). This reveals integration points where things can break.

### Phase 3: Risk Assessment

Categorise every risk using the matrix in `references/risk-matrix.md`. At minimum, check for:

**Critical risk areas** (require team lead sign-off before proceeding):

- Changes to authentication or authorisation logic
- Changes to tenant isolation (any query that filters by firm/organisation ID)
- Changes to billing, pricing, or subscription tier logic
- Changes to data sovereignty compliance (data must stay in ap-southeast-2)
- Changes to API contracts that external systems depend on (Smokeball, webhooks, etc.)

**High risk areas** (require extra care and thorough testing):

- Database schema changes or migrations
- Changes to shared middleware, utilities, or base classes
- Changes to document generation or legal template logic
- Changes to user-facing permissions or role-based access
- Third-party API integrations

**Standard risk areas** (follow normal development practices):

- New UI components with no shared dependencies
- Internal API endpoints with no external consumers
- Configuration changes
- Documentation updates

### Phase 4: Dependency and Blocker Analysis

Identify anything that could prevent the developer from completing the work:

- **Ticket dependencies:** Does this ticket require another ticket to be completed first? Search the codebase for TODO comments, feature flags, or incomplete implementations that this ticket builds on.
- **External dependencies:** Does this require access to a third-party API, credentials, test accounts, or documentation that the developer might not have?
- **Knowledge dependencies:** Does this require understanding of a part of the codebase the developer may not be familiar with? If so, point them to the relevant files and suggest they read them first.
- **People dependencies:** Does this require input, approval, or coordination with someone else (designer, product, another developer)?

### Phase 5: Estimation Sanity Check

Based on the codebase analysis, assess whether the scope matches the apparent complexity:

- Count the number of files that need to change
- Count the number of new files that need to be created
- Check if database migrations are needed
- Check if new API endpoints are needed
- Check if there are multiple layers to change (frontend + backend + database)

If the scope looks significantly larger or smaller than what the ticket implies, flag it explicitly. A ticket estimated at "small" that requires changes across 15 files and a database migration is a red flag.

## Output Format

Structure the output exactly as follows. The developer should be able to copy this directly into a ticket comment or Slack message.

```
## MUST CLARIFY BEFORE STARTING
[List every unanswered question that could change the implementation approach.
If this section is empty, write "No blocking questions — clear to proceed."
If this section has items, the developer MUST get answers before writing code.]

## Requirements Summary
### Explicit Requirements
[Numbered list of every explicit requirement from the ticket]

### Implicit Requirements
[Numbered list of requirements not stated in the ticket but obviously needed]

## Codebase Impact
### Files to Modify
[List every file path that will likely need changes, with a one-line description of what changes]

### Files to Create
[List every new file that will need to be created]

### Existing Patterns to Follow
[Reference specific files/functions that implement similar features — the developer should match these patterns]

### Shared Code at Risk
[List any shared utilities, middleware, or components that will be affected, and what depends on them]

## Existing Decisions That Apply
[If ADRs exist in docs/decisions/ that are relevant to this ticket, list them:
- ADR-NNN: [title] — [one-line summary of the decision and how it constrains or informs this ticket]

If any ADR conflicts with the ticket requirements, flag it:
- ⚠️ ADR-NNN decided [X], but this ticket requires [Y]. This needs to be resolved before implementation — either the ADR is superseded or the ticket requirements are adjusted.

If no relevant ADRs exist, write "No existing architectural decisions affect this ticket."]

## Risk Assessment
### Critical Risks (Require Team Lead Sign-off)
[List any, or "None identified"]

### High Risks (Require Extra Testing)
[List any, or "None identified"]

## Dependencies and Blockers
[List any ticket dependencies, external dependencies, knowledge gaps, or people dependencies.
Or "No dependencies or blockers identified."]

## Estimation Check
[Brief assessment: does the scope match the expected complexity? Flag if mismatched.]

## Suggested Implementation Order
[Recommended sequence of what to build first, second, third, with natural checkpoints]
```

## Important Behaviours

- **Be specific, not generic.** Don't say "check the auth middleware" — say "the auth middleware is in `src/middleware/auth.ts` and uses the `validateTenant()` function on line 47. Your changes will need to pass through this."
- **Search the codebase, don't guess.** Use Grep, Glob, and Read to find actual file paths, function names, and patterns. If you can't find something, say so — don't fabricate paths.
- **Flag ambiguity aggressively.** When in doubt about a requirement, put it in the "MUST CLARIFY" section. It's better to ask one too many questions than to build the wrong thing.
- **Don't start implementing.** This skill produces analysis only. Do not write code, create files, or make changes. The output is a document for the developer to review.
- **Be honest about uncertainty.** If the codebase is large and you can't fully trace all dependencies, say so. "I've identified these files but there may be others — search for [pattern] to confirm" is better than a false sense of completeness.
