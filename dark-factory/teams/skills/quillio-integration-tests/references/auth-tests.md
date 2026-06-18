# Auth Tests

## Coverage Targets

| Function | Coverage |
|---|---|
| `get_auth_url` | URL contains all required query params + state |
| `exchange_code_for_token` | POSTs correct body, parses tokens, extracts firm ID, resolves tenant URL |
| `_extract_firm_id` | Tries each candidate JWT claim, returns first match |
| `_resolve_tenant_url` | Calls config service, falls back to default on failure |
| `save_credentials` | Upserts with `status="connected"` |
| `get_credentials` | Returns None when status="disconnected" |
| `refresh_credentials` | Posts refresh grant, updates token + expiry |
| `refresh_credentials` (rotation) | Uses new refresh_token if returned |
| `refresh_credentials` (concurrent) | Two parallel calls produce ONE network request (Redis lock) |
| `refresh_credentials` (revoked) | 400 response → user marked disconnected |
| `save_webhook_signing_key` | Stores per-user (default) or per-firm (variant) |
| `get_webhook_signing_key` | Returns None for users without key |
| `logout` | Marks `status="disconnected"` |

## Sample Tests

### `get_auth_url`

```python
import pytest
from urllib.parse import parse_qs, urlparse


@pytest.mark.asyncio
async def test_get_auth_url_includes_required_params(mock_<partner>_settings):
    from modules.integrations.<partner>.backend.services.<partner>_auth import (
        <Partner>AuthService,
    )
    auth = <Partner>AuthService()
    url = await auth.get_auth_url("state-abc")
    parsed = urlparse(url)
    qs = parse_qs(parsed.query)
    assert qs["response_type"] == ["code"]
    assert qs["client_id"] == ["test-client-id"]
    assert qs["redirect_uri"] == ["https://test.example.com/callback"]
    assert qs["state"] == ["state-abc"]
```

### `exchange_code_for_token`

```python
@pytest.mark.asyncio
async def test_exchange_code_returns_token_data(mock_<partner>_settings, respx_mock):
    from modules.integrations.<partner>.backend.services.<partner>_auth import (
        <Partner>AuthService,
    )
    respx_mock.post("https://partner.example.com/oauth/token").respond(
        200,
        json={
            "access_token": "access-1",
            "refresh_token": "refresh-1",
            "expires_in": 3600,
            "id_token": _fake_jwt({"extension_<Partner>FirmId": "firm-xyz"}),
        },
    )
    auth = <Partner>AuthService()
    result = await auth.exchange_code_for_token("auth-code")
    assert result["access_token"] == "access-1"
    assert result["refresh_token"] == "refresh-1"
    assert result["firm_cloud_id"] == "firm-xyz"
    assert result["api_base_url"]  # tenant resolved or fell back


def _fake_jwt(claims):
    import jwt
    return jwt.encode(claims, "test", algorithm="HS256")
```

### `_extract_firm_id` candidates

```python
@pytest.mark.parametrize("claim_key,expected", [
    ("extension_<Partner>FirmId", "firm-1"),
    ("firmId", "firm-2"),
    ("firm_id", "firm-3"),
    ("tid", "firm-4"),
])
def test_extract_firm_id_tries_candidates(claim_key, expected):
    from modules.integrations.<partner>.backend.services.<partner>_auth import (
        <Partner>AuthService,
    )
    auth = <Partner>AuthService()
    token = _fake_jwt({claim_key: expected})
    assert auth._extract_firm_id(token) == expected


def test_extract_firm_id_returns_none_for_unrecognised():
    from modules.integrations.<partner>.backend.services.<partner>_auth import (
        <Partner>AuthService,
    )
    auth = <Partner>AuthService()
    assert auth._extract_firm_id(_fake_jwt({"unrelated": "x"})) is None
    assert auth._extract_firm_id(None) is None
```

### `save_credentials` upserts

```python
@pytest.mark.asyncio
async def test_save_credentials_upserts(mock_<partner>_settings, mock_db):
    from modules.integrations.<partner>.backend.services.<partner>_auth import (
        <Partner>AuthService,
    )
    auth = <Partner>AuthService(db=mock_db)
    await auth.save_credentials("user@example.com", {
        "access_token": "a", "refresh_token": "r",
        "token_expiry": datetime.utcnow() + timedelta(hours=1),
        "api_base_url": "https://api.x", "firm_cloud_id": "f",
    })
    doc = await mock_db.integration_tokens.find_one({"owner_id": "user@example.com"})
    assert doc["status"] == "connected"
    assert doc["provider"] == "<partner>"

    # Re-save updates instead of duplicating.
    await auth.save_credentials("user@example.com", {
        "access_token": "a2", "refresh_token": "r2",
        "token_expiry": datetime.utcnow() + timedelta(hours=2),
        "api_base_url": "https://api.x", "firm_cloud_id": "f",
    })
    count = await mock_db.integration_tokens.count_documents({"owner_id": "user@example.com"})
    assert count == 1
```

### Refresh under concurrency (Redis lock)

```python
import asyncio
import pytest


@pytest.mark.asyncio
async def test_refresh_under_concurrency_only_one_network_call(
    mock_<partner>_settings, mock_db, mock_redis, respx_mock, seed_credentials,
):
    from modules.integrations.<partner>.backend.services.<partner>_auth import (
        <Partner>AuthService,
    )
    route = respx_mock.post("https://partner.example.com/oauth/token").respond(
        200,
        json={
            "access_token": "new-access",
            "refresh_token": "new-refresh",
            "expires_in": 3600,
        },
    )
    auth = <Partner>AuthService(db=mock_db)
    # Force the credentials to look expired.
    await mock_db.integration_tokens.update_one(
        {"owner_id": "user@example.com"},
        {"$set": {"token_expiry": datetime.utcnow() - timedelta(seconds=1)}},
    )
    results = await asyncio.gather(
        auth.refresh_credentials("user@example.com"),
        auth.refresh_credentials("user@example.com"),
        auth.refresh_credentials("user@example.com"),
    )
    assert all(r is not None for r in results)
    assert route.call_count == 1, "Expected one network call, got %d" % route.call_count
```

### Refresh failure → disconnect

```python
@pytest.mark.asyncio
async def test_refresh_400_disconnects_user(
    mock_<partner>_settings, mock_db, mock_redis, respx_mock, seed_credentials,
):
    from modules.integrations.<partner>.backend.services.<partner>_auth import (
        <Partner>AuthService,
    )
    respx_mock.post("https://partner.example.com/oauth/token").respond(
        400, json={"error": "invalid_grant"}
    )
    auth = <Partner>AuthService(db=mock_db)
    result = await auth.refresh_credentials("user@example.com")
    assert result is None
    doc = await mock_db.integration_tokens.find_one({"owner_id": "user@example.com"})
    assert doc["status"] == "disconnected"
```

### Webhook signing key per-user

```python
@pytest.mark.asyncio
async def test_save_webhook_key_per_user(mock_<partner>_settings, mock_db, seed_credentials):
    from modules.integrations.<partner>.backend.services.<partner>_auth import (
        <Partner>AuthService,
    )
    auth = <Partner>AuthService(db=mock_db)
    await auth.save_webhook_signing_key("user@example.com", "user-secret")
    key = await auth.get_webhook_signing_key("user@example.com")
    assert key == "user-secret"
```

### Webhook signing key per-firm (variant)

```python
@pytest.mark.asyncio
async def test_save_webhook_key_per_firm_updates_all_in_firm(mock_db):
    # Seed two users in same firm.
    await mock_db.integration_tokens.insert_many([
        {"owner_id": "a@x", "provider": "<partner>", "firm_cloud_id": "F1", "status": "connected"},
        {"owner_id": "b@x", "provider": "<partner>", "firm_cloud_id": "F1", "status": "connected"},
        {"owner_id": "c@y", "provider": "<partner>", "firm_cloud_id": "F2", "status": "connected"},
    ])
    auth = <Partner>AuthService(db=mock_db)
    await auth.save_webhook_signing_key_for_firm("F1", "firm-key")
    docs = await mock_db.integration_tokens.find({"firm_cloud_id": "F1"}).to_list(10)
    assert all(d["webhook_signing_key"] == "firm-key" for d in docs)
    other = await mock_db.integration_tokens.find_one({"firm_cloud_id": "F2"})
    assert other.get("webhook_signing_key") is None
```

### Logout

```python
@pytest.mark.asyncio
async def test_logout_marks_disconnected(mock_db, seed_credentials):
    from modules.integrations.<partner>.backend.services.<partner>_auth import (
        <Partner>AuthService,
    )
    auth = <Partner>AuthService(db=mock_db)
    assert await auth.logout("user@example.com") is True
    doc = await mock_db.integration_tokens.find_one({"owner_id": "user@example.com"})
    assert doc["status"] == "disconnected"
```

## Don'ts

- Don't hit the real partner OAuth endpoint — use respx.
- Don't depend on real Redis — use fakeredis.
- Don't share state between tests — autouse fixtures clear between runs.
- Don't test logging output as primary assertion — too brittle.
