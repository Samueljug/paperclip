# Webhook Tests

## Coverage Targets

| Function | Coverage |
|---|---|
| `verify_signature` | Valid HMAC + correct key returns True |
| `verify_signature` | Wrong key returns False |
| `verify_signature` | Per-user key found in DB |
| `verify_signature` | Per-firm key found in DB (variant) |
| `verify_signature` | Falls back to global key |
| `verify_signature` | Timestamp outside window returns False |
| `verify_signature` | Duplicate nonce returns False |
| `process_event` | Routes each event type to correct handler |
| `_handle_document_event` | Finds users by firm AND entity, intersects |
| `_find_affected_owners` | Filters disconnected users |
| `_extract_ids` | Normalises nested vs flat shapes |
| Document metadata pre-fetch | Uses first owner's credentials |
| All handlers | Swallow exceptions (never raise) |
| Router endpoint | Returns 200 even on internal failure |
| Router endpoint | Returns 200 on invalid signature (no leak) |

## Helper: HMAC Payload Generator

```python
import base64
import hmac
import hashlib
import json
import time


def make_signed_webhook(
    body: dict,
    *,
    signing_key: str,
    webhook_id: str = "wh-test",
    timestamp: int | None = None,
) -> tuple[bytes, dict[str, str]]:
    """Returns (raw_body, headers) suitable for posting to /webhook."""
    if timestamp is None:
        timestamp = int(time.time())
    payload = json.dumps(body).encode()
    signing_string = f"{webhook_id}.{timestamp}.{payload.decode()}".encode()
    digest = hmac.new(signing_key.encode(), signing_string, hashlib.sha256).digest()
    signature = "v1," + base64.b64encode(digest).decode()
    headers = {
        "webhook-signature": signature,
        "webhook-timestamp": str(timestamp),
        "webhook-id": webhook_id,
    }
    return payload, headers
```

## Sample Tests

### Valid signature

```python
@pytest.mark.asyncio
async def test_verify_signature_valid(mock_db, mock_redis):
    from modules.integrations.<partner>.backend.services.<partner>_webhook import (
        <Partner>WebhookService,
    )
    await mock_db.integration_tokens.insert_one({
        "owner_id": "user@example.com",
        "provider": "<partner>",
        "status": "connected",
        "webhook_signing_key": "secret-1",
    })
    webhook = <Partner>WebhookService()
    body, headers = make_signed_webhook({"type": "ping"}, signing_key="secret-1")
    assert await webhook.verify_signature(body, headers) is True
```

### Wrong key

```python
@pytest.mark.asyncio
async def test_verify_signature_wrong_key(mock_db, mock_redis):
    from modules.integrations.<partner>.backend.services.<partner>_webhook import (
        <Partner>WebhookService,
    )
    await mock_db.integration_tokens.insert_one({
        "owner_id": "user@example.com",
        "provider": "<partner>",
        "status": "connected",
        "webhook_signing_key": "actual-key",
    })
    webhook = <Partner>WebhookService()
    body, headers = make_signed_webhook({"type": "ping"}, signing_key="forged-key")
    assert await webhook.verify_signature(body, headers) is False
```

### Falls back to global key

```python
@pytest.mark.asyncio
async def test_verify_signature_falls_back_to_global(mock_<partner>_settings, mock_db, mock_redis):
    from modules.integrations.<partner>.backend.services.<partner>_webhook import (
        <Partner>WebhookService,
    )
    # No per-user key.
    webhook = <Partner>WebhookService()
    body, headers = make_signed_webhook({"type": "ping"}, signing_key="global-fallback-key")
    assert await webhook.verify_signature(body, headers) is True
```

### Outside timestamp window

```python
@pytest.mark.asyncio
async def test_verify_signature_rejects_old_timestamp(mock_<partner>_settings, mock_db, mock_redis):
    from modules.integrations.<partner>.backend.services.<partner>_webhook import (
        <Partner>WebhookService,
    )
    webhook = <Partner>WebhookService()
    old = int(time.time()) - 600  # 10 min ago
    body, headers = make_signed_webhook({"type": "ping"}, signing_key="global-fallback-key", timestamp=old)
    assert await webhook.verify_signature(body, headers) is False
```

### Duplicate nonce

```python
@pytest.mark.asyncio
async def test_verify_signature_rejects_duplicate(mock_<partner>_settings, mock_db, mock_redis):
    from modules.integrations.<partner>.backend.services.<partner>_webhook import (
        <Partner>WebhookService,
    )
    webhook = <Partner>WebhookService()
    body, headers = make_signed_webhook({"type": "ping"}, signing_key="global-fallback-key")
    assert await webhook.verify_signature(body, headers) is True
    # Replay same headers.
    assert await webhook.verify_signature(body, headers) is False
```

### Event routing

```python
@pytest.mark.asyncio
async def test_process_event_routes_document_created(mock_db, mock_redis, monkeypatch):
    from modules.integrations.<partner>.backend.services.<partner>_webhook import (
        <Partner>WebhookService,
    )
    handled = {"called": False}

    async def fake_handler(self, data, ts, firm_id):
        handled["called"] = True

    monkeypatch.setattr(<Partner>WebhookService, "_handle_document_event", fake_handler)
    await <Partner>WebhookService().process_event({
        "type": "document.created",
        "data": {"document_id": "d-1", "matter_id": "m-1"},
        "timestamp": "2026-01-01T00:00:00Z",
        "firm_id": "firm-1",
    })
    assert handled["called"]
```

### User fan-out: firm + entity intersection

```python
@pytest.mark.asyncio
async def test_find_affected_owners_intersects(mock_db):
    from modules.integrations.<partner>.backend.services.<partner>_webhook import (
        <Partner>WebhookService,
    )
    # Firm has alice + bob, but only alice has the matter imported.
    await mock_db.integration_tokens.insert_many([
        {"owner_id": "alice@x", "provider": "<partner>", "firm_cloud_id": "F1", "status": "connected"},
        {"owner_id": "bob@x", "provider": "<partner>", "firm_cloud_id": "F1", "status": "connected"},
    ])
    await mock_db.folders.insert_one({
        "ownerId": "alice@x", "integration": "<partner>", "action_id": "matter-1",
    })
    webhook = <Partner>WebhookService()
    owners = await webhook._find_affected_owners(mock_db, "F1", None, "matter-1", None)
    assert owners == {"alice@x"}
```

### `_extract_ids` flat vs nested

```python
def test_extract_ids_handles_flat():
    from modules.integrations.<partner>.backend.services.<partner>_webhook import (
        <Partner>WebhookService,
    )
    w = <Partner>WebhookService()
    doc, matter, client = w._extract_ids({"document_id": "d", "matter_id": "m", "client_id": "c"})
    assert (doc, matter, client) == ("d", "m", "c")


def test_extract_ids_handles_nested():
    from modules.integrations.<partner>.backend.services.<partner>_webhook import (
        <Partner>WebhookService,
    )
    w = <Partner>WebhookService()
    doc, matter, client = w._extract_ids({
        "document": {"id": "d"},
        "location": {"matter_id": "m", "client_id": "c"},
    })
    assert (doc, matter, client) == ("d", "m", "c")
```

### Handlers swallow exceptions

```python
@pytest.mark.asyncio
async def test_process_event_swallows_handler_exception(mock_db, mock_redis, monkeypatch):
    from modules.integrations.<partner>.backend.services.<partner>_webhook import (
        <Partner>WebhookService,
    )

    async def boom(self, *a, **kw):
        raise RuntimeError("oops")

    monkeypatch.setattr(<Partner>WebhookService, "_handle_document_event", boom)
    # Must not raise.
    await <Partner>WebhookService().process_event({
        "type": "document.created", "data": {}, "timestamp": "x", "firm_id": "F",
    })
```

### Router endpoint always returns 200

```python
@pytest.mark.asyncio
async def test_webhook_endpoint_returns_200_on_invalid_signature(client):
    """`client` is a fixture that builds a TestClient over the FastAPI app."""
    response = await client.post(
        "/integrations/<partner>/webhook",
        headers={"webhook-signature": "v1,bogus", "webhook-timestamp": str(int(time.time())), "webhook-id": "x"},
        content=b"{}",
    )
    assert response.status_code == 200
```

## Replay-Window Edge Cases

- `timestamp == now` → accept
- `timestamp == now - 299s` → accept (just inside window)
- `timestamp == now - 301s` → reject
- `timestamp == now + 60s` → accept (clock skew tolerance)
- `timestamp == now + 600s` → reject (probably forged)
- Missing `timestamp` header → reject
- Non-numeric `timestamp` → reject

Cover each as a parametrised test.

## Don'ts

- Don't test that the endpoint returns 200 on a duplicate — that's a webhook service detail; assert at the service level.
- Don't depend on log output for the test outcome — assert state changes (DB writes, mocked side-effect calls).
