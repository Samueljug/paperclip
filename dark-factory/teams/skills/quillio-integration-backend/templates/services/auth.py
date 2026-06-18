"""OAuth + token storage + refresh-with-lock for <partner>.

Drop into: modules/integrations/<partner>/backend/services/<partner>_auth.py
"""
import asyncio
import json
import logging
from datetime import datetime, timedelta
from typing import Any, Dict, Optional
from urllib.parse import urlencode

import httpx
import jwt

from app.mongodb import get_motor_db
from app.redis_async import get_async_redis
from app.settings import settings

from modules.integrations.<partner>.backend.models.<partner>_models import (
    <Partner>Credentials,
)

logger = logging.getLogger(__name__)


def _redact(value: Optional[str], keep: int = 6) -> str:
    if not value:
        return "<none>"
    return f"{value[:keep]}...({len(value) - keep} more)"


def _safe_oauth_error(response: httpx.Response) -> Dict[str, Any]:
    try:
        body = response.json()
        return {
            "error": body.get("error"),
            "error_description": body.get("error_description"),
        }
    except Exception:
        return {"status": response.status_code}


class <Partner>AuthService:
    PROVIDER = "<partner>"
    LOCK_TTL_SECONDS = 30
    REFRESH_RESULT_CACHE_TTL = 10

    def __init__(self, db=None):
        self._db = db

    async def get_auth_url(self, state: str) -> str:
        params = {
            "response_type": "code",
            "client_id": settings.<partner>_client_id,
            "redirect_uri": settings.<partner>_redirect_uri,
            "state": state,
            # TODO(quillio:<partner>): add scopes / audience per partner docs
        }
        return f"{settings.<partner>_auth_url}?{urlencode(params)}"

    async def exchange_code_for_token(self, code: str) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                settings.<partner>_token_url,
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "client_id": settings.<partner>_client_id,
                    "client_secret": settings.<partner>_client_secret,
                    "redirect_uri": settings.<partner>_redirect_uri,
                },
                headers={"Accept": "application/json"},
            )
        if response.status_code >= 400:
            logger.error(
                "[<PARTNER>_AUTH] token exchange failed status=%s detail=%s",
                response.status_code,
                _safe_oauth_error(response),
            )
            response.raise_for_status()

        token_data = response.json()
        firm_cloud_id = self._extract_firm_id(
            token_data.get("id_token") or token_data.get("access_token")
        )
        api_base_url = await self._resolve_tenant_url(
            firm_cloud_id, token_data["access_token"]
        )
        return {
            "access_token": token_data["access_token"],
            "refresh_token": token_data.get("refresh_token"),
            "token_expiry": datetime.utcnow()
            + timedelta(seconds=int(token_data.get("expires_in", 3600))),
            "api_base_url": api_base_url,
            "firm_cloud_id": firm_cloud_id,
        }

    def _extract_firm_id(self, token: Optional[str]) -> Optional[str]:
        if not token:
            return None
        try:
            claims = jwt.decode(token, options={"verify_signature": False})
        except jwt.PyJWTError:
            return None
        for key in ("extension_<Partner>FirmId", "firmId", "firm_id", "tid"):
            if claims.get(key):
                return str(claims[key])
        return None

    async def _resolve_tenant_url(
        self, firm_id: Optional[str], access_token: str
    ) -> str:
        # TODO(quillio:<partner>): if partner has a config service, hit it here
        # to get the tenant-specific API base URL. Otherwise fall through.
        if not firm_id:
            return settings.<partner>_api_base_url
        return settings.<partner>_api_base_url

    async def save_credentials(
        self, owner_id: str, token_data: Dict[str, Any]
    ) -> None:
        db = self._db or await get_motor_db()
        await db.integration_tokens.update_one(
            {"owner_id": owner_id, "provider": self.PROVIDER},
            {
                "$set": {
                    **token_data,
                    "status": "connected",
                    "updated_at": datetime.utcnow(),
                },
                "$setOnInsert": {"created_at": datetime.utcnow()},
            },
            upsert=True,
        )

    async def get_credentials(
        self, owner_id: str
    ) -> Optional[<Partner>Credentials]:
        db = self._db or await get_motor_db()
        doc = await db.integration_tokens.find_one(
            {"owner_id": owner_id, "provider": self.PROVIDER, "status": "connected"}
        )
        if not doc:
            return None
        return <Partner>Credentials(**doc)

    async def get_credentials_by_id(
        self, doc_id: Any
    ) -> Optional[<Partner>Credentials]:
        from bson import ObjectId

        db = self._db or await get_motor_db()
        try:
            oid = ObjectId(doc_id)
        except Exception:
            return None
        doc = await db.integration_tokens.find_one({"_id": oid})
        return <Partner>Credentials(**doc) if doc else None

    async def refresh_credentials(
        self, owner_id: str
    ) -> Optional[<Partner>Credentials]:
        redis = await get_async_redis()
        lock_key = f"{self.PROVIDER}:refresh_lock:{owner_id}"
        cache_key = f"{self.PROVIDER}:refresh_result:{owner_id}"

        acquired = await redis.set(lock_key, "1", nx=True, ex=self.LOCK_TTL_SECONDS)
        if not acquired:
            return await self._wait_for_refresh_completion(
                owner_id, redis, cache_key
            )

        try:
            creds = await self.get_credentials(owner_id)
            if not creds or not creds.refresh_token:
                return None

            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.post(
                    settings.<partner>_token_url,
                    data={
                        "grant_type": "refresh_token",
                        "refresh_token": creds.refresh_token,
                        "client_id": settings.<partner>_client_id,
                        "client_secret": settings.<partner>_client_secret,
                    },
                )

            if response.status_code == 400:
                logger.warning(
                    "[<PARTNER>_AUTH] refresh 400 — disconnecting user=%s",
                    owner_id,
                )
                await self._mark_disconnected(owner_id)
                return None
            response.raise_for_status()

            payload = response.json()
            new_data = {
                "access_token": payload["access_token"],
                "refresh_token": payload.get("refresh_token", creds.refresh_token),
                "token_expiry": datetime.utcnow()
                + timedelta(seconds=int(payload.get("expires_in", 3600))),
                "api_base_url": creds.api_base_url,
                "firm_cloud_id": creds.firm_cloud_id,
            }
            await self.save_credentials(owner_id, new_data)
            await redis.set(
                cache_key,
                json.dumps(
                    {
                        "access_token": new_data["access_token"],
                        "expiry": new_data["token_expiry"].isoformat(),
                    }
                ),
                ex=self.REFRESH_RESULT_CACHE_TTL,
            )
            return await self.get_credentials(owner_id)
        except Exception:
            logger.exception(
                "[<PARTNER>_AUTH] refresh failed for owner=%s", owner_id
            )
            return None
        finally:
            await redis.delete(lock_key)

    async def _wait_for_refresh_completion(
        self,
        owner_id: str,
        redis,
        cache_key: str,
        timeout: float = 10.0,
    ) -> Optional[<Partner>Credentials]:
        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            cached = await redis.get(cache_key)
            if cached:
                return await self.get_credentials(owner_id)
            if not await redis.exists(
                f"{self.PROVIDER}:refresh_lock:{owner_id}"
            ):
                return await self.get_credentials(owner_id)
            await asyncio.sleep(0.25)
        return await self.get_credentials(owner_id)

    async def _mark_disconnected(self, owner_id: str) -> None:
        db = self._db or await get_motor_db()
        await db.integration_tokens.update_one(
            {"owner_id": owner_id, "provider": self.PROVIDER},
            {
                "$set": {
                    "status": "disconnected",
                    "updated_at": datetime.utcnow(),
                }
            },
        )

    async def save_webhook_signing_key(self, owner_id: str, key: str) -> None:
        db = self._db or await get_motor_db()
        await db.integration_tokens.update_one(
            {"owner_id": owner_id, "provider": self.PROVIDER},
            {
                "$set": {
                    "webhook_signing_key": key,
                    "updated_at": datetime.utcnow(),
                }
            },
        )

    async def save_webhook_signing_key_for_firm(
        self, firm_cloud_id: str, key: str
    ) -> None:
        """Per-firm variant. Use only if partner mandates firm-level keys."""
        db = self._db or await get_motor_db()
        await db.integration_tokens.update_many(
            {"provider": self.PROVIDER, "firm_cloud_id": firm_cloud_id},
            {
                "$set": {
                    "webhook_signing_key": key,
                    "updated_at": datetime.utcnow(),
                }
            },
        )

    async def get_webhook_signing_key(self, owner_id: str) -> Optional[str]:
        creds = await self.get_credentials(owner_id)
        return creds.webhook_signing_key if creds else None

    async def logout(self, owner_id: str) -> bool:
        await self._mark_disconnected(owner_id)
        return True
