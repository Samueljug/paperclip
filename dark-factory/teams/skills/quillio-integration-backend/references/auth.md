# Auth Layer (`<partner>_auth.py`)

Reference: `modules/integrations/onelaw/backend/services/onelaw_auth.py` (466 lines).

## Responsibility

Own everything related to credential lifecycle:
- Build OAuth authorization URL
- Exchange auth code for tokens (resolving multi-region tenant URL if applicable)
- Persist credentials in `integration_tokens` MongoDB collection
- Retrieve credentials
- Refresh expired tokens — protected by Redis distributed lock
- Manage per-user webhook signing keys (or per-firm if partner mandates)

The auth module never makes business-logic API calls. Only token-related HTTP and DB.

## Token Storage Shape

Single collection: `integration_tokens`. One document per (`owner_id`, `provider`).

```python
{
    "owner_id": "user@example.com",            # = user_email; multi-tenant key
    "provider": "<partner>",                   # exact partner slug
    "access_token": "...",
    "refresh_token": "...",
    "token_expiry": datetime,                  # UTC, naive
    "api_base_url": "https://...",             # tenant-specific, populated at OAuth time
    "firm_cloud_id": "firm-guid",              # optional; only if partner has firm concept
    "webhook_signing_key": "...",              # per-user by default
    "status": "connected" | "disconnected",
    "created_at": datetime,
    "updated_at": datetime,
}
```

No `EncryptedStringField` MongoEngine docs. The Smokeball pattern is dead. If your partner is paranoid, layer transparent encryption at the Mongo client level (out of scope for this skill).

## Skeleton

```python
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

import httpx
import jwt

from app.settings import settings
from app.mongodb import get_motor_db
from modules.integrations.<partner>.backend.models.<partner>_models import (
    <Partner>Credentials,
)

logger = logging.getLogger(__name__)


def _redact(value: Optional[str], keep: int = 6) -> str:
    """Show first `keep` chars of secret for safe logging."""
    if not value:
        return "<none>"
    return f"{value[:keep]}...({len(value) - keep} more)"


class <Partner>AuthService:
    def __init__(self, db=None):
        self._db = db
        self._lock_ttl_seconds = 30

    async def get_auth_url(self, state: str) -> str:
        params = {
            "response_type": "code",
            "client_id": settings.<partner>_client_id,
            "redirect_uri": settings.<partner>_redirect_uri,
            "state": state,
            # TODO(quillio:<partner>): add scopes / audience / etc per partner docs
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
                "[<PARTNER>_AUTH] token exchange failed status=%s body=%s",
                response.status_code, _safe_oauth_error(response),
            )
            response.raise_for_status()

        token_data = response.json()
        # TODO(quillio:<partner>): if partner returns api_endpoint or tenant URL in
        # response, capture it here and store on credentials.
        firm_cloud_id = self._extract_firm_id(token_data.get("id_token") or token_data.get("access_token"))
        api_base_url = await self._resolve_tenant_url(firm_cloud_id, token_data["access_token"])

        return {
            "access_token": token_data["access_token"],
            "refresh_token": token_data.get("refresh_token"),
            "token_expiry": datetime.utcnow() + timedelta(seconds=token_data.get("expires_in", 3600)),
            "api_base_url": api_base_url,
            "firm_cloud_id": firm_cloud_id,
        }

    def _extract_firm_id(self, token: Optional[str]) -> Optional[str]:
        """Decode JWT to extract firm identifier. Try multiple claim names."""
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

    async def _resolve_tenant_url(self, firm_id: Optional[str], access_token: str) -> str:
        """Resolve tenant-specific API URL. Fall back to default."""
        # TODO(quillio:<partner>): if partner has a config service, hit it here.
        if not firm_id:
            return settings.<partner>_api_base_url
        return settings.<partner>_api_base_url

    async def save_credentials(self, owner_id: str, token_data: Dict[str, Any]) -> None:
        db = self._db or await get_motor_db()
        await db.integration_tokens.update_one(
            {"owner_id": owner_id, "provider": "<partner>"},
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

    async def get_credentials(self, owner_id: str) -> Optional[<Partner>Credentials]:
        db = self._db or await get_motor_db()
        doc = await db.integration_tokens.find_one(
            {"owner_id": owner_id, "provider": "<partner>", "status": "connected"}
        )
        if not doc:
            return None
        return <Partner>Credentials(**doc)

    async def refresh_credentials(self, owner_id: str) -> Optional[<Partner>Credentials]:
        """Refresh under Redis distributed lock to avoid stampede."""
        from app.redis_async import get_async_redis

        redis = await get_async_redis()
        lock_key = f"<partner>:refresh_lock:{owner_id}"
        token_cache_key = f"<partner>:refresh_result:{owner_id}"

        acquired = await redis.set(lock_key, "1", nx=True, ex=self._lock_ttl_seconds)
        if not acquired:
            return await self._wait_for_refresh_completion(owner_id, redis, token_cache_key)

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
                # Refresh token revoked or rotated; mark disconnected.
                await self._mark_disconnected(owner_id)
                return None
            response.raise_for_status()

            payload = response.json()
            new_token_data = {
                "access_token": payload["access_token"],
                "refresh_token": payload.get("refresh_token", creds.refresh_token),
                "token_expiry": datetime.utcnow() + timedelta(seconds=payload.get("expires_in", 3600)),
                "api_base_url": creds.api_base_url,
                "firm_cloud_id": creds.firm_cloud_id,
            }
            await self.save_credentials(owner_id, new_token_data)

            # Cache result for waiters.
            await redis.set(
                token_cache_key,
                json.dumps({"access_token": new_token_data["access_token"], "expiry": new_token_data["token_expiry"].isoformat()}),
                ex=10,
            )
            return await self.get_credentials(owner_id)
        finally:
            await redis.delete(lock_key)

    async def _wait_for_refresh_completion(self, owner_id, redis, cache_key, timeout=10):
        """Loser of the lock race waits for winner's result."""
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            cached = await redis.get(cache_key)
            if cached:
                return await self.get_credentials(owner_id)
            if not await redis.exists(f"<partner>:refresh_lock:{owner_id}"):
                # Winner finished but cache miss; read from DB.
                return await self.get_credentials(owner_id)
            await asyncio.sleep(0.25)
        # Timeout — fall back to DB read; may still be stale.
        return await self.get_credentials(owner_id)

    async def _mark_disconnected(self, owner_id: str) -> None:
        db = self._db or await get_motor_db()
        await db.integration_tokens.update_one(
            {"owner_id": owner_id, "provider": "<partner>"},
            {"$set": {"status": "disconnected", "updated_at": datetime.utcnow()}},
        )

    async def save_webhook_signing_key(self, owner_id: str, key: str) -> None:
        """Per-user webhook key (default). Override only if partner mandates per-firm."""
        db = self._db or await get_motor_db()
        await db.integration_tokens.update_one(
            {"owner_id": owner_id, "provider": "<partner>"},
            {"$set": {"webhook_signing_key": key, "updated_at": datetime.utcnow()}},
        )

    async def get_webhook_signing_key(self, owner_id: str) -> Optional[str]:
        creds = await self.get_credentials(owner_id)
        return creds.webhook_signing_key if creds else None

    async def logout(self, owner_id: str) -> bool:
        await self._mark_disconnected(owner_id)
        return True
```

## Per-Firm Webhook Key Variant

If partner mandates per-firm signing key (OneLaw):

```python
async def save_webhook_signing_key(self, owner_id: str, key: str) -> None:
    """Apply key to ALL users in the same firm."""
    creds = await self.get_credentials(owner_id)
    if not creds or not creds.firm_cloud_id:
        raise ValueError("Cannot save firm-level key: firm not resolved")

    db = self._db or await get_motor_db()
    await db.integration_tokens.update_many(
        {"provider": "<partner>", "firm_cloud_id": creds.firm_cloud_id},
        {"$set": {"webhook_signing_key": key, "updated_at": datetime.utcnow()}},
    )
```

## Refresh Concurrency Pattern (Why)

Two requests hit a 401 simultaneously. Both call `refresh_credentials`. Refresh tokens are usually one-time use. Without a lock:
- Request A exchanges refresh_token → gets new tokens.
- Request B exchanges the same refresh_token → 400 invalid_grant.
- Request B marks the user disconnected.
- User has to re-authenticate.

The Redis lock ensures one refresh per user at a time. Losers wait for the winner's cached result and re-read.

The 30s TTL on the lock is a safety net for crashed winners; pick this based on partner refresh latency.

## State Token (CSRF Protection on Callback)

Use the existing helpers:

```python
from app.utils.oauth_state import generate_oauth_state, validate_oauth_state

# At /auth/login:
state = await generate_oauth_state(redis_client, user_id)
auth_url = await auth_service.get_auth_url(state)

# At /auth/callback:
user_id = await validate_oauth_state(redis_client, state)
if not user_id:
    raise HTTPException(400, "Invalid OAuth state")
```

State has 5-min Redis TTL.

## Logging Discipline

- Never log raw `access_token` or `refresh_token`. Use `_redact()`.
- Log refresh attempts at INFO, refresh failures at ERROR with token redacted.
- Log lock acquisition/release at DEBUG.
- Include `[<PARTNER>_AUTH]` prefix on every log line for grep-ability.

## Test Hooks

The auth service is fully unit-testable:
- Mock `httpx.AsyncClient` via `respx`.
- Mock the Redis lock via `fakeredis.aioredis`.
- Mock the DB via `mongomock` or test container.

See `quillio-integration-tests/references/auth-tests.md` for the recipes.
