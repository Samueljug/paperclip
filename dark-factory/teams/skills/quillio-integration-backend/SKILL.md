---
name: quillio-integration-backend
description: Build the backend half of a new AILA legal-practice-management integration matching the OneLaw canonical pattern. Use when the developer is implementing the FastAPI router, OAuth flow, async HTTP client, webhook receiver, Celery import/export jobs, mappers, or MongoDB models for a new third-party integration in modules/integrations/<partner>/backend/. Trigger words: "implement the {partner} backend", "wire up OAuth for {partner}", "add the webhook handler", "write the import job", "create the {partner} module". Always invoke quillio-integration master skill FIRST so capability matrix is filled before this skill runs.
---

# Quillio Integration — Backend Builder

**SCOPE:** `backend-legal/modules/integrations/<partner>/backend/` only. Wiring touches `backend-legal/app/main.py` and `backend-legal/app/tasks.py`.

## Strict Task Scope (NON-NEGOTIABLE)

Only create or modify backend integration files, behaviour, tests, and docs explicitly authorised by the accepted task/plan. Adjacent partner capabilities, refactors, cleanup, or architecture ideas become follow-up items for Samuel unless explicitly approved.

**CANONICAL REFERENCE:** Read `backend-legal/modules/integrations/onelaw/backend/` end-to-end before writing anything. It is the source of truth for layout, idioms, and conventions.

**HARD RULE:** Every file you create must be < 500 lines. If it grows toward 400, split it before merge.

---

## Mandatory Sequence

Build in this order. Do not skip. Each step depends on the previous.

### Step 1: Module Skeleton

Create directory tree exactly:

```
modules/integrations/<partner>/
├── __init__.py                    # empty
└── backend/
    ├── __init__.py                # empty
    ├── api/
    │   ├── __init__.py            # empty
    │   └── <partner>_router.py    # FastAPI router, prefix /integrations/<partner>
    ├── services/
    │   ├── __init__.py            # empty
    │   ├── <partner>_auth.py      # OAuth + token storage + refresh
    │   ├── <partner>_client.py    # async httpx wrapper
    │   ├── <partner>_service.py   # business logic, orchestrates auth + client
    │   ├── <partner>_webhook.py   # signature verify + event dispatch (only if partner has webhooks)
    │   └── sync_event_logger.py   # PipelineTracker + log_sync_event
    ├── mappers/
    │   ├── __init__.py            # empty
    │   └── <partner>_mappers.py   # Pydantic → AILA canonical translation
    ├── models/
    │   ├── __init__.py            # empty
    │   └── <partner>_models.py    # Pydantic request/response/credential schemas
    ├── utils/
    │   ├── __init__.py            # empty
    │   └── proxy_token.py         # JWT proxy token mint/verify (only if download proxy needed)
    └── tasks.py                   # Celery shared_task entries (delegate to async helpers)
```

Templates for each file live under `templates/`. Copy, then fill `# TODO(quillio:<partner>)` markers.

### Step 2: Settings

Add to `backend-legal/app/settings.py`:

```python
# <Partner> Integration
<partner>_client_id: str = ""
<partner>_client_secret: str = ""
<partner>_redirect_uri: str = ""
<partner>_auth_url: str = ""
<partner>_token_url: str = ""
<partner>_api_base_url: str = ""
<partner>_webhook_signing_key: str = ""  # optional global fallback
```

### Step 3: Auth Layer

Read `references/auth.md`. Implement `<partner>_auth.py`:

- `get_auth_url(state: str) -> str`
- `exchange_code_for_token(code: str) -> Dict` — also resolves tenant URL if multi-region
- `save_credentials(owner_id: str, token_data: Dict) -> None` — upsert to `integration_tokens` collection (provider="<partner>")
- `get_credentials(owner_id: str) -> Optional[<Partner>Credentials]`
- `refresh_credentials(owner_id: str) -> Optional[<Partner>Credentials]` — protected by Redis distributed lock keyed `<partner>:refresh_lock:{owner_id}`
- `save_webhook_signing_key(owner_id, key)` / `get_webhook_signing_key(owner_id)` — per-user by default

### Step 4: HTTP Client Layer

Read `references/http-client.md`. Implement `<partner>_client.py`:

- `__init__(base_url, access_token, timeout=30)` — single `httpx.AsyncClient` per instance, lazy-init
- `async __aenter__/__aexit__` and `async close()` — for context-manager usage and explicit cleanup
- Private `_request(method, path, **kwargs)` — single chokepoint for all API calls; handles:
  - Bearer token header
  - 401 → raise `AuthFailedError` (caller decides to refresh)
  - 429 → respect `Retry-After`, exponential backoff capped at 60s, max 30 retries
  - 5xx → exponential backoff + retry up to 3
  - 404 → raise `NotFoundError` or return `None` based on `raise_on_404` flag
  - Presigned URL detection (X-Amz-Signature) → strip Authorization header
- One method per partner endpoint. Pagination handled inside the method (offset/limit loop + hard cap 50,000 rows).

### Step 5: Service Layer (Business Logic)

Read `references/service-layer.md`. Implement `<partner>_service.py`:

- `class <Partner>Service(IntegrationBase)` from `app.integrations.base.integration_base`
- `__init__(db=None)` — track `_active_clients: list[<Partner>Client]` for cleanup
- `async cleanup()` — close every tracked client
- `async get_client(user_email) -> Optional[<Partner>Client]`:
  - Fetch credentials via `auth_service.get_credentials(user_email)`
  - If `token_expiry <= now()` → call `auth_service.refresh_credentials(user_email)`
  - If still missing → return None (caller returns 401 to FE)
  - Otherwise instantiate client with current `access_token` + `api_base_url`
- High-level methods (`list_matters`, `list_documents`, `get_document_tree`, `unified_search`, `import_documents`, `export_documents`) — orchestrate client + mappers + JobEngine
- MRU tracking via `app.tables.Recent<Partner>Interactions` (mirror `RecentOneLawInteractions`)
- Background tasks dispatched via `asyncio.create_task()` (do not await — service `cleanup()` cancels stragglers)

### Step 6: Webhook Layer (skip if partner has no webhooks)

Read `references/webhooks.md`. Implement `<partner>_webhook.py`:

- `async verify_signature(payload: bytes, headers: Dict, firm_id: Optional[str]) -> bool` — HMAC-SHA256 + per-user/per-firm key lookup + global fallback
- `async process_event(event: Dict)` — dispatch to per-event handlers
- Per-event handlers — `_handle_document_event`, `_handle_document_status_change`, `_handle_document_moved`, etc. Each one:
  - Find affected users (firm-based + entity-based, intersect)
  - Pre-fetch document metadata once (use first owner's credentials)
  - For each owner, fan out via `service.import_documents()` inside `asyncio.gather`
- Never raise — log and continue. The router's webhook endpoint always returns 200.

### Step 7: Celery Tasks

Read `references/celery-jobs.md`. Implement `tasks.py`:

```python
from celery import shared_task

@shared_task(name="<partner>.import_documents", bind=True, max_retries=5, default_retry_delay=3)
def process_<partner>_import_job(self, job_id: str):
    asyncio.run(_process_import_job_async(job_id))

@shared_task(name="<partner>.export_documents")
def process_<partner>_export_job(job_id: str):
    asyncio.run(_process_export_job_async(job_id))
```

Async helpers (`_process_import_job_async`, `_process_export_job_async`) live in the same file, but if they grow > 300 lines split them into `services/<partner>_import_runner.py` and `services/<partner>_export_runner.py`.

Job lifecycle — `JobEngine` records, progress via `JobProgressService.publish_progress`, cancellation via `JobCancellationService`, rollback via `old_docs` + `rollback_marker` flags.

### Step 8: Mappers + Models

Read `references/mappers-models.md`. Implement `<partner>_mappers.py` and `<partner>_models.py`:

- Pydantic models for every partner API response shape
- Pydantic models for import/export request bodies
- `<Partner>Credentials` model for stored tokens
- Mappers translate partner objects → AILA canonical (`Contact`, `Matter`, `Document`, `TreeItem`)
- Naming convention `"{number} - {name}"` for display titles

### Step 9: Router

Read `references/router-wiring.md`. Implement `<partner>_router.py`:

- `router = APIRouter(prefix="/integrations/<partner>", tags=["<partner>"])`
- Generator dependency `async def get_<partner>_service()` — yield + cleanup in finally
- Standard endpoints (skip those that don't apply):
  - `GET /auth/login`
  - `GET /auth/callback`
  - `POST /auth/logout`
  - `GET /clients`, `GET /matters`, `GET /matters/{id}/tree`
  - `GET /search`
  - `GET /sync-status`, `GET /sync-history`, `GET /sync-history/{event_id}`
  - `GET /recent/clients`, `GET /recent/matters`
  - `POST /import`, `POST /export`
  - `GET /jobs/{job_id}`, `DELETE /cancel-import/{job_id}`
  - `WebSocket /ws/import-status/{job_id}`, `WebSocket /ws/sync-status`
  - `PUT /webhook-key`, `GET /webhook-key`, `POST /webhook` (only if webhooks supported)
  - `GET /proxy/document/{user_email}/{document_id}` (only if download proxy needed)
- Authentication: every route except `/auth/callback` and `/webhook` uses `Depends(get_current_user)`. WebSocket auth via `?token=<jwt>` query param + manual `get_ws_current_user()` call.
- Errors: HTTPException(400|401|403|404|500). Async jobs return 202.

### Step 10: Wiring

Edit `backend-legal/app/main.py`:

```python
from modules.integrations.<partner>.backend.api.<partner>_router import router as <partner>_router
app.include_router(<partner>_router)
```

Edit `backend-legal/app/tasks.py`:

```python
from modules.integrations.<partner>.backend.tasks import (  # noqa: F401
    process_<partner>_import_job,
    process_<partner>_export_job,
)
```

### Step 11: Verify

Before declaring done:

```bash
cd backend-legal
flake8 modules/integrations/<partner>/
ruff check modules/integrations/<partner>/
python -c "from modules.integrations.<partner>.backend.api.<partner>_router import router; print(router.routes)"
```

All three must pass.

---

## Reference Docs

| File | Purpose |
|---|---|
| `references/auth.md` | OAuth flow, token storage shape, Redis-locked refresh, multi-tenant URL discovery |
| `references/http-client.md` | httpx async client, retries, rate-limit, pagination, presigned URL handling, error mapping |
| `references/service-layer.md` | Business logic orchestration, MRU tracking, background tasks |
| `references/webhooks.md` | HMAC verify, nonce dedup, key storage, multi-user fan-out |
| `references/celery-jobs.md` | JobEngine, progress pub/sub, cancellation, rollback markers, batching, concurrency caps |
| `references/sync-state.md` | external_id, smart-sync conflict resolution, sync events audit trail |
| `references/folder-mirroring.md` | Folder hierarchy upsert, parent-chain walking, document_count denormalisation |
| `references/proxy-tokens.md` | JWT proxy tokens for download URLs |
| `references/router-wiring.md` | FastAPI router, dependency injection, WebSocket auth, main.py + tasks.py wiring |
| `references/mappers-models.md` | Pydantic models, mappers, MongoDB collection schemas, naming conventions |

## Templates

`templates/` contains compileable Python skeletons. Copy them into `modules/integrations/<partner>/backend/`, then search/replace the literal token `<partner>` with the partner's lowercase name (`leap`, `mycase`, etc.) and `<Partner>` with the title-case name. Fill in every `# TODO(quillio:<partner>)` block by reading the partner's API docs.

| Template | Drops to |
|---|---|
| `templates/api/router.py` | `api/<partner>_router.py` |
| `templates/services/auth.py` | `services/<partner>_auth.py` |
| `templates/services/client.py` | `services/<partner>_client.py` |
| `templates/services/service.py` | `services/<partner>_service.py` |
| `templates/services/webhook.py` | `services/<partner>_webhook.py` |
| `templates/services/sync_event_logger.py` | `services/sync_event_logger.py` |
| `templates/mappers/mappers.py` | `mappers/<partner>_mappers.py` |
| `templates/models/models.py` | `models/<partner>_models.py` |
| `templates/utils/proxy_token.py` | `utils/proxy_token.py` |
| `templates/tasks.py` | `tasks.py` |

## Stop Conditions

Pause and ask the developer if:

- Partner uses a non-OAuth auth scheme (mTLS, signed JWT bearer, API key) — adapt `auth.md` patterns.
- Partner returns paginated results via a scheme not covered (link header, opaque continuation token in body) — extend `http-client.md`.
- Partner requires region-specific token endpoint URLs that differ across customers — multi-region pattern in `auth.md`.
- File you are writing crosses 400 lines.
