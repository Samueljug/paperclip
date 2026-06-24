"""Unit tests for <Partner>Client.

Drop into: backend-legal/tests/unit/integrations/<partner>/test_<partner>_client.py
"""
import asyncio

import pytest

from modules.integrations.<partner>.backend.services.<partner>_client import (
    AuthFailedError,
    NotFoundError,
    RateLimitError,
    <Partner>Client,
)


@pytest.mark.asyncio
async def test_get_returns_parsed_json(respx_mock, partner_client):
    respx_mock.get("https://api.partner.example.com/clients").respond(
        200, json={"items": [{"id": "c1", "name": "Acme"}], "total": 1}
    )
    payload = await partner_client.list_clients()
    assert payload["items"][0]["id"] == "c1"


@pytest.mark.asyncio
async def test_204_returns_empty_dict(respx_mock, partner_client):
    respx_mock.get("https://api.partner.example.com/clients").respond(204)
    payload = await partner_client.list_clients()
    assert payload == {}


@pytest.mark.asyncio
async def test_401_raises_auth_failed(respx_mock, partner_client):
    respx_mock.get("https://api.partner.example.com/clients").respond(401)
    with pytest.raises(AuthFailedError):
        await partner_client.list_clients()


@pytest.mark.asyncio
async def test_404_raises_or_returns_none(respx_mock, partner_client):
    respx_mock.get("https://api.partner.example.com/clients/missing").respond(404)
    # raise_on_404 is False inside get_client per template.
    result = await partner_client.get_client("missing")
    assert result is None


@pytest.mark.asyncio
async def test_429_respects_retry_after(respx_mock, partner_client, monkeypatch):
    sleeps = []

    async def fake_sleep(s):
        sleeps.append(s)

    monkeypatch.setattr(asyncio, "sleep", fake_sleep)

    respx_mock.get("https://api.partner.example.com/clients").mock(
        side_effect=[
            __import__("httpx").Response(429, headers={"Retry-After": "3"}),
            __import__("httpx").Response(200, json={"items": [], "total": 0}),
        ]
    )
    await partner_client.list_clients()
    assert any(s == 3.0 for s in sleeps)


@pytest.mark.asyncio
async def test_429_exhausts_retries_raises(respx_mock, partner_client, monkeypatch):
    async def no_sleep(s):
        return None

    monkeypatch.setattr(asyncio, "sleep", no_sleep)
    respx_mock.get("https://api.partner.example.com/clients").respond(
        429, headers={"Retry-After": "1"}
    )
    partner_client.RATE_LIMIT_MAX_RETRIES = 2
    with pytest.raises(RateLimitError):
        await partner_client.list_clients()


@pytest.mark.asyncio
async def test_5xx_retries_then_raises(respx_mock, partner_client, monkeypatch):
    async def no_sleep(s):
        return None

    monkeypatch.setattr(asyncio, "sleep", no_sleep)
    respx_mock.get("https://api.partner.example.com/clients").respond(503)
    with pytest.raises(Exception):
        await partner_client.list_clients()


@pytest.mark.asyncio
async def test_presigned_url_strips_auth_header(respx_mock, partner_client):
    """Presigned S3 URLs must NOT carry Authorization."""
    presigned = (
        "https://aws-s3.example.com/file?X-Amz-Signature=abc&"
        "X-Amz-Algorithm=AWS4-HMAC-SHA256"
    )
    route = respx_mock.get(presigned).respond(200, content=b"binary")
    await partner_client.download_document(presigned)
    sent_headers = route.calls.last.request.headers
    assert "authorization" not in {k.lower() for k in sent_headers}


@pytest.mark.asyncio
async def test_pagination_caps_at_hard_limit(respx_mock, partner_client, monkeypatch):
    partner_client.HARD_PAGE_CAP = 5
    page = [{"id": str(i), "name": f"d-{i}"} for i in range(50)]
    respx_mock.get("https://api.partner.example.com/test-paging").respond(
        200, json={"items": page, "total": 100}
    )
    rows = await partner_client._paginate("/test-paging", page_size=50)
    assert len(rows) == 50  # one full page returned, then capped before next request
