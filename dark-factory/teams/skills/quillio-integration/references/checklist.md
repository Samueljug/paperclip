# Pre-PR Checklist

Run before opening a PR. Every item must be ticked.

## Module Hygiene

- [ ] Every new file < 500 lines (`find modules/integrations/<partner> -name '*.py' | xargs wc -l | sort -rn | head -20`)
- [ ] Directory layout matches the canonical tree (api / services / mappers / models / utils / tasks.py)
- [ ] `__init__.py` files exist and are EMPTY (no public re-exports)
- [ ] No imports from `app.services.smokeball|actionstep|clio` or `modules.integrations.<other>`

## Lint & Format

- [ ] `flake8 modules/integrations/<partner>/` clean
- [ ] `ruff check modules/integrations/<partner>/` clean
- [ ] Pre-commit hook present (`ls .git/hooks/pre-commit`)
- [ ] No commented-out code blocks
- [ ] No `# TODO(quillio:<partner>)` markers left in shipped code

## Wiring

- [ ] `app/main.py` includes the router (`app.include_router(<partner>_router)`)
- [ ] `app/tasks.py` imports the Celery task entries (with `# noqa: F401`)
- [ ] `app/settings.py` declares all `<partner>_*` settings + defaults documented
- [ ] `.env.example` updated with the new env var names

## Auth

- [ ] OAuth `state` is verified on callback (CSRF protection)
- [ ] Tokens stored in `integration_tokens` collection with `provider="<partner>"`
- [ ] Token refresh uses Redis distributed lock
- [ ] Multi-region partners read tenant URL from OAuth response, not hardcoded
- [ ] Refresh failure marks user `status="disconnected"`
- [ ] No tokens in logs (use `_redact()` helper)

## HTTP Client

- [ ] Single `httpx.AsyncClient` per `<Partner>Client` instance
- [ ] All requests go through one `_request` chokepoint
- [ ] 401 raises typed `AuthFailedError` (not generic Exception)
- [ ] 429 respects `Retry-After`, caps individual sleep at 120s
- [ ] 5xx retries up to 3 with exponential backoff
- [ ] Pagination has hard cap (≤ 50,000 rows)
- [ ] Presigned URL detection strips Authorization header
- [ ] `Idempotency-Key` header on POSTs that create resources

## Webhooks (skip section if partner has no webhooks)

- [ ] Signature verified before any work
- [ ] Returns 200 within milliseconds; real work in background
- [ ] Nonce dedup via Redis (5-min TTL)
- [ ] Timestamp window check (5-min)
- [ ] Per-event handlers (not one fat method)
- [ ] User fan-out: firm-based AND entity-based, intersected
- [ ] Per-user signing key (default) or per-firm if partner mandates
- [ ] Re-auth rotates webhook + secret

## Jobs

- [ ] Uses `JobEngine` + `IntegrationJob` (not custom collection)
- [ ] Progress published to Redis pub/sub via `JobProgressService`
- [ ] Cancellation via Redis flag, polled frequently
- [ ] WebSocket auth via `?token=<jwt>` query param
- [ ] Concurrency capped (`asyncio.Semaphore(4)` is the OneLaw default)
- [ ] Rollback markers (`old_docs` + `rollback_marker`) on partial failure
- [ ] Idempotent: re-running with same job_id is safe
- [ ] Background cleanup task (`cleanup_stuck_<partner>_imports`) registered

## Sync State

- [ ] External ID stored as `<partner>_doc_id` (matches OneLaw `sp_doc_id` convention) + `provider`
- [ ] `ownerId = user_email` filter on every MongoDB query (multi-tenant)
- [ ] Smart-sync conflict resolution implemented (only if bidirectional)
- [ ] Echo detection (skip webhook within 60s of our reverse sync)
- [ ] Audit trail entry written on every action (`<partner>_sync_events` collection)
- [ ] Folder `document_count` denormalised and kept in sync

## Proxy Tokens (skip if no download proxy)

- [ ] HS256 JWT, 5-min TTL
- [ ] Claims: `{sub, doc, exp, purpose}`
- [ ] Verified on every proxy request
- [ ] No bearer tokens in URLs anywhere

## Tests

- [ ] Unit tests for auth, client, service, webhook, mappers, tasks
- [ ] Integration test for OAuth round-trip
- [ ] Integration test for webhook delivery
- [ ] Integration test for import job end-to-end
- [ ] Coverage > 70% (`pytest --cov=modules/integrations/<partner> --cov-fail-under=70`)
- [ ] Frontend Vitest tests for service, composables, components
- [ ] All tests pass on CI

## Frontend

- [ ] Service registered in `frontend-legal/app/plugins/03.service-provider.ts`
- [ ] Sidebar/menu entry added
- [ ] ConnectButton handles OAuth round-trip + connection-status polling
- [ ] MatterBrowser supports search + pagination + selection
- [ ] ImportModal subscribes to WebSocket progress + handles disconnect
- [ ] No console errors, no `any` types
- [ ] `yarn typecheck` clean
- [ ] `yarn lint` clean
- [ ] `yarn test` passes

## Docs

- [ ] `modules/integrations/<partner>/README.md` documents:
  - Capability matrix (what was built, what was skipped, why)
  - Known limitations
  - Manual reconnect procedure
  - On-call runbook (what to check when imports fail)
- [ ] Settings documented in `.env.example`

## Security

- [ ] Webhook signature verification timing-safe (`hmac.compare_digest`)
- [ ] Tokens encrypted at rest (or DB-level encryption documented)
- [ ] No sensitive data in error messages returned to FE
- [ ] OAuth state token has 5-min TTL (Redis)
- [ ] Rate-limit own callbacks against the partner

## Observability

- [ ] Structured logs use `[<PARTNER>_<AREA>]` prefix
- [ ] Sentry breadcrumbs / context tags include `provider="<partner>"` + `user_email`
- [ ] Job failures captured with stack trace
- [ ] Webhook signature failures logged at WARNING (not silent)

## On-Call Readiness

- [ ] Health check endpoint added to `/checks` if partner has a status API
- [ ] Runbook entry: how to manually re-trigger a failed sync
- [ ] Runbook entry: how to check token refresh state
- [ ] Runbook entry: how to verify webhook delivery

## Final

- [ ] PR description references `quillio-integration` skill use
- [ ] PR description includes screenshots of FE flow
- [ ] PR description lists settings/env-var changes
- [ ] PR has `do not merge` label until review complete; flipped to `ready to merge` after deep review (per `CLAUDE.md` rule)
