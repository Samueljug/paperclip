"""Webhook signature verification + event dispatch for <partner>.

Drop into: modules/integrations/<partner>/backend/services/<partner>_webhook.py
Skip this file entirely if the partner does not support webhooks.
"""
import asyncio
import base64
import hashlib
import hmac
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
        signature_header = (
            headers.get("webhook-signature")
            or headers.get("x-<partner>-signature")
        )
        timestamp = headers.get("webhook-timestamp")
        webhook_id = (
            headers.get("webhook-id")
            or headers.get("x-<partner>-webhook-id", "")
        )

        if not signature_header or not timestamp:
            logger.warning("[<PARTNER>_WEBHOOK] missing signature/timestamp")
            return False

        try:
            ts_int = int(timestamp)
            now = int(datetime.utcnow().timestamp())
            if abs(now - ts_int) > self.TIMESTAMP_WINDOW_SECONDS:
                logger.warning(
                    "[<PARTNER>_WEBHOOK] timestamp drift=%ds — rejected",
                    now - ts_int,
                )
                return False
        except (ValueError, TypeError):
            return False

        nonce_key = f"{self.PROVIDER}:webhook_nonce:{webhook_id}:{timestamp}"
        redis = await get_async_redis()
        not_seen = await redis.set(
            nonce_key, "1", nx=True, ex=self.NONCE_TTL_SECONDS
        )
        if not_seen is None:
            logger.info(
                "[<PARTNER>_WEBHOOK] duplicate webhook_id=%s", webhook_id
            )
            return False

        signing_string = (
            f"{webhook_id}.{timestamp}."
            f"{payload.decode('utf-8', errors='replace')}"
        ).encode()
        signing_keys = await self._candidate_signing_keys(firm_id)
        provided = signature_header.split(",", 1)[-1].strip()

        for key in signing_keys:
            if not key:
                continue
            expected = hmac.new(
                key.encode(), signing_string, hashlib.sha256
            ).digest()
            expected_b64 = base64.b64encode(expected).decode()
            if hmac.compare_digest(provided, expected_b64):
                return True

        logger.warning("[<PARTNER>_WEBHOOK] no matching signing key")
        return False

    async def _candidate_signing_keys(
        self, firm_id: Optional[str]
    ) -> List[str]:
        keys: List[str] = []
        db = await get_motor_db()

        if firm_id:
            cursor = db.integration_tokens.find(
                {
                    "provider": self.PROVIDER,
                    "firm_cloud_id": firm_id,
                    "webhook_signing_key": {"$exists": True, "$ne": None},
                },
                {"webhook_signing_key": 1},
            )
            keys.extend([d["webhook_signing_key"] async for d in cursor])

        cursor = db.integration_tokens.find(
            {
                "provider": self.PROVIDER,
                "status": "connected",
                "webhook_signing_key": {"$exists": True, "$ne": None},
            },
            {"webhook_signing_key": 1},
        )
        keys.extend([d["webhook_signing_key"] async for d in cursor])

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
            elif event_type in (
                "document.renamed",
                "document.deleted",
                "document.restored",
            ):
                await self._handle_document_status_change(event_type, data)
            elif event_type == "document.moved":
                await self._handle_document_moved(data, firm_id)
            elif event_type in (
                "matter.created",
                "matter.updated",
                "party.created",
                "party.updated",
            ):
                logger.debug(
                    "[<PARTNER>_WEBHOOK] %s — no-op", event_type
                )
            else:
                logger.info(
                    "[<PARTNER>_WEBHOOK] unknown event type: %s", event_type
                )
        except Exception:
            logger.exception("[<PARTNER>_WEBHOOK] process_event failed")

    async def _handle_document_event(
        self,
        data: Dict[str, Any],
        event_timestamp: Optional[str],
        firm_id: Optional[str],
    ) -> None:
        doc_id, matter_id, client_id = self._extract_ids(data)
        if not doc_id:
            logger.warning(
                "[<PARTNER>_WEBHOOK] document event without document_id"
            )
            return

        db = await get_motor_db()
        owners = await self._find_affected_owners(
            db, firm_id, doc_id, matter_id, client_id
        )
        if not owners:
            logger.info(
                "[<PARTNER>_WEBHOOK] no connected owners for doc=%s", doc_id
            )
            return

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
                    logger.debug(
                        "[<PARTNER>_WEBHOOK] metadata pre-fetch failed"
                    )

            await asyncio.gather(*[
                self._submit_import_for_owner(
                    service,
                    owner,
                    data,
                    matter_id,
                    client_id,
                    event_timestamp,
                )
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
            doc_item = {
                "document_id": (
                    doc_data.get("document_id") or doc_data.get("id")
                ),
                "document_name": (
                    doc_data.get("name") or doc_data.get("file_name")
                ),
            }
            request: Dict[str, Any] = {
                "source": "webhook",
                "client_id": client_id,
                "metadata": {"webhook_timestamp": event_timestamp},
            }
            if matter_id:
                request["matters"] = [
                    {"matter_id": matter_id, "items": [doc_item]}
                ]
            else:
                request["client_files"] = [doc_item]
            await service.import_documents(owner_id, request)
        except Exception:
            logger.exception(
                "[<PARTNER>_WEBHOOK] failed to submit import owner=%s",
                owner_id,
            )

    async def _handle_document_status_change(
        self,
        event_type: str,
        data: Dict[str, Any],
    ) -> None:
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
                title = (
                    f"{new_number} - {new_name}" if new_number else new_name
                )
                update = {
                    "title": title,
                    "fileName": new_name,
                    "updatedAt": datetime.utcnow(),
                }
        if update:
            result = await db.documents.update_many(
                {
                    "<partner>_doc_id": doc_id,
                    "integration": self.PROVIDER,
                },
                {"$set": update},
            )
            logger.info(
                "[<PARTNER>_WEBHOOK] %s -> %d docs (doc_id=%s)",
                event_type,
                result.modified_count,
                doc_id,
            )

    async def _handle_document_moved(
        self,
        data: Dict[str, Any],
        firm_id: Optional[str],
    ) -> None:
        # TODO(quillio:<partner>): implement folder reparenting + count adjustments
        pass

    # ----------------------- Helpers -----------------------

    def _extract_ids(
        self, data: Dict[str, Any]
    ) -> Tuple[Optional[str], Optional[str], Optional[str]]:
        doc_id = (
            data.get("document_id")
            or data.get("id")
            or (data.get("document") or {}).get("id")
        )
        matter_id = (
            data.get("matter_id")
            or (data.get("matter") or {}).get("id")
            or (data.get("location") or {}).get("matter_id")
        )
        client_id = (
            data.get("client_id")
            or (data.get("client") or {}).get("id")
            or (data.get("location") or {}).get("client_id")
        )
        return (
            str(doc_id) if doc_id else None,
            str(matter_id) if matter_id else None,
            str(client_id) if client_id else None,
        )

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
                {
                    "provider": self.PROVIDER,
                    "firm_cloud_id": firm_id,
                    "status": "connected",
                },
                {"owner_id": 1},
            )
            firm_owners = {d["owner_id"] async for d in cursor}

        entity_owners: Set[str] = set()
        if doc_id:
            cursor = db.documents.find(
                {
                    "<partner>_doc_id": doc_id,
                    "integration": self.PROVIDER,
                },
                {"ownerId": 1},
            )
            entity_owners.update({d["ownerId"] async for d in cursor})
        for action_id in (matter_id, client_id):
            if not action_id:
                continue
            cursor = db.folders.find(
                {
                    "action_id": action_id,
                    "integration": self.PROVIDER,
                },
                {"ownerId": 1},
            )
            entity_owners.update({d["ownerId"] async for d in cursor})

        if firm_owners and entity_owners:
            return firm_owners & entity_owners
        return firm_owners or entity_owners
