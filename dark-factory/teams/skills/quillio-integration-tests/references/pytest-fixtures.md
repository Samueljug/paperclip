# pytest Fixtures (Backend)

## Tools

| Library | Purpose |
|---|---|
| `pytest` + `pytest-asyncio` | Async test execution |
| `respx` | httpx mocking (works with `httpx.AsyncClient`) |
| `fakeredis` (`fakeredis.aioredis`) | In-memory Redis with full async API |
| `mongomock` or `motor`-against-test-DB | MongoDB |
| `freezegun` | Time travel (useful for token-expiry tests) |
| `celery.contrib.testing.worker` | Inline Celery worker for task tests |
| `pytest-cov` | Coverage |

Add to `requirements-dev.txt`:

```
pytest>=8
pytest-asyncio>=0.23
pytest-cov>=5
respx>=0.21
fakeredis>=2.23
mongomock>=4.1
freezegun>=1.5
```

## Project conftest.py Additions

Repo-level `tests/conftest.py` provides shared fixtures. The integration-specific `tests/unit/integrations/<partner>/conftest.py` extends them.

### Async event loop

```python
import asyncio
import pytest


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()
```

### Settings override

```python
@pytest.fixture
def mock_<partner>_settings(monkeypatch):
    monkeypatch.setattr("app.settings.settings.<partner>_client_id", "test-client-id")
    monkeypatch.setattr("app.settings.settings.<partner>_client_secret", "test-secret")
    monkeypatch.setattr("app.settings.settings.<partner>_redirect_uri", "https://test.example.com/callback")
    monkeypatch.setattr("app.settings.settings.<partner>_auth_url", "https://partner.example.com/oauth/authorize")
    monkeypatch.setattr("app.settings.settings.<partner>_token_url", "https://partner.example.com/oauth/token")
    monkeypatch.setattr("app.settings.settings.<partner>_api_base_url", "https://api.partner.example.com")
    monkeypatch.setattr("app.settings.settings.<partner>_webhook_signing_key", "global-fallback-key")
    monkeypatch.setattr("app.settings.settings.authjwt_secret_key", "test-jwt-secret")
    monkeypatch.setattr("app.settings.settings.base_url_backend", "https://api.test.aila.app")
```

### Mock MongoDB (mongomock)

```python
import pytest
import mongomock_motor


@pytest.fixture
async def mock_db():
    client = mongomock_motor.AsyncMongoMockClient()
    db = client["aila_test"]
    yield db
    client.close()
```

### Mock Redis (fakeredis)

```python
import fakeredis.aioredis
import pytest


@pytest.fixture
async def mock_redis():
    r = fakeredis.aioredis.FakeRedis(decode_responses=True)
    yield r
    await r.flushall()
    await r.close()
```

### Mock httpx via respx

```python
import respx
import pytest


@pytest.fixture
def respx_mock():
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as router:
        yield router
```

### Sample credentials fixture

```python
from datetime import datetime, timedelta
from modules.integrations.<partner>.backend.models.<partner>_models import <Partner>Credentials


@pytest.fixture
def sample_<partner>_credentials():
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
    await mock_db.integration_tokens.insert_one(sample_<partner>_credentials.model_dump())
    return sample_<partner>_credentials
```

### `<Partner>Service` factory

```python
@pytest.fixture
async def partner_service(mock_db):
    from modules.integrations.<partner>.backend.services.<partner>_service import <Partner>Service
    service = <Partner>Service(db=mock_db)
    yield service
    await service.cleanup()
```

### `<Partner>Client` factory

```python
@pytest.fixture
async def partner_client(sample_<partner>_credentials):
    from modules.integrations.<partner>.backend.services.<partner>_client import <Partner>Client
    client = <Partner>Client(
        base_url=sample_<partner>_credentials.api_base_url,
        access_token=sample_<partner>_credentials.access_token,
    )
    yield client
    await client.close()
```

## Patching `get_motor_db` and `get_async_redis`

Service / auth / webhook code calls `await get_motor_db()` and `await get_async_redis()`. Patch them globally per test:

```python
@pytest.fixture(autouse=True)
def patch_infra(monkeypatch, mock_db, mock_redis):
    async def _get_db():
        return mock_db

    async def _get_redis():
        return mock_redis

    monkeypatch.setattr("app.mongodb.get_motor_db", _get_db)
    monkeypatch.setattr("app.redis_async.get_async_redis", _get_redis)
```

`autouse=True` applies to every test in the file — keeps each test focused on the partner-specific assertion, not infrastructure.

## Celery Inline Worker

For Celery task tests, run worker in-process:

```python
import pytest
from celery.contrib.testing.worker import start_worker
from app.tasks import celery_app


@pytest.fixture(scope="module")
def celery_worker():
    with start_worker(celery_app, perform_ping_check=False, shutdown_timeout=10) as worker:
        yield worker
```

Or use eager mode for individual tests:

```python
@pytest.fixture
def celery_eager(monkeypatch):
    from app.tasks import celery_app
    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True
    yield
    celery_app.conf.task_always_eager = False
```

## Time Travel

```python
from freezegun import freeze_time


def test_token_expiry_triggers_refresh():
    with freeze_time("2026-01-01 12:00:00"):
        # ... save credentials with token_expiry at 13:00:00
        ...
    with freeze_time("2026-01-01 13:00:01"):
        # ... call get_client; should trigger refresh
        ...
```

## Conftest Layout

```
tests/
├── conftest.py                      # repo-wide fixtures
├── unit/
│   └── integrations/
│       └── <partner>/
│           └── conftest.py          # partner-specific extensions of repo fixtures
└── integration/
    └── integrations/
        └── <partner>/
            └── conftest.py          # integration-test fixtures (real services optional)
```

The partner conftest IMPORTS from repo conftest implicitly (pytest discovery). Only override what's necessary.
