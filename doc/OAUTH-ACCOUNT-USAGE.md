# OAuth Account Usage Report

Paperclip exposes an operator report at **Company -> OAuth Usage** and:

```text
GET /api/companies/:companyId/oauth-account-usage
```

The endpoint is board-only and company-access checked before it reads local model account state.

## What It Reports

- Provider/tool: Antigravity `agy`, Gemini CLI, Codex CLI, and Claude CLI where local state is safely discoverable.
- Account identifier when exposed by local metadata or logs, usually an email address.
- Auth source type and evidence source paths.
- Selected model evidence when a tool stores or logs it.
- Quota windows when an existing OAuth quota endpoint exposes them.
- Quota exhaustion/reset evidence from safe local logs when exact quota is not exposed.
- Local Gemini chat-log counts, deduped by session/message/timestamp/type.
- Last checked timestamp and provider limitations.

## Secret Handling

The report must not return OAuth access tokens, refresh tokens, ID tokens, auth codes, API keys, bearer tokens, environment dumps, or raw prompt/response logs. Secret-bearing files are only used as presence and mtime evidence. Evidence snippets are redacted before leaving the server.

## Provider Limits

Antigravity and classic Gemini CLI do not currently expose exact remaining OAuth quota in stable local metadata. Paperclip reports selected/authenticated model evidence, recent safe usage counts, and the latest quota/reset error lines such as `RESOURCE_EXHAUSTED` when present. It does not invent remaining requests.

Codex and Claude reuse the existing adapter quota helpers. If their OAuth usage endpoints return windows, the report shows those windows. If they fail or return no windows, Paperclip reports the failure honestly and falls back to local auth/config evidence.

Local usage summaries are evidence, not billing authority. Use provider dashboards or official usage APIs for authoritative billing and quota decisions when available.
