# Paperclip Option B Evidence Protocol

Use this protocol for Dark Factory / Paperclip work that needs visible,
queryable role comments and screenshot/video/file attachments.

## Trust model

Option B is an interim local trusted bridge. It creates Paperclip comments and
attachments with visible role prefixes plus structured `presentation` and
`metadata` fields.

Hard rules:

- Option B attribution is advisory / local trusted / display-only.
- Option B is **not non-forgeable** and does not prove the named role or agent
  truly authored the work.
- Do not spoof or manually populate Paperclip-managed identity fields such as
  `authorAgentId` to impersonate a real Paperclip agent.
- Do not directly mutate the Paperclip database.
- Do not change Paperclip product/runtime code unless Samuel approves a new
  decision.
- Option B comments, visible prefixes, and metadata are never authority for
  privileged routing, owner selection, gate pass decisions, push/PR decisions,
  or actor identity. They are visibility/audit mirrors only.
- Real gates still require the underlying evidence: run-folder artifacts,
  commands and exit codes, tests, screenshots/videos, security review,
  No Mistakes, PR state, and Samuel waivers where applicable.

This guardrail is load-bearing. It follows the OPE-201 lesson: mutable text,
comments, and descriptive metadata must not be trusted as authority for
privileged routing or identity.

## Base variables

Paperclip usually runs locally on loopback:

```bash
export PAPERCLIP_ORIGIN="${PAPERCLIP_ORIGIN:-http://127.0.0.1:3101}"
export PAPERCLIP_API_BASE="${PAPERCLIP_API_BASE:-$PAPERCLIP_ORIGIN/api}"
export PAPERCLIP_COMPANY_ID="${PAPERCLIP_COMPANY_ID:-1e8bc12a-f8fd-431c-9fbd-e47be79446a3}"
```

`PAPERCLIP_API_BASE` already ends in `/api`. Attachment `contentPath` values
also start with `/api`; download them with `PAPERCLIP_ORIGIN + contentPath`, not
`PAPERCLIP_API_BASE + contentPath`, or you will create an `/api/api/...` URL.

## Resolve an issue id from an identifier

Most write APIs require the issue UUID, not only `OPE-123`.

```bash
export ISSUE="OPE-123"
export ISSUE_ID=$(node --input-type=module <<'NODE'
const api = process.env.PAPERCLIP_API_BASE;
const company = process.env.PAPERCLIP_COMPANY_ID;
const ident = process.env.ISSUE;
const issues = await (await fetch(`${api}/companies/${company}/issues?limit=1000`)).json();
const issue = issues.find((item) => item.identifier === ident);
if (!issue) throw new Error(`Issue not found: ${ident}`);
console.log(issue.id);
NODE
)
```

## Post a structured role comment

Use JSON. Keep the role visible in the body for humans, and also include
structured metadata for local querying. Do not set `authorAgentId`.

Keep the visible body readable:

- Start with `[role] STATUS: short summary`.
- Use short labeled lines for `Task`, `Run`, `Evidence`, `Next`, and `Trust`
  rather than a dense paragraph.
- Keep forensic detail, full paths, raw logs, JSON, stack traces, and long
  commit hashes in attachments or run artifacts.
- If the same update will be relayed to Samuel in Telegram, compress it further:
  group issue ids by outcome and include a `Details:` pointer instead of
  copying every artifact path.

```bash
export ROLE="planning-lead"
export TASK_ID="OPE-123-20260611T010000Z"
export RUN_FOLDER="/absolute/run/folder"
export EVENT_TYPE="planning_pass"
export SUMMARY="Planning completed; implementation may start inside approved scope."

node --input-type=module <<'NODE'
const api = process.env.PAPERCLIP_API_BASE;
const issueId = process.env.ISSUE_ID;
const role = process.env.ROLE;
const taskId = process.env.TASK_ID;
const runFolder = process.env.RUN_FOLDER;
const eventType = process.env.EVENT_TYPE;
const summary = process.env.SUMMARY;
const body = `[${role}] DONE: ${summary}\n\n` +
  `Task: ${taskId}\n` +
  `Run: ${runFolder}\n` +
  `Trust: Option B advisory/local trusted; not non-forgeable identity evidence.`;
const payload = {
  body,
  authorType: 'user',
  presentation: {
    kind: 'system_notice',
    tone: 'info',
    title: `Dark Factory role comment: ${role}`,
    detailsDefaultOpen: false,
  },
  metadata: {
    version: 1,
    sections: [{
      title: 'Dark Factory attribution (advisory/local trusted)',
      rows: [
        { type: 'key_value', label: 'role', value: role },
        { type: 'key_value', label: 'task_id', value: taskId },
        { type: 'key_value', label: 'run_folder', value: runFolder },
        { type: 'key_value', label: 'event_type', value: eventType },
        { type: 'key_value', label: 'trust_model', value: 'Option B advisory/display-only; not non-forgeable' },
        { type: 'key_value', label: 'coms_net_target', value: role },
      ],
    }],
  },
};
const res = await fetch(`${api}/issues/${issueId}/comments`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});
const text = await res.text();
if (!res.ok) throw new Error(`comment failed ${res.status}: ${text}`);
console.log(text);
NODE
```

Verified current route shape:

- `POST $PAPERCLIP_API_BASE/issues/:issueId/comments`

## Upload an attachment

Use multipart `form-data` with field name `file`. Add `issueCommentId` when the
file supports a specific comment. Detect MIME type conservatively; images and
videos should retain their real type.

```bash
export FILE="/absolute/path/to/evidence.png"
export COMMENT_ID="optional-comment-uuid"

node --input-type=module <<'NODE'
import { readFileSync } from 'fs';
import { basename } from 'path';
const api = process.env.PAPERCLIP_API_BASE;
const company = process.env.PAPERCLIP_COMPANY_ID;
const issueId = process.env.ISSUE_ID;
const file = process.env.FILE;
const commentId = process.env.COMMENT_ID || '';
const ext = file.toLowerCase().split('.').pop();
const typeByExt = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', log: 'text/plain',
};
const bytes = readFileSync(file);
const form = new FormData();
form.append('file', new Blob([bytes], { type: typeByExt[ext] || 'application/octet-stream' }), basename(file));
if (commentId) form.append('issueCommentId', commentId);
const res = await fetch(`${api}/companies/${company}/issues/${issueId}/attachments`, {
  method: 'POST',
  body: form,
});
const text = await res.text();
if (!res.ok) throw new Error(`attachment upload failed ${res.status}: ${text}`);
console.log(text);
NODE
```

Verified current upload route:

- `POST $PAPERCLIP_API_BASE/companies/:companyId/issues/:issueId/attachments`

## Verify attachments and content round-trip

List attachments:

```bash
curl -fsS "$PAPERCLIP_API_BASE/issues/$ISSUE_ID/attachments" | jq .
```

Download by returned `contentPath`:

```bash
CONTENT_PATH="/api/attachments/<attachment-id>/content"
curl -fsS "$PAPERCLIP_ORIGIN$CONTENT_PATH" -o /tmp/paperclip-attachment-check
```

Hash check:

```bash
shasum -a 256 "$FILE" /tmp/paperclip-attachment-check
```

A screenshot/video gate is incomplete until the file exists locally, upload
succeeds, `GET /issues/:id/attachments` lists it, and the content hash or byte
size matches the local file.

## Stage comment templates

Use the structured role comment command above with these `EVENT_TYPE` values and
body content:

- Planning: `planning_pass` — brief, accepted scope, allowed/forbidden paths,
  risks, test/evidence plan, approval state.
- Implementation start: `implementation_started` — branch/work folder, files to
  touch, upstream token/plan, current blocker state.
- Implementation finish: `implementation_complete` — changed files, behavior,
  commands run, artifacts, residual risks.
- Handoff: `handoff` — from role, to role, prior token, next action, required
  evidence path.
- Blocker: `blocked` — exact owner/action, failing command or missing decision,
  why work cannot safely continue.
- Verification: `verification_pass` or `verification_failed` — acceptance checks,
  command outputs, exit codes, untested gaps, verdict.
- Security: `security_pass` or `security_failed` — reviewed scope, findings,
  severity, data/auth/secret risks, terminal SECURITY token when applicable.
- Browser/Visual QA: `browser_qa_pass`, `browser_qa_failed`, or
  `browser_qa_blocked` — routes/devices, screenshots/videos, reproduction steps,
  credentials/app blockers, exact artifact IDs.
- PR status: `pr_status` — PR URL, base/head, No Mistakes run id, CI/checks,
  reviewer routing, review status, actionable comments.
- Self-improvement: `improvement_review`, `improvement_noop`, or
  `improvement_not_applicable` — owner/reviewer, source coverage, missing
  coverage, verdict, run artifact, proposal/follow-up IDs or explicit no-op,
  and trust model. This
  is mandatory before Ship to PR, Done, closed, or final disposition for every
  Dark Factory run.
- Final disposition: `final_disposition` — done/cancelled/blocked, shipped or
  no-PR reason, evidence summary, remaining follow-ups.

## Decision escalation standing order

If any decision, approval, option selection, write-scope change,
identity/security tradeoff, PR/push choice, or owner action is needed:

1. Stop the work that depends on the decision.
2. Comment visibly on the Paperclip ticket with `EVENT_TYPE=decision_needed`.
3. Return to Samuel visibly in Telegram via OpenClaw/coordinator with the same
   decision request.
4. Do not leave the required decision only in a run folder, ledger, hidden
   memory, or ticket status.

Decision comments must name exactly one owner and the smallest concrete action
needed. Avoid generic "approval needed" loops.

## Bounded backfill policy

Backfill is allowed only when Samuel or the task explicitly asks for it.

Allowed backfill:

- recent active tickets only: `todo`, `in_progress`, `in_review`, or `blocked`
  tickets updated in the last 14 days, plus direct parent/child tickets needed
  to explain current state.
- Factual comments derived from real artifacts: existing run folders, ledgers,
  command logs, screenshots/videos, PR URLs, Git history, or Paperclip comments.
- Existing evidence files uploaded as attachments when they still exist and are
  relevant.

Forbidden backfill:

- no fabricated historical role comments.
- Invented screenshots/videos or regenerated images claimed as old evidence.
- Reconstructed agent dialogue, fake timestamps, fake approvals, fake PR status,
  or fake gate tokens.
- Importing secrets, restricted credentials, or private customer data.

Every backfill comment must say it is a backfill, cite the source artifact, and
state that Option B attribution is advisory/display-only.

## Fail-closed coverage rule

When a task requires Paperclip-visible evidence, local run-folder evidence alone
is not enough for board readiness. Paperclip comments/attachments are required
for visibility, but they are not sufficient by themselves: verification must
also check the underlying artifacts and commands. Missing board visibility keeps
the ticket out of Ship to PR / Done unless Samuel explicitly waives it.
