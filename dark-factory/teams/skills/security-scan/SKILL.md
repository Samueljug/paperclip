---
name: security-scan
description: Runnable security-review checklist for Quillio changes — concrete grep/scan patterns for tenant isolation, data sovereignty, authz, data exposure, injection, and secrets, plus the repo's own scanners. Use for any security pass on a diff so findings are reproducible, not impressionistic. Keywords - security, tenant, firm_id, sovereignty, injection, SSRF, prompt injection, PII, secrets, gitleaks, authz.
allowed-tools: Bash, Read, Grep
---

# Security Scan (reproducible checklist)

Turn the security review into commands. Run the relevant patterns against the
changed files and trust evidence over impression. Report each finding as
`file:line` + the exploit path + the minimal fix. Default-fail: if a path can't
be verified, report it as a blocking unverified gap, not a pass. Report only — do
not edit product code unless explicitly authorized.

## Secrets (run first, every time)

- Use the repo's scanner: `gitleaks detect --no-banner` (it's in pre-commit).
- Quick grep: `grep -rniE "api[_-]?key|secret|password|token|bearer |-----BEGIN" <changed>`
- Never print secret values; report location only.

## Tenant isolation (CRITICAL — cross-firm leakage)

- Find the tenant key and context: `grep -rn "firm_id\|get_current_firm\|current_tenant" app`
- Unscoped reads (suspect): `grep -rnE "\.objects\(|\.find\(|aggregate\(" <changed>`
  — for each, confirm a `firm_id`/tenant filter is present.
- Lookup-by-id (IDOR): any `get(id=...)` / `objects(id=...)` must also scope to the
  caller's firm.
- Cache keys: `grep -rnE "cache|redis|set\(|get\(" <changed>` — keys must include
  the firm.
- Celery tasks: firm context passed explicitly into the job, not read from a
  global.

## Data sovereignty (ap-southeast-2)

- New egress/SDKs/LLM calls: `grep -rniE "http[s]?://|requests\.|httpx|boto3|client\(|invoke_model|bedrock|openai|anthropic" <changed>`
  — prove each destination/region is approved; an unpinned region or global
  endpoint is a finding.
- Logging/telemetry of content or prompts leaving region is a finding.

## AuthZ / access control

- New endpoints: `grep -rnE "@router\.(get|post|put|delete|patch)" <changed>` —
  each must have the right auth dependency AND an action-level permission/role
  check, not just "is authenticated".
- Admin / super-admin / cross-account paths gated; no privilege escalation by
  changing an id.

## Data exposure / PII

- Serializers/responses over-exposing fields; error handlers leaking stack/queries.
- PII or document content in logs: `grep -rniE "logger|logging|print\(" <changed>`
  — confirm no client content, prompts, or auth material is logged.

## Injection / SSRF / prompt injection

- DB: string-built queries or unsanitized operators (`$where`, dict operator
  injection). Confirm parameterized/safe builders.
- Shell/eval from input; path traversal from user-controlled filenames.
- SSRF: server-side fetch with a user-influenced URL.
- Prompt injection: untrusted content (documents, web text, user messages) flowing
  into an LLM prompt or tool call — treated as data, not instructions.

## Optional deeper scans (only if already available in the work area)

- `semgrep --config auto <changed>` and `ast-grep` for structural rules. Do not
  install anything global; if absent, fall back to the greps above and note it.
