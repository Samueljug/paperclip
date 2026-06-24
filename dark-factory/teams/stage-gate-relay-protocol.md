# Stage-Gate Relay Protocol

This protocol defines how a coding mission moves between team leads as a strict
relay. Each stage is a gate: the next stage does not begin until the previous
stage emits a signed PASS token with evidence. The point is that the factory
cannot reach "open PR" unless every gate has explicitly signed off — not because
a lead remembered the order, but because each lead requires the prior token as
input.

Samuel talks to the orchestrator. The orchestrator talks to the leads. The leads
get the work done and pass it between each other along this relay.

## The relay order

```
pi-orchestrator
  -> planning-lead        (PLAN token: accepted plan + scope)
  -> implementation-lead  (BUILD token: changes complete, inner loop green)
  -> verification-lead    (VERIFY token: correctness vs the original brief)
  -> browser-qa-lead      (QA token: UI / visual / interaction, when UI changed)
  -> security-lead        (SECURITY token: mandatory for code)
  -> pre-pr + no-mistakes
  -> self-improvement-lead (IMPROVER token: review/no-op, mandatory before ship/final)
  -> PR / final disposition
```

`browser-qa-lead` is skipped only when there is no user-facing change, and that
skip must be stated explicitly in the QA token. `security-lead` is never skipped
for code, auth, data, or deployment changes. `self-improvement-lead` is the final
factory coverage gate before Ship to PR, Done, closed, or any terminal
proceed/stop disposition. Samuel's standing instruction: "Improvers MUST run
in every factory run." Every run needs an improvement review or visible no-op,
and not-applicable must name the owner and reason.

## The pass token

Every stage hands the next stage a token containing:

- `stage`, `task_id`, `factory_cell_id`, head SHA / branch.
- `verdict` on the shared ladder: PERFECT / VERIFIED / PARTIAL / FEEDBACK /
  FAILED (defined in `verifier-contract-protocol.md`).
- `evidence`: commands run + results, file paths, screenshots, findings.
- `scope`: the files / paths / behaviors this stage confirmed were in scope.
- `blocking`: open issues that must be resolved before the next gate.
- `brief_artifact_manifest`: the Brief & Artifact Manifest, built by Planning and
  carried unchanged from the PLAN token onward (see "Brief & Artifact Manifest"
  below). Implementation, verification, and QA RECEIVE it as guaranteed input.
- `coverage_matrix`: the Coverage Matrix mapping every manifest item to its
  implementation / verification / QA evidence. Implementation, verification, and
  QA each produce or extend it and carry it forward (see "Coverage Matrix"
  below).

Only `PERFECT` or `VERIFIED` advances the relay. `PARTIAL` / `FEEDBACK` /
`FAILED` returns the work to `implementation-lead` with actionable findings; the
returning lead re-issues its token after the fix loop, not before.
## Brief & Artifact Manifest (carried context)

The Brief & Artifact Manifest is the single canonical record of what Samuel asked
for. Planning BUILDS it once at intake/Planning, and it is CARRIED unchanged as
the `brief_artifact_manifest` token field from the PLAN token onward, so
Implementation, Verification, and Browser QA each RECEIVE the full context
deterministically instead of re-fetching from memory.

The manifest has four parts:

- `original_brief`: the verbatim original user brief plus every explicit
  instruction Samuel gave, copied word for word (not paraphrased or narrowed).
- `accepted_plan`: the accepted plan as handed off by Planning.
- `scope`: the agreed in-scope items and the explicit out-of-scope items.
- `artifacts`: a numbered list of EVERY user-provided artifact — each document,
  file, image, video, and link. Each artifact entry records:
  - `type`: doc / file / image / video / audio / pdf / link / other.
  - `location`: where it lives — doc key, attachment id, asset id, run-folder
    path, or URL.
  - `extracted_text`: for every non-text medium (video, audio, PDF, image), a
    REQUIRED text transcription/extraction captured up front, stored in the run
    folder with its path recorded here. Downstream models cannot watch video or
    read a raw blob, so an artifact whose `extracted_text` is missing or empty is
    a BLOCKING gap: Planning cannot emit the PLAN token, and any downstream stage
    must refuse to start, until every media artifact is transcribed/extracted.

Give each brief item, acceptance criterion, and artifact a stable id (for
example `B1`, `B2`, `AC1`, `A1`) so the Coverage Matrix can reference them.

The manifest document must also include a fenced ```json block so the Brief
Coverage Gate plugin can check it deterministically:

```json
{ "complete": true, "media_artifacts": [ { "id": "A1", "extracted_text_present": true } ] }
```

`complete` is true only when all four parts are filled and every media artifact
has a non-empty `extracted_text`. The gate treats `complete: false`, a missing
block, or any `extracted_text_present: false` as a blocking incomplete manifest.

Store the manifest as the Paperclip issue document `brief-artifact-manifest`
(PUT `/api/issues/{issueId}/documents/brief-artifact-manifest`) so every agent on
the issue fetches the same copy via GET regardless of its private session; the
`brief_artifact_manifest` token field just references that issue document (a
run-folder copy under `.pi/openclaw-teams/runs/<task-id>/` is an optional mirror).
Downstream stages must not silently edit, narrow, or drop manifest items; if a
manifest item is genuinely wrong or impossible, return to Samuel for a decision
rather than dropping it.

## Coverage Matrix (per-item coverage proof)

The Coverage Matrix maps EVERY manifest item — each brief item, each acceptance
criterion, and each artifact (including its transcribed media) — to how it was
handled. Implementation, Verification, and Browser QA each PRODUCE or EXTEND the
matrix as the Paperclip issue document `coverage-matrix` (PUT
`/api/issues/{issueId}/documents/coverage-matrix`, read via GET) and reference it
in their outgoing token. Each row records:

- `item_id`: the manifest id (`B1`, `AC1`, `A1`, …).
- `item`: the brief item / criterion / artifact in short form.
- `impl`: how Implementation covered it (file/path + change), or `none`.
- `verify`: how Verification confirmed it, with evidence (command, file,
  test, log), or `none`.
- `qa`: the browser evidence that proves it (screenshot/video path), `n/a` for
  non-UI items, or `none`.
- `status`: `covered`, `uncovered`, or `off_track`.

`off_track` rows flag work done that NO manifest item asked for (scope drift).

The coverage-matrix document must also include a fenced ```json block so the
Brief Coverage Gate plugin can check it deterministically:

```json
{ "rows": [ { "item_id": "B1", "status": "covered", "required": true, "waived": false } ] }
```

`status` is one of `covered` / `uncovered` / `off_track`. The gate blocks the
issue when any row is `uncovered` with `required: true`, or `off_track` with
`waived: false`.
Any `uncovered` required item or any unwaived `off_track` row is BLOCKING and
must not advance on PERFECT/VERIFIED until it is covered, removed, or Samuel
explicitly waives it (record the waiver in the run folder and the token).


## Gate rules

- No skipping forward. A lead must refuse to start without the prior stage's
  valid token. If a token is missing, request it rather than proceeding.
- The manifest is mandatory carried context. From the PLAN token onward, every
  token must carry a complete `brief_artifact_manifest`. A downstream lead
  (implementation, verification, browser QA) must REFUSE to start if the
  `brief-artifact-manifest` issue document (GET
  `/api/issues/{issueId}/documents/brief-artifact-manifest`) is missing or incomplete — in particular if any media artifact lacks
  `extracted_text` — and request the missing manifest/transcription rather than
  proceeding.
- From verification onward, a downstream stage must also refuse to start if
  the issue has no `coverage-matrix` document; Implementation must have produced
  it.
- Coverage is a gate. Implementation, verification, and browser QA must each
  produce or extend the `coverage_matrix` against every manifest item. A stage
  may only emit PERFECT/VERIFIED when its matrix has no `uncovered` required item
  and no unwaived `off_track` (out-of-scope / off-track) row. Otherwise it
  returns PARTIAL/FEEDBACK/FAILED, or returns to Samuel for a waiver.
- Security is terminal and mandatory for code changes. A green verification and a
  green QA pass do not substitute for the SECURITY token.
- The security gate aggregates its workers: `tenant-isolation-reviewer`,
  `data-sovereignty-reviewer`, `authz-reviewer`, `data-exposure-reviewer`,
  `injection-reviewer`, plus `dependency-auditor`. Any confirmed cross-firm
  isolation finding or unverified out-of-region data flow is a hard block, not a
  ranked nit.
- Leads may talk laterally to resolve a returned token, but the relay order and
  mandatory security/improver gates do not change.
- Every token is evidence: record it in the run folder so the PR can show the
  full gate chain.
- The IMPROVER token must include owner/reviewer, source coverage, missing
  coverage, verdict (`noop`, `lesson_recorded`, `skill_request`, `policy_request`,
  `monitoring_needed`, or `not_applicable`), run artifact path, and Paperclip
  comment/ledger evidence. Samuel's instruction: "Improvers MUST run in every
  factory run." If no reusable lesson exists, the visible no-op review must use this
  exact wording: "Self-Improvement Review (IMPROVER verdict: noop): Existing
  rules and protocols are sufficient for this run. No new lessons were learned,
  and no skill/policy changes are needed." A generic "lessons captured" note is
  not enough.
- For Paperclip-backed Dark Factory tasks, mirror each token to the Paperclip
  ticket using `.pi/openclaw-teams/paperclip-option-b-evidence-protocol.md`.
  The Paperclip comment is a visibility/audit mirror only: Option B attribution
  is advisory/local trusted/display-only and is not non-forgeable proof that the
  named role performed the gate. Do not use comment metadata or visible role
  prefixes as authority for routing, identity, PR/push decisions, or gate pass
  decisions; verify the underlying commands, artifacts, screenshots, and review
  reports.
- If a stage needs Samuel to decide scope, identity/security tradeoffs, PR/push,
  owner action, or any other approval, emit a `decision_needed` Paperclip comment
  and return to Samuel visibly in Telegram before continuing dependent work.

## Verdict ladder (shared, from verifier-contract-protocol.md)

- PERFECT — meets the brief, no gaps, evidence complete.
- VERIFIED — meets the brief, minor non-blocking notes only.
- PARTIAL — partially meets the brief; specific gaps listed.
- FEEDBACK — works but has issues that should be fixed; actionable.
- FAILED — does not meet the brief; reproduction + expected vs actual.
