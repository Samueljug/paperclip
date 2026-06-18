# Webhooks (`<partner>_webhook.py`)

Reference: `modules/integrations/onelaw/backend/services/onelaw_webhook.py` (616 lines).

**SKIP THIS DOC if your partner doesn't support webhooks.**

## Responsibility

- Verify webhook signature (HMAC + key lookup)
- Dedup via Redis nonce + timestamp window (replay protection)
- Dispatch to per-event handlers (NOT one fat method — see anti-pattern A5)
- Find affected users (firm-based + entity-based, intersected)
- Pre-fetch document metadata once (saves N API calls when N owners)
- Fan out to per-user import jobs via `asyncio.gather`
- Never raise — log and continue

## Endpoint Discipline

The router endpoint MUST:
1. Verify signature first.
2. If invalid signature: return 200 (do NOT reveal validity to attacker).
3. Parse body.
4. Dispatch to `BackgroundTasks` or Celery task.
5. Return 200 within milliseconds.

Body of the webhook handler should be < 30 lines. All real work happens in the dispatched task.

## Skeleton

```python
import asyncio
import base64
import hashlib
import hmac
import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional, Set, Tuple

from app.mongodb import get_motor_db
from app.redis_async import get_async_redis
from app.settings import settings

from modules.integrations.<partner>.backend.services.<partner>_service import (
    <Partner>Service,
)

logger = logging.getLogger(__name__)


class <Partner>WebhookService:
    PROVIDER = "<partner>"
    NONCE_TTL_SECONDS = 300
    TIMESTAMP_WINDOW_SECONDS = 300

    async def verify_signature(
        self,
        payload: bytes,
        headers: Dict[str, str],
        firm_id: Optional[str] = None,
    ) -> bool:
        signature_header = headers.get("webhook-signature") or headers.get("x-<partner>-signature")
        timestamp = headers.get("webhook-timestamp")
        webhook_id = headers.get("webhook-id") or headers.get("x-<partner>-webhook-id", "")

        if not signature_header or not timestamp:
            logger.warning("[<PARTNER>_WEBHOOK] missing signature or timestamp header")
            return False

        # Timestamp window check.
        try:
            ts_int = int(timestamp)
            now = int(datetime.utcnow().timestamp())
            if abs(now - ts_int) > self.TIMESTAMP_WINDOW_SECONDS:
                logger.warning("[<PARTNER>_WEBHOOK] timestamp outside window: drift=%ds", now - ts_int)
                return False
        except (ValueError, TypeError):
            logger.warning("[<PARTNER>_WEBHOOK] invalid timestamp header")
            return False

        # Nonce dedup.
        nonce_key = f"<partner>:webhook_nonce:{webhook_id}:{timestamp}"
        redis = await get_async_redis()
        not_seen = await redis.set(nonce_key, "1", nx=True, ex=self.NONCE_TTL_SECONDS)
        if not_seen is None:  # Already seen — duplicate delivery.
            logger.info("[<PARTNER>_WEBHOOK] duplicate delivery webhook_id=%s", webhook_id)
            return False

        # Compute expected signature: HMAC-SHA256 over `{webhook_id}.{timestamp}.{body}`.
        signing_string = f"{webhook_id}.{timestamp}.{payload.decode('utf-8', errors='replace')}".encode()
        signing_keys = await self._candidate_signing_keys(firm_id)

        for key in signing_keys:
            if not key:
                continue
            expected = hmac.new(key.encode(), signing_string, hashlib.sha256).digest()
            expected_b64 = base64.b64encode(expected).decode()
            # Header format may be "v1,Base64Hash"; strip prefix if present.
            provided = signature_header.split(",", 1)[-1].strip()
            if hmac.compare_digest(provided, expected_b64):
                return True

        logger.warning("[<PARTNER>_WEBHOOK] no matching signing key produced valid signature")
        return False

    async def _candidate_signing_keys(self, firm_id: Optional[str]) -> List[str]:
        """Return all keys to try, in priority order."""
        keys: List[str] = []
        db = await get_motor_db()

        # Per-firm key (if partner uses firm-level keys).
        if firm_id:
            cursor = db.integration_tokens.find(
                {"provider": self.PROVIDER, "firm_cloud_id": firm_id, "webhook_signing_key": {"$exists": True, "$ne": None}},
                {"webhook_signing_key": 1},
            )
            keys.extend([d["webhook_signing_key"] async for d in cursor])

        # Per-user keys for connected users (default).
        cursor = db.integration_tokens.find(
            {"provider": self.PROVIDER, "status": "connected", "webhook_signing_key": {"$exists": True, "$ne": None}},
            {"webhook_signing_key": 1},
        )
        keys.extend([d["webhook_signing_key"] async for d in cursor])

        # Global fallback.
        global_key = getattr(settings, "<partner>_webhook_signing_key", None)
        if global_key:
            keys.append(global_key)

        return keys

    # ----------------------- Event dispatch -----------------------

    async def process_event(self, event: Dict[str, Any]) -> None:
        try:
            event_type = event.get("type", "")
            data = event.get("data", {})
            timestamp = event.get("timestamp")
            firm_id = event.get("firm_id") or event.get("firm_cloud_id")

            if event_type in ("document.created", "document.updated"):
                await self._handle_document_event(data, timestamp, firm_id)
            elif event_type in ("document.renamed", "document.deleted", "document.restored"):
                await self._handle_document_status_change(event_type, data)
            elif event_type == "document.moved":
                await self._handle_document_moved(data, firm_id)
            elif event_type in ("matter.created", "matter.updated", "party.created", "party.updated"):
                logger.debug("[<PARTNER>_WEBHOOK] %s — no-op", event_type)
            else:
                logger.info("[<PARTNER>_WEBHOOK] unknown event type: %s", event_type)
        except Exception:
            logger.exception("[<PARTNER>_WEBHOOK] process_event failed")

    # ----------------------- Per-event handlers -----------------------

    async def _handle_document_event(
        self,
        data: Dict[str, Any],
        event_timestamp: Optional[str],
        firm_id: Optional[str],
    ) -> None:
        doc_id, matter_id, client_id = self._extract_ids(data)
        if not doc_id:
            logger.warning("[<PARTNER>_WEBHOOK] document event without document_id")
            return

        db = await get_motor_db()
        owners = await self._find_affected_owners(db, firm_id, doc_id, matter_id, client_id)
        if not owners:
            logger.info("[<PARTNER>_WEBHOOK] no connected owners for document=%s", doc_id)
            return

        # Pre-fetch metadata once using first owner's credentials.
        service = <Partner>Service(db=db)
        try:
            client = await service.get_client(next(iter(owners)))
            if client and matter_id:
                try:
                    metadata = await client.get_document(matter_id, doc_id)
                    if metadata:
                        for key, value in metadata.items():
                            data.setdefault(key, value)
                except Exception:
                    logger.debug("[<PARTNER>_WEBHOOK] metadata pre-fetch failed; will fetch per-owner")

            # Fan out import jobs.
            await asyncio.gather(*[
                self._submit_import_for_owner(service, owner, data, matter_id, client_id, event_timestamp)
                for owner in owners
            ], return_exceptions=True)
        finally:
            await service.cleanup()

    async def _submit_import_for_owner(
        self,
        service: "<Partner>Service",
        owner_id: str,
        doc_data: Dict[str, Any],
        matter_id: Optional[str],
        client_id: Optional[str],
        event_timestamp: Optional[str],
    ) -> None:
        try:
            request: Dict[str, Any] = {
                "source": "webhook",
                "client_id": client_id,
                "metadata": {"webhook_timestamp": event_timestamp},
            }
            doc_item = {
                "document_id": doc_data.get("document_id") or doc_data.get("id"),
                "document_name": doc_data.get("name") or doc_data.get("file_name"),
            }
            if matter_id:
                request["matters"] = [{"matter_id": matter_id, "items": [doc_item]}]
            else:
                request["client_files"] = [doc_item]
            await service.import_documents(owner_id, request)
        except Exception:
            logger.exception("[<PARTNER>_WEBHOOK] failed to submit import for owner=%s", owner_id)

    async def _handle_document_status_change(self, event_type: str, data: Dict[str, Any]) -> None:
        doc_id, _, _ = self._extract_ids(data)
        if not doc_id:
            return
        db = await get_motor_db()

        update: Dict[str, Any] = {}
        if event_type == "document.deleted":
            update = {"isTrashed": True, "updatedAt": datetime.utcnow()}
        elif event_type == "document.restored":
            update = {"isTrashed": False, "updatedAt": datetime.utcnow()}
        elif event_type == "document.renamed":
            new_name = data.get("name") or data.get("file_name")
            new_number = data.get("number")
            if new_name:
                title = f"{new_number} - {new_name}" if new_number else new_name
                update = {"title": title, "fileName": new_name, "updatedAt": datetime.utcnow()}
        if update:
            result = await db.documents.update_many(
                {"<partner>_doc_id": doc_id, "integration": self.PROVIDER},
                {"$set": update},
            )
            logger.info("[<PARTNER>_WEBHOOK] %s applied to %d docs (doc_id=%s)", event_type, result.modified_count, doc_id)

    async def _handle_document_moved(self, data: Dict[str, Any], firm_id: Optional[str]) -> None:
        # Implementation: find all AILA documents with the partner's doc id, look up the
        # destination folder per owner, update folderId/action_id, decrement old folder
        # document_count, increment new folder document_count.
        # See onelaw_webhook.py:495-617 for the full algorithm.
        ...

    # ----------------------- Helpers -----------------------

    def _extract_ids(self, data: Dict[str, Any]) -> Tuple[Optional[str], Optional[str], Optional[str]]:
        """Normalise nested vs flat ID shapes."""
        doc_id = data.get("document_id") or data.get("id") or (data.get("document") or {}).get("id")
        matter_id = data.get("matter_id") or (data.get("matter") or {}).get("id") or (data.get("location") or {}).get("matter_id")
        client_id = data.get("client_id") or (data.get("client") or {}).get("id") or (data.get("location") or {}).get("client_id")
        return (str(doc_id) if doc_id else None,
                str(matter_id) if matter_id else None,
                str(client_id) if client_id else None)

    async def _find_affected_owners(
        self,
        db,
        firm_id: Optional[str],
        doc_id: Optional[str],
        matter_id: Optional[str],
        client_id: Optional[str],
    ) -> Set[str]:
        firm_owners: Set[str] = set()
        if firm_id:
            cursor = db.integration_tokens.find(
                {"provider": self.PROVIDER, "firm_cloud_id": firm_id, "status": "connected"},
                {"owner_id": 1},
            )
            firm_owners = {d["owner_id"] async for d in cursor}

        entity_owners: Set[str] = set()
        if doc_id:
            cursor = db.documents.find(
                {"<partner>_doc_id": doc_id, "integration": self.PROVIDER},
                {"ownerId": 1},
            )
            entity_owners.update({d["ownerId"] async for d in cursor})
        for action_id in (matter_id, client_id):
            if not action_id:
                continue
            cursor = db.folders.find(
                {"action_id": action_id, "integration": self.PROVIDER},
                {"ownerId": 1},
            )
            entity_owners.update({d["ownerId"] async for d in cursor})

        # Combine. Prefer intersection if both are non-empty.
        if firm_owners and entity_owners:
            return firm_owners & entity_owners
        return firm_owners or entity_owners
```

## Multi-User Fan-Out

When N firm members have the same matter imported, a single document update fires N import jobs (one per user). Each job is independent and idempotent. Concurrency is bounded by Celery worker pool — no special handling needed.

## Echo Detection

If you implement reverse sync (AILA → partner), the partner will fire a webhook back at you for your own write. Skip it:

```python
async def _is_our_own_echo(self, db, doc_id: str, event_timestamp: datetime) -> bool:
    doc = await db.documents.find_one(
        {"<partner>_doc_id": doc_id, "last_synced_to_<partner>_at": {"$exists": True}},
        {"last_synced_to_<partner>_at": 1},
    )
    if not doc:
        return False
    last_sync = doc.get("last_synced_to_<partner>_at")
    if not last_sync:
        return False
    delta = (event_timestamp - last_sync).total_seconds()
    return 0 <= delta <= 60
```

Wire it into `_handle_document_event` before any work.

## Reliability

- The webhook service NEVER raises. Catch every Exception, log, return.
- The router endpoint ALWAYS returns 200. Partner retries are wasteful.
- Failed background processing → Sentry breadcrumb + log; do not retry the webhook.

## Reauth = Rotate

When a user re-authenticates:
1. Delete old webhook subscriptions on the partner.
2. Wipe `webhook_signing_key` field.
3. Register new webhook subscriptions.
4. Save the fresh signing key returned by the partner.

Old signing key keeps verifying for ≤ 5 min (timestamp window) — acceptable.

## Testing

See `quillio-integration-tests/references/webhook-tests.md` for HMAC payload generation and replay-window edge cases.
