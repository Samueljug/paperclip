# Architecture Decision Records (ADRs)

## Purpose

ADRs capture technical decisions so they never need to be made twice. When a developer evaluates multiple approaches and picks one, the decision, the rejected alternatives, and the reasoning are recorded. Future developers (and Claude) read this before re-evaluating the same choices.

## ADR Directory Structure

```
docs/decisions/
├── INDEX.md                              ← Summary index of all ADRs with tags
├── 001-template-filtering-approach.md
├── 002-subscription-tier-gating.md
├── 003-integration-sync-strategy.md
└── ...
```

### The Index File

`docs/decisions/INDEX.md` is a lightweight summary that skills read INSTEAD of loading every ADR. It enables fast, targeted lookup without consuming context window on irrelevant decisions.

Format:

```markdown
# Architecture Decision Index

| ADR | Title | Status | Area | Date |
|-----|-------|--------|------|------|
| 001 | Template filtering approach | accepted | API, Data Model | 2025-11-15 |
| 002 | Subscription tier gating strategy | accepted | Auth, Billing | 2025-11-22 |
| 003 | Integration sync strategy | superseded by 008 | Integrations | 2025-12-01 |
| 004 | Document storage architecture | accepted | Data Model, Infrastructure | 2025-12-10 |
```

**Area tags** (use one or more per ADR):
`API`, `Data Model`, `Auth`, `Billing`, `Frontend`, `Infrastructure`, `Integrations`, `Performance`, `Security`, `Testing`

**How skills use the index:**
1. Read `INDEX.md` first (a few lines, negligible context cost)
2. Identify which ADRs are relevant based on the area tags matching the current task
3. Read ONLY those specific ADR files
4. Never load "superseded" or "deprecated" ADRs unless specifically investigating why a decision changed

## ADR Lifecycle

```
proposed → accepted → [superseded by NNN | deprecated]
```

**proposed** — Created by the plan skill as part of a plan that hasn't been approved yet. The developer and their reviewer decide whether to accept it. An ADR should NEVER be created as "accepted" directly — it always starts as "proposed" because the plan it belongs to hasn't been reviewed yet.

**accepted** — The plan was approved and the approach was implemented. Update the status from "proposed" to "accepted" when the PR implementing the decision is merged. The `/create-pr` command should remind the developer to update ADR status.

**superseded by NNN** — A new decision replaced this one. The old ADR stays in the repo for historical context (why was the original decision made? what changed?). The new ADR should reference the old one and explain what new constraints triggered the change.

**deprecated** — The decision is no longer relevant (feature was removed, technology was replaced, etc.). Add a one-line explanation of why.

## ADR Template

Every ADR follows this format. Keep the total under 60 lines. The summary section must be under 10 lines — it's what appears in quick scans.

```markdown
# ADR-[NNN]: [Decision Title]

**Date:** [YYYY-MM-DD]
**Status:** proposed
**Area:** [comma-separated area tags from the list above]
**Ticket:** [ticket reference if applicable]
**Supersedes:** [ADR-NNN if this replaces a previous decision, or "none"]

## Summary

[2-3 sentences max. What was decided and the key reason why. A developer scanning ADRs should understand the decision from this section alone without reading further.]

## Context

[2-3 sentences. What problem or requirement triggered this decision. What constraints exist. What the system currently does (if changing an existing approach).]

## Decision

[The chosen approach in 2-4 sentences. Be specific enough that a developer knows what to build.]

## Alternatives Considered

### [Alternative A]
[1-2 sentences: what it is and how it would work]
**Rejected because:** [1 sentence — the decisive reason, not a list of minor concerns]

### [Alternative B]
[1-2 sentences: what it is]
**Rejected because:** [1 sentence]

[Only include alternatives that had genuine merit. Don't list obviously bad options just to pad the section.]

## Consequences

**Enables:** [what this decision makes possible or easier — 1-2 bullet points]

**Constrains:** [what future decisions are now locked in or limited — 1-2 bullet points. This is the most important subsection — it tells future developers what they can't do because of this decision.]

**Tradeoffs accepted:** [what was knowingly sacrificed — 1-2 bullet points, or "None significant."]
```

## Code-Level Linkage

When a decision governs a specific file, function, or module, add a comment in the code pointing to the ADR. This ensures developers editing the file know the decision exists without needing to run the discover skill first.

Format (adapt to your language's comment style):

```typescript
// Decision: ADR-003 — Integration uses async webhooks, not synchronous API calls.
// See docs/decisions/003-integration-sync-strategy.md before changing this pattern.
export async function handleWebhookEvent(payload: WebhookPayload) {
  // ...
}
```

**When to add code comments:**
- At the top of a file or class whose entire architecture is governed by an ADR
- Above a function that implements the specific approach chosen in the ADR
- Above a configuration block that reflects a decision (e.g., cache TTL, retry strategy)

**When NOT to add code comments:**
- On every file — only where the decision is non-obvious and someone might change it
- For deprecated or superseded ADRs — remove the comment when updating the code

The plan skill's file-by-file plan should specify which files need ADR comments when creating new code governed by a decision.

## How Skills Use ADRs

### Discover Skill (reads only)

1. Read `docs/decisions/INDEX.md`
2. Identify ADRs whose area tags overlap with the areas the ticket affects
3. Read those specific ADR files
4. Surface relevant decisions in the output under "Existing Decisions That Apply"
5. Flag conflicts between the ticket requirements and existing decisions

### Plan Skill (reads and writes)

**Before planning:**
1. Read `docs/decisions/INDEX.md`
2. Read ADRs relevant to the planning area
3. Respect existing "accepted" decisions — do not re-evaluate
4. If an existing decision conflicts with new constraints, flag it for the developer

**After deciding (Section 1: Approach Summary):**
1. If 2+ genuine approaches were evaluated with real tradeoffs → create a new ADR as "proposed"
2. Determine next number from INDEX.md
3. Create `docs/decisions/NNN-[slug].md`
4. Add the entry to `INDEX.md`
5. In the file-by-file plan, note which files need ADR code comments
6. Include in the plan output: "📝 ADR proposed: `docs/decisions/NNN-[slug].md`"

**If superseding an existing ADR:**
1. Create the new ADR with `Supersedes: ADR-NNN`
2. Update the old ADR's status to `superseded by NNN`
3. Update `INDEX.md` for both entries
4. Flag in the plan output — superseding a past decision requires explicit developer approval

### Checkpoint Command (reads only)

During `/checkpoint`, if the implementation deviates from a relevant ADR:
```
⚠️ ADR DEVIATION: ADR-003 specifies [pattern X], but the implementation in 
[file:line] uses [pattern Y]. Is this intentional?
→ If yes: the ADR may need to be superseded — flag for discussion.
→ If no: fix the implementation to follow the ADR.
```

### Create-PR Command (reads only)

The `/create-pr` command should include in the PR description:
- Any ADRs created during this work (listed under "Decisions Recorded")
- Any existing ADRs the implementation builds on (for reviewer context)
- A reminder to update ADR status from "proposed" to "accepted" when the PR is merged

### Fix-Review Command (reads only)

If a reviewer's feedback contradicts an existing ADR (e.g., "why didn't you use synchronous API calls?" when ADR-003 says async), the response draft should reference the ADR:
```
"This follows ADR-003 which decided on async webhooks over synchronous calls 
because [reasoning]. Happy to discuss if you think the decision should be revisited."
```

## Conflict Detection

When creating or reading ADRs, check for conflicts:

- **Two accepted ADRs governing the same area with different decisions.** This shouldn't happen but can if two developers create ADRs independently. Flag it and have the team resolve which takes precedence.
- **A new ADR that implicitly invalidates an older one without explicitly superseding it.** The new ADR should reference the old one.
- **A "proposed" ADR that contradicts an "accepted" one.** The proposed ADR must explicitly state it supersedes the existing one, or the plan must explain why both can coexist.

## When to Create ADRs — The Significance Threshold

**DO create an ADR:**
- 2+ architecturally different approaches were genuinely evaluated
- The rejected alternatives had real merit (not obviously wrong)
- Future developers working in this area would plausibly face the same decision
- The decision constrains future work in ways that aren't obvious from the code alone

**Do NOT create an ADR:**
- Only one sensible approach exists (no real decision was made)
- Following an existing pattern or ADR (the decision already exists)
- Implementation details that don't affect architecture
- Code style choices (these belong in `docs/claude/patterns.md`)
- Bug fixes (the correct approach is to fix the bug)
- Trivial choices that don't constrain future work

## Maintenance

- **Proposed ADRs that are rejected:** If a plan is rejected and the approach changes, delete the proposed ADR and remove it from INDEX.md. Don't leave rejected proposals in the repo.
- **Quarterly review:** Every 3 months, scan INDEX.md for accepted ADRs that may no longer be relevant. Mark as "deprecated" with a one-line explanation if the feature was removed or the technology was replaced.
- **Commit ADRs with the code.** They're part of the repo, not a separate wiki. They travel with the code they govern.
