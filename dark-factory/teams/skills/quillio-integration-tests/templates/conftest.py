"""Partner-specific pytest fixtures for <partner> integration.

Drop into: backend-legal/tests/unit/integrations/<partner>/conftest.py
"""
import asyncio
from datetime import datetime, timedelta
from typing import Any, Dict

import fakeredis.aioredis
import mongomock_motor
import pytest
import respx

from modules.integrations.<partner>.backend.models.<partner>_models import (
    <Partner>Credentials,
)


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
def mock_<partner>_settings(monkeypatch):
    monkeypatch.setattr(
        "app.settings.settings.<partner>_client_id", "test-client-id"
    )
    monkeypatch.setattr(
        "app.settings.settings.<partner>_client_secret", "test-secret"
    )
    monkeypatch.setattr(
        "app.settings.settings.<partner>_redirect_uri",
        "https://test.example.com/callback",
    )
    monkeypatch.setattr(
        "app.settings.settings.<partner>_auth_url",
        "https://partner.example.com/oauth/authorize",
    )
    monkeypatch.setattr(
        "app.settings.settings.<partner>_token_url",
        "https://partner.example.com/oauth/token",
    )
    monkeypatch.setattr(
        "app.settings.settings.<partner>_api_base_url",
        "https://api.partner.example.com",
    )
    monkeypatch.setattr(
        "app.settings.settings.<partner>_webhook_signing_key",
        "global-fallback-key",
    )
    monkeypatch.setattr(
        "app.settings.settings.authjwt_secret_key", "test-jwt-secret"
    )
    monkeypatch.setattr(
        "app.settings.settings.base_url_backend",
        "https://api.test.aila.app",
    )
    monkeypatch.setattr(
        "app.settings.settings.base_url_user",
        "https://app.test.aila.app",
    )


@pytest.fixture
async def mock_db():
    client = mongomock_motor.AsyncMongoMockClient()
    db = client["aila_test"]
    yield db
    client.close()


@pytest.fixture
async def mock_redis():
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    yield redis
    await redis.flushall()
    await redis.close()


@pytest.fixture(autouse=True)
def patch_infra(monkeypatch, mock_db, mock_redis):
    async def _get_db():
        return mock_db

    async def _get_redis():
        return mock_redis

    monkeypatch.setattr("app.mongodb.get_motor_db", _get_db)
    monkeypatch.setattr("app.redis_async.get_async_redis", _get_redis)


@pytest.fixture
def respx_mock():
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as router:
        yield router


@pytest.fixture
def sample_<partner>_credentials() -> <Partner>Credentials:
    return <Partner>Credentials(
        owner_id="user@example.com",
        provider="<partner>",
        access_token="access-test",
        refresh_token="refresh-test",
        token_expiry=datetime.utcnow() + timedelta(hours=1),
        api_base_url="https://api.partner.example.com",
        firm_cloud_id="firm-test",
        webhook_signing_key="user-key-test",
        status="connected",
    )


@pytest.fixture
async def seed_credentials(mock_db, sample_<partner>_credentials):
    await mock_db.integration_tokens.insert_one(
        sample_<partner>_credentials.model_dump()
    )
    return sample_<partner>_credentials


@pytest.fixture
async def partner_service(mock_db):
    from modules.integrations.<partner>.backend.services.<partner>_service import (
        <Partner>Service,
    )
    service = <Partner>Service(db=mock_db)
    yield service
    await service.cleanup()


@pytest.fixture
async def partner_client(sample_<partner>_credentials):
    from modules.integrations.<partner>.backend.services.<partner>_client import (
        <Partner>Client,
    )
    client = <Partner>Client(
        base_url=sample_<partner>_credentials.api_base_url,
        access_token=sample_<partner>_credentials.access_token,
    )
    yield client
    await client.close()


@pytest.fixture
def celery_eager(monkeypatch):
    from app.tasks import celery_app

    monkeypatch.setattr(celery_app.conf, "task_always_eager", True)
    monkeypatch.setattr(celery_app.conf, "task_eager_propagates", True)
    yield


def fake_jwt(claims: Dict[str, Any]) -> str:
    import jwt

    return jwt.encode(claims, "test", algorithm="HS256")
