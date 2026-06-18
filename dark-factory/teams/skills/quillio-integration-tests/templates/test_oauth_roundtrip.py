"""Integration test: OAuth round-trip for <partner>.

Drop into: backend-legal/tests/integration/integrations/<partner>/test_oauth_roundtrip.py

Uses real (test) MongoDB + Redis if available; otherwise falls back to mocks
inherited from unit conftest.
"""
import pytest
from httpx import AsyncClient

from app.main import app


@pytest.mark.asyncio
async def test_oauth_login_returns_url(
    mock_<partner>_settings, mock_db, mock_redis, auth_header,
):
    async with AsyncClient(app=app, base_url="http://test") as client:
        response = await client.get(
            "/integrations/<partner>/auth/login", headers=auth_header,
        )
    assert response.status_code == 200
    body = response.json()
    assert body["url"].startswith("https://partner.example.com/oauth/authorize")


@pytest.mark.asyncio
async def test_oauth_callback_exchanges_and_redirects(
    mock_<partner>_settings, mock_db, mock_redis, respx_mock, oauth_state,
):
    respx_mock.post("https://partner.example.com/oauth/token").respond(
        200,
        json={
            "access_token": "ax",
            "refresh_token": "rx",
            "expires_in": 3600,
        },
    )

    async with AsyncClient(app=app, base_url="http://test", follow_redirects=False) as client:
        response = await client.get(
            "/integrations/<partner>/auth/callback",
            params={"code": "fake-code", "state": oauth_state},
        )

    assert response.status_code in (302, 307)
    assert "integration=<partner>" in response.headers["location"]
    assert "status=connected" in response.headers["location"]

    # Confirm credentials saved.
    doc = await mock_db.integration_tokens.find_one(
        {"owner_id": "user@example.com", "provider": "<partner>"}
    )
    assert doc is not None
    assert doc["status"] == "connected"


# ---------- Required fixtures (live in tests/integration/conftest.py if shared) ----------

@pytest.fixture
def auth_header() -> dict:
    """Return Authorization header with a valid JWT for the test user."""
    # TODO(quillio:<partner>): build via your project's existing JWT helper
    return {"Authorization": "Bearer test-jwt"}


@pytest.fixture
async def oauth_state(mock_redis) -> str:
    """Generate and stash an OAuth state token for callback validation."""
    from app.utils.oauth_state import generate_oauth_state
    return await generate_oauth_state(mock_redis, "user@example.com")
