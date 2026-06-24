---
name: quillio-integration-tests
description: Write meaningful, extensive pytest tests for a new AILA legal-practice-management integration backend, plus Vitest tests for the frontend. Use when the developer needs unit tests for auth/client/service/webhook/tasks, integration tests for OAuth round-trip and webhook delivery, and frontend tests for composables/components. Mandatory before merging any new integration. Trigger words: "test the {partner} integration", "write tests for the webhook", "add coverage for the import job", "mock the {partner} API". Always invoke after at least the backend skeleton exists.
---

# Quillio Integration — Tests Builder

**SCOPE:** `backend-legal/tests/` + `frontend-legal/tests/` (or alongside source files in `*.test.ts`).

## Strict Task Scope (NON-NEGOTIABLE)

Only create or modify tests for the integration files, behaviour, and acceptance criteria explicitly authorised by the accepted task/plan. Unrelated test debt or product issues become follow-up items for Samuel unless explicitly approved.

**HARD RULE:** Coverage > 70% on every new module. No PR merges without tests. Per `backend-legal/CLAUDE.md`.

---

## Backend Tests (pytest)

### Mandatory Sequence

#### Step 1: Test Layout

Create:

```
backend-legal/tests/
├── unit/
│   └── integrations/
│       └── <partner>/
│           ├── __init__.py
│           ├── conftest.py                 # partner-specific fixtures
│           ├── test_<partner>_auth.py
│           ├── test_<partner>_client.py
│           ├── test_<partner>_service.py
│           ├── test_<partner>_webhook.py
│           ├── test_<partner>_mappers.py
│           └── test_<partner>_tasks.py
└── integration/
    └── integrations/
        └── <partner>/
            ├── __init__.py
            ├── test_oauth_roundtrip.py
            ├── test_webhook_delivery.py
            └── test_import_job_e2e.py
```

#### Step 2: Fixtures

`conftest.py` provides:

- `mock_<partner>_settings` — patches `app.settings.settings.<partner>_*`
- `mock_<partner>_credentials` — returns a fake `<Partner>Credentials` object
- `mock_<partner>_client` — `respx`-backed httpx mock with canned responses for every endpoint the client calls
- `mock_redis` — `fakeredis.aioredis` instance
- `mock_motor_db` — in-memory mongo via `mongomock` or `pytest-asyncio` fixture against a test DB
- `mock_celery` — `celery.contrib.testing.worker.start_worker` for inline task execution

#### Step 3: Auth Tests

Cover at minimum:

- `get_auth_url` returns URL with required query params + state
- `exchange_code_for_token` posts correct body, returns parsed token dict
- `exchange_code_for_token` extracts firm ID from JWT extension claim, falls back through alternates
- `_resolve_tenant_url` calls config service, falls back to default on failure
- `save_credentials` upserts with status="connected"
- `get_credentials` returns None when status="disconnected"
- `refresh_credentials` posts refresh_token grant, updates token + expiry
- `refresh_credentials` marks status="disconnected" on 400 response
- `refresh_credentials` is locked: two concurrent calls only execute one network round-trip (Redis lock)
- `save_webhook_signing_key` stores per-user (default)
- `get_webhook_signing_key` returns None for users without key

#### Step 4: HTTP Client Tests

Cover:

- 2xx happy path returns parsed JSON
- 204 returns `{}`
- 401 raises `AuthFailedError`
- 404 raises `NotFoundError` when `raise_on_404=True`, returns `None` otherwise
- 429 with `Retry-After: 5` sleeps 5s and retries (use `respx` + `freezegun`)
- 429 without `Retry-After` uses exponential backoff (1, 2, 4, 8…)
- 5xx retries up to 3 then raises
- Pagination loop walks until empty page or hard cap
- Presigned URL detection strips Authorization header
- Idempotency-Key header attached to upload-ticket POST

#### Step 5: Service Tests

Cover:

- `get_client` returns None for disconnected user
- `get_client` triggers refresh when token expired
- `get_client` adds client to `_active_clients`
- `cleanup` closes every active client
- `list_matters` calls correct client method, applies mappers, saves MRU async
- `unified_search` runs both endpoints in parallel via `asyncio.gather`
- `import_documents` creates `IntegrationJob` and dispatches Celery task
- `get_proxy_document_url` mints token and returns full URL

#### Step 6: Webhook Tests

Cover (skip if partner has no webhooks):

- `verify_signature` returns True for valid HMAC + correct key
- `verify_signature` returns False for wrong key
- `verify_signature` falls back to global key when per-user key missing
- `process_event` routes each event type to correct handler
- `_handle_document_event` finds users by firm AND by entity, intersects when both available
- `_find_owners_by_firm` filters disconnected users
- `_extract_ids` normalises both nested and flat payload shapes
- Document metadata pre-fetch uses first owner's credentials
- All handlers swallow exceptions (never raise to caller)
- Router endpoint returns 200 even on internal failure

#### Step 7: Task Tests

Cover:

- `process_<partner>_import_job` happy path: sets status to PROCESSING, processes items, sets COMPLETED
- Cancellation: Redis flag set → task exits early, status CANCELLED
- Smart-sync skip: existing AILA doc with newer timestamp → no API download, sync event logged with reason
- Smart-sync echo: webhook within 60s of reverse sync → skip
- Failure of one document does not fail the whole job
- Rollback markers cleared on success and on cancel
- Job retry on transient `httpx.HTTPError` (max_retries=5)

#### Step 8: Mapper Tests

Cover every mapper function with a sample partner payload + expected canonical output. Edge cases: missing fields, nested vs flat ID shapes, number prefix construction, empty children list.

### Integration Tests

These hit a real (test) MongoDB and Redis but use `respx` to mock the partner API.

- `test_oauth_roundtrip` — Hit `/auth/login`, simulate partner callback, assert credentials saved + redirect URL correct
- `test_webhook_delivery` — POST signed webhook payload to `/webhook/{id}`, assert background task spawned, assert sync event appended after task completes
- `test_import_job_e2e` — POST `/import`, drain Celery worker, assert documents land in `documents` collection with correct metadata + audit trail

### Coverage Targets

| Module | Min Coverage |
|---|---|
| `services/<partner>_auth.py` | 90% |
| `services/<partner>_client.py` | 85% |
| `services/<partner>_service.py` | 80% |
| `services/<partner>_webhook.py` | 85% |
| `mappers/<partner>_mappers.py` | 95% |
| `tasks.py` | 75% |
| `api/<partner>_router.py` | 70% |

Run:

```bash
pytest tests/unit/integrations/<partner>/ tests/integration/integrations/<partner>/ \
  --cov=modules/integrations/<partner> --cov-report=term-missing --cov-fail-under=70
```

---

## Frontend Tests (Vitest + Vue Test Utils)

### Mandatory Sequence

#### Step 1: Test Layout

Co-locate next to source:

```
frontend-legal/app/
├── services/<partner>.service.test.ts
├── composables/use<Partner>.test.ts
└── components/integrations/<partner>/
    ├── ConnectButton.test.ts
    ├── MatterBrowser.test.ts
    └── ImportProgress.test.ts
```

#### Step 2: Service Tests

Mock `ApiService` HTTP layer. Assert correct URL, method, body envelope per call.

#### Step 3: Composable Tests

Wrap in `withSetup` helper. Mock service. Cover:

- Initial state
- Loading flag flips on query
- Data populates on success
- Error captured on failure
- Mutation invalidates correct query key
- WebSocket composable opens connection with JWT, parses messages, closes on dispose

#### Step 4: Component Tests

Mount with `@vue/test-utils`. Cover:

- ConnectButton: click triggers `getAuthUrl`, opens window
- MatterBrowser: renders DataTable with mocked data, search input debounces
- ImportProgress: subscribes to progress composable, renders per-document status, cancel button calls mutation

Run:

```bash
cd frontend-legal
pnpm test --coverage
```

Coverage target: 70% lines on each new file.

---

## Reference Docs

| File | Purpose |
|---|---|
| `references/pytest-fixtures.md` | conftest.py patterns, respx, fakeredis, mongomock, celery testing worker |
| `references/auth-tests.md` | OAuth + token + refresh-lock test recipes |
| `references/webhook-tests.md` | HMAC payload generation, replay window edge cases |
| `references/job-tests.md` | JobEngine fixtures, progress assertion, cancellation timing |
| `references/frontend-tests.md` | Vitest setup, `withSetup`, mocked ApiService, WebSocket mocking |

## Templates

| Template | Drops to |
|---|---|
| `templates/conftest.py` | `tests/unit/integrations/<partner>/` |
| `templates/test_auth.py` | same |
| `templates/test_client.py` | same |
| `templates/test_service.py` | same |
| `templates/test_webhook.py` | same |
| `templates/test_tasks.py` | same |
| `templates/test_mappers.py` | same |
| `templates/test_oauth_roundtrip.py` | `tests/integration/integrations/<partner>/` |
| `templates/test_webhook_delivery.py` | same |
| `templates/test_import_job_e2e.py` | same |

## Stop Conditions

Pause if:

- Backend module does not yet exist — write skeletons via `quillio-integration-backend` first.
- Coverage cannot reach 70% because a code path is untestable — surface as a code-design issue, not a testing issue.
