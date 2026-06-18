"""Business-logic orchestrator for <partner>.

Drop into: modules/integrations/<partner>/backend/services/<partner>_service.py
"""
import asyncio
import logging
import math
from datetime import datetime
from typing import Any, Dict, List, Optional

from app.integrations.base.integration_base import DocumentIntegrationBase
from app.integrations.core.jobs.engine import JobEngine
from app.integrations.core.jobs.models import IntegrationJob, JobStatus, JobType
from app.mongodb import get_motor_db
from app.redis_async import get_async_redis
from app.settings import settings
from app.utils.oauth_state import validate_oauth_state

from modules.integrations.<partner>.backend.mappers import <partner>_mappers as mappers
from modules.integrations.<partner>.backend.models import <partner>_models as models
from modules.integrations.<partner>.backend.services.<partner>_auth import (
    <Partner>AuthService,
)
from modules.integrations.<partner>.backend.services.<partner>_client import (
    <Partner>Client,
    AuthFailedError,
)
from modules.integrations.<partner>.backend.utils.proxy_token import create_proxy_token

logger = logging.getLogger(__name__)


class <Partner>Service(DocumentIntegrationBase):
    PROVIDER = "<partner>"
    PAGE_SIZE = 50

    def __init__(self, db=None):
        self._db = db
        self._auth = <Partner>AuthService(db=db)
        self._active_clients: List[<Partner>Client] = []

    async def cleanup(self) -> None:
        for c in self._active_clients:
            try:
                await c.close()
            except Exception:
                logger.exception("[<PARTNER>_SERVICE] client close failed")
        self._active_clients = []

    # ----------------------- Auth contract -----------------------

    async def authenticate(self, code: str, state: str) -> Dict[str, Any]:
        owner_id = await self._owner_id_from_state(state)
        token_data = await self._auth.exchange_code_for_token(code)
        await self._auth.save_credentials(owner_id, token_data)
        # TODO(quillio:<partner>): register webhooks here if partner supports them
        return {"owner_id": owner_id, "status": "connected"}

    async def refresh_token(self, refresh_token: str):
        raise NotImplementedError(
            "Use auth_service.refresh_credentials(owner_id) instead"
        )

    async def get_user_info(self, access_token: str) -> Dict[str, Any]:
        # TODO(quillio:<partner>): hit partner /userinfo or decode JWT
        return {}

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

    # ----------------------- Reads -----------------------

    async def list_clients(
        self,
        user_email: str,
        search: Optional[str] = None,
        page: int = 1,
    ):
        client = await self.get_client(user_email)
        if not client:
            return {"items": [], "total": 0, "page": page, "totalPages": 0}
        try:
            payload = await client.list_clients(search=search, page=page)
        except AuthFailedError:
            await self._auth.refresh_credentials(user_email)
            return await self.list_clients(user_email, search=search, page=page)

        items_raw = payload.get("items", []) if isinstance(payload, dict) else []
        items = [
            mappers.map_party_to_contact(models.<Partner>Party(**p))
            for p in items_raw
        ]
        total = int(payload.get("total", len(items)))
        return {
            "items": items,
            "total": total,
            "page": page,
            "totalPages": math.ceil(total / self.PAGE_SIZE) if total else 0,
        }

    async def list_matters(
        self,
        user_email: str,
        client_id: Optional[str] = None,
        search: Optional[str] = None,
        page: int = 1,
    ):
        client = await self.get_client(user_email)
        if not client:
            return {"items": [], "total": 0, "page": page, "totalPages": 0}
        payload = await client.list_matters(
            client_id=client_id, search=search, page=page
        )
        items_raw = payload.get("items", []) if isinstance(payload, dict) else []

        # Enrich matters with client_number in parallel.
        unique_client_ids = {
            m.get("client_id") for m in items_raw if m.get("client_id")
        }
        client_numbers = await asyncio.gather(*[
            self._get_client_number(client, cid) for cid in unique_client_ids
        ])
        client_number_map = dict(zip(unique_client_ids, client_numbers))

        items = [
            mappers.map_matter_to_canonical(
                models.<Partner>Matter(**m),
                client_number=client_number_map.get(m.get("client_id")),
            )
            for m in items_raw
        ]
        total = int(payload.get("total", len(items)))
        return {
            "items": items,
            "total": total,
            "page": page,
            "totalPages": math.ceil(total / self.PAGE_SIZE) if total else 0,
        }

    async def unified_search(self, user_email: str, query: str):
        client = await self.get_client(user_email)
        if not client:
            return {"clients": [], "matters": []}
        clients_resp, matters_resp = await asyncio.gather(
            client.list_clients(search=query),
            client.list_matters(search=query),
            return_exceptions=True,
        )
        clients = self._safe_search_extract(
            clients_resp,
            mapper=mappers.map_party_to_contact,
            model=models.<Partner>Party,
        )
        matters = self._safe_search_extract(
            matters_resp,
            mapper=mappers.map_matter_to_canonical,
            model=models.<Partner>Matter,
        )
        return {"clients": clients, "matters": matters}

    async def get_document_tree(
        self,
        user_email: str,
        matter_id: str,
        page: int = 1,
        page_size: int = 250,
    ):
        client = await self.get_client(user_email)
        if not client:
            return {"items": [], "total": 0, "page": page}
        payload = await client.list_matter_documents(
            matter_id, offset=(page - 1) * page_size, limit=page_size
        )
        items_raw = payload.get("items", []) if isinstance(payload, dict) else []
        items = [
            mappers.map_document_to_canonical(models.<Partner>Document(**d))
            for d in items_raw
        ]
        return {
            "items": items,
            "total": int(payload.get("total", len(items))),
            "page": page,
        }

    # ----------------------- Recent / MRU -----------------------

    async def get_recent_clients(self, user_email: str) -> List[Dict[str, Any]]:
        # TODO(quillio:<partner>): adapt MRU storage if you create
        # Recent<Partner>Interactions table
        return []

    async def get_recent_matters(self, user_email: str) -> List[Dict[str, Any]]:
        return []

    # ----------------------- Job submission -----------------------

    async def import_documents(
        self,
        user_email: str,
        import_request: Dict[str, Any],
    ) -> Dict[str, str]:
        from modules.integrations.<partner>.backend.tasks import (
            process_<partner>_import_job,
        )

        job_id = (
            f"{self.PROVIDER}_import_"
            f"{int(datetime.utcnow().timestamp() * 1000)}"
        )
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
            "websocket_url": (
                f"/integrations/<partner>/ws/import-status/{job_id}"
            ),
            "status_url": f"/integrations/<partner>/jobs/{job_id}",
        }

    async def export_documents(
        self,
        user_email: str,
        export_request: Dict[str, Any],
    ) -> Dict[str, str]:
        from modules.integrations.<partner>.backend.tasks import (
            process_<partner>_export_job,
        )

        job_id = (
            f"{self.PROVIDER}_export_"
            f"{int(datetime.utcnow().timestamp() * 1000)}"
        )
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

    async def get_proxy_document_url(
        self, user_email: str, document_id: str
    ) -> str:
        token = create_proxy_token(user_email, document_id)
        return (
            f"{settings.base_url_backend}/integrations/<partner>"
            f"/proxy/document/{user_email}/{document_id}?token={token}"
        )

    # ----------------------- Helpers -----------------------

    async def _owner_id_from_state(self, state: str) -> str:
        redis = await get_async_redis()
        owner_id = await validate_oauth_state(redis, state)
        if not owner_id:
            raise ValueError("Invalid OAuth state")
        return owner_id

    async def _get_client_number(
        self,
        client: <Partner>Client,
        client_id: str,
    ) -> Optional[str]:
        try:
            data = await client.get_client(client_id)
            return (data or {}).get("number")
        except Exception:
            return None

    def _safe_search_extract(self, response, *, mapper, model):
        if isinstance(response, Exception):
            logger.warning(
                "[<PARTNER>_SERVICE] search returned exception: %s", response
            )
            return []
        items = (
            response.get("items", [])
            if isinstance(response, dict)
            else response or []
        )
        return [mapper(model(**i)) for i in items]
