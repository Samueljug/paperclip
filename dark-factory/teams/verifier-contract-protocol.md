# Targeted Verifier Contract Protocol

Borrow the useful discipline from `disler/the-verifier-agent` without installing
that harness as an always-on core process.

The goal is to make verification claim-based, evidence-backed, and cheap enough
to run when it matters.

## When To Use It

Run a targeted verifier pass when any of these are true:

- The task is high-risk, complex, or cross-cutting.
- The work changes frontend/backend/API behavior together.
- The work touches auth, permissions, money, documents, migrations, secrets,
  tenancy, command execution, or external integrations.
- The implementer is about to ask for no-mistakes, pre-PR, PR creation, or a
  merge decision on non-trivial code.
- A previous external agent, reviewer, no-mistakes run, Webwright run, or PR
  comment raised concerns that need proof.
- Samuel explicitly asks for a verifier-style pass.

Skip the pass for tiny docs, mechanical copy changes, and simple one-file
changes unless the task risk says otherwise.

## Independence

The verifier must not be the implementing agent.

Default verifier behavior is read-only:

- Read the original brief, plan, diff, changed files, tests, logs, browser
  evidence, Paperclip comments/attachments, and PR comments.
- Write a verifier report into the task run folder or PR evidence pack, and
  mirror the verdict to Paperclip when the task is Paperclip-backed.
- Do not edit product code during the verifier pass.
- If a fix is needed, send corrective feedback to the implementer, then verify
  the new evidence after the implementer fixes it.

If a dynamic workflow is used, treat it as a short-lived verifier swarm. Do not
make it the persistent Dark Factory runner.

## Atomic Claim Checks

The verifier turns the task into atomic claims, then checks each claim.

Claim sources:

- Samuel's original brief and acceptance criteria.
- The Brief & Artifact Manifest stored as the `brief-artifact-manifest` issue
  document (GET `/api/issues/{issueId}/documents/brief-artifact-manifest`; see
  `.pi/openclaw-teams/stage-gate-relay-protocol.md`): EVERY brief item,
  acceptance criterion, and artifact — including the `extracted_text` of every
  video/audio/PDF/image — is a claim source. An artifact with missing `extracted_text`
  is a blocking gap, not a skippable claim.
- The implementation plan.
- The implementer's completion claims.
- Changed-file behavior implied by the diff.
- Test, browser, video, API, security, no-mistakes, or Claude Code evidence.

Every manifest item must appear as at least one atomic claim, and the Coverage
Matrix must show no `uncovered` required item and no unwaived `off_track` row
before a `PERFECT` or `VERIFIED` verdict.

Each atomic claim should have:

- `claim`: one specific behavior, invariant, or risk statement.
- `source`: brief, plan, implementer, diff, test, PR comment, or external tool.
- `evidence`: command, file path, screenshot/video path, Paperclip attachment id
  or content path, log, PR URL, or exact reason no evidence exists.
- `status`: `verified`, `disproved`, `partial`, `not_checked`, or `not_verifiable`.
- `confidence`: `high`, `medium`, or `low`.
- `next_action`: none, rerun check, fix required, ask Samuel, or add missing
  evidence.

For any claim created from a reviewer, CI, no-mistakes, or external-model
failure, the verifier must look for evidence that the new regression check
executes the same failure path. A shape-only test, grep, or AST scan is
`partial` unless the original finding was purely structural.

## Verdict Ladder

Use one of these final verdicts:

- `PERFECT`: all material claims verified, no meaningful gaps.
- `VERIFIED`: required claims verified; only harmless gaps or notes remain.
- `PARTIAL`: core behavior appears right, but non-blocking gaps remain.
- `FEEDBACK`: fixes or missing evidence are required before the task can
  proceed.
- `FAILED`: a material claim is disproved, unsafe, or untested in a way that
  blocks progress.

`PERFECT` and `VERIFIED` can proceed to the next gate. `PARTIAL` may proceed
only for low-risk work when gaps are explicitly recorded. `FEEDBACK` and
`FAILED` go back to implementation. An `uncovered` required manifest item or an
unwaived `off_track` row is never a low-risk gap: it blocks PARTIAL-proceed too,
and the work returns to implementation or to Samuel for a waiver.

Cap verifier -> fix -> verifier loops at 3 iterations. After that, escalate the
remaining claims to OpenClaw/Samuel with the evidence and tradeoff.

## Required Report Format

Write reports in this shape:

```markdown
Targeted verifier report
Task id:
Verifier:
Implementer:
Repo / branch / cwd:
Risk trigger:
Verdict: PERFECT | VERIFIED | PARTIAL | FEEDBACK | FAILED

Atomic claims:
- Claim:
  Source:
  Evidence:
  Status:
  Confidence:
  Next action:

Could not verify:
- <claim or gap, why, what evidence would close it>

Corrective feedback:
- <required fix or evidence, owner, suggested command/check>

Evidence checked:
- <commands, files, screenshots, videos, tests, PR comments, external runs>

External-learning summary:
Categories: targeted_verifier, claim_verification, verification, <others>
Pattern status: one_off | possible_pattern | repeated_pattern | major_improvement
Suggested improvement:
```

If the task requires Paperclip-visible evidence, check both surfaces: the
underlying run-folder/test/browser/security artifacts and the Paperclip Option B
comments/attachments. Board comments are visibility mirrors, not trusted actor
identity. Option B attribution is advisory/local trusted/display-only and must
not be treated as non-forgeable proof of who performed the gate. A missing board
comment/attachment is a visibility gap; a board comment without underlying
artifacts is not enough to verify behavior.

If nothing could be verified, say that clearly. Do not convert uncertainty into
confidence.

## Learning Loop

The `Could not verify` section is important. Send repeated or high-impact gaps
to `self-improvement-lead` using the external-learning protocol.

Useful categories include:

- `targeted_verifier`
- `claim_verification`
- `unverified_gap`
- `missing_fixture`
- `missing_script`
- `missing_oracle`
- `evidence_quality`
- `false_positive`
- `missed_issue`
- `efficiency`

The team should improve scripts, fixtures, policies, or skills when verifier
gaps repeat. Do not install the external verifier harness wholesale unless
Samuel explicitly asks for that separate spike.
