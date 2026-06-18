# Architecture

## The Modular Monolith Rules

AILA backend is mid-migration from layered (`app/api/`, `app/services/`, `app/models/`) to modular (`modules/<feature>/`). All NEW work goes under `modules/`. New integrations live at:

```
backend-legal/
└── modules/
    └── integrations/
        └── <partner>/
            ├── __init__.py        # empty (do NOT export here)
            ├── README.md          # capabilities + known limits
            └── backend/
                ├── __init__.py
                ├── api/
                ├── services/
                ├── mappers/
                ├── models/
                ├── utils/
                └── tasks.py
```

Frontend mirror:

```
frontend-legal/
└── app/
    ├── services/<partner>.service.ts
    ├── composables/use<Partner>*.ts
    ├── components/integrations/<partner>/*
    ├── pages/integrations/<partner>/*
    └── types/<partner>.types.ts
```

## Layered Service Pattern (canonical, from OneLaw)

```
HTTP Request
    │
    ▼
api/<partner>_router.py       (FastAPI router, prefix /integrations/<partner>)
    │  Depends(get_<partner>_service)
    ▼
services/<partner>_service.py (business logic; orchestrates auth + client + mappers + JobEngine)
    │
    ├──▶ services/<partner>_auth.py    (token storage + refresh under Redis lock)
    │
    ├──▶ services/<partner>_client.py  (httpx async wrapper for partner API)
    │         │
    │         ▼
    │    Partner API (HTTPS)
    │
    ├──▶ mappers/<partner>_mappers.py  (Pydantic → AILA canonical translation)
    │
    └──▶ tasks.py (Celery shared_task entries)
              │
              ▼
        Celery Worker
              │
              ├──▶ JobEngine (MongoDB job records)
              ├──▶ JobProgressService (Redis pub/sub)
              └──▶ services/sync_event_logger.py (audit trail)


External Webhook
    │
    ▼
api/<partner>_router.py POST /webhook
    │  verify_signature → return 200 → BackgroundTasks
    ▼
services/<partner>_webhook.py (event dispatch + multi-user fan-out)
    │
    └──▶ services/<partner>_service.import_documents (Celery jobs per affected user)
```

## File Size Budget

| Tier | Lines | Rule |
|---|---|---|
| Hard cap | 500 | Refuse to merge anything over. |
| Yellow line | 400 | If you cross 400 in active development, split before adding more. |
| Green | < 300 | Healthy. |

The 2,751-line `app/services/smokeball.py` and 3,603-line `app/services/actionstep.py` are the cautionary tales. The 854-line `modules/integrations/onelaw/backend/api/onelaw_router.py` is on the edge — acceptable because it's mostly thin endpoint declarations, but the next integration must do better.

## Wiring Points

The integration is invisible to FastAPI and Celery until it is wired in.

`backend-legal/app/main.py`:
```python
from modules.integrations.<partner>.backend.api.<partner>_router import (
    router as <partner>_router,
)
app.include_router(<partner>_router)
```

`backend-legal/app/tasks.py`:
```python
from modules.integrations.<partner>.backend.tasks import (  # noqa: F401
    process_<partner>_import_job,
    process_<partner>_export_job,
)
```

That's it. No service registry, no plugin discovery, no DI container. Imports are wiring.

## Module Isolation Contract

Allowed:
- `from app.<anything>` (shared infrastructure: settings, mongodb, redis, auth, tables)
- `from app.integrations.core.<anything>` (shared JobEngine, base classes, document utils)
- `from app.integrations.base.<anything>` (`AuthServiceBase`, `IntegrationBase`, `DocumentBase`)
- `from modules.integrations.<self>.backend.<anything>` (your own module)

Forbidden:
- `from modules.integrations.<other>.<anything>` — never import another integration's internals.
- `from app.services.smokeball|actionstep|clio` — those are legacy; do not couple new code to them.

If two integrations need to share logic, lift it to `app.integrations.core.*` or `app.integrations.utils.*`.

## Shared Infrastructure

Live in `app.integrations.core.*` and `app.integrations.base.*`. Use them; do not fork them.

| Module | Purpose |
|---|---|
| `app.integrations.core.jobs.engine.JobEngine` | Job records (MongoDB) |
| `app.integrations.core.jobs.models.IntegrationJob` | Job model |
| `app.integrations.core.jobs.models.JobStatus` | QUEUED, PROCESSING, COMPLETED, FAILED, CANCELLED, PAUSED |
| `app.integrations.core.jobs.progress.JobProgressService` | Redis pub/sub + WebSocket stream |
| `app.integrations.core.jobs.cancellation.JobCancellationService` | Cancel flag in Redis |
| `app.integrations.base.integration_base.IntegrationBase` | Abstract service contract |
| `app.integrations.base.integration_base.DocumentIntegrationBase` | + document/folder methods |
| `app.integrations.base.auth_base.AuthServiceBase` | Abstract auth contract |
| `app.integrations.base.document_base.DocumentBase` | Extension/MIME mapping |
| `app.integrations.utils.document_service.DocumentService` | Download, ConvertAPI, SFDT, transcription |

## Why This Layout

- **Self-contained module** — moving an integration to its own repo later is `git mv modules/integrations/<partner> ../<partner>-repo` plus updating the two wiring points. No surgery.
- **Predictable navigation** — `auth.py` always means OAuth, `client.py` always means HTTP wrapper, `service.py` always means business logic. No more "which of the 80 methods on `SmokeballService` does what."
- **Test isolation** — every layer has a clear seam to mock.
- **File-size discipline** — when each layer is its own file, none of them grow into thousand-line monsters.
