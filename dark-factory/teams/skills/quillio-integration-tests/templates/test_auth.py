"""Unit tests for <Partner>AuthService.

Drop into: backend-legal/tests/unit/integrations/<partner>/test_<partner>_auth.py
"""
import asyncio
from datetime import datetime, timedelta
from urllib.parse import parse_qs, urlparse

import pytest

from modules.integrations.<partner>.backend.services.<partner>_auth import (
    <Partner>AuthService,
)


@pytest.mark.asyncio
async def test_get_auth_url_includes_required_params(mock_<partner>_settings):
    auth = <Partner>AuthService()
    url = await auth.get_auth_url("state-abc")
    parsed = urlparse(url)
    qs = parse_qs(parsed.query)
    assert qs["response_type"] == ["code"]
    assert qs["client_id"] == ["test-client-id"]
    assert qs["redirect_uri"] == ["https://test.example.com/callback"]
    assert qs["state"] == ["state-abc"]


@pytest.mark.asyncio
async def test_exchange_code_returns_token_data(
    mock_<partner>_settings, respx_mock,
):
    respx_mock.post("https://partner.example.com/oauth/token").respond(
        200,
        json={
            "access_token": "access-1",
            "refresh_token": "refresh-1",
            "expires_in": 3600,
        },
    )
    auth = <Partner>AuthService()
    result = await auth.exchange_code_for_token("auth-code")
    assert result["access_token"] == "access-1"
    assert result["refresh_token"] == "refresh-1"
    assert isinstance(result["token_expiry"], datetime)
    assert result["api_base_url"]


@pytest.mark.parametrize("claim_key,expected", [
    ("extension_<Partner>FirmId", "firm-1"),
    ("firmId", "firm-2"),
    ("firm_id", "firm-3"),
    ("tid", "firm-4"),
])
def test_extract_firm_id_tries_candidates(claim_key, expected, mock_<partner>_settings):
    from tests.unit.integrations.<partner>.conftest import fake_jwt
    auth = <Partner>AuthService()
    assert auth._extract_firm_id(fake_jwt({claim_key: expected})) == expected


def test_extract_firm_id_returns_none_for_unrecognised(mock_<partner>_settings):
    from tests.unit.integrations.<partner>.conftest import fake_jwt
    auth = <Partner>AuthService()
    assert auth._extract_firm_id(fake_jwt({"unrelated": "x"})) is None
    assert auth._extract_firm_id(None) is None


@pytest.mark.asyncio
async def test_save_credentials_upserts(mock_<partner>_settings, mock_db):
    auth = <Partner>AuthService(db=mock_db)
    payload = {
        "access_token": "a",
        "refresh_token": "r",
        "token_expiry": datetime.utcnow() + timedelta(hours=1),
        "api_base_url": "https://api.x",
        "firm_cloud_id": "f",
    }
    await auth.save_credentials("user@example.com", payload)
    doc = await mock_db.integration_tokens.find_one(
        {"owner_id": "user@example.com"}
    )
    assert doc["status"] == "connected"
    assert doc["provider"] == "<partner>"

    await auth.save_credentials("user@example.com", payload)
    count = await mock_db.integration_tokens.count_documents(
        {"owner_id": "user@example.com"}
    )
    assert count == 1


@pytest.mark.asyncio
async def test_get_credentials_returns_none_for_disconnected(
    mock_<partner>_settings, mock_db, seed_credentials,
):
    await mock_db.integration_tokens.update_one(
        {"owner_id": "user@example.com"},
        {"$set": {"status": "disconnected"}},
    )
    auth = <Partner>AuthService(db=mock_db)
    assert await auth.get_credentials("user@example.com") is None


@pytest.mark.asyncio
async def test_refresh_under_concurrency_only_one_network_call(
    mock_<partner>_settings, mock_db, mock_redis, respx_mock, seed_credentials,
):
    route = respx_mock.post(
        "https://partner.example.com/oauth/token"
    ).respond(
        200,
        json={
            "access_token": "new-access",
            "refresh_token": "new-refresh",
            "expires_in": 3600,
        },
    )
    await mock_db.integration_tokens.update_one(
        {"owner_id": "user@example.com"},
        {"$set": {"token_expiry": datetime.utcnow() - timedelta(seconds=1)}},
    )
    auth = <Partner>AuthService(db=mock_db)
    results = await asyncio.gather(
        auth.refresh_credentials("user@example.com"),
        auth.refresh_credentials("user@example.com"),
        auth.refresh_credentials("user@example.com"),
    )
    assert all(r is not None for r in results)
    assert route.call_count == 1


@pytest.mark.asyncio
async def test_refresh_400_disconnects_user(
    mock_<partner>_settings, mock_db, mock_redis, respx_mock, seed_credentials,
):
    respx_mock.post(
        "https://partner.example.com/oauth/token"
    ).respond(400, json={"error": "invalid_grant"})
    auth = <Partner>AuthService(db=mock_db)
    result = await auth.refresh_credentials("user@example.com")
    assert result is None
    doc = await mock_db.integration_tokens.find_one(
        {"owner_id": "user@example.com"}
    )
    assert doc["status"] == "disconnected"


@pytest.mark.asyncio
async def test_save_webhook_key_per_user(
    mock_<partner>_settings, mock_db, seed_credentials,
):
    auth = <Partner>AuthService(db=mock_db)
    await auth.save_webhook_signing_key("user@example.com", "user-secret")
    key = await auth.get_webhook_signing_key("user@example.com")
    assert key == "user-secret"


@pytest.mark.asyncio
async def test_save_webhook_key_per_firm_updates_all_in_firm(mock_db):
    await mock_db.integration_tokens.insert_many([
        {
            "owner_id": "a@x", "provider": "<partner>",
            "firm_cloud_id": "F1", "status": "connected",
        },
        {
            "owner_id": "b@x", "provider": "<partner>",
            "firm_cloud_id": "F1", "status": "connected",
        },
        {
            "owner_id": "c@y", "provider": "<partner>",
            "firm_cloud_id": "F2", "status": "connected",
        },
    ])
    auth = <Partner>AuthService(db=mock_db)
    await auth.save_webhook_signing_key_for_firm("F1", "firm-key")
    docs = await mock_db.integration_tokens.find(
        {"firm_cloud_id": "F1"}
    ).to_list(10)
    assert all(d["webhook_signing_key"] == "firm-key" for d in docs)
    other = await mock_db.integration_tokens.find_one(
        {"firm_cloud_id": "F2"}
    )
    assert other.get("webhook_signing_key") is None


@pytest.mark.asyncio
async def test_logout_marks_disconnected(mock_db, seed_credentials):
    auth = <Partner>AuthService(db=mock_db)
    assert await auth.logout("user@example.com") is True
    doc = await mock_db.integration_tokens.find_one(
        {"owner_id": "user@example.com"}
    )
    assert doc["status"] == "disconnected"
