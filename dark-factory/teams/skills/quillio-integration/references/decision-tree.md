# Decision Tree — Capability → Pattern

For each row in the capability matrix from the master skill, this maps to what gets built.

## Authentication

| Partner Auth | What to Build |
|---|---|
| OAuth 2.0 authorization code grant + refresh tokens | Standard OneLaw flow. `services/<partner>_auth.py` with `get_auth_url`, `exchange_code_for_token`, `refresh_credentials` (Redis-locked). |
| OAuth 2.0 without refresh tokens | Same shape; `refresh_credentials` raises `NotImplementedError`. Mark user disconnected on token expiry; FE prompts re-auth. |
| OAuth 2.0 with PKCE | Add `code_verifier`/`code_challenge` to auth URL + token exchange. Store verifier in Redis keyed by state. |
| Long-lived API key | Skip OAuth flow entirely. `auth.py` exposes `save_api_key(user_email, key)` + `get_api_key`. Router endpoint `PUT /auth/api-key`. |
| Signed JWT bearer (service account) | One-time setup of private key per firm. `auth.py` mints short-lived JWTs on demand using `jwt.encode(payload, private_key, alg="RS256")`. |
| mTLS | Configure `httpx.AsyncClient(verify=..., cert=...)` per user. Cert paths stored as Redis-cached temp files. |
| HMAC-signed requests (no token) | Skip token exchange. Sign each request in `client.py._request` using `hmac.new(secret, canonical_request)`. |

## Multi-Region / Tenant Discovery

| Partner | What to Build |
|---|---|
| Single global API URL | `client.__init__(base_url=settings.<partner>_api_base_url)`. Done. |
| Tenant-specific URL discovered via OAuth response field | Capture `api_endpoint` from token exchange response, store in `integration_tokens.api_base_url`, instantiate client with stored URL. |
| Tenant URL discovered via separate config service call | Add `_resolve_tenant_url(firm_id, access_token)` that hits config endpoint after token exchange (OneLaw pattern). |
| Region selection by user choice at OAuth time | Add `region` query param to `/auth/login`, encode into state, pick base URL on callback. |

## Webhooks

| Partner | What to Build |
|---|---|
| No webhooks | Skip `<partner>_webhook.py` entirely. Skip `/webhook` and `/webhook-key` router endpoints. Skip webhook-key DB fields. Sync only happens on user-triggered import. |
| Webhooks with HMAC-SHA256 signature (header) | Standard OneLaw flow. `_verify_signature` over `{webhook_id}.{timestamp}.{body}`. |
| Webhooks with simple shared-secret query param | Verify via `hmac.compare_digest(query.secret, stored_secret)`. Still apply nonce dedup. |
| Webhooks with signed JWT in header | Verify with `jwt.decode(header_token, public_key, algorithms=["RS256"])`. |
| Webhooks with retries but no idempotency key | Use `(event_type, resource_id, timestamp)` as Redis dedup key. |
| Webhooks scoped per-firm | Per-firm signing key (OneLaw pattern). Save to all users in firm. |
| Webhooks scoped per-user | Per-user signing key (default — Clio pattern). |

## Pagination

| Partner | What to Build |
|---|---|
| `offset` + `limit` | OneLaw pattern. Loop in client method with hard cap 50,000. |
| `page` + `page_size` | Same loop, just compute `offset = (page-1)*page_size` if you want to expose offset upstream. |
| Cursor / continuation token | Loop reading `response['next_cursor']` until empty. Hard cap 50,000. |
| Link header (RFC 5988) | Parse `Link: <...>; rel="next"` via `httpx.Response.links`. Loop until `next` absent. |
| Streaming / unbounded | Wrap in `async for` generator. Cap per-job document count up front. |

## Rate Limiting

| Partner | What to Build |
|---|---|
| 429 with `Retry-After` (seconds or HTTP-date) | Parse, sleep, retry. Cap individual sleep at 120s, total retries at 30. |
| 429 with custom header (`X-RateLimit-Reset`, etc.) | Same pattern; parse the partner's specific header. |
| 429 with no info | Exponential backoff: 1, 2, 4, 8, 16, 32, 60, 60, 60s. |
| Per-second token bucket published in headers (`X-RateLimit-Remaining`) | Pre-emptively throttle in `client._request`: if `remaining < threshold`, sleep till `reset`. |
| Hard daily quota | Track usage in Redis counter `<partner>:daily_calls:{user_email}:{YYYY-MM-DD}`. Refuse calls when over. |

## File Upload

| Partner | What to Build |
|---|---|
| Single PUT/POST with full body | `client.upload_file_content(url, content, filename)`. |
| Chunked (`?part_count=N&part_number=i`) | `_upload_in_chunks(file_data, chunk_size=5MB)` — Actionstep model. Last chunk's response carries final file ID. |
| Get presigned S3 URL then PUT | Two-step: `get_upload_ticket()` returns presigned URL + `upload_id`; `upload_file_content(presigned_url, content)` PUTs; `create_document_record(upload_id, metadata)` registers. OneLaw pattern. |
| Upload via partner-managed temp storage | Same two-step but with partner's storage primitives. |

## Bidirectional Sync

| Need | What to Build |
|---|---|
| Read-only (import partner → AILA) | Skip reverse sync. Skip `ready_to_sync` flag. Skip echo detection. |
| Write-back (AILA edits → partner) | Add `services/<partner>_sync_runner.py` for reverse sync. Set `ready_to_sync=true` in document record; Celery beat polls and pushes. |
| Real-time sync via webhooks | Smart-sync conflict resolution required (see `quillio-integration-backend/references/sync-state.md`). Echo detection: skip webhook events that arrive < 60s after our own write. |

## Document Categories / Tags

| Partner | What to Build |
|---|---|
| No categories | Skip. |
| Categories per matter / per client | Mirror to AILA Tags. Maintain `tag_name_map` in import job to dedup. OneLaw pattern. |
| Hierarchical category tree | Flatten or build full tree mirror; depends on UX needs. Default flat. |

## Folders

| Partner | What to Build |
|---|---|
| Flat (no folders) | Documents land in matter root. Skip folder mirroring. |
| Single-level folders per matter | One-shot folder fetch + create. |
| Arbitrary depth folder tree | Full hierarchy mirror with parent-chain walking. See `folder-mirroring.md`. Hard cap depth = 50, breadth = 50,000. |

## Frontend Surface

| Need | Build |
|---|---|
| Connect + browse + import | Standard pages + components in `quillio-integration-frontend`. |
| Admin-only connection (no end-user UI) | Skip MatterBrowser/ImportModal. Build `WebhookKeyAdmin` + connection-status panel only. |
| Embedded sidebar (no full page) | Build components only; mount in existing parent page. |
