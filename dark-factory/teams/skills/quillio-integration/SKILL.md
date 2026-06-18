---
name: quillio-integration
description: Master skill for building a new third-party legal-practice-management integration in the AILA backend (Modular Monolith). Use when the developer mentions integrating a new partner (e.g. LEAP, MyCase, PracticePanther, NetDocuments, iManage, ProLaw, AbacusLaw), pastes partner API docs, asks "how do I add a new integration", says "build the X integration", or starts work on connecting a new external legal SaaS. This skill walks the discovery and decision tree, then dispatches to quillio-integration-backend, quillio-integration-frontend and quillio-integration-tests skills for the actual implementation. Always invoke this BEFORE the sub-skills so capability mapping and architectural decisions are made up-front.
---

# Quillio Integration — Master Skill

**SCOPE:** Project-wide. Backend lives in `backend-legal/`, frontend in `frontend-legal/`. Operates inside the AILA Modular Monolith.

## Strict Task Scope (NON-NEGOTIABLE)

Only build or modify integration files, behaviour, tests, docs, and UI explicitly authorised by the accepted task/plan. Adjacent partner capabilities, refactors, cleanup, copy/design changes, and architecture ideas become follow-up items for Samuel unless explicitly approved.

**CANONICAL REFERENCE INTEGRATION:** OneLaw — `backend-legal/modules/integrations/onelaw/backend/`. Every decision defaults to "what does OneLaw do?" unless the partner's API docs force otherwise.

**INTEGRATIONS YOU MUST AVOID COPYING:** Smokeball (`app/services/smokeball.py`, 2,751 lines), Actionstep (`app/services/actionstep.py`, 3,603 lines), Clio (`app/integrations/clio/api.py`, 2,654 lines). These are legacy monoliths kept running but not extended. Read `references/anti-patterns.md` before writing any code.

---

## When To Use This Skill

- Developer pastes a partner API doc / OpenAPI spec / SDK link.
- "Add the {Partner} integration."
- "How do I connect {Partner} to AILA?"
- "Build a OneLaw-style integration for {Partner}."
- New ticket references a partner not already under `modules/integrations/`.

If the request is purely about **modifying an existing** OneLaw / Clio / Smokeball / Actionstep flow, do NOT invoke this skill — use `bug-fixer`, `feature-improver`, or `son-of-dom` instead.

---

## Mandatory Pre-Flight (do this BEFORE writing any code)

Run through these checks in order. Do not skip. If a check cannot be answered, stop and ask the developer.

### 1. Read the Partner Docs

The developer must hand you at minimum:
- Auth flow specification (OAuth 2.0? API key? signed JWT? mutual TLS?)
- Base URL(s) — production + sandbox + multi-region if applicable
- Endpoint catalogue (matters/cases, documents, folders, contacts, billing, custom fields, etc.)
- Webhook contract (event types, signature header format, retry behavior, replay window)
- Rate-limit policy (req/sec, burst, headers returned on 429)
- Pagination scheme (offset/limit, page/pageSize, cursor, link header)
- File upload contract (single PUT? multipart? chunked? presigned S3?)
- Error response shape

If any of these is missing, ask the developer to find it. Do not guess. Do not invent.

### 2. Capability Matrix

Fill in this table. Every "no" or "n/a" simplifies the build.

| Capability | Yes/No | Notes |
|---|---|---|
| OAuth 2.0 (auth code grant) | | If no, document the alternate auth mechanism |
| Refresh tokens | | If no, prompt user to reconnect on expiry |
| Multi-region / tenant URL discovery | | If yes, where in the OAuth response does the tenant URL live? |
| Webhooks | | If no, skip the webhook reference doc |
| Webhook signature scheme | | HMAC-SHA256 over what payload? |
| Per-firm / per-user signing key | | Default per-user; per-firm only if partner mandates |
| Rate-limit headers on 429 | | `Retry-After`? Custom? |
| Pagination | | offset/limit, page/pageSize, cursor, or link header |
| File upload | | single, chunked, presigned URL, or partner-managed |
| Document categories / tags | | Map to AILA Tags? |
| Folder hierarchy | | Flat, single-level, or arbitrary depth |
| Bidirectional sync needed | | If yes, smart-sync conflict resolution required |

### 3. Decision Tree → Sub-Skill Dispatch

| Need | Skill to Invoke | When |
|---|---|---|
| Backend implementation (always required) | `quillio-integration-backend` | After capability matrix is filled |
| Frontend (connect button, browse, import UI) | `quillio-integration-frontend` | If the integration is user-visible |
| Tests (mandatory per Quillio rules) | `quillio-integration-tests` | After backend code exists |

Backend skill always comes first. Frontend skill can run in parallel with tests skill.

---

## Architectural Non-Negotiables

These rules are inherited from `backend-legal/CLAUDE.md`, `.techdebt/architecture.md`, and the OneLaw reference implementation. The sub-skills enforce them; this is the summary.

1. **Module location**: `modules/integrations/<partner>/backend/{api,services,mappers,models,utils}` plus `tasks.py`. Frontend mirror lives at `frontend-legal/app/{services,composables,components,pages}/<partner>/`.
2. **File-size budget**: hard cap 500 lines per file. If a file approaches 400 lines, split it. The Smokeball/Actionstep service files at 2,700+ and 3,600+ lines are the warning sign.
3. **Layered service architecture**: Router → Service → Client → External API. Webhook → WebhookService → Service → Client. Never skip a layer; never let the router talk to the client directly.
4. **Module isolation**: Imports allowed from `app.*`, `app.integrations.core.*`, and `modules.integrations.<self>.backend.*`. NEVER import from another integration's internals (`modules.integrations.clio.backend.services.clio_service` is forbidden from the OneLaw module).
5. **JobEngine**: All async work goes through `app.integrations.core.jobs.engine.JobEngine` + `JobProgressService`. Do not roll a custom `import_jobs` MongoDB collection (that is the Clio anti-pattern).
6. **Tenant key**: `ownerId = user_email` on every MongoDB document. Every query filters by `ownerId`. No exceptions.
7. **Token storage**: `integration_tokens` MongoDB collection (the OneLaw shape). Do NOT use `EncryptedStringField` MongoEngine documents (the Smokeball pattern) for new integrations.
8. **Refresh under concurrency**: Redis distributed lock keyed by `<partner>:refresh_lock:{user_email}`. Pattern is in `quillio-integration-backend/references/auth.md`.
9. **Webhook security**: HMAC-SHA256 verify + Redis nonce dedup (5min TTL) + timestamp window (5min) + return 200 immediately + dispatch to background task. Pattern is in `quillio-integration-backend/references/webhooks.md`.
10. **Job pattern**: Celery task → `JobEngine` record → progress over Redis pub/sub `integration_job_progress:{job_id}` → WebSocket stream → cancellation via Redis flag. Never block the HTTP request.
11. **Sync state**: External ID stored as `<partner>_doc_id` (matches OneLaw `sp_doc_id` convention) plus `provider` and `integration` fields. Smart-sync conflict resolution required if bidirectional.
12. **Audit trail**: Every sync action writes to `<partner>_sync_events` MongoDB collection with `PipelineTracker` step durations.
13. **Proxy tokens**: 5-minute HS256 JWT with claims `{sub, doc, exp, purpose}`. Used for download URLs handed to Syncfusion / ConvertAPI / browser. Never embed bearer tokens in URLs.
14. **Lint gates**: Code must pass `flake8` AND `ruff check`. Pre-commit hook is mandatory (per repo `CLAUDE.md`).
15. **Tests**: Required. Coverage targets in `quillio-integration-tests`. No PR merges without tests.

---

## Anti-Patterns (Hard No)

See `references/anti-patterns.md` for the full list with file:line refs. Headlines:

- ❌ Monolithic service class (Smokeball 2,751 / Actionstep 3,603 lines)
- ❌ Lazy global service singletons in router files (`_smokeball_service_instance = None`)
- ❌ Mixed auth secrets in one MongoEngine document (Smokeball `access_token` + `refresh_token` + `webhook_key` together)
- ❌ Cross-integration imports (`from app.integrations.clio.service import ...` inside `actionstep.py`)
- ❌ Fat webhook event processor handling every event type in one method
- ❌ `asyncio.run()` inside Celery task (use the JobEngine async helpers instead)
- ❌ Hardcoded region in base URL (Actionstep `ap-southeast-2.actionstep.com` — use the `api_endpoint` from the OAuth response instead)
- ❌ Pagination as unbounded `while True` (always have a hard cap, e.g., 50,000 rows max)
- ❌ Custom `import_jobs` MongoDB collection (use `JobEngine`)
- ❌ Webhook event handled synchronously in HTTP handler (return 200 immediately, dispatch to background)
- ❌ Building a new integration without writing tests

---

## Standard Build Sequence

After pre-flight is complete:

1. **Backend skeleton** — Skill `quillio-integration-backend`. Produces module tree, all stubs, lint-clean.
2. **Wire-up** — Add router include in `backend-legal/app/main.py`. Add Celery task import in `backend-legal/app/tasks.py`. Both are documented in `quillio-integration-backend/references/router-wiring.md`.
3. **Backend tests** — Skill `quillio-integration-tests`. Mocks for partner API, fixtures for `JobEngine`, integration test for OAuth round-trip.
4. **Frontend** — Skill `quillio-integration-frontend`. Types, service, composable, page, ConnectButton, MatterBrowser, ImportProgress.
5. **Frontend tests** — Same skill.
6. **End-to-end smoke** — Manually exercise OAuth + list matters + import 1 doc + receive 1 webhook in dev.
7. **Pre-PR checklist** — `references/checklist.md`.

---

## Pre-PR Checklist

Run before opening a PR. See `references/checklist.md` for the full list.

- [ ] All files < 500 lines
- [ ] `flake8` clean
- [ ] `ruff check` clean
- [ ] Tests pass; coverage > 70% on the new module
- [ ] Pre-commit hook present (`ls .git/hooks/pre-commit`)
- [ ] Router included in `app/main.py`
- [ ] Celery task imported in `app/tasks.py`
- [ ] Settings vars added to `app/settings.py`
- [ ] No imports from another integration's internals
- [ ] No hardcoded region in base URL
- [ ] OAuth refresh uses Redis lock
- [ ] Webhook verifies signature + dedups nonce + returns 200 + dispatches background
- [ ] Job uses `JobEngine` + `JobProgressService` (not custom collection)
- [ ] Audit trail writes to `<partner>_sync_events`
- [ ] Frontend ConnectButton + MatterBrowser + ImportProgress wired
- [ ] No tokens in URLs (use proxy-token pattern for downloads)
- [ ] Documentation: `modules/integrations/<partner>/README.md` describes capabilities + known limitations

---

## Reference Docs

- `references/architecture.md` — Module layout, layered service rules, file-size budget, wiring points
- `references/decision-tree.md` — Capability-to-pattern mapping; what to build for each "yes/no" in the matrix
- `references/anti-patterns.md` — Detailed list with file:line refs from Smokeball / Actionstep / Clio
- `references/checklist.md` — Pre-PR gate

## Sub-Skills

- `quillio-integration-backend` — Backend implementation (auth, client, webhooks, jobs, sync, router, mappers, models)
- `quillio-integration-frontend` — Frontend implementation (types, service, composables, page, components)
- `quillio-integration-tests` — pytest harness, mocks, fixtures, coverage targets
