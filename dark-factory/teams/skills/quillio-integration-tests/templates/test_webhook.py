"""Unit tests for <Partner>WebhookService.

Drop into: backend-legal/tests/unit/integrations/<partner>/test_<partner>_webhook.py
"""
import base64
import hashlib
import hmac
import json
import time

import pytest

from modules.integrations.<partner>.backend.services.<partner>_webhook import (
    <Partner>WebhookService,
)


def make_signed_webhook(
    body: dict,
    *,
    signing_key: str,
    webhook_id: str = "wh-test",
    timestamp: int | None = None,
) -> tuple[bytes, dict[str, str]]:
    if timestamp is None:
        timestamp = int(time.time())
    payload = json.dumps(body).encode()
    signing_string = (
        f"{webhook_id}.{timestamp}.{payload.decode()}".encode()
    )
    digest = hmac.new(
        signing_key.encode(), signing_string, hashlib.sha256
    ).digest()
    signature = "v1," + base64.b64encode(digest).decode()
    headers = {
        "webhook-signature": signature,
        "webhook-timestamp": str(timestamp),
        "webhook-id": webhook_id,
    }
    return payload, headers


@pytest.mark.asyncio
async def test_verify_signature_valid_with_user_key(
    mock_<partner>_settings, mock_db, mock_redis,
):
    await mock_db.integration_tokens.insert_one({
        "owner_id": "user@example.com",
        "provider": "<partner>",
        "status": "connected",
        "webhook_signing_key": "secret-1",
    })
    body, headers = make_signed_webhook({"type": "ping"}, signing_key="secret-1")
    assert await <Partner>WebhookService().verify_signature(body, headers) is True


@pytest.mark.asyncio
async def test_verify_signature_falls_back_to_global(
    mock_<partner>_settings, mock_db, mock_redis,
):
    body, headers = make_signed_webhook(
        {"type": "ping"}, signing_key="global-fallback-key",
    )
    assert await <Partner>WebhookService().verify_signature(body, headers) is True


@pytest.mark.asyncio
async def test_verify_signature_rejects_wrong_key(
    mock_<partner>_settings, mock_db, mock_redis,
):
    await mock_db.integration_tokens.insert_one({
        "owner_id": "user@example.com",
        "provider": "<partner>",
        "status": "connected",
        "webhook_signing_key": "actual-key",
    })
    body, headers = make_signed_webhook(
        {"type": "ping"}, signing_key="forged-key",
    )
    assert await <Partner>WebhookService().verify_signature(body, headers) is False


@pytest.mark.asyncio
async def test_verify_signature_rejects_old_timestamp(
    mock_<partner>_settings, mock_db, mock_redis,
):
    old = int(time.time()) - 600
    body, headers = make_signed_webhook(
        {"type": "ping"},
        signing_key="global-fallback-key",
        timestamp=old,
    )
    assert await <Partner>WebhookService().verify_signature(body, headers) is False


@pytest.mark.asyncio
async def test_verify_signature_rejects_duplicate(
    mock_<partner>_settings, mock_db, mock_redis,
):
    body, headers = make_signed_webhook(
        {"type": "ping"}, signing_key="global-fallback-key",
    )
    assert await <Partner>WebhookService().verify_signature(body, headers) is True
    assert await <Partner>WebhookService().verify_signature(body, headers) is False


@pytest.mark.asyncio
async def test_process_event_routes_document_created(
    mock_db, mock_redis, monkeypatch,
):
    handled = {"called": False}

    async def fake(self, data, ts, firm_id):
        handled["called"] = True

    monkeypatch.setattr(
        <Partner>WebhookService, "_handle_document_event", fake
    )
    await <Partner>WebhookService().process_event({
        "type": "document.created",
        "data": {"document_id": "d", "matter_id": "m"},
        "timestamp": "2026-01-01T00:00:00Z",
        "firm_id": "F",
    })
    assert handled["called"]


@pytest.mark.asyncio
async def test_find_affected_owners_intersects(mock_db):
    await mock_db.integration_tokens.insert_many([
        {
            "owner_id": "alice@x", "provider": "<partner>",
            "firm_cloud_id": "F1", "status": "connected",
        },
        {
            "owner_id": "bob@x", "provider": "<partner>",
            "firm_cloud_id": "F1", "status": "connected",
        },
    ])
    await mock_db.folders.insert_one({
        "ownerId": "alice@x", "integration": "<partner>",
        "action_id": "matter-1",
    })
    owners = await <Partner>WebhookService()._find_affected_owners(
        mock_db, "F1", None, "matter-1", None,
    )
    assert owners == {"alice@x"}


def test_extract_ids_handles_flat_and_nested():
    w = <Partner>WebhookService()
    flat = w._extract_ids({
        "document_id": "d", "matter_id": "m", "client_id": "c"
    })
    nested = w._extract_ids({
        "document": {"id": "d"},
        "location": {"matter_id": "m", "client_id": "c"},
    })
    assert flat == ("d", "m", "c")
    assert nested == ("d", "m", "c")


@pytest.mark.asyncio
async def test_process_event_swallows_exceptions(
    mock_db, mock_redis, monkeypatch,
):
    async def boom(self, *a, **kw):
        raise RuntimeError("oops")

    monkeypatch.setattr(
        <Partner>WebhookService, "_handle_document_event", boom
    )
    # Must not raise.
    await <Partner>WebhookService().process_event({
        "type": "document.created", "data": {}, "timestamp": "x", "firm_id": "F",
    })


@pytest.mark.asyncio
async def test_document_renamed_updates_title(
    mock_<partner>_settings, mock_db, mock_redis,
):
    await mock_db.documents.insert_one({
        "ownerId": "user@example.com",
        "integration": "<partner>",
        "<partner>_doc_id": "d-1",
        "title": "old",
    })
    await <Partner>WebhookService()._handle_document_status_change(
        "document.renamed",
        {"document_id": "d-1", "name": "New.docx", "number": "42"},
    )
    doc = await mock_db.documents.find_one({"<partner>_doc_id": "d-1"})
    assert doc["title"] == "42 - New.docx"
