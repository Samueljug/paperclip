# Job Tests

## Coverage Targets

| Behavior | Coverage |
|---|---|
| Happy path | Job goes QUEUED → PROCESSING → COMPLETED, all docs imported |
| Cancellation | Redis flag set → task exits early, status CANCELLED |
| Smart-sync skip (remote unchanged) | Skipped doc has correct sync event |
| Smart-sync skip (echo) | Webhook within 60s of reverse-sync skipped |
| Smart-sync reverse-sync | AILA newer triggers `ready_to_sync=true` |
| Single doc failure | Job continues, only that doc marked failed |
| Rollback markers | Cleared on success and on cancel |
| Retry | Transient `httpx.HTTPError` triggers Celery retry up to max |
| Cleanup task | Stuck jobs older than TTL get rolled back |
| Concurrency cap | At most `CONCURRENCY` workers active at once |
| Progress publication | One progress message per batch |

## Sample Tests

### Happy path end-to-end (eager mode)

```python
@pytest.mark.asyncio
async def test_import_job_happy_path(
    celery_eager, mock_db, mock_redis, respx_mock, sample_<partner>_credentials, monkeypatch,
):
    from modules.integrations.<partner>.backend.tasks import process_<partner>_import_job
    from app.integrations.core.jobs.engine import JobEngine
    from app.integrations.core.jobs.models import IntegrationJob, JobStatus, JobType

    # Seed credentials.
    await mock_db.integration_tokens.insert_one(sample_<partner>_credentials.model_dump())

    # Seed job.
    job = IntegrationJob(
        job_id="<partner>_import_test",
        user_email="user@example.com",
        provider="<partner>",
        job_type=JobType.IMPORT,
        status=JobStatus.QUEUED,
        metadata={"request": {
            "matters": [{"matter_id": "m-1", "items": [{"document_id": "d-1"}]}],
            "source": "user_initiated",
        }},
    )
    await JobEngine.create_job(job)

    # Mock partner API.
    respx_mock.get("https://api.partner.example.com/matters/m-1/documents/d-1").respond(
        200, json={
            "id": "d-1", "name": "Doc.pdf", "extension": "pdf", "size": 123,
            "modified": "2026-01-01T00:00:00Z",
            "links": {"content_url": "https://partner-cdn.example.com/d-1?signed"},
        },
    )
    # Mock the eventual file download. (DocumentService is mocked separately.)
    monkeypatch.setattr(
        "app.integrations.utils.document_service.DocumentService.download_docx",
        lambda self, *a, **kw: asyncio.sleep(0, result="https://aila-s3.example.com/d-1.sfdt"),
    )

    process_<partner>_import_job.delay("<partner>_import_test")  # eager → runs synchronously

    final = await JobEngine.get_job("<partner>_import_test")
    assert final["status"] == JobStatus.COMPLETED.value
    doc = await mock_db.documents.find_one({"<partner>_doc_id": "d-1", "ownerId": "user@example.com"})
    assert doc is not None
    assert doc["sync_status"] == "complete"
```

### Cancellation

```python
@pytest.mark.asyncio
async def test_import_job_cancellation(
    celery_eager, mock_db, mock_redis, sample_<partner>_credentials,
):
    from modules.integrations.<partner>.backend.tasks import process_<partner>_import_job
    from app.integrations.core.jobs.engine import JobEngine
    from app.integrations.core.jobs.models import IntegrationJob, JobStatus, JobType

    await mock_db.integration_tokens.insert_one(sample_<partner>_credentials.model_dump())
    job_id = "<partner>_import_cancel"
    await JobEngine.create_job(IntegrationJob(
        job_id=job_id, user_email="user@example.com", provider="<partner>",
        job_type=JobType.IMPORT, status=JobStatus.QUEUED, metadata={"request": {}},
    ))
    # Set cancellation flag BEFORE task starts.
    await mock_redis.set(f"job:cancel:{job_id}", "1")
    process_<partner>_import_job.delay(job_id)
    final = await JobEngine.get_job(job_id)
    assert final["status"] == JobStatus.CANCELLED.value
```

### Smart-sync skip — remote unchanged

```python
@pytest.mark.asyncio
async def test_smart_sync_skips_remote_unchanged(
    celery_eager, mock_db, mock_redis, respx_mock, sample_<partner>_credentials, monkeypatch,
):
    # Pre-existing doc with stored modified timestamp.
    stored_modified = datetime(2026, 1, 1)
    await mock_db.integration_tokens.insert_one(sample_<partner>_credentials.model_dump())
    await mock_db.documents.insert_one({
        "ownerId": "user@example.com", "integration": "<partner>",
        "<partner>_doc_id": "d-1",
        "<partner>_modified_at": stored_modified,
    })
    respx_mock.get("https://api.partner.example.com/matters/m-1/documents/d-1").respond(
        200, json={"id": "d-1", "name": "Doc", "modified": stored_modified.isoformat()},
    )
    # Should NOT trigger download.
    download_calls = []
    monkeypatch.setattr(
        "app.integrations.utils.document_service.DocumentService.download_docx",
        lambda self, *a, **kw: download_calls.append(a) or asyncio.sleep(0, result=""),
    )

    job_id = "<partner>_import_skip"
    from app.integrations.core.jobs.engine import JobEngine
    from app.integrations.core.jobs.models import IntegrationJob, JobStatus, JobType
    await JobEngine.create_job(IntegrationJob(
        job_id=job_id, user_email="user@example.com", provider="<partner>",
        job_type=JobType.IMPORT, status=JobStatus.QUEUED,
        metadata={"request": {"matters": [{"matter_id": "m-1", "items": [{"document_id": "d-1"}]}]}},
    ))
    from modules.integrations.<partner>.backend.tasks import process_<partner>_import_job
    process_<partner>_import_job.delay(job_id)

    assert download_calls == [], "Did not expect any download for unchanged remote"
    event = await mock_db.<partner>_sync_events.find_one({"sp_doc_id": "d-1"})
    assert event["action"] == "skipped"
    assert event["smart_sync_reason"] == "remote_unchanged"
```

### Single doc failure

```python
@pytest.mark.asyncio
async def test_one_doc_failure_does_not_fail_job(
    celery_eager, mock_db, mock_redis, respx_mock, sample_<partner>_credentials, monkeypatch,
):
    await mock_db.integration_tokens.insert_one(sample_<partner>_credentials.model_dump())
    respx_mock.get("https://api.partner.example.com/matters/m-1/documents/d-good").respond(
        200, json={"id": "d-good", "name": "Good.pdf", "modified": "2026-01-01T00:00:00Z"},
    )
    respx_mock.get("https://api.partner.example.com/matters/m-1/documents/d-bad").respond(
        500, text="oops",
    )
    monkeypatch.setattr(
        "app.integrations.utils.document_service.DocumentService.download_docx",
        lambda self, *a, **kw: asyncio.sleep(0, result="https://aila-s3/x"),
    )

    job_id = "<partner>_import_partial"
    from app.integrations.core.jobs.engine import JobEngine
    from app.integrations.core.jobs.models import IntegrationJob, JobStatus, JobType
    await JobEngine.create_job(IntegrationJob(
        job_id=job_id, user_email="user@example.com", provider="<partner>",
        job_type=JobType.IMPORT, status=JobStatus.QUEUED,
        metadata={"request": {"matters": [{"matter_id": "m-1", "items": [
            {"document_id": "d-good"}, {"document_id": "d-bad"},
        ]}]}},
    ))
    from modules.integrations.<partner>.backend.tasks import process_<partner>_import_job
    process_<partner>_import_job.delay(job_id)

    job = await JobEngine.get_job(job_id)
    assert job["status"] == JobStatus.COMPLETED.value
    good = await mock_db.documents.find_one({"<partner>_doc_id": "d-good"})
    bad_event = await mock_db.<partner>_sync_events.find_one({"sp_doc_id": "d-bad", "action": "failed"})
    assert good is not None
    assert bad_event is not None
```

### Rollback markers cleared

```python
@pytest.mark.asyncio
async def test_rollback_markers_cleared_on_success(celery_eager, mock_db, mock_redis, sample_<partner>_credentials, ...):
    # Setup similar to happy path.
    # After task runs, assert no documents have rollback_marker set.
    cursor = mock_db.documents.find({"ownerId": "user@example.com", "rollback_marker": {"$exists": True}})
    docs = await cursor.to_list(10)
    assert docs == []
```

### Cleanup task

```python
@pytest.mark.asyncio
async def test_cleanup_stuck_imports_rolls_back(mock_db, mock_redis, monkeypatch):
    from modules.integrations.<partner>.backend.tasks import cleanup_stuck_<partner>_imports
    from app.integrations.core.jobs.engine import JobEngine

    # Seed a stuck job (PROCESSING for > 2h).
    await mock_db.integration_jobs.insert_one({
        "job_id": "stuck-1", "provider": "<partner>",
        "status": "processing", "user_email": "user@example.com",
        "updated_at": datetime.utcnow() - timedelta(hours=3),
    })
    await mock_db.documents.insert_one({"_id": ObjectId(), "rollback_marker": "stuck-1"})

    # Run cleanup synchronously.
    cleanup_stuck_<partner>_imports.apply()

    job = await JobEngine.get_job("stuck-1")
    assert job["status"] == "failed"
    docs = await mock_db.documents.find({"rollback_marker": "stuck-1"}).to_list(10)
    assert docs == []
```

### Concurrency cap

```python
@pytest.mark.asyncio
async def test_concurrency_capped(monkeypatch):
    """Verify the semaphore is honored."""
    from modules.integrations.<partner>.backend.tasks import _process_one_document, CONCURRENCY
    active = 0
    peak = 0

    async def fake_one_doc(*args, **kwargs):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.01)
        active -= 1

    monkeypatch.setattr(
        "modules.integrations.<partner>.backend.tasks._process_one_document",
        fake_one_doc,
    )
    # ... run task with 20 docs, assert peak <= CONCURRENCY
```

## Don'ts

- Don't test the partner's API behavior — mock it.
- Don't sleep arbitrary amounts — use eager mode or `await asyncio.sleep(0)` to yield control.
- Don't assert on Redis pub/sub timing — assert on side effects (DB writes, JobEngine state).
- Don't run real Celery workers in unit tests — use `task_always_eager`.
