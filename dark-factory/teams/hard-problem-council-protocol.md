# Hard Problem Council Protocol

Use this protocol when a task is difficult enough that one implementer or one
lead should not be trusted to pick the fix alone.

The goal is to turn a stuck or high-risk implementation problem into a concrete
approach decision that the implementation team can execute, with dissent and
verification requirements recorded.

## Trigger

Convene the Problem Solvers when any of these are true:

- Samuel explicitly asks for problem solvers, top models, hard-problem review,
  or agents to discuss a difficult fix.
- The task is D3/D4, high user impact, high-risk, or expensive to reverse.
- Root cause is ambiguous and there are multiple plausible fixes.
- Implementation, verification, browser QA, security, CI, No Mistakes, or PR
  review loops fail repeatedly.
- A verifier -> fix -> verifier loop reaches its cap.
- Leads disagree about the correct approach.
- The proposed fix would cross boundaries, alter architecture, weaken security,
  create data risk, or broaden the accepted task scope.

Simple bugs and deterministic one-file fixes do not need this lane unless a
normal loop gets stuck.

## Roles

- `problem-solving-lead`: owns the council trigger, context packet, discussion,
  decision artifact, and handoff to `implementation-lead`.
- `problem-root-cause-solver`: finds the actual failure path, missing evidence,
  and the smallest reproduction that proves the problem.
- `problem-implementation-solver`: proposes the smallest maintainable fix and
  names exact files, boundaries, risks, and rollback path.
- `problem-test-repro-solver`: designs the reproduction, regression tests,
  browser/API checks, fixtures, and evidence needed to prove the fix.
- `problem-risk-skeptic`: challenges assumptions, scope creep, unsafe shortcuts,
  false certainty, hidden data/security risk, and overbuilt fixes.
- `problem-synthesis-judge`: selects the approach or blocks the task, recording
  the evidence, dissent, rejected options, stop conditions, and handoff.

For top-tier hard problems, the council should include a Claude Code Opus 4.8
max counterpart pass through `claude_code_run` when available. The bridge
enforces the Claude model and effort. If Claude is unavailable, record the
degraded path and why.

## Council Sequence

Do not start with a group chat. Independent thinking comes first.

1. `problem-solving-lead` creates a bounded context packet:
   original brief, accepted plan, task id, run folder, repo/branch/cwd, allowed
   writes, forbidden writes, current diff, failing checks, evidence, prior
   attempts, and open questions.
2. Each solver independently writes a proposed approach without reading the
   other solvers' answers unless the tool path already forces shared context.
3. The lead shares the proposals and asks each solver to challenge at least one
   other proposal's strongest assumption, evidence gap, or risk.
4. The synthesis judge chooses the approach using evidence, task scope,
   maintainability, security, testability, and Samuel's priorities.
5. The council writes `hard-problem-decision.md`.
6. `implementation-lead` resumes only from the selected approach, or the task is
   blocked and escalated to OpenClaw/Samuel.

Agreement is not the same as correctness. Do not optimize for consensus. If the
best answer has unresolved dissent, record the dissent and verification that
would prove or disprove it.

## Required Artifact

Save the decision under:

```text
.pi/openclaw-teams/runs/<task-id>/hard-problem-decision.md
```

Use this shape:

```markdown
Hard problem decision
Task id:
Factory cell:
Trigger:
Repo / branch / cwd:
Original brief:
Brief & Artifact Manifest (brief_artifact_manifest, carried verbatim from the PLAN token — brief + instructions, accepted plan, in/out scope, every artifact with type/location plus required extracted_text for media):
Allowed writes:
Forbidden writes:
Evidence packet:
Participants:
Claude counterpart:

Independent proposals:
- Solver:
  Proposed approach:
  Evidence:
  Risks:
  Tests/evidence required:

Challenges:
- From:
  Against:
  Point:
  Resolution:

Decision: APPROACH_SELECTED | BLOCKED | ASK_SAMUEL
Selected approach:
Why this approach:
Rejected options:
Dissent / unresolved assumptions:
Implementation handoff:
Verification requirements:
Security/browser/no-mistakes requirements:
Stop conditions:
External-learning notes:
```

## Handoff Rules

- The council is read-only by default. It decides the approach; it does not make
  product edits unless Samuel or the accepted task explicitly authorizes it.
- The decision must reference the `brief-artifact-manifest` issue document
  (GET `/api/issues/{issueId}/documents/brief-artifact-manifest`). A
  council-routed task must not reach implementation without it.
- `implementation-lead` owns the code change after the decision, builds the
  Coverage Matrix against every manifest item, and refuses to start if the
  decision carries no complete manifest.
- `verification-lead` verifies the implementation against the decision and the
  original brief. The decision does not replace normal verification, security,
  browser QA, No Mistakes, or PR gates.
- If the council expands scope, the expanded scope becomes a separate ticket or
  an explicit Samuel approval request.
- If a hard-problem trigger fires after repeated failed loops, implementation
  should not keep iterating past the cap without `hard-problem-decision.md` or a
  visible waiver.

## Decision Quality

A useful hard-problem decision is:

- grounded in the original brief and evidence
- explicit about root cause confidence
- small enough to implement safely
- clear about what is out of scope
- testable with the same failure path, not only shape checks
- honest about risks and dissent
- easy for implementation to execute without re-litigating the problem

If the council cannot produce that, return `BLOCKED` or `ASK_SAMUEL`.
