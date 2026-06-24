"""Integration test: webhook delivery flow.

Drop into: backend-legal/tests/integration/integrations/<partner>/test_webhook_delivery.py
"""
import asyncio
import base64
import hashlib
import hmac
import json
import time

import pytest
from httpx import AsyncClient

from app.main import app


def _sign(body: dict, key: str, *, webhook_id: str = "wh-int", ts: int | None = None):
    if ts is None:
        ts = int(time.time())
    payload = json.dumps(body).encode()
    sig_string = f"{webhook_id}.{ts}.{payload.decode()}".encode()
    digest = hmac.new(key.encode(), sig_string, hashlib.sha256).digest()
    return payload, {
        "webhook-signature": "v1," + base64.b64encode(digest).decode(),
        "webhook-timestamp": str(ts),
        "webhook-id": webhook_id,
    }


@pytest.mark.asyncio
async def test_webhook_returns_200_on_invalid_signature(mock_<partner>_settings):
    async with AsyncClient(app=app, base_url="http://test") as client:
        response = await client.post(
            "/integrations/<partner>/webhook",
            content=b"{}",
            headers={
                "webhook-signature": "v1,bogus",
                "webhook-timestamp": str(int(time.time())),
                "webhook-id": "x",
            },
        )
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_webhook_dispatches_to_background_on_valid(
    mock_<partner>_settings, mock_db, mock_redis,
):
    body, headers = _sign(
        {
            "type": "document.created",
            "data": {"document_id": "d-1", "matter_id": "m-1"},
            "timestamp": "2026-01-01T00:00:00Z",
            "firm_id": "F1",
        },
        key="global-fallback-key",
    )
    async with AsyncClient(app=app, base_url="http://test") as client:
        response = await client.post(
            "/integrations/<partner>/webhook",
            content=body,
            headers=headers,
        )
    assert response.status_code == 200
    # Yield to allow BackgroundTasks to run.
    await asyncio.sleep(0.05)
    # Assert side effect of process_event (e.g., a sync event written or
    # an import job queued). Adapt to your concrete implementation.
