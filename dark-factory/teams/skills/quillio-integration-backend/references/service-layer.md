# Service Layer (`<partner>_service.py`)

Reference: `modules/integrations/onelaw/backend/services/onelaw_service.py` (727 lines).

## Responsibility

Business logic that orchestrates the auth, client, mapper, and JobEngine layers. Routers call the service. The service decides what client method to call, what mapper to apply, and when to enqueue background work.

The service NEVER:
- Talks directly to the partner's HTTP API (`client.py` does that)
- Reads or writes credentials directly (`auth.py` does that)
- Returns raw partner JSON (mappers translate to AILA canonical)
- Blocks on Celery work (kicks off and returns immediately)

## Class Skeleton

```python
import asyncio
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from app.integrations.base.integration_base import DocumentIntegrationBase
from app.integrations.core.jobs.engine import JobEngine
from app.integrations.core.jobs.models import IntegrationJob, JobStatus, JobType
from app.mongodb import get_motor_db
from app.tables import Recent<Partner>Interactions

from modules.integrations.<partner>.backend.services.<partner>_auth import (
    <Partner>AuthService,
)
from modules.integrations.<partner>.backend.services.<partner>_client import (
    <Partner>Client, AuthFailedError,
)
from modules.integrations.<partner>.backend.mappers import <partner>_mappers as mappers
from modules.integrations.<partner>.backend.models import <partner>_models as models
from modules.integrations.<partner>.backend.utils.proxy_token import create_proxy_token

logger = logging.getLogger(__name__)


class <Partner>Service(DocumentIntegrationBase):
    PROVIDER = "<partner>"

    def __init__(self, db=None):
        self._db = db
        self._auth = <Partner>AuthService(db=db)
        self._active_clients: List[<Partner>Client] = []

    async def cleanup(self) -> None:
        for c in self._active_clients:
            await c.close()
        self._active_clients = []

    # ----------------------- Auth contract (from IntegrationBase) -----------------------

    async def authenticate(self, code: str, state: str) -> Dict[str, Any]:
        token_data = await self._auth.exchange_code_for_token(code)
        owner_id = await self._owner_id_from_state(state)
        await self._auth.save_credentials(owner_id, token_data)
        return {"owner_id": owner_id, "status": "connected"}

    async def refresh_token(self, refresh_token: str):
        # Called via abstract contract; real refresh uses owner_id, not raw token.
        raise NotImplementedError("Use auth_service.refresh_credentials(owner_id) instead.")

    async def get_user_info(self, access_token: str) -> Dict[str, Any]:
        # Decode JWT; same as auth._extract_firm_id but exposes more claims if needed.
        ...

    async def logout(self, user_email: str) -> bool:
        return await self._auth.logout(user_email)

    async def get_auth_url(self, state: str) -> str:
        return await self._auth.get_auth_url(state)

    # ----------------------- Client factory -----------------------

    async def get_client(self, user_email: str) -> Optional[<Partner>Client]:
        creds = await self._auth.get_credentials(user_email)
        if not creds:
            return None
        if creds.token_expiry and creds.token_expiry <= datetime.utcnow():
            creds = await self._auth.refresh_credentials(user_email)
            if not creds:
                return None
        client = <Partner>Client(
            base_url=creds.api_base_url,
            access_token=creds.access_token,
        )
        self._active_clients.append(client)
        return client

    # ----------------------- Read methods -----------------------

    async def list_clients(self, user_email: str, search: Optional[str] = None, page: int = 1):
        client = await self.get_client(user_email)
        if not client:
            return models.ClientListResponse(items=[], total=0, page=page, total_pages=0)
        try:
            payload = await client.list_clients(search=search, page=page)
        except AuthFailedError:
            await self._auth.refresh_credentials(user_email)
            return await self.list_clients(user_email, search=search, page=page)
        items = [mappers.map_party_to_contact(models.<Partner>Party(**p)) for p in payload.get("items", [])]
        # Save to MRU asynchronously, no await.
        asyncio.create_task(self._save_recent_clients(user_email, items[:5]))
        total = int(payload.get("total", len(items)))
        return models.ClientListResponse(items=items, total=total, page=page, total_pages=math.ceil(total / 50))

    async def list_matters(self, user_email, client_id=None, search=None, page=1):
        client = await self.get_client(user_email)
        if not client:
            return models.MatterListResponse(items=[], total=0, page=page, total_pages=0)
        payload = await client.list_matters(client_id=client_id, search=search, page=page)
        items_raw = payload.get("items", [])

        # Enrich matters with client number in parallel.
        unique_client_ids = {m.get("client_id") for m in items_raw if m.get("client_id")}
        client_numbers = await asyncio.gather(*[
            self._get_client_number(client, cid) for cid in unique_client_ids
        ])
        client_number_map = dict(zip(unique_client_ids, client_numbers))

        items = [
            mappers.map_matter_to_canonical(models.<Partner>Matter(**m), client_number=client_number_map.get(m.get("client_id")))
            for m in items_raw
        ]
        return models.MatterListResponse(items=items, total=int(payload.get("total", len(items))), page=page, total_pages=math.ceil(int(payload.get("total", len(items))) / 50))

    async def unified_search(self, user_email: str, query: str):
        client = await self.get_client(user_email)
        if not client:
            return {"clients": [], "matters": []}
        clients_resp, matters_resp = await asyncio.gather(
            client.list_clients(search=query),
            client.list_matters(search=query),
            return_exceptions=True,
        )
        clients = self._safe_search_extract(clients_resp, mapper=mappers.map_party_to_contact, model=models.<Partner>Party)
        matters = self._safe_search_extract(matters_resp, mapper=mappers.map_matter_to_canonical, model=models.<Partner>Matter)
        return {"clients": clients, "matters": matters}

    async def get_document_tree(self, user_email, matter_id, page=1, page_size=250):
        client = await self.get_client(user_email)
        if not client:
            return {"items": [], "total": 0, "page": page}
        payload = await client.list_matter_documents(matter_id, offset=(page - 1) * page_size, limit=page_size)
        # TODO(quillio:<partner>): build hierarchical tree if partner exposes parent_id.
        items_raw = payload.get("items", [])
        items = [mappers.map_document_to_canonical(models.<Partner>Document(**d)) for d in items_raw]
        return {"items": items, "total": int(payload.get("total", len(items))), "page": page}

    # ----------------------- Recent / MRU -----------------------

    async def get_recent_clients(self, user_email: str) -> List[Dict[str, Any]]:
        record = await asyncio.to_thread(Recent<Partner>Interactions.objects(user_email=user_email).first)
        return record.recent_clients if record else []

    async def add_recent_clients(self, user_email: str, clients: List[Dict[str, Any]]) -> None:
        await asyncio.to_thread(self._sync_add_recent_clients, user_email, clients)

    def _sync_add_recent_clients(self, user_email, clients):
        record = Recent<Partner>Interactions.objects(user_email=user_email).first()
        if not record:
            record = Recent<Partner>Interactions(user_email=user_email, recent_clients=[], recent_matters=[])
        existing_ids = {c.get("external_id") for c in record.recent_clients}
        new_clients = [c for c in clients if c.get("external_id") not in existing_ids]
        record.recent_clients = (new_clients + record.recent_clients)[:50]
        record.save()

    async def _save_recent_clients(self, user_email, items):
        try:
            payloads = [{"external_id": i.id, "name": i.name, "number": i.number} for i in items]
            await self.add_recent_clients(user_email, payloads)
        except Exception:
            logger.exception("[<PARTNER>_SERVICE] failed to save MRU clients")

    # ----------------------- Job submission -----------------------

    async def import_documents(self, user_email: str, import_request: Dict[str, Any]) -> Dict[str, str]:
        from modules.integrations.<partner>.backend.tasks import process_<partner>_import_job

        job_id = f"<partner>_import_{int(datetime.utcnow().timestamp() * 1000)}"
        job = IntegrationJob(
            job_id=job_id,
            user_email=user_email,
            provider=self.PROVIDER,
            job_type=JobType.IMPORT,
            status=JobStatus.QUEUED,
            metadata={"request": import_request},
        )
        await JobEngine.create_job(job)
        process_<partner>_import_job.delay(job_id)
        return {
            "job_id": job_id,
            "status": JobStatus.QUEUED.value,
            "websocket_url": f"/integrations/<partner>/ws/import-status/{job_id}",
            "status_url": f"/integrations/<partner>/jobs/{job_id}",
        }

    async def export_documents(self, user_email: str, export_request: Dict[str, Any]) -> Dict[str, str]:
        from modules.integrations.<partner>.backend.tasks import process_<partner>_export_job

        job_id = f"<partner>_export_{int(datetime.utcnow().timestamp() * 1000)}"
        job = IntegrationJob(
            job_id=job_id,
            user_email=user_email,
            provider=self.PROVIDER,
            job_type=JobType.EXPORT,
            status=JobStatus.QUEUED,
            metadata={"request": export_request},
        )
        await JobEngine.create_job(job)
        process_<partner>_export_job.delay(job_id)
        return {"job_id": job_id, "status": JobStatus.QUEUED.value}

    async def get_proxy_document_url(self, user_email: str, document_id: str) -> str:
        from app.settings import settings
        token = create_proxy_token(user_email, document_id)
        return f"{settings.base_url_backend}/integrations/<partner>/proxy/document/{user_email}/{document_id}?token={token}"

    # ----------------------- Helpers -----------------------

    async def _owner_id_from_state(self, state: str) -> str:
        from app.utils.oauth_state import validate_oauth_state
        from app.redis_async import get_async_redis
        redis = await get_async_redis()
        owner_id = await validate_oauth_state(redis, state)
        if not owner_id:
            raise ValueError("Invalid OAuth state")
        return owner_id

    async def _get_client_number(self, client: <Partner>Client, client_id: str) -> Optional[str]:
        try:
            data = await client.get_client(client_id)
            return data.get("number") if data else None
        except Exception:
            return None

    def _safe_search_extract(self, response, *, mapper, model):
        if isinstance(response, Exception):
            logger.warning("[<PARTNER>_SERVICE] search returned exception: %s", response)
            return []
        items = response.get("items", []) if isinstance(response, dict) else response or []
        return [mapper(model(**i)) for i in items]
```

## Idioms

### Auto-refresh on AuthFailedError

The service catches `AuthFailedError` from the client, calls `auth.refresh_credentials`, and retries ONCE. After one retry, propagate as 401 to FE. Do not loop.

### Background tasks via `asyncio.create_task`

MRU writes, audit logs, and other fire-and-forget operations should NOT block the request. Wrap in `asyncio.create_task()` and let `service.cleanup()` await them on cleanup.

### `asyncio.to_thread` for sync MongoEngine

MongoEngine ODM is sync. Wrap calls in `asyncio.to_thread(...)` from async contexts. Pure-Motor calls do not need this.

### `asyncio.gather` for parallel reads

Unified search, client number enrichment, multi-folder fetches — all run in parallel via `asyncio.gather(..., return_exceptions=True)` so a single failure does not kill the response.

## File Size Budget

If `service.py` approaches 500 lines, split by responsibility:
- `service.py` — core client factory, MRU, job submission
- `service_search.py` — `unified_search`, `list_clients`, `list_matters`
- `service_documents.py` — document tree, document operations
- `service_sync_runner.py` — reverse sync (if bidirectional)

The split must follow `app.integrations.base.integration_base.DocumentIntegrationBase` contract: the public surface is the union of all these modules, but each consumer imports the class from `<partner>_service.py`. Use composition or mixins.

## Testing Hooks

- `db=None` constructor arg lets tests inject `mongomock` / test DB
- `_active_clients` list is inspectable
- `cleanup()` is idempotent
- All public methods are async; pytest-asyncio fixtures everywhere
